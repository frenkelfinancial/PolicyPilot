# Summary Page Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone "quest tracker" theme on `#sec-summary` with Producer Stack tokens (matching the rest of the dashboard, supporting `body.light`) and rebuild the Bonus Milestones card as a "Pace & Forecast" treatment driven by program-native time windows.

**Architecture:** All work lands in the single-file app `index-3.html`. We rewrite the `.sum-v3 *` CSS block from local `--sv-*` tokens to the shared `:root` Producer Stack tokens, restructure the hero into two cards, replace the milestone card markup, and add new JS helpers (`AMERICO_WINDOW`, `amAmWindow`, `pacePosition`, `paceTagFor`, `renderGoalScorecard`, `renderPaceRow`) while deleting the obsolete `renderMilestoneBar` and `renderVPTrack`. Existing wiring (`renderSummary` data flow, click handlers, IDs read by other sections) is preserved.

**Tech Stack:** Vanilla HTML / CSS / JS in a single `index-3.html`. No build step, no test framework — verification is visual + console smoke checks in a browser. No git history available; we snapshot the file to `archive/` before changes.

**Spec:** `docs/superpowers/specs/2026-05-10-summary-restyle-design.md`

---

## File Structure

Single file: `index-3.html`. Edits land in three regions:

| Region | Approx. line range (stale — `grep -n` at edit time) | What changes |
|---|---|---|
| `<style>` block | 582 – 762 (the `/* ---- SUMMARY TAB (v3 modern bold) ---- */` block) | Rewritten end-to-end with Producer Stack tokens. Pace-card rules added. |
| HTML body — `#sec-summary` | 946 – 1114 | Hero block restructured; `.milestone-card` block replaced with `.pace-card`. |
| `<script>` inline | 4143 – 4200 (`renderMilestoneBar`, `renderVPTrack`), 4202 – 4213 (milestone constants), 4215+ (`renderSummary`) | New constants and helpers added; `renderMilestoneBar` + `renderVPTrack` deleted; `renderSummary` rewired. |

Use `grep -n '/* ---- SUMMARY TAB'`, `grep -n 'id="sec-summary"'`, `grep -n 'function renderSummary'`, `grep -n 'function renderMilestoneBar'`, `grep -n 'const AM_MILESTONES'` at edit time to find current line numbers — the architecture doc notes line numbers drift.

---

## Task 1: Snapshot + add JS helpers and constants

**Files:**
- Snapshot: `archive/index-2026-05-10-pre-summary-restyle.html` (copy of `index-3.html`)
- Modify: `index-3.html` — script region near `const AM_MILESTONES = [...]` (grep `grep -n 'const AM_MILESTONES'`)

This task is JS-only and adds nothing visible. After it, the page should still look identical, but the new helpers are available in the console.

- [ ] **Step 1: Snapshot the file**

Run from the project root:

```bash
cp "index-3.html" "archive/index-2026-05-10-pre-summary-restyle.html"
```

Expected: a new file appears in `archive/`. Confirm with `ls archive/ | grep 2026-05-10`.

- [ ] **Step 2: Find the insertion point**

Run:

```bash
grep -n 'const AM_MILESTONES' index-3.html
grep -n 'const AMAM_MILESTONES' index-3.html
```

You'll get two adjacent line numbers (currently around 4202 and 4209). The insertion goes **immediately after** the `AMAM_MILESTONES` declaration.

- [ ] **Step 3: Add the new constants and helpers**

Insert this block right after the `AMAM_MILESTONES` array (after its closing `];`):

```js
// ---- Pace & forecast helpers ----
// REFRESH: when the next UFirst contest window is announced (current cycle ends 2026-05-29).
const AMERICO_WINDOW = { start: '2025-12-01', end: '2026-05-29' };

function amAmWindow(today) {
  const t = today || new Date();
  const s = new Date(t.getFullYear(), t.getMonth(), 1);
  const e = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  return {
    start: s.toISOString().split('T')[0],
    end:   e.toISOString().split('T')[0],
  };
}

// Returns { daysElapsed, daysTotal, projected } for a fixed [start, end] window.
function pacePosition(current, win, today) {
  const t = today || new Date();
  const start = new Date(win.start + 'T00:00:00');
  const end   = new Date(win.end   + 'T23:59:59');
  const daysTotal   = Math.max(1, Math.round((end - start) / 86400000));
  const daysElapsed = Math.max(0, Math.min(daysTotal,
    Math.round((t - start) / 86400000)));
  const projected = daysElapsed >= 1 ? current * (daysTotal / daysElapsed) : 0;
  return { daysElapsed, daysTotal, projected };
}

// 'on' | 'behind' | 'ahead' based on projection vs next / next-after tiers.
function paceTagFor(projected, nextTier, tierAfterNext) {
  if (tierAfterNext && projected >= tierAfterNext) return 'ahead';
  if (nextTier && projected >= nextTier) return 'on';
  return 'behind';
}

// Compact dollar format: 12345 -> "$12.3K", 100000 -> "$100K"
function fmtK(v) {
  const n = Number(v) || 0;
  if (n >= 1000) {
    const k = n / 1000;
    return '$' + (k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10)) + 'K';
  }
  return '$' + Math.round(n);
}
```

- [ ] **Step 4: Verify in the browser console**

Open `index-3.html` in a browser, sign in if needed, then open DevTools console. Paste each:

```js
AMERICO_WINDOW
// → {start: "2025-12-01", end: "2026-05-29"}

amAmWindow(new Date('2026-05-10'))
// → {start: "2026-05-01", end: "2026-05-31"}

pacePosition(45000, AMERICO_WINDOW, new Date('2026-03-01'))
// daysElapsed ~90, daysTotal ~179, projected ~89500

paceTagFor(89500, 55000, 75000)
// → "ahead"

paceTagFor(40000, 55000, 75000)
// → "behind"

fmtK(45000)  // → "$45K"
fmtK(11800)  // → "$11.8K"
fmtK(100000) // → "$100K"
```

Expected: each line returns the value in the comment. If anything throws or returns unexpected values, fix before proceeding.

---

## Task 2: Rewrite summary CSS (hero / KPI / period / status / donut / drafts)

**Files:**
- Modify: `index-3.html` — CSS region under `/* ---- SUMMARY TAB (v3 modern bold) ---- */`

This task replaces the bulk of the old neon CSS with Producer Stack token-driven rules. We **keep** the old `.milestone-card`, `.ms-bar`, `.ms-*`, `.ms-vp` rules in place for now — they'll be removed in Task 6 once the new pace-card replaces them. Between this task and Task 5 the milestone area will look stale (old neon bars on an otherwise clean page) — that's expected.

- [ ] **Step 1: Find the block**

Run:

```bash
grep -n '/* ---- SUMMARY TAB (v3 modern bold) ----' index-3.html
grep -n '/* ---- AUTH GATE ----' index-3.html
grep -n '\.milestone-card{' index-3.html
grep -n '\.ms-track{' index-3.html
```

