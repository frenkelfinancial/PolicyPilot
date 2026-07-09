# PROMPT 2 (Phase 1 of 3) — Claude Code — Take the Wallet LIVE

> Purpose: Phase 1's code is already written (from PROMPT_01). Now take it live
> yourself: run the SQL, create/switch the Stripe products via the Stripe API,
> deploy the Edge Functions, migrate existing customers off the old metered
> subscriptions, and verify end-to-end. You do the terminal/SQL/Stripe-API
> work directly — but you STOP and show me before any live or destructive step.
> The few browser-only bits are handled separately in the Cowork prompt (file 05).
>
> Run in the PolicyPilot repo. This is still Phase 1 — no SMS/MMS/email/A2P.

---

## North-Star principles (the four things I'm beating Ringy on — keep serving them)
1. **Billing transparency** — after go-live, every test action must produce a clear itemized ledger row.
2. **Never charge for undelivered** — Phase 2, but don't break the hold/settle/void ledger.
3. **Deliverability & compliance moat** — Phase 2.
4. **Email that actually works** — Phase 2.

## Hard rule: APPROVAL GATES
You may run SQL, call the Stripe API, deploy functions, and set secrets yourself. But before **(a)** running SQL against the live database, **(b)** creating/cancelling anything in LIVE-mode Stripe, or **(c)** cancelling any existing customer's subscription — **print exactly what you're about to do and wait for my explicit "go."** Do all Stripe work in **TEST mode first**, show me it works, then repeat in LIVE. Never skip my manual review of SQL — that checkpoint is intentional.

## Step 0 — Re-read what Phase 1 actually shipped
Read the migration file PROMPT_01 produced (it is **`data/sql/016_wallet_foundation.sql`** — 013/014/015 were already taken; the file self-documents this) plus its mirror `supabase/migrations/20260709b_wallet_foundation.sql`, and the changed functions (`_shared/dialer-next-lead.ts`, `stripe-create-checkout`, `stripe-webhook`, `telnyx-buy-number`). Confirm the REAL names of: `wallet_accounts`, `wallet_ledger`, `wallet_topups`, the `wallet_topup/debit/hold/settle/void` (and `wallet_credit_topup`) RPCs, the `billing_config` mills columns (`call_minute_mills=10`, etc.), and the new `phone_numbers` columns. Everything below uses those real names. Money is in **mills** ($1 = 1000 mills).

**Known gap to fix first:** PROMPT_01 did **not** create the `supabase/functions/wallet-renew-numbers/` cron worker (the function that renews numbers from the wallet every 30 days by calling `wallet_debit` at the local/toll-free rate and advancing `next_renewal_at`; underfunded wallets get flagged `past_due`, never charged negative, never silently released). **Write that function now** before deploying, following the spec in PROMPT_01 step 5.

