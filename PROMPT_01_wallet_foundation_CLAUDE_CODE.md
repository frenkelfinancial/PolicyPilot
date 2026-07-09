# PROMPT 1 (Phase 1 of 3) — Claude Code — Wallet Foundation & Phone-Number Switch

> Purpose: Convert my billing from Stripe **metered subscriptions** to a **prepaid
> wallet (account balance)**. This is the code-writing half. You write all repo
> artifacts (SQL migration, edge functions, shared helpers, minimal wallet UI).
> You do NOT run SQL against the live DB and you do NOT touch the Stripe
> dashboard — a paired Cowork prompt (file 02) executes all of that. Write
> everything so it is inert until Cowork wires the real Stripe IDs.
>
> Run this inside the PolicyPilot / ProducerStack repo. Order matters — this is
> Phase 1. Do NOT build Phase 2 (SMS/MMS/email/A2P) or Phase 3 (rich UI) here.

---

## North-Star principles — bake these into everything you build (all phases)

These are the four things I am beating Ringy on. Every artifact must serve them:

1. **Billing transparency.** Every debit is an itemized, human-readable ledger row (what, how many units, unit rate, resulting balance). Never a mystery deduction. The balance is always in real dollars, never abstract "credits" the user can't price.
2. **Never charge for undelivered messages.** (Fully implemented in Phase 2, but the ledger you build now must support it: money is *held*, then *settled* on success or *voided* on failure — design the ledger with `pending`/`settled`/`voided` states from day one.)
3. **Deliverability & compliance as a done-for-you moat.** (Phase 2.) Don't design anything now that blocks it.
4. **Email that actually works.** (Phase 2.) Don't design anything now that blocks it.

---

## Ground truth about my stack (VERIFY against the repo — do not assume)

