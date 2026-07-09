# Wallet migration — reconciliation log

Live actions taken against project `cweiaibjigjwspmshcrj`, in order, with
explicit "go" obtained before each gated step. See `pre-migration-state.md`
for the snapshot taken beforehand.

## Incident (2026-07-09): free wallet credit + open RPC grants

User reported clicking the $5 "Add funds" preset credited their wallet
instantly with no Stripe Checkout, no card, no PaymentIntent. Root causes:

1. `stripe-create-checkout`'s topup mode had a `user.email === DEV_EMAIL`
   branch that called `wallet_topup` directly — the same dev-bypass
   pattern used elsewhere in the codebase for free numbers/plans, ported
   in without recognizing that minting spendable balance is categorically
   different from waiving a cost the business already controls. Removed
   entirely (`data/sql` unaffected — this was app code, not schema).
2. **Separately, and more severely**: every `wallet_*` RPC was directly
   executable by `anon` and `authenticated` on the live database. The
   original `revoke all on function ... from public` in 016/017 only
   stripped the `PUBLIC` pseudo-role's grant — it did nothing to
   Supabase's default direct grant of new functions to `anon`/
   `authenticated`. This meant anyone with the public anon key (embedded
   client-side, inherently public) could have called `wallet_topup` for
   any `agent_id` with any amount, no authentication match required.
   Fixed live via explicit `revoke execute ... from anon, authenticated`
   on all seven wallet RPCs, captured in `data/sql/018_wallet_rpc_lockdown.sql`.
   Verified via `has_function_privilege(...)` before and after: only
   `service_role` can execute any wallet RPC now.

**Reversal**: found exactly one fake ledger row — agent
`f1c78a79-95f9-47c0-b279-29d6fb96c419` (the dev account), `+5000` mills
via `wallet_topup`, `ref_type='stripe_payment_intent'`,
`ref_id='dev-1783575224800'` (never a real Stripe ID). `wallet_topups`
had zero rows for this agent (the dev path never wrote to that table),
confirmed project-wide zero `succeeded` rows in `wallet_topups` at all.
Balance manually corrected to $0.00 via a direct SQL transaction —
decremented `wallet_accounts.balance_mills` by 5000 and inserted an
`adjustment` ledger row (append-only: the original fake `topup` row was
left in place as a historical record, not deleted, with the correction
as a separate linked row) — rather than a new RPC, since no
"manual correction" RPC exists and this was a one-off.

Redeployed `stripe-create-checkout`, `app.html` (Vercel + GitHub Pages).

## 1. Schema applied

- `data/sql/016_wallet_foundation.sql` — applied via `supabase db query --linked -f`. No errors.
- `data/sql/017_wallet_spend_gate.sql` — applied via the same method. No errors.
- Verified: `wallet_accounts` has 6 rows, all `balance_mills = 0`, none negative.
- Verified: all 7 RPCs exist (`wallet_topup`, `wallet_debit`, `wallet_hold`, `wallet_settle`, `wallet_void`, `wallet_credit_topup`, `wallet_settle_call`).
- Verified: `billing_config` seeded — `call_minute_mills=10`, `sms_segment_mills=10`, `mms_mills=30`, `email_mills=1`, `number_local_mills=3000`, `number_tollfree_mills=10000`, `min_call_start_mills=30`, `low_balance_threshold_mills=5000`, `topup_presets_mills=[5000,10000,25000,50000,100000]`.
- Verified: RLS on `wallet_accounts`/`wallet_ledger`/`wallet_topups` is SELECT-only, own + admin — no insert/update/delete policies for authenticated/anon.
- Verified: all 4 live `phone_numbers` rows got `number_type='local'`, `next_renewal_at = now()+30d`, `renew_from_wallet=true`, `past_due_since=null`.

## 2. Stripe top-up product created (live mode)

- `POST /v1/products` → `prod_UqnE4Du2YoY6zs` ("PolicyPilot Wallet Top-Up").
- Written to `billing_config.stripe_topup_product_id`.
- No new Price objects needed — checkout uses dynamic `price_data` per top-up amount (see `stripe-create-checkout` mode `"topup"`).
- Created via a throwaway diagnostic edge function (deployed, invoked once, deleted immediately after) so the raw `STRIPE_SECRET_KEY` never left the server or entered this conversation.