Note: the SUMMARY TAB block starts at one line and ends just before AUTH GATE (currently ~line 767). The `.milestone-card` and `.ms-*` rules live inside that span (currently lines ~681–705). You will delete everything in `[SUMMARY_TAB_START, AUTH_GATE_START)` **except** the `.milestone-card { … }` and `.ms-* { … }` and `.ms-vp* { … }` rules. The simplest path: copy the block out, isolate the milestone rules, paste the new CSS, then re-append the milestone rules at the end of the new block.

- [ ] **Step 2: Isolate the milestone rules**

Before deleting anything, copy the milestone CSS rules into a scratch buffer so you can paste them back at the end. The block of rules to preserve looks roughly like:

```css
/* MILESTONE CARD */
.milestone-card{padding-bottom:18px}
.ms-track{margin-top:14px}
.ms-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.ms-name{font:13px/18px 'Inter Tight','Inter',var(--sans);font-weight:600;color:var(--sv-text);letter-spacing:.02em}
.ms-current{font:12px/16px 'JetBrains Mono','Consolas',ui-monospace;font-variant-numeric:tabular-nums;color:var(--sv-text2)}
.ms-current strong{color:#fff;font-weight:700}
.ms-bar{width:100%;height:60px;display:block;overflow:visible}
.ms-bar .ms-track-bg{fill:rgba(255,255,255,.06);stroke:none}
.ms-bar .ms-track-fill{fill:url(#msFill);stroke:none;width:0;transition:width 1s cubic-bezier(.34,1.2,.64,1)}
.ms-bar .ms-stop{fill:#0F2236;stroke:rgba(255,255,255,.18);stroke-width:1.5;transition:fill .2s, stroke .2s, r .2s}
.ms-bar .ms-stop.reached{fill:#34D399;stroke:#34D399;filter:drop-shadow(0 0 6px rgba(52,211,153,.6))}
.ms-bar .ms-stop.next{stroke:#22D3EE;stroke-width:2.5;filter:drop-shadow(0 0 8px rgba(34,211,238,.55))}
.ms-bar .ms-lbl{font:10px/14px 'Inter Tight','Inter',var(--sans);font-weight:600;fill:var(--sv-text2);text-anchor:middle;letter-spacing:.04em}
.ms-bar .ms-lbl.reached{fill:#6EE7B7}
.ms-bar .ms-lbl.next{fill:#7FE8FF}
.ms-vp{margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.06)}
.ms-vp-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.ms-vp-state{font:12px/16px 'JetBrains Mono','Consolas',ui-monospace;color:var(--sv-text2);font-weight:600}
.ms-vp-state.eligible{color:#6EE7B7;text-shadow:0 0 8px rgba(52,211,153,.4)}
.ms-vp-bar{height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden;position:relative}
.ms-vp-fill{height:100%;width:0;background:linear-gradient(90deg,#22D3EE 0%,#34D399 100%);border-radius:4px;transition:width 1s cubic-bezier(.34,1.2,.64,1);box-shadow:0 0 10px rgba(52,211,153,.4)}
.ms-vp-meta{font:11px/16px 'Inter Tight','Inter',var(--sans);color:var(--sv-text3);margin-top:8px}
```

Set those aside.

- [ ] **Step 3: Replace the entire SUMMARY TAB block with the new CSS**

Delete the whole `/* ---- SUMMARY TAB (v3 modern bold) ---- */ … ` block up to (but not including) the `/* ---- AUTH GATE ---- */` comment. Paste the milestone rules you isolated in Step 2 **at the end** of the new block (they remain unchanged for now).

New CSS to paste in place of the old block:

