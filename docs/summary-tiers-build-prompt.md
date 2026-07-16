# Build Prompt: Tiered Summary Pages (Basic / Pro / Team Leader) — "Ledger" style

Copy everything below into Claude Code as the task prompt.

---

You are working in the PolicyPilot / ProducerStack repo. Read `CLAUDE.md` first and follow it. The runtime source of truth is `app.html`.

## Context & design philosophy

Agents live in this tool 6+ hours a day tracking policies, commissions, chargebacks, and leads across multiple carriers (Mutual of Omaha, Transamerica, Corebridge, Americo). It's an operational workhorse, not a marketing page. **Data density matters more than visual delight.** Reference points: Attio, Linear, Ramp, Retool — left-aligned, tight vertical rhythm, 13px body text in-app, tables that look like real tables with visible row separators. Think a bank's internal tooling, not a startup landing page.

The visual direction is already chosen: **"Ledger" (2a)** — warm-gray neutrals, Spline Sans + Spline Sans Mono, blue as accent only. The full token spec is at the end of this prompt and is the single source of truth for fonts, colors, spacing, radius, shadows, pills, sidebar, tables, chips, buttons, charts, and feed rows. Where the spec and any existing `--ds-*` styling in `app.html` conflict, the Ledger spec wins on the Summary pages. Do not invent a new direction.

### Hard design constraints — never do any of these

