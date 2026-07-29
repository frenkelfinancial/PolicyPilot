-- ============================================================
-- Back Office, Phase 5 — persistency.
--
-- ONE function. No table, no column, no data change, no RLS change.
--
--   get_downline_persistency(p_now date)
--     per-agent cohort and kept counts at 4 / 9 / 13 / 25 months, for the
--     caller and their accepted downline. AGGREGATES ONLY.
--
-- WHY THIS EXISTS AT ALL
--
-- The POLICY view of persistency — by carrier, by lead source — is computed in
-- the browser from the agent's own `policies` array, which is already loaded.
-- No RPC is needed or wanted for it.
--
-- The AGENT view is different: for a solo agent it is one row (their own book)
-- and for an agency owner it is the whole point. "Which of my agents writes
-- business that sticks" is the question persistency exists to answer, and it
-- cannot be answered from the browser because `policies` RLS is owner-only.
--
-- WHAT IT RETURNS, AND WHAT IT DOES NOT
--
-- Four counts per (agent, window): how many policies were in the cohort, how
-- many are still in force, and the same two in annualised premium so the
-- browser can offer Flat vs Weighted from one round trip. Nothing else. No
-- client name, no policy number, no carrier, no lead source — a leader gets a
-- RATE, exactly as `docs/agency-team-screen.md` requires and exactly as
-- get_team_summary and get_downline_commission_rollup already do.
--
-- THE TWO DEFINITIONS, WHICH MUST MATCH THE BROWSER
--
--   COHORT — a policy that reached issue and is old enough. Statuses that
--            never issued (pending, approved, denied, withdrawn) are NOT in
--            the cohort: a policy the carrier declined was never at risk of
--            lapsing, and counting it as a lapse would punish an agent for
--            underwriting.
--
--   KEPT   — issued | paid | placed | claim. A CLAIM IS NOT A LAPSE: the
--            policy stayed in force until the insured died, which is the
--            policy doing its job. Counting it against the agent is both wrong
--            and, for a final-expense book, common enough to matter.
--
-- `persistCohortStatuses` / `persistKeptStatuses` in the `// <persist-core>`
-- block are the same two lists, and a test asserts they agree with this file.
--
-- THE ISSUE DATE IS A FALLBACK CHAIN, AND THAT IS A FIX
--
-- issueDate -> draft -> dateSubmitted. `issueDate` is an OPTIONAL field on the
-- Add Policy form: in production only 8 of 23 policies carry one, while all 23
-- carry a draft date. The pre-existing `persistency13mo()` keyed on issueDate
-- alone, so it silently ignored two thirds of the book and reported a rate
-- over whatever was left. A persistency figure computed from a third of the
-- policies is worse than no figure, because it looks like a figure.
-- ============================================================

create or replace function public.get_downline_persistency(
  p_now date default null
)
returns table (
  agent_id       uuid,
  agent_name     text,
  agent_email    text,
  is_self        boolean,
  window_months  int,
  cohort_count   bigint,
  kept_count     bigint,
  cohort_ap      numeric,
  kept_ap        numeric
)
language sql
security definer
set search_path = public
stable
as $fn$
  with bounds as (
    select coalesce(p_now, current_date) as today
  ),
  team as (
    select auth.uid() as uid, true as is_self
    union
    select ai.invitee_id, false
    from public.agency_invites ai
    where ai.leader_id  = auth.uid()
      and ai.status     = 'accepted'
      and ai.invitee_id is not null
  ),
  windows as (
    select * from (values (4), (9), (13), (25)) as w(months)
  ),
  pol as (
    select
      po.agent_id as uid,
      -- issueDate -> draft -> dateSubmitted, each regex-guarded before the
      -- cast for the same reason get_team_summary guards AP: these are
      -- free-text jsonb values and one malformed date would abort everything.
      coalesce(
        case when coalesce(po.data->>'issueDate','')     ~ '^\d{4}-\d{2}-\d{2}'
             then (left(po.data->>'issueDate', 10))::date end,
        case when coalesce(po.data->>'draft','')         ~ '^\d{4}-\d{2}-\d{2}'
             then (left(po.data->>'draft', 10))::date end,
        case when coalesce(po.data->>'dateSubmitted','') ~ '^\d{4}-\d{2}-\d{2}'
             then (left(po.data->>'dateSubmitted', 10))::date end
      ) as started_on,
      coalesce(po.data->>'status','') as status,
      case when coalesce(po.data->>'ap','') ~ '^-?[0-9]+(\.[0-9]+)?$'
           then (po.data->>'ap')::numeric else 0 end as ap
    from public.policies po
    join team t on t.uid = po.agent_id
  ),
  eligible as (
    select * from pol
    where started_on is not null
      -- Reached issue. A policy that never issued was never at risk.
      and status not in ('pending', 'approved', 'denied', 'withdrawn')
  ),
  agg as (
    select
      e.uid,
      w.months,
      count(*)::bigint                                                     as cohort_count,
      count(*) filter (where e.status in ('issued','paid','placed','claim'))::bigint as kept_count,
      coalesce(sum(e.ap), 0)::numeric                                      as cohort_ap,
      coalesce(sum(e.ap) filter (
        where e.status in ('issued','paid','placed','claim')), 0)::numeric as kept_ap
    from eligible e
    cross join windows w
    cross join bounds b
    where e.started_on <= (b.today - make_interval(months => w.months))
    group by e.uid, w.months
  )
  select
    t.uid,
    coalesce(nullif(ag.display_name, ''),
             nullif(au.raw_user_meta_data->>'display_name', ''),
             au.email)              as agent_name,
    au.email                        as agent_email,
    t.is_self,
    w.months,
    coalesce(agg.cohort_count, 0),
    coalesce(agg.kept_count, 0),
    coalesce(agg.cohort_ap, 0),
    coalesce(agg.kept_ap, 0)
  from team t
  cross join windows w
  left join auth.users    au on au.id = t.uid
  left join public.agents ag on ag.id = t.uid
  left join agg              on agg.uid = t.uid and agg.months = w.months
  order by t.is_self desc, agent_name, w.months;
$fn$;

comment on function public.get_downline_persistency(date) is
  'Per-agent persistency cohorts at 4/9/13/25 months for the caller and their accepted downline. AGGREGATES ONLY — counts and premium, never a policy. SECURITY DEFINER with no parameter naming a leader.';

grant execute on function public.get_downline_persistency(date) to authenticated;
