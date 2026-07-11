# Prompt: Bake real carrier bonus data into the ProducerStack Bonus Tracker

Copy everything below the line into Claude Code (or your coding agent) from the repo root.

---

## Task

Make the Bonus Tracker fully functional using the real carrier bonus data in `data/carrier_bonuses.json` (researched July 2026, carrier-official programs only — no IMO bonuses). Replace the hardcoded bonus structures (`AM_MS`, `AM_AM_*` tier logic) with a data-driven engine that works for any carrier in the file. Follow the existing conventions in this codebase: single-file `index.html`, vanilla JS, and the mirror pattern used for `data/compensation-table.json` ↔ the `COMP` const (keep a `CARRIER_BONUSES` const in `index.html` in sync with the JSON, same as `COMP`).

## Data source & schema

`data/carrier_bonuses.json` → `carriers[]`, each entry:

- `id`, `carrier`, `program`, `sponsor`
- `bonus_type`: `cash_percent` | `cash_flat` | `per_policy` | `lead_credit` | `trip` | `none_public` | `portal_only`
- `basis`: `annualized_premium` | `policy_count` | others
- `tiers[]`: `{ threshold, threshold_label, payout }` — `threshold` is numeric ($ AP or policy count depending on `basis`)
- `period` (free text describing the qualification window), `requirements`, `status`, `confidence`, `source`, `source_date`, `notes`

`status` values: `active_2026`, `last_documented`, `period_ended_*`, `portal_only`, `possibly_outdated`, `expired`, `discontinued`, `none_found`.

## Carrier ID mapping

Map CRM policy records to bonus entries. The CRM's product keys use these prefixes (see `COMP` in `index.html`):

| Product key prefix | carrier_bonuses id |
|---|---|
| `americo_` | `americo` |
| `aa_` (American Amicable) | `american_amicable` |
| `mutual_` | `mutual_of_omaha` |
| `trans_` | `transamerica` |
| `core_` | `corebridge` |
| `ethos_` | `ethos` |
| `foresters_` | `foresters` |
| `aetna_` | `aetna_accendo` |
| `aflac_` | `aflac` |
| `ahl_` | `american_home_life` |
| `baltimore_` | `baltimore_life` |
| `elco_` | `elco_mutual` |
| `uhl_` | `uhl` |
| `sbli_` | `sbli` |
| `gtl_` | `gtl` |
| `kcl_` (Kansas City Life) | *(no bonus entry — show "no known bonus")* |

Any carrier without a bonus entry, or with `status` of `none_found`/`discontinued`, renders a quiet "No active bonus program" state and is excluded from progress bars and recommendations.

## Feature 1 — Agent settings: contracted carriers

Add a "My Carriers" selector (settings or bonuses tab): checkboxes over all carriers in `CARRIER_BONUSES`, persisted in the existing storage layer. Default selection: `americo`, `mutual_of_omaha`, `transamerica`, `ethos`, `corebridge`, `american_amicable`. Only selected carriers appear in the tracker, progress bars, and recommendations.

## Feature 2 — Period engine

Each program accrues production inside its current qualification window. Implement `currentWindow(bonus, today)` returning `{start, end}` or `null`:

- **Monthly** (Am-Am Bonus Bucks, SNL, Trinity): calendar month, resets on the 1st.
- **Calendar quarter** (MoO 4 Quarters Club, Corebridge SIWL, American Home Life, Foresters): Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec.
- **Fixed dates** (Americo UFirst: 2025-12-01 → 2026-05-29): if today is past `end`, the program is in a **"window closed"** state — show "Qualification period ended MM/DD — watch for the next program" instead of a bar, and exclude from recommendations until data is updated.
- **Calendar year** (trip programs): Jan 1 – Dec 31.