## 3. Functions deployed

`stripe-create-checkout`, `stripe-webhook`, `telnyx-buy-number`, `telnyx-search-numbers`,
`telnyx-replace-number`, `telnyx-report-call-minutes`, `telnyx-call-status`,
`telnyx-dialer-skip`, `telnyx-dialer-end`, `telnyx-dialer-create-session`,
`telnyx-webrtc-token`, `telnyx-bridge`, `wallet-renew-numbers`,
`wallet-low-balance-notify`, `wallet-hold-call` — all deployed successfully
via `supabase functions deploy --use-api`.

**Fixed during deploy verification:** `wallet-low-balance-notify` initially
had no auth check at all — since it wasn't deployed with `--no-verify-jwt`,
the *public anon key* (embedded client-side in `app.html`) would have been
enough to trigger real customer emails or read who's low on funds. Added
an explicit auth guard before first live exposure; confirmed the
unauthenticated request now returns 401.

## 4. Cron auth: dedicated secret instead of the service role key

Rather than embed the actual `SUPABASE_SERVICE_ROLE_KEY` into a `pg_cron` /
`net.http_post` call (which would require materializing that credential),
minted a fresh, purpose-specific `WALLET_CRON_SECRET` (32 random bytes,
generated locally, never derived from or equal to any existing credential)
and set it as a new Supabase secret. `wallet-renew-numbers` and
`wallet-low-balance-notify` now check that secret instead of the service
role key. Scoped, revocable independently of the service role key if ever
needed.

## 5. Cron jobs scheduled

| jobname | schedule | purpose |
|---|---|---|
| `wallet-renew-numbers` | `0 * * * *` (hourly) | renews numbers whose `next_renewal_at` has passed |
| `wallet-low-balance-notify` | `0 13 * * *` (daily, 9am ET) | ongoing low-balance email trigger (debounced) |

Confirmed both present and `active=true` in `cron.job`.

## 6. Stripe webhook

Already pointed at `stripe-webhook` (`we_1Tizth14emSc8rogHvjLsrKs`) with
`checkout.session.completed` already enabled (sufficient on its own for
top-ups to credit correctly). Added `payment_intent.succeeded` for the
redundancy the brief asked for — `wallet_credit_topup`'s uniqueness on
`stripe_payment_intent_id` means both events firing for the same payment
can never double-credit.

## 7. Stripe subscription-item removed (live, with explicit go)

- `DELETE /v1/subscription_items/si_Uotmu8bKcqQPJ6` → `{"deleted": true}`.
- Subscription `sub_1TpC2z14emSc8rogWliSA5p5` (agent
  `242ebda1-5cb4-4e9d-809e-696c8274f5d1`'s **plan** subscription) is
  untouched — confirmed via the same query that cleared the DB column.
- `UPDATE agents SET stripe_minutes_item_id = null WHERE id = '242ebda1-...'`
  — confirmed cleared, `stripe_subscription_id` unchanged.
- Done via another throwaway diagnostic function (deployed, invoked once,
  deleted immediately after).
- **No metered Stripe billing remains anywhere in this project.**

## Not yet done (needs a human)

1. **A real end-to-end top-up test** — I have no way to drive a browser or
   use a live payment method myself. Please do one top-up as a logged-in
   user once you're ready (any amount from the preset grid) and confirm:
   the balance updates, exactly one `wallet_topups` row appears even if
   you refresh the success page, and the ledger shows a single `topup` row.
2. **The one-time migration low-balance email blast** — deliberately held.
   Only 1 of the 6 agents was ever an actual paying customer (the other 5
   are the admin account or manually-granted plan access with no Stripe
   subscription) — decided not to blast all 6. Not sent to anyone yet;
   `wallet-low-balance-notify` is ready to fire on your call whenever you
   decide the scope (its own debounce means it's safe to invoke more than
   once — it only ever emails an agent once per low-balance episode).
