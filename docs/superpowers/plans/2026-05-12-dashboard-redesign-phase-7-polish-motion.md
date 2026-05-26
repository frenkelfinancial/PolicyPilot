# Dashboard Redesign — Phase 7 (Polish, Motion, Stickiness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Make the dashboard feel **inspiring**, not just informative. Number count-up animations, ring fills animating, satisfying completion micro-animations, adaptive greeting, configurable widget order, browser notifications, and the "moment" moments (app-submit / placement / streak-break overlays).

**Architecture:** Cross-cutting layer that touches every renderer. No new dashboard widgets — only enhancements:
- A new `_animateValue(el, from, to, fmt)` helper that interpolates numeric text content (replaces direct `.textContent = '$X'` assignments where appropriate).
- A new `_lastSeenValue(key)` / `_storeLastValue(key, v)` pair so count-ups start from the last known value (not from 0) — feels like progress, not reset.
- A new `DASHBOARD_LAYOUT` localStorage key for widget order, with drag-to-reorder.
- A new `DashboardMoments` module for celebration overlays (app submit, placement, streak milestone, streak break).
- A `requestNotificationPermission()` flow on first sign-in after `?notify=1` (off by default until the agent opts in).
- Greeting personalization wired to `currentAgent.display_name` + a contextual phrase generator.

**Tech Stack:** Same as Phase 0. Uses the Web Animations API for celebration overlays (no Lottie / GSAP).

**Spec:** §7.

**Out of scope:**
- Drag-to-reorder UI library — uses a simple HTML5 drag-and-drop handler.
- Full notification scheduling backend (only browser-side `Notification` API; no service worker).
- Audio cues (would clash with FFL field environment).

**Cross-cutting:**
- **All count-ups respect `prefers-reduced-motion`** (collapses to instant via the Phase 0 motion tokens).
- **Layout-order persistence** keyed per-agent via `k('dashboard_layout')`. Falls back to default order.
- **Moments are opt-in via a setting toggle** (`DS_LS.moments_enabled`). Default OFF for new agents until they've seen at least one app submit; once they've submitted, they're prompted to enable.

---

## File Structure

| Region | Where | What |
|---|---|---|
| `<style>` | Before AUTH GATE | `/* ---- DASHBOARD MOMENTS ---- */` block (overlay + confetti shapes) |
| `<script>` helpers | After Phase 6 helpers | `_animateValue`, `_lastSeenValue`, `_storeLastValue`, `dashboardMomentApp`, `dashboardMomentPlacement`, `dashboardMomentStreak`, `dashboardMomentStreakBreak` |
| `<script>` greeting + layout | After helpers | `renderGreeting`, `applyDashboardLayout`, `saveDashboardLayout` |
| `<script>` notifications | After greeting | `requestDashboardNotifications`, `scheduleDailySummary` |
| HTML body — topbar | `grep -n 'id="pgTitle"'` | Replace static page title structure with greeting + title combo |
| `<script>` integration into renderers | Every existing `*.textContent = '$X'` in `renderSummary`/Phase 1-6 renderers | Wrap with `_animateValue(...)` where the value changed |
| `<script>` integration into policy add | `grep -n 'function addPolicy\b'` | After successful add, call `dashboardMomentApp(policy)` |
| `<script>` integration into status changes | `grep -n 'function setPolicyStatus\|updatePolicy'` (find the place) | When status transitions to `placed`, call `dashboardMomentPlacement` |

---

## Task 1: Snapshot

- [ ] `cp index-3.html archive/index-2026-05-12-pre-polish-motion.html`

---

## Task 2: Animation + storage helpers

