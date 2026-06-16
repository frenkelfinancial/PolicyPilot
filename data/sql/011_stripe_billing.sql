-- ============================================================
-- 011_stripe_billing.sql
-- Wires Stripe subscription billing into the plans + agents tables.
--
-- Run once in the Supabase SQL Editor.
-- ============================================================

-- 1. Add stripe_price_id to plans so the edge function can look
--    up the Stripe Price to charge when a user subscribes.
--    After running this SQL, fill in the IDs from Stripe Dashboard:
--      UPDATE public.plans SET stripe_price_id = 'price_XXXX' WHERE slug = 'basic';
--      UPDATE public.plans SET stripe_price_id = 'price_XXXX' WHERE slug = 'pro';
--      UPDATE public.plans SET stripe_price_id = 'price_XXXX' WHERE slug = 'max';
alter table public.plans
  add column if not exists stripe_price_id text;

-- 2. Track the Stripe customer + subscription on agents so we can
--    reuse customers and update subscriptions without going through checkout.
alter table public.agents
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text;