- Blue (#5B94E8 badges/mark, #3A73C9 interactive, #2A5599 hover) is an **accent only** — links, active nav state, focus rings, one chart series, primary button. Never a hero background, never a gradient, never filling more than ~5% of any screen.
- No purple/blue gradients, no glassmorphism, no backdrop-blur
- No emoji as icons — SVG only, single stroke weight (1.5, matching the sidebar spec)
- One border radius across the whole system: 6px (per spec)
- No large rounded pill buttons
- No centered hero sections
- No uniform 3-column icon-title-body feature grids
- Layered subtle shadows only (use the spec's sm/md/frame definitions), never a generic drop shadow
- Two typefaces max: Spline Sans + Spline Sans Mono. Don't introduce others, don't fall back to Inter.

## Goal

Replace the single Summary page with three tier-gated versions of the same page, resolved from the agent's plan tier (`basic` / `pro` / `leader` — see the existing tier-resolution logic around `currentAgentIsAdmin` / plan-name matching near line ~12180 in `app.html`, and the gating pattern already used by `renderSummary()` widgets):

1. **Basic Summary** (all plans) — the essentials only.
2. **Pro Summary** (pro + leader) — everything analytic.
3. **Team Summary** (leader only) — everything in Pro, plus a team section showing each downline agent's basic production and calling stats alongside the leader's own personal stats.

## Hard data constraints

- **No email-parsing content anywhere on any summary page.** Do not surface `parsed_events`, `commission_events`, `portal_nudges`, `review_queue`, or the Carrier Mail urgency feed (`cmRefreshUrgent`) on the Summary section. The email pipeline exists but is not ready; leave it entirely out of Summary. All metrics must derive from user-entered policies (`ff_policies` / Supabase `policies`), leads (`pp_leads` / `leads`), activities (`ds_activities`), the dialer `calls` table, and static reference data (`COMP`, `CARRIER_BONUSES`, `conversion-rules.json`).
- **Never invent bonus tier numbers.** Follow existing rules: `portal_only` / empty-`tiers` programs get no numeric projections; all payouts display with an "est." prefix.
- Reuse existing computed functions where they exist (`inForceAP`, `netCommission`, `getChargebackExposure`, `renewalProjection12mo`, `persistency13mo/25mo`, `freeLookWatch`, `productMix`, `carrierConcentration`, `pipelinePartition`, `streakStats`, `computeBonusSnapshots`). Do not fork parallel implementations.
- Locked widgets (lower tiers) render as upgrade teasers: the card frame in Ledger style with content blurred/faded, an 11px UPPERCASE label ("PRO" / "TEAM LEADER") as a #5B94E8-family badge, and a primary button (#3A73C9) upgrade CTA. No gradients or glass effects on the teaser overlay.

## Time periods

Every summary page gets a period toggle: **Daily / Weekly / Monthly** (default Monthly, persisted in `pp_summary_period` — extend the existing `summaryPeriodRange` helper rather than replacing it). Render the toggle as Ledger filter chips (white bg, #E4E0DA border; active: border #B8CCEE, text #3A73C9).

- Daily = today (local midnight → now)
- Weekly = current week (Mon–Sun to now)
- Monthly = current calendar month to now

Every metric recomputes against the selected period. Point-in-time metrics (in-force AP, persistency, chargeback exposure, bonus progress) are labeled with a small "book-wide" caption (10.5px, #B0A99C) and do not change with the toggle.

## Calling stats (ALL plans, including Basic)

Add a **Calling Stats card** to every tier for the selected period:

- **Total dials** — count of dial events. Source of truth: the dialer `calls` table (rows for the agent within the period). Fall back to / union with `ds_activities` entries of type `dial` for manually logged dials, de-duplicating where a call row and activity refer to the same event. Use the answered semantics already in the call-history code (~line 18660: `status === 'completed' && duration_sec >= 5`).
- **Call time** — sum of `duration_sec` over the agent's calls in the period, formatted with the existing `_pbFmtDur` helper (`Xh Ym`), rendered in Spline Sans Mono.
- **Contacts** — answered calls (completed, ≥5s).
- **Call-to-close ratio** — total dials ÷ number of sales in the period. A "sale" = a policy with `dateSubmitted` (or `draft` if missing) inside the period, excluding `lapsed`/`chargeback`. Display as "1 sale per N dials" (e.g., 87:1). If sales = 0, show "—" with a caption "no sales yet this period"; never divide by zero.

Values use the KPI treatment: 22px/600 mono, labels 10.5–11px UPPERCASE #948C7F.

## Tier contents

### Basic Summary (all plans)

- Period toggle (D/W/M chips)
- Calling Stats card (above)
- KPI row (4-col grid, gap 14px, card padding 13px 16px): policies written (count), total AP submitted, est. commission (AP × comm% × 0.75, existing modal math), avg premium — all for the period, values in mono
- Status breakdown bar (existing `SUM_STATUSES` pending/approved/issued/paid/lapsed, click-through to tracker) using the Ledger status-pill palette: Pending UW #8A6116/#F6EDD8, Issued–Not Paid #2A5599/#E7EFFB, Active #1B7A43/#E4F2E9, Lapse Pending #A34E0C/#FBEBDD, Chargeback #B3261E/#FAE8E7, Declined #5A6472/#ECEEF1
- Smart Goal Hub ring — monthly AP goal vs actual
- Top 3 carriers by AP for the period (text list, mono amounts)
- Everything else renders as locked upgrade teasers

### Pro Summary (pro + leader) — Basic plus:

- Carrier mix donut (rework `_renderCarrierDonut` visuals to Ledger: one blue series — segments in the #5B94E8 family, active #3A73C9; remaining segments in neutral grays, not a rainbow)
- Pipeline Funnel with placement %
- Income Reality: net commission (earned − exposed), chargeback exposure, 12-mo renewal projection, in-force AP — negative amounts in #B3261E
- **Chargeback earn-down timeline** (new): month-by-month bar chart of at-risk advance $ clearing over the 9-month window, from `getChargebackExposure().atRiskPolicies` — finish the earn-down schedule stub. Bars #5B94E8, current month #3A73C9, radius 3px 3px 0 0, axis labels 10px mono #948C7F
- Persistency Health rings (13/25-mo)
- Activity Momentum funnel + streaks + achievements
- Bonus Tier Intelligence + Upcoming Bonuses, plus a **"nearest tier" callout** (new): for each active program, gap to next tier and days left in period, sorted by smallest gap — e.g., "est. $500 — $2,400 AP to go by Aug 31"
- **Lead-source ROI table** (new): per `leadSource` — leads, sales (via `soldLeadId` linkage), conversion %, total AP, est. commission. Ledger table treatment: header 34px #FAF8F5 with UPPERCASE 10.5–11px #948C7F columns, rows 38px with visible #F0EDE7 dividers, hover #FAF8F5, amounts mono
- **Cycle-time card** (new): avg days submitted→issued and issued→paid, per carrier, flagging the slowest
- **Free-look watchlist** (new): surface `freeLookWatch()` — policies in the 30-day window with days remaining, as Ledger feed rows (9px 0 padding, 8px status dot, title 12.5/500, meta 11.5 #948C7F, time 10.5 #B0A99C)
- **Dial efficiency** (new): est. $ per dial and per contact (period est. commission ÷ dials / contacts)
- Product mix + concentration alerts (`productMix`, `carrierConcentration`; warning state when top carrier > 60% of in-force AP)
- Term Conversion Radar summary: count + AP of policies with `conversionDeadline` within 90 days

### Team Summary (leader only) — Pro plus a Team section:

Team = agents sharing the leader's `agency_code` (see `agents.agency_code`, `process_agency_code_join`). The leader's own row appears first, marked "You".

**Per-agent data is intentionally basic — nothing more than this:**

| Agent | AP (period) | Sales (period) | Total dials | Call time | Call-to-close |
|---|---|---|---|---|---|

- AP = sum of policy AP submitted in the period; Sales = policy count (same definition as the ratio's denominator)
- Dials / call time / call-to-close computed identically to the personal card
- Ledger table styling (as above); sortable by any column; totals row at the bottom (team aggregate + team-wide call-to-close); amounts/durations in mono
- Do NOT expose downline agents' client names, policy details, commission amounts, comp levels, or book contents — production and calling totals only

**Access:** current RLS is per-agent, so the leader's browser cannot query downline `policies`/`calls` directly. Create a Supabase migration adding a `security definer` RPC (e.g., `get_team_summary(p_start timestamptz, p_end timestamptz)`) that verifies the caller is a leader for their `agency_code`, then returns only the aggregated per-agent rows above — never raw policy or call rows. Follow the migration style in `supabase/migrations/` and `data/sql/`.

Also add a small "Team vs You" strip: your AP / dials / call-to-close side by side with the team average for the period.

## Implementation notes

- Keep it all in `app.html` (single-file pattern) plus the one SQL migration. Extend `renderSummary()` with a tier switch rather than three copied render trees; compose from shared widget functions.
- Scope the Ledger styles to the Summary section (e.g., a `.ledger` root class with its own CSS variables) so the rest of the app is untouched; load Spline Sans + Spline Sans Mono from Google Fonts.
- All icons: inline SVG, 18×18, stroke 1.5, currentColor — consistent with the sidebar spec. No emoji, no icon fonts.
- Loading states: skeleton cards while the team RPC and calls queries resolve; page must render personal stats without waiting on team data.
- Empty states for new agents (no calls, no policies) on every card — plain text in caption colors, no illustration blocks.
- Period math must use the agent's local timezone consistently (same convention as `streakStats`).

## Verification

- Fixture-test period boundaries (policy at 11:59pm Sunday counts in that week, etc.) and the call-to-close zero-sales case.
- Verify a `basic`-tier account sees teasers not data for Pro widgets; a `pro` account sees no Team section; a non-leader can't get data from the team RPC (test the RPC's authorization directly).
- Confirm nothing on any Summary tier reads from `parsed_events`, `commission_events`, `portal_nudges`, `email_ingest_log`, or calls `cmRefreshUrgent`.
- Visually diff against the style spec below: font sizes, pill colors, table row heights, chip states, and shadows must match exactly. Then audit against the hard design constraints (no gradients/glass/pills/emoji, single 6px radius, blue ≤ ~5% of any screen).

---

## STYLE SPEC — ProducerStack "Ledger" (2a)

### Fonts

- UI: 'Spline Sans' (400/500/600), Google Fonts
- Money / policy #s / dates / timestamps: 'Spline Sans Mono' (400–600)
- Sizes: 10.5, 11, 11.5, 12, 12.5, 13, 15, 18, 22px · line-height 1.45
- Body & table cells 13px · KPI value 22px/600 mono · page title 15px/600
- Section titles 13px/600 · labels/column headers 10.5–11px UPPERCASE, letter-spacing .06–.08em, weight 600, color #948C7F

### Colors

- Page canvas #F5F3F0 (warm gray) · cards #FFFFFF
- Table header + row hover #FAF8F5
- Borders: frame #D8D3CA · cards/controls #E4E0DA · row dividers #F0EDE7
- Text: primary #0F1D3D · secondary #3B372F · muted mono #6B6459 · captions #948C7F · faint #B0A99C
- Blue (accent only): mark/badges #5B94E8 · interactive #3A73C9 · hover #2A5599
- Green #1B7A43 · red #B3261E (negative amounts too)

### Status pills (11px/600, padding 2px 8px, radius 6px)

- Active: #1B7A43 on #E4F2E9 · Pending UW: #8A6116 on #F6EDD8
- Issued–Not Paid: #2A5599 on #E7EFFB · Lapse Pending: #A34E0C on #FBEBDD
- Chargeback: #B3261E on #FAE8E7 · Declined: #5A6472 on #ECEEF1
- Dots (feed): #2E9E5B, #C9971F, #5B94E8, #D97B2A, #D2483F, #98A1AE
- Chargeback row highlight bg: #FCF1F0

### Sidebar rail (cool-tinted, hover-expand)

- 68px collapsed → 232px on hover · transition width .18s ease
- bg #EEF2FB · border-right 1px solid #DFE6F3 · padding 12px 10px
- Items 36px tall, radius 6px, 3px gap · 18×18 icons, stroke 1.5, currentColor
- Idle #4C5568 · active: bg #DCE7F8, icon #3A73C9, label #0F1D3D/600
- Labels 13px/500, hidden collapsed · dividers #DFE6F3 · Sign out #8A93A6
- Nav: Summary, Quote + Underwriting, Policy Tracker, Carrier Mail, Bonus Tracker, Leads, Calendar, Phone Book, Web Dialer, Agency · footer: Support, Settings, Sign out

### Space / radius / shadow

- Spacing scale 4 · 8 · 12 · 16 · 24 · 32
- Radius: 6px everywhere (single radius)
- Shadow sm: 0 1px 2px rgba(15,29,61,.05)
- Shadow md: sm + 0 4px 12px rgba(15,29,61,.05)
- Frame: 0 1px 2px rgba(15,29,61,.06), 0 8px 24px rgba(15,29,61,.06)

### Layout

- Canvas 1440px · topbar 50px white, border-bottom #E4E0DA, padding 0 24px
- Avatar 26×26, bg #0F1D3D, radius 6 · content padding 20px 24px, gaps 16px
- KPI: 4-col grid, gap 14px, card padding 13px 16px
- Table: header 34px on #FAF8F5 · rows 38px, padding 0 16px, col-gap 12px, hover #FAF8F5
- Filter chips: padding 6px 10px, 12.5px/500, white bg, #E4E0DA border; active chip border #B8CCEE + text #3A73C9
- Primary button: #3A73C9 → hover #2A5599, white, 12.5px/600, padding 7px 12px
- Chart bars #5B94E8 (current #3A73C9), radius 3px 3px 0 0, axis labels 10px mono #948C7F
- Feed rows: 9px 0 padding, divider #F0EDE7, 8px dot, title 12.5/500, meta 11.5 #948C7F, amount 12/600 mono, time 10.5 #B0A99C
