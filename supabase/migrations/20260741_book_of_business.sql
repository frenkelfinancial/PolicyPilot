-- ============================================================
-- Back Office, Phase 3 — Book of Business.
--
-- Two things, both additive and idempotent:
--
--   1. public.policy_status_history — an APPEND-ONLY trail of every policy
--      status change, carrying WHERE the change came from. Existing policies
--      are backfilled with one genesis entry each, so no policy opens onto an
--      empty timeline.
--
--   2. public.get_team_summary — replaced (same signature, same 22-column
--      return type, so CREATE OR REPLACE suffices and nothing is dropped) with
--      exactly one change: the "is a sale" predicate now also excludes the two
--      new not-a-sale statuses this phase introduces.
--
-- WHY A NEW TABLE RATHER THAN public.policy_events
--
-- `policy_events` (20260717) already records status changes, but only the ones
-- the CARRIER-EMAIL parser made: it is keyed to `parsed_events`, it is
-- service-role write only, and it has no concept of a manual edit. Phase 3
-- needs a trail that covers manual edits, the app's own automatic transitions
-- and commission-statement ingestion as well. Rather than widen a table the
-- email pipeline owns — and risk changing what `match-events` writes — this is
-- a new table with a `source` column, and `policy_events` is left exactly as
-- it is. The Book of Business timeline reads BOTH and merges them.
--
-- WHY THE BROWSER MAY WRITE IT, WHEN commission_rows MAY NOT
--
-- The policy tracker is a browser-side app: `public.policies` is written
-- directly from the client under an owner RLS policy, and there is no edge
-- function anywhere in the policy write path. A history table the browser
-- could not write would therefore record nothing at all for the source that
-- produces most of the entries. So INSERT is allowed for the owner — but
-- there is deliberately NO UPDATE and NO DELETE policy: the trail is
-- append-only, and something that can rewrite history is not a trail.
--
-- The one thing a client must not be able to do is forge PROVENANCE. A row
-- claiming source='statement' means "a carrier's own statement said so", and
-- Phase 6's reconciliation screen will treat it that way. So a trigger
-- restricts client callers to the two sources a browser can honestly produce
-- ('manual', 'system') and rejects the rest; the service role — which is what
-- `statement-parse` runs as — keeps the usual carve-out. Protect the column,
-- not only the function that sets it: this schema has learned that in
-- 20260703c, 20260730, 20260736 and 20260740.
--
-- NOT here on purpose:
--   * Any cross-agent read path. A leader cannot see a downline's policy
--     history, for the same reason `get_team_summary` returns aggregates only.
--   * Any change to `public.policies`. The four new statuses live in the
--     existing `data->>'status'` string; there is no enum and no column to
--     widen, so introducing them is a client-side change plus this trail.
-- ============================================================


