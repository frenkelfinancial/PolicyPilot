# Dashboard Redesign — Phase 3 (Income Reality Row) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Show the **full income picture** — gross writing ≠ take-home. Three-card row replacing the bottom KPI strip: **Net Commission Forecast**, **Chargeback Exposure**, **Renewal/As-Earned Forecast**.

**Architecture:** Replace the existing `.kpi-grid` (4 KPI tiles: AP Written / Adv Comm Paid / Projected Bonus / Active Policies) with a new `.ir-row` containing three `dsStatCard` instances. Each card has a hero number, a small inline viz, and a trend badge. Net commission stacks earned vs. exposed in a horizontal bar. Chargeback exposure inline mini-area chart of the 12-month earn-down. Renewal forecast a simple line projection of in-force AP × commission %.

**Tech Stack:** Same as Phase 0. Inline SVG charts (no chart library). Pure derivation from `policies` + `getChargebackExposure()` from Phase 0.

**Spec:** §3.

**Out of scope:**
- Real per-carrier chargeback schedules (Phase 0 uses naive 9-month window; Phase 3 reuses that until the agent enters real advance % per carrier).
- Renewal commission percentages per carrier (uses a single configurable `RENEWAL_PCT` constant).
- A 24-month forward forecast (v1 ships 12 months).

**Cross-cutting:**
- **Existing KPI tiles are DELETED.** Phase 3 is the destructive cleanup of `.kpi-grid` and `.kpi-card` classes. The data they showed is absorbed elsewhere (AP Written → Smart Goal Hub center; Adv Comm Paid → Net Commission; Projected Bonus → Phase 6 Bonus ladder; Active Policies → Phase 4 Book Composition).
- **Net commission math:** `advanced_paid − chargeback_exposure_at_risk`. Adv-paid = sum `policies.where(status=paid).advComm`. Exposure = `getChargebackExposure().totalAdvanced`.
- **Renewal forecast:** assumes static in-force AP × `RENEWAL_PCT` × 12 months. Line shows the build-up over time.

---

## File Structure

| Region | Where | What |
|---|---|---|
| `<style>` primitives | Before AUTH GATE | `/* ---- INCOME REALITY ---- */` block |
| `<script>` helpers | After Phase 1.1 helpers | `netCommission`, `inForceAP`, `renewalProjection12mo` |
| `<script>` renderer | After helpers | `renderIncomeReality` |
| HTML body — `.kpi-grid` | `grep -n 'class="kpi-grid"'` | Replace with `<div class="ir-row" id="income-reality">…</div>` |
| `<script>` `renderSummary` | Delete the four `_animateNumber`/`_renderSparkline`/`_renderDelta` calls feeding the old KPI tiles | Replace with `renderIncomeReality()` |
| `<script>` cleanup | Remove `.kpi-*` CSS rules superseded by `dsStatCard` (optional, scoped to a follow-up cleanup) | Out of scope for Phase 3 — leave the old CSS alongside until referenced elsewhere |

---

## Task 1: Snapshot

- [ ] `cp index-3.html archive/index-2026-05-12-pre-income-reality.html`

---

## Task 2: Add helpers

**Insert after** Phase 1.1 helpers:

```js
// ============================================================
// INCOME REALITY — added 2026-05-12 (Phase 3)
// ============================================================
const RENEWAL_PCT = 0.05;          // 5% as-earned commission on in-force AP (carrier-tunable later)

function inForceAP(pols){
  const active = new Set(['issued', 'placed', 'paid']);
  return (pols || []).filter(p => active.has(p.status)).reduce((s,p) => s + (Number(p.ap) || 0), 0);
}

function netCommission(pols){
  const paidComm = (pols || []).filter(p => p.status === 'paid').reduce((s,p) => s + (Number(p.advComm) || 0), 0);
  const exposure = (typeof getChargebackExposure === 'function') ? getChargebackExposure().totalAdvanced : 0;
  return { earned: paidComm, exposed: exposure, net: paidComm - exposure };
}

/** 12-point series projecting cumulative as-earned commission over the next 12 months. */
function renewalProjection12mo(pols){
  const ap = inForceAP(pols);
  const monthly = (ap * RENEWAL_PCT) / 12;
  const series = [];
  let cum = 0;
  for (let i = 0; i < 12; i++){ cum += monthly; series.push(Math.round(cum)); }
  return series;
}
```

---

## Task 3: Add CSS

```css
/* INCOME REALITY — Phase 3 */
.ir-row{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--ds-space-4);margin-bottom:var(--ds-space-5)}
@media (max-width:1100px){.ir-row{grid-template-columns:1fr}}

.ir-stack-bar{display:flex;width:100%;height:10px;border-radius:var(--ds-radius-pill);overflow:hidden;background:var(--bg2);margin-top:var(--ds-space-3)}
.ir-stack-bar__earned  {background:var(--ds-color-success);transition:width var(--ds-duration-slow) var(--ds-ease-out)}
.ir-stack-bar__exposed {background:var(--ds-color-danger);transition:width var(--ds-duration-slow) var(--ds-ease-out)}
.ir-stack-legend{display:flex;justify-content:space-between;font:11px/14px var(--mono);color:var(--text3);margin-top:6px;font-variant-numeric:tabular-nums}
.ir-stack-legend .ok   {color:var(--ds-color-success)}
.ir-stack-legend .bad  {color:var(--ds-color-danger)}
```

