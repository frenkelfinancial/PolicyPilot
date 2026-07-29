-- ============================================================
-- Phase A — Team Leader / downline hardening + reporting fix.
--
-- Three independent, idempotent changes. Additive only: no DROP,
-- no data change, no auth.*/storage.* writes.
--
--   1. get_agency_stats — fix inflated AP, align status filter with
--      get_team_summary so the Agency tab and the Summary Team table
--      report the same numbers for the same agent.
--   2. agents_protect_privileged_columns — close the last ungated
--      route to becoming an agency leader (direct write of
--      agents.agency_code from the browser).
--   3. process_agency_code_join — refuse to attach a downline to an
--      account that does not currently qualify as a leader.
--
-- Audited before writing (2026-07-28): production has ZERO rows in
-- agency_invites and ZERO agents with agency_code set, so nothing
-- here migrates existing data — it is all preventive.
-- ============================================================


-- ------------------------------------------------------------
-- 1. get_agency_stats — AP was multiplied by (calls x leads).
--
-- The original joined policies, calls, and leads onto the same row
-- in ONE select. COUNT(DISTINCT ...) corrected the three counts, but
-- SUM((po.data->>'ap')::numeric) had no DISTINCT and no way to get
-- one — so every policy's AP was added once per (call x lead) pair.
-- An agent with 10 calls and 5 leads reported 50x their true AP on
-- the Agency tab, while the Summary Team table (get_team_summary)
-- reported it correctly. Same agent, two screens, two numbers.
--
-- Fixed with independent scalar subqueries: each aggregate now walks
-- exactly one table, which is also what removes the cartesian blow-up
-- (the old shape materialised policies x calls x leads rows per agent
-- before aggregating).
--
-- Status filter: 'lapsed' and 'chargeback' are now excluded from BOTH
-- the policy count and the AP sum, using the identical predicate
-- get_team_summary already uses. That is the change that makes the
-- two screens agree.
--
-- Deliberately unchanged: the auth.users join (agents.email exists but
-- is not proven populated for every row, and agent_email is a UI
-- fallback), and the `ai.leader_id = auth.uid()` authorization guard.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_agency_stats(p_leader_id uuid)
RETURNS TABLE (
  agent_id       uuid,
  agent_email    text,
  agent_name     text,
  agent_plan     text,
  policy_count   bigint,
  total_ap       numeric,
  call_count     bigint,
  lead_count     bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    ai.invitee_id                                AS agent_id,
    au.email                                     AS agent_email,
    COALESCE(ag.display_name, au.email)          AS agent_name,
    pl.name                                      AS agent_plan,
    (SELECT COUNT(*)
       FROM public.policies po
      WHERE po.agent_id = ai.invitee_id
        AND COALESCE(po.data->>'status','') NOT IN ('lapsed','chargeback')
    )                                            AS policy_count,
    (SELECT COALESCE(SUM((po.data->>'ap')::numeric), 0)
       FROM public.policies po
      WHERE po.agent_id = ai.invitee_id
        AND COALESCE(po.data->>'status','') NOT IN ('lapsed','chargeback')
    )                                            AS total_ap,
    (SELECT COUNT(*) FROM public.calls c WHERE c.agent_id = ai.invitee_id) AS call_count,
    (SELECT COUNT(*) FROM public.leads l WHERE l.agent_id = ai.invitee_id) AS lead_count
  FROM public.agency_invites ai
  JOIN auth.users au   ON au.id = ai.invitee_id
  LEFT JOIN public.agents ag ON ag.id = ai.invitee_id
  LEFT JOIN public.plans  pl ON pl.id = ag.plan_id
  WHERE ai.leader_id = p_leader_id
    AND ai.status    = 'accepted'
    AND ai.leader_id = auth.uid()   -- caller must be the leader
  ORDER BY total_ap DESC;
$$;


-- ------------------------------------------------------------
-- 2. agents_protect_privileged_columns — add agency_code/agency_name.
--
-- 20260703b gated the RPC (set_my_agency_profile refuses unless
-- is_agency_leader) and gated the invite RLS. It did NOT protect the
-- column, and agents_update_own is row-ownership only — so from the
-- browser console, with nothing but a session and the publishable key:
--
--   sb.from('agents').update({ agency_code: 'SMITH2024' }).eq('id', myId)
--
-- ...makes any account an agency leader without a Team Leader plan.
-- agency_code is UNIQUE, so this also lets an attacker squat the code
-- a real leader is about to hand out and collect that leader's recruits.
-- Combined with (3) below, the downline's production aggregates were
-- then readable via get_team_summary / get_agency_stats.
--
-- Revenue was never exposed: the 30% downline discount independently
-- re-checks is_agency_leader(leader_id) on every checkout
-- (stripe-create-checkout -> agent_has_active_leader_link).
--
-- GATE, not freeze. A blanket freeze would also revert the UPDATE that
-- set_my_agency_profile itself performs: auth.role() reads the JWT
-- claim, so it is still 'authenticated' inside a SECURITY DEFINER RPC
-- invoked from the browser. Gating on is_agency_leader(NEW.id) instead
-- lets the legitimate RPC through and blocks everyone else, with no
-- dependence on how the write arrived. The format checks mirror the
-- RPC's so a direct write cannot store a code the join path could
-- never match (process_agency_code_join upper()s its input).
--
-- Body is otherwise byte-identical to 20260703c (verified against the
-- live definition before replacing).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agents_protect_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only lock things down for real end-user requests coming through
  -- PostgREST as 'authenticated' or 'anon'. Everything else (service_role
  -- edge functions, direct SQL Editor / migration sessions) is trusted.
  IF auth.role() IS DISTINCT FROM 'authenticated' AND auth.role() IS DISTINCT FROM 'anon' THEN
    RETURN NEW;
  END IF;

  -- An existing admin may still adjust these (e.g. the Settings -> Calling
  -- "Agent Assignments" editor updating another agent's row), but nobody
  -- can grant themselves privileges they don't already have.
  IF public.is_admin_agent() THEN
    RETURN NEW;
  END IF;

  NEW.is_admin              := OLD.is_admin;
  NEW.plan_id                := OLD.plan_id;
  NEW.monthly_minute_limit   := OLD.monthly_minute_limit;
  NEW.monthly_quote_limit    := OLD.monthly_quote_limit;
  NEW.stripe_customer_id     := OLD.stripe_customer_id;
  NEW.stripe_subscription_id := OLD.stripe_subscription_id;
  NEW.stripe_numbers_item_id := OLD.stripe_numbers_item_id;

  -- Agency identity: only a real Team Leader may hold one, and only in
  -- the format set_my_agency_profile validates. Silent revert matches
  -- the columns above; the RPC raises a readable error before ever
  -- reaching here, so the silent path only affects direct writes.
  IF NEW.agency_code IS DISTINCT FROM OLD.agency_code
     OR NEW.agency_name IS DISTINCT FROM OLD.agency_name THEN
    IF NOT public.is_agency_leader(NEW.id) THEN
      NEW.agency_code := OLD.agency_code;
      NEW.agency_name := OLD.agency_name;
    ELSE
      IF NEW.agency_code IS NOT NULL AND NEW.agency_code !~ '^[A-Z0-9]{4,20}$' THEN
        NEW.agency_code := OLD.agency_code;
      END IF;
      IF NEW.agency_name IS NOT NULL AND length(NEW.agency_name) > 60 THEN
        NEW.agency_name := OLD.agency_name;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ------------------------------------------------------------
-- 3. process_agency_code_join — verify the LEADER, not just the code.
--
-- This function is SECURITY DEFINER, so it runs as the table owner and
-- row-level security on agency_invites does not apply to it. That means
-- the `is_agency_leader(auth.uid())` WITH CHECK that 20260703b added to
-- the "leaders manage their invites" policy was never enforced on this
-- path — the code-join route wrote accepted downline rows regardless of
-- whether the leader qualified. (2) closes the way an unqualified
-- account acquires a code in the first place; this closes the way any
-- code already in circulation keeps accumulating a downline, including
-- when a legitimate leader later downgrades or cancels.
--
-- Matches the discount rule exactly: stripe-create-checkout already
-- evaporates the downline discount the moment is_agency_leader(leader)
-- goes false. Now the link itself stops forming at the same moment.
--
-- Body is otherwise unchanged from 20260617_agency_code.sql.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_agency_code_join(p_code text)
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
BEGIN
  -- Look up the leader
  SELECT ag.id, au.email, COALESCE(ag.display_name, au.email)
  INTO   v_leader_id, v_leader_email, v_leader_name
  FROM   public.agents ag
  JOIN   auth.users   au ON au.id = ag.id
  WHERE  ag.agency_code = upper(trim(p_code))
  LIMIT  1;

  IF v_leader_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Agency code not found');
  END IF;

  IF v_leader_id = auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cannot join your own agency');
  END IF;

  -- The account behind the code must CURRENTLY hold a Team Leader plan.
  IF NOT public.is_agency_leader(v_leader_id) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'That agency code is not active right now — ask your team leader to check their plan');
  END IF;

  SELECT email INTO v_me_email FROM auth.users WHERE id = auth.uid();

  -- Upsert: if invite already exists (any status) set it accepted
  INSERT INTO public.agency_invites
    (leader_id, leader_email, leader_name, invitee_email, invitee_id, status)
  VALUES
    (v_leader_id, v_leader_email, v_leader_name, v_me_email, auth.uid(), 'accepted')
  ON CONFLICT (leader_id, invitee_email)
  DO UPDATE SET status = 'accepted', invitee_id = auth.uid();

  RETURN jsonb_build_object(
    'ok',           true,
    'leader_name',  v_leader_name,
    'leader_email', v_leader_email
  );
END;
$$;


-- Grants unchanged from the originals (Supabase default-privileges
-- already grant EXECUTE to anon/authenticated/service_role on public
-- functions; CREATE OR REPLACE preserves the existing ACL).
