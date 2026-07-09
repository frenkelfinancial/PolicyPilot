# Wallet migration — pre-migration snapshot

Captured via `supabase db query --linked` (read-only) against project
`cweiaibjigjwspmshcrj` on 2026-07-08, before `016_wallet_foundation.sql` /
`017_wallet_spend_gate.sql` are applied. Agent emails are intentionally
omitted from this file (join `agents.email` live by `agent_id` if ever
needed) — this file is tracked in git and `docs/` is not gitignored.

## Agents (6 total)

| metric | count |
|---|---|
| total agents | 6 |
| with a plan (`plan_id` set) | 4 |
| admins | 1 |
| with `stripe_customer_id` | 1 |
| with `stripe_subscription_id` | 1 |
| with `stripe_numbers_item_id` | 0 |
| with `stripe_minutes_item_id` | 1 |

Only **one** agent has any live Stripe billing artifact:

| agent_id | plan_id | stripe_customer_id | stripe_subscription_id | stripe_numbers_item_id | stripe_minutes_item_id |
|---|---|---|---|---|---|
| `242ebda1-5cb4-4e9d-809e-696c8274f5d1` | `d364210c-0170-46cf-9231-d729e9711f9f` | `cus_UopiS3qmKamNfO` | `sub_1TpC2z14emSc8rogWliSA5p5` | *(null)* | `si_Uotmu8bKcqQPJ6` |

`stripe_subscription_id` here is this agent's **plan subscription** (Basic/Pro/Max) —
per migration policy this must NOT be touched or cancelled. The only Stripe
action needed is removing the metered-minutes **subscription item**
`si_Uotmu8bKcqQPJ6` from that subscription (not the subscription itself),
then clearing `agents.stripe_minutes_item_id` to null.

## Phone numbers (4 total, all active)

No `phone_numbers` row has `stripe_sub_id` set — the per-number Stripe
subscription model was never actually populated for any live number, so
**no per-number Stripe subscriptions need cancelling**. This significantly
simplifies Step 6: there is nothing to cancel here, only the one metered
item above.

| id | agent_id | e164 | monthly_cost | purchased_at |
|---|---|---|---|---|
| `24e5c63a-7645-48ba-bfd2-00296db5931e` | `f1c78a79-95f9-47c0-b279-29d6fb96c419` | +12029981783 | $1.00 | 2026-06-15 |
| `11f04598-612e-4016-a248-ec790f60222b` | `242ebda1-5cb4-4e9d-809e-696c8274f5d1` | +12027428855 | $3.00 | 2026-07-03 |
| `e7a32f8e-7de9-44fc-9698-d0759226c0c9` | `89e10ce2-27bb-4fb1-aa44-c84bb4f46138` | +12027718346 | $3.00 | 2026-07-06 |
| `d9db8206-5f5f-4371-810a-55ed804784d9` | `752a788a-5dcf-4010-90c8-2cbddd8ab958` | +12027437798 | $3.00 | 2026-07-06 |

After migration, all 4 will get `next_renewal_at = now() + 30 days` (per
`016_wallet_foundation.sql`'s backfill) — a full 30-day grace window before
the wallet-renew-numbers cron first tries to debit any of them.

## billing_config (pre-migration baseline)

```json
{
  "id": 1,
  "number_rate_cents": 300,
  "minute_rate_cents": 2,
  "stripe_numbers_price_id": "price_1Tj0vZ14emSc8rogHtbsbNfj",
  "stripe_minutes_price_id": "price_1Tj12F14emSc8rogYHLGNGGz",
  "updated_at": "2026-06-16T17:46:47.103344+00:00"
}
```

These two Stripe Price IDs become unused once wallet billing takes over
(nothing in the new code reads `stripe_numbers_price_id`/
`stripe_minutes_price_id` for new purchases or renewals) — no action
required against them; they can be archived in the Stripe Dashboard at
your convenience, not blocking.

## Stripe key configuration (found during preflight, not part of the DB snapshot)

Two secrets are configured: `STRIPE_SECRET_KEY` (used by all live code) and
a typo'd `STIPE_SECRET_KEY` (not referenced anywhere in the codebase —
confirmed by grep). A throwaway diagnostic function (deployed and deleted
immediately after use, prefix-check only, never read the key values into
this conversation) reported:

- `STRIPE_SECRET_KEY` → **live mode**
- `STIPE_SECRET_KEY` → **live mode**, and a **different value** from the
  correct key (not a copy/duplicate)

There is no test-mode key configured in this project at all. The unused,
differently-valued `STIPE_SECRET_KEY` typo secret is a live API credential
sitting unused — recommend revoking it in the Stripe Dashboard once
confirmed it isn't needed elsewhere.

## Rollback note

Nothing has been written to the live database yet as of this snapshot —
016/017 have not been applied, no Stripe object has been created or
cancelled. If a rollback is ever needed after migration: the wallet tables
are additive (nothing existing is dropped), and the one subscription-item
removal above is Stripe's only destructive live action, reversible by
re-adding a metered item to `sub_1TpC2z14emSc8rogWliSA5p5` if ever required.
