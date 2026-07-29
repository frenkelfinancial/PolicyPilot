-- ============================================================
-- Phase B — one merged leader home screen.
--
-- The Agency tab and the Summary "Team" table have until now read two
-- different functions (get_agency_stats and get_team_summary) with two
-- different status filters and two different period notions. That is the
-- shape that produced the 8,610x AP overstatement fixed in 20260736: same
-- agent, two screens, two numbers. This migration makes get_team_summary
-- the SINGLE source both surfaces read, and gives it everything the merged
-- screen needs so neither surface has to reach for a second query.
--
-- Two changes:
--
--   1. agency_invites.accepted_at  — additive column + a stamping trigger.
--      "Joined" on a team roster means "joined the agency", and the table
--      only ever recorded when the INVITE WAS SENT (created_at). For a code
--      join those are the same instant; for an emailed invite accepted three
--      weeks later they are not, and the roster would have claimed tenure
--      the agent did not have — which then feeds the 30-day at-risk grace
--      period, so a wrong date is not merely cosmetic.
--
--   2. get_team_summary — REPLACED (drop + create in one transaction).
--      Authorised by Jace 2026-07-29 in answer to question 7 of the build
--      brief. This drops a FUNCTION, not a table: no row, no column and no
--      byte of data is read, moved or deleted by it, and the whole file is
--      transaction-wrapped so a failure leaves the old definition in place.
--      A return-type change cannot be done with CREATE OR REPLACE.
--
-- Additive in every other respect: no DROP of any table/column, no DELETE,
-- no TRUNCATE, nothing in auth.* or storage.*. Re-running is a no-op.
--
-- Pre-apply audit (2026-07-29): agency_invites 0 rows, accepted_at absent,
-- no triggers on the table, get_team_summary present with the 2-argument
-- signature and a 7-column result. So the backfill below is a guaranteed
-- no-op and nothing depends on the old column list except app.html, which
-- reads by name and is unaffected by additional columns.
--
-- Feature doc: docs/agency-team-screen.md
-- ============================================================


-- ------------------------------------------------------------
-- 1. agency_invites.accepted_at
-- ------------------------------------------------------------
ALTER TABLE public.agency_invites
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

-- Backfill: an already-accepted row has no better evidence than the invite
-- date, and leaving it NULL would make an existing member look like they
-- joined never. Guaranteed no-op today (0 accepted rows) but correct if this
-- file is ever replayed against a populated database.
UPDATE public.agency_invites
   SET accepted_at = created_at
 WHERE status = 'accepted'
   AND accepted_at IS NULL;

-- Stamp it on the transition, from whichever path performs it. There are two
-- and they look nothing alike: the browser UPDATEs the row directly
-- (agAcceptInvite, under the "invitees respond to invites" policy), and
-- process_agency_code_join INSERTs ... ON CONFLICT DO UPDATE as the table
-- owner. A trigger is the only place that covers both without duplicating
-- the rule, and it keeps working if a third path is ever added.
--
-- Write-once for client callers. `accepted_at` is roster metadata rather
-- than a privilege, so this is not a security boundary — but tenure gates
-- the at-risk grace period, and a leader who can backdate a join date can
-- suppress a badge. Cheap to close, so it is closed. Trusted contexts
-- (service_role, SQL editor, migrations) keep the carve-out every other
-- guard in this schema uses, so a future correction is not blocked.
CREATE OR REPLACE FUNCTION public.agency_invites_stamp_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' AND auth.role() IS DISTINCT FROM 'anon' THEN
    -- Trusted caller: fill a blank, honour anything explicit.
    IF NEW.status = 'accepted' AND NEW.accepted_at IS NULL THEN
      NEW.accepted_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.accepted_at IS NOT NULL THEN
    NEW.accepted_at := OLD.accepted_at;          -- write-once
  ELSIF NEW.status = 'accepted' THEN
    NEW.accepted_at := now();                    -- never client-supplied
  ELSE
    NEW.accepted_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agency_invites_stamp_accepted ON public.agency_invites;
CREATE TRIGGER agency_invites_stamp_accepted
  BEFORE INSERT OR UPDATE ON public.agency_invites
  FOR EACH ROW EXECUTE FUNCTION public.agency_invites_stamp_accepted();


-- ------------------------------------------------------------
-- 2. get_team_summary — the one function both surfaces read.
--
-- Still SECURITY DEFINER, and the authorization is unchanged and still the
-- only thing standing between a caller and someone else's aggregates:
--
--     ai.leader_id = auth.uid()
--
-- There is deliberately NO parameter naming a leader. get_agency_stats takes
-- p_leader_id and then has to re-check it against auth.uid(); this function
-- cannot be pointed at another leader's downline because there is nothing to
-- point. A non-leader calling it gets a team of one — their own row, which is
-- their own data.
--
-- It returns aggregates ONLY: AP, counts, call seconds, plan name, and
-- timestamps. No client names, no policy detail, no commission figures. The
-- merged Agency screen is built on this function alone, so that constraint is
-- now enforced by what the query selects rather than by what the UI chooses
-- to render.
--
-- Windows. All eight bounds are optional and NULL means unbounded, which is
-- how the "Lifetime" period is expressed:
--
--   p_start/p_end               the selected period
--   p_prev_start/p_prev_end     the comparable preceding period (trend)
--   p_month_start/p_month_end   this calendar month  \  the at-risk pair,
--   p_prev_month_*              last calendar month  /  fixed month-over-month
--
-- The month bounds are passed in rather than derived from now() because the
-- browser knows the agent's local calendar and the server only knows UTC;
-- near a month boundary those disagree by hours, and the at-risk badge would
-- flip depending on who did the arithmetic. Server-side defaults exist so a
-- caller that omits them still gets a sane answer.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_team_summary(timestamptz, timestamptz);

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
    WHERE COALESCE(po.data->>'status','') NOT IN ('lapsed','chargeback')
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

-- Browser-callable by authenticated users; the caller only ever sees their
-- own downline (ai.leader_id = auth.uid()). Same grant the 2-argument
-- version carried — restated because DROP took the old ACL with it.
REVOKE ALL ON FUNCTION public.get_team_summary(timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_team_summary(timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) TO authenticated, service_role;
