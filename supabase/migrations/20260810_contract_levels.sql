-- ============================================================
-- Contract levels an agency owner can set, and the data to price an override.
--
-- Round 1 of 2 (PROMPT_OV1). BACKEND ONLY — schema, RPCs, RLS. The screen and
-- the override arithmetic are Round 2. Feature doc: docs/contract-levels.md.
--
-- ADDITIVE. One new table, one index, one SELECT policy, one AFTER trigger,
-- two new functions, and ONE existing function re-created to carry three extra
-- columns. No DROP of a table, a column or a row; no DELETE, no TRUNCATE;
-- nothing in auth.* or storage.* is written. Re-running is a no-op.
--
-- The whole file is transaction-wrapped, because section 4 must DROP
-- get_agency_members() to widen its RETURNS TABLE (a return-type change cannot
-- be done with CREATE OR REPLACE). A failure anywhere leaves the old
-- definition, and its ACL, exactly where they were.
--
-- ------------------------------------------------------------------
-- THE OWNER'S DECISION, AND THE ONE THING IT LEAVES OPEN
-- ------------------------------------------------------------------
-- Both the agency owner and the agent may set that agent's contract level, and
-- THE MOST RECENT CHANGE WINS whoever made it. That is settled and this file
-- does not re-litigate it: there is no approval step, no lock, and no
-- leader-wins rule anywhere below.
--
-- What it leaves open is that an agent can move the number that determines
-- their upline's override, and until now nothing recorded that it happened.
-- So: every change is logged with who made it, the leader can read the log for
-- their own downline, and `get_agency_members` answers the one question an
-- owner actually asks — "did they set that themselves?" — as a BOOLEAN.
-- Never as a name, never as an email. The rule is unchanged; it is now visible.
--
-- ------------------------------------------------------------------
-- WHAT THIS FILE DOES NOT DO
-- ------------------------------------------------------------------
-- It computes no override. `get_downline_product_ap` returns AP per agent per
-- product and nothing else; the COMP-table arithmetic is Round 2's, in the
-- browser, where getCommPct() already lives. A level ABOVE the leader's own
-- must clamp the override to zero rather than go negative — this file does
-- nothing that makes that impossible, and deliberately does not implement it.
-- ============================================================

begin;


-- ------------------------------------------------------------
-- 1. contract_level_changes — the audit trail.
--
-- RLS ON, and SELECT is the only policy. Rows are written by the trigger in
-- section 2 under SECURITY DEFINER and by nothing else. An INSERT policy broad
-- enough to let a browser record "the agent raised their own level on the 3rd"
-- is broad enough to let it record one that never happened, which would make
-- the table worse than not having it.
--
-- TYPES, and the two places this departs from the brief as written:
--
--   changed_by IS NULLABLE. auth.uid() is NULL for a service-role write, the
--   SQL editor and a migration — every trusted context. The brief says
--   `not null` and also says to handle the null case explicitly rather than
--   letting the insert fail, and those two cannot both hold. The alternatives
--   to a nullable column were to coalesce to the agent (a lie: the table
--   exists precisely so "who moved it" is answerable) or to skip the row (a
--   lost change in an audit table). NULL means "not an end-user session", and
--   `level_changed_by_self` reads it as false, which is correct — a service
--   write is not the agent doing it themselves. `on delete set null` folds a
--   deleted changer into the same value; the row, the agent and the timestamp
--   survive, which is the point of an audit table.
--
--   new_level IS NOT NULL, as the brief specifies, and the trigger therefore
--   declines to fire when a level is CLEARED. That is not a lost change out of
--   carelessness: a NOT NULL violation raised inside an AFTER trigger aborts
--   the caller's entire transaction, so the alternative is an unrelated agent
--   save failing because somebody nulled a column. Same class of hazard as
--   pp_jsonb_ts() in leads_preserve_ai_status(), and the same answer. Neither
--   write path can produce it anyway: the browser sends `parseInt(value) || 100`
--   and set_downline_contract_level() rejects a null outright.
-- ------------------------------------------------------------
create table if not exists public.contract_level_changes (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid not null references auth.users(id) on delete cascade,
  changed_by uuid          references auth.users(id) on delete set null,
  old_level  numeric,
  new_level  numeric not null,
  changed_at timestamptz not null default now()
);

comment on table public.contract_level_changes is
  'Append-only record of every change to agents.contract_level. Written only by the agents_log_contract_level trigger. changed_by NULL = not an end-user session (service role, SQL editor, migration) or a deleted account.';

