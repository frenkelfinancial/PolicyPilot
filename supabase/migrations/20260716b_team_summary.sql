-- ============================================================
-- get_team_summary — per-agent production + calling rollup for a
-- Team Leader's downline over a [p_start, p_end) window.
--
-- SECURITY DEFINER so it can read downline policies/calls past
-- per-agent RLS, but it returns ONLY aggregate rows (AP, sales,
-- dials, call time) — never client names, policy details, comp
-- levels, or commission amounts.
--
-- SELF-CONTAINED: safe to run on its own. It does not depend on the
-- agency helper functions (is_agency_leader) or the plans table; it
-- only needs auth.users + policies + calls (core) and agency_invites
-- (created below if missing). The downline is scoped by
-- ai.leader_id = auth.uid(), so a caller can ONLY ever see agents
-- they personally lead — a non-leader gets a "team of one" (just
-- their own row, which is data they already own). The frontend
-- additionally renders the Team section for leader/admin plans only.
--
-- Run once in your Supabase SQL editor.
-- ============================================================

-- Ensure the downline link table exists (no-op if the full agency
-- feature — 20260616_agency.sql — has already created it). Populating
-- it (building downlines) still requires the agency join RPCs from
-- 20260617_agency_code.sql; without them a leader simply sees a team
-- of one until teammates join with their agency code.
CREATE TABLE IF NOT EXISTS public.agency_invites (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  leader_email   text,
  leader_name    text,
  invitee_email  text,
  invitee_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  status         text        NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Lock the table down to definer-only access when freshly created
-- (enabling RLS with no policy denies direct client reads/writes;
-- the SECURITY DEFINER function below still reads it). Idempotent.
ALTER TABLE public.agency_invites ENABLE ROW LEVEL SECURITY;

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
  WITH team AS (
    -- The caller's own row (always present; only their own aggregates,
    -- which they already own — no cross-agent leak).
    SELECT auth.uid() AS uid, true AS is_leader
    UNION
    -- Accepted downline invitees — the load-bearing authorization is
    -- ai.leader_id = auth.uid(): you can only ever see agents YOU lead.
    SELECT ai.invitee_id AS uid, false AS is_leader
    FROM public.agency_invites ai
    WHERE ai.leader_id  = auth.uid()
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
    t.uid                                                       AS agent_id,
    COALESCE(NULLIF(au.raw_user_meta_data->>'display_name',''),
             au.email)                                          AS agent_name,
    t.is_leader,
    COALESCE(pol.ap, 0)                                         AS ap,
    COALESCE(pol.sales, 0)                                      AS sales,
    COALESCE(cl.dials, 0)                                       AS dials,
    COALESCE(cl.call_time_sec, 0)                               AS call_time_sec
  FROM team t
  LEFT JOIN auth.users au ON au.id = t.uid
  LEFT JOIN pol ON pol.agent_id = t.uid
  LEFT JOIN cl  ON cl.agent_id  = t.uid
  ORDER BY ap DESC;
$$;

-- Browser-callable by authenticated users; the caller only ever sees their
-- own downline (via ai.leader_id = auth.uid()). Matches get_agency_stats,
-- which relies on the default authenticated grant.
REVOKE ALL ON FUNCTION public.get_team_summary(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_team_summary(timestamptz, timestamptz) TO authenticated, service_role;
