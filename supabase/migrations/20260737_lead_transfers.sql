-- ============================================================
-- Lead distribution between agency members ("Send Leads").
--
-- Two objects, both additive and idempotent:
--   1. public.lead_transfers  — append-only audit of every lead handoff.
--   2. public.get_agency_members() — the caller's agency peers, which is
--      what the two pickers render.
--
-- NOT here on purpose: any RLS policy letting one agent write another
-- agent's leads. The move itself runs in the `transfer-leads` edge
-- function under the service role, which re-derives the agency link from
-- the caller's JWT before touching a row. A PostgREST policy broad enough
-- to allow the write would also allow every write we are refusing.
-- ============================================================


-- ------------------------------------------------------------
-- 1. lead_transfers — who sent which lead to whom, and when.
--
-- Both client_ids are recorded because they can differ: `leads` carries
-- UNIQUE (agent_id, client_id) and client_id is the browser's local
-- lead.id (String(lead.id), see sbUpsertLead in app.html). If the
-- recipient already holds a lead with that id — two agents' Date.now()
-- seeds can collide — the transfer reassigns a fresh one, and the audit
-- has to be able to name the lead on both sides of the handoff.
--
-- lead_name / lead_phone are denormalized snapshots. The lead row can be
-- edited or deleted by the recipient afterwards; an audit trail that
-- silently changes underneath you is not an audit trail.
--
-- ON DELETE SET NULL for lead_id (not CASCADE): deleting a lead must not
-- erase the record that it was handed over.
-- ------------------------------------------------------------
create table if not exists public.lead_transfers (
  id                  uuid        primary key default gen_random_uuid(),
  lead_id             uuid        references public.leads(id) on delete set null,
  sender_id           uuid        not null references auth.users(id) on delete cascade,
  recipient_id        uuid        not null references auth.users(id) on delete cascade,
  sender_client_id    text        not null,
  recipient_client_id text        not null,
  lead_name           text,
  lead_phone          text,
  transferred_at      timestamptz not null default now()
);

comment on table public.lead_transfers is
  'Append-only audit of leads moved between agency members by the transfer-leads edge function. Service-role write only; sender and recipient can each read their own rows.';
comment on column public.lead_transfers.sender_client_id is
  'leads.client_id on the sender''s side at handoff time.';
comment on column public.lead_transfers.recipient_client_id is
  'leads.client_id after the move. Differs from sender_client_id only when the recipient already had a lead with that client_id (UNIQUE (agent_id, client_id)).';

create index if not exists lead_transfers_sender_idx
  on public.lead_transfers (sender_id, transferred_at desc);
create index if not exists lead_transfers_recipient_idx
  on public.lead_transfers (recipient_id, transferred_at desc);
create index if not exists lead_transfers_lead_idx
  on public.lead_transfers (lead_id);

alter table public.lead_transfers enable row level security;

-- SELECT only, and only your own side of the handoff. There is deliberately
-- no INSERT/UPDATE/DELETE policy: RLS-enabled-with-no-policy is how
-- "service-role only" is expressed in Postgres, same as reputation_config.
drop policy if exists "parties read their transfers" on public.lead_transfers;
create policy "parties read their transfers"
  on public.lead_transfers for select to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());


-- ------------------------------------------------------------
-- 2. get_agency_members() — everyone the caller shares an agency with.
--
-- Three relationships, all derived from ACCEPTED agency_invites rows:
--   upline   — a leader who invited me
--   downline — an agent I invited
--   sibling  — another accepted invitee of one of my uplines
--
-- Siblings are the reason this is an RPC rather than a client query: a
-- downline agent cannot see agency_invites rows that are not addressed to
-- them (RLS is leader_id = auth.uid() OR invitee_email = auth.email()), so
-- the browser cannot enumerate its own peers.
--
-- Returns only what a picker needs to identify a colleague — name, email,
-- plan. No production figures, no book contents. get_agency_stats remains
-- the leader-only surface for numbers.
--
-- SECURITY DEFINER with the caller's own auth.uid() as the sole anchor:
-- there is no parameter, so there is nothing to tamper with.
-- ------------------------------------------------------------
create or replace function public.get_agency_members()
returns table (
  agent_id     uuid,
  agent_name   text,
  agent_email  text,
  agent_plan   text,
  relationship text
)
language sql
security definer
set search_path = public
stable
as $$
  with uplines as (
    select ai.leader_id as uid
    from public.agency_invites ai
    where ai.invitee_id = auth.uid()
      and ai.status = 'accepted'
  ),
  downlines as (
    select ai.invitee_id as uid
    from public.agency_invites ai
    where ai.leader_id = auth.uid()
      and ai.status = 'accepted'
      and ai.invitee_id is not null
  ),
  siblings as (
    select ai.invitee_id as uid
    from public.agency_invites ai
    join uplines u on u.uid = ai.leader_id
    where ai.status = 'accepted'
      and ai.invitee_id is not null
      and ai.invitee_id <> auth.uid()
  ),
  peers as (
    -- Rank so a duplicate (someone who is both my leader and, via another
    -- leader, my sibling) resolves to the stronger relationship exactly once.
    select uid, 1 as rank, 'upline'   as rel from uplines
    union all
    select uid, 2,          'downline'      from downlines
    union all
    select uid, 3,          'sibling'       from siblings
  ),
  ranked as (
    select distinct on (uid) uid, rel
    from peers
    where uid is not null and uid <> auth.uid()
    order by uid, rank
  )
  select
    r.uid                                        as agent_id,
    coalesce(nullif(ag.display_name, ''), au.email) as agent_name,
    au.email                                     as agent_email,
    pl.name                                      as agent_plan,
    r.rel                                        as relationship
  from ranked r
  join auth.users au        on au.id = r.uid
  left join public.agents ag on ag.id = r.uid
  left join public.plans  pl on pl.id = ag.plan_id
  order by 2;
$$;

revoke all on function public.get_agency_members() from public;
grant execute on function public.get_agency_members() to authenticated, service_role;