```css
/* ---- SUMMARY TAB (Producer Stack) ---- */
/* Now uses :root tokens — respects body.light. No --sv-* local tokens.
   Milestone (.ms-*) rules at the bottom are kept temporarily and will be
   removed when the pace-card lands in Task 6. */

.sum-v3{padding:0;margin:-12px -12px 0;padding:18px 22px 24px;min-height:calc(100vh - 80px);position:relative}
.sum-v3 .card{margin-bottom:18px;position:relative;overflow:hidden;transition:border-color .2s ease,box-shadow .2s ease,transform .2s ease}
.sum-v3 .card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.sum-v3 .kpi-label{font:11px/14px var(--sans);text-transform:uppercase;letter-spacing:.22em;color:var(--text3);font-weight:600}
.sum-v3 .btn-link{background:none;border:none;color:var(--accent);font:12px/16px var(--sans);font-weight:500;cursor:pointer;padding:0;letter-spacing:.04em}
.sum-v3 .btn-link:hover{color:var(--accent-2)}

/* HERO (two cards side-by-side) */
.sum-hero{display:grid;grid-template-columns:1fr 1.2fr;gap:18px;margin-bottom:18px}
.sum-v3 .hero-goal{display:flex;align-items:center;gap:22px}
.ring-wrap{position:relative;width:180px;height:180px;flex-shrink:0;cursor:pointer;transition:transform .2s ease}
.ring-wrap:hover{transform:scale(1.015)}
.goal-ring{width:180px;height:180px;display:block;transform:rotate(-90deg)}
.goal-track{fill:none;stroke:rgba(255,255,255,.06);stroke-width:12}
.goal-arc{fill:none;stroke:var(--accent);stroke-width:12;stroke-linecap:round;transition:stroke-dashoffset 1.1s cubic-bezier(.34,1.2,.64,1)}
body.light .goal-track{stroke:rgba(11,31,58,.08)}
.goal-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;width:140px}
.goal-eyebrow{font:10px/14px var(--sans);text-transform:uppercase;letter-spacing:.24em;color:var(--text3);margin-bottom:4px;font-weight:600}
.goal-num{font:800 28px/32px var(--display);color:var(--text);letter-spacing:-.01em}
.goal-target{font:12px/16px var(--mono);font-variant-numeric:tabular-nums;color:var(--text2);margin-top:3px}
.goal-meta{font:11px/16px var(--mono);font-variant-numeric:tabular-nums;color:var(--accent);margin-top:6px;font-weight:600}

/* Goal scorecard side panel */
.goal-side{flex:1;min-width:0}
.goal-side h3{font:700 14px/18px var(--display);margin-bottom:8px;color:var(--text)}
.goal-meta-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:13px}
.goal-meta-row:last-of-type{border-bottom:none}
body.light .goal-meta-row{border-bottom-color:rgba(11,31,58,.06)}
.goal-meta-row .lbl{color:var(--text2)}
.goal-meta-row .val{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text);font-weight:600}
.goal-edit{font:11px/14px var(--sans);color:var(--text3);margin-top:10px;cursor:pointer}

/* Streak + activity right column */
.hero-side{display:flex;flex-direction:column;gap:14px}
.streak-card{padding:14px 18px}
.streak-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.streak-eyebrow{font:11px/14px var(--sans);text-transform:uppercase;letter-spacing:.22em;color:var(--text3);font-weight:600}
.streak-flame{width:14px;height:14px;display:inline-flex;align-items:center;color:var(--a3)}
.streak-flame.active{color:var(--a3)}
.streak-flame svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2}
.streak-num{font:800 32px/36px var(--display);color:var(--text);margin:4px 0 8px;font-variant-numeric:tabular-nums}
.streak-strip{display:flex;gap:4px;margin-top:4px}
.streak-strip .day{flex:1;height:18px;border-radius:3px;background:rgba(255,255,255,.05)}
.streak-strip .day.hit{background:var(--a2)}
.streak-strip .day.today{outline:1.5px solid var(--accent);outline-offset:1.5px}
body.light .streak-strip .day{background:rgba(11,31,58,.06)}
.streak-sub{font:11px/14px var(--sans);color:var(--text3);margin-top:8px}

.activity-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.act-tile{padding:12px 14px}
.act-eyebrow{font:10px/14px var(--sans);text-transform:uppercase;letter-spacing:.2em;color:var(--text3);font-weight:600}
.act-num{font:800 24px/28px var(--display);color:var(--text);margin-top:3px;font-variant-numeric:tabular-nums}

/* PERIOD ROW */
.sum-period-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;flex-wrap:wrap;gap:12px}
.sum-period-chips{display:inline-flex;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:3px;gap:2px}
.period-chip{background:transparent;border:none;color:var(--text2);font:12.5px/16px var(--sans);font-weight:500;padding:7px 14px;border-radius:6px;cursor:pointer;transition:all .14s;letter-spacing:.04em}
.period-chip:hover{color:var(--text)}
.period-chip.active{background:var(--bg3);color:var(--text);box-shadow:0 1px 0 rgba(255,255,255,.06) inset}
body.light .period-chip.active{box-shadow:0 1px 0 rgba(11,31,58,.06) inset}
.sum-period-caption{font:11.5px/16px var(--sans);color:var(--text3);letter-spacing:.04em}

/* KPI GRID */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:18px}
.kpi-grid .card{margin-bottom:0;display:flex;flex-direction:column;min-height:170px;padding-top:20px}
.kpi-clickable{cursor:pointer}
.kpi-clickable::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;border-radius:12px 12px 0 0;background:var(--ac,var(--accent))}
.kpi-accent-green   {--ac:var(--a2)}     /* Adv Comm — mint */
.kpi-accent-cyan    {--ac:var(--accent)} /* AP Written — pastel blue */
.kpi-accent-gold    {--ac:var(--a3)}     /* Projected Bonus — warm tan */
.kpi-accent-magenta {--ac:var(--a5)}     /* Active Policies — lavender */
.kpi-clickable:hover{border-color:var(--ac);transform:translateY(-1px);box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 12px 28px -16px rgba(0,0,0,.6)}
body.light .kpi-clickable:hover{box-shadow:0 1px 0 rgba(11,31,58,.04) inset,0 8px 20px -12px rgba(11,31,58,.18)}
.kpi-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px}
.kpi-hero{font:800 28px/32px var(--display);color:var(--text);letter-spacing:-.01em;margin-bottom:8px;font-variant-numeric:tabular-nums}
.kpi-delta{font:10.5px/14px var(--mono);font-variant-numeric:tabular-nums;font-weight:600;padding:3px 7px;border-radius:4px;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;letter-spacing:.03em}
.kpi-delta:empty{display:none}
.kpi-delta.up   {background:rgba(92,201,167,.14);color:var(--a2)}
.kpi-delta.down {background:rgba(224,123,123,.14);color:var(--a4)}
.kpi-delta.flat {background:rgba(168,188,214,.10);color:var(--text2)}
.kpi-delta-static{background:rgba(224,184,132,.14);color:var(--a3);text-transform:uppercase;letter-spacing:.12em;font-size:9.5px}

/* SPARKLINE */
.kpi-spark{width:100%;height:42px;margin-top:auto;display:block;overflow:visible}
.kpi-spark .spark-fill{fill:var(--ac,var(--accent));fill-opacity:.12}
.kpi-spark .spark-line{fill:none;stroke:var(--ac,var(--accent));stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.kpi-spark .spark-empty{fill:none;stroke:rgba(255,255,255,.10);stroke-width:1;stroke-dasharray:3 3}
body.light .kpi-spark .spark-empty{stroke:rgba(11,31,58,.10)}

/* BONUS BREAKDOWN tags */
.kpi-bonus-breakdown{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:8px}
.kpi-bonus-breakdown .b-tag{font:10px/12px var(--sans);text-transform:uppercase;letter-spacing:.10em;color:var(--text2);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.05);padding:5px 8px;border-radius:5px}
.kpi-bonus-breakdown .b-tag em{font-family:var(--mono);font-style:normal;font-weight:600;color:var(--a3);margin-left:5px}
body.light .kpi-bonus-breakdown .b-tag{background:rgba(11,31,58,.04);border-color:rgba(11,31,58,.06)}

/* MID ROW: status + carrier mix */
.sum-mid-row{display:grid;grid-template-columns:1.7fr 1fr;gap:16px;margin-bottom:18px}
.sum-mid-row .card{margin-bottom:0}

/* STATUS BAR */
.status-bar{display:flex;width:100%;height:14px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.06);margin-top:14px}
body.light .status-bar{background:rgba(11,31,58,.06)}
.status-seg{height:100%;cursor:pointer;width:0;transition:width .8s cubic-bezier(.34,1.2,.64,1),filter .14s}
.status-seg:hover{filter:brightness(1.1)}
.status-seg.s-pending {background:var(--a3)}
.status-seg.s-approved{background:var(--a5)}
.status-seg.s-issued  {background:var(--a2)}
.status-seg.s-paid    {background:var(--accent)}
.status-seg.s-lapsed  {background:var(--a4)}
@media (prefers-reduced-motion: reduce){.status-seg{transition:none}}
.status-legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.status-legend .leg{display:flex;align-items:center;gap:6px;font:11.5px/14px var(--sans);color:var(--text2);cursor:pointer;padding:5px 9px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);border-radius:5px;transition:all .14s}
.status-legend .leg:hover{background:rgba(255,255,255,.07);color:var(--text)}
body.light .status-legend .leg{background:rgba(11,31,58,.03);border-color:rgba(11,31,58,.06)}
body.light .status-legend .leg:hover{background:rgba(11,31,58,.06)}
.status-legend .dot{width:8px;height:8px;border-radius:2px;display:inline-block}
.status-legend .leg-num{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text);font-weight:600;margin-left:2px}
.status-legend .leg-pct{color:var(--text3);font-size:10.5px;margin-left:1px}

/* CARRIER DONUT */
.mix-wrap{display:flex;align-items:center;gap:18px;margin-top:14px}
.mix-donut{width:120px;height:120px;flex-shrink:0}
.mix-donut .mix-arc{fill:none;stroke-width:14;stroke-linecap:butt;transition:stroke-width .14s}
.mix-donut .mix-arc:hover{stroke-width:18}
.mix-legend{flex:1;display:flex;flex-direction:column;gap:6px;font:12px/16px var(--sans);color:var(--text);min-width:0}
.mix-legend .row{display:flex;align-items:center;gap:8px;min-width:0}
.mix-legend .swatch{width:10px;height:10px;border-radius:2px;flex-shrink:0}
.mix-legend .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)}
.mix-legend .amt{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600;color:var(--text)}
.mix-empty{font-size:12px;color:var(--text3);font-style:italic}

/* DRAFTS STRIP */
.drafts-strip-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.drafts-strip-tbl{width:100%;border-collapse:collapse}
.drafts-strip-tbl tr{transition:background .14s}
.drafts-strip-tbl tr.clickable{cursor:pointer}
.drafts-strip-tbl tr.clickable:hover{background:rgba(143,194,247,.04)}
body.light .drafts-strip-tbl tr.clickable:hover{background:rgba(91,160,232,.06)}
.drafts-strip-tbl td{padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.04);font:13px/18px var(--sans);color:var(--text)}
body.light .drafts-strip-tbl td{border-bottom-color:rgba(11,31,58,.06)}
.drafts-strip-tbl tr:last-child td{border-bottom:none}
.drafts-strip-tbl td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;color:var(--text);font-weight:600}
.drafts-strip-tbl td.dim{color:var(--text3)}
.sum-v3 .empty{color:var(--text3);padding:32px;text-align:center}

@media (max-width:1100px){
  .sum-v3 .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .sum-v3 .sum-mid-row{grid-template-columns:1fr}
  .sum-v3 .sum-hero{grid-template-columns:1fr}
}
@media (max-width:640px){
  .sum-v3 .kpi-grid{grid-template-columns:1fr}
  .sum-v3 .mix-wrap{flex-direction:column;align-items:flex-start}
  .sum-v3 .activity-grid{grid-template-columns:1fr}
  .ring-wrap,.goal-ring{width:160px;height:160px}
}
@media (prefers-reduced-motion: reduce){
  .sum-v3 .card{transition:none}
  .goal-arc{transition:none}
}

/* === MILESTONE CARD (LEGACY — removed in Task 6) === */
.milestone-card{padding-bottom:18px}
.ms-track{margin-top:14px}
.ms-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.ms-name{font:13px/18px var(--sans);font-weight:600;color:var(--text);letter-spacing:.02em}
.ms-current{font:12px/16px var(--mono);font-variant-numeric:tabular-nums;color:var(--text2)}
.ms-current strong{color:var(--text);font-weight:700}
.ms-bar{width:100%;height:60px;display:block;overflow:visible}
.ms-bar .ms-track-bg{fill:rgba(255,255,255,.06);stroke:none}
.ms-bar .ms-track-fill{fill:url(#msFill);stroke:none}
.ms-bar .ms-stop{fill:var(--card);stroke:rgba(255,255,255,.18);stroke-width:1.5}
.ms-bar .ms-stop.reached{fill:var(--a2);stroke:var(--a2)}
.ms-bar .ms-stop.next{stroke:var(--accent);stroke-width:2.5}
.ms-bar .ms-lbl{font:10px/14px var(--sans);font-weight:600;fill:var(--text2);text-anchor:middle;letter-spacing:.04em}
.ms-bar .ms-lbl.reached{fill:var(--a2)}
.ms-bar .ms-lbl.next{fill:var(--accent)}
.ms-vp{margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.06)}
.ms-vp-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.ms-vp-state{font:12px/16px var(--mono);color:var(--text2);font-weight:600}
.ms-vp-state.eligible{color:var(--a2)}
.ms-vp-bar{height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden;position:relative}
.ms-vp-fill{height:100%;width:0;background:var(--accent);border-radius:4px;transition:width 1s cubic-bezier(.34,1.2,.64,1)}
.ms-vp-meta{font:11px/16px var(--sans);color:var(--text3);margin-top:8px}
```

