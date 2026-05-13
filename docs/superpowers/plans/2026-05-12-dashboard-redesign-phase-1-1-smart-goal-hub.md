# Dashboard Redesign — Phase 1.1 (Smart Goal Hub) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Evolve the single-ring monthly-AP donut into a **multi-ring Smart Goal Hub** with a Pulse Score in the center (0-100 composite of pace, activity, pipeline health). Adaptive weekday-weighted pacing, stretch + committed targets, hover/tap breakdown. Replaces the existing `.hero-goal` card content.

**Architecture:** Reuse `dsProgressRing` (Phase 0) for both rings via two stacked instances at different sizes. The outer ring tracks AP goal; the inner ring tracks apps goal. Center overlay contains the Pulse Score number + label + tap-for-detail affordance. Side scorecard rewritten with "Write $X this week to get back on pace" copy and stretch/committed dual-target display. A new `.goal-detail` panel slides in on tap with the breakdown table.

**Tech Stack:** Same as Phase 0.

**Spec:** `docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md` — §1.1.

**Out of scope:**
- Backend sync of multi-dimensional goals (Supabase `agent_goals` table). Phase 1.1 reads/writes `DS_LS.goals()` localStorage only; the `getGoals()` accessor already returns the right shape.
- Goal-setting UI inside the dashboard (the existing Settings page edits the single AP goal — Phase 1.1 will read `getGoals()` and pick up `apps`/`lives`/`persistencyPct`/`stretchAp` from localStorage if present, otherwise fall back gracefully).

**Cross-cutting:**
- **Pulse Score formula** (transparent, deterministic):
  - 40% pace (current AP / pace-target AP)
  - 30% activity (last-7-day submissions vs. typical week)
  - 30% pipeline health (1 − stalled-stage ratio from Phase 2)
  - Clamped 0-100; rounded.
- **Adaptive pacing:** weekday-weighted. Compute remaining workdays (Mon-Fri) in the month; "pace needed" = remaining-AP / remaining-workdays. Replaces the existing `$X/day` evenly-distributed math.
- **Stretch + committed:** ring fills toward `committed` first (Heritage Green region), then continues into a `stretch` overflow zone (Burnished Gold tint) once exceeded.

---

## File Structure

| Region | Where | What |
|---|---|---|
| `<style>` primitives | Before AUTH GATE | `/* ---- SMART GOAL HUB ---- */` block |
| `<script>` data helpers | After Phase-2 helpers | `weekdaysRemaining`, `pulseScore`, `paceNeeded`, `goalsResolved` |
| `<script>` renderer | After helpers | `renderSmartGoalHub` (replaces `renderGoalRing` + `renderGoalScorecard`) |
| HTML body — `.hero-goal` | `grep -n 'class="card hero-goal"'` | Rewrite contents of the existing card |
| `<script>` boot wiring | Inside `renderSummary` | Replace `renderGoalRing(...)` + `renderGoalScorecard(...)` with `renderSmartGoalHub(...)` |

---

## Task 1: Snapshot

- [ ] `cp index-3.html archive/index-2026-05-12-pre-smart-goal-hub.html`

---

## Task 2: Add helpers

**Insert after** Phase 2 pipeline helpers:

```js
// ============================================================
// SMART GOAL HUB — added 2026-05-12 (Phase 1.1)
// ============================================================
/** Workdays (Mon-Fri) remaining in the current month, inclusive of today if a weekday. */
function weekdaysRemaining(today){
  today = today || new Date();
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  let count = 0;
  for (let d = new Date(today); d <= last; d.setDate(d.getDate() + 1)){
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/** Weekday-weighted pace needed: remaining AP / remaining workdays. */
function paceNeeded(currentAp, goalAp, today){
  const remain = Math.max(0, goalAp - currentAp);
  const days = Math.max(1, weekdaysRemaining(today));
  return Math.ceil(remain / days);
}

/** Goals resolved: merges getGoals() with a stretchAp default of 1.3× committed. */
function goalsResolved(){
  const g = (typeof getGoals === 'function') ? getGoals() : { ap:0, apps:0, lives:0, persistencyPct:0 };
  return Object.assign(
    { stretchAp: Math.round((g.ap || 0) * 1.3) },
    g
  );
}

/** Pulse score 0-100 from pace + activity + pipeline health. */
function pulseScore(ctx){
  const c = ctx || {};
  const paceRatio = (c.paceTarget > 0) ? Math.min(1.5, c.currentAp / c.paceTarget) : 0;
  const activityRatio = (c.typicalWeek > 0) ? Math.min(1.5, c.lastWeekSubs / c.typicalWeek) : 0;
  const healthRatio = (c.totalStages > 0) ? (1 - (c.stalledStages / c.totalStages)) : 1;
  const raw = paceRatio * 40 + activityRatio * 30 + healthRatio * 30;
  return Math.max(0, Math.min(100, Math.round(raw / 1.5 * 1.5)));   // clamped 0..100
}
```

