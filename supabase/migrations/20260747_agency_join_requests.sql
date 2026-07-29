-- ============================================================
-- Agency JOIN REQUESTS — agent-initiated "request to join" flow.
--
-- Until now the only ways onto a leader's roster were:
--   (a) the leader emails/sends an invite — an agency_invites row the
--       leader creates, that the AGENT accepts; and
--   (b) the agent signs up WITH the agency code — process_agency_code_join,
--       which auto-accepts and grants the 30% signup discount.
--
-- This adds the reverse of (a): an existing Basic/Pro agent types a
-- leader's agency code IN-APP and sends a REQUEST the LEADER must approve.
-- The leader sees the requester's name, plan tier, comp (contract) level
-- and NPN before deciding. Nothing about the signup path (b) changes, and
-- no discount is ever granted by this path.
--
-- Additive only: one nullable-with-default column and two SECURITY DEFINER
-- functions. No DROP of any table/column, no DELETE, no data rewrite,
-- nothing in auth.*/storage.*. Re-running is a no-op.
--
-- Run this in your Supabase SQL editor after 20260738_team_roster.sql.
-- Feature doc: docs/agency-team-screen.md
-- ============================================================


-- ------------------------------------------------------------
-- 1. Direction marker on agency_invites.
--
-- The same table now carries two kinds of pending row: an invite the
-- LEADER sent (the agent accepts) and a request the AGENT sent (the leader
-- accepts). Both are status='pending'; only initiated_by tells them apart,
-- so each surface can show the right half to the right person.
--
-- Every existing row is either a leader-sent invite or an accepted signup
-- join — 'leader' is the correct backfill for all of them, and the DEFAULT
-- keeps the browser's existing agSendInvite() insert (which does not name
-- the column) writing a leader invite exactly as before. Only
-- request_agency_join() below ever writes 'agent'.
-- ------------------------------------------------------------
ALTER TABLE public.agency_invites
  ADD COLUMN IF NOT EXISTS initiated_by text NOT NULL DEFAULT 'leader'
    CHECK (initiated_by IN ('leader','agent'));


-- ------------------------------------------------------------
-- 2. request_agency_join(code) — the agent asks to join.
--
-- SECURITY DEFINER because the row it writes has leader_id = SOMEONE ELSE,
-- which the "leaders manage their invites" RLS policy refuses from the
-- browser. Same shape and guards as process_agency_code_join (code must
-- resolve, cannot be your own agency, and the code's owner must CURRENTLY
-- be a Team Leader) with one deliberate difference: it writes
-- status='pending', never 'accepted'. The leader approves in-app, and this
-- path grants no discount.
--
-- If the leader had already invited this agent (a pending LEADER invite),
-- typing the code is taken as accepting it — both sides have now consented
-- — so that row is accepted rather than a second, contradictory request
-- being filed against the same UNIQUE (leader_id, invitee_email) pair.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_agency_join(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_leader_id    uuid;
  v_leader_email text;
  v_leader_name  text;
  v_me_email     text;
  v_existing     record;
BEGIN
  SELECT ag.id, au.email, COALESCE(ag.display_name, au.email)
  INTO   v_leader_id, v_leader_email, v_leader_name
  FROM   public.agents ag
  JOIN   auth.users au ON au.id = ag.id
  WHERE  ag.agency_code = upper(trim(p_code))
  LIMIT  1;

  IF v_leader_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Agency code not found');
  END IF;

  IF v_leader_id = auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'You cannot request to join your own agency');
  END IF;

  -- The account behind the code must CURRENTLY hold a Team Leader plan —
  -- identical check to process_agency_code_join, so a lapsed leader's code
  -- cannot collect recruits by either path.
  IF NOT public.is_agency_leader(v_leader_id) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'That agency code is not active right now — ask the team leader to check their plan');
  END IF;

  SELECT email INTO v_me_email FROM auth.users WHERE id = auth.uid();

  SELECT id, status, initiated_by INTO v_existing
  FROM public.agency_invites
  WHERE leader_id = v_leader_id AND invitee_email = v_me_email
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.status = 'accepted' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'You are already a member of this agency');
    ELSIF v_existing.status = 'pending' AND v_existing.initiated_by = 'leader' THEN
      -- Leader already invited you; typing the code accepts that invite.
      UPDATE public.agency_invites
         SET status = 'accepted', invitee_id = auth.uid()
       WHERE id = v_existing.id;
      RETURN jsonb_build_object('ok', true, 'auto_accepted', true, 'leader_name', v_leader_name);
    END IF;
  END IF;

  INSERT INTO public.agency_invites
    (leader_id, leader_email, leader_name, invitee_email, invitee_id, status, initiated_by)
  VALUES
    (v_leader_id, v_leader_email, v_leader_name, v_me_email, auth.uid(), 'pending', 'agent')
  ON CONFLICT (leader_id, invitee_email)
  DO UPDATE SET status = 'pending', initiated_by = 'agent', invitee_id = auth.uid();

  RETURN jsonb_build_object('ok', true, 'pending', true, 'leader_name', v_leader_name);
END;
$$;

REVOKE ALL ON FUNCTION public.request_agency_join(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_agency_join(text) TO authenticated, service_role;


-- ------------------------------------------------------------
-- 3. get_agency_join_requests() — what the leader sees before deciding.
--
-- Returns the profile of every agent with a PENDING, AGENT-initiated
-- request to the caller: name, plan tier, comp (contract) level and NPN.
-- Scoped hard to leader_id = auth.uid() AND status='pending' AND
-- initiated_by='agent', so it can only ever reveal the details of someone
-- who has personally asked THIS caller to be let in — the same
-- self-or-own-downline shape every other DEFINER read in this schema uses.
--
-- comp level and plan are read authoritatively from agents/plans (the
-- leader wants the real numbers, not client-reported ones); name and NPN
-- come from the requester's signup metadata, NPN being optional
-- ('if applicable'). comp_level is returned as text so this function is
-- agnostic to whether agents.contract_level is stored int or numeric.
--
-- This is NOT a widening of the aggregates-only rule that governs leader
-- views of DOWNLINE PERFORMANCE (get_team_summary): it exposes no policy,
-- commission or client data — only the requester's own identity, which
-- they volunteered by asking to join, and only while the ask is pending.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_agency_join_requests()
RETURNS TABLE (
  invite_id     uuid,
  requester_id  uuid,
  email         text,
  first_name    text,
  last_name     text,
  display_name  text,
  npn           text,
  comp_level    text,
  plan_name     text,
  requested_at  timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    ai.id,
    ai.invitee_id,
    au.email,
    NULLIF(au.raw_user_meta_data->>'first_name',''),
    NULLIF(au.raw_user_meta_data->>'last_name',''),
    NULLIF(ag.display_name,''),
    NULLIF(au.raw_user_meta_data->>'npn',''),
    NULLIF(ag.contract_level::text,''),
    pl.name,
    ai.created_at
  FROM public.agency_invites ai
  JOIN auth.users au ON au.id = ai.invitee_id
  LEFT JOIN public.agents ag ON ag.id = ai.invitee_id
  LEFT JOIN public.plans  pl ON pl.id = ag.plan_id
  WHERE ai.leader_id    = auth.uid()
    AND ai.status       = 'pending'
    AND ai.initiated_by = 'agent'
  ORDER BY ai.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.get_agency_join_requests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agency_join_requests() TO authenticated, service_role;
