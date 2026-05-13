# Dashboard Redesign — Phase 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the design system extensions, six reusable component primitives, and the data-layer shape contracts that every subsequent phase of the dashboard redesign will build on.

**Architecture:** All work lands in the single-file app `index-3.html`. We extend the existing `:root` token block with a new `--ds-*` "design system layer" (semantic / momentum / motion / elevation tokens), add six reusable primitive functions and CSS classes (`StatCard`, `ProgressRing`, `Sparkline`, `TrendBadge`, `ActionItem`, `EmptyState`) into the inline `<script>` and `<style>`, define typed shapes + stub accessors for `activities` / `goals` / `chargebacks` / `events`, and add a hidden `#sec-ds-playground` section that renders one of each primitive for visual verification. **No existing widget is changed.** This phase is purely additive.

**Tech Stack:** Vanilla HTML / CSS / JS in a single `index-3.html`. No build step, no test framework — verification is visual + console smoke checks in a browser. No git available; we snapshot to `archive/` before changes. New token names use the `--ds-*` prefix to coexist with the legacy Producer Stack tokens (`--bg`, `--accent`, etc.) without renaming any working code.

**Spec:** `docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md` — Phase 0 section (lines covering 0.1 / 0.2 / 0.3).

**Out of scope:** Replacing existing widgets (Phases 1+), wiring real activity/goal/chargeback data (front-end-first per `feedback_frontend_first`), Supabase schema changes, mobile-only redesigns. The hero, KPI grid, and pace card stay untouched.

**Cross-cutting decisions baked in:**

- **Single-file kept intact.** No new `shared/` or `src/` files in Phase 0. The dashboard is agent-only and the project convention is to extract only when a section exceeds ~400 lines AND the code is reused by `client.html`. Primitives are agent-only, so they live inline.
- **`--ds-*` prefix isolates the new layer.** Legacy `--bg`, `--accent`, `--text` etc. stay untouched. Future phases author against `--ds-*`. Existing widgets keep working.
- **Light + dark parity from day one.** Every new token has a value in both `:root` (dark default) and `body.light` (light override) so future widgets work in both themes without retrofitting.
- **`prefers-reduced-motion` honored.** Every motion token collapses to `0ms` under the reduced-motion media query.
- **Playground is gated.** `#sec-ds-playground` is reachable only via `?ds=1` URL param so it never ships to a real agent's view.

---

## File Structure

Single file: `index-3.html`. Edits land in five regions:

| Region | How to find it | What changes |
|---|---|---|
| `<style>` — `:root` token block | `grep -n '/* Producer Stack — DARK theme' index-3.html` (currently ~line 11) | Add `--ds-*` semantic / momentum / elevation block at the bottom of `:root`; mirror in `body.light`; add `@media (prefers-reduced-motion)` overrides for motion tokens |
| `<style>` — primitives stylesheet | New block, inserted right before the `/* ---- AUTH GATE ---- */` comment (`grep -n '\\-\\-\\-\\- AUTH GATE'`) | New `/* ---- DS PRIMITIVES ---- */` section with classes `.ds-stat`, `.ds-ring`, `.ds-spark`, `.ds-trend`, `.ds-action`, `.ds-empty`, `.ds-playground` |
| HTML body — playground section | After the closing `</div>` of `#sec-summary` (`grep -n 'id="sec-summary"'` then find its end), but inside `.main` | New `<div class="section sum-v3" id="sec-ds-playground">` with one of every primitive |
| HTML body — sidebar nav | `grep -n 'data-ico="gear"'` (Settings nav item) | Append new nav item `Design System` only when `?ds=1` is present (added via JS init, not hardcoded) |
| `<script>` — primitives + data-layer | New block inserted right after the `getContract` / `saveContract` helpers (`grep -n 'function saveContract'`), before the FE rate helpers | New section: `// ---- DS PRIMITIVES ----` factories `dsStatCard`, `dsProgressRing`, `dsSparkline`, `dsTrendBadge`, `dsActionItem`, `dsEmptyState`. New section: `// ---- DS DATA LAYER ----` shapes + accessors `getActivities`, `getGoals`, `getChargebackExposure`, `getEvents`. New init helper `dsInitPlayground` invoked from existing `bootDashboard` |

Use the exact `grep -n` commands at edit time — the architecture doc says line numbers drift.

---

## Task 1: Snapshot the file

This task ships nothing visible. It guards every later task against an in-place mistake.

**Files:**
- Create: `archive/index-2026-05-11-pre-ds-foundation.html` (copy of `index-3.html`)

- [ ] **Step 1: Snapshot**

Run from the project root:

```bash
cp "index-3.html" "archive/index-2026-05-11-pre-ds-foundation.html"
```

- [ ] **Step 2: Verify**

Run:

```bash
ls -la archive/index-2026-05-11-pre-ds-foundation.html
```

Expected: file size ≈ 1.37 MB (matches current `index-3.html`). If size is 0, redo step 1.

---

## Task 2: Add the `--ds-*` token layer (semantic + momentum + elevation + motion)

**Files:**
- Modify: `index-3.html` — `:root` block at top of `<style>`, plus `body.light` override block, plus a new `prefers-reduced-motion` media query.

This task adds CSS variables only. After it, the page should look identical, but new tokens are queryable in DevTools (`getComputedStyle(document.documentElement).getPropertyValue('--ds-color-success')`).

- [ ] **Step 1: Find the insertion point**

Run:

```bash
grep -n '\-\-brand-blue-3:#5BA0E8' index-3.html
```

The token layer goes **immediately after** that `--brand-blue-3` line (currently ~line 24), inside the same `:root { ... }` block, before the closing `}`.

- [ ] **Step 2: Append the dark-theme `--ds-*` block to `:root`**

Insert these lines after the `--brand-blue-3` line and before the `:root` closing `}`:

```css
  /* ---- DS LAYER 2026-05-11 — design-system extensions for dashboard redesign ---- */
  /* Semantic colors — paired with icon + text, never color alone (per design-system doc 02). */
  --ds-color-success:    #5CC9A7;   /* mint — positive deltas, on-pace, completed */
  --ds-color-success-bg: rgba(92,201,167,.14);
  --ds-color-warning:    #E0B884;   /* warm tan — at risk, attention, free-look soon */
  --ds-color-warning-bg: rgba(224,184,132,.14);
  --ds-color-danger:     #E07B7B;   /* coral — overdue, declined, exposure */
  --ds-color-danger-bg:  rgba(224,123,123,.14);
  --ds-color-info:       #8FC2F7;   /* pastel blue — neutral notice */
  --ds-color-info-bg:    rgba(143,194,247,.14);
  --ds-color-neutral:    #A8BCD6;   /* graphite-cool — flat / unchanged */
  --ds-color-neutral-bg: rgba(168,188,214,.10);

  /* Momentum accent — the "you're on a roll" color. Saturated electric blue, used sparingly. */
  --ds-color-momentum:    #5BA0E8;
  --ds-color-momentum-bg: rgba(91,160,232,.18);
  --ds-color-momentum-glow: 0 0 0 3px rgba(91,160,232,.22);

  /* Elevation scale — three levels, no glassmorphism (design-system doc 01 forbids). */
  --ds-elev-flat:  none;
  --ds-elev-hover: 0 1px 0 rgba(255,255,255,.05) inset, 0 12px 28px -16px rgba(0,0,0,.6);
  --ds-elev-modal: 0 1px 0 rgba(255,255,255,.06) inset, 0 24px 64px -24px rgba(0,0,0,.8);

  /* Radius scale — locked to the existing card radii used by Producer Stack. */
  --ds-radius-sm: 6px;   /* chips, badges, tags */
  --ds-radius-md: 10px;  /* buttons, inputs */
  --ds-radius-lg: 12px;  /* cards (matches existing .card radius) */
  --ds-radius-pill: 999px;

  /* Spacing scale — 4px base, multiples only (design-system doc 04). */
  --ds-space-1: 4px;
  --ds-space-2: 8px;
  --ds-space-3: 12px;
  --ds-space-4: 16px;
  --ds-space-5: 24px;
  --ds-space-6: 32px;
  --ds-space-7: 48px;
  --ds-space-8: 64px;

  /* Motion tokens — `prefers-reduced-motion` collapses these to 0ms below. */
  --ds-duration-fast:  150ms;
  --ds-duration-base:  250ms;
  --ds-duration-slow:  400ms;
  --ds-ease-out:       cubic-bezier(.16,1,.3,1);          /* general entrances */
  --ds-ease-out-expo:  cubic-bezier(.19,1,.22,1);         /* hero entrances */
  --ds-ease-spring:    cubic-bezier(.34,1.56,.64,1);      /* micro-celebrations */
```