Notes:
- The old `--sv-*` token block on `.sum-v3` is gone — all rules now reference `:root` tokens.
- `body.light` overrides are inline next to each dark-mode rule that uses `rgba(255,255,255,*)`.
- The `.milestone-card` and `.ms-*` rules at the bottom are kept temporarily (Task 6 deletes them) but are token-stripped so they don't bleed neon while the legacy markup is still on screen.

- [ ] **Step 4: Verify visual baseline**

Reload `index-3.html`, sign in, open the Summary tab. Walk through this checklist:

1. Page background matches the rest of the dashboard (no more `#06101F` dark surface).
2. Toggle the dark/light switch (top-right of the topbar). The summary page re-paints — no neon colors anywhere, all surfaces follow Producer Stack tokens.
3. Hero band still uses the OLD markup at this point — it will look broken (no two-card layout yet). That's expected; Task 3 restructures it.
4. KPI cards show four colored top borders: blue / mint / tan / lavender (was green / cyan / gold / magenta — class names retained for now).
5. Status bar segments and donut wedges use semantic Producer Stack colors. No `drop-shadow` glow on the donut.
6. Drafts strip hover row tint matches policy tracker.
7. Open DevTools and search the page CSS for `--sv-` — there should be **zero** matches inside the `.sum-v3` scope.
8. Search the page CSS for the hex literals `#34D399`, `#22D3EE`, `#F4C766`, `#E879F9`, `#06101F` — there should be **zero** matches inside the `.sum-v3` scope.

If any of those fail, stop and fix before moving on.

---

## Task 3: Restructure hero HTML + add `renderGoalScorecard`

**Files:**
- Modify: `index-3.html` — HTML block under `<div class="sum-hero">` (`grep -n 'class="sum-hero"'`)
- Modify: `index-3.html` — script region (insert `renderGoalScorecard` near `renderGoalRing`, wire into `renderSummary`)

- [ ] **Step 1: Find the hero block**

Run:

```bash
grep -n 'class="sum-hero"' index-3.html
grep -n 'class="sum-period-row"' index-3.html
```

The hero block runs from the `sum-hero` line down to (but not including) the `sum-period-row` line. Replace the entire `<div class="sum-hero"> … </div>` block with the new markup below.

- [ ] **Step 2: Replace the hero HTML**

```html
      <!-- HERO: goal ring + scorecard | streak + activity -->
      <div class="sum-hero">

        <!-- Left card: monthly goal ring + scorecard -->
        <div class="card hero-goal">
          <div class="ring-wrap" onclick="editMonthlyGoal()" title="Click to set your monthly AP goal">
            <svg class="goal-ring" viewBox="0 0 200 200" aria-hidden="true">
              <circle class="goal-track" cx="100" cy="100" r="84"/>
              <circle class="goal-arc"   cx="100" cy="100" r="84" id="goal-arc"
                      stroke-dasharray="527.79" stroke-dashoffset="527.79"/>
            </svg>
            <div class="goal-center">
              <div class="goal-eyebrow">Monthly Goal</div>
              <div class="goal-num"    id="goal-num">$0</div>
              <div class="goal-target" id="goal-target">of $0</div>
              <div class="goal-meta"   id="goal-meta">— days left</div>
            </div>
          </div>

          <div class="goal-side">
            <h3>Monthly AP Goal</h3>
            <div class="goal-meta-row">
              <span class="lbl">Pace needed</span>
              <span class="val" id="goal-pace-needed">—</span>
            </div>
            <div class="goal-meta-row">
              <span class="lbl">Avg this month</span>
              <span class="val" id="goal-avg-day">—</span>
            </div>
            <div class="goal-meta-row">
              <span class="lbl">Projected month-end</span>
              <span class="val" id="goal-projected">—</span>
            </div>
            <div class="goal-edit">Click ring to edit goal</div>
          </div>
        </div>

        <!-- Right column: streak + 2-up activity -->
        <div class="hero-side">
          <div class="card streak-card">
            <div class="streak-head">
              <span class="streak-eyebrow">Day Streak</span>
              <span class="streak-flame" id="streak-flame" aria-hidden="true">
                <svg viewBox="0 0 24 24" stroke="currentColor" fill="none"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
              </span>
            </div>
            <div class="streak-num" id="streak-num">0</div>
            <div class="streak-strip" id="streak-strip" aria-label="Last 14 days"></div>
            <div class="streak-sub" id="streak-sub">Days with at least one policy in the last 14</div>
          </div>

          <div class="activity-grid">
            <div class="card act-tile">
              <div class="act-eyebrow">Policies this month</div>
              <div class="act-num" id="act-month">0</div>
            </div>
            <div class="card act-tile">
              <div class="act-eyebrow">This week</div>
              <div class="act-num" id="act-week">0</div>
            </div>
          </div>
        </div>

      </div>
```

