-- ============================================================
-- get_team_summary — per-agent production + calling rollup for a
-- Team Leader's downline over a [p_start, p_end) window.
--
-- SECURITY DEFINER so it can read downline policies/calls past
-- per-agent RLS, but it returns ONLY aggregate rows (AP, sales,
-- dials, call time) — never client names, policy details, comp
-- levels, or commission amounts. The caller self-authorizes via
-- is_agency_leader(auth.uid()); non-leaders get zero rows.
--
-- Run this once in your Supabase SQL editor, after
-- 20260703b_agency_leader_gate.sql (which provides is_agency_leader).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_team_summary(p_start timestamptz, p_end timestamptz)
RETURNS TABLE (
  agent_id       uuid,
  agent_name     text,
  is_leader      boolean,
  ap             numeric,
  sales          bigint,
  dials          bigint,
  call_time_sec  numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH gate AS (
    -- Load-bearing authorization: only a real Team Leader (or admin)
    -- gets a non-empty team, and only for their own downline.
    SELECT public.is_agency_leader(auth.uid()) AS ok
  ),
  team AS (
    -- The leader themselves (their own row is marked is_leader = true).
    SELECT auth.uid() AS uid, true AS is_leader
    FROM gate WHERE ok
    UNION
    -- Accepted downline invitees for this leader.
    SELECT ai.invitee_id AS uid, false AS is_leader
    FROM public.agency_invites ai, gate
    WHERE gate.ok
      AND ai.leader_id  = auth.uid()   -- caller must be the leader
      AND ai.status     = 'accepted'
      AND ai.invitee_id IS NOT NULL
  ),
  pol AS (
    -- Period-scoped policy production per agent. A "sale" is a policy whose
    -- submitted date (dateSubmitted, else draft) falls in the window and whose
    -- status is not lapsed/chargeback. Date strings are ISO (YYYY-MM-DD); the
    -- regex guard keeps a malformed value from erroring the whole query.
    SELECT po.agent_id,
           COUNT(*)                                   AS sales,
           COALESCE(SUM((po.data->>'ap')::numeric),0) AS ap
    FROM public.policies po
    JOIN team t ON t.uid = po.agent_id
    WHERE COALESCE(po.data->>'status','') NOT IN ('lapsed','chargeback')
      AND COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')) ~ '^\d{4}-\d{2}-\d{2}'
      AND (COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')))::date >= p_start::date
      AND (COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')))::date <  p_end::date
    GROUP BY po.agent_id
  ),
  cl AS (
    -- Period-scoped dialer activity per agent.
    SELECT c.agent_id,
           COUNT(*)                        AS dials,
           COALESCE(SUM(c.duration_sec),0) AS call_time_sec
    FROM public.calls c
    JOIN team t ON t.uid = c.agent_id
    WHERE c.started_at >= p_start
      AND c.started_at <  p_end
    GROUP BY c.agent_id
  )
  SELECT
    t.uid                                AS agent_id,
    COALESCE(ag.display_name, au.email)  AS agent_name,
    t.is_leader,
    COALESCE(pol.ap, 0)                  AS ap,
    COALESCE(pol.sales, 0)               AS sales,
    COALESCE(cl.dials, 0)                AS dials,
    COALESCE(cl.call_time_sec, 0)        AS call_time_sec
  FROM team t
  LEFT JOIN auth.users    au ON au.id = t.uid
  LEFT JOIN public.agents ag ON ag.id = t.uid
  LEFT JOIN pol ON pol.agent_id = t.uid
  LEFT JOIN cl  ON cl.agent_id  = t.uid
  ORDER BY ap DESC;
$$;

-- Browser-callable by authenticated users; the function self-authorizes via
-- is_agency_leader(auth.uid()) and returns zero rows to non-leaders. Matches
-- get_agency_stats, which relies on the default authenticated grant.
REVOKE ALL ON FUNCTION public.get_team_summary(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_team_summary(timestamptz, timestamptz) TO authenticated, service_role;
