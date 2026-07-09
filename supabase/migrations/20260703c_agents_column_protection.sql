-- ============================================================
-- CRITICAL fix: agents.agents_update_own (from 001_agents_profile.sql)
-- only checks row ownership (auth.uid() = id), never which columns
-- change. Since is_admin, plan_id, monthly_minute_limit,
-- monthly_quote_limit, stripe_customer_id, stripe_subscription_id,
-- and stripe_numbers_item_id all live on the SAME row a user already
-- owns, any authenticated account can currently do, straight from
-- the browser console with only the publishable key + their own
-- session:
--
--   sb.from('agents').update({ is_admin: true }).eq('id', myId)
--
-- ...which immediately unlocks agents_select_admin / agents_update_admin
-- / calls_select_admin (full read of every agent's PII and call log,
-- plus write access to any agent row). The same gap also lets a user
-- overwrite their own stripe_subscription_id/stripe_customer_id to a
-- victim's real Stripe IDs and then hit stripe-cancel-subscription to
-- cancel a stranger's paid subscription.
--
-- The app itself never updates these columns from the client (verified:
-- only monthly_goal, contract_level, agent_phone, signalwire_caller_id
-- are ever client-written), so locking them down here breaks nothing
-- legitimate. service_role (edge functions) and existing admins still
-- bypass this guard; direct SQL Editor / migration sessions (no
-- PostgREST JWT context at all) are also left untouched so the existing
-- "manually toggle is_admin per-row" workflow keeps working.
-- ============================================================

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

  -- An existing admin may still adjust these (e.g. the Settings → Calling
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agents_protect_privileged_columns ON public.agents;
CREATE TRIGGER agents_protect_privileged_columns
  BEFORE UPDATE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.agents_protect_privileged_columns();