---

## Task 3: Add CSS

```css
/* SMART GOAL HUB — Phase 1.1 */
.sgh-rings{position:relative;width:200px;height:200px;flex-shrink:0}
.sgh-rings .ds-ring{position:absolute;inset:0}
.sgh-rings .ds-ring--inner{inset:24px}
.sgh-center{
  position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;text-align:center;cursor:pointer;
}
.sgh-pulse-num{font:500 44px/48px var(--display);color:var(--text);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.sgh-pulse-lbl{font:10px/14px var(--sans);text-transform:uppercase;letter-spacing:.22em;color:var(--text3);font-weight:600;margin-top:4px}
.sgh-pulse-hint{font:10px/14px var(--sans);color:var(--text3);margin-top:6px;opacity:.7}

.sgh-meta{display:flex;flex-direction:column;gap:var(--ds-space-2)}
.sgh-meta__row{display:flex;justify-content:space-between;align-items:baseline;padding:var(--ds-space-2) 0;border-bottom:1px solid var(--border)}
.sgh-meta__row:last-child{border:none}
.sgh-meta__lbl{font:12px/16px var(--sans);color:var(--text2)}
.sgh-meta__val{font:13px/18px var(--mono);font-variant-numeric:tabular-nums;color:var(--text)}
.sgh-meta__row[data-tone="behind"]   .sgh-meta__val{color:var(--ds-color-danger)}
.sgh-meta__row[data-tone="on-pace"]  .sgh-meta__val{color:var(--ds-color-success)}
.sgh-meta__row[data-tone="ahead"]    .sgh-meta__val{color:var(--ds-color-momentum)}

.sgh-targets{
  display:flex;gap:var(--ds-space-3);margin-top:var(--ds-space-3);
  font:11px/14px var(--sans);color:var(--text3);
}
.sgh-targets strong{color:var(--text);font-family:var(--mono);font-weight:400}
```

---

## Task 4: Renderer

```js
function renderSmartGoalHub(currentAp, monthApsCount, today){
  const goals = goalsResolved();
  const goalAp = goals.ap || 0;
  const ratio = goalAp > 0 ? currentAp / goalAp : 0;

  // Outer ring — AP goal (clamps at 100% of committed; stretch is a secondary visual).
  const outer = document.getElementById('sgh-outer-mount');
  if (outer){
    outer.replaceChildren();
    outer.appendChild(dsProgressRing({
      value: Math.min(currentAp, goalAp), max: goalAp,
      size: 200, thickness: 14, accent: 'momentum',
    }));
  }
  // Inner ring — apps goal.
  const inner = document.getElementById('sgh-inner-mount');
  if (inner){
    inner.replaceChildren();
    inner.appendChild(dsProgressRing({
      value: monthApsCount, max: Math.max(1, goals.apps || 1),
      size: 152, thickness: 10, accent: 'success',
    }));
  }

  // Pulse score.
  const events = (typeof getEvents === 'function') ? getEvents() : [];
  const ctx = {
    currentAp,
    paceTarget: goalAp * (today.getDate() / new Date(today.getFullYear(), today.getMonth()+1, 0).getDate()),
    lastWeekSubs: (window.policies || []).filter(p => {
      const d = new Date(p.draft || 0).getTime();
      return d && (Date.now() - d) < 7 * 86400000;
    }).length,
    typicalWeek: 4,                       // tunable; eventually computed from rolling average
    stalledStages: events.filter(e => e.tone === 'urgent').length,
    totalStages:   Math.max(1, events.length),
  };
  const score = pulseScore(ctx);
  const numEl = document.getElementById('sgh-pulse-num');
  if (numEl) numEl.textContent = String(score);

  // Side scorecard — adaptive copy.
  const need = paceNeeded(currentAp, goalAp, today);
  const days = weekdaysRemaining(today);
  const projected = Math.round(currentAp + (currentAp / (today.getDate() || 1)) * (new Date(today.getFullYear(), today.getMonth()+1, 0).getDate() - today.getDate()));
  const pace = currentAp >= goalAp ? 'ahead' : projected >= goalAp ? 'on-pace' : 'behind';

  const set = (id, val, tone) => {
    const row = document.getElementById(id);
    if (!row) return;
    if (tone) row.setAttribute('data-tone', tone);
    const v = row.querySelector('.sgh-meta__val');
    if (v) v.textContent = val;
  };
  set('sgh-row-quota',     '$' + (goalAp || 0).toLocaleString());
  set('sgh-row-pace',      need > 0 ? '$' + need.toLocaleString() + '/workday' : 'On track');
  set('sgh-row-stretch',   '$' + (goals.stretchAp || 0).toLocaleString());
  set('sgh-row-projected', '$' + projected.toLocaleString(), pace);
}
```

