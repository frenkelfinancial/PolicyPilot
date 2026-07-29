-- ============================================================
-- Back Office, Phase 4 — commissions dashboard.
--
-- Three functions, no tables, no columns, no data change. Everything the
-- dashboard reads already exists on `public.commission_rows`.
--
--   1. get_commission_buckets(start, end)   the caller's own figures, grouped
--                                           by week and transaction type
--   2. get_commission_debt()                the caller's carrier-reported debt
--   3. get_downline_commission_rollup(...)  a LEADER's downline, aggregates only
--
-- THE ORGANISING DECISION: (1) returns BUCKETS, not answers.
--
-- Six headline cards and two charts are all derived from one grouped result in
-- the browser, in the pure `// <comm-core>` block that the unit tests execute.
-- The alternative — six SQL expressions returning six numbers — puts the
-- definition of "net commission" somewhere no test runs and makes every card a
-- separate round trip. SQL groups; the definitions live in tested code.
--
-- The grouping is what keeps it bounded: a year is 52 rows back, an all-time
-- range on a five-year book is a few hundred, whatever the row count behind
-- them. Fetching the rows themselves would hit PostgREST's 1,000-row ceiling
-- and quietly return a WRONG total rather than an error, which on a commission
-- figure is the worst possible failure.
--
-- EFFECTIVE AGENT. `commission_rows.agent_id` is the uploader (the tenant, and
-- what RLS keys on); `attributed_agent_id` is who wrote the business, resolved
-- from a producer code in Phase 2. Everything here attributes on
-- `coalesce(attributed_agent_id, agent_id)`:
--
--   * on a solo agent's own statement the two are the same id;
--   * on an agency owner's consolidated statement, a line attributed to a
--     downline agent counts as THAT agent's production, not the owner's;
--   * an unattributed line falls back to the uploader, because an unattributed
--     line on your own statement is far more likely to be yours than nobody's
--     — and the dashboard says how many such lines there are, with a link to
--     Settings → Producer Codes, rather than hiding them.
--
-- The coalesce is also what makes the downline rollup double-count-proof: a
-- line uploaded by the leader and attributed to a downline agent, and a line
-- uploaded by that agent with no attribution, both resolve to exactly one
-- agent and are counted once.
--
-- NOT here on purpose:
--   * Any change to `commission_rows` RLS. It stays SELECT-only and
--     per-tenant. (1) and (2) are SECURITY INVOKER and read through the
--     caller's own policy, so they cannot return another agent's figures even
--     by accident. Only (3) is SECURITY DEFINER, and it returns FIGURES —
--     never rows, never a client name, never a policy number.
--   * Any read path letting a downline agent see rows their LEADER uploaded
--     and attributed to them. That is a real gap and it is recorded in
--     docs/back-office-commissions.md rather than closed here: closing it
--     means a second reader on the most sensitive table in the app and
--     deserves its own decision.
-- ============================================================


-- ------------------------------------------------------------
-- 1. get_commission_buckets — the caller's own figures.
--
-- SECURITY INVOKER (the default), so `commission_rows_select_own` is what
-- scopes it. There is no agent parameter and no way to add one that would
-- help: RLS would refuse the rows anyway.
--
-- NULL bounds mean unbounded, which is how "All time" is expressed — the same
-- convention as get_team_summary.
--
-- Bucketing is on `transaction_date`, which Phase 1 guarantees is populated
-- (it falls back to the paid date, then the effective date) precisely so that
-- no row silently vanishes from this chart.
--
-- `week_start` is Monday. date_trunc('week') in Postgres is ISO, i.e. Monday,
-- which matches the app's own week elsewhere.
-- ------------------------------------------------------------
create or replace function public.get_commission_buckets(
  p_start date default null,
  p_end   date default null
)
returns table (
  week_start       date,
  transaction_type text,
  is_own           boolean,
  amount_cents     bigint,
  positive_cents   bigint,
  negative_cents   bigint,
  row_count        bigint
)
language sql
stable
set search_path = public
as $fn$
  select
    (date_trunc('week', cr.transaction_date))::date                  as week_start,
    cr.transaction_type,
    coalesce(cr.attributed_agent_id, cr.agent_id) = auth.uid()       as is_own,
    coalesce(sum(cr.amount_cents), 0)::bigint                        as amount_cents,
    coalesce(sum(cr.amount_cents) filter (where cr.amount_cents > 0), 0)::bigint as positive_cents,
    coalesce(sum(cr.amount_cents) filter (where cr.amount_cents < 0), 0)::bigint as negative_cents,
    count(*)::bigint                                                 as row_count
  from public.commission_rows cr
  where cr.transaction_date is not null
    and (p_start is null or cr.transaction_date >= p_start)
    and (p_end   is null or cr.transaction_date <  p_end)
  group by 1, 2, 3
  order by 1, 2;
