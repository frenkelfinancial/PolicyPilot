-- ============================================================
-- 017_wallet_spend_gate.sql
-- Universal spend gate: minimum call-start balance, call-start
-- hold/settle-at-hangup, and the low-balance nudge threshold used by
-- both the app.html pop-up and the low-balance email.
--
-- Depends on 016_wallet_foundation.sql (wallet_accounts, wallet_ledger,
-- wallet_hold/settle/void). Paste after 016.
-- ============================================================

alter table public.billing_config
  add column if not exists min_call_start_mills bigint not null default 30,
  add column if not exists low_balance_threshold_mills bigint not null default 5000;

comment on column public.billing_config.min_call_start_mills is
  'Minimum wallet balance required to START a call, in mills. Default 30 = 3 minutes @ call_minute_mills=10. Held via wallet_hold at call start (both softphone and power dialer); reconciled at hangup via wallet_settle_call.';
comment on column public.billing_config.low_balance_threshold_mills is
  'Wallet balance (mills) below which the app.html low-balance nudge pop-up and the low-balance email trigger. Default 5000 = $5.00.';

update public.billing_config
   set min_call_start_mills        = coalesce(min_call_start_mills, 30),
       low_balance_threshold_mills = coalesce(low_balance_threshold_mills, 5000)
 where id = 1;

-- Tracks which hold (if any) was placed at dial time for a given calls
-- row, so the hangup path knows whether to reconcile a hold
-- (wallet_settle_call) or fall back to a plain debit.
alter table public.calls
  add column if not exists wallet_hold_id uuid references public.wallet_ledger(id);

comment on column public.calls.wallet_hold_id is
  'wallet_ledger.id of the pending hold placed when this call was dialed (see wallet_hold usage in dialNextLead / _webrtcDial). Null for calls that predate the spend gate or whose hold could not be placed.';

-- Resolve a hold placed at call start against the real, rounded-up call
-- cost at hangup. The hold already deducted the ORIGINAL held amount from
-- balance_mills when it was placed; this reconciles the difference:
--   - actual < held  -> refund the difference back to balance (a 'refund' row)
--   - actual > held  -> charge the extra, clamped to whatever remains so
--     balance never goes negative; any uncollectible shortfall is logged
--     as a zero-balance-impact 'adjustment' row for reconciliation —
--     never silently eaten, never taken from money that isn't there.
--   - actual == held -> no adjustment row.
-- The original hold row is never rewritten — it transitions to
-- entry_type='hold_settle', status='settled', and its original amount /
-- balance_after stay exactly as recorded when the hold was placed
-- (append-only ledger; the reconciliation is a separate row).
create or replace function public.wallet_settle_call(
  p_hold_ledger_id uuid,
  p_actual_amount_mills bigint,
  p_units numeric,
  p_ref_type text,
  p_ref_id text,
  p_desc text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent      uuid;
  v_status     text;
  v_type       text;
  v_held       bigint;
  v_balance    bigint;
  v_diff       bigint;
  v_chargeable bigint;
  v_shortfall  bigint;
begin
  select agent_id, status, entry_type, abs(amount_mills)
    into v_agent, v_status, v_type, v_held
    from public.wallet_ledger
   where id = p_hold_ledger_id
     for update;

  if v_agent is null then
    raise exception 'ledger_row_not_found';
  end if;
  if v_type <> 'hold' or v_status <> 'pending' then
    raise exception 'not_a_pending_hold';
  end if;
  if p_actual_amount_mills < 0 then
    raise exception 'invalid_amount';
  end if;

  update public.wallet_ledger
     set entry_type = 'hold_settle', status = 'settled', settled_at = now()
   where id = p_hold_ledger_id;

  v_diff := v_held - p_actual_amount_mills;

  if v_diff > 0 then
    -- Call cost less than held (including never-answered = 0 actual) —
    -- refund the unused portion of the hold.
    update public.wallet_accounts
       set balance_mills = balance_mills + v_diff
     where agent_id = v_agent
    returning balance_mills into v_balance;

    insert into public.wallet_ledger
      (agent_id, entry_type, category, amount_mills, balance_after_mills,
       units, status, ref_type, ref_id, description, settled_at)
    values
      (v_agent, 'refund', 'call', v_diff, v_balance,
       p_units, 'settled', p_ref_type, p_ref_id,
       p_desc || ' — refund of unused hold', now());

  elsif v_diff < 0 then
    -- Call ran longer than the held estimate — charge the extra, clamped
    -- to whatever balance remains so it can never go negative.
    select balance_mills into v_balance from public.wallet_accounts where agent_id = v_agent for update;
    v_chargeable := least(abs(v_diff), v_balance);
    v_shortfall  := abs(v_diff) - v_chargeable;

    update public.wallet_accounts
       set balance_mills = balance_mills - v_chargeable
     where agent_id = v_agent
    returning balance_mills into v_balance;

    if v_chargeable > 0 then
      insert into public.wallet_ledger
        (agent_id, entry_type, category, amount_mills, balance_after_mills,
         units, status, ref_type, ref_id, description, settled_at)
      values
        (v_agent, 'debit', 'call', -v_chargeable, v_balance,
         p_units, 'settled', p_ref_type, p_ref_id,
         p_desc || ' — additional minutes beyond the held estimate', now());
    end if;

    if v_shortfall > 0 then
      -- Logged for reconciliation only — does NOT further touch
      -- balance_mills (there is nothing left to take). This is the
      -- "never silently absorbed" record of an uncollectible overage.
      insert into public.wallet_ledger
        (agent_id, entry_type, category, amount_mills, balance_after_mills,
         units, status, ref_type, ref_id, description, settled_at)
      values
        (v_agent, 'adjustment', 'call', -v_shortfall, v_balance,
         null, 'settled', p_ref_type, p_ref_id,
         'Uncollectible shortfall — call ran past the funded hold and the wallet had already reached $0', now());
    end if;
  end if;

  select balance_mills into v_balance from public.wallet_accounts where agent_id = v_agent;
  return v_balance;
end;
$$;

revoke all on function public.wallet_settle_call(uuid, bigint, numeric, text, text, text) from public;
grant execute on function public.wallet_settle_call(uuid, bigint, numeric, text, text, text) to service_role;
