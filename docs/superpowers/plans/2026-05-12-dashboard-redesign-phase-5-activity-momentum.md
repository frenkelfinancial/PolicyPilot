# Dashboard Redesign — Phase 5 (Activity & Momentum) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Build the **stickiness reinforcement layer** — Activity Pulse (conversion funnel + heatmap) and Streaks & Records. Reward the agent for showing up, even on slow weeks.

**Architecture:** Two-card row inserted below the Income Reality row. Card 1 is the Activity Pulse: daily/weekly toggle, a 5-stage conversion funnel (Dials → Contacts → Appts → Apps → Issued) with target ratios as overlay lines, plus a GitHub-style heatmap calendar of activity. Card 2 is Streaks & Records: current streak, longest streak, this-month vs. best-month, achievement badges row. All data sourced from `getActivities()` (Phase 0 reader) which gained writes in Phase 1.2.

**Tech Stack:** Same as Phase 0. Heatmap is an SVG grid (53 weeks × 7 days = 371 cells). Funnel uses simple `flex-basis` bars.

**Spec:** §5.

**Out of scope:**
- Configurable targets per agent (uses fixed conversion targets: dial→contact 25%, contact→appt 40%, appt→app 50%, app→issued 80%).
- Achievement badge unlock notifications (a Phase 7 motion concern).
- Activity-entry UI (Phase 5 only READS activities; entry is via Action Hub CTAs and a follow-up "log activity" plan).

**Cross-cutting:**
- **Activity types feed different funnel stages.** Mapping: `call` → dials; `contact` → contacts; `appointment` → appts; `quote` → apps; policy with `status in (issued, placed, paid)` → issued. This means the funnel pulls from BOTH `getActivities()` (top 4 stages) AND `policies` (bottom stage).
- **Streak = consecutive days with at least one logged activity OR policy submission.** Resets at the first day with zero.
- **Heatmap squares colored by total activity count that day** (0 → muted; 1-2 → low; 3-4 → mid; 5+ → max). Tooltip shows date + count.
- **Achievement badges are deterministic.** Configurable list of `{id, label, predicate(stats)}`. Earned badges show; unearned grayed out.

---

## File Structure

| Region | Where | What |
|---|---|---|
| `<style>` | Before AUTH GATE | `/* ---- ACTIVITY MOMENTUM ---- */` block |
| `<script>` helpers | After Phase 3 helpers | `activityFunnel`, `activityHeatmapCells`, `streakStats`, `evaluateAchievements` |
| `<script>` renderer | After helpers | `renderActivityMomentum` |
| HTML body — `#sec-summary` | After `#income-reality` close | New `<div class="am-row" id="activity-momentum">…</div>` with two card mounts |
| `<script>` `renderSummary` | After `renderIncomeReality()` | Add `renderActivityMomentum()` call |

---

## Task 1: Snapshot

- [ ] `cp index-3.html archive/index-2026-05-12-pre-activity-momentum.html`

---

## Task 2: Helpers