create index if not exists contract_level_changes_agent_idx
  on public.contract_level_changes (agent_id, changed_at desc);

alter table public.contract_level_changes enable row level security;

-- An agent reads their own history; a leader reads their accepted downline's.
-- `ai.leader_id = auth.uid()` is the whole authorization and there is nothing
-- to point at another agency, the same shape every downline read in this
-- schema uses. Nobody else sees a row.
drop policy if exists contract_level_changes_select on public.contract_level_changes;
create policy contract_level_changes_select
  on public.contract_level_changes
  for select
  to authenticated
  using (
    agent_id = auth.uid()
    or exists (
      select 1
        from public.agency_invites ai
       where ai.leader_id  = auth.uid()
         and ai.invitee_id = contract_level_changes.agent_id
         and ai.status     = 'accepted'
    )
  );

revoke insert, update, delete on public.contract_level_changes from anon, authenticated;
grant select on public.contract_level_changes to authenticated;


-- ------------------------------------------------------------
-- 2. Log every change, from BOTH write paths.
--
-- The two paths look nothing alike — the agent UPDATEs their own row straight
-- from the browser (sbSaveContract), and the leader calls the SECURITY DEFINER
-- function in section 3 — so a trigger is the only place the rule can live
-- once. A third path added later is covered for free.
--
-- 🔴 WHY THIS IS AN *AFTER* TRIGGER, AND WHY THAT IS THE ORDERING ANSWER.
--
-- public.agents already carries seven BEFORE UPDATE triggers, and Postgres
-- fires BEFORE row triggers in ALPHABETICAL ORDER by trigger name:
--
--     agents_lock_compliance_slug
--     agents_protect_commission_token
--     agents_protect_compliance_columns
--     agents_protect_privileged_columns      <-- 20260703c
--     agents_protect_verification_columns
--     agents_sync_compliance_page
--     agents_touch_updated_at
--
-- `agents_log_contract_level` sorts BEFORE all seven of those. As a BEFORE
-- trigger it would therefore read NEW as the client offered it, not as it was
-- finally stored — and this schema's column guards work by silently REVERTING
-- `NEW.col := OLD.col`, not by raising. A logger that ran first would record
-- changes that a later guard then undid. As an AFTER trigger it cannot: every
-- BEFORE trigger has finished, NEW is the row that actually landed, and
-- `is distinct from` sees a reverted column as no change at all and writes
-- nothing. Ordering by luck of the alphabet is exactly what this avoids.
--
-- Composition with 20260703c specifically: that trigger is a DENYLIST. It
-- reverts is_admin, plan_id, monthly_minute_limit, monthly_quote_limit and the
-- three stripe_* columns for a non-admin `authenticated`/`anon` caller, and it
-- touches contract_level nowhere. So a self-update of a contract level passes
-- through it untouched and is logged — which is the intended behaviour, since
-- contract_level is a column the app has always let an agent write. (The
-- comment at the top of 20260703c names monthly_goal, contract_level,
-- agent_phone and signalwire_caller_id, but as an OBSERVATION about what the
-- client writes, not as an allowlist the trigger enforces.)
--
-- An update the guards reject outright — agents_lock_compliance_slug raises on
-- a locked slug — aborts the statement, so the AFTER trigger never runs and
-- nothing is logged. Correct in both directions.
--
-- `after update of contract_level` narrows this further: the trigger is not
-- even considered unless that column appears in the UPDATE's target list, so
-- every ordinary agent save pays nothing for it.
-- ------------------------------------------------------------
create or replace function public.agents_log_contract_level()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- `is distinct from` and not `<>`: a level moving to or from NULL is a
  -- change, and `null <> 100` is null, which is not true.
  if new.contract_level is distinct from old.contract_level
     and new.contract_level is not null then
    insert into public.contract_level_changes (agent_id, changed_by, old_level, new_level)
    values (new.id, auth.uid(), old.contract_level, new.contract_level);
  end if;
  return null;   -- AFTER ... FOR EACH ROW: the return value is ignored.
end;
$fn$;

drop trigger if exists agents_log_contract_level on public.agents;
create trigger agents_log_contract_level
  after update of contract_level on public.agents
  for each row execute function public.agents_log_contract_level();


