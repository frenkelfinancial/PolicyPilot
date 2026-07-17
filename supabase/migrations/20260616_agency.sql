-- ============================================================
-- Agency invites table + RLS + stats RPC
-- Run this once in your Supabase SQL editor.
-- ============================================================

-- 1. Create the table
CREATE TABLE IF NOT EXISTS public.agency_invites (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  leader_email   text        NOT NULL,
  leader_name    text,
  invitee_email  text        NOT NULL,
  invitee_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','accepted','declined')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leader_id, invitee_email)
);

ALTER TABLE public.agency_invites ENABLE ROW LEVEL SECURITY;

-- 2. RLS: leaders manage their own invites
DROP POLICY IF EXISTS "leaders manage their invites" ON public.agency_invites;
CREATE POLICY "leaders manage their invites"
  ON public.agency_invites FOR ALL TO authenticated
  USING  (leader_id = auth.uid())
  WITH CHECK (leader_id = auth.uid());

-- 3. RLS: invitees can see invites sent to their email
DROP POLICY IF EXISTS "invitees see their invites" ON public.agency_invites;
CREATE POLICY "invitees see their invites"
  ON public.agency_invites FOR SELECT TO authenticated
  USING (invitee_email = auth.email());

-- 4. RLS: invitees can update status of their invites (accept / decline)
DROP POLICY IF EXISTS "invitees respond to invites" ON public.agency_invites;
CREATE POLICY "invitees respond to invites"
  ON public.agency_invites FOR UPDATE TO authenticated
  USING  (invitee_email = auth.email())
  WITH CHECK (invitee_email = auth.email());

-- 5. Aggregate stats function (SECURITY DEFINER so it can bypass
--    per-row RLS on policies / calls / leads).
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
AS $$
  SELECT
    ai.invitee_id                                                AS agent_id,
    au.email                                                     AS agent_email,
    COALESCE(ag.display_name, au.email)                          AS agent_name,
    pl.name                                                      AS agent_plan,
    COUNT(DISTINCT po.id)                                        AS policy_count,
    COALESCE(SUM((po.data->>'ap')::numeric), 0)                  AS total_ap,
    COUNT(DISTINCT c.id)                                         AS call_count,
    COUNT(DISTINCT l.id)                                         AS lead_count
  FROM public.agency_invites ai
  JOIN auth.users au   ON au.id  = ai.invitee_id
  LEFT JOIN public.agents  ag ON ag.id  = ai.invitee_id
  LEFT JOIN public.plans   pl ON pl.id  = ag.plan_id
  LEFT JOIN public.policies po ON po.agent_id = ai.invitee_id
  LEFT JOIN public.calls    c  ON c.agent_id  = ai.invitee_id
  LEFT JOIN public.leads    l  ON l.agent_id  = ai.invitee_id
  WHERE ai.leader_id = p_leader_id
    AND ai.status    = 'accepted'
    AND ai.leader_id = auth.uid()   -- caller must be the leader
  GROUP BY ai.invitee_id, au.email, ag.display_name, pl.name
$$;
