# Summary Page Restyle — Producer Stack + Pace & Forecast Milestones

**Date:** 2026-05-10
**Surface:** `index-3.html` → `#sec-summary`
**Goal:** Make the agent summary page feel like the rest of the dashboard, and replace the "cheap" bonus milestone visualization with one that actually promotes growth.

---

## 1. Why this redesign

The summary tab today is a self-contained dark "quest tracker" surface (`#06101F` + neon green/cyan/gold/magenta, animated glow blobs, gradient bars with glowing dots). The rest of the dashboard uses **Producer Stack** tokens (`#070d1a` background, pastel-blue `#8FC2F7` accent, DM Sans + DM Mono + Sora, light/dark toggle via `body.light`).

Two consequences:

- The summary doesn't respect the light/dark toggle the rest of the app honors.
- The bonus milestone card reads as decorative rather than informative — gradient fills with glowing pips don't tell the agent whether they're on track or what to do next.

---

## 2. Scope

**In scope (restyle in place):**

- Token-swap every rule under `.sum-v3 *` from the local `--sv-*` set to the shared `:root` Producer Stack tokens.
- Make the summary participate in the existing `body.light` overrides.
- Rebuild **one** section — Bonus Milestones — using the "Pace & Forecast" treatment.
- Restructure the hero band from one wide gradient panel into two Producer Stack cards (goal + scorecard meta on the left, streak + activity tiles on the right).

**Out of scope:**

- New summary sections, new data sources, or new DB columns.
- Adding bonus programs beyond the three that exist (Americo UFirst, Am-Am Bonus Bucks, FFL VP).
- Calculating bonus pace against the summary period chip — pace always uses the program-native window.
- Mobile-first redesign; the existing `@media (max-width: 1100px)` / `640px` breakpoints stay.

---

## 3. Section-by-section redesign

### 3.1 Hero band

**Today:** one wide panel with a `linear-gradient(135deg, #0A1A35 0%, #0F2D3D 45%, #16453D 100%)` background, two animated cyan/green blur blobs, a 240px goal ring with gradient stroke + glow filter, a streak strip with a pulsing flame, and two activity tiles.

**After:** two side-by-side Producer Stack `.card`s.

| Left card — Monthly Goal | Right card stack — Activity |
|---|---|
| 180px goal ring (solid `--accent` stroke, no gradient, no glow filter). Inside the ring: eyebrow "MONTHLY GOAL", number (Sora 800/28), "of $X" target line (DM Mono), percent + days-left chip (DM Mono, `--accent` color). | Streak card (smaller `.card`): "DAY STREAK" eyebrow, monochrome flame icon (`--a3`), Sora streak number, 14-day strip with `--a2` mint hit days and a `--accent` outline ring on "today". |
| Side-panel scorecard (3 rows): "Pace needed" ($/day to hit goal), "Avg this month" (actual $/day), "Projected month-end" (linear projection — colored `--a2` if ≥ goal, `--a4` if behind). All numbers DM Mono tabular. | 2-up activity tiles (`.card.act-tile`): "Policies this month" + "This week" with Sora 800/24 numbers. |

**Removed:** `.hero-glow*` blobs, `@keyframes hero-float`, the gradient hero background, `.streak-flame` radial glow + pulse animation, the `.goal-arc` `filter:url(#goalGlow)` blur.

### 3.2 Period chips

Container: `background: var(--bg2); border: 1px solid var(--border)`. Active chip: `background: var(--bg3); color: var(--text); box-shadow: 0 1px 0 rgba(255,255,255,.06) inset`. No glow.

### 3.3 KPI grid (4 cards)

Cards use the standard `.card` foundation. Drop:

- The full-width neon top `::before` glow.
- The colored hover halo (`box-shadow: 0 0 24px color-mix(...)`).
- The `text-shadow` on `.kpi-hero`.
- The `drop-shadow` filter on sparkline lines.

Add a **2px solid top accent border** per KPI:

| KPI | Accent token | Hex |
|---|---|---|
| AP Written | `--accent` | `#8FC2F7` |
| Adv Comm Paid | `--a2` | `#5CC9A7` |
| Projected Bonus | `--a3` | `#E0B884` |
| Active Policies | `--a5` | `#9FB7E8` |

Sparklines render in the same accent (`stroke`) with `.spark .fill` at `fill-opacity: .12`. Hero numbers use **Sora 800 / 28**. Delta chips: `.up` = `--a2`, `.down` = `--a4`, `.flat` = `--text3` on a neutral track.

### 3.4 Bonus Milestones — REBUILD (Pace & Forecast)

