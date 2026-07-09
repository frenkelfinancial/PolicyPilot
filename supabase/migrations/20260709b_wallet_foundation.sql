-- ============================================================
-- 016_wallet_foundation.sql
-- Prepaid wallet (account balance) billing foundation — replaces
-- per-number Stripe subscriptions and metered-minute usage records
-- with a single dollar balance, debited atomically per action.
--
-- NOTE ON NUMBERING: the build brief that generated this file assumed
-- 013 was the next free number in data/sql/. By the time this was written,
-- 013/014/015 were already taken (weekly digest, promo email cron,
-- summary emails) — so this is 016. No renumbering of those files.
--
-- All money is stored in MILLS (integer thousandths of a dollar).
-- $1.00 = 1000 mills. This is required because outbound email bills at
-- $0.001 (1 mill) — a whole-cent column cannot represent that.
--
-- Run once in the Supabase SQL Editor, in this order (paste this whole
-- file — it's already ordered correctly top to bottom):
--   1. wallet_accounts / wallet_ledger / wallet_topups tables
--   2. billing_config + phone_numbers column additions
--   3. wallet_accounts backfill (every existing agent starts at $0)
--   4. RPCs: wallet_topup / wallet_debit / wallet_hold / wallet_settle / wallet_void / wallet_credit_topup
--   5. RLS policies
--
-- After running, see the Cowork hand-off checklist (delivered separately)
-- for the Stripe product/price setup and secrets this needs to go live.
-- ============================================================

-- ------------------------------------------------------------
-- 1. wallet_accounts — one row per agent, the spendable balance.
-- ------------------------------------------------------------
create table if not exists public.wallet_accounts (
  agent_id                      uuid primary key references auth.users(id) on delete cascade,
  balance_mills                 bigint not null default 0 check (balance_mills >= 0),
  auto_recharge_enabled         boolean not null default false,
  auto_recharge_threshold_mills bigint,
  auto_recharge_amount_mills    bigint,
  low_balance_notified_at       timestamptz,
  updated_at                    timestamptz not null default now()
);

comment on table public.wallet_accounts is
  'One row per agent: the spendable prepaid balance in mills (1000 mills = $1.00). Every agent starts at 0 — no free balance. All mutations go through the wallet_* RPCs below so balance can never go negative and every change is mirrored into wallet_ledger in the same transaction.';
comment on column public.wallet_accounts.balance_mills is
  'Current spendable balance in mills. Never negative. This is the number shown to the user as their account balance (balance_mills / 1000 = dollars).';

drop trigger if exists wallet_accounts_touch_updated_at on public.wallet_accounts;
create trigger wallet_accounts_touch_updated_at
  before update on public.wallet_accounts
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 2. wallet_ledger — append-only audit trail. Powers billing
--    transparency (every debit is an itemized row) AND
--    never-charge-undelivered (pending/settled/voided holds).
-- ------------------------------------------------------------
create table if not exists public.wallet_ledger (
  id                  uuid primary key default gen_random_uuid(),
  agent_id            uuid not null references auth.users(id) on delete cascade,
  entry_type          text not null check (entry_type in ('topup','debit','hold','hold_settle','hold_void','refund','adjustment')),
  category            text not null check (category in ('call','sms','mms','email','number_local','number_tollfree','a2p_registration','topup','refund','adjustment')),
  amount_mills        bigint not null,          -- signed: credits +, debits/holds -
  balance_after_mills bigint not null,           -- wallet_accounts.balance_mills immediately after this row was written
  units               numeric,                   -- e.g. minutes, segments — null for topup/refund/adjustment
  unit_rate_mills     bigint,                    -- rate applied, for display ("3 min @ $0.01/min")
  status              text not null default 'settled' check (status in ('pending','settled','voided')),
  ref_type            text,                      -- e.g. 'call', 'phone_number', 'stripe_payment_intent'
  ref_id              text,                      -- id of the row/object that caused this entry
  description         text not null,              -- human-readable line for the itemized ledger UI (Phase 3)
  created_at          timestamptz not null default now(),
  settled_at          timestamptz
);

comment on table public.wallet_ledger is
  'Append-only itemized audit trail of every wallet balance change. Rows are never deleted or have their amount rewritten; a hold row''s status/entry_type/settled_at transition once (pending hold -> settled or voided) as it resolves. This is the single source of truth for "what was I charged and why" (billing transparency) and for never charging for undelivered sends (Phase 2 holds).';

create index if not exists wallet_ledger_agent_created_idx
  on public.wallet_ledger (agent_id, created_at desc);
create index if not exists wallet_ledger_ref_idx
  on public.wallet_ledger (ref_type, ref_id);

-- ------------------------------------------------------------
-- 3. wallet_topups — one row per successful Stripe top-up.
--    Unique on the PaymentIntent id so the webhook can never
--    double-credit a retry/duplicate delivery.
-- ------------------------------------------------------------
create table if not exists public.wallet_topups (
  id                        uuid primary key default gen_random_uuid(),
  agent_id                  uuid not null references auth.users(id) on delete cascade,
  amount_mills              bigint not null,
  stripe_payment_intent_id  text unique,
  status                    text not null default 'pending' check (status in ('pending','succeeded','failed')),
  created_at                timestamptz not null default now()
);

comment on table public.wallet_topups is
  'One row per Stripe top-up attempt. stripe_payment_intent_id is unique so stripe-webhook can upsert on it and never double-credit a wallet on a retried webhook delivery.';

create index if not exists wallet_topups_agent_idx
  on public.wallet_topups (agent_id, created_at desc);

-- ------------------------------------------------------------
-- 4. billing_config — add mills-denominated rates alongside the
--    existing (soon-to-be-unused) cents columns. Single source of
--    truth for every rate; only calls + number renewals actually
--    debit in Phase 1, the rest are wired for Phase 2.
-- ------------------------------------------------------------
alter table public.billing_config
  add column if not exists call_minute_mills     bigint not null default 10,
  add column if not exists sms_segment_mills     bigint not null default 10,
  add column if not exists mms_mills             bigint not null default 30,
  add column if not exists email_mills           bigint not null default 1,
  add column if not exists number_local_mills    bigint not null default 3000,
  add column if not exists number_tollfree_mills bigint not null default 10000,
  add column if not exists stripe_topup_product_id text;

comment on column public.billing_config.call_minute_mills is
  'Outbound call rate: $0.01/min = 10 mills. Charged via wallet_debit, minutes = Math.max(1, Math.ceil(durationSec/60)).';
comment on column public.billing_config.number_local_mills is
  'Local number rate: $3.00 / 30 days = 3000 mills. Charged on purchase and by wallet-renew-numbers every 30 days.';
comment on column public.billing_config.number_tollfree_mills is
  'Toll-free number rate: $10.00 / 30 days = 10000 mills.';
comment on column public.billing_config.stripe_topup_product_id is
  'Stripe Product id used for wallet top-up Checkout Sessions (price is set dynamically per top-up amount via price_data, so only one Product is needed here — see stripe-create-checkout mode="topup").';

-- Explicit seed for the id=1 row (defaults above already backfill this on
-- ALTER — this UPDATE is just belt-and-suspenders idempotent seeding).
update public.billing_config
   set call_minute_mills     = coalesce(call_minute_mills, 10),
       sms_segment_mills     = coalesce(sms_segment_mills, 10),
       mms_mills             = coalesce(mms_mills, 30),
       email_mills           = coalesce(email_mills, 1),
       number_local_mills    = coalesce(number_local_mills, 3000),
       number_tollfree_mills = coalesce(number_tollfree_mills, 10000)
 where id = 1;

-- ------------------------------------------------------------
-- 5. phone_numbers — number type + wallet renewal tracking.
-- ------------------------------------------------------------
alter table public.phone_numbers
  add column if not exists number_type      text not null default 'local' check (number_type in ('local','tollfree')),
  add column if not exists next_renewal_at  timestamptz,
  add column if not exists renew_from_wallet boolean not null default true,
  add column if not exists past_due_since   timestamptz;

comment on column public.phone_numbers.next_renewal_at is
  'Next time wallet-renew-numbers should debit this number''s 30-day fee. Set on purchase; advanced by wallet-renew-numbers on each successful renewal debit.';
comment on column public.phone_numbers.past_due_since is
  'Set the first time a renewal debit fails for insufficient balance; cleared on the next successful renewal. Grace flag for Phase 3 notifications — the number is NOT released while past_due.';

-- Allow the new 'past_due' status value (existing constraint only allowed
-- active/pending/released).
alter table public.phone_numbers drop constraint if exists phone_numbers_status_check;
alter table public.phone_numbers
  add constraint phone_numbers_status_check check (status in ('active','pending','released','past_due'));

-- Backfill next_renewal_at for existing active numbers bought under the
-- old per-number Stripe subscription model — give them a full 30-day
-- runway under the new model starting now, not retroactively from
-- purchased_at (avoids every existing number renewing on day one).
update public.phone_numbers
   set next_renewal_at = now() + interval '30 days'
 where status = 'active'
   and next_renewal_at is null;

-- ------------------------------------------------------------
-- 6. Backfill: every existing agent gets a $0 wallet row.
-- ------------------------------------------------------------
insert into public.wallet_accounts (agent_id, balance_mills)
select id, 0 from public.agents
on conflict (agent_id) do nothing;

-- Auto-create a $0 wallet row whenever a new agent row is created, so
-- every future signup has one without needing app-level bootstrapping.
create or replace function public.handle_new_agent_wallet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.wallet_accounts (agent_id) values (new.id)
  on conflict (agent_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_agent_created_wallet on public.agents;
create trigger on_agent_created_wallet
  after insert on public.agents
  for each row execute function public.handle_new_agent_wallet();

-- ------------------------------------------------------------
-- 7. Atomic, race-safe wallet RPCs. All are SECURITY DEFINER and
--    lock the wallet row with SELECT ... FOR UPDATE before touching
--    balance, so concurrent debits/holds on the same agent can never
--    race the balance below zero. Only service_role may execute
--    these — end users never call them directly.
-- ------------------------------------------------------------

-- Credit the wallet (e.g. a Stripe top-up). Writes a 'topup' ledger row.
create or replace function public.wallet_topup(
  p_agent  uuid,
  p_amount_mills bigint,
  p_ref    text,
  p_desc   text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
begin
  if p_amount_mills <= 0 then
    raise exception 'invalid_amount';
  end if;

  insert into public.wallet_accounts (agent_id) values (p_agent)
  on conflict (agent_id) do nothing;

  update public.wallet_accounts
     set balance_mills = balance_mills + p_amount_mills
   where agent_id = p_agent
  returning balance_mills into v_balance;

  insert into public.wallet_ledger
    (agent_id, entry_type, category, amount_mills, balance_after_mills,
     status, ref_type, ref_id, description, settled_at)
  values
    (p_agent, 'topup', 'topup', p_amount_mills, v_balance,
     'settled', 'stripe_payment_intent', p_ref, p_desc, now());

  return v_balance;
end;
$$;

-- Debit the wallet immediately for a completed, billable action (a
-- finished call, a renewed number). Raises 'insufficient_balance' (with
-- the shortfall in the DETAIL, as JSON) if the wallet can't cover it —
-- callers should pre-check balance where a clean 402 is needed, since
-- this raise is the last-resort safety net against a race, not the
-- primary UX path.
create or replace function public.wallet_debit(
  p_agent    uuid,
  p_category text,
  p_units    numeric,
  p_amount_mills bigint,
  p_ref_type text,
  p_ref_id   text,
  p_desc     text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
  v_rate    bigint;
begin
  if p_amount_mills <= 0 then
    raise exception 'invalid_amount';
  end if;

  insert into public.wallet_accounts (agent_id) values (p_agent)
  on conflict (agent_id) do nothing;

  select balance_mills into v_balance
    from public.wallet_accounts
   where agent_id = p_agent
     for update;

  if v_balance < p_amount_mills then
    raise exception 'insufficient_balance'
      using detail = jsonb_build_object('shortfall_mills', p_amount_mills - v_balance)::text;
  end if;

  v_rate := case when p_units is not null and p_units > 0
                 then round(p_amount_mills / p_units) else null end;

  update public.wallet_accounts
     set balance_mills = balance_mills - p_amount_mills
   where agent_id = p_agent
  returning balance_mills into v_balance;

  insert into public.wallet_ledger
    (agent_id, entry_type, category, amount_mills, balance_after_mills,
     units, unit_rate_mills, status, ref_type, ref_id, description, settled_at)
  values
    (p_agent, 'debit', p_category, -p_amount_mills, v_balance,
     p_units, v_rate, 'settled', p_ref_type, p_ref_id, p_desc, now());

  return v_balance;
end;
$$;

-- Reserve funds for an action whose outcome isn't known yet (Phase 2:
-- SMS/MMS/email send attempts). Deducts from the spendable balance right
-- away (so the same funds can't be double-spent by a second send) but
-- the ledger row stays 'pending' until wallet_settle or wallet_void
-- resolves it. Returns the new wallet_ledger row's id — the caller must
-- hold onto it to settle/void later.
create or replace function public.wallet_hold(
  p_agent    uuid,
  p_category text,
  p_units    numeric,
  p_amount_mills bigint,
  p_ref_type text,
  p_ref_id   text,
  p_desc     text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance   bigint;
  v_rate      bigint;
  v_ledger_id uuid;
begin
  if p_amount_mills <= 0 then
    raise exception 'invalid_amount';
  end if;

  insert into public.wallet_accounts (agent_id) values (p_agent)
  on conflict (agent_id) do nothing;

  select balance_mills into v_balance
    from public.wallet_accounts
   where agent_id = p_agent
     for update;

  if v_balance < p_amount_mills then
    raise exception 'insufficient_balance'
      using detail = jsonb_build_object('shortfall_mills', p_amount_mills - v_balance)::text;
  end if;

  v_rate := case when p_units is not null and p_units > 0
                 then round(p_amount_mills / p_units) else null end;

  update public.wallet_accounts
     set balance_mills = balance_mills - p_amount_mills
   where agent_id = p_agent
  returning balance_mills into v_balance;

  insert into public.wallet_ledger
    (agent_id, entry_type, category, amount_mills, balance_after_mills,
     units, unit_rate_mills, status, ref_type, ref_id, description)
  values
    (p_agent, 'hold', p_category, -p_amount_mills, v_balance,
     p_units, v_rate, 'pending', p_ref_type, p_ref_id, p_desc)
  returning id into v_ledger_id;

  return v_ledger_id;
end;
$$;

-- Finalize a hold whose action succeeded (e.g. carrier confirmed
-- delivery). The funds were already deducted at hold time — this just
-- marks the ledger row settled. Balance does not change.
create or replace function public.wallet_settle(
  p_ledger_id uuid
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent  uuid;
  v_status text;
  v_type   text;
  v_balance bigint;
begin
  select agent_id, status, entry_type into v_agent, v_status, v_type
    from public.wallet_ledger
   where id = p_ledger_id
     for update;

  if v_agent is null then
    raise exception 'ledger_row_not_found';
  end if;
  if v_type <> 'hold' or v_status <> 'pending' then
    raise exception 'not_a_pending_hold';
  end if;

  update public.wallet_ledger
     set entry_type = 'hold_settle', status = 'settled', settled_at = now()
   where id = p_ledger_id;

  select balance_mills into v_balance from public.wallet_accounts where agent_id = v_agent;
  return v_balance;
end;
$$;

-- Release a hold whose action failed (never charge for undelivered).
-- Refunds the held amount back to the spendable balance and marks the
-- ledger row voided.
create or replace function public.wallet_void(
  p_ledger_id uuid
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent   uuid;
  v_status  text;
  v_type    text;
  v_amount  bigint;
  v_balance bigint;
begin
  select agent_id, status, entry_type, amount_mills
    into v_agent, v_status, v_type, v_amount
    from public.wallet_ledger
   where id = p_ledger_id
     for update;

  if v_agent is null then
    raise exception 'ledger_row_not_found';
  end if;
  if v_type <> 'hold' or v_status <> 'pending' then
    raise exception 'not_a_pending_hold';
  end if;

  update public.wallet_ledger
     set entry_type = 'hold_void', status = 'voided', settled_at = now()
   where id = p_ledger_id;

  update public.wallet_accounts
     set balance_mills = balance_mills + abs(v_amount)
   where agent_id = v_agent
  returning balance_mills into v_balance;

  return v_balance;
end;
$$;

-- Atomically credit a Stripe top-up AND record it in wallet_topups keyed
-- by PaymentIntent id, so a retried webhook delivery for the same
-- PaymentIntent can never double-credit. Used by stripe-webhook.
create or replace function public.wallet_credit_topup(
  p_agent          uuid,
  p_amount_mills   bigint,
  p_payment_intent text,
  p_desc           text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_status  text;
  v_balance bigint;
begin
  insert into public.wallet_topups (agent_id, amount_mills, stripe_payment_intent_id, status)
  values (p_agent, p_amount_mills, p_payment_intent, 'succeeded')
  on conflict (stripe_payment_intent_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- Already have a row for this PaymentIntent — only credit if we
    -- haven't already (guards a retried webhook delivery).
    select status into v_status from public.wallet_topups
     where stripe_payment_intent_id = p_payment_intent;

    if v_status = 'succeeded' then
      select balance_mills into v_balance from public.wallet_accounts where agent_id = p_agent;
      return v_balance;
    end if;

    update public.wallet_topups set status = 'succeeded'
     where stripe_payment_intent_id = p_payment_intent;
  end if;

  return public.wallet_topup(p_agent, p_amount_mills, p_payment_intent, p_desc);
end;
$$;

revoke all on function public.wallet_topup(uuid, bigint, text, text) from public;
revoke all on function public.wallet_debit(uuid, text, numeric, bigint, text, text, text) from public;
revoke all on function public.wallet_hold(uuid, text, numeric, bigint, text, text, text) from public;
revoke all on function public.wallet_settle(uuid) from public;
revoke all on function public.wallet_void(uuid) from public;
revoke all on function public.wallet_credit_topup(uuid, bigint, text, text) from public;

grant execute on function public.wallet_topup(uuid, bigint, text, text) to service_role;
grant execute on function public.wallet_debit(uuid, text, numeric, bigint, text, text, text) to service_role;
grant execute on function public.wallet_hold(uuid, text, numeric, bigint, text, text, text) to service_role;
grant execute on function public.wallet_settle(uuid) to service_role;
grant execute on function public.wallet_void(uuid) to service_role;
grant execute on function public.wallet_credit_topup(uuid, bigint, text, text) to service_role;

-- ------------------------------------------------------------
-- 8. RLS — agents read only their own rows; admins read all;
--    nobody (not even the row owner) writes directly — every write
--    goes through the SECURITY DEFINER RPCs above or service_role
--    edge functions.
-- ------------------------------------------------------------
alter table public.wallet_accounts enable row level security;
alter table public.wallet_ledger   enable row level security;
alter table public.wallet_topups   enable row level security;

drop policy if exists "wallet_accounts_select_own" on public.wallet_accounts;
create policy "wallet_accounts_select_own"
  on public.wallet_accounts for select
  using (auth.uid() = agent_id);

drop policy if exists "wallet_accounts_select_admin" on public.wallet_accounts;
create policy "wallet_accounts_select_admin"
  on public.wallet_accounts for select
  using (public.is_admin_agent());

drop policy if exists "wallet_ledger_select_own" on public.wallet_ledger;
create policy "wallet_ledger_select_own"
  on public.wallet_ledger for select
  using (auth.uid() = agent_id);

drop policy if exists "wallet_ledger_select_admin" on public.wallet_ledger;
create policy "wallet_ledger_select_admin"
  on public.wallet_ledger for select
  using (public.is_admin_agent());

drop policy if exists "wallet_topups_select_own" on public.wallet_topups;
create policy "wallet_topups_select_own"
  on public.wallet_topups for select
  using (auth.uid() = agent_id);

drop policy if exists "wallet_topups_select_admin" on public.wallet_topups;
create policy "wallet_topups_select_admin"
  on public.wallet_topups for select
  using (public.is_admin_agent());

-- No insert/update/delete policies for authenticated/anon on any of the
-- three tables — RLS defaults to deny, and all real writes happen via
-- the SECURITY DEFINER RPCs (service_role only) or service_role edge
-- functions, which bypass RLS entirely.

-- ------------------------------------------------------------
-- Deliverable for Cowork: schedule the renewal cron once
-- wallet-renew-numbers is deployed (needs pg_cron + pg_net extensions,
-- which Supabase enables by default on most projects). Run in SQL
-- Editor AFTER the function is deployed and SUPABASE_SERVICE_ROLE_KEY
-- is available to embed below:
--
--   select cron.schedule(
--     'wallet-renew-numbers',
--     '0 * * * *',  -- hourly; renewals are idempotent so any cadence is safe
--     $$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/wallet-renew-numbers',
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
--         'Content-Type',  'application/json'
--       )
--     );
--     $$
--   );
-- ------------------------------------------------------------