$fn$;

comment on function public.get_commission_buckets(date, date) is
  'Caller''s own commission rows grouped by week + transaction type. SECURITY INVOKER: scoped by commission_rows RLS, so it cannot return another agent''s figures.';

grant execute on function public.get_commission_buckets(date, date) to authenticated;


-- ------------------------------------------------------------
-- 2. get_commission_debt — carrier-reported balance, per carrier.
--
-- Debt is what a carrier has taken back and not yet been repaid: the sum of
-- chargeback and adjustment lines, reported as a positive balance when that
-- sum is negative and as zero when it is not.
--
-- Only `chargeback` and `adjustment` count. An advance is not debt — it is an
-- advance, and treating unearned advance as a carrier balance would invent a
-- number the carrier never reported. A POSITIVE adjustment reduces the
-- balance, which is how a repayment appears on a statement.
--
-- `unmatched_rows` is carried because a debt line that matched no policy is
-- still real money owed; it must show in the total and be findable in the
-- drill-down, not be quietly excluded for want of a match.
-- ------------------------------------------------------------
create or replace function public.get_commission_debt(
  p_start date default null,
  p_end   date default null
)
returns table (
  carrier          text,
  debt_cents       bigint,
  chargeback_cents bigint,
  adjustment_cents bigint,
  row_count        bigint,
  unmatched_rows   bigint,
  last_at          date
)
language sql
stable
set search_path = public
as $fn$
  select
    coalesce(nullif(btrim(cr.carrier), ''), 'Unnamed carrier')                     as carrier,
    greatest(0, -coalesce(sum(cr.amount_cents), 0))::bigint                        as debt_cents,
    coalesce(sum(cr.amount_cents) filter (where cr.transaction_type = 'chargeback'), 0)::bigint as chargeback_cents,
    coalesce(sum(cr.amount_cents) filter (where cr.transaction_type = 'adjustment'), 0)::bigint as adjustment_cents,
    count(*)::bigint                                                               as row_count,
    count(*) filter (where cr.matched_policy_id is null)::bigint                   as unmatched_rows,
    max(cr.transaction_date)                                                       as last_at
  from public.commission_rows cr
  where cr.transaction_type in ('chargeback', 'adjustment')
    and (p_start is null or cr.transaction_date is null or cr.transaction_date >= p_start)
    and (p_end   is null or cr.transaction_date is null or cr.transaction_date <  p_end)
  group by 1
  having greatest(0, -coalesce(sum(cr.amount_cents), 0)) > 0
  order by 2 desc;
$fn$;

comment on function public.get_commission_debt(date, date) is
  'Caller''s carrier-reported debt: chargeback + adjustment lines per carrier, positive balance only. SECURITY INVOKER, scoped by RLS.';

grant execute on function public.get_commission_debt(date, date) to authenticated;