Parse the window from the `period` field once and store it as structured config inside `CARRIER_BONUSES` (add `window: {type: 'monthly'|'quarterly'|'fixed'|'annual', start?, end?}` to each entry when you build the const — do this by hand per carrier, don't regex the free text at runtime).

## Feature 3 — Progress computation

For each selected carrier's active program:

- `basis: annualized_premium` → progress = sum of issued/paid AP for that carrier's policies within the window (use the existing policy AP fields the dashboard already tracks).
- `basis: policy_count` (Corebridge) → progress = count of paid SIWL policies in the window. **Corebridge counts SimpliNow Legacy SIWL only — exclude GIWL products (`core_giwl`).**

Payout math per `bonus_type` — these differ, get them right:

- **Cliff percent** (Americo, MoO): once threshold reached, payout = pct × **total** window AP (not marginal). E.g. MoO: ≥$25,000 quarter ANBP → 10% of the whole quarter's ANBP; 12% variant shown as a secondary "with >95% 3-mo persistency" line.
- **Banded flat, not cumulative** (Am-Am): highest band only — $7.5k–10k→$50, $10k–20k→$75, $20k+→$100 per month.
- **Cumulative ladder** (Corebridge): each policy-count tier adds cash; show cumulative earned so far and next rung.
- **Banded percent** (American Home Life 5–10%): payout = band pct × quarterly AP.
- **lead_credit** (Trinity, SNL, Oxford): same math, label the payout "lead credit" not cash.
- **trip**: progress bar toward the credit threshold, payout label = trip name, no $ value.
- **portal_only** / empty tiers (Ethos, Gerber…): render an info card "Program exists — tiers are on the carrier portal" with the source link; no bar, no recommendation.

## Feature 4 — Bonuses tab UI (progress bars)

For each selected carrier, a card with:

- Carrier + program name, status badge (`active_2026` green "Verified 2026" · `last_documented` amber "Unverified — check portal" · `period_ended` gray).
- One progress bar per tier (or one bar with tier markers along it): current value vs threshold, `$X of $Y` (or `N of M policies`), % filled, days left in the window.
- Reached tiers: bar full, checkmark, "Unlocked — est. $Z" (or the flat amount).
- Requirements (persistency, placement, exclusions) as small caveat text on the card — display only, do not model.
- Source link + `source_date` in the card footer.
- All estimated payouts labeled "est." — bonuses are subject to carrier quality metrics.

## Feature 5 — "Upcoming bonuses" tracker

A widget (top of bonuses tab + compact version on Summary) showing:

- **Count badge**: number of tiers currently reached-but-unpaid across all selected carriers ("Upcoming bonuses: 3").
- Line items: carrier, program, est. $ amount, expected payout timing derived from the window (e.g. "paid ~month after quarter end" for MoO/Corebridge — use `period`/`requirements` text).
- Sum line: "Total est. incoming: $X,XXX".

## Feature 6 — Summary tab nudge ("next best carrier")

Extend `renderBonusTierIntel` / the Bonus Tier Intelligence card:

1. For each selected carrier with an active window, compute `gap` = next unreached threshold − current progress, and `unlockValue` = the est. $ (or incremental $) unlocked at that threshold.
2. Rank by best return: primarily smallest gap-to-dollar ratio (`gap / unlockValue`), tie-break by smallest absolute gap. Exclude trips from ranking $ math but mention if one is very close (>90%).
3. Render one primary nudge sentence, e.g.:
   > "You're only **$1,850** away from **Mutual of Omaha's 4 Quarters Club** — crossing $25,000 this quarter unlocks an est. **$2,500+ (10% of your quarterly AP)**. Consider writing your next policy with them."
   For policy-count programs: "2 more Corebridge SIWL policies unlock **$500**."
4. Below it, 2–3 secondary one-liners for the next-closest opportunities.
5. If nothing is close (<40% to every next tier), show the closest one framed as a pace target instead.

## Guardrails

- Never invent tier numbers not present in the JSON. `portal_only`/empty-tier carriers get no numeric projections.
- Every displayed amount is an estimate; keep the "est." prefix and a single footnote: "Bonuses subject to carrier persistency/quality requirements — verify on carrier portal."
- Corebridge tiers change quarterly — structure the const so a quarter's tiers are one swappable block.
- Keep `data/carrier_bonuses.json` and the `CARRIER_BONUSES` const in sync (note it in a comment, same as `COMP`).
- Don't touch the commission math (`COMP`) — bonuses are separate from contract-level commissions.

## Verify

- Unit-check the four payout shapes with fixture policies: Am-Am month at $9k → $50 (not $125); MoO quarter at $24,999 → $0, at $25,001 → 10% of $25,001; Corebridge 12 SIWL policies in Q3 → $500 earned, next rung visible; Americo (window closed) → no bar, "period ended" state.
- Archive `index.html` to `archive/` before editing, per repo convention.