-- ------------------------------------------------------------
-- 1. policy_status_history
--
-- KEYING. The durable identity of a policy in this app is
-- (agent_id, client_id) — `policies.client_id` is the browser's own
-- `Date.now()` id, it is what UNIQUE (agent_id, client_id) is built on, and
-- it is the only handle the browser has. `policy_id` is the convenience FK
-- for server-side writers that already hold the uuid; it is ON DELETE SET
-- NULL rather than CASCADE because deleting a policy must not erase the
-- record that its status once changed — the same reasoning as
-- `lead_transfers.lead_id`.
--
-- source:
--   manual         an agent changed it in the app
--   system         the app changed it on its own (the draft-date auto-advance)
--   statement      a carrier commission statement said so   (service role)
--   carrier_email  the carrier-mail parser said so          (service role)
--   migration      the genesis entry written by this file
-- ------------------------------------------------------------
create table if not exists public.policy_status_history (
  id               uuid        primary key default gen_random_uuid(),
  agent_id         uuid        not null references auth.users(id) on delete cascade,
  policy_client_id bigint      not null,
  policy_id        uuid        references public.policies(id) on delete set null,

  old_status       text,
  new_status       text        not null,

  source           text        not null default 'manual',
  source_detail    text,
  source_ref_id    uuid,

  changed_at       timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

comment on table public.policy_status_history is
  'Append-only trail of every policy status change and where it came from. Owner may SELECT and INSERT; there is deliberately no UPDATE or DELETE policy.';
comment on column public.policy_status_history.policy_client_id is
  'The browser-side policy id (policies.client_id). The durable key — policy_id is a convenience FK and may be null.';
comment on column public.policy_status_history.source is
  'manual | system | statement | carrier_email | migration. Client callers are restricted to manual/system by policy_status_history_guard.';
comment on column public.policy_status_history.changed_at is
  'When the change happened, which is not always when the row was written: a genesis entry is dated from the policy, not from the backfill.';

create index if not exists policy_status_history_policy_idx
  on public.policy_status_history (agent_id, policy_client_id, changed_at desc);
create index if not exists policy_status_history_agent_idx
  on public.policy_status_history (agent_id, changed_at desc);
create index if not exists policy_status_history_source_idx
  on public.policy_status_history (agent_id, source, changed_at desc);
create index if not exists policy_status_history_ref_idx
  on public.policy_status_history (source_ref_id)
  where source_ref_id is not null;

do $guard$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'policy_status_history_source_check'
  ) then
    alter table public.policy_status_history
      add constraint policy_status_history_source_check
      check (source in ('manual','system','statement','carrier_email','migration'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'policy_status_history_status_check'
  ) then
    alter table public.policy_status_history
      add constraint policy_status_history_status_check
      check (new_status in (
        'pending','approved','issued','paid',
        'denied','withdrawn','lapsed','surrendered','claim','chargeback'
      ));
  end if;
end
$guard$;


-- ------------------------------------------------------------
-- 2. The provenance guard.
--
-- `agent_id` is forced to auth.uid() for a client caller so a row cannot be
-- filed into another agent's book even if the RLS WITH CHECK were ever
-- loosened, and `source` is restricted to the two values a browser can
-- honestly claim. A client asserting source='statement' would be asserting
-- that a carrier said something — exactly the claim Phase 6's triage screen
-- has to be able to trust.
--
-- Trusted contexts (service_role, the SQL editor) keep the usual carve-out:
-- auth.role() reads the JWT claim, so it is 'authenticated' for a browser
-- caller and absent or 'service_role' otherwise.
-- ------------------------------------------------------------
create or replace function public.policy_status_history_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.agent_id := auth.uid();
    if new.source is null or new.source not in ('manual', 'system') then
      raise exception
        'policy_status_history.source must be manual or system when written by a client (got %)',
        coalesce(new.source, 'null')
        using errcode = '42501';
    end if;
  end if;
  if new.changed_at is null then
    new.changed_at := now();
  end if;
  return new;
end
$fn$;

drop trigger if exists policy_status_history_guard on public.policy_status_history;
create trigger policy_status_history_guard
  before insert on public.policy_status_history
  for each row execute function public.policy_status_history_guard();


-- ------------------------------------------------------------
-- 3. RLS — read own, append own, rewrite nothing.
-- ------------------------------------------------------------
alter table public.policy_status_history enable row level security;

drop policy if exists policy_status_history_select_own on public.policy_status_history;
create policy policy_status_history_select_own
  on public.policy_status_history for select to authenticated
  using (agent_id = auth.uid());

drop policy if exists policy_status_history_insert_own on public.policy_status_history;
create policy policy_status_history_insert_own
  on public.policy_status_history for insert to authenticated
  with check (agent_id = auth.uid());

-- No UPDATE policy and no DELETE policy, on purpose. Append-only.


-- ------------------------------------------------------------
-- 4. Backfill — one genesis entry per existing policy.
--
-- "Existing statuses migrate in as each policy's first entry", so a policy
-- written before this phase does not open onto an empty timeline. Dated from
-- the policy itself (dateSubmitted, else draft, else the row's created_at)
-- rather than from now(), so the trail reads truthfully.
--
-- Guarded by NOT EXISTS, so re-running the file writes nothing further. A
-- status the check constraint does not recognise is skipped rather than
-- failing the whole apply — there is no enum on policies.data->>'status' and
-- a hand-edited row could hold anything.
--
-- Both dates are regex-guarded before the cast for the same reason
-- `get_team_summary` guards AP: these are free-text jsonb values, and one
-- malformed date would abort the entire apply rather than mis-date one row.
--
-- NOON, not midnight. `dateSubmitted` is a plain calendar date the agent
-- typed; casting it lands on midnight UTC, and the browser renders a
-- timestamptz in the reader's LOCAL zone — so every agent west of UTC would
-- see their policy's first entry dated one day early, silently and on every
-- policy they own. Noon keeps the rendered day correct from UTC-11 to UTC+11,
-- which is the same reason `bobRecordPolicyCreated()` in app.html stamps
-- T12:00:00Z. Found by the headless click-through, not by a unit test.
-- ------------------------------------------------------------
insert into public.policy_status_history
  (agent_id, policy_client_id, policy_id, old_status, new_status,
   source, source_detail, changed_at)
select
  po.agent_id,
  po.client_id,
  po.id,
  null,
  po.data->>'status',
  'migration',
  'Status as recorded when the status history was introduced',
  coalesce(
    case when coalesce(po.data->>'dateSubmitted','') ~ '^\d{4}-\d{2}-\d{2}'
         then (left(po.data->>'dateSubmitted', 10))::timestamptz + interval '12 hours' end,
    case when coalesce(po.data->>'draft','') ~ '^\d{4}-\d{2}-\d{2}'
         then (left(po.data->>'draft', 10))::timestamptz + interval '12 hours' end,
    po.created_at,
    now()
  )
from public.policies po
where po.data->>'status' in (
        'pending','approved','issued','paid',
        'denied','withdrawn','lapsed','surrendered','claim','chargeback')
  and not exists (
    select 1 from public.policy_status_history h
    where h.agent_id = po.agent_id
      and h.policy_client_id = po.client_id
  );

-- Correct genesis entries written at midnight by an EARLIER run of this same
-- file, before the noon fix above. Scoped as tightly as it can be — only rows
-- this file wrote (source='migration'), only ones sitting at exactly 00:00:00
-- UTC, and only where the policy's own date confirms which day was meant. A
-- genuine midnight instant cannot be produced by the expression above, so
-- there is nothing else this can hit. Re-running it is a no-op.
update public.policy_status_history h
   set changed_at = h.changed_at + interval '12 hours'
  from public.policies po
 where h.source = 'migration'
   and h.changed_at = date_trunc('day', h.changed_at)
   and po.agent_id = h.agent_id
   and po.client_id = h.policy_client_id
   and h.changed_at::date = coalesce(
         case when coalesce(po.data->>'dateSubmitted','') ~ '^\d{4}-\d{2}-\d{2}'
              then (left(po.data->>'dateSubmitted', 10))::date end,
         case when coalesce(po.data->>'draft','') ~ '^\d{4}-\d{2}-\d{2}'
              then (left(po.data->>'draft', 10))::date end);


-- ------------------------------------------------------------
-- 5. get_team_summary — replaced.
--
-- Byte-identical to the definition applied in 20260738 EXCEPT for the sale
-- predicate, which now also excludes 'denied' and 'withdrawn'. Both are
-- statuses this phase introduces and both mean the policy never issued, so
-- counting either as team production would overstate a downline's AP the
-- moment an agent starts using them.
--
-- 'surrendered' and 'claim' are deliberately NOT excluded: both describe a
-- policy that WAS sold and later ended, and the predicate is about whether a
-- sale ever happened, not about whether it is still in force.
--
-- Same signature and same RETURNS TABLE, so CREATE OR REPLACE is enough —
-- nothing is dropped, grants are untouched, and authorization is unchanged
-- (SECURITY DEFINER, anchored solely on ai.leader_id = auth.uid(), with no
-- parameter naming a leader).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_team_summary(
  p_start            timestamptz DEFAULT NULL,
  p_end              timestamptz DEFAULT NULL,
  p_prev_start       timestamptz DEFAULT NULL,
  p_prev_end         timestamptz DEFAULT NULL,
  p_month_start      timestamptz DEFAULT NULL,
  p_month_end        timestamptz DEFAULT NULL,
  p_prev_month_start timestamptz DEFAULT NULL,
  p_prev_month_end   timestamptz DEFAULT NULL
)
RETURNS TABLE (
  agent_id               uuid,
  agent_name             text,
  agent_email            text,
  agent_plan             text,
  is_leader              boolean,
  joined_at              timestamptz,
  last_activity_at       timestamptz,
  last_dial_at           timestamptz,
  ap                     numeric,
  sales                  bigint,
  dials                  bigint,
  call_time_sec          numeric,
  prev_ap                numeric,
  prev_sales             bigint,
  prev_dials             bigint,
  prev_call_time_sec     numeric,
  month_ap               numeric,
  prev_month_ap          numeric,
  lifetime_ap            numeric,
  lifetime_sales         bigint,
  lifetime_dials         bigint,
  lifetime_call_time_sec numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH bounds AS (
    SELECT
      p_start                                                            AS s,
      p_end                                                              AS e,
      p_prev_start                                                       AS ps,
      p_prev_end                                                         AS pe,
      COALESCE(p_month_start, date_trunc('month', now()))                AS ms,
      COALESCE(p_month_end,   date_trunc('month', now()) + interval '1 month') AS me,
      COALESCE(p_prev_month_start, date_trunc('month', now()) - interval '1 month') AS pms,
      COALESCE(p_prev_month_end,   date_trunc('month', now()))           AS pme
  ),
  team AS (
    -- The caller's own row (always present; their own aggregates, which they
    -- already own — no cross-agent leak).
    SELECT auth.uid() AS uid, true AS is_leader, NULL::timestamptz AS joined_at
    UNION
    -- Accepted downline invitees. ai.leader_id = auth.uid() is the whole
    -- authorization: you can only ever see agents YOU lead.
    SELECT ai.invitee_id,
           false,
           COALESCE(ai.accepted_at, ai.created_at)
    FROM public.agency_invites ai
    WHERE ai.leader_id  = auth.uid()
      AND ai.status     = 'accepted'
      AND ai.invitee_id IS NOT NULL
  ),
  -- One normalized pass over policies. A "sale" is a policy whose submitted
  -- date (dateSubmitted, else draft) parses as ISO and whose status is not
  -- lapsed/chargeback — the identical predicate this function has always
  -- used, and the one get_agency_stats was corrected to in 20260736.
  --
  -- The AP guard is new: `(data->>'ap')::numeric` throws on any non-numeric
  -- value, and a single malformed policy would take down the whole team
  -- rollup for every agent on the screen rather than mis-state one row.
  -- Unparseable AP now counts as 0.
  pol AS (
    SELECT po.agent_id AS uid,
           (COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')))::date AS sub_date,
           CASE WHEN COALESCE(po.data->>'ap','') ~ '^-?[0-9]+(\.[0-9]+)?$'
                THEN (po.data->>'ap')::numeric ELSE 0 END AS ap
    FROM public.policies po
    JOIN team t ON t.uid = po.agent_id
    WHERE COALESCE(po.data->>'status','') NOT IN ('lapsed','chargeback','denied','withdrawn')
      AND COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')) ~ '^\d{4}-\d{2}-\d{2}'
  ),
  pol_agg AS (
    SELECT p.uid,
      COALESCE(SUM(p.ap) FILTER (WHERE (b.s IS NULL OR p.sub_date >= b.s::date) AND (b.e IS NULL OR p.sub_date < b.e::date)), 0)::numeric AS ap,
      (COUNT(*)          FILTER (WHERE (b.s IS NULL OR p.sub_date >= b.s::date) AND (b.e IS NULL OR p.sub_date < b.e::date)))::bigint     AS sales,
      COALESCE(SUM(p.ap) FILTER (WHERE b.ps IS NOT NULL AND p.sub_date >= b.ps::date AND p.sub_date < b.pe::date), 0)::numeric            AS prev_ap,
      (COUNT(*)          FILTER (WHERE b.ps IS NOT NULL AND p.sub_date >= b.ps::date AND p.sub_date < b.pe::date))::bigint                AS prev_sales,
      COALESCE(SUM(p.ap) FILTER (WHERE p.sub_date >= b.ms::date  AND p.sub_date < b.me::date), 0)::numeric                                AS month_ap,
      COALESCE(SUM(p.ap) FILTER (WHERE p.sub_date >= b.pms::date AND p.sub_date < b.pme::date), 0)::numeric                               AS prev_month_ap,
      COALESCE(SUM(p.ap), 0)::numeric AS lifetime_ap,
      (COUNT(*))::bigint              AS lifetime_sales
    FROM pol p CROSS JOIN bounds b
    GROUP BY p.uid
  ),
  cl AS (
    SELECT c.agent_id AS uid,
      (COUNT(*)                     FILTER (WHERE (b.s IS NULL OR c.started_at >= b.s) AND (b.e IS NULL OR c.started_at < b.e)))::bigint  AS dials,
      COALESCE(SUM(c.duration_sec)  FILTER (WHERE (b.s IS NULL OR c.started_at >= b.s) AND (b.e IS NULL OR c.started_at < b.e)), 0)::numeric AS call_time_sec,
      (COUNT(*)                     FILTER (WHERE b.ps IS NOT NULL AND c.started_at >= b.ps AND c.started_at < b.pe))::bigint          AS prev_dials,
      COALESCE(SUM(c.duration_sec)  FILTER (WHERE b.ps IS NOT NULL AND c.started_at >= b.ps AND c.started_at < b.pe), 0)::numeric      AS prev_call_time_sec,
      (COUNT(*))::bigint                        AS lifetime_dials,
      COALESCE(SUM(c.duration_sec),0)::numeric  AS lifetime_call_time_sec,
      MAX(c.started_at)                         AS last_dial_at
    FROM public.calls c
    JOIN team t ON t.uid = c.agent_id
    CROSS JOIN bounds b
    GROUP BY c.agent_id
  ),
  -- "Last activity" = the last time the agent did something, not the last
  -- time they opened the app. Deliberately built from created_at and never
  -- updated_at: sbUpsertAllLeads() re-upserts the ENTIRE local book on every
  -- save, so leads.updated_at tracks app usage, not work, and would report
  -- every idle agent as active today.
  act AS (
    SELECT t.uid,
           GREATEST(
             (SELECT MAX(c.started_at)  FROM public.calls    c  WHERE c.agent_id  = t.uid),
             (SELECT MAX(po.created_at) FROM public.policies po WHERE po.agent_id = t.uid),
             (SELECT MAX(l.created_at)  FROM public.leads    l  WHERE l.agent_id  = t.uid)
           ) AS last_activity_at
    FROM team t
  )
  SELECT
    t.uid,
    COALESCE(NULLIF(ag.display_name,''),
             NULLIF(au.raw_user_meta_data->>'display_name',''),
             au.email)                                    AS agent_name,
    au.email                                              AS agent_email,
    pl.name                                               AS agent_plan,
    t.is_leader,
    t.joined_at,
    act.last_activity_at,
    cl.last_dial_at,
    COALESCE(pol_agg.ap, 0),
    COALESCE(pol_agg.sales, 0),
    COALESCE(cl.dials, 0),
    COALESCE(cl.call_time_sec, 0),
    COALESCE(pol_agg.prev_ap, 0),
    COALESCE(pol_agg.prev_sales, 0),
    COALESCE(cl.prev_dials, 0),
    COALESCE(cl.prev_call_time_sec, 0),
    COALESCE(pol_agg.month_ap, 0),
    COALESCE(pol_agg.prev_month_ap, 0),
    COALESCE(pol_agg.lifetime_ap, 0),
    COALESCE(pol_agg.lifetime_sales, 0),
    COALESCE(cl.lifetime_dials, 0),
    COALESCE(cl.lifetime_call_time_sec, 0)
  FROM team t
  LEFT JOIN auth.users   au ON au.id = t.uid
  LEFT JOIN public.agents ag ON ag.id = t.uid
  LEFT JOIN public.plans  pl ON pl.id = ag.plan_id
  LEFT JOIN pol_agg ON pol_agg.uid = t.uid
  LEFT JOIN cl      ON cl.uid      = t.uid
  LEFT JOIN act     ON act.uid     = t.uid
  ORDER BY 9 DESC;
$$;
