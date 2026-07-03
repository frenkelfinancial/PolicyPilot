-- ============================================================
-- Custom agency code + agency name
-- Run this in your Supabase SQL editor after 20260617_agency_code.sql
-- ============================================================

-- 1. Add agency_name column
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS agency_name TEXT;

-- 2. Replace the random-code-only RPC with one that lets a leader set both
--    a custom code and a display name in a single call.
DROP FUNCTION IF EXISTS public.set_my_agency_code(text);

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
