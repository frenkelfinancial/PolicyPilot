# Telnyx Number Reputation — automated spam-score registration

Goal: stop new dialer numbers getting "Spam Likely" flagged in their first ~30 dials.
When numbers are associated with an approved Telnyx **Enterprise**, Telnyx registers
them across the carrier call-analytics reputation feed (Hiya-sourced) on our behalf —
the automated replacement for manually filing each number on FreeCallerRegistry.com.

## Pieces

| File | Role |
| --- | --- |
| `supabase/migrations/20260716_number_reputation.sql` | `reputation_config` table + reputation columns on `phone_numbers` |
| `supabase/functions/_shared/telnyx-reputation.ts` | shared associate/register helpers (best-effort, never blocks purchases) |
| `supabase/functions/telnyx-buy-number` / `telnyx-provision-number` / `telnyx-replace-number` | auto-register each new number at purchase time |
| `supabase/functions/telnyx-reputation-monitor` | cron: syncs approval gates, backfills unregistered numbers (≤100/batch, per-number fallback), copies cached spam scores onto `phone_numbers` |
| `scripts/setup-telnyx-reputation.mjs` | one-time CLI: `init` → `loa` → `enable` → `status` |
| `scripts/telnyx-enterprise.template.json` | business-details payload for `init` |

## One-time setup (manual, in order)

1. **Telnyx account level** — Number Reputation endpoints require a *verified* or
   *enterprise-level* Telnyx account (trial/standard are rejected). Check in the
   Telnyx portal; contact Telnyx support to upgrade if needed.
2. Copy `scripts/telnyx-enterprise.template.json` → `scripts/telnyx-enterprise.json`
   and fill in real business details (legal name, **EIN**, address, contacts).
   Do not commit the filled file.
3. `node scripts/setup-telnyx-reputation.mjs init` — accepts the Number Reputation
   ToS (a legal agreement) and creates the enterprise.
4. `node scripts/setup-telnyx-reputation.mjs loa` — renders `telnyx-loa.pdf`.
   **Sign it** (e-sign is fine), save as `telnyx-loa-signed.pdf`.
5. `node scripts/setup-telnyx-reputation.mjs enable telnyx-loa-signed.pdf` —
   uploads the LOA and enables reputation (**billable** from here).
6. `node scripts/setup-telnyx-reputation.mjs status` — repeat until BOTH
   `status` and `loa_status` read `approved` (two independent gates; the LOA is
   the #1 thing people get stuck on). Each run syncs `reputation_config` in
   Supabase so the edge functions know when to start registering.

## Deploy

```
supabase db push          # migration
supabase functions deploy telnyx-buy-number telnyx-provision-number \
  telnyx-replace-number telnyx-reputation-monitor
supabase secrets set REPUTATION_CRON_SECRET=<random>
# then schedule the cron (see commented cron.schedule in the migration)
```

## Behavior notes / gotchas

- **US local numbers only** — Telnyx reputation monitoring rejects toll-free;
  helpers skip `number_type != 'local'`.
- Association is **atomic per request** (all-or-nothing): the monitor retries a
  failed batch one number at a time so a single stale number can't block a backfill.
- Cached reputation reads are **free**; fresh/forced queries and each auto-refresh
  are **billed per number**. The monitor only reads cached data. `check_frequency`
  is set to `business_daily` at enable time — dial it down if the bill is too high.
- `phone_numbers.spam_risk` = `low`/`medium`/`high` (null = no data yet). `high`
  means carriers likely flag it → surface in UI and push the agent to replace the
  number (telnyx-replace-number auto-registers the fresh one).
- Registration lowers flag probability but does not immunize: keep dial hygiene
  (age new numbers 1–2 weeks, cap daily dials/number, don't hammer dead leads).