**Also build now — the low-balance nudge system (needed for the migration, since existing customers drop to $0):**
1. **Recurring dismissible pop-up.** In `app.html`, a modal that shows on **every page load/refresh when the agent's balance is below a low-balance threshold** (including $0). Copy: "Your balance is too low" with a short line that calls/texts/number renewals need funds, a primary **"Top up now"** button that routes to the **Billing tab**, and a dismiss ("X"/"Not now") — the user CAN click out and keep using the app. It reappears next load until the balance is healthy. Match my design tokens exactly. This is the awareness layer; the server RPCs remain the real enforcement (a $0 wallet still can't call/buy).
2. **Low-balance email.** Reuse my existing Resend send pattern (see the digest functions for the code shape and secrets). Send a "your balance is too low — add funds" email: once to every existing customer at migration, and on an ongoing trigger when an agent first crosses into low/zero balance (debounced so it doesn't repeat-spam). If my Resend/email infra isn't live yet, still build it but gate the actual send behind a flag and tell me — the pop-up is the guaranteed channel regardless. Never hardcode the from-address.

**Also build now — the UNIVERSAL SPEND GATE (this is a hard requirement: nothing may EVER cost me money that the customer's wallet can't cover):**
- **One choke point, server-authoritative.** Every billable action must pass a balance check on the server BEFORE it can start, and be rejected with a clear `insufficient_balance` error (message to the user: **"Insufficient wallet balance — top up to continue"**). This applies to: **click-to-call / the WebRTC softphone** (`telnyx-webrtc-token` / `telnyx-dialer-create-session` / wherever `app.html`'s `_webrtcDial` initiates), the **power dialer** (session start AND each dial), **buying a number** (local/toll-free — already gated in PROMPT_01, confirm), and any other path that debits the wallet. Client-side, **disable** those controls and show the same message when the wallet can't cover the minimum — but the server check is the real enforcement; never trust the client.
- **Close the post-pay overspend hole (calls bill per-minute at call END).** A customer at $0.01 must not be able to start a call and talk for 20 minutes, leaving a debit that fails after I've already paid Telnyx. Enforce BOTH: (a) require a configurable **minimum start balance** (`billing_config.min_call_start_mills`, default e.g. 3 minutes' worth) before a call can begin, AND (b) place a **`wallet_hold`** at call start for that estimated amount, then `wallet_settle` the real rounded-up minutes at hangup (refunding the difference) — reuse the Phase-1 hold/settle/void RPCs. If a call would exceed the held/available balance mid-call, end it gracefully at the limit. Under no circumstances may `wallet_debit` drive a balance negative — the RPC must clamp/raise, and any residual must be logged, never silently absorbed by me.
- **Net effect:** a $0 or underfunded wallet can browse the CRM and see the nudge, but **cannot trigger a single billable action.** Verify there is no code path (softphone, dialer, number buy/renew, or Phase-2 messaging later) that spends before the balance check.

## Step 1 — Preflight
Confirm you can reach Supabase (connection string / service role in `.env.local`) and Stripe (`STRIPE_SECRET_KEY`). Report which Stripe mode each key is (test vs live). Confirm the Supabase project ref. Do NOT use `db push` (it skips `data/sql/`); run the exact SQL via `psql`/the SQL runner so my file is applied verbatim.

## Step 2 — Back up (do this before anything)
Snapshot `agents`, `phone_numbers`, `billing_config`, and list every currently-active Stripe subscription (plan subs, per-number subs, metered-minute items) into `docs/wallet-migration/pre-migration-state.md`. We must be able to reconcile and roll back.

## Step 3 — Apply the schema (APPROVAL GATE)
Show me the full SQL, then on my go, run `data/sql/013_wallet_foundation.sql` verbatim. Verify: all three wallet tables exist, **every agent has a `balance_mills = 0` row (no starting balance, no free credits)**, the `billing_config` mills columns are seeded 10/10/30/1/3000/10000, the new `phone_numbers` columns exist, and the RPCs exist. Confirm RLS: an agent can read only their own wallet rows.

## Step 4 — Stripe products via API (TEST first, then LIVE with gate)
- Create the **Wallet Top-Up** product with the preset one-time prices (`mode: payment`, NOT subscription) via the Stripe API. Capture the IDs and write them into `billing_config` via SQL where PROMPT_01 expects them — never hardcode in code.
- Confirm no per-usage **metered** Stripe prices are needed anymore (usage now debits the wallet in our DB).
- Do the whole thing in test mode, prove a test top-up works, then repeat in live mode on my go.

## Step 5 — Secrets, deploy, webhook, cron
- `supabase secrets set` for anything new PROMPT_01 introduced (keep `STRIPE_SECRET_KEY`; service role auto-injected — don't hardcode).
- `supabase functions deploy`: `stripe-create-checkout`, `stripe-webhook`, `telnyx-buy-number`, `telnyx-report-call-minutes`, `telnyx-call-status`, `telnyx-dialer-skip`, redeploy `_shared` dependents, and the new `wallet-renew-numbers`.
- Point/confirm the Stripe webhook at the deployed `stripe-webhook`; enable `checkout.session.completed` + `payment_intent.succeeded`. Test that a top-up event credits the wallet and that **webhook retries do not double-credit**.
- Schedule `wallet-renew-numbers` daily via `pg_cron` + `net.http_post` (match the existing digest cron pattern). Confirm it's in `cron.job`.

## Step 6 — Migrate existing customers off the old model (APPROVAL GATE)
**Migration policy I chose: HARD $0 for everyone, no courtesy credit — drive top-ups with loud, dismissible nudges + email.** Specifically:
- **Do NOT seed any balance.** Every existing agent starts at a literal $0 wallet post-migration (matches the "no starting balance" rule).
- **Cancel the live per-number Stripe subscriptions** (`phone_numbers.stripe_sub_id`) so nobody is double-billed, and remove `stripe_minutes_item_id` metered line items. Do this at the same time as the SQL apply so no one is billed on Stripe while being debited from a $0 wallet.
- **Give numbers a grace window, don't strand anyone instantly:** set `next_renewal_at` to a near-future date and let the renewal cron flag underfunded numbers `past_due` — **numbers are NOT silently released;** the nudges get time to convert the customer to a top-up. (Decide with me how many past-due days before a number is actually released — default to a generous window.)
- **Fire the migration nudges:** send the low-balance email (Step 0.2) to every existing customer, and confirm the recurring dismissible pop-up (Step 0.1) shows for anyone under threshold.
- Do not touch plan subscriptions or $0/100%-discount agents' plan access.
- Write every cancelled subscription, each number's new renewal date, and the email send list to `docs/wallet-migration/reconciliation.md`.

## Step 7 — Verify end-to-end (paste results)
1. New agent starts at **$0** → cannot call or buy a number until they top up (RPC rejects + UI blocks).
2. **Top-up** (test card) credits exactly (dollars→mills), writes a `topup` ledger row, no double-credit on retry.
3. A **3-min-1-sec call** debits **4 × $0.01 = $0.04** (rounds up), itemized, can't double-charge.
4. **Local number** → −$3.00; **toll-free** → −$10.00; both set `next_renewal_at` +30 days.
5. **Renewal cron** debits on due date and advances it; underfunded wallet flagged past-due, not charged negative, not auto-released.
6. Balance + ledger visible in `app.html`, reconciles to the penny.
7. **Low-balance nudge:** an agent under threshold (incl. $0) sees the dismissible "balance too low" pop-up on every load, can click out, and the "Top up now" button lands on the Billing tab; the pop-up stops once balance is healthy. The migration low-balance email sends to existing customers (or is flag-gated with a clear note if email infra isn't live).
8. **Spend gate holds:** a **$0 wallet cannot start a click-to-call, a dialer session, or buy a number** — each is blocked client-side (disabled + "Insufficient wallet balance") AND server-side (rejected). Prove the post-pay hole is closed: a wallet with only 1 minute of funds cannot run a long call into a negative balance — the call is gated at start and/or ended at the funded limit, and my balance never goes negative.

## Step 8 — Hand-off
List anything left that needs a **browser/human** (there's little for Phase 1 — optionally eyeball the Stripe dashboard). Those go to the Cowork prompt (file 05, §1). Give me the short go-live checklist and mark what blocks go-live.

## Do NOT
- No SMS/MMS/email/A2P (Phase 2). No rich ledger UI/auto-recharge automation (Phase 3).
- No starting balance for anyone. No silent number release. Nothing destructive without a backup + my go.
- Never hardcode Stripe IDs, rates, or from-addresses.