```js
// ============================================================
// ACTIVITY & MOMENTUM — added 2026-05-12 (Phase 5)
// ============================================================
const ACTIVITY_FUNNEL_TARGETS = { dialToContact:.25, contactToAppt:.40, apptToApp:.50, appToIssued:.80 };

function activityFunnel(rangeDays){
  rangeDays = rangeDays || 7;
  const cutoff = Date.now() - rangeDays * 86400000;
  const acts = (typeof getActivities === 'function') ? getActivities() : [];
  const inRange = acts.filter(a => new Date(a.when).getTime() >= cutoff);
  const count = type => inRange.filter(a => a.type === type).length;
  const dials    = count('call');
  const contacts = count('contact');
  const appts    = count('appointment');
  const apps     = count('quote');
  const pols     = (window.policies || []).filter(p => {
    const d = new Date(p.draft || p.issueDate || 0).getTime();
    return d && d >= cutoff && ['issued','placed','paid'].includes(p.status);
  }).length;
  return { dials, contacts, appts, apps, issued: pols };
}

/** 371 cells for ~53 weeks. Each cell: { date:Date, count:number }. */
function activityHeatmapCells(){
  const today = new Date(); today.setHours(0,0,0,0);
  const start = new Date(today); start.setDate(start.getDate() - (52*7 + today.getDay()));
  const acts = (typeof getActivities === 'function') ? getActivities() : [];
  const counts = new Map();
  for (const a of acts){
    const d = new Date(a.when); d.setHours(0,0,0,0);
    const key = d.toISOString().slice(0,10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const cells = [];
  for (let i = 0; i < 53 * 7; i++){
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0,10);
    cells.push({ date: new Date(d), count: counts.get(key) || 0 });
  }
  return cells;
}

function streakStats(){
  const acts = (typeof getActivities === 'function') ? getActivities() : [];
  const pols = (window.policies || []);
  const dates = new Set();
  for (const a of acts) dates.add(new Date(a.when).toISOString().slice(0,10));
  for (const p of pols) if (p.draft) dates.add(new Date(p.draft).toISOString().slice(0,10));
  // Current streak — count back from today/yesterday.
  let current = 0;
  for (let i = 0; i < 365; i++){
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    if (dates.has(key)){ current++; } else if (i > 0) { break; }
  }
  // Longest streak — scan all dates sorted asc.
  const sorted = [...dates].sort();
  let longest = 0, run = 0, prev = null;
  for (const k of sorted){
    if (prev && (new Date(k) - new Date(prev)) === 86400000) run++; else run = 1;
    if (run > longest) longest = run;
    prev = k;
  }
  return { current, longest, totalDays: dates.size };
}

const ACHIEVEMENTS = [
  { id:'first-app',      label:'First Application',  earned: s => s.totalApps >= 1 },
  { id:'ten-month',      label:'10 Apps in a Month',  earned: s => s.bestMonthApps >= 10 },
  { id:'week-streak',    label:'7-Day Streak',         earned: s => s.longestStreak >= 7 },
  { id:'month-streak',   label:'30-Day Streak',        earned: s => s.longestStreak >= 30 },
  { id:'multi-carrier',  label:'5 Carriers Active',    earned: s => s.uniqueCarriers >= 5 },
];

function evaluateAchievements(){
  const pols = (window.policies || []);
  const byMonth = new Map();
  const carriers = new Set();
  for (const p of pols){
    if (p.carrier) carriers.add(p.carrier);
    if (p.draft){
      const m = p.draft.slice(0,7);
      byMonth.set(m, (byMonth.get(m) || 0) + 1);
    }
  }
  const streaks = streakStats();
  const stats = {
    totalApps: pols.length,
    bestMonthApps: Math.max(0, ...byMonth.values()),
    longestStreak: streaks.longest,
    uniqueCarriers: carriers.size,
  };
  return ACHIEVEMENTS.map(a => ({ ...a, _earned: a.earned(stats) }));
}
```

---

## Task 3: CSS

