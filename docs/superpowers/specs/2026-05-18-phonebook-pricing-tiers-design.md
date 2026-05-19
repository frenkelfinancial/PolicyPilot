# Phone Book — Basic / Pro / Max Pricing Tiers

**Date:** 2026-05-18
**Branch:** `feature/phone-book-tab`
**Supersedes:** the inline Starter/Pro/Scale seed in `data/sql/009_phone_book.sql` (not yet applied to Supabase).

## Goal

Rename the Phone Book's plan catalog to **Basic / Pro / Max** and turn each tier into a *bundle* of three usage caps (outbound minutes, ITK live quotes, included DID numbers) plus a recording-retention window — so a single plan choice provisions the whole agent surface instead of three orthogonal caps drifting independently. This lands before billing wiring; gates are enforceable, payment processing is still deferred.

## Non-goals

- Real payment processing. The existing `pb-billing-note` ("Billing isn't wired up yet — for now this just updates your monthly cap. Real payment processing is coming soon.") stays in the UI.
- Usage-based overage pricing. Minutes and quotes remain **hard-capped** at the plan limit — matches what `signalwire-bridge` and `itk-quote` already enforce, and keeps surprise-bill risk at zero.
- Per-second / per-minute pricing of telephony beyond the cap. SignalWire's underlying per-minute fee still hits the SignalWire account directly; the plan price is a flat subscription envelope.
- SMS, releasing/cancelling numbers, vanity search, international numbers, inbound routing — all still out of scope per `[[project_phone_book]]`.

## The three tiers

| | **Basic** | **Pro** | **Max** |
|---|---:|---:|---:|
| Price / month | $29 | $79 | $199 |
| Outbound minutes | 750 | 2,500 | 10,000 |
| ITK live quotes | 250 | 1,000 | 10,000 |
| Included DID numbers | 1 | 3 | 10 |
| Extra DIDs | $1.50/mo each | $1.50/mo each | $1.50/mo each |
| Call recording retention | 30 days | 90 days | 365 days |
| Overage policy | hard cap | hard cap | hard cap |

### Rationale

- **Bottom raised, top stretched.** Old Starter (500 min / $25) was thin for a real producer; raising to 750 min / $29 gives the entry tier daily-use viability without abandoning the prior price band. Old Scale (5,000 min / $150) becomes a wider Max at 10,000 min / $199 — anchors "everything turned up" and creates real headroom for power users.
- **~$0.04/min effective at every tier** ($0.0387 Basic, $0.0316 Pro, $0.0199 Max), well above SignalWire wholesale (~$0.013/min). Margin tightens at Max — by design — because Max users absorb more of the included-numbers cost too.
- **Quotes scaled with phone activity.** ITK lookups correlate with selling activity; if you're talking more, you're quoting more. Existing per-agent default cap is 250/mo — that becomes Basic's number unchanged, so current agents won't feel a regression.
- **Included DIDs is a soft moat.** SignalWire still bills the underlying ~$1/mo per number to the SignalWire account; "included" means *we absorb that cost up to the tier's count*. The unit-economic loss at Max is bounded ($10/mo).
- **Hard cap, not overage.** Three reasons: (1) no payment processor wired up, (2) avoids `signalwire-bridge` and `itk-quote` enforcement diverging from the UI's "you have N left" promise, (3) clearer mental model — the agent's plan is a budget, not a metered bill.

## Schema changes

All in **one edit** to `data/sql/009_phone_book.sql` — the migration hasn't been pasted into Supabase yet (per `[[project_phone_book]]` pending actions), so this is not a follow-up migration but a revision of the original.

### `public.plans` — new columns + new seed

The migration has never been pasted into Supabase (per `[[project_phone_book]]` pending actions and `[[project_sql_migrations_manual]]`), so we revise the file in place. There is no "legacy plan" cleanup to do — there are no existing rows yet.

Add three columns to the `create table if not exists public.plans (...)` block:

```sql
  monthly_quote_limit       int  not null default 0,
  included_numbers          int  not null default 0,
  recording_retention_days  int  not null default 30,
```

Replace the existing 3-row seed with:

```sql
insert into public.plans
  (slug, name, monthly_minutes, monthly_quote_limit, included_numbers, recording_retention_days, monthly_cost, sort_order)
values
  ('basic', 'Basic',    750,    250,  1,  30,  29.00, 1),
  ('pro',   'Pro',    2500,   1000,  3,  90,  79.00, 2),
  ('max',   'Max',   10000,  10000, 10, 365, 199.00, 3)
on conflict (slug) do nothing;
```

### `public.agents` — backfill unchanged

The existing backfill in `009_phone_book.sql` picks the smallest plan whose `monthly_minutes >= agents.monthly_minute_limit`. With the new minutes ladder (750 / 2500 / 10000) and the existing default of 500, every agent lands on **Basic** — which is the right starting point. No edits to the backfill block.

Existing per-agent `agents.monthly_minute_limit` (set in `007_signalwire.sql`) and `agents.monthly_quote_limit` (set in `005_quote_usage.sql`) stay as the **authoritative caps the edge functions read**; `pbApplyPlanChange()` writes them from the chosen plan's columns. No new column on `agents`.