Preserved IDs: `goal-arc`, `goal-num`, `goal-target`, `goal-meta`, `streak-flame`, `streak-num`, `streak-strip`, `streak-sub`, `act-month`, `act-week`. The existing `renderGoalRing()`, `renderStreakModule()`, and the period-chip wiring continue to find them.

Note: the goal-ring circumference is now `2 * π * 84 ≈ 527.79`, so the existing `renderGoalRing()` function's `stroke-dasharray` math must also be `527.79`. Verify in Step 4.

- [ ] **Step 3: Add `renderGoalScorecard` and wire it into `renderSummary`**

Run `grep -n 'function renderGoalRing' index-3.html` — the new function goes immediately after `renderGoalRing`. Add this:

```js
function renderGoalScorecard(monthAP, goal, today) {
  const t = today || new Date();
  const daysElapsed = t.getDate();
  const daysTotal = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  const daysLeft = Math.max(0, daysTotal - daysElapsed);
  const remaining = Math.max(0, goal - monthAP);
  const paceNeeded = daysLeft > 0 ? remaining / daysLeft : 0;
  const avg = daysElapsed > 0 ? monthAP / daysElapsed : 0;
  const projected = avg * daysTotal;

  const paceEl = document.getElementById('goal-pace-needed');
  if (paceEl) paceEl.textContent = daysLeft > 0
    ? fmt$(paceNeeded).replace(/\.\d+$/, '') + '/day'
    : (monthAP >= goal ? 'goal hit' : '—');

  const avgEl = document.getElementById('goal-avg-day');
  if (avgEl) avgEl.textContent = fmt$(avg).replace(/\.\d+$/, '') + '/day';

  const projEl = document.getElementById('goal-projected');
  if (projEl) {
    projEl.textContent = fmt$(projected).replace(/\.\d+$/, '');
    projEl.style.color = goal > 0 && projected >= goal
      ? 'var(--a2)'
      : (goal > 0 ? 'var(--a4)' : 'var(--text)');
  }
}
```

Then find the call site:

```bash
grep -n 'renderGoalRing(monthAP' index-3.html
```

Right after the `renderGoalRing(monthAP, getMonthlyGoal(), today);` line, add:

```js
  renderGoalScorecard(monthAP, getMonthlyGoal(), today);
```

- [ ] **Step 4: Update the ring math constant**

Run:

```bash
grep -n 'stroke-dasharray' index-3.html | grep -i goal
grep -n '578\.05\|578\.0' index-3.html
```

The previous ring used `r=92` so circumference was `578.05`. The new ring uses `r=84` so circumference is `527.79`. Find any JS line that sets `goal-arc` `stroke-dasharray` or `stroke-dashoffset` to `578.05` and replace with `527.79`. Inside `renderGoalRing`, expect something like:

```js
arc.style.strokeDasharray = '578.05';
arc.style.strokeDashoffset = (578.05 * (1 - pct)).toString();
```

Replace with:

```js
arc.style.strokeDasharray = '527.79';
arc.style.strokeDashoffset = (527.79 * (1 - pct)).toString();
```

If the existing code uses a constant or computes from `r`, just update the radius value. Verify by reloading and watching the arc fill correctly.

- [ ] **Step 5: Verify visual**

Reload, open Summary. Walk through:

1. Hero is now two side-by-side cards (left: ring + scorecard, right: streak card + 2-up tiles).
2. Goal ring fills proportionally to your month-to-date AP / monthly goal. No glow, no gradient — solid pastel-blue stroke.
3. The three scorecard rows under the ring show real numbers (Pace needed, Avg this month, Projected month-end).
4. Projected month-end is mint if ≥ goal, soft red if < goal.
5. Streak number, 14-day strip, "today" outline, and the two activity tiles all populate as before.
6. Toggle `body.light` — the hero re-paints correctly with the navy stroke equivalents and ivory backgrounds.

---

## Task 4: Add pace-card CSS

**Files:**
- Modify: `index-3.html` — CSS region, **inside** the SUMMARY TAB block. Insert immediately before the `/* === MILESTONE CARD (LEGACY — removed in Task 6) === */` comment from Task 2.

- [ ] **Step 1: Find the insertion point**

```bash
grep -n 'MILESTONE CARD (LEGACY' index-3.html
```

Insert the new CSS just above that comment.

- [ ] **Step 2: Add pace-card CSS rules**

```css
/* PACE & FORECAST CARD (replaces .milestone-card) */
.pace-card{padding-bottom:18px}
.pace-row{display:grid;grid-template-columns:1.4fr 1fr;gap:28px;padding:16px 0;border-bottom:1px solid rgba(255,255,255,.05);align-items:center}
body.light .pace-row{border-bottom-color:rgba(11,31,58,.06)}
.pace-row:last-child{border-bottom:none;padding-bottom:4px}
.pace-row:first-of-type{padding-top:6px}
.pace-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.pace-name{font:700 14.5px/18px var(--sans);color:var(--text)}
.pace-window{font:11px/14px var(--mono);color:var(--text3);font-weight:500}
.pace-tag{padding:3px 9px;border-radius:4px;font:700 10.5px/14px var(--sans);letter-spacing:.05em;text-transform:uppercase}
.pace-tag.on     {background:rgba(92,201,167,.16);color:var(--a2)}
.pace-tag.behind {background:rgba(224,123,123,.16);color:var(--a4)}
.pace-tag.ahead  {background:rgba(143,194,247,.16);color:var(--accent-2)}
.pace-tag.flat   {background:rgba(168,188,214,.12);color:var(--text2)}
.pace-sub{font:13px/18px var(--sans);color:var(--text2)}
.pace-sub strong{color:var(--text);font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600}
.pace-forecast{font:12px/16px var(--sans);color:var(--text3);margin-top:5px}
.pace-forecast strong{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600}
.pace-bar-wrap{position:relative}
.pace-bar{position:relative;height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden}
body.light .pace-bar{background:rgba(11,31,58,.06)}
.pace-bar-cur{position:absolute;left:0;top:0;bottom:0;background:var(--accent);border-radius:3px;transition:width .8s cubic-bezier(.34,1.2,.64,1)}
.pace-bar-proj{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--a2);transition:left .8s cubic-bezier(.34,1.2,.64,1)}
.pace-bar-target{position:absolute;right:0;top:-3px;bottom:-3px;width:2px;background:rgba(255,255,255,.3)}
body.light .pace-bar-target{background:rgba(11,31,58,.3)}
.pace-bar-legend{display:flex;justify-content:space-between;font:10.5px/14px var(--mono);font-variant-numeric:tabular-nums;color:var(--text3);margin-top:6px}
.pace-bar-legend .cur  {color:var(--accent-2)}
.pace-bar-legend .proj {color:var(--a2)}
@media (prefers-reduced-motion: reduce){
  .pace-bar-cur,.pace-bar-proj{transition:none}
}
@media (max-width:900px){
  .pace-row{grid-template-columns:1fr;gap:14px}
}
```

