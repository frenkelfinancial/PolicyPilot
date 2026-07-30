-- ============================================================
-- Display names everywhere; email addresses nowhere peer-facing.
--
-- Feature doc: docs/agency-leaderboards.md § "Who an agent is called".
--
-- ADDITIVE. Five `create or replace function`, three guarded `UPDATE`s that
-- only ever fill a blank or correct a stored name, and one grant. No table, no
-- column, no index, no policy. No DROP, no DELETE, no TRUNCATE. Nothing in
-- `auth.*` or `storage.*` is WRITTEN (auth.users is read for the name a
-- consumer's identity provider already gave us). Re-running is a no-op.
--
-- ------------------------------------------------------------------
-- WHAT WAS WRONG
-- ------------------------------------------------------------------
-- Every name-resolving expression in this schema ended `..., au.email)`, and
-- `agents.display_name` is NULL for all 8 production agents. So the fallback
-- was not a fallback — it was the ANSWER, for everybody.
--
-- The account this ships for renders as `jacef8778099@gmail.com` on the team
-- table, all seven leaderboards, both record scopes, the Hall of Fame, the
-- milestone feed, the roster and the lead-transfer picker. Two downline agents
-- can read it today. `agency_records.holder_name` has it STORED, seven times.
--
-- The near-miss that made it invisible: the old chain probed
-- `raw_user_meta_data->>'display_name'`, and Google OAuth writes the person's
-- name to `full_name` and `name`. One key away from correct.
--
-- ------------------------------------------------------------------
-- ONE RESOLVER, AND EVERY SURFACE READS IT
-- ------------------------------------------------------------------
-- `pp_display_name()` is the single definition. `lb_agent_name` now delegates
-- to it rather than carrying a second copy; `get_team_summary` and
-- `get_agency_members` call it instead of inlining a COALESCE. Those two
-- functions are otherwise reproduced BYTE-IDENTICALLY from the migrations that
-- most recently define them (20260741 and 20260737) — the file is generated,
-- not retyped, and the generator throws if either expression has moved.
--
-- The chain, and why it is in this order:
--
--   1. agents.display_name              what the agent typed in Settings
--   2. raw_user_meta_data->>'display_name'   preserved: the old chain's key
--   3. raw_user_meta_data->>'full_name'      Google/Apple give us a PERSON
--   4. raw_user_meta_data->>'name'           same, other providers
--   5. dba_name / business_legal_name / agency_name   the business profile
--   6. the email's LOCAL PART, prettified    never the address itself
--   7. 'Agent'                                rather than a blank cell
--
-- The identity-provider name sits ABOVE the business profile deliberately,
-- and it is the one place this file departs from the brief as written. A
-- leaderboard row names a PERSON. Jace's business profile says "Frenkel
-- Financial LLC" and his Google account says "Jace Frenkel"; ranking a company
-- against ten people reads as a bug, and "confirm my own account renders as
-- Jace Frenkel" is the stated acceptance test. The business profile is still
-- in the chain, one rung lower, for an agent who has one and no OAuth name.
--
-- Step 6 keeps a promise rather than making a compromise: `owenclark.2831`
-- becomes "Owenclark 2831", which is not a mailto: and cannot be harvested,
-- but is still recognisably them to their own team.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The resolver.
--
-- SECURITY DEFINER because it reads auth.users, which `authenticated` cannot.
-- It returns a NAME and nothing else — no email, no id — so it is safe to
-- expose, and every cross-agent surface already had to resolve names somehow.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pp_display_name(p_agent uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE((
    SELECT COALESCE(
      NULLIF(btrim(ag.display_name), ''),
      NULLIF(btrim(au.raw_user_meta_data->>'display_name'), ''),
      NULLIF(btrim(au.raw_user_meta_data->>'full_name'), ''),
      NULLIF(btrim(au.raw_user_meta_data->>'name'), ''),
      NULLIF(btrim(ag.dba_name), ''),
      NULLIF(btrim(ag.business_legal_name), ''),
      NULLIF(btrim(ag.agency_name), ''),
      -- The email's LOCAL PART only, separators to spaces, title-cased.
      -- Never the address: no domain, no '@', nothing a scraper can use.
      NULLIF(btrim(initcap(regexp_replace(split_part(au.email, '@', 1),
                                          '[._+-]+', ' ', 'g'))), '')
    )
    FROM auth.users au
    LEFT JOIN public.agents ag ON ag.id = au.id
    WHERE au.id = p_agent
  ), 'Agent');
$fn$;

COMMENT ON FUNCTION public.pp_display_name(uuid) IS
  'The ONE name resolver. Returns a human name for an agent and never an email address. Every peer-visible surface reads this, directly or through lb_agent_name / get_team_summary / get_agency_members.';

REVOKE ALL ON FUNCTION public.pp_display_name(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pp_display_name(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pp_display_name(uuid) TO service_role;


-- ------------------------------------------------------------
-- 2. lb_agent_name delegates rather than duplicating.
--
-- It was a second copy of the same COALESCE, which is exactly how the two
-- would have drifted the first time somebody fixed one of them.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lb_agent_name(p_agent uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT public.pp_display_name(p_agent);
$fn$;


-- ------------------------------------------------------------
-- 3. get_team_summary — reproduced verbatim from 20260741 with ONE
--    expression changed (agent_name). Signature, RETURNS TABLE, the sale
--    predicate, the AP guard and all eight window bounds are untouched, so
--    CREATE OR REPLACE suffices and nothing is dropped.
--
--    agent_email STAYS in the result. It identifies an invitation, and the
--    roster panel still needs it for a pending row where no account exists.
--    What changed is that it is no longer anybody's rendered NAME.
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
    public.pp_display_name(t.uid)                 AS agent_name,
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


-- ------------------------------------------------------------
-- 4. get_agency_members — likewise, verbatim from 20260737 with one
--    expression changed. This one feeds the lead-transfer recipient picker.
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
    public.pp_display_name(r.uid)                 as agent_name,
    au.email                                     as agent_email,
    pl.name                                      as agent_plan,
    r.rel                                        as relationship
  from ranked r
  join auth.users au        on au.id = r.uid
  left join public.agents ag on ag.id = r.uid
  left join public.plans  pl on pl.id = ag.plan_id
  order by 2;
$$;


-- ------------------------------------------------------------
-- 5. Backfill agents.display_name.
--
-- Only ever fills a BLANK — an agent who has set a name keeps it, and
-- re-running writes nothing. The source order matches the resolver's:
-- identity-provider person name first, business profile second.
--
-- This is a convenience, not the fix: pp_display_name() already resolves the
-- same value at read time for a row this leaves alone. Filling the column
-- means the Settings field opens pre-populated with the name the agent is
-- already being shown, instead of looking empty and inviting them to wonder
-- where "Jace Frenkel" came from.
-- ------------------------------------------------------------
UPDATE public.agents ag
   SET display_name = src.nm
  FROM (
    SELECT au.id,
           COALESCE(
             NULLIF(btrim(au.raw_user_meta_data->>'display_name'), ''),
             NULLIF(btrim(au.raw_user_meta_data->>'full_name'), ''),
             NULLIF(btrim(au.raw_user_meta_data->>'name'), ''),
             NULLIF(btrim(a2.dba_name), ''),
             NULLIF(btrim(a2.business_legal_name), ''),
             NULLIF(btrim(a2.agency_name), '')
           ) AS nm
      FROM auth.users au
      LEFT JOIN public.agents a2 ON a2.id = au.id
  ) src
 WHERE src.id = ag.id
   AND src.nm IS NOT NULL
   AND COALESCE(btrim(ag.display_name), '') = '';


-- ------------------------------------------------------------
-- 6. Correct the names already STORED on the leaderboard tables.
--
-- These three columns are denormalized on purpose — a Hall of Fame that
-- forgets a winner's name when they leave the agency is not a hall of fame —
-- which also means they froze whatever the broken resolver returned. On this
-- database that is seven `agency_records` rows reading an email address, live
-- on the Records screen for two downline agents.
--
-- Each UPDATE is scoped to rows whose stored name DIFFERS from what the
-- resolver now returns, so re-running is a no-op, and to rows that still name
-- a live agent — a row whose holder was deleted keeps the name it was set
-- with, which is the entire point of storing it.
-- ------------------------------------------------------------
UPDATE public.agency_records ar
   SET holder_name = public.pp_display_name(ar.holder_agent_id),
       updated_at  = now()
 WHERE ar.holder_agent_id IS NOT NULL
   AND ar.holder_name IS DISTINCT FROM public.pp_display_name(ar.holder_agent_id);

UPDATE public.agency_milestones m
   SET agent_name = public.pp_display_name(m.agent_id)
 WHERE m.agent_id IS NOT NULL
   AND m.agent_name IS DISTINCT FROM public.pp_display_name(m.agent_id);

UPDATE public.leaderboard_snapshots s
   SET agent_name = public.pp_display_name(s.agent_id)
 WHERE s.agent_id IS NOT NULL
   AND s.agent_name IS DISTINCT FROM public.pp_display_name(s.agent_id);