- [ ] **Step 3: Mirror semantic colors in `body.light`**

Run:

```bash
grep -n '^body\.light{' index-3.html
```

That opens the `body.light{ ... }` custom-property block (which holds existing overrides like `--bg`, `--card`, `--text`, `--text3`). The closing `}` of that block currently sits ~line 40 in the pre-task file (it shifts after Task 2's edit). Append the light-theme `--ds-*` overrides **inside that block, immediately before its closing `}`** — NOT after the `body.light .bulk-bar` selector rule (which is a separate rule outside the variable block):

```css
  /* ---- DS LAYER 2026-05-11 — light-theme overrides ---- */
  --ds-color-success:    #2C5F4F;   /* heritage green — light theme aligns with design-system canonical */
  --ds-color-success-bg: rgba(44,95,79,.10);
  --ds-color-warning:    #B8945A;   /* burnished gold — used as caution, not alarm */
  --ds-color-warning-bg: rgba(184,148,90,.10);
  --ds-color-danger:     #9A2A2A;   /* signal red — critical only */
  --ds-color-danger-bg:  rgba(154,42,42,.08);
  --ds-color-info:       #5BA0E8;
  --ds-color-info-bg:    rgba(91,160,232,.10);
  --ds-color-neutral:    #3F4750;
  --ds-color-neutral-bg: rgba(63,71,80,.06);
  --ds-color-momentum:   #0B1F3A;   /* midnight navy in light mode — momentum reads as authority */
  --ds-color-momentum-bg: rgba(11,31,58,.08);
  --ds-color-momentum-glow: 0 0 0 3px rgba(11,31,58,.10);
  --ds-elev-flat:  none;
  --ds-elev-hover: 0 1px 0 rgba(11,31,58,.04) inset, 0 8px 20px -12px rgba(11,31,58,.18);
  --ds-elev-modal: 0 1px 0 rgba(11,31,58,.06) inset, 0 24px 64px -24px rgba(11,31,58,.30);
```

(Radius / spacing / motion tokens are theme-agnostic — no override needed.)

- [ ] **Step 4: Add the reduced-motion override**

Find an existing `@media (prefers-reduced-motion: reduce)` block:

```bash
grep -n 'prefers-reduced-motion' index-3.html | head -3
```

Append a **new** block at the very end of the `<style>` section (find with `grep -n '</style>'`), **immediately above `</style>`**:

```css
@media (prefers-reduced-motion: reduce){
  :root, body.light{
    --ds-duration-fast: 0ms;
    --ds-duration-base: 0ms;
    --ds-duration-slow: 0ms;
  }
}
```

- [ ] **Step 5: Verify in browser**

Open `index-3.html` in a browser. Open DevTools console and run:

```js
const cs = getComputedStyle(document.documentElement);
['--ds-color-success','--ds-color-momentum','--ds-radius-lg','--ds-duration-base','--ds-ease-out-expo']
  .forEach(t => console.log(t, '=', cs.getPropertyValue(t).trim()));
```

Expected output:
```
--ds-color-success = #5CC9A7
--ds-color-momentum = #5BA0E8
--ds-radius-lg = 12px
--ds-duration-base = 250ms
--ds-ease-out-expo = cubic-bezier(.19,1,.22,1)
```

Toggle to light mode (whatever existing toggle exists, or `document.body.classList.add('light')`) and re-run — `--ds-color-success` should change to `#2C5F4F`.

Visually confirm the dashboard looks identical to before. **No widget should change appearance.** If anything looks off, the insertion accidentally landed outside the `:root` block — re-check braces.

- [ ] **Step 6: Commit-equivalent — snapshot a checkpoint copy**

```bash
cp "index-3.html" "archive/index-2026-05-11-ds-tokens-only.html"
```

(Acts as the rollback point if any later task introduces a regression.)

---

## Task 3: Add the primitives stylesheet block

**Files:**
- Modify: `index-3.html` — `<style>` block, just before the `/* ---- AUTH GATE ---- */` rule.

This task adds CSS only. No DOM is rendered yet — the next tasks add the JS factories and the playground markup. The page should still look identical after this task.

- [ ] **Step 1: Find the insertion point**

```bash
grep -n '/\* ---- AUTH GATE ----' index-3.html
```

Insert the block **immediately above** that `/* ---- AUTH GATE ----` line.

- [ ] **Step 2: Insert the primitives stylesheet**

```css
/* ============================================================
 * DS PRIMITIVES — added 2026-05-11 (Phase 0 foundation)
 * Reusable component CSS for the dashboard-redesign series.
 * Author against --ds-* tokens only; never hardcode hex.
 * ============================================================ */

/* StatCard — variants: default | trend | sparkline | progress | alert */
.ds-stat{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:var(--ds-radius-lg);
  padding:var(--ds-space-5);
  display:flex;flex-direction:column;gap:var(--ds-space-3);
  position:relative;
  transition:border-color var(--ds-duration-fast) var(--ds-ease-out),
             transform   var(--ds-duration-fast) var(--ds-ease-out),
             box-shadow  var(--ds-duration-fast) var(--ds-ease-out);
}
.ds-stat[data-clickable="true"]{cursor:pointer}
.ds-stat[data-clickable="true"]:hover{
  border-color:var(--ac, var(--ds-color-info));
  transform:translateY(-1px);
  box-shadow:var(--ds-elev-hover);
}
.ds-stat[data-accent="success"] {--ac:var(--ds-color-success)}
.ds-stat[data-accent="warning"] {--ac:var(--ds-color-warning)}
.ds-stat[data-accent="danger"]  {--ac:var(--ds-color-danger)}
.ds-stat[data-accent="info"]    {--ac:var(--ds-color-info)}
.ds-stat[data-accent="momentum"]{--ac:var(--ds-color-momentum)}
.ds-stat[data-accent="neutral"] {--ac:var(--ds-color-neutral)}
.ds-stat[data-clickable="true"]::before{
  content:"";position:absolute;top:0;left:0;right:0;height:2px;
  border-radius:var(--ds-radius-lg) var(--ds-radius-lg) 0 0;
  background:var(--ac, var(--ds-color-info));
}
.ds-stat__head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--ds-space-2)}
.ds-stat__label{
  font:10px/14px var(--sans);text-transform:uppercase;letter-spacing:.18em;
  color:var(--text3);font-weight:600;
}
.ds-stat__hero{
  font:500 28px/32px var(--display);color:var(--text);
  letter-spacing:-.01em;font-variant-numeric:tabular-nums;
}
.ds-stat__sub{font:12px/16px var(--sans);color:var(--text2)}
.ds-stat[data-variant="alert"]{border-color:var(--ds-color-danger)}
.ds-stat[data-variant="alert"] .ds-stat__hero{color:var(--ds-color-danger)}

/* ProgressRing — SVG, size + thickness + color via attrs */
.ds-ring{display:inline-block;position:relative;line-height:0}
.ds-ring svg{display:block;transform:rotate(-90deg)}
.ds-ring__track{fill:none;stroke:rgba(255,255,255,.08)}
body.light .ds-ring__track{stroke:rgba(11,31,58,.08)}
.ds-ring__arc{
  fill:none;stroke:var(--ac, var(--ds-color-info));stroke-linecap:round;
  transition:stroke-dashoffset var(--ds-duration-slow) var(--ds-ease-out-expo);
}
.ds-ring__center{
  position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:2px;text-align:center;
}
.ds-ring[data-accent="success"]  {--ac:var(--ds-color-success)}
.ds-ring[data-accent="warning"]  {--ac:var(--ds-color-warning)}
.ds-ring[data-accent="danger"]   {--ac:var(--ds-color-danger)}
.ds-ring[data-accent="momentum"] {--ac:var(--ds-color-momentum)}

/* Sparkline — width is 100% of parent, height fixed by the data-height attr */
.ds-spark{display:block;width:100%;overflow:visible}
.ds-spark__fill{fill:var(--ac, var(--ds-color-info));fill-opacity:.12}
.ds-spark__line{
  fill:none;stroke:var(--ac, var(--ds-color-info));
  stroke-width:2;stroke-linecap:round;stroke-linejoin:round;
}
.ds-spark__empty{
  fill:none;stroke:rgba(255,255,255,.10);stroke-width:1;stroke-dasharray:3 3;
}
body.light .ds-spark__empty{stroke:rgba(11,31,58,.10)}
.ds-spark[data-accent="success"]  {--ac:var(--ds-color-success)}
.ds-spark[data-accent="warning"]  {--ac:var(--ds-color-warning)}
.ds-spark[data-accent="danger"]   {--ac:var(--ds-color-danger)}
.ds-spark[data-accent="momentum"] {--ac:var(--ds-color-momentum)}

/* TrendBadge — semantic delta chip (replaces ad-hoc .kpi-delta usage going forward) */
.ds-trend{
  font:10.5px/14px var(--mono);font-variant-numeric:tabular-nums;font-weight:400;
  padding:3px 7px;border-radius:var(--ds-radius-sm);
  display:inline-flex;align-items:center;gap:3px;letter-spacing:.03em;white-space:nowrap;
}
.ds-trend[data-tone="up"]      {background:var(--ds-color-success-bg);color:var(--ds-color-success)}
.ds-trend[data-tone="down"]    {background:var(--ds-color-danger-bg); color:var(--ds-color-danger)}
.ds-trend[data-tone="flat"]    {background:var(--ds-color-neutral-bg);color:var(--ds-color-neutral)}
.ds-trend[data-tone="warn"]    {background:var(--ds-color-warning-bg);color:var(--ds-color-warning)}
.ds-trend[data-tone="momentum"]{background:var(--ds-color-momentum-bg);color:var(--ds-color-momentum)}
.ds-trend[data-tone="static"]{
  background:var(--ds-color-warning-bg);color:var(--ds-color-warning);
  text-transform:uppercase;letter-spacing:.12em;font-size:9.5px;
}

/* ActionItem — list row with icon, title, meta, CTA. Used by the upcoming Action Hub. */
.ds-action{
  display:grid;grid-template-columns:24px 1fr auto;
  align-items:center;gap:var(--ds-space-3);
  padding:var(--ds-space-3) var(--ds-space-4);
  border:1px solid transparent;border-radius:var(--ds-radius-md);
  background:transparent;
  transition:background var(--ds-duration-fast) var(--ds-ease-out),
             border-color var(--ds-duration-fast) var(--ds-ease-out),
             opacity var(--ds-duration-base) var(--ds-ease-out),
             transform var(--ds-duration-base) var(--ds-ease-spring);
}
.ds-action:hover{background:rgba(143,194,247,.04);border-color:var(--border)}
body.light .ds-action:hover{background:rgba(91,160,232,.06)}
.ds-action__icon{
  width:24px;height:24px;display:flex;align-items:center;justify-content:center;
  color:var(--tone, var(--text2));
}
.ds-action[data-tone="urgent"]      {--tone:var(--ds-color-danger)}
.ds-action[data-tone="today"]       {--tone:var(--ds-color-warning)}
.ds-action[data-tone="opportunity"] {--tone:var(--ds-color-success)}
.ds-action__body{min-width:0;display:flex;flex-direction:column;gap:2px}
.ds-action__title{
  font:500 13.5px/18px var(--sans);color:var(--text);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.ds-action__meta{font:11.5px/15px var(--sans);color:var(--text3)}
.ds-action__cta{
  font:11.5px/14px var(--sans);font-weight:500;
  padding:6px 12px;border-radius:var(--ds-radius-sm);
  background:var(--bg3);color:var(--text);border:1px solid var(--border);
  cursor:pointer;
  transition:background var(--ds-duration-fast) var(--ds-ease-out);
}
.ds-action__cta:hover{background:var(--card)}
.ds-action[data-state="completed"]{
  opacity:0;transform:translateX(8px) scale(.98);
  pointer-events:none;
}

/* EmptyState — illustration + headline + CTA, never a bare zero */
.ds-empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:var(--ds-space-3);padding:var(--ds-space-7) var(--ds-space-5);
  text-align:center;color:var(--text3);
}
.ds-empty__icon{
  width:48px;height:48px;border-radius:var(--ds-radius-pill);
  background:var(--bg3);border:1px solid var(--border);
  display:flex;align-items:center;justify-content:center;color:var(--text2);
}
.ds-empty__title{font:600 15px/20px var(--sans);color:var(--text2);max-width:32ch}
.ds-empty__body{font:13px/19px var(--sans);color:var(--text3);max-width:42ch}
.ds-empty__cta{
  margin-top:var(--ds-space-2);
  font:13px/16px var(--sans);font-weight:500;
  padding:8px 16px;border-radius:var(--ds-radius-md);
  background:var(--accent);color:var(--brand-navy);border:none;cursor:pointer;
  transition:filter var(--ds-duration-fast) var(--ds-ease-out);
}
.ds-empty__cta:hover{filter:brightness(1.06)}

/* Playground — only rendered when ?ds=1 puts the user on this section */
.ds-playground{display:flex;flex-direction:column;gap:var(--ds-space-6)}
.ds-playground__group{display:flex;flex-direction:column;gap:var(--ds-space-3)}
.ds-playground__title{
  font:600 13px/18px var(--sans);color:var(--text2);
  text-transform:uppercase;letter-spacing:.16em;
}
.ds-playground__row{display:flex;flex-wrap:wrap;gap:var(--ds-space-4);align-items:flex-start}
.ds-playground__row > *{min-width:200px}
```

- [ ] **Step 3: Verify**

Reload the page. Visually confirm nothing changed — no new visible elements, no layout shift. Open DevTools and check that the new rules show up:

```js
[...document.styleSheets[0].cssRules].some(r => r.selectorText === '.ds-stat')
```

Expected: `true`.

- [ ] **Step 4: Snapshot checkpoint**

```bash
cp "index-3.html" "archive/index-2026-05-11-ds-css-only.html"
```

---

## Task 4: Add the primitives JS factories

**Files:**
- Modify: `index-3.html` — inline `<script>`, immediately after `function saveContract`.

This task adds JS only. After it, the factories work in the console even before the playground renders.

- [ ] **Step 1: Find the insertion point**

```bash
grep -n 'function saveContract' index-3.html
```

Insert the block **immediately after** the closing `}` of `saveContract`. (If `saveContract` doesn't exist, fall back to inserting just after the `getContract` function.)

- [ ] **Step 2: Insert the factories**

```js
// ============================================================
// DS PRIMITIVES — added 2026-05-11 (Phase 0 foundation)
// Six reusable factories for the dashboard-redesign series.
// All return DOM elements; none read globals; safe to call from
// any render path. Author future widgets against these — do not
// hand-roll .kpi-* or .stat markup in new code.
// ============================================================
const DS_ACCENTS = new Set(['success','warning','danger','info','neutral','momentum']);
const DS_TONES   = new Set(['up','down','flat','warn','momentum','static']);

function _dsAttr(el, name, value){
  if (value == null || value === '') return;
  el.setAttribute(name, String(value));
}

/**
 * dsStatCard({ label, hero, sub, accent, variant, trend, sparkline, onClick }) -> HTMLElement
 *   variant: 'default' | 'trend' | 'sparkline' | 'progress' | 'alert'
 *   accent:  one of DS_ACCENTS (default 'info')
 *   trend:   { tone: 'up'|'down'|'flat'|'warn'|'momentum'|'static', text: '+12%' }
 *   sparkline: array of numbers (passed through to dsSparkline)
 *   onClick: function — when present, card becomes clickable + accent bar appears
 */
function dsStatCard(opts){
  const o = Object.assign({ accent:'info', variant:'default' }, opts || {});
  const card = document.createElement('div');
  card.className = 'ds-stat';
  _dsAttr(card, 'data-accent',  DS_ACCENTS.has(o.accent) ? o.accent : 'info');
  _dsAttr(card, 'data-variant', o.variant);
  if (typeof o.onClick === 'function'){
    card.setAttribute('data-clickable','true');
    card.setAttribute('role','button');
    card.setAttribute('tabindex','0');
    card.addEventListener('click', o.onClick);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); o.onClick(e); } });
  }
  const head = document.createElement('div');
  head.className = 'ds-stat__head';
  const lbl = document.createElement('div');
  lbl.className = 'ds-stat__label';
  lbl.textContent = o.label || '';
  head.appendChild(lbl);
  if (o.trend){ head.appendChild(dsTrendBadge(o.trend)); }
  card.appendChild(head);

  if (o.hero != null){
    const hero = document.createElement('div');
    hero.className = 'ds-stat__hero';
    hero.textContent = String(o.hero);
    card.appendChild(hero);
  }
  if (o.sub){
    const sub = document.createElement('div');
    sub.className = 'ds-stat__sub';
    sub.textContent = o.sub;
    card.appendChild(sub);
  }
  if (Array.isArray(o.sparkline)){
    card.appendChild(dsSparkline({ data:o.sparkline, accent:o.accent, height:42 }));
  }
  return card;
}

/**
 * dsProgressRing({ value, max, size, thickness, accent, centerLabel, centerValue }) -> HTMLElement
 *   value/max:   ratio fills the arc; clamped to [0, max]
 *   size:        outer diameter in px (default 200)
 *   thickness:   stroke width (default 14)
 *   accent:      one of DS_ACCENTS (default 'momentum')
 */
function dsProgressRing(opts){
  const o = Object.assign({ size:200, thickness:14, accent:'momentum', value:0, max:100 }, opts || {});
  const r = (o.size / 2) - (o.thickness / 2) - 2;
  const C = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(1, (o.max > 0 ? o.value / o.max : 0)));
  const offset = C * (1 - ratio);

  const wrap = document.createElement('div');
  wrap.className = 'ds-ring';
  _dsAttr(wrap, 'data-accent', DS_ACCENTS.has(o.accent) ? o.accent : 'momentum');
  wrap.style.width  = o.size + 'px';
  wrap.style.height = o.size + 'px';

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${o.size} ${o.size}`);
  svg.setAttribute('width',  o.size);
  svg.setAttribute('height', o.size);
  svg.setAttribute('aria-hidden','true');

  const track = document.createElementNS(ns, 'circle');
  track.setAttribute('class', 'ds-ring__track');
  track.setAttribute('cx', o.size/2);
  track.setAttribute('cy', o.size/2);
  track.setAttribute('r',  r);
  track.setAttribute('stroke-width', o.thickness);
  svg.appendChild(track);

  const arc = document.createElementNS(ns, 'circle');
  arc.setAttribute('class', 'ds-ring__arc');
  arc.setAttribute('cx', o.size/2);
  arc.setAttribute('cy', o.size/2);
  arc.setAttribute('r',  r);
  arc.setAttribute('stroke-width', o.thickness);
  arc.setAttribute('stroke-dasharray',  String(C));
  arc.setAttribute('stroke-dashoffset', String(C));   // start empty; animate to target
  svg.appendChild(arc);
  wrap.appendChild(svg);

  if (o.centerLabel || o.centerValue != null){
    const center = document.createElement('div');
    center.className = 'ds-ring__center';
    if (o.centerValue != null){
      const v = document.createElement('div');
      v.style.font = '500 28px/32px var(--display)';
      v.style.color = 'var(--text)';
      v.style.fontVariantNumeric = 'tabular-nums';
      v.textContent = String(o.centerValue);
      center.appendChild(v);
    }
    if (o.centerLabel){
      const l = document.createElement('div');
      l.style.font = '10px/14px var(--sans)';
      l.style.textTransform = 'uppercase';
      l.style.letterSpacing = '.18em';
      l.style.color = 'var(--text3)';
      l.style.fontWeight = '600';
      l.textContent = o.centerLabel;
      center.appendChild(l);
    }
    wrap.appendChild(center);
  }

  // Animate to the target on next frame so the CSS transition fires.
  requestAnimationFrame(() => { arc.setAttribute('stroke-dashoffset', String(offset)); });

  return wrap;
}