- [ ] **Step 3: Verify it loads**

Reload the page and inspect the CSS in DevTools. The new `.pace-*` rules should be present. No visual change yet — the markup for them lands in Task 5.

---

## Task 5: Replace milestone HTML + add `renderPaceRow` + wire it into `renderSummary`

**Files:**
- Modify: `index-3.html` — HTML block under `<div class="card milestone-card">` (`grep -n 'class="card milestone-card"'`)
- Modify: `index-3.html` — script: add `renderPaceRow()`, rewire `renderSummary()` to call it.

- [ ] **Step 1: Replace the milestone HTML**

```bash
grep -n 'class="card milestone-card"' index-3.html
grep -n 'class="sum-mid-row"' index-3.html
```

Replace the entire `<div class="card milestone-card"> … </div>` block (it ends just before `<div class="sum-mid-row">`) with:

```html
      <!-- BONUS MILESTONES — Pace & Forecast -->
      <div class="card pace-card">
        <div class="card-head">
          <div class="kpi-label">Bonus Milestones</div>
          <button class="btn-link" onclick="nav('bonuses')">Open Bonus Tracker &rarr;</button>
        </div>

        <!-- Americo UFirst -->
        <div class="pace-row">
          <div>
            <div class="pace-head">
              <span class="pace-name">Americo UFirst</span>
              <span class="pace-window">Dec 1, 2025 &ndash; May 29, 2026</span>
              <span class="pace-tag flat" id="pace-am-tag">&mdash;</span>
            </div>
            <div class="pace-sub" id="pace-am-sub">&mdash;</div>
            <div class="pace-forecast" id="pace-am-forecast">&mdash;</div>
          </div>
          <div class="pace-bar-wrap">
            <div class="pace-bar">
              <div class="pace-bar-cur"    id="pace-am-bar-cur"  style="width:0%"></div>
              <div class="pace-bar-proj"   id="pace-am-bar-proj" style="left:0%"></div>
              <div class="pace-bar-target"></div>
            </div>
            <div class="pace-bar-legend">
              <span class="cur"  id="pace-am-legend-cur">$0 today</span>
              <span class="proj" id="pace-am-legend-proj"></span>
              <span         id="pace-am-legend-cap">$100K cap</span>
            </div>
          </div>
        </div>

        <!-- Am-Am Bonus Bucks -->
        <div class="pace-row">
          <div>
            <div class="pace-head">
              <span class="pace-name">Am-Am Bonus Bucks</span>
              <span class="pace-window" id="pace-amam-window">Month-to-date</span>
              <span class="pace-tag flat" id="pace-amam-tag">&mdash;</span>
            </div>
            <div class="pace-sub" id="pace-amam-sub">&mdash;</div>
            <div class="pace-forecast" id="pace-amam-forecast">&mdash;</div>
          </div>
          <div class="pace-bar-wrap">
            <div class="pace-bar">
              <div class="pace-bar-cur"    id="pace-amam-bar-cur"  style="width:0%"></div>
              <div class="pace-bar-proj"   id="pace-amam-bar-proj" style="left:0%"></div>
              <div class="pace-bar-target"></div>
            </div>
            <div class="pace-bar-legend">
              <span class="cur"  id="pace-amam-legend-cur">$0 today</span>
              <span class="proj" id="pace-amam-legend-proj"></span>
              <span         id="pace-amam-legend-cap">$20K cap</span>
            </div>
          </div>
        </div>

        <!-- FFL VP Track -->
        <div class="pace-row">
          <div>
            <div class="pace-head">
              <span class="pace-name">FFL VP Track</span>
              <span class="pace-window">Contract-level eligibility</span>
              <span class="pace-tag flat" id="pace-vp-tag">&mdash;</span>
            </div>
            <div class="pace-sub" id="pace-vp-sub">&mdash;</div>
            <div class="pace-forecast" id="pace-vp-forecast">&mdash;</div>
          </div>
          <div class="pace-bar-wrap">
            <div class="pace-bar">
              <div class="pace-bar-cur" id="pace-vp-bar-cur" style="width:0%"></div>
              <div class="pace-bar-target"></div>
            </div>
            <div class="pace-bar-legend">
              <span class="cur" id="pace-vp-legend-cur">100% today</span>
              <span></span>
              <span>VP @ 145%</span>
            </div>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Add `renderPaceRow` and the three program-specific build functions**

Run:

```bash
grep -n 'function renderVPTrack' index-3.html
```

Insert this block right before `function renderVPTrack` (we'll delete `renderVPTrack` in Task 6):

```js
// ---- Pace-row renderer + per-program builders ----

// prefix: 'pace-am' | 'pace-amam' | 'pace-vp'
// opts: { tag, tagText, sub, forecast, curPct, projPct (or null),
//         legendCur, legendProj, legendCap }
function renderPaceRow(prefix, opts) {
  const tagEl = document.getElementById(prefix + '-tag');
  if (tagEl) {
    tagEl.className = 'pace-tag ' + (opts.tag || 'flat');
    tagEl.textContent = opts.tagText || '';
  }
  const subEl = document.getElementById(prefix + '-sub');
  if (subEl) subEl.innerHTML = opts.sub || '';
  const fcEl = document.getElementById(prefix + '-forecast');
  if (fcEl) {
    fcEl.innerHTML = opts.forecast || '';
    fcEl.style.display = opts.forecast ? '' : 'none';
  }

  const curEl  = document.getElementById(prefix + '-bar-cur');
  if (curEl) curEl.style.width = Math.min(100, Math.max(0, opts.curPct || 0)) + '%';

  const projEl = document.getElementById(prefix + '-bar-proj');
  if (projEl) {
    if (opts.projPct == null) {
      projEl.style.display = 'none';
    } else {
      projEl.style.display = '';
      projEl.style.left = Math.min(100, Math.max(0, opts.projPct)) + '%';
    }
  }

  const lCur  = document.getElementById(prefix + '-legend-cur');
  const lProj = document.getElementById(prefix + '-legend-proj');
  const lCap  = document.getElementById(prefix + '-legend-cap');
  if (lCur)  lCur.textContent  = opts.legendCur  || '';
  if (lProj) lProj.textContent = opts.legendProj || '';
  if (lCap)  lCap.textContent  = opts.legendCap  || '';
}

