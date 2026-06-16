-- ============================================================
-- Agency code column + RPCs
-- Run this in your Supabase SQL editor after 20260616_agency.sql
-- ============================================================

-- 1. Add agency_code column to agents
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS agency_code TEXT UNIQUE;

-- 2. SECURITY DEFINER: let the calling agent save their own agency code
CREATE OR REPLACE FUNCTION public.set_my_agency_code(p_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF length(trim(p_code)) < 4 THEN
    RAISE EXCEPTION 'Agency code must be at least 4 characters';
  END IF;
  UPDATE public.agents SET agency_code = upper(trim(p_code)) WHERE id = auth.uid();
  RETURN upper(trim(p_code));
END;
$$;

-- 3. Public lookup: get leader info by agency code (read-only, no sensitive data)
CREATE OR REPLACE FUNCTION public.get_leader_by_agency_code(p_code text)
RETURNS TABLE(leader_id uuid, leader_email text, leader_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ag.id,
         au.email,
         COALESCE(ag.display_name, au.email) AS leader_name
  FROM   public.agents ag
  JOIN   auth.users   au ON au.id = ag.id
  WHERE  ag.agency_code = upper(trim(p_code))
  LIMIT  1;
$$;

-- 4. Process join: inserts (or re-activates) an accepted agency_invite
--    Called post-login by the new agent when pending_agency_code is in their metadata.
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