-- ------------------------------------------------------------
-- 3. set_downline_contract_level — the leader's write path.
--
-- This function exists because a leader CANNOT simply `update public.agents`:
-- the table's RLS lets an agent write their own row only, and the column
-- guards in 20260703c / 20260729 / 20260748 / 20260804 sit on top of that. A
-- policy wide enough to let a leader write a downline agent's row would be
-- wide enough to let any agent write any row they can name. So the leader's
-- write goes through one SECURITY DEFINER function that re-derives the
-- relationship from the caller's own JWT.
--
-- 🔴 THERE IS NO PARAMETER NAMING A LEADER. p_agent_id names the SUBJECT — the
-- agent whose level is being set — and the leader is `auth.uid()` and nothing
-- else. A p_leader_id argument is how one agency reads or writes another's
-- book; the same reasoning and the same shape as get_team_summary,
-- apply_producer_codes and get_downline_commission_rollup.
--
-- Validation reuses setContractValue()'s real bounds from app.html:
-- 70..145, rounded to the nearest 5. It ROUNDS inside the range exactly as the
-- browser does (103 -> 105, so the RPC and the input box agree) but RAISES
-- outside it rather than clamping — a leader who types 200 should be told, not
-- silently handed 145. The resolved level is returned so the caller renders
-- what was actually stored. Postgres `round()` and JS `Math.round()` agree for
-- every positive value, so the two cannot disagree on a .5.
--
-- The logging is the trigger's, not this function's. One rule, one place.
-- ------------------------------------------------------------
create or replace function public.set_downline_contract_level(
  p_agent_id uuid,
  p_level    numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- The clamp from setContractValue() in app.html. A test compares these two
  -- numbers against that function's source text so they cannot drift.
  v_min   constant numeric := 70;
  v_max   constant numeric := 145;
  v_step  constant numeric := 5;
  v_level numeric;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_agent_id is null then
    raise exception 'set_downline_contract_level requires an agent'
      using errcode = '22023';
  end if;

  -- Authorization, and the whole of it: an accepted invite whose leader is the
  -- caller. Not the caller's own row either — an agent sets their own level
  -- through their own row, which they already own.
  if not exists (
    select 1
      from public.agency_invites ai
     where ai.leader_id  = auth.uid()
       and ai.invitee_id = p_agent_id
       and ai.status     = 'accepted'
  ) then
    raise exception 'not authorized: that agent is not an accepted member of your downline'
      using errcode = '42501';
  end if;

  if p_level is null or p_level < v_min or p_level > v_max then
    raise exception 'contract level must be between % and % (got %)', v_min, v_max, coalesce(p_level::text, 'null')
      using errcode = '22023';
  end if;

  v_level := round(p_level / v_step) * v_step;

  update public.agents
     set contract_level = v_level
   where id = p_agent_id;

  if not found then
    raise exception 'no agents row for that agent' using errcode = 'P0002';
  end if;

  return v_level;
end;
$fn$;

comment on function public.set_downline_contract_level(uuid, numeric) is
  'Sets an accepted downline agent''s contract level. SECURITY DEFINER with NO parameter naming a leader: authorization is agency_invites.leader_id = auth.uid() and status = accepted. Most recent change wins, whoever made it; the change is logged by agents_log_contract_level.';

revoke all on function public.set_downline_contract_level(uuid, numeric) from public;
grant execute on function public.set_downline_contract_level(uuid, numeric) to authenticated, service_role;


-- ------------------------------------------------------------
-- 4. get_agency_members — three columns added.
--
-- Reproduced verbatim from 20260751 with the three additions and nothing else
-- changed. DROP + CREATE in one transaction because RETURNS TABLE is widening;
-- the grant is restated because DROP takes the ACL with it.
--
-- WHY THIS FUNCTION AND NOT get_team_summary. get_team_summary is under the
-- one-call-site invariant and its `pol` CTE is compared character for character
-- against lb_agent_metrics by test/leaderboards.test.mjs; widening it means
-- touching the function two screens' AP already agrees through, for a field
-- that has nothing to do with AP. get_agency_members is already the roster
-- read, is under no such invariant, and both of its callers in app.html read
-- their columns BY NAME, so additional columns are inert until Round 2 asks
-- for them.
--
-- 🔴 A CONTRACT LEVEL IS RETURNED FOR A DOWNLINE ROW ONLY. This function also
-- returns UPLINES and SIBLINGS — it feeds the lead-transfer picker — and the
-- owner's decision is that an agent sees only their own level while a leader
-- sees everyone's in their agency. An ungated column here would show an agent
-- their sibling's contract, and their leader's. The `rel = 'downline'` case is
-- that rule; the caller's own row is not in this result at all (`uid <>
-- auth.uid()`), and their own level still comes from sbLoadContract().
--
-- 🔴 THE CHANGER IS A BOOLEAN, NEVER AN IDENTITY. `level_changed_by_self`
-- answers the owner's actual question — did the agent move this themselves —
-- without publishing who else did. NULL means there is no recorded change:
-- either the level predates this migration or it has never moved. False means
-- somebody other than that agent set it, which includes the leader and
-- includes a service-role write; that distinction is not worth a name on a
-- peer-visible surface.
-- ------------------------------------------------------------
drop function if exists public.get_agency_members();

create or replace function public.get_agency_members()
returns table (
  agent_id              uuid,
  agent_name            text,
  agent_email           text,
  agent_plan            text,
  relationship          text,
  contract_level        numeric,
  level_changed_by_self boolean,
  level_changed_at      timestamptz
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
  ),
  -- The most recent recorded change per agent. `distinct on` over the index
  -- this migration creates, so it is one ordered read and not a correlated
  -- subquery per row.
  lastchg as (
    select distinct on (c.agent_id)
           c.agent_id, c.changed_by, c.changed_at
      from public.contract_level_changes c
     order by c.agent_id, c.changed_at desc
  )
  select
    r.uid                                        as agent_id,
    public.pp_display_name(r.uid)                as agent_name,
    au.email                                     as agent_email,
    pl.name                                      as agent_plan,
    r.rel                                        as relationship,
    case when r.rel = 'downline' then ag.contract_level::numeric end        as contract_level,
    case when r.rel = 'downline' and lc.agent_id is not null
         then (lc.changed_by is not distinct from r.uid) end                as level_changed_by_self,
    case when r.rel = 'downline' then lc.changed_at end                     as level_changed_at
  from ranked r
  join auth.users au        on au.id = r.uid
  left join public.agents ag on ag.id = r.uid
  left join public.plans  pl on pl.id = ag.plan_id
  left join lastchg lc       on lc.agent_id = r.uid
  order by 2;
$$;

comment on function public.get_agency_members() is
  'The caller''s agency peers for the transfer picker and the Round 2 override screen. Aggregate/roster fields only. contract_level and the two level_* columns are populated for DOWNLINE rows only — an agent sees their own level through sbLoadContract(), never a peer''s — and the changer is reported as a boolean, never as a name or an email.';

revoke all on function public.get_agency_members() from public;
grant execute on function public.get_agency_members() to authenticated, service_role;


-- ------------------------------------------------------------
-- 5. get_downline_product_ap — AP per agent per product. FIGURES ONLY.
--
-- 🔴 THE SALE PREDICATE, THE SALE-DATE CHAIN AND THE AP GUARD BELOW ARE
-- BYTE-IDENTICAL TO get_team_summary'S `pol` CTE, and test/contract-levels.
-- test.mjs compares them character for character exactly as
-- test/leaderboards.test.mjs already does for lb_agent_metrics. Round 2 prices
-- an override off these numbers and the Agency tab reports AP for the same
-- agents one click away; two definitions of "a sale" across those two screens
-- is the 8,610x bug with a shorter fuse. Do not paraphrase it. If the team
-- function's definition ever moves, this one moves in the same commit.
--
-- 🔴 NO PARAMETER NAMING A LEADER. Both parameters are date bounds; the
-- downline is `ai.leader_id = auth.uid()`, plus the caller's own row.
--
-- 🔴 AGGREGATES, NEVER ROWS. No client name, no insured, no policy number, no
-- carrier statement id, no per-policy row — enforced by what RETURNS TABLE
-- declares, not by what a UI chooses to render.
--
-- THE OPT-OUT. `agents.hide_from_leaderboards` is NOT applied here, matching
-- get_downline_commission_rollup (20260742), which does not apply it either,
-- and get_team_summary, which does not apply it either. lb_visible_members()
-- is the enforcement point for PEER-VISIBLE RANKINGS — who appears on a board
-- against their colleagues — and a hidden agent is already in their leader's
-- team table and commission rollup today. Inventing a stricter stance for this
-- one function would mean a leader's override estimate silently omitting an
-- agent whose AP the row above it is showing. Matched deliberately; stated so
-- the next reader does not have to guess.
--
-- 🔴 `product` IS NOT A COMP KEY, BECAUSE THE BOOK DOES NOT HOLD ONE.
-- Checked against production before this was written (26 policies, 3 agents):
-- `data->>'product'` holds FOUR distinct values and they are two different
-- key spaces at once —
--
--     'Whole Life'                     the display category, the bulk of the book
--     'aa_senior', 'core_siwl', 'trans_express'    legacy rows storing a raw COMP key
--
-- and `data->>'cls'` likewise holds 'std' and 'gi' alongside the legacy 'level'
-- and 'standard'. A COMP key cannot be resolved from `product` alone in either
-- space: the browser's getActiveCommKey(carrier, product, cls) needs all three,
-- because CARRIER_PRODUCTS[carrier].products[product] is what turns
-- 'Whole Life' into 'americo_eagle', and because the graded/GI overrides and
-- the ~40% cut flag come off the carrier and the health class.
--
-- So this function does NOT map anything and invents no mapping table. It
-- returns the three stored values VERBATIM, joined into one text key in the
-- shape app.html already uses for exactly this lookup —
-- commPctOverrideKey(carrier, product, cls) === `${carrier}|${product}|${cls}`
-- — and Round 2 splits on '|' and calls the resolver that already ships. A
-- bare `data->>'product'` would have been the raw value and also an unusable
-- one; this is the raw values and a usable grain, which is the whole reason
-- the column exists. Two policies differing only in health class are two rows,
-- deliberately: they earn different percentages.
-- ------------------------------------------------------------
create or replace function public.get_downline_product_ap(
  p_start date default null,
  p_end   date default null
)
returns table (
  agent_id     uuid,
  product      text,
  policy_count bigint,
  total_ap     numeric
)
language sql
security definer
set search_path = public
stable
as $fn$
  with team as (
    -- The caller's own row (their own aggregates, which they already own),
    -- plus accepted downline invitees. ai.leader_id = auth.uid() is the whole
    -- authorization. A non-leader gets a book of one — their own.
    select auth.uid() as uid
    union
    select ai.invitee_id
    from public.agency_invites ai
    where ai.leader_id  = auth.uid()
      and ai.status     = 'accepted'
      and ai.invitee_id is not null
  ),
  pol AS (
    SELECT po.agent_id AS uid,
           (COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')))::date AS sub_date,
           CASE WHEN COALESCE(po.data->>'ap','') ~ '^-?[0-9]+(\.[0-9]+)?$'
                THEN (po.data->>'ap')::numeric ELSE 0 END AS ap,
           -- Verbatim stored values, never interpreted here. Same shape as
           -- commPctOverrideKey(carrier, product, cls) in app.html.
           COALESCE(po.data->>'carrier','') || '|' ||
           COALESCE(po.data->>'product','') || '|' ||
           COALESCE(po.data->>'cls','')     AS product_key
    FROM public.policies po
    JOIN team t ON t.uid = po.agent_id
    WHERE COALESCE(po.data->>'status','') NOT IN ('lapsed','chargeback','denied','withdrawn')
      AND COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')) ~ '^\d{4}-\d{2}-\d{2}'
  )
  select
    p.uid                            as agent_id,
    p.product_key                    as product,
    count(*)::bigint                 as policy_count,
    coalesce(sum(p.ap), 0)::numeric  as total_ap
  from pol p
  -- Half-open and compared as DATEs, exactly as get_team_summary compares
  -- them. NULL is unbounded, which is how "Lifetime" is expressed.
  where (p_start is null or p.sub_date >= p_start)
    and (p_end   is null or p.sub_date <  p_end)
  group by p.uid, p.product_key
  order by 4 desc, 2;
$fn$;

comment on function public.get_downline_product_ap(date, date) is
  'A leader''s downline AP by product, AGGREGATES ONLY — no client, no insured, no policy number, no statement. SECURITY DEFINER with no parameter naming a leader: scoped solely by agency_invites.leader_id = auth.uid(). `product` is the VERBATIM carrier|product|cls triple as stored, NOT a COMP key: the book holds display labels and legacy COMP keys in the same column, and only getActiveCommKey(carrier, product, cls) can resolve one. The sale predicate is byte-identical to get_team_summary''s.';

revoke all on function public.get_downline_product_ap(date, date) from public;
grant execute on function public.get_downline_product_ap(date, date) to authenticated, service_role;


commit;