function buildAmericoPaceOpts(current, pace) {
  const cap = 100000;
  const curPct = (current / cap) * 100;
  const tooEarly = pace.daysElapsed < 3;

  const nextIdx = AM_MILESTONES.findIndex(m => current < m.val);
  const next  = nextIdx >= 0 ? AM_MILESTONES[nextIdx] : null;
  const after = (nextIdx >= 0 && nextIdx + 1 < AM_MILESTONES.length)
    ? AM_MILESTONES[nextIdx + 1] : null;

  let tag = 'flat', tagText = '—', projPct = null, legendProj = '', forecast = '';

  if (tooEarly) {
    tag = 'flat'; tagText = 'Too early to project';
  } else if (!next) {
    tag = 'ahead'; tagText = 'Cap reached';
    projPct = 100;
    legendProj = 'cap reached';
    forecast = 'You’ve cleared the $100K cap. Bonus secured.';
  } else {
    tag = paceTagFor(pace.projected, next.val, after && after.val);
    tagText = tag === 'on' ? 'On pace' : tag === 'behind' ? 'Behind pace' : 'Ahead of pace';
    projPct = Math.min(100, (pace.projected / cap) * 100);
    legendProj = fmtK(pace.projected) + ' projected';

    // Highest tier the projection clears, if any.
    let landed = null;
    for (const m of AM_MILESTONES) { if (pace.projected >= m.val) landed = m; else break; }
    forecast = landed
      ? `At current pace you'll land at <strong>${fmtK(pace.projected)}</strong> by May 29 — clears the <strong>${fmtK(landed.val)}</strong> tier.`
      : `At current pace you'll land at <strong>${fmtK(pace.projected)}</strong> by May 29 — short of the <strong>${fmtK(next.val)}</strong> tier.`;
  }

  const gap = next ? Math.max(0, next.val - current) : 0;
  const sub = next
    ? `<strong>${fmtK(current)}</strong> credits · next tier <strong>${fmtK(next.val)}</strong> · <strong>${fmtK(gap)}</strong> to go`
    : `<strong>${fmtK(current)}</strong> credits · cap reached`;

  return {
    tag, tagText, sub, forecast,
    curPct, projPct,
    legendCur:  fmtK(current) + ' today',
    legendProj,
    legendCap:  '$100K cap',
  };
}

function buildAmAmPaceOpts(current, pace, win) {
  const cap = 20000;
  const curPct = (current / cap) * 100;
  const tooEarly = pace.daysElapsed < 3;

  const nextIdx = AMAM_MILESTONES.findIndex(m => current < m.val);
  const next  = nextIdx >= 0 ? AMAM_MILESTONES[nextIdx] : null;
  const after = (nextIdx >= 0 && nextIdx + 1 < AMAM_MILESTONES.length)
    ? AMAM_MILESTONES[nextIdx + 1] : null;

  let tag = 'flat', tagText = '—', projPct = null, legendProj = '', forecast = '';

  if (tooEarly) {
    tag = 'flat'; tagText = 'Too early to project';
  } else if (!next) {
    tag = 'ahead'; tagText = 'Platinum locked';
    projPct = 100;
    legendProj = 'cap reached';
    forecast = 'Platinum tier secured this month.';
  } else {
    tag = paceTagFor(pace.projected, next.val, after && after.val);
    tagText = tag === 'on' ? 'On pace' : tag === 'behind' ? 'Behind pace' : 'Ahead of pace';
    projPct = Math.min(100, (pace.projected / cap) * 100);
    legendProj = fmtK(pace.projected) + ' projected';

    const daysLeft = Math.max(1, pace.daysTotal - pace.daysElapsed);
    const need = Math.max(0, next.val - current);
    const monthName = new Date(win.end + 'T00:00:00').toLocaleDateString('en-US', { month: 'long' });
    forecast = tag === 'behind'
      ? `Need <strong>${fmtK(need / Math.max(1, daysLeft / 7))}/wk</strong> over the last ${Math.ceil(daysLeft / 7)} weeks of ${monthName} to clear <strong>${next.label}</strong>.`
      : `At current pace you'll clear <strong>${next.label}</strong> by ${monthName} ${new Date(win.end + 'T00:00:00').getDate()}.`;
  }

  const gap = next ? Math.max(0, next.val - current) : 0;
  const sub = next
    ? `<strong>${fmtK(current)}</strong> credits · next tier <strong>${next.label}</strong> (${fmtK(next.val)}) · <strong>${fmtK(gap)}</strong> to go`
    : `<strong>${fmtK(current)}</strong> credits · Platinum locked`;

  return {
    tag, tagText, sub, forecast,
    curPct, projPct,
    legendCur:  fmtK(current) + ' today',
    legendProj,
    legendCap:  '$20K cap',
  };
}

function buildVPPaceOpts() {
  const contract = parseInt(getContract()) || 100;
  const start = 80, target = 145;
  const pct = Math.max(0, Math.min(1, (contract - start) / (target - start)));
  const eligible = contract >= target;

  return {
    tag: 'flat',
    tagText: eligible ? 'VP eligible' : `Contract ${contract}%`,
    sub: eligible
      ? `Contract <strong>${contract}%</strong> · VP eligibility unlocked.`
      : `VP eligibility opens at <strong>145%</strong> contract.`,
    forecast: eligible
      ? 'Keep persistency up to stay in VP territory.'
      : `Need <strong>+${target - contract}%</strong> contract for VP eligibility — promotion path lives in the Bonus Tracker.`,
    curPct: pct * 100,
    projPct: null,
    legendCur: `${contract}% today`,
    legendProj: '',
    legendCap: 'VP @ 145%',
  };
}
```

- [ ] **Step 3: Rewire `renderSummary` to call the new pace renderers**

Run:

```bash
grep -n 'renderMilestoneBar(document.getElementById' index-3.html
grep -n 'renderVPTrack()' index-3.html
```

Replace the block that contains both `renderMilestoneBar` calls and the `renderVPTrack()` call (a contiguous ~10 lines inside `renderSummary`) with:

```js
  // --- Bonus milestones (program-native windows; ignore the period chip) ---
  // _inRange expects Date objects (the existing summaryPeriodRange returns
  // Dates). Our window helpers return YYYY-MM-DD strings, so wrap them
  // before calling _inRange — otherwise the Date >= string comparison
  // coerces to NaN and every policy gets filtered out.
  const americoStart = new Date(AMERICO_WINDOW.start + 'T00:00:00');
  const americoEnd   = new Date(AMERICO_WINDOW.end   + 'T23:59:59');
  const americoCurrent = _sumKey(pols.filter(p =>
    p.carrier === 'Americo' &&
    _inRange(p, americoStart, americoEnd)
  ), 'ap');
  const americoPace = pacePosition(americoCurrent, AMERICO_WINDOW, today);
  renderPaceRow('pace-am', buildAmericoPaceOpts(americoCurrent, americoPace));

  const amamWin = amAmWindow(today);
  const amamStart = new Date(amamWin.start + 'T00:00:00');
  const amamEnd   = new Date(amamWin.end   + 'T23:59:59');
  const amamCurrent = _sumKey(pols.filter(p =>
    (p.carrier || '').includes('Amicable') &&
    _inRange(p, amamStart, amamEnd)
  ), 'ap');
  const amamPace = pacePosition(amamCurrent, amamWin, today);
  renderPaceRow('pace-amam', buildAmAmPaceOpts(amamCurrent, amamPace, amamWin));

  renderPaceRow('pace-vp', buildVPPaceOpts());