```css
/* ACTIVITY & MOMENTUM — Phase 5 */
.am-row{display:grid;grid-template-columns:1.4fr 1fr;gap:var(--ds-space-4);margin-bottom:var(--ds-space-5)}
@media (max-width:1100px){.am-row{grid-template-columns:1fr}}

.am-funnel{display:flex;flex-direction:column;gap:var(--ds-space-2);margin-top:var(--ds-space-3)}
.am-funnel__row{display:grid;grid-template-columns:88px 1fr 64px;align-items:center;gap:var(--ds-space-3)}
.am-funnel__lbl{font:11px/14px var(--sans);color:var(--text3);text-transform:uppercase;letter-spacing:.12em}
.am-funnel__bar{height:14px;background:var(--bg2);border-radius:var(--ds-radius-pill);overflow:hidden;position:relative}
.am-funnel__bar-fill{height:100%;background:var(--ds-color-momentum);border-radius:var(--ds-radius-pill);transition:width var(--ds-duration-slow) var(--ds-ease-out)}
.am-funnel__count{font:12px/16px var(--mono);font-variant-numeric:tabular-nums;color:var(--text);text-align:right}
.am-funnel__ratio{font:10px/13px var(--mono);color:var(--text3);font-variant-numeric:tabular-nums;text-align:right;margin-top:1px}
.am-funnel__ratio[data-tone="ok"]   {color:var(--ds-color-success)}
.am-funnel__ratio[data-tone="warn"] {color:var(--ds-color-warning)}
.am-funnel__ratio[data-tone="bad"]  {color:var(--ds-color-danger)}

.am-heat{display:grid;grid-template-rows:repeat(7, 11px);grid-auto-flow:column;grid-auto-columns:11px;gap:2px;margin-top:var(--ds-space-4)}
.am-heat__cell{border-radius:2px;background:var(--bg2)}
.am-heat__cell[data-level="1"]{background:rgba(91,160,232,.25)}
.am-heat__cell[data-level="2"]{background:rgba(91,160,232,.45)}
.am-heat__cell[data-level="3"]{background:rgba(91,160,232,.70)}
.am-heat__cell[data-level="4"]{background:var(--ds-color-momentum)}
.am-heat__legend{display:flex;justify-content:flex-end;gap:var(--ds-space-2);margin-top:var(--ds-space-2);font:10.5px/14px var(--sans);color:var(--text3)}

.am-streak{display:grid;grid-template-columns:1fr 1fr;gap:var(--ds-space-3);margin-bottom:var(--ds-space-4)}
.am-streak__num{font:500 36px/40px var(--display);color:var(--ds-color-momentum);font-variant-numeric:tabular-nums}
.am-streak__lbl{font:10.5px/14px var(--sans);color:var(--text3);text-transform:uppercase;letter-spacing:.12em}
.am-badges{display:flex;flex-wrap:wrap;gap:var(--ds-space-2);margin-top:var(--ds-space-3)}
.am-badge{padding:6px 10px;border-radius:var(--ds-radius-pill);font:11px/14px var(--sans);background:var(--bg2);color:var(--text3);border:1px solid var(--border)}
.am-badge[data-earned="true"]{background:var(--ds-color-success-bg);color:var(--ds-color-success);border-color:var(--ds-color-success)}
```

---

## Task 4: Renderer

