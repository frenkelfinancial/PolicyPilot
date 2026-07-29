-- ============================================================
-- Back Office, Phase 7 — the Carriers screen.
--
-- ONE function. No table, no column, no data change, no RLS change.
--
-- `get_carrier_summary()` is the read behind a READ-ONLY list of the carriers
-- an agent actually has commission rows for: how many lines, what they paid,
-- what is owed back, and when the last one landed.
--
-- SECURITY INVOKER (the default), so `commission_rows_select_own` is what
-- scopes it. There is no cross-agent carrier view and there should not be one:
-- "which carriers does my downline write" is a question about their book, and
-- the aggregate paths that exist (get_downline_commission_rollup,
-- get_downline_persistency) deliberately return money and rates rather than
-- anything naming a carrier.
--
-- WHY THIS IS DERIVED AND NOT A TABLE. Checklist #103 asks for "appointed
-- carriers, derived from ingested statements", and derived is the whole point:
-- a carrier appears here because it has paid the agent, which is a fact the
-- statements already carry. A `carriers` table would be a second list to
-- maintain, and the first thing an agent would forget to update after taking
-- an appointment.
--
-- `data/carrier_bonuses.json` (45 carriers) and `TRACKER_CARRIER_LIST` (24)
-- are deliberately NOT joined in. They answer a different question — what
-- programmes exist, and what the Add Policy dropdown offers — and folding them
-- together would show an agent carriers they have never written a line with.
-- ============================================================

create or replace function public.get_carrier_summary(
  p_start date default null,
  p_end   date default null
)
returns table (
  carrier            text,
  row_count          bigint,
  policy_count       bigint,
  gross_cents        bigint,
  chargeback_cents   bigint,
  net_cents          bigint,
  debt_cents         bigint,
  premium_cents      bigint,
  unmatched_rows     bigint,
  first_at           date,
  last_at            date
)
language sql
stable
set search_path = public
as $fn$
  select
    coalesce(nullif(btrim(cr.carrier), ''), 'Unnamed carrier')                     as carrier,
    count(*)::bigint                                                               as row_count,
    count(distinct cr.matched_policy_id)::bigint                                   as policy_count,
    coalesce(sum(cr.amount_cents) filter (where cr.amount_cents > 0), 0)::bigint   as gross_cents,
    coalesce(-sum(cr.amount_cents) filter (where cr.amount_cents < 0), 0)::bigint  as chargeback_cents,
    coalesce(sum(cr.amount_cents), 0)::bigint                                      as net_cents,
    -- Same definition the Debt tab uses: chargeback + adjustment only, and only
    -- when the balance is actually against the agent. An advance is not debt.
    greatest(0, -coalesce(sum(cr.amount_cents) filter (
      where cr.transaction_type in ('chargeback','adjustment')), 0))::bigint       as debt_cents,
    coalesce(sum(cr.premium_cents), 0)::bigint                                     as premium_cents,
    count(*) filter (where cr.matched_policy_id is null)::bigint                   as unmatched_rows,
    min(cr.transaction_date)                                                       as first_at,
    max(cr.transaction_date)                                                       as last_at
  from public.commission_rows cr
  where cr.review_status <> 'rejected'
    and (p_start is null or cr.transaction_date is null or cr.transaction_date >= p_start)
    and (p_end   is null or cr.transaction_date is null or cr.transaction_date <  p_end)
  group by 1
  order by 6 desc;
$fn$;

comment on function public.get_carrier_summary(date, date) is
  'Read-only per-carrier totals derived from the caller''s ingested commission rows. SECURITY INVOKER — scoped by RLS, never cross-agent.';

grant execute on function public.get_carrier_summary(date, date) to authenticated;