```

- [ ] **Step 4: Verify visual + console**

Reload, open Summary. Walk through:

1. Bonus Milestones card now shows three pace rows: Americo / Am-Am / FFL VP. Each has a name, window eyebrow, status tag, sub line, forecast sentence, and a bar with current/projection/cap legend.
2. Add a fake Americo policy (Tracker → Add policy, carrier "Americo", ap value e.g. 5000, draft date today) — the Americo row updates with the new current credits and projection.
3. With `daysElapsed >= 3`, the Americo tag shows "On pace", "Behind pace", or "Ahead of pace" depending on the projection.
4. Set a fake "Amicable" policy similarly — Am-Am row updates.
5. Open DevTools console and inspect:

```js
buildAmericoPaceOpts(45000, pacePosition(45000, AMERICO_WINDOW, new Date()))
// → check curPct, projPct, sub, forecast look right

buildVPPaceOpts()
// → tag flat, tagText "Contract 100%", curPct ~31, legendCap "VP @ 145%"
```

6. Toggle `body.light` — the pace rows re-paint cleanly (tag chip pill backgrounds, bar background, projection tick contrast).

---

## Task 6: Cleanup — delete legacy code + final QA

**Files:**
- Modify: `index-3.html` — delete legacy CSS, JS functions, and stale comments.

- [ ] **Step 1: Delete `renderMilestoneBar` and `renderVPTrack`**

Run:

```bash
grep -n 'function renderMilestoneBar' index-3.html
grep -n 'function renderVPTrack' index-3.html
```

Delete both function definitions in full. They should no longer be referenced anywhere — confirm with:

```bash
grep -n 'renderMilestoneBar\|renderVPTrack' index-3.html
```

The only remaining matches should be in comments or strings. If `renderSummary` still references them, you missed a rewrite in Task 5 Step 3 — go back and fix it.

- [ ] **Step 2: Delete the legacy milestone CSS**

```bash
grep -n 'MILESTONE CARD (LEGACY' index-3.html
grep -n 'PACE & FORECAST CARD' index-3.html
```

Delete every CSS rule between the `=== MILESTONE CARD (LEGACY — removed in Task 6) ===` comment and the end of the SUMMARY TAB block (the `body.light` overrides above it stay; only the `.milestone-card`, `.ms-track`, `.ms-head`, `.ms-name`, `.ms-current`, `.ms-bar`, `.ms-vp*` rules are removed). Delete the legacy banner comment itself.

- [ ] **Step 3: Sweep for stragglers**

Run these and expect **zero** matches inside the file (or only matches in `archive/` reference comments):

```bash
# No --sv-* tokens, anywhere.
grep -n '\-\-sv-' index-3.html

# No legacy neon hex literals used by the old summary CSS.
grep -nE '#34D399|#22D3EE|#F4C766|#E879F9|#06101F|#0F2236|#13283F' index-3.html

# No references to deleted functions.
grep -nE 'renderMilestoneBar|renderVPTrack' index-3.html

# No references to deleted class names.
grep -nE '\.ms-bar|\.ms-stop|\.ms-vp|milestone-card' index-3.html
```

If any of these return matches inside `<style>` or `<script>` regions, hunt them down and remove. (Matches inside `archive/index-2026-05-10-pre-summary-restyle.html` are expected and fine — that's the snapshot.)

- [ ] **Step 4: Final QA pass**

Reload `index-3.html`. Run through this complete checklist:

1. **Dark mode (default):** Summary tab loads with all sections (hero, period chips, KPI grid, pace card, status+donut, drafts strip) rendering in Producer Stack tokens. No neon greens / cyans / golds / magentas.
2. **Light mode:** Toggle the top-right theme switch. Every section re-paints — backgrounds become ivory, text becomes navy, the goal-ring track and pace-bar background go to `rgba(11,31,58,*)`, status segments and donut wedges keep their semantic Producer Stack colors.
3. **Period chips:** Click `This Week`, `This Month`, `This Year`, `All Time`. The KPI grid and status/donut/drafts strip update. The Bonus Milestones card does **not** change (it's pinned to program-native windows — by design).
4. **Goal scorecard:** Pace needed / Avg this month / Projected month-end show real numbers. Projected month-end is mint if you're tracking ≥ goal, soft red if behind.
5. **Goal ring click:** Opens the existing goal editor (`editMonthlyGoal()` still works).
6. **KPI card clicks:** Each of the four cards drills into the right tab — AP Written / Adv Comm Paid / Active Policies → Policy Tracker, Projected Bonus → Bonus Tracker.
7. **Pace card behavior:**
   - Americo row: "On pace" if your linear-projected Americo AP ≥ next tier by May 29; "Behind pace" if below; "Ahead of pace" if it clears the tier after next; "Too early to project" if `daysElapsed < 3` in the window.
   - Am-Am row: same logic against current calendar month.
   - FFL VP row: "Contract X%" status tag (no pace), forecast says "Need +Y% contract" or "Keep persistency up" if eligible.
8. **Drafts strip:** Next 7 days table renders. Clicking a row drills to the policy in the Tracker.
9. **`prefers-reduced-motion: reduce`:** Toggle via DevTools → Rendering → Emulate CSS media. Reload Summary. Pace bars and goal-arc animate-snap into place rather than tween.
10. **No console errors** during navigation through any of the above.

If all green, the restyle is done.

---

## Self-Review Notes

- **Spec coverage:** Each spec section maps to a task — `3.1 Hero` → Task 3, `3.2 Period chips` → Task 2, `3.3 KPI grid` → Task 2, `3.4 Bonus Milestones` → Tasks 4+5, `3.5 Mid row` → Task 2, `3.6 Drafts strip` → Task 2, `4.1 CSS` → Tasks 2+4+6, `4.2 HTML` → Tasks 3+5, `4.3 JS` → Tasks 1+3+5+6. Acceptance criteria mapped to Task 6 Step 4 checklist.
- **Type consistency:** `renderPaceRow(prefix, opts)` opts keys (`tag`, `tagText`, `sub`, `forecast`, `curPct`, `projPct`, `legendCur`, `legendProj`, `legendCap`) match what every build* function returns. `pacePosition` returns `{daysElapsed, daysTotal, projected}` — consumed correctly by all callers. `AMERICO_WINDOW` / `amAmWindow()` both return `{start, end}` shaped objects — consumed correctly by `pacePosition` and `_inRange`.
- **No git steps:** The repo is not a git checkout. Task 1 takes a single archival snapshot to `archive/`; no per-task commits — engineers verify visually after each task.
- **Known follow-up (out of scope for this plan):** the `kpi-accent-magenta`/`kpi-accent-cyan` class names no longer match their colors (lavender/blue). Renaming is a one-line HTML change but touches several spots and is best done as a small follow-up.