```js
function renderActivityMomentum(){
  const root = document.getElementById('activity-momentum');
  if (!root) return;
  root.replaceChildren();

  // ---- Card 1: Activity Pulse (funnel + heatmap)
  const card1 = dsStatCard({
    label: 'Activity Pulse · Last 7 days',
    hero: '',
    accent: 'momentum',
  });
  // remove hero element since the funnel takes its place
  const hero = card1.querySelector('.ds-stat__hero'); if (hero) hero.remove();

  const f = activityFunnel(7);
  const max = Math.max(1, f.dials, f.contacts, f.appts, f.apps, f.issued);
  const rows = [
    ['Dials',    f.dials,    null,             null],
    ['Contacts', f.contacts, f.dials,          ACTIVITY_FUNNEL_TARGETS.dialToContact],
    ['Appts',    f.appts,    f.contacts,       ACTIVITY_FUNNEL_TARGETS.contactToAppt],
    ['Apps',     f.apps,     f.appts,          ACTIVITY_FUNNEL_TARGETS.apptToApp],
    ['Issued',   f.issued,   f.apps,           ACTIVITY_FUNNEL_TARGETS.appToIssued],
  ];
  const funnel = document.createElement('div'); funnel.className = 'am-funnel';
  for (const [lbl, count, prev, target] of rows){
    const row = document.createElement('div'); row.className = 'am-funnel__row';
    const l = document.createElement('div'); l.className = 'am-funnel__lbl'; l.textContent = lbl;
    const barWrap = document.createElement('div'); barWrap.className = 'am-funnel__bar';
    const fill = document.createElement('div'); fill.className = 'am-funnel__bar-fill';
    fill.style.width = (count / max * 100) + '%';
    barWrap.appendChild(fill);
    const right = document.createElement('div');
    const c = document.createElement('div'); c.className = 'am-funnel__count'; c.textContent = count;
    right.appendChild(c);
    if (prev !== null){
      const ratio = prev ? count / prev : 0;
      const r = document.createElement('div'); r.className = 'am-funnel__ratio';
      r.textContent = Math.round(ratio * 100) + '% · target ' + Math.round(target * 100) + '%';
      r.setAttribute('data-tone', ratio >= target ? 'ok' : ratio >= target * 0.7 ? 'warn' : 'bad');
      right.appendChild(r);
    }
    row.appendChild(l); row.appendChild(barWrap); row.appendChild(right);
    funnel.appendChild(row);
  }
  card1.appendChild(funnel);

  // Heatmap
  const heat = document.createElement('div'); heat.className = 'am-heat';
  for (const cell of activityHeatmapCells()){
    const c = document.createElement('div'); c.className = 'am-heat__cell';
    const level = cell.count === 0 ? 0 : cell.count <= 2 ? 1 : cell.count <= 4 ? 2 : cell.count <= 6 ? 3 : 4;
    c.setAttribute('data-level', String(level));
    c.title = `${cell.date.toLocaleDateString()} — ${cell.count} activit${cell.count===1?'y':'ies'}`;
    heat.appendChild(c);
  }
  card1.appendChild(heat);
  root.appendChild(card1);

  // ---- Card 2: Streaks & Records
  const s = streakStats();
  const card2 = dsStatCard({ label: 'Streaks & Records', hero: '', accent: 'success' });
  const hero2 = card2.querySelector('.ds-stat__hero'); if (hero2) hero2.remove();

  const streak = document.createElement('div'); streak.className = 'am-streak';
  const cur = document.createElement('div');
  cur.innerHTML = `<div class="am-streak__num">${s.current}</div><div class="am-streak__lbl">Current streak</div>`;
  const lng = document.createElement('div');
  lng.innerHTML = `<div class="am-streak__num" style="color:var(--ds-color-success)">${s.longest}</div><div class="am-streak__lbl">Longest · ${s.totalDays} active days</div>`;
  streak.appendChild(cur); streak.appendChild(lng);
  card2.appendChild(streak);

  const badges = document.createElement('div'); badges.className = 'am-badges';
  for (const a of evaluateAchievements()){
    const b = document.createElement('span'); b.className = 'am-badge'; b.textContent = a.label;
    b.setAttribute('data-earned', String(!!a._earned));
    badges.appendChild(b);
  }
  card2.appendChild(badges);
  root.appendChild(card2);
}
```

---

## Task 5: Markup + wiring

Insert after `#income-reality` in `#sec-summary`:

```html
      <!-- ACTIVITY & MOMENTUM (Phase 5) -->
      <div class="am-row" id="activity-momentum"></div>
```

Add `renderActivityMomentum()` call to `renderSummary` after `renderIncomeReality()`.

---

## Task 6: Snapshot + docs + memory

- [ ] Snapshot.
- [ ] `docs/architecture.md` Phase 5 section.
- [ ] `memory/project_activity_momentum.md` with the achievement list + streak math.
- [ ] `MEMORY.md` index + vault log.

---

## Self-Review

| Vision §5 requirement | Where |
|---|---|
| Daily/weekly toggle | Hardcoded 7-day in v1; toggle deferred to a v2 follow-up. Document. |
| Dials → Contacts → Appts → Apps → Issued funnel | Task 4 `am-funnel__row` × 5 |
| Conversion ratios with target line | Task 4 `am-funnel__ratio` with `[data-tone]` |
| Heatmap calendar GitHub-style | Task 4 + Task 3 `am-heat` 53×7 grid |
| Current submission streak | Task 2 `streakStats.current` |
| Longest / best month | Task 2 `streakStats.longest` + `bestMonthApps` from `evaluateAchievements` stats |
| Achievement badges | Task 2 `ACHIEVEMENTS` array + Task 4 render |