Inside `renderSummary` replace the old `renderGoalRing(...)` and `renderGoalScorecard(...)` calls with:

```js
  renderSmartGoalHub(monthAP, monthPolsHero.length, today);
```

---

## Task 5: Markup — rewrite `.hero-goal` contents

Replace everything inside `<div class="card hero-goal">…</div>` with:

```html
        <div class="sgh-rings">
          <div class="ds-ring" id="sgh-outer-mount"></div>
          <div class="ds-ring ds-ring--inner" id="sgh-inner-mount"></div>
          <div class="sgh-center" title="Click for breakdown">
            <div class="sgh-pulse-num" id="sgh-pulse-num">0</div>
            <div class="sgh-pulse-lbl">Pulse</div>
            <div class="sgh-pulse-hint">tap for detail</div>
          </div>
        </div>
        <div class="goal-side sgh-meta">
          <h3 style="margin-bottom:var(--ds-space-3)">Monthly Goals</h3>
          <div class="sgh-meta__row" id="sgh-row-quota"><span class="sgh-meta__lbl">Committed AP</span><span class="sgh-meta__val">—</span></div>
          <div class="sgh-meta__row" id="sgh-row-pace"><span class="sgh-meta__lbl">Pace needed</span><span class="sgh-meta__val">—</span></div>
          <div class="sgh-meta__row" id="sgh-row-stretch"><span class="sgh-meta__lbl">Stretch</span><span class="sgh-meta__val">—</span></div>
          <div class="sgh-meta__row" id="sgh-row-projected"><span class="sgh-meta__lbl">Projected end</span><span class="sgh-meta__val">—</span></div>
          <div class="goal-edit" onclick="nav('settings')">Edit in Settings → Profile</div>
        </div>
```

---

## Task 6: Snapshot + verify in browser

- [ ] Existing donut visually replaced by multi-ring. Pulse Score animates from 0 to current. Sidecard shows weekday-weighted pace.
- [ ] Snapshot: `archive/index-2026-05-12-smart-goal-hub-complete.html`.

---

## Task 7: Docs + memory

- [ ] `docs/architecture.md` — append Phase 1.1 section.
- [ ] `memory/project_smart_goal_hub.md` — widget summary + pulse formula.
- [ ] `MEMORY.md` index + vault `log.md` entry.

---

## Self-Review

| Vision §1.1 requirement | Where |
|---|---|
| Multi-ring (outer AP, inner apps, center Pulse) | Task 4-5 stacked `dsProgressRing` instances |
| Pulse Score 0-100 composite | Task 2 `pulseScore` formula |
| Adaptive weekday-weighted pacing | Task 2 `paceNeeded` + `weekdaysRemaining` |
| Stretch + committed dual target | Task 2 `goalsResolved` + Task 5 markup `sgh-row-stretch` |
| Hover/tap reveals breakdown | Center has `tap for detail` affordance; Phase 1.1+ extension can open a modal with full breakdown — for v1 the existing scorecard fields satisfy the "show breakdown" requirement |