**Replace** the `.milestone-card` (current `.ms-bar` SVGs + `.ms-vp` block) with a `.pace-card` containing three `.pace-row` blocks. Each row is a `1.4fr / 1fr` grid: left = headline + forecast prose, right = projection bar + legend.

Per row:

```
[ Program name ]  [ window eyebrow ]  [ pace tag ]
[ Current credits · next tier · $gap to go ]
[ Forecast sentence — at pace you'll land at $X by Y ]

[ ▓▓▓░░░░░░░░░░░░  ]   ← filled = current, green tick = projection, white tick = cap
[ $cur today · $proj projected · $cap target ]
```

The per-tier payout dollar figure shown in the original mockup is deferred to v2 — it requires refactoring `projectAmerico` / `projectAmAm` to accept an override credit value, which is out of scope for this restyle. The "Projected Bonus" KPI card still shows the aggregate forward-looking payout (`projectFFL().pay + projectAmerico().bonus + projectAmAm().awardAmt`).

Per-program data:

| Program | Window | Tiers (label / val) | Bar cap | Pace logic |
|---|---|---|---|---|
| **Americo UFirst** | `AMERICO_WINDOW` constant (`{start:'2025-12-01', end:'2026-05-29'}`) | $20K / $35K / $55K / $75K / $100K (reuse existing `AM_MILESTONES`) | $100K (Platinum tier) | `projected = current * daysTotal / daysElapsed` against the Americo window. Pace tag = `on` if projected ≥ next tier, `behind` if projected < next tier, `ahead` if projected clears the tier after next. |
| **Am-Am Bonus Bucks** | Current calendar month (computed by `amAmWindow(today)`) | Silver $7.5K / Gold $10K / Platinum $20K (reuse existing `AMAM_MILESTONES`) | $20K (Platinum tier) | Same projection math against the month. |
| **FFL VP Track** | Not time-based | Start 80%, target 145% contract | 145% (VP threshold) | No pace tag — show **`flat` status tag** with current contract %. Forecast row: "Need +X% contract for VP eligibility" or "VP ELIGIBLE — keep persistency up". |

The right-most legend label on each bar is the program's cap (column 4 above). The middle legend ("projected") appears only when a pace tag is shown.

Pace tag classes: `.pace-tag.on` (mint), `.pace-tag.behind` (soft red), `.pace-tag.ahead` (pastel blue), `.pace-tag.flat` (muted grey).

**Insufficient data guard:** if `daysElapsed < 3` in a time-based program, show `.pace-tag.flat` with the text "Too early to project" and omit the forecast sentence — the projection bar's green tick is hidden.

Payout numbers:

- Americo "payout at next tier" reuses the same `projectAmerico()` logic but computes the *delta* from current tier to next tier rather than total.
- Am-Am "payout at next tier" same idea on `projectAmAm()`.
- FFL VP shows no $ payout figure in this row — promotion is unlocked, not paid.

### 3.5 Mid row — Status bar + Carrier donut

Status segment colors switch to Producer Stack semantic tokens:

| Status | Token | Hex |
|---|---|---|
| Pending | `--a3` | `#E0B884` |
| Approved | `--a5` | `#9FB7E8` |
| Issued | `--a2` | `#5CC9A7` |
| Paid | `--accent` | `#8FC2F7` |
| Lapsed | `--a4` | `#E07B7B` |

Donut uses the same palette in carrier order. Drop the `drop-shadow(0 0 12px rgba(52,211,153,.18))` filter. Legend chips: `background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.05)`; `body.light` override flips both.

### 3.6 Drafts strip

Token-swap only. Hover row background = `rgba(143,194,247,.04)` to match the policy tracker table elsewhere.

---

## 4. Code-level plan

### 4.1 CSS (`index-3.html` lines ~582–762)

- Delete the local `--sv-*` token declaration on `.sum-v3`.
- Rewrite every rule under `.sum-v3 *` to read from the shared `:root` tokens.
- Remove the `min-height:calc(100vh - 80px)` and the negative margin trick — the page should breathe like other sections.
- Add `body.light` overrides for any spot that uses `rgba(255,255,255,*)` overlays; `body.light .sum-v3 …` mirrors should use `rgba(11,31,58,*)` (navy-on-ivory) at the same opacity.
- Animations: keep one subtle `opacity 0 → 1` fade-in on the period change. Drop `hero-float`, `flame-pulse`, `spark-draw`, and the `goal-arc` ease-out tween.
- Keep `@media (prefers-reduced-motion: reduce)` block (now smaller — just disables the fade and any transitions).

### 4.2 HTML (`index-3.html` lines ~946–1114)