```js
// ============================================================
// POLISH / MOTION — added 2026-05-12 (Phase 7)
// ============================================================

/** Animate a number from `from` to `to` over duration ms, updating el.textContent each frame. */
function _animateValue(el, from, to, fmt, duration){
  if (!el) return;
  duration = duration || parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ds-duration-slow')) || 400;
  if (duration === 0 || from === to){ el.textContent = fmt(to); return; }
  const start = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);    // ease-out-cubic
  const tick = now => {
    const t = Math.min(1, (now - start) / duration);
    const v = from + (to - from) * ease(t);
    el.textContent = fmt(v);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const _lastSeenStore = new Map();
function _lastSeenValue(key){
  if (_lastSeenStore.has(key)) return _lastSeenStore.get(key);
  try { const raw = localStorage.getItem(k('ds_last_' + key)); return raw ? Number(raw) : 0; }
  catch (_e) { return 0; }
}
function _storeLastValue(key, v){
  _lastSeenStore.set(key, v);
  try { localStorage.setItem(k('ds_last_' + key), String(v)); } catch (_e) {}
}

/** Convenience for KPI-style values: `_kpi('ap-month', el, 1200, v => '$' + Math.round(v).toLocaleString())` */
function _kpi(key, el, newValue, fmt){
  const prev = _lastSeenValue(key);
  _animateValue(el, prev, newValue, fmt);
  _storeLastValue(key, newValue);
}
```

---

## Task 3: Dashboard moments (celebration overlays)

```js
/** Tiny overlay shown for short-lived celebrations. Uses Web Animations API. */
function _showMomentOverlay(html, durationMs){
  durationMs = durationMs || 1800;
  if (!document.body) return;
  const el = document.createElement('div');
  el.className = 'dm-overlay';
  el.innerHTML = html;
  document.body.appendChild(el);
  el.animate(
    [
      { opacity: 0, transform: 'translateY(8px) scale(.96)' },
      { opacity: 1, transform: 'translateY(0) scale(1)', offset: .25 },
      { opacity: 1, transform: 'translateY(0) scale(1)', offset: .85 },
      { opacity: 0, transform: 'translateY(-8px) scale(.99)' },
    ],
    { duration: durationMs, easing: 'cubic-bezier(.16,1,.3,1)' }
  ).finished.then(() => el.remove()).catch(() => el.remove());
}

function dashboardMomentApp(policy){
  if (!_momentsEnabled()) return;
  _showMomentOverlay(
    `<div class="dm-card"><div class="dm-eyebrow">Application submitted</div>` +
    `<div class="dm-headline">${(policy && policy.client) || 'New app'}</div>` +
    `<div class="dm-sub">$${Number((policy && policy.ap) || 0).toLocaleString()} AP · ${(policy && policy.carrier) || ''}</div></div>`
  );
}

function dashboardMomentPlacement(policy){
  if (!_momentsEnabled()) return;
  _showMomentOverlay(
    `<div class="dm-card dm-card--strong"><div class="dm-eyebrow">Policy placed</div>` +
    `<div class="dm-headline">${(policy && policy.client) || 'A policy placed'}</div>` +
    `<div class="dm-sub">Commission earned</div></div>`,
    2400
  );
}

function dashboardMomentStreak(days){
  if (!_momentsEnabled()) return;
  _showMomentOverlay(
    `<div class="dm-card dm-card--momentum"><div class="dm-eyebrow">${days}-day streak</div>` +
    `<div class="dm-headline">Keep going.</div></div>`
  );
}

function dashboardMomentStreakBreak(prevDays){
  if (!_momentsEnabled()) return;
  _showMomentOverlay(
    `<div class="dm-card"><div class="dm-eyebrow">Streak ended</div>` +
    `<div class="dm-headline">${prevDays} days strong.</div>` +
    `<div class="dm-sub">Today's a fresh start.</div></div>`,
    2200
  );
}

function _momentsEnabled(){
  try { return localStorage.getItem(k('ds_moments_enabled')) === '1'; }
  catch (_e) { return false; }
}
function setMomentsEnabled(v){
  try { localStorage.setItem(k('ds_moments_enabled'), v ? '1' : '0'); } catch (_e) {}
}
```

---

## Task 4: CSS

```css
/* DASHBOARD MOMENTS — Phase 7 */
.dm-overlay{
  position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
  pointer-events:none;z-index:400;padding:var(--ds-space-7);
}
.dm-card{
  background:var(--card);border:1px solid var(--border);
  border-radius:var(--ds-radius-lg);padding:var(--ds-space-6) var(--ds-space-7);
  box-shadow:var(--ds-elev-modal);text-align:center;max-width:420px;
}
.dm-card--strong{border-color:var(--ds-color-success);border-width:2px}
.dm-card--momentum{border-color:var(--ds-color-momentum);border-width:2px}
.dm-eyebrow{font:11px/14px var(--sans);text-transform:uppercase;letter-spacing:.18em;color:var(--text3);font-weight:600;margin-bottom:var(--ds-space-2)}
.dm-headline{font:500 24px/30px var(--display);color:var(--text);letter-spacing:-.01em}
.dm-sub{font:13px/18px var(--sans);color:var(--text3);margin-top:var(--ds-space-2)}
@media (prefers-reduced-motion: reduce){ .dm-overlay{display:none} }

