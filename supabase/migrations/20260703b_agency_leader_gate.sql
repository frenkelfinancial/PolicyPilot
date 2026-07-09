-- ============================================================
-- Security fix: gate agency codes/invites and the 20% downline
-- discount to real Team Leader (or admin) accounts.
--
-- Without this, any authenticated account — including one that has
-- never paid for a plan — could call set_my_agency_profile to mint
-- its own "agency code", hand it out, and grant anyone who signs up
-- with it an ongoing 20% discount forever, with no relationship to
-- an actual paying team leader.
--
-- Run this after 20260703_agency_custom_profile.sql
-- ============================================================

-- 1. Single source of truth for "is this account a real team leader".
CREATE OR REPLACE FUNCTION public.is_agency_leader(p_uid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE((SELECT a.is_admin FROM public.agents a WHERE a.id = p_uid), false)
      OR EXISTS (
        SELECT 1 FROM public.agents a
        JOIN public.plans p ON p.id = a.plan_id
        WHERE a.id = p_uid AND p.name ILIKE '%leader%'
      );
$$;

-- Granted to `authenticated` too (not just service_role): this function is
-- referenced directly inside the agency_invites RLS policies below, which
-- are evaluated under the `authenticated` role itself — without this grant,
-- every real leader's invite/insert would fail with "permission denied for
-- function is_agency_leader".
REVOKE ALL ON FUNCTION public.is_agency_leader(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_agency_leader(uuid) TO authenticated, service_role;

-- 2. Only real leaders may set an agency code/name.
CREATE OR REPLACE FUNCTION public.set_my_agency_profile(p_code text, p_name text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text := upper(trim(p_code));
  v_name text := trim(coalesce(p_name, ''));
BEGIN
  IF NOT public.is_agency_leader(auth.uid()) THEN
    RAISE EXCEPTION 'Only Team Leader plan accounts can set an agency code';
  END IF;
  IF v_code !~ '^[A-Z0-9]{4,20}$' THEN
    RAISE EXCEPTION 'Agency code must be 4-20 letters/numbers, no spaces or symbols';
  END IF;
  IF length(v_name) > 60 THEN
    RAISE EXCEPTION 'Agency name must be 60 characters or fewer';
  END IF;

  BEGIN
    UPDATE public.agents
    SET agency_code = v_code,
        agency_name = NULLIF(v_name, '')
    WHERE id = auth.uid();
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That agency code is already taken — try another';
  END;

  RETURN jsonb_build_object('code', v_code, 'name', NULLIF(v_name, ''));
END;
$$;

-- 3. Close an invitee_id-hijack hole: today, a leader (via their own "FOR
--    ALL" policy) or an invitee (via "invitees respond to invites") can set
--    invitee_id on a row to ANY uuid, not just the account that actually
--    owns invitee_email. That lets someone attach a stranger's real uuid to
--    an accepted invite and read their business stats via get_agency_stats
--    — a data leak unrelated to who actually got invited. Fix: invitee_id
--    may only ever be set to the uuid that truly owns invitee_email.
CREATE OR REPLACE FUNCTION public.email_matches_user(p_user_id uuid, p_email text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT p_user_id IS NULL OR EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = p_user_id AND lower(u.email) = lower(p_email)
  );
$$;

REVOKE ALL ON FUNCTION public.email_matches_user(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.email_matches_user(uuid, text) TO authenticated, service_role;

-- 4. Only real leaders may create NEW agency_invites rows (existing rows
--    remain visible/removable via USING even if a leader later downgrades,
--    since WITH CHECK — not USING — is what gates INSERT/UPDATE writes).
DROP POLICY IF EXISTS "leaders manage their invites" ON public.agency_invites;
CREATE POLICY "leaders manage their invites"
  ON public.agency_invites FOR ALL TO authenticated
  USING (leader_id = auth.uid())
  WITH CHECK (
    leader_id = auth.uid()
    AND public.is_agency_leader(auth.uid())
    AND public.email_matches_user(invitee_id, invitee_email)
  );

DROP POLICY IF EXISTS "invitees respond to invites" ON public.agency_invites;
CREATE POLICY "invitees respond to invites"
  ON public.agency_invites FOR UPDATE TO authenticated
  USING (invitee_email = auth.email())
  WITH CHECK (
    invitee_email = auth.email()
    AND public.email_matches_user(invitee_id, invitee_email)
  );

-- 5. Server-side source of truth for discount eligibility: an accepted
--    invite only counts if the linked leader currently qualifies. This
--    is the load-bearing check — it protects revenue even if a code
--    or invite was created before this fix, or a leader later downgrades.
CREATE OR REPLACE FUNCTION public.agent_has_active_leader_link(p_invitee uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agency_invites ai
    WHERE ai.invitee_id = p_invitee
      AND ai.status = 'accepted'
      AND public.is_agency_leader(ai.leader_id)
  );
$$;

REVOKE ALL ON FUNCTION public.agent_has_active_leader_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_has_active_leader_link(uuid) TO service_role;