- Hero block: split into two `.card`s in a `display:grid; grid-template-columns: 1fr 1.2fr` wrapper. Preserve element IDs (`goal-arc`, `goal-num`, `goal-target`, `goal-meta`, `streak-num`, `streak-strip`, `act-month`, `act-week`).
- Add three new IDs in the goal scorecard: `goal-pace-needed`, `goal-avg-day`, `goal-projected`.
- Period row + KPI grid: structural HTML unchanged; only class names and `data-*` are touched.
- `.milestone-card` block: replace entirely with `.pace-card` containing three rows. New IDs:
  - `pace-am-tag`, `pace-am-sub`, `pace-am-forecast`, `pace-am-bar-cur`, `pace-am-bar-proj`, `pace-am-legend-cur`, `pace-am-legend-proj`, `pace-am-legend-cap`
  - Same pattern with prefix `pace-amam-` and `pace-vp-`.

### 4.3 JS (`index-3.html`)

- **Delete** `renderMilestoneBar()` and `renderVPTrack()`.
- **Add** near the existing milestone constants. The codebase already formats dates as `YYYY-MM-DD` via `toISOString().split('T')[0]` inline (e.g. lines 3432, 3559) — reuse that pattern, don't introduce a separate helper.

  ```js
  const AMERICO_WINDOW = { start: '2025-12-01', end: '2026-05-29' };
  // REFRESH: when the next UFirst contest is announced (post May 29 2026).
  function amAmWindow(today = new Date()) {
    const s = new Date(today.getFullYear(), today.getMonth(), 1);
    const e = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return {
      start: s.toISOString().split('T')[0],
      end:   e.toISOString().split('T')[0],
    };
  }
  function pacePosition(current, window, today = new Date()) {
    const start = new Date(window.start + 'T00:00:00');
    const end   = new Date(window.end   + 'T23:59:59');
    const daysTotal   = Math.max(1, Math.round((end - start) / 86400000));
    const daysElapsed = Math.max(0, Math.min(daysTotal,
      Math.round((today - start) / 86400000)));
    const projected = daysElapsed >= 1
      ? current * (daysTotal / daysElapsed)
      : 0;
    return { daysElapsed, daysTotal, projected };
  }
  function paceTagFor(projected, nextTier, tierAfterNext) {
    if (projected >= (tierAfterNext || Infinity)) return 'ahead';
    if (projected >= nextTier) return 'on';
    return 'behind';
  }
  ```

- **Add** `renderPaceRow(prefix, opts)` that writes to the new IDs. Opts: `{ tag, tagText, sub, forecast, curPct, projPct, legendCur, legendProj, legendCap }`.
- **Add** `renderGoalScorecard(currentMonthAP, goal, daysLeft)` that writes `goal-pace-needed`, `goal-avg-day`, `goal-projected`.
- **Modify** `renderSummary()` to:
  - Call `renderGoalScorecard(...)` after `renderGoalRing(...)`.
  - Replace the three `renderMilestoneBar` / `renderVPTrack` calls with three `renderPaceRow` calls driven by `pacePosition()` and the relevant `_sumKey` totals computed against `AMERICO_WINDOW` and `amAmWindow()` — **not** against `range` (the period chip).

---

## 5. Acceptance criteria

1. Toggling `body.light` re-paints the summary page like every other section — no hard-coded dark hex values bleed through.
2. No `--sv-*` custom property remains. No neon glow filters (`drop-shadow`, `text-shadow`, `filter:blur`) remain on resting elements.
3. The bonus milestone card shows pace data computed from the program-native window for Americo and Am-Am, and a contract-status row for FFL.
4. Existing wiring still works: clicking a KPI card drills to tracker, clicking the goal ring opens the goal editor, clicking a draft row opens that policy, period chips update the page and persist via `localStorage`.
5. With `prefers-reduced-motion: reduce`, no animations fire on first render or on period change.

---

## 6. Risks

- **AMERICO_WINDOW is hard-coded.** After May 29 2026 the constant must be refreshed (and probably moved to `shared/data.js` if the contest cycles). Mitigation: add a `// REFRESH:` comment next to the constant naming the next expected update date.
- **"Behind pace" tone.** Could feel demotivating. Mitigation: gate the tag behind a 3-day minimum, and pair it with an actionable forecast sentence ("Need $X/wk for the last N weeks to clear Gold") rather than a bare verdict.
- **Light-mode coverage.** Producer Stack's `body.light` overrides are scattered. We need to mirror every new dark-mode rule we add. Acceptance criterion #1 enforces this — fail loudly if a token leaks.