/* Greeting strip in the topbar */
.greet{display:flex;flex-direction:column;gap:2px}
.greet__hello{font:11px/14px var(--sans);text-transform:uppercase;letter-spacing:.18em;color:var(--text3);font-weight:600}
.greet__name {font:500 18px/22px var(--display);color:var(--text);font-variant-numeric:tabular-nums}

/* Drag-to-reorder cards */
.sum-v3 .card[draggable="true"]{cursor:grab}
.sum-v3 .card.dragging{opacity:.6;transform:rotate(.5deg)}
.sum-v3 .card.drag-over{outline:2px dashed var(--ds-color-momentum);outline-offset:4px}
```

---

## Task 5: Greeting + adaptive copy

```js
function renderGreeting(){
  const titleEl = document.getElementById('pgTitle');
  if (!titleEl) return;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = (typeof currentAgent === 'object' && currentAgent && currentAgent.display_name)
    ? currentAgent.display_name.split(' ')[0]
    : '';
  const pols = window.policies || [];
  const monthAp = pols.filter(p => {
    if (!p.draft) return false;
    const d = new Date(p.draft);
    return d.getMonth() === new Date().getMonth() && d.getFullYear() === new Date().getFullYear();
  }).reduce((s,p) => s + (Number(p.ap) || 0), 0);

  // Contextual phrase
  let context = '';
  if (monthAp === 0) context = 'Let’s open the month with one app.';
  else {
    const s = (typeof streakStats === 'function') ? streakStats() : { current: 0, longest: 0 };
    if (s.current >= 3) context = `${s.current}-day streak — keep it alive.`;
    else if (monthAp > 0) context = 'Build on yesterday.';
  }

  titleEl.innerHTML =
    `<div class="greet">` +
      `<span class="greet__hello">${greet}${name ? ', ' + name : ''}</span>` +
      `<span class="greet__name">${context}</span>` +
    `</div>`;
}
```

Call `renderGreeting()` from `renderSummary` at the top.

---

## Task 6: Drag-to-reorder

```js
function applyDashboardLayout(){
  let order;
  try { order = JSON.parse(localStorage.getItem(k('dashboard_layout')) || 'null'); } catch (_e) {}
  if (!Array.isArray(order)) return;
  const root = document.getElementById('sec-summary');
  if (!root) return;
  for (const id of order){
    const el = document.getElementById(id);
    if (el) root.appendChild(el);   // appendChild moves nodes in place
  }
}

function saveDashboardLayout(){
  const root = document.getElementById('sec-summary');
  if (!root) return;
  const ids = [...root.children].map(c => c.id).filter(Boolean);
  try { localStorage.setItem(k('dashboard_layout'), JSON.stringify(ids)); } catch (_e) {}
}

function _wireReorder(){
  const root = document.getElementById('sec-summary');
  if (!root) return;
  for (const card of root.querySelectorAll('.card')){
    if (!card.id) continue;
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', () => card.classList.add('dragging'));
    card.addEventListener('dragend',   () => card.classList.remove('dragging'));
    card.addEventListener('dragover',  e => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop',      e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const dragging = root.querySelector('.dragging');
      if (dragging && dragging !== card) root.insertBefore(dragging, card);
      saveDashboardLayout();
    });
  }
}
```

Call `applyDashboardLayout()` once after `renderSummary` finishes; call `_wireReorder()` once at the end of `bootDashboard`.

---

## Task 7: Notifications (opt-in)

```js
async function requestDashboardNotifications(){
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied')  return false;
  const res = await Notification.requestPermission();
  return res === 'granted';
}

function notifyIf(title, body){
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body }); } catch (_e) {}
}

