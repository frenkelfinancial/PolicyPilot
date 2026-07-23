-- ============================================================
-- 20260723_wallet_ai_minutes.sql
-- ProducerStack wallet repricing — July 2026 (see scripts/wallet-rates-2026-07.sql).
--
-- Two things:
--   1. Reprice the existing usage rates already wired into wallet_debit:
--        dialer minutes  $0.01/min -> $0.012/min  (10 -> 12 mills)
--        local numbers   $3.00/mo  -> $2.00/mo     (3000 -> 2000 mills)
--   2. Add a NEW usage type — AI Sales Agent voice minutes — with a volume
--      tier, and the debit RPC that charges it:
--        base   $0.075/min (75 mills)
--        volume $0.065/min (65 mills) for minutes beyond 2,000 in a
--               calendar month (the 2,000th minute is still base rate).
--
-- All money is in mills (1000 mills = $1.00), matching 20260709b_wallet_foundation.
-- Idempotent: safe to run more than once (add-if-not-exists / create-or-replace /
-- drop-constraint-if-exists).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Reprice dialer minutes and local numbers.
--    (billing_config is a singleton, id = 1 — every reader uses .eq("id", 1).)
-- ------------------------------------------------------------
update public.billing_config
   set call_minute_mills  = 12,
       number_local_mills = 2000
 where id = 1;

-- Phone numbers are now unlimited quantity at $2/mo — there is no per-user
-- number cap anywhere in the wallet/checkout path to remove (verified 07/2026).

-- ------------------------------------------------------------
-- 2. AI Sales Agent voice-minute rates.
-- ------------------------------------------------------------
alter table public.billing_config
  add column if not exists ai_minute_mills            bigint not null default 75,
  add column if not exists ai_minute_volume_mills     bigint not null default 65,
  add column if not exists ai_minute_volume_threshold bigint not null default 2000;

comment on column public.billing_config.ai_minute_mills is
  'AI Sales Agent voice minutes — base rate: $0.075/min = 75 mills. Charged via wallet_debit_ai_minutes.';
comment on column public.billing_config.ai_minute_volume_mills is
  'AI Sales Agent voice minutes — volume rate: $0.065/min = 65 mills, applied to minutes beyond ai_minute_volume_threshold in a calendar month.';
comment on column public.billing_config.ai_minute_volume_threshold is
  'AI minutes per calendar month billed at ai_minute_mills before ai_minute_volume_mills applies. Default 2000: the 2,000th minute is base rate, the 2,001st is the first volume-rate minute.';

update public.billing_config
   set ai_minute_mills            = coalesce(ai_minute_mills, 75),
       ai_minute_volume_mills     = coalesce(ai_minute_volume_mills, 65),
       ai_minute_volume_threshold = coalesce(ai_minute_volume_threshold, 2000)
 where id = 1;

-- ------------------------------------------------------------
-- 3. Allow the new 'ai_call' ledger category.
--    (Inline column CHECK from 20260709b is named wallet_ledger_category_check.)
-- ------------------------------------------------------------
alter table public.wallet_ledger drop constraint if exists wallet_ledger_category_check;
alter table public.wallet_ledger
  add constraint wallet_ledger_category_check
  check (category in ('call','sms','mms','email','number_local','number_tollfree',
                      'a2p_registration','topup','refund','adjustment','ai_call'));

-- ------------------------------------------------------------
-- 4. wallet_debit_ai_minutes — atomic tiered debit for AI voice minutes.
--
-- Same locking discipline as wallet_debit (SELECT ... FOR UPDATE before
-- touching balance), but the amount is computed HERE from the wallet's
-- month-to-date AI usage instead of being passed in, so the volume tier is
-- authoritative and can't be gamed by a caller. Reads the wallet lock BEFORE
-- summing month-to-date minutes so two concurrent AI debits for the same
-- agent can't both see the same mtd and both bill at the base rate.
--
-- Tier split MIRRORS supabase/functions/_shared/ai-minute-billing.ts
-- splitAiMinutes() — keep both in sync.
--
-- Integration point (not wired yet): the AI Sales Agent call-end handler
-- should call this with the elapsed whole minutes, exactly as
-- reportMinutesToWallet calls wallet_debit for human dialer calls.
-- ------------------------------------------------------------
create or replace function public.wallet_debit_ai_minutes(
  p_agent    uuid,
  p_minutes  integer,
  p_ref_type text,
  p_ref_id   text,
  p_desc     text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_rate   bigint;
  v_vol_rate    bigint;
  v_threshold   bigint;
  v_mtd_minutes bigint;
  v_base_min    bigint;
  v_vol_min     bigint;
  v_amount      bigint;
  v_balance     bigint;
  v_rate        bigint;
begin
  if p_minutes is null or p_minutes <= 0 then
    raise exception 'invalid_amount';
  end if;

  select ai_minute_mills, ai_minute_volume_mills, ai_minute_volume_threshold
    into v_base_rate, v_vol_rate, v_threshold
    from public.billing_config
   where id = 1;

  v_base_rate := coalesce(v_base_rate, 75);
  v_vol_rate  := coalesce(v_vol_rate, 65);
  v_threshold := coalesce(v_threshold, 2000);

  insert into public.wallet_accounts (agent_id) values (p_agent)
  on conflict (agent_id) do nothing;

  -- Lock the wallet row first (atomic read-of-mtd + debit).
  select balance_mills into v_balance
    from public.wallet_accounts
   where agent_id = p_agent
     for update;

  -- Whole AI minutes already billed to this wallet this calendar month.
  -- Only settled AI debits count (holds/voids/refunds excluded).
  select coalesce(sum(units), 0) into v_mtd_minutes
    from public.wallet_ledger
   where agent_id = p_agent
     and category = 'ai_call'
     and entry_type = 'debit'
     and created_at >= date_trunc('month', now());

  -- base minutes = those still under the monthly threshold; rest are volume.
  v_base_min := greatest(0, least(p_minutes::bigint, v_threshold - v_mtd_minutes));
  v_vol_min  := p_minutes::bigint - v_base_min;
  v_amount   := v_base_min * v_base_rate + v_vol_min * v_vol_rate;

  if v_amount <= 0 then
    raise exception 'invalid_amount';
  end if;

  if v_balance < v_amount then
    raise exception 'insufficient_balance'
      using detail = jsonb_build_object('shortfall_mills', v_amount - v_balance)::text;
  end if;

  -- Blended per-minute rate, for the itemized ledger UI ("N min @ $x/min").
  v_rate := round(v_amount / p_minutes);

  update public.wallet_accounts
     set balance_mills = balance_mills - v_amount
   where agent_id = p_agent
  returning balance_mills into v_balance;

  insert into public.wallet_ledger
    (agent_id, entry_type, category, amount_mills, balance_after_mills,
     units, unit_rate_mills, status, ref_type, ref_id, description, settled_at)
  values
    (p_agent, 'debit', 'ai_call', -v_amount, v_balance,
     p_minutes, v_rate, 'settled', p_ref_type, p_ref_id, p_desc, now());

  return v_balance;
end;
$$;

-- Only service_role may execute it — same lockdown as every other wallet_* RPC
-- (see 20260709d_wallet_rpc_lockdown.sql). End users never call it directly.
revoke all on function public.wallet_debit_ai_minutes(uuid, integer, text, text, text) from public;
revoke execute on function public.wallet_debit_ai_minutes(uuid, integer, text, text, text) from anon, authenticated;
grant execute on function public.wallet_debit_ai_minutes(uuid, integer, text, text, text) to service_role;
