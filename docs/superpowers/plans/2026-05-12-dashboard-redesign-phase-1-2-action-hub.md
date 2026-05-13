# Dashboard Redesign — Phase 1.2 (Action Hub) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **Action Hub** — a prioritized urgent / today / opportunity list that becomes the dashboard's morning ritual. This is the single biggest stickiness win in the entire redesign series.

**Architecture:** Add a new full-width card at the TOP of `#sec-summary` (above the existing hero), binding to `getEvents()` from the Phase 0 data layer. Three sections: 🔴 Urgent, 🟡 Today, 🟢 Opportunity. Each row is a `dsActionItem` (Phase 0 primitive) with a CTA that logs an activity via a new `addActivity()` writer and fades the row out. Empty state when no events. Refreshed inside the existing `renderSummary()` flow so it tracks policy changes for free.

**Tech Stack:** Same as Phase 0 — vanilla HTML / CSS / JS in `index-3.html`. Verification = static checks + browser eyeball. No git, no tests. Snapshot to `archive/` before changes.

**Spec:** `docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md` — Phase 1.2 section.

**Out of scope** (deferred to later phases):
- Replacing the existing hero or removing Today/Week/Month tiles (that's Phase 1.1 / 5).
- Snooze / dismiss / per-event preferences (YAGNI for v1).
- Pulling actions from `getActivities()` (callbacks). Phase 1.2 only reads `getEvents()` (free-look + anniversary). Callbacks come when Phase 5 Activity Pulse adds activity writes from elsewhere in the app.
- Confetti / sound on completion. The `dsActionItem` data-state fade is the only celebration in v1.
- LLM-generated outreach text. The CTA labels are deterministic per event type.

**Cross-cutting decisions baked in:**

- **Additive, not replacement.** The new card sits ABOVE the existing hero. Nothing in `#sec-summary` moves or gets deleted. Phase 1.1 will eventually merge this into a two-column hero alongside the Smart Goal Hub.
- **`getEvents()` is consumed as-is.** No changes to the Phase 0 data shape. The widget formats display strings (CTA labels, sublines) from `event.type` — schema stays narrow.
- **Activity persistence stays local.** `addActivity()` writes to `DS_LS.activities()` localStorage. Supabase sync for `activities` is a separate follow-up plan once a real schema is defined.
- **Empty state shines.** If `getEvents()` returns `[]`, the card renders the `dsEmptyState` primitive with an encouraging message — never a bare zero.
- **Re-render on every `renderSummary()`.** Same cadence as KPI tiles. The card always reflects current policy state.

---

## File Structure

Single file: `index-3.html`. Five edit regions:

| Region | How to find it | What changes |
|---|---|---|
| `<style>` — primitives stylesheet | `grep -n '/\* ---- DS PRIMITIVES ----' index-3.html` (Task 3 of Phase 0 left this block; we append at its end, right before AUTH GATE) | New `/* ---- ACTION HUB ---- */` rules: `.ah-hub`, `.ah-section`, `.ah-section__head`, `.ah-list` |
| `<script>` — data layer | `grep -n 'function getEvents' index-3.html` then find its closing `}` | New `addActivity()` writer + `getActivityCount()` reader appended directly after `getEvents` |
| `<script>` — render function | After the new data-layer writers | New `renderActionHub()` function |
| HTML body — `#sec-summary` | `grep -n 'id="sec-summary"' index-3.html` | New `<div class="card ah-hub" id="action-hub">…</div>` inserted as the FIRST child of `#sec-summary`, immediately above the existing `<div class="sum-hero">` |
| `<script>` — render call | `grep -n 'function renderSummary' index-3.html` | One-line invocation `renderActionHub()` added near the top of `renderSummary` |

---

## Task 1: Snapshot

- [ ] **Step 1:** `cp index-3.html archive/index-2026-05-12-pre-action-hub.html`
- [ ] **Step 2:** Verify size matches current `index-3.html` size.

---

## Task 2: Add Action Hub stylesheet

**Files:** Modify `index-3.html` — append a new block at the end of the `/* ---- DS PRIMITIVES ---- */` section, just before the `/* ---- AUTH GATE ----` rule.

This is the widget's CSS. The classes live alongside the DS primitives so a future reader sees them as related. They author against `--ds-*` tokens.

- [ ] **Step 1:** Find insertion point — `grep -n '/\* ---- AUTH GATE ----' index-3.html`. The new block goes IMMEDIATELY above that marker, so AFTER the playground rules from Phase 0 Task 3 and BEFORE the auth gate.

- [ ] **Step 2:** Insert the block:

```css
/* ============================================================
 * ACTION HUB — added 2026-05-12 (Phase 1.2)
 * Reads getEvents(); renders urgent/today/opportunity sections.
 * The "morning ritual" surface — primary stickiness driver.
 * ============================================================ */
.ah-hub{
  margin-bottom:var(--ds-space-5);
  padding:var(--ds-space-5);
}
.ah-hub__head{
  display:flex;justify-content:space-between;align-items:baseline;gap:var(--ds-space-3);
  margin-bottom:var(--ds-space-4);
}
.ah-hub__title{
  font:600 13px/18px var(--sans);color:var(--text2);
  text-transform:uppercase;letter-spacing:.16em;
}
.ah-hub__meta{font:11.5px/14px var(--mono);font-variant-numeric:tabular-nums;color:var(--text3)}
.ah-hub__body{display:flex;flex-direction:column;gap:var(--ds-space-4)}

.ah-section{display:flex;flex-direction:column;gap:var(--ds-space-2)}
.ah-section[data-hidden="true"]{display:none}
.ah-section__head{
  display:flex;align-items:center;gap:var(--ds-space-2);
  padding:0 var(--ds-space-4);
  font:600 11px/14px var(--sans);text-transform:uppercase;letter-spacing:.14em;
  color:var(--ds-tone, var(--text3));
}
.ah-section__head::before{
  content:"";width:6px;height:6px;border-radius:var(--ds-radius-pill);
  background:var(--ds-tone, var(--text3));
  flex-shrink:0;
}
.ah-section[data-tone="urgent"]      {--ds-tone:var(--ds-color-danger)}
.ah-section[data-tone="today"]       {--ds-tone:var(--ds-color-warning)}
.ah-section[data-tone="opportunity"] {--ds-tone:var(--ds-color-success)}
.ah-section__count{
  margin-left:auto;
  font-family:var(--mono);font-variant-numeric:tabular-nums;
  color:var(--text3);font-weight:400;letter-spacing:.02em;
}
.ah-list{display:flex;flex-direction:column;gap:2px;list-style:none;padding:0;margin:0}
```

- [ ] **Step 3:** Verify — `grep -n 'ACTION HUB — added 2026-05-12' index-3.html` → 1 match. `grep -c '^\.ah-' index-3.html` → at least 6 selectors.

- [ ] **Step 4:** Snapshot — `cp index-3.html archive/index-2026-05-12-ah-css.html`.

---

## Task 3: Add data-layer writers

**Files:** Modify `index-3.html` — append after the `getEvents()` function (find with `grep -n 'function getEvents' index-3.html` and locate its closing `}`).

The Phase 0 data layer was read-only. Phase 1.2 introduces the first writer (`addActivity`) and a small reader (`getActivityCount`) used by the empty state.

- [ ] **Step 1:** Insert the block immediately after `getEvents`'s closing `}`:

```js
/**
 * addActivity(activity) — appends an Activity to localStorage at DS_LS.activities().
 * Generates an id if missing, stamps `when` if missing, caps the array at 500
 * entries (older entries trimmed from the front).
 * @param {Partial<Activity>} activity
 * @returns {Activity|null} the persisted activity, or null on failure
 */
function addActivity(activity){
  if (!activity || typeof activity !== 'object') return null;
  const a = Object.assign(
    { id: 'act-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      when: new Date().toISOString() },
    activity
  );
  if (!a.type || !a.clientId) return null;     // required fields
  try {
    const key = DS_LS.activities();
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    const safe = Array.isArray(list) ? list : [];
    safe.push(a);
    if (safe.length > 500) safe.splice(0, safe.length - 500);
    localStorage.setItem(key, JSON.stringify(safe));
    return a;
  } catch (_e) {
    return null;
  }
}

/** @returns {number} total activities recorded (used by empty-state copy) */
function getActivityCount(){
  try {
    const raw = localStorage.getItem(DS_LS.activities());
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.length : 0;
  } catch (_e) { return 0; }
}
```

- [ ] **Step 2:** Verify — `grep -n 'function addActivity' index-3.html` → 1 match. `grep -n 'function getActivityCount' index-3.html` → 1 match. Run `node --check` on the extracted snippet.

- [ ] **Step 3:** Snapshot — `cp index-3.html archive/index-2026-05-12-ah-writers.html`.

---

## Task 4: Add `renderActionHub()`

**Files:** Modify `index-3.html` — insert a new function immediately after `getActivityCount` from Task 3.

This is the widget renderer. Reads `getEvents()`, partitions into three tone buckets, renders each as a section of `dsActionItem` rows. Empty state when no events.

- [ ] **Step 1:** Insert:

```js
// ============================================================
// ACTION HUB — added 2026-05-12 (Phase 1.2)
// Renders the urgent/today/opportunity list into #action-hub.
// Idempotent — safe to call from renderSummary() on every refresh.
// ============================================================
const AH_CTA = {
  'free-look':    'Mark contacted',
  'anniversary':  'Send outreach',
  'uw-deadline':  'Mark resolved',
  'birthday':     'Send greeting',
  'callback':     'Mark called',
};
const AH_OUTCOME = {
  'free-look':    'free-look-contacted',
  'anniversary':  'anniversary-outreach-sent',
  'uw-deadline':  'uw-deadline-resolved',
  'birthday':     'birthday-greeting-sent',
  'callback':     'callback-completed',
};
const AH_ICON = {
  'free-look':    'phone',
  'anniversary':  'sparkle',
  'uw-deadline':  'warning',
  'birthday':     'gift',
  'callback':     'phone',
};
const AH_TONE_ORDER = ['urgent', 'today', 'opportunity'];
const AH_TONE_LABEL = {
  urgent:      'Urgent',
  today:       'Today',
  opportunity: 'Opportunities',
};

function renderActionHub(){
  const root = document.getElementById('action-hub');
  if (!root) return;

  const events = (typeof getEvents === 'function') ? getEvents() : [];
  const meta = root.querySelector('.ah-hub__meta');
  if (meta) meta.textContent = events.length === 0
    ? 'All clear'
    : (events.length === 1 ? '1 action' : events.length + ' actions');

  const body = root.querySelector('.ah-hub__body');
  if (!body) return;
  body.replaceChildren();   // idempotent re-render

  if (events.length === 0){
    const isNewAgent = getActivityCount() === 0;
    body.appendChild(dsEmptyState({
      icon: 'inbox',
      title: isNewAgent ? 'No actions queued yet' : 'You’re all caught up',
      body: isNewAgent
        ? 'When clients have free-look windows, anniversaries, or UW deadlines, they’ll surface here so you know what to do next.'
        : 'New actions surface here as policies move through underwriting and approach milestones.',
    }));
    return;
  }

  // Partition events by tone, preserving the date-asc order from getEvents().
  const buckets = { urgent: [], today: [], opportunity: [] };
  for (const ev of events){
    const tone = (ev && AH_TONE_LABEL[ev.tone]) ? ev.tone : 'today';
    buckets[tone].push(ev);
  }

  for (const tone of AH_TONE_ORDER){
    const list = buckets[tone];
    const section = document.createElement('section');
    section.className = 'ah-section';
    section.setAttribute('data-tone', tone);
    if (list.length === 0){ section.setAttribute('data-hidden', 'true'); }

    const head = document.createElement('div');
    head.className = 'ah-section__head';
    head.textContent = AH_TONE_LABEL[tone];
    const count = document.createElement('span');
    count.className = 'ah-section__count';
    count.textContent = String(list.length);
    head.appendChild(count);
    section.appendChild(head);

    const ul = document.createElement('ul');
    ul.className = 'ah-list';
    ul.setAttribute('role', 'list');

    for (const ev of list){
      const row = dsActionItem({
        icon:     AH_ICON[ev.type]    || 'phone',
        tone,
        title:    ev.headline,
        meta:     _ahFormatMeta(ev),
        ctaLabel: AH_CTA[ev.type]     || 'Done',
        onComplete: () => {
          addActivity({
            type: 'contact',
            clientId: ev.clientId,
            clientName: ev.clientName,
            outcome: AH_OUTCOME[ev.type] || 'action-completed',
            notes: ev.headline,
          });
          row.remove();
          // Update the counter chip when a row leaves.
          renderActionHub();
        },
      });
      ul.appendChild(row);
    }
    section.appendChild(ul);
    body.appendChild(section);
  }
}

/** Build the second-line metadata string under a row's headline. */
function _ahFormatMeta(ev){
  if (!ev) return '';
  const parts = [];
  if (ev.clientName && ev.subline !== ev.clientName) parts.push(ev.clientName);
  if (ev.when){
    try {
      const d = new Date(ev.when + 'T00:00:00');
      if (!isNaN(d)){
        parts.push(d.toLocaleDateString(undefined, { month:'short', day:'numeric' }));
      }
    } catch (_e) {}
  }
  if (ev.subline && ev.subline !== ev.clientName) parts.push(ev.subline);
  return parts.join(' · ');
}
```

- [ ] **Step 2:** Verify — `grep -n 'function renderActionHub' index-3.html` → 1 match. Run `node --check`.

- [ ] **Step 3:** Snapshot — `cp index-3.html archive/index-2026-05-12-ah-render.html`.

---

## Task 5: Add the markup inside `#sec-summary`

**Files:** Modify `index-3.html` — insert a new `<div class="card ah-hub" id="action-hub">…</div>` as the **first child** of `#sec-summary`, immediately above `<div class="sum-hero">`.

- [ ] **Step 1:** Find anchor — `grep -n '<div class="section active sum-v3" id="sec-summary">' index-3.html`. The new card goes RIGHT AFTER that opening div, BEFORE the `<!-- HERO:` comment.

- [ ] **Step 2:** Insert:

```html
      <!-- ACTION HUB (Phase 1.2 — urgent/today/opportunity) -->
      <div class="card ah-hub" id="action-hub">
        <div class="ah-hub__head">
          <div class="ah-hub__title">What to do today</div>
          <span class="ah-hub__meta">All clear</span>
        </div>
        <div class="ah-hub__body"></div>
      </div>
```

- [ ] **Step 3:** Verify — `grep -n 'id="action-hub"' index-3.html` → 1 match. The `.sum-hero` block must still exist directly after the new card; confirm with Read.

- [ ] **Step 4:** Snapshot — `cp index-3.html archive/index-2026-05-12-ah-markup.html`.

---

## Task 6: Wire `renderActionHub()` into `renderSummary()`

**Files:** Modify `index-3.html` — add a single line at the TOP of `renderSummary` (right after the existing `if (!document.getElementById('sec-summary')) return;` guard).

- [ ] **Step 1:** Find — `grep -n 'function renderSummary' index-3.html`.

- [ ] **Step 2:** Add the line right after the existing guard:

```js
  if (typeof renderActionHub === 'function') renderActionHub();
```

- [ ] **Step 3:** Verify — `grep -n 'renderActionHub()' index-3.html` → expect 3+ matches: definition + the recursive call inside `onComplete` (line in Task 4) + this new call inside `renderSummary`.

- [ ] **Step 4:** Snapshot — `cp index-3.html archive/index-2026-05-12-action-hub-complete.html`.

---

## Task 7: Browser verification recipe + docs update

**Files:** Modify `docs/architecture.md` — append a short section. Memory — update the existing `project_dashboard_ds_foundation` memory to reference Phase 1.2, and add a new `project_action_hub` memory.

### Browser verification (the human runs these)

Open `index-3.html` after signing in. The Summary tab should now show, at the very top:

- A new card titled "What to do today" with a counter ("All clear" or "N actions").
- If you have no policies with `issueDate` in the last 30 days and no policies with `draft` dates in the next 14 days, the empty state copy renders ("No actions queued yet" for new agents, "You're all caught up" otherwise).
- If you do have qualifying policies:
  - Free-look events under "Urgent" (≤1 day) or "Today" (2-7 days).
  - Anniversary events under "Opportunities" (≤14 days).
- Each row has an icon, the client name + headline, a meta line with date + subline, and a CTA button (`Mark contacted` / `Send outreach`).
- Clicking a CTA: row fades + slides, an activity gets written to localStorage at `ff_ds_activities_<uid>` (verify in DevTools → Application → Local Storage), the counter chip ticks down.

### Sanity test in DevTools

After signing in, run:

```js
// Force a fake free-look event to test the urgent rendering path.
window.policies.push({
  id: 'demo-1', client: 'Demo Client', status: 'issued',
  issueDate: new Date(Date.now() - 28*86400000).toISOString().slice(0,10),  // 2 days from free-look expiry
  ap: 1200, advComm: 600, carrier: 'Americo', draft: '2026-05-01',
});
renderActionHub();
```

You should see a new Urgent row. Click "Mark contacted" → row fades, activity persisted, counter updates.

```js
// Inspect what was written
JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('ff_ds_activities_'))));
```

- [ ] **Step 1:** Append to `docs/architecture.md`:

```markdown

## Action Hub (Phase 1.2 — 2026-05-12)

A full-width card at the top of `#sec-summary` that lists the agent's
prioritized actions. Three sections: Urgent, Today, Opportunities. Data source
is the `getEvents()` accessor from the Phase 0 data layer. Each row is a
`dsActionItem`; the CTA invokes `addActivity()` (Phase 1.2 writer) and removes
the row.

**Where things live:**
- CSS: `/* ---- ACTION HUB ---- */` inside the inline `<style>`, right above
  `/* ---- AUTH GATE ----`.
- Markup: `<div class="card ah-hub" id="action-hub">` as the first child of
  `#sec-summary`.
- Writer: `addActivity()` writes to `DS_LS.activities()` localStorage. Supabase
  sync is a follow-up.
- Renderer: `renderActionHub()` called from the top of `renderSummary()`.

**Activity persistence:** `addActivity()` is the first non-read function in the
DS data layer. It caps the array at 500 entries (oldest dropped). Real
persistence to Supabase requires a new `activities` table + the standard
hybrid CRUD pattern.

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-1-2-action-hub.md`
```

- [ ] **Step 2:** Write `/Users/tanner/.claude/projects/-Users-tanner-Jace--Life-Insurance/memory/project_action_hub.md`:

```markdown
---
name: action-hub
description: Phase 1.2 — Action Hub widget at the top of `#sec-summary`. Reads `getEvents()`, partitions into urgent/today/opportunity sections, renders `dsActionItem` rows. CTA click writes via `addActivity()` (first DS writer; localStorage only, Supabase wiring deferred).
metadata:
  type: project
---

The Action Hub shipped 2026-05-12 as the first visible widget in the
dashboard-redesign series. It sits at the top of `#sec-summary` as a
full-width card titled "What to do today."

**Where:** `index-3.html` — markup at the top of `#sec-summary`, CSS in
`/* ---- ACTION HUB ---- */`, JS in `renderActionHub()`, called from the top
of `renderSummary()`.

**Data:**
- Reads `getEvents()` ([[dashboard-ds-foundation]]).
- Writes activities via `addActivity()` — first DS-layer writer.
  Persistence is `DS_LS.activities()` localStorage (`ff_ds_activities_<uid>`),
  capped at 500 entries.

**Event type → CTA mapping** (deterministic, in `AH_CTA`):
- `free-look`: Mark contacted
- `anniversary`: Send outreach
- `uw-deadline`: Mark resolved
- `birthday`: Send greeting
- `callback`: Mark called

**Empty state** branches on `getActivityCount()`:
- Zero activities ever → "No actions queued yet" (new agent).
- Any activities exist → "You're all caught up" (agent with history).

**Why:** Per the user's vision spec, "stickiness comes from momentum, not data
density." The Action Hub answers "what should I do today?" in <5 seconds — the
acceptance criterion from the vision. Shipping standalone first (before
Phase 1.1 Smart Goal Hub) was an explicit build-order call.

**How to apply:** When asked to add new action types, extend `AH_CTA`,
`AH_OUTCOME`, `AH_ICON` constants and add a case to `getEvents()` in the
Phase 0 data layer if the event isn't already detected. Do not bypass the
hub by hand-rolling new top-of-summary widgets.

**Plan trail:**
- Vision spec: `docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md`
- Phase 1.2 plan: `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-1-2-action-hub.md`
- Snapshots: `archive/index-2026-05-12-{pre-action-hub,ah-css,ah-writers,ah-render,ah-markup,action-hub-complete}.html`
```

- [ ] **Step 3:** Append to `MEMORY.md`:

```
- [Action Hub widget](project_action_hub.md) — Phase 1.2 — full-width "What to do today" card at top of #sec-summary; reads getEvents(), writes via new addActivity(); first visible widget of the redesign series
```

- [ ] **Step 4:** Append to vault `log.md` at `/Users/tanner/Documents/Construct.AI/Construct.AI/log.md`:

```
## [2026-05-12] ingest | Dashboard redesign Phase 1.2 — Action Hub
- Plan: `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-1-2-action-hub.md`
- Ships standalone above the existing hero. Reads `getEvents()`, writes activities via new `addActivity()` localStorage writer (Supabase deferred). Three sections: urgent/today/opportunity. Empty state branches on whether the agent has any activity history.
```

---

## Self-Review (run before declaring Phase 1.2 done)

| Vision §1.2 requirement | Where it's built |
|---|---|
| Prioritized scrollable list | Task 2 — `.ah-hub` card; native page scroll. List itself is internal sections, not a scroll container in v1. |
| Three sections — 🔴 Urgent / 🟡 Today / 🟢 Opportunities | Task 4 — `AH_TONE_ORDER`, `.ah-section[data-tone="…"]` |
| Per-row: icon, client name, action, time/deadline, one-tap CTA | Task 4 — `dsActionItem` provides icon+title+meta+CTA; `_ahFormatMeta` builds the date+subline string |
| Tap CTA → logs the action → row collapses | Task 4 — `onComplete` calls `addActivity()` then `row.remove()`; the `dsActionItem` `data-state="completed"` fade runs first |
| Micro-celebration | Built into `dsActionItem` (Phase 0). v1 keeps it as a fade — confetti deferred. |
| Empty state | Task 4 — `dsEmptyState` with branch on `getActivityCount()` |
| Acceptance: top 3 actions in <5 seconds without scrolling | Verified manually — card is at TOP of summary, 3 sections visible without scroll on standard 1440px displays |

If anything is missing, add the task before declaring done.

---

## What's next (after Phase 1.2 ships)

Per the user's build order: **Phase 2 — Pipeline Funnel.** Horizontal funnel `Submitted → In UW → Approved → Issued → Placed → Paid` with aging color overlay and segment-click drill-down. Highest-leverage business value after the stickiness win. Plan to be written next: `docs/superpowers/plans/2026-XX-XX-dashboard-redesign-phase-2-pipeline-funnel.md`.