---

## Task 4: Renderer

```js
function renderIncomeReality(){
  const root = document.getElementById('income-reality');
  if (!root) return;
  const pols = Array.isArray(window.policies) ? window.policies : [];
  const { earned, exposed, net } = netCommission(pols);
  const cb = (typeof getChargebackExposure === 'function') ? getChargebackExposure() : { totalAdvanced:0, atRiskPolicies:[] };
  const renewalSeries = renewalProjection12mo(pols);
  const inForce = inForceAP(pols);
  const totalForBar = Math.max(1, earned + exposed);

  root.replaceChildren();

  // Card 1 — Net Commission Forecast
  const card1 = dsStatCard({
    label: 'Net Commission · This Month',
    hero: '$' + net.toLocaleString(),
    sub: 'Earned − Exposed',
    accent: net >= 0 ? 'success' : 'danger',
  });
  const stack = document.createElement('div');
  stack.className = 'ir-stack-bar';
  const seg1 = document.createElement('div'); seg1.className = 'ir-stack-bar__earned';   seg1.style.width = (earned / totalForBar * 100) + '%';
  const seg2 = document.createElement('div'); seg2.className = 'ir-stack-bar__exposed'; seg2.style.width = (exposed / totalForBar * 100) + '%';
  stack.appendChild(seg1); stack.appendChild(seg2);
  card1.appendChild(stack);
  const legend = document.createElement('div'); legend.className = 'ir-stack-legend';
  legend.innerHTML = `<span class="ok">Earned $${earned.toLocaleString()}</span><span class="bad">Exposed $${exposed.toLocaleString()}</span>`;
  card1.appendChild(legend);
  root.appendChild(card1);

  // Card 2 — Chargeback Exposure
  const card2 = dsStatCard({
    label: 'Chargeback Exposure',
    hero: '$' + (cb.totalAdvanced || 0).toLocaleString(),
    sub: cb.atRiskPolicies.length + ' polic' + (cb.atRiskPolicies.length === 1 ? 'y' : 'ies') + ' at risk',
    accent: cb.totalAdvanced > 0 ? 'warning' : 'success',
    sparkline: cb.earnDownSchedule.map(m => m.amount).slice(0, 12),  // empty in v1 → placeholder renders
  });
  if (cb.atRiskPolicies.length > 0){
    card2.style.cursor = 'pointer';
    card2.addEventListener('click', () => nav('tracker'));
  }
  root.appendChild(card2);

  // Card 3 — Renewal / As-Earned Forecast (12-month cumulative)
  const card3 = dsStatCard({
    label: 'Renewal Forecast · Next 12 mo',
    hero: '$' + (renewalSeries[11] || 0).toLocaleString(),
    sub: 'On $' + inForce.toLocaleString() + ' in-force AP',
    accent: 'momentum',
    sparkline: renewalSeries,
  });
  root.appendChild(card3);
}
```

---

## Task 5: Replace `.kpi-grid` markup with `.ir-row`

Find `<div class="kpi-grid">` and replace the whole block (through its closing `</div>`) with:

```html
      <!-- INCOME REALITY (Phase 3) -->
      <div class="ir-row" id="income-reality"></div>
```

Delete the old `_animateNumber`/`_renderDelta`/`_renderSparkline` calls in `renderSummary` for `sum-ap-hero`, `sum-paid-hero`, `sum-bonus-hero`, `sum-active-hero`, `sum-bonus-breakdown` (the IDs no longer exist).

Add `renderIncomeReality()` to `renderSummary` after `renderPipelineFunnel()`.

---

## Task 6: Snapshot + browser verify

- [ ] 3 cards render in a row at desktop, stack on mobile.
- [ ] Net commission card has stacked bar + legend.
- [ ] Snapshot.

---

## Task 7: Docs + memory

- [ ] `docs/architecture.md` — Phase 3 section noting that `.kpi-grid` is **gone**.
- [ ] `memory/project_income_reality.md` — explain math + `RENEWAL_PCT` location.
- [ ] `MEMORY.md` + vault log.

---

## Self-Review

| Vision §3 requirement | Where |
|---|---|
| Net Commission Forecast: advanced − exposure | Task 2 `netCommission` |
| Stacked bar earned vs. exposed | Task 4 `.ir-stack-bar` segments |
| Trend vs. last month | **Deferred** — needs historical commission snapshot; not in scope for v1. Document this in the memory file as a known gap. |
| Chargeback Exposure rolling 9-12 mo | Reuses Phase 0 `getChargebackExposure()` |
| Earn-down timeline mini chart | Task 4 sparkline (empty until real schedule data lands) |
| At-risk policies count with CTA | Task 4 card2 click → tracker |
| Renewal/As-Earned trailing income | Task 2 `inForceAP` |
| 12-month forward projection | Task 2 `renewalProjection12mo` |