## Code changes

### 1. Upgrade modal — feature matrix per option

`index.html` `pbRenderUpgradeOptions()` (around line 11058) currently renders only minutes per row. Replace the `.pb-plan-opt-detail` block with three short lines:

```
2,500 minutes / month
1,000 quotes / month
3 phone numbers included
```

CSS: existing `.pb-plan-opt-detail` already styles a small block; multiline is fine with `line-height:1.6`. No new selector needed.

### 2. Apply plan change — write both caps

`pbApplyPlanChange()` (around line 11093) currently writes `{ plan_id, monthly_minute_limit }`. Extend the update payload:

```js
await sb.from('agents').update({
  plan_id:              plan.id,
  monthly_minute_limit: plan.monthly_minutes,
  monthly_quote_limit:  plan.monthly_quote_limit,
}).eq('id', currentAgent.id);
```

This keeps both edge-function enforcement points (`signalwire-bridge`, `itk-quote`) reading the right cap immediately after a plan change. No edge-function code changes.

### 3. Plan card — add quotes row + numbers count

`pbRenderPlanCard()` (around line 10646) currently shows one progress bar (minutes). Add:

- A second usage row below the minute bar: **quotes used / quote cap**, same `.pb-bar` + `.pb-bar-fill` styling, sourced from a new parallel read of `quote_usage` (table from `005_quote_usage.sql`). Window matches the edge function: `created_at >= now() - interval '30 days'` (trailing 30 days, **not** calendar month — minutes use calendar-month-since-the-1st in `signalwire-bridge`, quotes use rolling-30-days in `itk-quote`; this asymmetry already exists and the UI should reflect it). Label the bar `quotes used (last 30 days)` so the agent isn't confused by the different reset cadence.
- A small line under the bar group: `Numbers: <owned> of <included> included` — coloured `--ds-color-warning` when `owned > included` so agents see they're paying for extras.

The parallel read goes into the existing `Promise.all` in `renderPhoneBook()` so the tab still paints in one round trip.

### 4. Buy Number modal — included vs. extra

`pbConfirmBuy()` (around line 11005) currently confirms with a generic `~$1.00/month to your SignalWire bill` message. Extend the modal to compute `includedRemaining = plan.included_numbers - currentNumbers.length`:

- If `includedRemaining > 0`: the per-row Buy button label stays "Buy", confirm copy says "**Included with your plan** — no extra charge."
- If `includedRemaining <= 0`: button label becomes "Buy ($1.50/mo)", confirm copy says "**This number is beyond your plan's included <N> — adds $1.50/mo to your subscription.**"

The actual $1.50 is **informational only** for now (no billing). When billing lands, this becomes a real upcharge; today it's a truthful disclosure of the future state. Document this explicitly in `pb-billing-note`.

### 5. Plan card — surface recording retention

Below the renews-on line, add: `Recordings kept for <N> days` (read from `plan.recording_retention_days`). Purely informational in this spec — the actual recording-purge job is a separate scope (not built yet).

## Out-of-scope clean-up done in this spec

- `[[project_phone_book]]` memory will need an update to reflect the new tier names + bundled-cap model. Done at end of implementation, not as part of this spec.
- The `pb-billing-note` text in the upgrade modal is reworded to call out the included-numbers semantics explicitly (one sentence added).

## Open questions

None to block on — all defaults below are reasonable calls the spec adopts; the spec review is the place to redirect any of them.

- **$/mo amounts** ($29 / $79 / $199): adopted. Easy to tweak by editing the seed before paste.
- **Recording retention numbers** (30 / 90 / 365 days): adopted. No purge job exists yet, so these are essentially policy strings until a retention worker ships.
- **Extra-DID price** ($1.50/mo): adopted. SignalWire underlying cost is ~$1.00, so $0.50/number absorbs ~33% admin/billing margin once payment processing lands.

## Verification plan

1. Paste revised `009_phone_book.sql` in Supabase SQL Editor — `select slug, name, monthly_minutes, monthly_quote_limit, included_numbers, recording_retention_days, monthly_cost from public.plans order by sort_order` returns exactly three rows (Basic, Pro, Max).
2. Open Phone Book tab as a test agent → plan card shows current plan with two progress bars + numbers count + retention line.
3. Open Upgrade Plan modal → three rows, each showing minutes / quotes / included-numbers triplet.
4. Switch to Max → reload tab → `agents.monthly_minute_limit` is 10000 and `agents.monthly_quote_limit` is 10000 (SQL check).
5. With agent on Basic (1 included DID) and 0 numbers owned, Buy Number modal shows "Included with your plan" in the confirm.
6. Same agent, after buying 1 number: Buy modal now shows "$1.50/mo" in the confirm.

## Implementation order

1. Edit `data/sql/009_phone_book.sql` per the schema section.
2. Edit `pbApplyPlanChange()`, `pbRenderUpgradeOptions()`, `pbRenderPlanCard()`, `pbConfirmBuy()`, and `renderPhoneBook()` per the code-changes section.
3. Manual paste + manual smoke test (no automated test suite exists for this surface yet).
4. Update `[[project_phone_book]]` memory.

Implementation plan to follow as a separate document.