// Hook into existing event detection.
function scheduleDailySummary(){
  if (!_momentsEnabled()) return;
  // Fire a notification once per day, lazily on next renderSummary after 8am local.
  const today = new Date().toISOString().slice(0,10);
  let lastDay; try { lastDay = localStorage.getItem(k('ds_last_notify_day')); } catch (_e) {}
  if (lastDay === today) return;
  const events = (typeof getEvents === 'function') ? getEvents() : [];
  const urgent = events.filter(e => e.tone === 'urgent').length;
  const today_  = events.filter(e => e.tone === 'today').length;
  notifyIf(
    `${events.length} action${events.length===1?'':'s'} today`,
    urgent ? `${urgent} urgent · ${today_} today` : `${today_} today`
  );
  try { localStorage.setItem(k('ds_last_notify_day'), today); } catch (_e) {}
}
```

Call `scheduleDailySummary()` from `renderSummary`.

---

## Task 8: Wire moments into policy mutations

In `addPolicy` (or wherever new policies get pushed): right after a successful add, call `dashboardMomentApp(policy)`.

In the status-change code path (wherever a policy transitions to `placed`): call `dashboardMomentPlacement(policy)`.

In `renderSummary`, after computing the current streak, compare to `_lastSeenValue('streak')`:

```js
const streak = (typeof streakStats === 'function') ? streakStats().current : 0;
const prevStreak = _lastSeenValue('streak');
if (streak > prevStreak && (streak === 3 || streak === 7 || streak % 10 === 0)) dashboardMomentStreak(streak);
if (prevStreak >= 3 && streak === 0) dashboardMomentStreakBreak(prevStreak);
_storeLastValue('streak', streak);
```

---

## Task 9: Count-up integration into existing renderers

Touch each renderer from Phases 1.1–6 and replace direct `.textContent = '$X'` assignments on hero numbers with the `_kpi(key, el, newValue, fmt)` helper. Keyed values to migrate:

- `sgh-pulse-num` → `_kpi('pulse', numEl, score, v => Math.round(v))`
- Smart Goal Hub side rows → `_kpi('ap-month', valEl, ap, fmt$)`
- `pf-seg__count` and `pf-seg__ap` → `_kpi('pipe-' + stage.key, cnt, list.length, v => Math.round(v))`
- Income Reality hero numbers
- Streaks `am-streak__num`
- Bonus Tier Intelligence `bti-ladder__sub` AP totals

These are mechanical replacements. Don't refactor structure — only swap the assignment.

---

## Task 10: Snapshot + docs + memory

- [ ] Snapshot.
- [ ] `docs/architecture.md` Phase 7 section.
- [ ] `memory/project_polish_motion.md` documenting `_kpi`, moments, layout, notifications.
- [ ] `MEMORY.md` + vault log.

---

## Self-Review

| Vision §7 requirement | Where |
|---|---|
| Numbers count up from last seen value | Task 2 `_kpi` + Task 9 integration |
| Ring fills animate | Already done in Phase 0 `dsProgressRing` |
| Action items collapse with micro-animation | Already done in Phase 0 `dsActionItem` |
| Sparklines draw left-to-right on first paint | Deferred — current `dsSparkline` paints instant; a stroke-dashoffset draw-on animation is a v2 polish, doc'd as gap |
| Greeting adapts | Task 5 `renderGreeting` |
| Configurable widget order | Task 6 `_wireReorder` + `applyDashboardLayout` |
| Light/dark support for new components | All new CSS authored against `--ds-*` tokens; works in both |
| Browser/push notifications | Task 7 `requestDashboardNotifications` + `scheduleDailySummary` |
| App-submit celebration | Task 3 `dashboardMomentApp` + Task 8 wiring |
| Policy-place celebration | Task 3 `dashboardMomentPlacement` + Task 8 wiring |
| Goal-hit takeover | Deferred — needs a goal-hit detection point; a follow-up plan when goals get richer |
| Streak break empathetic | Task 3 `dashboardMomentStreakBreak` + Task 8 wiring |
| Moments opt-in | Task 3 `_momentsEnabled` + `setMomentsEnabled` |

**Acceptance:** Agent describes the dashboard as "fun to open." Manual UX feedback only.
