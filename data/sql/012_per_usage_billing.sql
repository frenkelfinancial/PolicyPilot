-- ============================================================
-- 012_per_usage_billing.sql
-- Per-number ($3/mo) and per-minute ($0.02/min) Stripe billing.
--
-- Adds:
--   • agents.stripe_numbers_item_id  — Stripe subscription item for phone numbers
--   • agents.stripe_minutes_item_id  — Stripe subscription item for metered minutes
--   • public.billing_config          — Singleton table: admin-configurable rates
--                                      + Stripe price IDs
--
-- After running, set up in Stripe Dashboard:
--   1. Create a "Phone Number" product → recurring price $3.00/month, per-unit
--      → paste that price ID: UPDATE billing_config SET stripe_numbers_price_id = 'price_XXXX' WHERE id = 1;
--   2. Create a "Call Minutes" product → recurring price $0.02/unit, metered (sum)
--      → paste that price ID: UPDATE billing_config SET stripe_minutes_price_id = 'price_XXXX' WHERE id = 1;
--
-- Run once in the Supabase SQL Editor.
-- ============================================================

-- 1. Add Stripe subscription item IDs to agents --------------------------
alter table public.agents
  add column if not exists stripe_numbers_item_id text,
  add column if not exists stripe_minutes_item_id text;

comment on column public.agents.stripe_numbers_item_id is
  'Stripe subscription item ID for the per-number line ($3/mo × qty). Set when the first number is purchased; quantity incremented/decremented on each buy/release.';
comment on column public.agents.stripe_minutes_item_id is
  'Stripe subscription item ID for the metered minutes line ($0.02/min). Set on first call completion; usage records reported after each call.';

-- 2. Billing config singleton -------------------------------------------
create table if not exists public.billing_config (
  id                      integer primary key default 1 check (id = 1),
  number_rate_cents       integer not null default 300,
  minute_rate_cents       integer not null default 2,
  stripe_numbers_price_id text,
  stripe_minutes_price_id text,
  updated_at              timestamptz not null default now()
);

comment on table public.billing_config is
  'Singleton (id=1) storing admin-configurable billing rates and the Stripe price IDs that back those rates. number_rate_cents=300 → $3.00/number/month; minute_rate_cents=2 → $0.02/min.';

insert into public.billing_config (id, number_rate_cents, minute_rate_cents)
values (1, 300, 2)
on conflict (id) do nothing;

-- 3. RLS: anyone authenticated can read; only service role writes --------
alter table public.billing_config enable row level security;

drop policy if exists "billing_config_select_all" on public.billing_config;
create policy "billing_config_select_all"
  on public.billing_config for select
  to authenticated
  using (true);