-- ------------------------------------------------------------
-- 3. get_downline_commission_rollup — a leader's downline. FIGURES ONLY.
--
-- This is the first deliberate cross-agent read of commission data in this
-- schema, and Phase 1's ledger entry deferred it here on purpose. It closes
-- checklist #100: "how much does my downline owe the carriers" is the number
-- an agency owner actually worries about.
--
-- It has to be SECURITY DEFINER, because `commission_rows` is SELECT-only and
-- per-tenant and must stay that way. Everything that makes that safe is in the
-- next three paragraphs.
--
-- THERE IS NO PARAMETER NAMING A LEADER. Both parameters are time bounds. The
-- downline is scoped solely by `ai.leader_id = auth.uid()`, so there is
-- nothing to point at somebody else's agency — the same shape and the same
-- reasoning as get_team_summary and apply_producer_codes.
--
-- IT RETURNS AGGREGATES, NEVER ROWS. No client name, no insured name, no
-- policy number, no carrier, no statement id — money totals and a row count.
-- That is enforced by what the RETURNS TABLE declares, not by what the UI
-- chooses to render, which is the lesson docs/agency-team-screen.md records.
--
-- IT ONLY EVER READS INSIDE THE CALLER'S OWN AGENCY. The `agent_id in (team)`
-- predicate bounds the scan to statements uploaded by the leader or by their
-- accepted downline. Without it, a row attributed to a downline agent by a
-- COMPLETE STRANGER's producer-code entry would be pulled into this leader's
-- rollup — `producer_codes.subject_agent_id` is guarded to self-or-downline,
-- but that guard is about who may CLAIM a code, not about whose rollup the
-- result may appear in.
-- ------------------------------------------------------------
create or replace function public.get_downline_commission_rollup(
  p_start date default null,
  p_end   date default null
)
returns table (
  agent_id         uuid,
  agent_name       text,
  agent_email      text,
  is_self          boolean,
  gross_cents      bigint,
  chargeback_cents bigint,
  net_cents        bigint,
  personal_cents   bigint,
  override_cents   bigint,
  debt_cents       bigint,
  row_count        bigint
)
language sql
security definer
set search_path = public
stable
as $fn$
  with team as (
    select auth.uid() as uid, true as is_self
    union
    select ai.invitee_id, false
    from public.agency_invites ai
    where ai.leader_id  = auth.uid()
      and ai.status     = 'accepted'
      and ai.invitee_id is not null
  ),
  scoped as (
    -- `agent_id in (team)` is the SECURITY bound and the only one: a row
    -- uploaded by someone outside this agency can never enter this rollup,
    -- whoever it happens to be attributed to.
    --
    -- The attribution is then applied only if it lands INSIDE the team, and
    -- otherwise falls back to the uploader. Excluding such a row instead —
    -- which is what this function did first — makes money DISAPPEAR from the
    -- total with nothing on screen to say so: an agent who leaves the agency
    -- flips their invite to `declined`, and every line the leader's own
    -- statements had attributed to them silently drops out of the leader's
    -- figures. A total that quietly shrinks is the worst failure this schema
    -- can produce, and "nothing is discarded" is the rule the whole Back
    -- Office is built on. Found by the behavioural check, not by inspection.
    select
      case
        when coalesce(cr.attributed_agent_id, cr.agent_id) in (select uid from team)
          then coalesce(cr.attributed_agent_id, cr.agent_id)
        else cr.agent_id
      end as uid,
      cr.transaction_type,
      cr.amount_cents
    from public.commission_rows cr
    where cr.agent_id in (select uid from team)
      and (p_start is null or cr.transaction_date is null or cr.transaction_date >= p_start)
      and (p_end   is null or cr.transaction_date is null or cr.transaction_date <  p_end)
  ),
  agg as (
    select
      s.uid,
      coalesce(sum(s.amount_cents) filter (where s.amount_cents > 0), 0)::bigint as gross_cents,
      coalesce(-sum(s.amount_cents) filter (where s.amount_cents < 0), 0)::bigint as chargeback_cents,
      coalesce(sum(s.amount_cents), 0)::bigint                                    as net_cents,
      coalesce(sum(s.amount_cents) filter (
        where s.transaction_type in ('advance', 'renewal', 'chargeback')), 0)::bigint as personal_cents,
      coalesce(sum(s.amount_cents) filter (where s.transaction_type = 'override'), 0)::bigint as override_cents,
      greatest(0, -coalesce(sum(s.amount_cents) filter (
        where s.transaction_type in ('chargeback', 'adjustment')), 0))::bigint     as debt_cents,
      count(*)::bigint                                                            as row_count
    from scoped s
    group by s.uid
  )
  select
    t.uid,
    coalesce(nullif(ag.display_name, ''),
             nullif(au.raw_user_meta_data->>'display_name', ''),
             au.email)                  as agent_name,
    au.email                            as agent_email,
    t.is_self,
    coalesce(agg.gross_cents, 0),
    coalesce(agg.chargeback_cents, 0),
    coalesce(agg.net_cents, 0),
    coalesce(agg.personal_cents, 0),
    coalesce(agg.override_cents, 0),
    coalesce(agg.debt_cents, 0),
    coalesce(agg.row_count, 0)
  from team t
  left join auth.users    au on au.id = t.uid
  left join public.agents ag on ag.id = t.uid
  left join agg              on agg.uid = t.uid
  order by 10 desc, 7 desc;
$fn$;

comment on function public.get_downline_commission_rollup(date, date) is
  'A leader''s downline commission and debt, AGGREGATES ONLY. SECURITY DEFINER with no parameter naming a leader: scoped solely by agency_invites.leader_id = auth.uid().';

grant execute on function public.get_downline_commission_rollup(date, date) to authenticated;
