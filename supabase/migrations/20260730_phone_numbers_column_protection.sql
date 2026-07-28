-- ============================================================
-- CRITICAL fix, same class as 20260703c_agents_column_protection.sql, for a
-- DIFFERENT table found during the 2026-07-28 audit.
--
-- phone_numbers.phone_numbers_update_own (from 009_phone_book.sql) checks only
-- row ownership (auth.uid() = agent_id), never which columns change. `anon`
-- and `authenticated` hold column-level UPDATE on every column of the table
-- (default PostgREST grant), and there was NO protective trigger. So any
-- authenticated agent could, from the browser console with only the
-- publishable key + their own session, edit BILLING columns on a number they
-- own:
--
--   sb.from('phone_numbers').update({ renew_from_wallet: false }).eq('id', myNumberId)
--
-- wallet-renew-numbers selects `.eq('renew_from_wallet', true)
-- .lte('next_renewal_at', now())`, so setting renew_from_wallet=false — or
-- pushing next_renewal_at far into the future — makes the number never renew,
-- i.e. a permanently free DID. status/past_due_since could likewise be flipped
-- to clear a past_due state the cron set after a failed charge.
--
-- Lower severity than the agents hole (self-scoped, money-bounded, no PII or
-- cross-tenant access), but the same root cause and the same fix.
--
-- The ONLY column the client legitimately writes on this table is `is_primary`
-- (the "Set as primary" control in the Phone Book, verified in app.html
-- pbSetNumberAsPrimary), plus the harmless display labels friendly_name /
-- locality / region. Those stay writable; every system/billing/compliance
-- column is reverted for non-service, non-admin callers. service_role (edge
-- functions) and existing admins bypass, exactly like 20260703c.
-- ============================================================

CREATE OR REPLACE FUNCTION public.phone_numbers_protect_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only end-user requests through PostgREST as 'authenticated'/'anon'.
  -- service_role edge functions and direct SQL sessions are trusted.
  IF auth.role() IS DISTINCT FROM 'authenticated' AND auth.role() IS DISTINCT FROM 'anon' THEN
    RETURN NEW;
  END IF;

  -- Admins may still adjust another agent's number (Settings -> Calling).
  IF public.is_admin_agent() THEN
    RETURN NEW;
  END IF;

  -- Identity / ownership — never client-mutable.
  NEW.agent_id                 := OLD.agent_id;
  NEW.e164                     := OLD.e164;
  NEW.sw_phone_sid             := OLD.sw_phone_sid;
  NEW.number_type              := OLD.number_type;
  NEW.purchased_at             := OLD.purchased_at;

  -- Billing / lifecycle — set only by purchase + wallet-renew-numbers.
  NEW.monthly_cost             := OLD.monthly_cost;
  NEW.status                   := OLD.status;
  NEW.stripe_sub_id            := OLD.stripe_sub_id;
  NEW.next_renewal_at          := OLD.next_renewal_at;
  NEW.renew_from_wallet        := OLD.renew_from_wallet;
  NEW.past_due_since           := OLD.past_due_since;

  -- A2P / compliance assignment — set by the a2p functions only.
  NEW.a2p_campaign_id          := OLD.a2p_campaign_id;
  NEW.a2p_assignment_status    := OLD.a2p_assignment_status;
  NEW.a2p_assigned_at          := OLD.a2p_assigned_at;
  NEW.sms_capable              := OLD.sms_capable;
  NEW.sms_setup_error          := OLD.sms_setup_error;

  -- Reputation — set by the reputation monitor only.
  NEW.reputation_registered_at := OLD.reputation_registered_at;
  NEW.spam_risk                := OLD.spam_risk;
  NEW.spam_category            := OLD.spam_category;
  NEW.reputation_scores        := OLD.reputation_scores;
  NEW.reputation_checked_at    := OLD.reputation_checked_at;

  -- Left client-writable on purpose: is_primary (Set as primary),
  -- friendly_name / locality / region (display labels).
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS phone_numbers_protect_privileged_columns ON public.phone_numbers;
CREATE TRIGGER phone_numbers_protect_privileged_columns
  BEFORE UPDATE ON public.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION public.phone_numbers_protect_privileged_columns();