/**
 * dsSparkline({ data, accent, height, width }) -> SVGElement
 *   data:   number[]; if empty/null, renders dashed-empty placeholder
 *   width:  viewBox width (default 200)
 *   height: viewBox height (default 42)
 */
function dsSparkline(opts){
  const o = Object.assign({ width:200, height:42, accent:'info' }, opts || {});
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ds-spark');
  svg.setAttribute('viewBox', `0 0 ${o.width} ${o.height}`);
  svg.setAttribute('preserveAspectRatio','none');
  svg.setAttribute('aria-hidden','true');
  _dsAttr(svg, 'data-accent', DS_ACCENTS.has(o.accent) ? o.accent : 'info');

  const data = Array.isArray(o.data) ? o.data : [];
  if (!data.length){
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('class', 'ds-spark__empty');
    line.setAttribute('x1', 0); line.setAttribute('x2', o.width);
    line.setAttribute('y1', o.height/2); line.setAttribute('y2', o.height/2);
    svg.appendChild(line);
    return svg;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = (max - min) || 1;
  const step = data.length > 1 ? (o.width / (data.length - 1)) : 0;

  const pts = data.map((v, i) => {
    const x = i * step;
    const y = o.height - ((v - min) / span) * (o.height - 4) - 2;
    return [x, y];
  });

  const linePath = pts.map(([x,y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
  const fillPath = `${linePath} L${o.width},${o.height} L0,${o.height} Z`;

  const fill = document.createElementNS(ns, 'path');
  fill.setAttribute('class', 'ds-spark__fill');
  fill.setAttribute('d', fillPath);
  svg.appendChild(fill);

  const line = document.createElementNS(ns, 'path');
  line.setAttribute('class', 'ds-spark__line');
  line.setAttribute('d', linePath);
  svg.appendChild(line);

  return svg;
}

/**
 * dsTrendBadge({ tone, text }) -> HTMLElement
 *   tone: one of DS_TONES (default 'flat')
 *   text: visible string (e.g. '+12%', '— flat', 'FORWARD')
 */
function dsTrendBadge(opts){
  const o = Object.assign({ tone:'flat', text:'' }, opts || {});
  const el = document.createElement('span');
  el.className = 'ds-trend';
  _dsAttr(el, 'data-tone', DS_TONES.has(o.tone) ? o.tone : 'flat');
  el.textContent = o.text;
  return el;
}

/**
 * dsActionItem({ icon, title, meta, ctaLabel, tone, onComplete }) -> HTMLElement
 *   icon:       data-ico key recognized by the existing icon system (e.g. 'phone', 'clock')
 *   tone:       'urgent' | 'today' | 'opportunity'
 *   onComplete: function — when invoked (CTA click), the row fades + slides out
 */
function dsActionItem(opts){
  const o = Object.assign({ tone:'today', ctaLabel:'Done' }, opts || {});
  const row = document.createElement('div');
  row.className = 'ds-action';
  _dsAttr(row, 'data-tone', o.tone);
  row.setAttribute('role','listitem');

  const icon = document.createElement('div');
  icon.className = 'ds-action__icon';
  if (o.icon){
    const span = document.createElement('span');
    span.setAttribute('data-ico', o.icon);
    span.setAttribute('data-size','18');
    icon.appendChild(span);
  }
  row.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'ds-action__body';
  const title = document.createElement('div');
  title.className = 'ds-action__title';
  title.textContent = o.title || '';
  body.appendChild(title);
  if (o.meta){
    const meta = document.createElement('div');
    meta.className = 'ds-action__meta';
    meta.textContent = o.meta;
    body.appendChild(meta);
  }
  row.appendChild(body);

  const cta = document.createElement('button');
  cta.className = 'ds-action__cta';
  cta.type = 'button';
  cta.textContent = o.ctaLabel;
  cta.addEventListener('click', () => {
    row.setAttribute('data-state','completed');
    if (typeof o.onComplete === 'function'){
      // Wait for the CSS transition before calling back, so the caller can remove the node.
      const dur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ds-duration-base')) || 250;
      setTimeout(() => o.onComplete(), dur + 30);
    }
  });
  row.appendChild(cta);

  return row;
}

/**
 * dsEmptyState({ icon, title, body, ctaLabel, onCta }) -> HTMLElement
 */
function dsEmptyState(opts){
  const o = Object.assign({}, opts || {});
  const wrap = document.createElement('div');
  wrap.className = 'ds-empty';

  const icon = document.createElement('div');
  icon.className = 'ds-empty__icon';
  if (o.icon){
    const span = document.createElement('span');
    span.setAttribute('data-ico', o.icon);
    span.setAttribute('data-size','24');
    icon.appendChild(span);
  }
  wrap.appendChild(icon);

  if (o.title){
    const t = document.createElement('div');
    t.className = 'ds-empty__title';
    t.textContent = o.title;
    wrap.appendChild(t);
  }
  if (o.body){
    const b = document.createElement('div');
    b.className = 'ds-empty__body';
    b.textContent = o.body;
    wrap.appendChild(b);
  }
  if (o.ctaLabel && typeof o.onCta === 'function'){
    const c = document.createElement('button');
    c.className = 'ds-empty__cta';
    c.type = 'button';
    c.textContent = o.ctaLabel;
    c.addEventListener('click', o.onCta);
    wrap.appendChild(c);
  }
  return wrap;
}
```

- [ ] **Step 3: Verify factories work in the console**

Reload the page. In DevTools console:

```js
const c = dsStatCard({
  label:'Test KPI', hero:'$12,450', sub:'vs $10,200 last month',
  accent:'momentum', trend:{ tone:'up', text:'+22%' },
  sparkline:[1,3,2,5,4,7,6,9],
  onClick:() => console.log('clicked')
});
document.body.appendChild(c);
```

Expected: a card appears at the bottom of the page with the label, hero number, sub line, an "+22%" green chip, and a blue sparkline. Clicking it logs `clicked`. Then run:

```js
c.remove();
const r = dsProgressRing({ value:65, max:100, size:120, thickness:10, accent:'momentum', centerValue:'65%', centerLabel:'Goal' });
document.body.appendChild(r);
```

Expected: a ring appears with the arc animating in over ~400ms, filling 65% of the way around. Then run:

```js
r.remove();
const s = dsSparkline({ data:[5,3,7,4,8,6,9,12], height:60, accent:'success' });
s.style.maxWidth = '320px';
document.body.appendChild(s);
```

Expected: a small green line chart appears at the bottom of the page.

Then run:

```js
s.remove();
const a = dsActionItem({ icon:'phone', tone:'urgent', title:'Call Maria Rodriguez', meta:'Free-look expires today · UW called yesterday', ctaLabel:'Mark called', onComplete:() => a.remove() });
document.body.appendChild(a);
```

Expected: a row with a phone icon (or empty placeholder if the icon system isn't loaded), a title, meta, and a "Mark called" button. Clicking the button fades + slides the row out and removes it.

Then run:

```js
const e = dsEmptyState({ icon:'inbox', title:'No actions queued', body:'When clients have callbacks, expiring quotes, or anniversaries you can act on, they show up here.', ctaLabel:'View all clients', onCta:() => console.log('clients') });
document.body.appendChild(e);
```

Expected: a centered empty-state card. Click the CTA → console logs `clients`. Run `e.remove()` to clean up.

If any factory throws an error or renders nothing visible, **stop and debug before continuing**.

- [ ] **Step 4: Snapshot checkpoint**

```bash
cp "index-3.html" "archive/index-2026-05-11-ds-js-factories.html"
```

---

## Task 5: Add data-layer shapes + stub accessors

**Files:**
- Modify: `index-3.html` — inline `<script>`, immediately after the DS factories block from Task 4.

Per the front-end-first feedback memory, this task does NOT touch Supabase or persist anything new. It defines the shapes future widgets bind to and provides stub accessors that return either real data (when present in `policies`) or empty arrays. Backend wiring is its own follow-up plan.

- [ ] **Step 1: Insert the data-layer block**

Right after the end of the DS factories block (after `dsEmptyState`'s closing `}`), insert:

```js
// ============================================================
// DS DATA LAYER — added 2026-05-11 (Phase 0 foundation)
// Canonical shapes + stub accessors for dashboard-redesign widgets.
// Real persistence is a follow-up plan; for now these read from
// localStorage where data already exists, or return [] safely.
// Author future widgets against these accessors — do not reach
// into `policies` / `leads` directly when an accessor exists.
// ============================================================

/**
 * Activity (call, contact, appointment, quote)
 * @typedef {Object} Activity
 * @property {string} id
 * @property {'call'|'contact'|'appointment'|'quote'} type
 * @property {string} clientId
 * @property {string} clientName
 * @property {string} when            // ISO timestamp
 * @property {string=} outcome        // 'no-answer', 'set-appt', 'sold', etc.
 * @property {string=} notes
 */

/**
 * Goal (multi-dimensional)
 * @typedef {Object} Goals
 * @property {number} ap              // monthly AP target ($)
 * @property {number} apps            // monthly app count target
 * @property {number} lives           // monthly lives target
 * @property {number} persistencyPct  // target persistency (0-100)
 * @property {number=} stretchAp      // optional stretch goal
 */

/**
 * Chargeback exposure summary
 * @typedef {Object} ChargebackExposure
 * @property {number} totalAdvanced       // sum of advance commissions still in chargeback window ($)
 * @property {number} earnedDown          // sum already earned through ($)
 * @property {Array<{month:string, amount:number}>} earnDownSchedule  // forward 12 months
 * @property {Array<{policyId:string, clientName:string, amountAtRisk:number, riskReason:string}>} atRiskPolicies
 */

/**
 * Event (free-look expiration, anniversary, UW deadline, birthday)
 * @typedef {Object} EventItem
 * @property {string} id
 * @property {'free-look'|'anniversary'|'uw-deadline'|'birthday'|'callback'} type
 * @property {string} clientId
 * @property {string} clientName
 * @property {string} when            // ISO date
 * @property {'urgent'|'today'|'opportunity'} tone
 * @property {string} headline        // human-readable single line
 * @property {string=} subline
 */

const DS_LS = {
  activities: () => k('ds_activities'),   // reuses the per-agent k() namespace
  goals:      () => k('ds_goals'),
};

/** @returns {Activity[]} */
function getActivities(){
  try {
    const raw = localStorage.getItem(DS_LS.activities());
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_e) {
    return [];
  }
}

/** @returns {Goals} — falls back to legacy single-AP goal if no multi-goal exists */
function getGoals(){
  try {
    const raw = localStorage.getItem(DS_LS.goals());
    if (raw){
      const g = JSON.parse(raw);
      return Object.assign({ ap:0, apps:0, lives:0, persistencyPct:0 }, g);
    }
  } catch (_e) {}
  // Legacy fallback — read the existing monthly AP goal if available.
  const legacyAp = (typeof getMonthlyGoal === 'function') ? Number(getMonthlyGoal()) || 0 : 0;
  return { ap: legacyAp, apps: 0, lives: 0, persistencyPct: 0 };
}

/** @returns {ChargebackExposure} — derived from `policies` (computed, not persisted) */
function getChargebackExposure(){
  const pols = (Array.isArray(window.policies) ? window.policies : []);
  // Naive v1: any policy with status 'lapsed' within the last 9 months counts as exposed.
  // Future plans will replace this with per-carrier earn-down schedules.
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 9);
  const exposed = pols.filter(p =>
    p.status === 'lapsed' &&
    p.draft && new Date(p.draft) >= cutoff
  );
  const totalAdvanced = exposed.reduce((s,p) => s + (Number(p.advComm) || 0), 0);
  const atRiskPolicies = exposed.map(p => ({
    policyId: String(p.id),
    clientName: p.client || '—',
    amountAtRisk: Number(p.advComm) || 0,
    riskReason: 'Lapsed within 9-month chargeback window',
  }));
  return {
    totalAdvanced,
    earnedDown: 0,
    earnDownSchedule: [],
    atRiskPolicies,
  };
}

/** @returns {EventItem[]} — derived from `policies` (free-look windows, anniversaries) */
function getEvents(){
  const pols = (Array.isArray(window.policies) ? window.policies : []);
  const out = [];
  const now = Date.now();
  const D = 86400000;

  for (const p of pols){
    if (!p || !p.id) continue;
    // Free-look — typically 30 days from issue date for life policies.
    if (p.issueDate){
      const issued = new Date(p.issueDate).getTime();
      if (Number.isFinite(issued)){
        const expires = issued + 30 * D;
        const daysLeft = Math.round((expires - now) / D);
        if (daysLeft >= 0 && daysLeft <= 7){
          out.push({
            id: 'fl-' + p.id,
            type: 'free-look',
            clientId: String(p.id),
            clientName: p.client || '—',
            when: new Date(expires).toISOString().slice(0,10),
            tone: daysLeft <= 1 ? 'urgent' : 'today',
            headline: `Free-look expires in ${daysLeft} day${daysLeft===1?'':'s'}`,
            subline: p.client || undefined,
          });
        }
      }
    }
    // Anniversary — yearly draft date roll-up.
    if (p.draft){
      const draft = new Date(p.draft);
      if (Number.isFinite(draft.getTime())){
        const thisYear = new Date();
        const annivThisYear = new Date(thisYear.getFullYear(), draft.getMonth(), draft.getDate()).getTime();
        const days = Math.round((annivThisYear - now) / D);
        if (days >= 0 && days <= 14){
          out.push({
            id: 'an-' + p.id,
            type: 'anniversary',
            clientId: String(p.id),
            clientName: p.client || '—',
            when: new Date(annivThisYear).toISOString().slice(0,10),
            tone: 'opportunity',
            headline: `Policy anniversary in ${days} day${days===1?'':'s'}`,
            subline: p.client || undefined,
          });
        }
      }
    }
  }

  out.sort((a,b) => a.when.localeCompare(b.when));
  return out;
}
```

- [ ] **Step 2: Verify accessors return the right shapes**

Reload the page (sign in if the auth gate appears). In the console:

```js
console.log('activities:', getActivities());          // expect []  (no real data yet)
console.log('goals:',      getGoals());               // expect { ap: <number>, apps:0, lives:0, persistencyPct:0 }
console.log('chargebacks:',getChargebackExposure());  // expect { totalAdvanced:0, earnedDown:0, earnDownSchedule:[], atRiskPolicies:[] } unless lapsed policies exist
console.log('events:',     getEvents());              // expect [] unless policies have nearby issueDate / draft dates
```

Confirm each accessor:
1. Returns the documented shape (no `undefined` fields).
2. Does not throw when `policies` is empty / unset.
3. `getGoals().ap` matches the existing monthly AP goal shown in the hero ring.

- [ ] **Step 3: Snapshot checkpoint**

```bash
cp "index-3.html" "archive/index-2026-05-11-ds-data-layer.html"
```

---

## Task 6: Add the playground section + dev-only nav entry

**Files:**
- Modify: `index-3.html` — HTML body (new `<div class="section sum-v3" id="sec-ds-playground">`), JS init helper called from `bootDashboard`.

The playground gives every later task a single page where every primitive can be eyeballed in both themes. It's hidden behind `?ds=1` so an agent never sees it.

- [ ] **Step 1: Find where to insert the playground markup**

```bash
grep -n 'id="sec-quoter"' index-3.html
```

The line **immediately above** `<div class="section" id="sec-quoter">` is where `#sec-summary` ends. Insert the playground section there — between `#sec-summary` and `#sec-quoter`, at the same indentation level.

- [ ] **Step 2: Insert the playground markup**

```html
    <!-- ========== DS PLAYGROUND (dev-only, ?ds=1) ========== -->
    <div class="section sum-v3" id="sec-ds-playground">
      <div class="card">
        <div class="card-head">
          <div class="kpi-label">Design System Playground</div>
          <span class="ds-trend" data-tone="static">DEV ONLY</span>
        </div>
        <p style="font:13px/19px var(--sans);color:var(--text2);margin:0 0 16px">
          One of every Phase 0 primitive. Use this surface to verify visual changes after editing
          <code>--ds-*</code> tokens or the <code>ds*</code> factories. Toggle light/dark mode to
          confirm both themes render correctly. URL param <code>?ds=1</code> is the only way in.
        </p>
        <div class="ds-playground" id="ds-playground-mount"></div>
      </div>
    </div>
```

- [ ] **Step 3: Find the JS init wiring point**

```bash
grep -n 'function bootDashboard' index-3.html
```

If `bootDashboard` does not exist yet (it's referenced in `architecture.md` as the auth-gate post-login mount), search instead for the `DOMContentLoaded` handler:

```bash
grep -n 'DOMContentLoaded' index-3.html
```

Either way, you need a single function that runs once after the page is ready and the user is signed in.

- [ ] **Step 4: Insert the playground init helper near the other DS code**

Append this **immediately after** the `getEvents()` function from Task 5:

```js
// ---- DS playground init (dev-only, gated on ?ds=1) ----
function dsInitPlayground(){
  const url = new URLSearchParams(location.search);
  if (url.get('ds') !== '1') return;

  // Reveal the nav entry.
  const sidebarBot = document.querySelector('.sidebar .nav-item[onclick*="settings"]');
  if (sidebarBot && !document.getElementById('nav-ds')){
    const a = document.createElement('div');
    a.className = 'nav-item';
    a.id = 'nav-ds';
    a.onclick = () => nav('ds-playground');
    a.innerHTML = '<span class="ico" data-ico="palette"></span><span class="nav-lbl-text">Design System</span>';
    sidebarBot.parentNode.insertBefore(a, sidebarBot);
  }

  const mount = document.getElementById('ds-playground-mount');
  if (!mount || mount.dataset.mounted === '1') return;
  mount.dataset.mounted = '1';

  const group = (title, ...children) => {
    const g = document.createElement('div'); g.className = 'ds-playground__group';
    const t = document.createElement('div'); t.className = 'ds-playground__title'; t.textContent = title;
    const r = document.createElement('div'); r.className = 'ds-playground__row';
    children.forEach(c => r.appendChild(c));
    g.appendChild(t); g.appendChild(r);
    return g;
  };

  // StatCards — one per accent + one per variant.
  mount.appendChild(group('StatCard — accents',
    dsStatCard({ label:'Default', hero:'$12,450', sub:'info accent', accent:'info', trend:{tone:'up',text:'+12%'} }),
    dsStatCard({ label:'On pace', hero:'42 apps',  sub:'success',     accent:'success', trend:{tone:'up',text:'+8%'} }),
    dsStatCard({ label:'Caution', hero:'18 days',  sub:'warning',     accent:'warning', trend:{tone:'warn',text:'CHECK'} }),
    dsStatCard({ label:'At risk', hero:'$2,300',   sub:'danger',      accent:'danger',  trend:{tone:'down',text:'-15%'} }),
    dsStatCard({ label:'Momentum',hero:'7-day',    sub:'streak',      accent:'momentum',trend:{tone:'momentum',text:'STREAK'} }),
  ));
  mount.appendChild(group('StatCard — variants',
    dsStatCard({ label:'Sparkline', hero:'$12,450', sub:'7-day trend', accent:'info', sparkline:[3,5,4,6,7,9,8] }),
    dsStatCard({ label:'Clickable', hero:'$22,100', sub:'click me', accent:'momentum', onClick:()=>alert('clicked') }),
    dsStatCard({ label:'Alert',     hero:'$0',      sub:'no AP yet today', variant:'alert' }),
  ));

  // ProgressRings — three sizes / accents.
  mount.appendChild(group('ProgressRing',
    dsProgressRing({ value:65, max:100, size:160, thickness:14, accent:'momentum', centerValue:'65%', centerLabel:'Goal' }),
    dsProgressRing({ value:42, max:100, size:120, thickness:10, accent:'success',  centerValue:'42',  centerLabel:'Apps' }),
    dsProgressRing({ value:88, max:100, size:96,  thickness:8,  accent:'warning',  centerValue:'88%', centerLabel:'Pers.' }),
  ));

  // Sparklines — three accents.
  const spark = (data, accent) => {
    const wrap = document.createElement('div'); wrap.style.width = '240px';
    wrap.appendChild(dsSparkline({ data, accent, height:48 })); return wrap;
  };
  mount.appendChild(group('Sparkline',
    spark([3,5,4,6,7,9,8,11,10], 'info'),
    spark([1,1,2,1,3,2,4,3,5],   'success'),
    spark([8,7,5,6,3,4,2,1,1],   'danger'),
    spark([],                    'info'),     // empty placeholder
  ));

  // TrendBadges — every tone.
  const trendRow = group('TrendBadge',
    dsTrendBadge({tone:'up',       text:'+12.5%'}),
    dsTrendBadge({tone:'down',     text:'-4.0%'}),
    dsTrendBadge({tone:'flat',     text:'— flat'}),
    dsTrendBadge({tone:'warn',     text:'CHECK'}),
    dsTrendBadge({tone:'momentum', text:'ON A ROLL'}),
    dsTrendBadge({tone:'static',   text:'FORWARD'}),
  );
  mount.appendChild(trendRow);

  // ActionItems — one per tone.
  const actionsCard = document.createElement('div');
  actionsCard.className = 'card';
  actionsCard.style.padding = '8px';
  const heading = document.createElement('div');
  heading.className = 'ds-playground__title';
  heading.style.padding = '12px 16px 4px';
  heading.textContent = 'ActionItem';
  actionsCard.appendChild(heading);
  ['urgent','today','opportunity'].forEach((tone, i) => {
    const titles = {urgent:'Free-look expires today — Maria Rodriguez',
                    today:'Confirm 2pm exam — James Park',
                    opportunity:'Anniversary in 12 days — Sandra Liu'};
    const metas  = {urgent:'Last contact 4 days ago · UW called yesterday',
                    today:'AmFam Term 20 · 2:00 PM Pacific',
                    opportunity:'IUL upgrade candidate · est +$420 commission'};
    const ctas   = {urgent:'Mark called', today:'Confirmed', opportunity:'Send template'};
    const a = dsActionItem({
      icon: tone==='urgent'?'phone':tone==='today'?'clock':'sparkle',
      tone, title:titles[tone], meta:metas[tone], ctaLabel:ctas[tone],
      onComplete: () => console.log('completed', tone),
    });
    actionsCard.appendChild(a);
  });
  const actionsGroup = document.createElement('div'); actionsGroup.className = 'ds-playground__group';
  actionsGroup.appendChild(actionsCard);
  mount.appendChild(actionsGroup);

  // EmptyState.
  mount.appendChild(group('EmptyState',
    dsEmptyState({ icon:'inbox', title:'No actions queued',
      body:'When clients have callbacks, expiring quotes, or anniversaries you can act on, they show up here.',
      ctaLabel:'View all clients', onCta:() => console.log('view clients') }),
  ));
}
```

- [ ] **Step 5: Wire `dsInitPlayground` into the existing boot flow**

The architecture doc (line 108) says: *"`bootDashboard` hydrates `policies` and `leads` from namespaced localStorage and renders the dashboard."* Find where `bootDashboard` finishes its render work:

```bash
grep -n 'function bootDashboard' index-3.html
```

Add a single line at the very end of `bootDashboard`'s body (just before the closing `}`):

```js
  if (typeof dsInitPlayground === 'function') dsInitPlayground();
```

If `bootDashboard` is not present (architecture.md is stale), add the same line at the very end of the `DOMContentLoaded` handler instead.

- [ ] **Step 6: Verify in browser**

Open `index-3.html?ds=1` in a browser, sign in if needed.

1. The sidebar should show a new **Design System** nav entry above Settings.
2. Click it. The playground section should render with rows for StatCard / ProgressRing / Sparkline / TrendBadge / ActionItem / EmptyState.
3. Visually confirm:
   - Each accent color is distinct and readable.
   - The progress rings animate in over ~400ms on first paint.
   - Trend badges have correct background tints per tone.
   - The "Mark called" / "Confirmed" / "Send template" buttons fade + slide their row out when clicked, and log to console.
   - The empty state CTA logs to console.
4. Toggle light mode (existing toggle in the UI). Confirm:
   - Cards still readable (no white text on white).
   - Semantic colors stay distinguishable (success = heritage green, warning = burnished gold, danger = signal red).
   - Sparkline empty placeholder uses dark dashed line, not white.
5. Open `index-3.html` (no `?ds=1`). The sidebar should NOT have the Design System entry. Navigate around — no errors in the console.

If any check fails, fix before moving on. Common pitfalls:
- Indentation drift (CSS rule outside `:root`).
- Calling `dsInitPlayground` before `bootDashboard` runs (mount element doesn't exist yet).
- `nav('ds-playground')` not switching sections — the existing `nav()` helper expects a section ID matching `sec-<name>`, which we follow (`sec-ds-playground`), so this should just work.

- [ ] **Step 7: Snapshot checkpoint**

```bash
cp "index-3.html" "archive/index-2026-05-11-ds-foundation-complete.html"
```

---

## Task 7: Update architecture doc + add memory notes

**Files:**
- Modify: `docs/architecture.md` — add a new short section at the bottom describing the DS layer.
- Memory: write a new memory file documenting the DS-foundation deliverables and link it from `MEMORY.md`.

This task closes the loop so future sessions inherit the new conventions.

- [ ] **Step 1: Append a section to `docs/architecture.md`**

At the end of the file, append:

```markdown

## Dashboard Design System (DS Layer — Phase 0, 2026-05-11)

The dashboard-redesign series authors against a `--ds-*` token layer added on top
of the existing Producer Stack tokens. Both layers coexist; legacy widgets keep
using `--bg`, `--accent`, `--text`; new widgets use `--ds-color-*`,
`--ds-radius-*`, `--ds-space-*`, `--ds-duration-*`.

**Where things live (all in `index-3.html`):**

- Tokens: bottom of the `:root` block, mirrored in `body.light`, with a
  `prefers-reduced-motion` override at the bottom of `<style>`.
- Primitive CSS: the `/* ---- DS PRIMITIVES ---- */` block right above
  `/* ---- AUTH GATE ---- */`.
- Primitive JS factories: the `// ---- DS PRIMITIVES ----` block right after
  `getContract` / `saveContract`.
- Data layer: the `// ---- DS DATA LAYER ----` block right after the factories.
- Playground: `#sec-ds-playground` (gated on `?ds=1`), init via `dsInitPlayground`
  called from the end of `bootDashboard`.

**Six primitives:** `dsStatCard`, `dsProgressRing`, `dsSparkline`, `dsTrendBadge`,
`dsActionItem`, `dsEmptyState`. All take a single options object, return DOM
elements, and read no globals. Add new accents by extending the `DS_ACCENTS` set
and adding the matching `[data-accent="..."]` CSS rule.

**Four data shapes:** `Activity`, `Goals`, `ChargebackExposure`, `EventItem`.
Accessors: `getActivities`, `getGoals`, `getChargebackExposure`, `getEvents`.
Real persistence (Supabase `activities` / `goals` tables, per-carrier
chargeback schedules) is a follow-up plan — for now accessors derive from
`policies` or fall back to empty arrays.

**Verification surface:** open `index-3.html?ds=1`, click the **Design System**
nav entry. Every primitive renders there in light + dark.

**Spec / plan trail:**

- Vision: `docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md`
- Phase 0 plan: `docs/superpowers/plans/2026-05-11-dashboard-redesign-phase-0-foundation.md`
```

- [ ] **Step 2: Write a new memory file**

Save to `/Users/tanner/.claude/projects/-Users-tanner-Jace--Life-Insurance/memory/project_dashboard_ds_foundation.md`:

```markdown
---
name: dashboard-ds-foundation
description: PolicyPilot agent dashboard has a Phase 0 design-system layer — `--ds-*` tokens + 6 primitives (`dsStatCard`, `dsProgressRing`, `dsSparkline`, `dsTrendBadge`, `dsActionItem`, `dsEmptyState`) + 4 data shapes/accessors. New widgets author against this layer, not the legacy Producer Stack tokens or hand-rolled `.kpi-*` markup.
metadata:
  type: project
---

The agent dashboard (`index-3.html`, `#sec-summary` and forward) has a Phase 0
design-system layer landed 2026-05-11 to support a multi-phase redesign series.

**Tokens** — `--ds-*` prefix, lives at the bottom of the existing `:root` block
and mirrored in `body.light`. Includes semantic colors (success / warning /
danger / info / neutral), a momentum accent (`#5BA0E8` electric blue, midnight
navy in light mode), spacing 1-8, radius sm/md/lg/pill, elevation flat/hover/
modal, motion fast/base/slow + ease tokens. Reduced-motion media query collapses
durations to 0ms.

**Six primitives** (factories returning DOM elements): `dsStatCard`,
`dsProgressRing`, `dsSparkline`, `dsTrendBadge`, `dsActionItem`, `dsEmptyState`.
Each takes a single options object; none read globals. CSS classes use the
`.ds-*` prefix.

**Four data shapes** (JSDoc-typed) + stub accessors: `Activity[]`, `Goals`,
`ChargebackExposure`, `EventItem[]` exposed via `getActivities()`, `getGoals()`,
`getChargebackExposure()`, `getEvents()`. Real persistence (Supabase tables for
activities / goals, per-carrier chargeback earn-down schedules) is a follow-up
plan — for now accessors derive from `policies` or return `[]`.

**Verification surface:** `index-3.html?ds=1` → "Design System" nav entry shows
the playground (`#sec-ds-playground`). Useful before/after token edits to
visually confirm both themes still work.

**Why:** The dashboard-redesign vision (see [[reference_dashboard_redesign_vision]])
calls for 7 phases of new widgets. Without a shared token + primitive layer,
each phase reinvented its own. Phase 0 unblocks Phases 1-6 by giving them
typed data shapes and reusable building blocks.

**How to apply:** When building any new dashboard widget, author against the
`--ds-*` tokens and use the six factories. Do not hand-roll new `.kpi-*`
markup — use `dsStatCard`. Do not hardcode hex colors — use `--ds-color-*`.
Bind to `getActivities`/`getGoals`/`getChargebackExposure`/`getEvents` rather
than reaching into `policies`/`leads` directly.

**Plan trail:**
- Vision spec: `docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md`
- Phase 0 plan: `docs/superpowers/plans/2026-05-11-dashboard-redesign-phase-0-foundation.md`
```

- [ ] **Step 3: Add a companion reference memory**

Save to `/Users/tanner/.claude/projects/-Users-tanner-Jace--Life-Insurance/memory/reference_dashboard_redesign_vision.md`:

```markdown
---
name: reference-dashboard-redesign-vision
description: Multi-phase plan to make the agent dashboard "stickier and more visually stimulating" — 7 phases (Foundation, Hero, Pipeline, Income Reality, Persistency, Activity & Streaks, Bonus Intelligence, Polish). Vision spec is the canonical source; each phase has its own build-ready plan.
metadata:
  type: reference
---

Tanner pasted a vision plan on 2026-05-11 for a multi-phase rebuild of the
agent summary tab. Vision document is the canonical source — return to it when
scoping any new dashboard widget.

**Where it lives:**
`/Users/tanner/Jace- Life Insurance/docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md`

**Phases:**
- Phase 0 — Foundation (tokens + 6 primitives + 4 data shapes). [[dashboard-ds-foundation]]
- Phase 1 — Hero rebuild: Smart Goal Hub (multi-ring, Pulse Score) + Action Hub (urgent/today/opportunity list — *the* stickiness engine).
- Phase 2 — Pipeline funnel with aging overlay + drill-down.
- Phase 3 — Income Reality row (Net Commission, Chargeback Exposure, Renewal Forecast).
- Phase 4 — Persistency Dashboard + Book Composition.
- Phase 5 — Activity Pulse + Streaks/Records.
- Phase 6 — Bonus Tier Intelligence (per-carrier ladder).
- Phase 7 — Polish (motion, personalization, notifications, "moment" moments).

**Build order from the user (NOT phase order):**
0 → 1.2 (Action Hub) → 2 (Pipeline) → 1.1 (Goal Hub) → 3 → 5 → 4 → 6 → 7.
The Action Hub ships standalone first because it's the biggest stickiness win.

**How to apply:** When asked to "add a dashboard widget" or "improve the
summary," consult this vision before scoping. Do not invent new widgets — find
which phase the request maps to and follow that phase's plan. If no plan
exists for the phase yet, write one against the vision before coding.
```

- [ ] **Step 4: Update `MEMORY.md` with both new pointers**

Open `/Users/tanner/.claude/projects/-Users-tanner-Jace--Life-Insurance/memory/MEMORY.md` and append two lines:

```
- [Dashboard DS foundation](project_dashboard_ds_foundation.md) — `--ds-*` tokens + 6 primitives + 4 data shapes landed 2026-05-11; new dashboard widgets author against this layer
- [Dashboard redesign vision](reference_dashboard_redesign_vision.md) — 7-phase rebuild of the agent summary tab; canonical spec at docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md
```

- [ ] **Step 5: Append to the vault log**

Open `/Users/tanner/Documents/Construct.AI/Construct.AI/log.md` and append:

```
## [2026-05-11] ingest | Dashboard redesign Phase 0 foundation — tokens, primitives, data layer
```

(Per the global CLAUDE.md vault convention. If this user-instruction step doesn't apply on the current run, skip it without aborting.)

---

## Self-Review (run before declaring Phase 0 done)

Walk the spec section by section against the tasks. Confirm each is covered:

| Spec item (vision §0) | Where it's built |
|---|---|
| Semantic palette: success / warning / danger / info / neutral | Task 2 — `--ds-color-{success,warning,danger,info,neutral}` |
| Momentum accent | Task 2 — `--ds-color-momentum` |
| Display weight for hero numbers | Task 3 — `.ds-stat__hero` reuses existing `--display` (Sora 28px/32px) |
| Spacing scale | Task 2 — `--ds-space-1` through `--ds-space-8` |
| Radius scale | Task 2 — `--ds-radius-sm/md/lg/pill` |
| Elevation scale (3 levels) | Task 2 — `--ds-elev-flat/hover/modal` |
| Motion tokens (fast/base/slow + ease-out-expo) | Task 2 — `--ds-duration-{fast,base,slow}`, `--ds-ease-out-expo` |
| StatCard with default/trend/sparkline/progress/alert variants | Tasks 3 + 4 — `.ds-stat[data-variant]`, `dsStatCard` accepts `variant`, `trend`, `sparkline`, `onClick` (clickable acts as the "interactive" variant) |
| ProgressRing primitive | Tasks 3 + 4 — `.ds-ring` + `dsProgressRing` |
| Sparkline primitive (extracted from existing) | Tasks 3 + 4 — `.ds-spark` + `dsSparkline`. **Note:** the existing `_renderSparkline` inside `renderSummary` is NOT migrated in Phase 0; that's a Phase-1 / Phase-3 task once the new widgets replace those KPI tiles. |
| TrendBadge replacing ad-hoc delta chips | Tasks 3 + 4 — `.ds-trend` + `dsTrendBadge`. Same caveat as Sparkline — existing `.kpi-delta` stays until the relevant widget gets replaced. |
| ActionItem primitive | Tasks 3 + 4 — `.ds-action` + `dsActionItem`, with `data-state="completed"` micro-animation |
| EmptyState primitive | Tasks 3 + 4 — `.ds-empty` + `dsEmptyState` |
| Data layer: policies / activities / goals / chargebacks / events | Task 5 — `policies` already exists; `Activity`, `Goals`, `ChargebackExposure`, `EventItem` shapes + accessors added |
| **Acceptance:** "A new widget can be built in <1 day because primitives and data are ready." | Playground (Task 6) is the proof — every primitive demoable in 30 seconds. |

Cross-cutting:
- Light + dark parity: Task 2 mirrors all colors; Task 6 step 6 explicitly toggles modes.
- `prefers-reduced-motion`: Task 2 step 4 collapses durations to 0ms.
- Accessibility: `dsStatCard` adds `role=button` + `tabindex` + Enter/Space handler when clickable; ProgressRing SVG has `aria-hidden`; ActionItem button is a real `<button>`.
- No legacy code touched: every change is purely additive. The hero, KPI grid, pace card, drafts strip, status bar, and carrier donut all keep their existing markup and CSS untouched.

If any row in the table above doesn't have a clear answer, **stop and add the missing task before declaring Phase 0 done**.

---

## What's Next (after Phase 0 ships)

Per the user's preferred build order, the immediate next plan is:

**Phase 1.2 — Action Hub.** Standalone widget that lives in the right column of the hero. Reads `getEvents()` and renders `dsActionItem` rows in three buckets (urgent / today / opportunity). Tap-to-complete uses the built-in micro-animation. This widget alone is the biggest stickiness win.

The Phase 1.2 plan should be written next: `docs/superpowers/plans/2026-05-11-dashboard-redesign-phase-1-2-action-hub.md`.