- **Frontend is a static single-page HTML app — NOT React/Next.** The live app is `app.html` (also `index.html`); vanilla JS + my design tokens (`styles.css`, `shared/tokens.css`, `PolicyPilot_Design_System.docx`). There is an existing **Billing** section and **Phone Number** UI in `app.html` (search "billing" / "Phone Number" — roughly lines 2490–2585 and 4440–4460). Do not introduce a framework.
- **Supabase (Postgres). Schema is applied by MANUAL SQL paste in the SQL Editor — never `db push`** (it silently skips `data/sql/`). Deliver **idempotent** SQL (`if not exists`, `on conflict`, guarded `alter`) as numbered files following `data/sql/*.sql` style. The next number in `data/sql/` is **013**; date-stamped mirrors go in `supabase/migrations/`.
- **Telnyx is the live voice/number provider** (SignalWire is legacy — don't extend it). Numbers are bought in `supabase/functions/telnyx-buy-number/`; minutes are billed in `supabase/functions/_shared/dialer-next-lead.ts` → `reportMinutesToStripe()`, called by `telnyx-call-status`, `telnyx-dialer-skip`, and `telnyx-report-call-minutes`.
- **Current (OLD) billing model you are REPLACING:**
  - `public.billing_config` singleton (id=1): `number_rate_cents=300`, `minute_rate_cents=2`, `stripe_numbers_price_id`, `stripe_minutes_price_id`.
  - **Each phone number = its own Stripe subscription** (`telnyx-buy-number`'s `createNumberSubscription`, stored in `phone_numbers.stripe_sub_id`).
  - **Minutes reported to Stripe metered usage** via `reportMinutesToStripe` using `agents.stripe_minutes_item_id`. It already computes `minutes = Math.max(1, Math.ceil(durationSec/60))` — **preserve that exact rounding.**
- **Access gating today** uses `agents.stripe_subscription_id` / `plan_id`. Some agents are 100%-discount ($0) and are granted access manually — do not break them.

## THE CRITICAL MONEY-UNIT RULE — read twice

My email rate is **$0.001**, a *tenth of a cent*. Whole-cent columns cannot represent it. **Store all money in MILLS (integer thousandths of a dollar). $1 = 1000 mills.** All balances, rates, ledger amounts, top-ups, and holds are `bigint` mills. Convert to dollars only for display (`mills / 1000`). Never use floats for money. The canonical rates (put these in the config table, do not hardcode elsewhere):

| Item | Rate | Mills |
|---|---|---|
| Outbound call | $0.01 / min, **rounded up** to next full min | `call_minute_mills = 10` |
| Outbound SMS | $0.01 / segment (160 chars) | `sms_segment_mills = 10` |
| Outbound MMS | $0.03 | `mms_mills = 30` |
| Outbound email | $0.001 | `email_mills = 1` |
| Local number | $3.00 / 30 days | `number_local_mills = 3000` |
| Toll-free number | $10.00 / 30 days | `number_tollfree_mills = 10000` |
| A2P 10DLC registration | pass-through fee (Phase 2) | stored per-registration |

(SMS/MMS/email/A2P rates live in config now for a single source of truth, but are only *charged* starting in Phase 2. Only **calls** and **number renewals** actually debit in Phase 1.)

## Work in this exact order — confirm each step before moving on

### 1. Read the real schema first, then report your mapping back to me
Confirm the actual columns on `agents`, `phone_numbers`, `billing_config`, `plans`, and the exact call-flow that reaches `reportMinutesToStripe`. List anything that differs from the ground-truth above **before** writing code.

### 2. Write `data/sql/013_wallet_foundation.sql` (+ dated mirror in `supabase/migrations/`)
Idempotent. It must create:

- **`public.wallet_accounts`** — one row per agent. `agent_id uuid primary key references auth.users(id) on delete cascade`, `balance_mills bigint not null default 0 check (balance_mills >= 0)`, `auto_recharge_enabled boolean not null default false`, `auto_recharge_threshold_mills bigint`, `auto_recharge_amount_mills bigint`, `low_balance_notified_at timestamptz`, `updated_at timestamptz not null default now()`. **Every agent starts at 0 — no free balance, no free credits.** Backfill a `balance_mills=0` row for every existing agent.
- **`public.wallet_ledger`** — append-only audit trail (this powers transparency AND never-charge-undelivered). Columns: `id uuid pk default gen_random_uuid()`, `agent_id uuid not null`, `entry_type text not null check (entry_type in ('topup','debit','hold','hold_settle','hold_void','refund','adjustment'))`, `category text not null` (`'call','sms','mms','email','number_local','number_tollfree','a2p_registration','topup','refund','adjustment'`), `amount_mills bigint not null` (signed: credits +, debits −), `balance_after_mills bigint not null`, `units numeric`, `unit_rate_mills bigint`, `status text not null default 'settled' check (status in ('pending','settled','voided'))`, `ref_type text`, `ref_id text`, `description text not null`, `created_at timestamptz not null default now()`, `settled_at timestamptz`. Index on `(agent_id, created_at desc)` and on `(ref_type, ref_id)`.
- **`public.wallet_topups`** — `id`, `agent_id`, `amount_mills bigint`, `stripe_payment_intent_id text unique`, `status text check in ('pending','succeeded','failed')`, `created_at`. (Unique PI id → idempotent webhook credit.)
- **Extend `public.billing_config`** (keep existing columns for back-compat): add `call_minute_mills bigint default 10`, `sms_segment_mills bigint default 10`, `mms_mills bigint default 30`, `email_mills bigint default 1`, `number_local_mills bigint default 3000`, `number_tollfree_mills bigint default 10000`. Seed them on the id=1 row.
- **Extend `public.phone_numbers`**: `number_type text not null default 'local' check (number_type in ('local','tollfree'))`, `next_renewal_at timestamptz`, `renew_from_wallet boolean not null default true`. Keep `stripe_sub_id` for now (Cowork will cancel those subs) but stop using it.
- **Atomic wallet RPCs (SECURITY DEFINER, race-safe with `SELECT ... FOR UPDATE`)** — all money movement goes through these so balance can never go negative and every change writes a ledger row in the same transaction:
  - `wallet_topup(p_agent uuid, p_amount_mills bigint, p_ref text, p_desc text)` → credits, writes ledger `topup`.
  - `wallet_debit(p_agent uuid, p_category text, p_units numeric, p_amount_mills bigint, p_ref_type text, p_ref_id text, p_desc text)` → **raises if `balance_mills < p_amount_mills`**; else decrements + settled ledger row. Returns new balance.
  - `wallet_hold(...)` / `wallet_settle(p_ledger_id uuid)` / `wallet_void(p_ledger_id uuid)` — reserve funds as a `pending` hold, then finalize or release. **Build these now even though Phase 1 uses only `wallet_debit`** — Phase 2 needs holds for never-charge-undelivered, and the ledger must be consistent from day one.
- **RLS**: an agent can `select` only their own `wallet_accounts` / `wallet_ledger` / `wallet_topups`; only the service role writes (all writes go through the RPCs / edge functions). Admin can read all (reuse `public.is_admin_agent()`).

Put a header comment block at the top like the existing `data/sql/*.sql` files explaining what to paste and in what order.

### 3. Switch **call billing** from Stripe-metered to wallet-debit
In `supabase/functions/_shared/dialer-next-lead.ts`, replace `reportMinutesToStripe`'s Stripe-usage-record logic with a call to the `wallet_debit` RPC:
- `minutes = Math.max(1, Math.ceil(durationSec / 60))` (unchanged rounding).
- `amount_mills = minutes * billing_config.call_minute_mills` (now **10 mills/min = $0.01**, down from $0.02).
- category `'call'`, `ref_type='call'`, `ref_id = call row id`, description like `"Outbound call — 3 min @ $0.01/min"`.
- Keep it **idempotent** (same guarantee `closeCallRowById` has today — never double-charge a call row). Update the three callers (`telnyx-call-status`, `telnyx-dialer-skip`, `telnyx-report-call-minutes`) if the function signature changes. Leave a clear deprecation comment where the old Stripe metered-usage code was.

### 4. Switch **phone-number billing** from per-number Stripe subs to wallet
In `supabase/functions/telnyx-buy-number/`:
- **Remove** the `createNumberSubscription` Stripe path. Instead, on purchase, call `wallet_debit` for the first 30 days: local → `number_local_mills` (3000), toll-free → `number_tollfree_mills` (10000). Set `phone_numbers.number_type` and `next_renewal_at = now() + interval '30 days'`.
- If the wallet can't cover it, **fail the purchase cleanly** (`402 insufficient_balance` with the shortfall in the body) — do not provision a number the user can't pay for.
- Replace the old `active_subscription_required` (402) gate: buying a number now requires **sufficient wallet balance**, not an active Stripe subscription.
- Support buying **toll-free** numbers (Telnyx search/provision already exists — extend it to pass number type through; verify the real Telnyx params in `telnyx-search-numbers` / `telnyx-provision-number`).

### 5. Write the **number-renewal cron worker** — `supabase/functions/wallet-renew-numbers/`
A service-role Edge Function that renews numbers whose `next_renewal_at <= now()` by `wallet_debit` (local/tollfree rate) and bumps `next_renewal_at += 30 days`. If a wallet can't cover a renewal: write a `past_due` state (add `phone_numbers.status` value if needed) and **do not release immediately** — leave a grace flag for Phase 3 to notify on. Idempotent per number per period. (Cowork will schedule this via `pg_cron`; you just write the function + provide the `cron.schedule` SQL as a deliverable comment.)

### 6. Add **wallet top-up** to Stripe checkout + webhook
- In `supabase/functions/stripe-create-checkout/`, add a **one-time top-up mode**: given an amount, create a Stripe Checkout Session (or PaymentIntent) in `mode: 'payment'` (NOT subscription) with the agent + amount_mills in metadata. Do not hardcode amounts — accept a set of top-up amounts and reference them by config.
- In `supabase/functions/stripe-webhook/`, handle `checkout.session.completed` / `payment_intent.succeeded` for top-ups: look up `agent + amount_mills` from metadata, call `wallet_topup`, upsert `wallet_topups` keyed on the PaymentIntent id (**idempotent** — never double-credit on webhook retries). Leave the existing plan-subscription webhook logic intact.

### 7. Minimal wallet UI in `app.html` (rich UI is Phase 3 — keep this small)
In the existing Billing section, using my design tokens exactly:
- Show **current balance in dollars** (`balance_mills/1000`), read on load.
- An **"Add funds" button** → the top-up checkout from step 6, with a few preset amounts.
- **Block-at-zero UX:** if balance is 0 (or below the cost of an action), calling/number-buying is disabled with a clear "Add funds to start calling" message — mirror this gate client-side, but the server RPCs are the real enforcement.
- A **plain-English note** that balance and credits **never expire**.
Do not build the itemized ledger table or live per-action cost preview yet — that's Phase 3.

### 8. Deliver a Cowork hand-off checklist
Output a concise, ordered list of exactly what the paired Cowork prompt must do live: which SQL files to paste (in order), which Stripe products/prices to create (top-up product, and **cancel** the old per-number & metered-minute prices), which IDs to paste into `billing_config`, which secrets to set, which functions to `supabase functions deploy`, and the existing-customer migration (cancel live per-number subscriptions, stop metered minute reporting). Mark which steps block go-live.

## Do NOT do in Phase 1
- No SMS/MMS/email sending or billing, no delivery webhooks, no A2P — that is Phase 2.
- No itemized-ledger UI, no live cost preview, no auto-recharge automation UI — that is Phase 3.
- Do not delete the old `stripe_sub_id` / `stripe_minutes_item_id` columns yet (Cowork needs them to unwind live subscriptions). Just stop writing to them.
- Do not give any agent a starting balance or free credits. Everyone starts at $0.
- Never hardcode Stripe IDs, rates, or a from-address. Everything config- or secret-driven.

Prioritize: money stored in mills, atomic race-safe RPCs, exact `Math.ceil` minute rounding, idempotent webhooks/renewals, zero disruption to the plan-subscription flow, and no starting balance. Ask before anything destructive.
