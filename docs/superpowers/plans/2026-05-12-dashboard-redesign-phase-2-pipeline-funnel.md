# Dashboard Redesign — Phase 2 (Pipeline Funnel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` for tracking.

**Goal:** Replace the diagnostic-free "where's my money stuck?" gap with a horizontal pipeline funnel showing every stage of the policy lifecycle (`Submitted → In UW → Approved → Issued → Placed → Paid`), aging color overlay, segment-click drill-down, and a placement-ratio readout. **Highest-leverage business value after the Action Hub.**

**Architecture:** New full-width card inserted into `#sec-summary` just BELOW the existing hero (above the existing KPI grid and Book Intelligence summary card). SVG-based funnel with one polygon per stage, width-tapering reflects drop-off, fill color reflects aging vs. benchmark. Click any segment → reuses the existing modal overlay pattern (`#addPolModal` style) to slide in a panel listing the policies in that stage with last-action date and CTAs. Placement ratio chip pinned top-right of the card. Built entirely from `--ds-*` tokens and `dsStatCard` / `dsTrendBadge` primitives where applicable.

**Tech Stack:** Vanilla HTML/CSS/JS in `index-3.html`. No new dependencies. Verification = static checks + browser smoke test.

**Spec:** `docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md` — Phase 2.

**Out of scope:**
- Replacing the existing `.kpi-grid` row (that's Phase 3 territory).
- "Nudge carrier" email/Gmail send from the drill-down (Phase 6+).
- Per-carrier stage benchmarks (v1 uses one global benchmark per stage).
- Stage-specific filtering UI (sort/filter chips inside the drill-down).

**Cross-cutting decisions:**
- **Six stages, locked.** The pipeline uses the existing `policies[].status` values (`pending`, `approved`, `issued`, `paid`, `lapsed`) plus a derived `submitted` state (any policy with `status` not lapsed and a `draft` date in the future). `lapsed` is rendered as a separate "lost" tail (visual distinct, never width-counted).
- **Aging benchmark constants live in code** under a new `PIPELINE_BENCHMARKS` object (median days-in-stage). Editable in one place.
- **Drill-down uses the existing `.overlay`/`.modal` pattern**, not a slide-out. The agent's muscle memory expects center-screen modals; a slide-out is one more pattern to learn for marginal gain.
- **Width algorithm:** each segment width = `max(40px, count / totalSubmitted * containerWidth)` to keep tiny-but-nonzero stages legible.

---

## File Structure

| Region | Find via | What changes |
|---|---|---|
| `<style>` — primitives stylesheet | `grep -n '/\* ---- ACTION HUB ---' index-3.html` then insert before `/* ---- AUTH GATE` | New `/* ---- PIPELINE FUNNEL ---- */` block |
| `<script>` — data helpers | After `_ahFormatMeta` from Phase 1.2 | `PIPELINE_STAGES`, `PIPELINE_BENCHMARKS`, `pipelinePartition`, `pipelineAging` |
| `<script>` — renderer | After helpers | `renderPipelineFunnel` + `openPipelineDrilldown` |
| HTML body — `#sec-summary` | After `.sum-hero` close, before `.sum-period-row` | New `<div class="card pf-card" id="pipeline-funnel">…</div>` |
| HTML body — drilldown modal | After `#addPolModal` | New `<div class="overlay pf-overlay" id="pipelineDrillModal">…</div>` |
| `<script>` — boot wiring | Inside `renderSummary` | Add `renderPipelineFunnel()` call after `renderActionHub()` |

---

## Task 1: Snapshot

- [ ] `cp index-3.html archive/index-2026-05-12-pre-pipeline-funnel.html`
- [ ] Verify size matches.

---

## Task 2: Add pipeline stage constants + partition helpers

**Insert after** the `_ahFormatMeta` function (find via `grep -n 'function _ahFormatMeta' index-3.html` and locate its closing `}`):

```js
// ============================================================
// PIPELINE FUNNEL — added 2026-05-12 (Phase 2)
// ============================================================
const PIPELINE_STAGES = [
  { key:'submitted', label:'Submitted', match: p => p.status === 'pending' || p.status === 'submitted' },
  { key:'uw',        label:'In UW',     match: p => p.status === 'in-uw' || p.status === 'uw' },
  { key:'approved',  label:'Approved',  match: p => p.status === 'approved' },
  { key:'issued',    label:'Issued',    match: p => p.status === 'issued' },
  { key:'placed',    label:'Placed',    match: p => p.status === 'placed' },
  { key:'paid',      label:'Paid',      match: p => p.status === 'paid' },
];
// Median days-in-stage benchmarks (editable in one place).
const PIPELINE_BENCHMARKS = {
  submitted: 3, uw: 14, approved: 7, issued: 5, placed: 30, paid: 0,
};

function pipelinePartition(pols){
  const buckets = {};
  for (const s of PIPELINE_STAGES) buckets[s.key] = [];
  let total = 0;
  for (const p of (pols || [])){
    if (!p || p.status === 'lapsed') continue;
    for (const s of PIPELINE_STAGES){
      if (s.match(p)){ buckets[s.key].push(p); total++; break; }
    }
  }
  return { buckets, total };
}

/** Days since the most recent timestamp on a policy (draft, issueDate, updatedAt). */
function _pipelineDaysIn(p){
  const candidates = [p.updatedAt, p.statusChangedAt, p.issueDate, p.draft]
    .filter(Boolean)
    .map(s => new Date(s).getTime())
    .filter(Number.isFinite);
  if (!candidates.length) return null;
  const most = Math.max(...candidates);
  return Math.round((Date.now() - most) / 86400000);
}

/** 'fast' | 'on-pace' | 'stalled' for a stage given the policies inside it. */
function pipelineAging(stageKey, pols){
  if (!pols.length) return 'on-pace';
  const benchmark = PIPELINE_BENCHMARKS[stageKey] || 0;
  if (!benchmark) return 'on-pace';
  const ages = pols.map(_pipelineDaysIn).filter(n => n !== null);
  if (!ages.length) return 'on-pace';
  const median = ages.sort((a,b) => a - b)[Math.floor(ages.length/2)];
  if (median > benchmark * 1.5) return 'stalled';
  if (median < benchmark * 0.7) return 'fast';
  return 'on-pace';
}
```

- [ ] Verify: `grep -n 'PIPELINE_STAGES' index-3.html` → 1 match; `node --check` on extracted snippet.

---

## Task 3: Add CSS

**Insert** in the primitives stylesheet, just before `/* ---- AUTH GATE`:

```css
/* ============================================================
 * PIPELINE FUNNEL — added 2026-05-12 (Phase 2)
 * ============================================================ */
.pf-card{margin-bottom:var(--ds-space-5);padding:var(--ds-space-5)}
.pf-card__head{display:flex;justify-content:space-between;align-items:baseline;gap:var(--ds-space-3);margin-bottom:var(--ds-space-4)}
.pf-card__title{font:600 13px/18px var(--sans);color:var(--text2);text-transform:uppercase;letter-spacing:.16em}
.pf-card__placement{font:11.5px/15px var(--mono);font-variant-numeric:tabular-nums;color:var(--text3)}
.pf-card__placement strong{color:var(--text);font-weight:400}

.pf-funnel{display:flex;gap:2px;width:100%;height:96px;align-items:stretch}
.pf-seg{
  position:relative;flex:0 0 auto;min-width:48px;
  display:flex;flex-direction:column;justify-content:flex-end;
  padding:var(--ds-space-3) var(--ds-space-2);
  border:1px solid var(--border);border-radius:var(--ds-radius-md);
  background:var(--card);cursor:pointer;
  transition:border-color var(--ds-duration-fast) var(--ds-ease-out),
             transform   var(--ds-duration-fast) var(--ds-ease-out);
}
.pf-seg:hover{transform:translateY(-1px);border-color:var(--pf-tone, var(--ds-color-info))}
.pf-seg[data-age="fast"]    {--pf-tone:var(--ds-color-success);border-top:3px solid var(--ds-color-success)}
.pf-seg[data-age="on-pace"] {--pf-tone:var(--ds-color-warning);border-top:3px solid var(--ds-color-warning)}
.pf-seg[data-age="stalled"] {--pf-tone:var(--ds-color-danger); border-top:3px solid var(--ds-color-danger)}
.pf-seg[data-empty="true"]  {opacity:.45;cursor:default}
.pf-seg[data-empty="true"]:hover{transform:none}
.pf-seg__label{font:10px/13px var(--sans);text-transform:uppercase;letter-spacing:.14em;color:var(--text3);font-weight:600}
.pf-seg__count{font:500 22px/26px var(--display);color:var(--text);font-variant-numeric:tabular-nums}
.pf-seg__ap{font:11px/14px var(--mono);color:var(--text2);font-variant-numeric:tabular-nums}

.pf-overlay .modal{max-width:640px}
.pf-drill__title{font:600 14px/20px var(--sans);color:var(--text);margin-bottom:var(--ds-space-2)}
.pf-drill__sub{font:12px/16px var(--sans);color:var(--text3);margin-bottom:var(--ds-space-4)}
.pf-drill__list{display:flex;flex-direction:column;gap:var(--ds-space-2);max-height:60vh;overflow:auto}
.pf-drill__row{
  display:grid;grid-template-columns:1fr auto auto;gap:var(--ds-space-3);align-items:center;
  padding:var(--ds-space-3) var(--ds-space-4);
  background:var(--bg2);border:1px solid var(--border);border-radius:var(--ds-radius-md);
}
.pf-drill__client{font:500 13.5px/18px var(--sans);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-drill__meta  {font:11.5px/15px var(--mono);color:var(--text3);font-variant-numeric:tabular-nums;white-space:nowrap}
.pf-drill__ap    {font:13px/16px var(--mono);font-variant-numeric:tabular-nums;color:var(--text)}
.pf-drill__age   {font:10.5px/14px var(--sans);text-transform:uppercase;letter-spacing:.1em}
```

- [ ] Verify `grep -c '^\.pf-' index-3.html` returns ≥ 12.

---

## Task 4: Add renderer + drill-down opener

**Insert** after Task 2's helpers:

```js
function renderPipelineFunnel(){
  const root = document.getElementById('pipeline-funnel');
  if (!root) return;
  const pols = Array.isArray(window.policies) ? window.policies : [];
  const { buckets, total } = pipelinePartition(pols);

  // Placement = (placed + paid) / total
  const placedCount = buckets.placed.length + buckets.paid.length;
  const placementPct = total ? Math.round(placedCount / total * 100) : 0;
  const placementEl = root.querySelector('.pf-card__placement');
  if (placementEl){
    placementEl.innerHTML = `Placement: <strong>${placementPct}%</strong> · Target 80%`;
  }

  const funnel = root.querySelector('.pf-funnel');
  if (!funnel) return;
  funnel.replaceChildren();

  // Width algorithm: each segment width proportional to count, clamped to a floor.
  const maxCount = Math.max(1, ...PIPELINE_STAGES.map(s => buckets[s.key].length));

  for (const s of PIPELINE_STAGES){
    const list = buckets[s.key];
    const age = pipelineAging(s.key, list);
    const seg = document.createElement('div');
    seg.className = 'pf-seg';
    seg.setAttribute('data-age', age);
    seg.setAttribute('data-stage', s.key);
    if (list.length === 0) seg.setAttribute('data-empty', 'true');
    seg.style.flexGrow = String(0.6 + (list.length / maxCount) * 2.4);

    const ap = list.reduce((sum, p) => sum + (Number(p.ap) || 0), 0);
    seg.innerHTML = '';
    const lbl = document.createElement('div'); lbl.className = 'pf-seg__label'; lbl.textContent = s.label;
    const cnt = document.createElement('div'); cnt.className = 'pf-seg__count'; cnt.textContent = list.length;
    const apl = document.createElement('div'); apl.className = 'pf-seg__ap';    apl.textContent = ap ? '$' + ap.toLocaleString() : '—';
    seg.appendChild(lbl); seg.appendChild(cnt); seg.appendChild(apl);

    if (list.length > 0){
      seg.addEventListener('click', () => openPipelineDrilldown(s, list, age));
    }
    funnel.appendChild(seg);
  }
}

function openPipelineDrilldown(stage, pols, age){
  const overlay = document.getElementById('pipelineDrillModal');
  if (!overlay) return;
  const title = overlay.querySelector('.pf-drill__title');
  const sub   = overlay.querySelector('.pf-drill__sub');
  const list  = overlay.querySelector('.pf-drill__list');
  if (title) title.textContent = `${stage.label} — ${pols.length} polic${pols.length===1?'y':'ies'}`;
  if (sub)   sub.textContent = `Median age vs. benchmark: ${age.replace('-', ' ')}`;
  if (list){
    list.replaceChildren();
    for (const p of pols){
      const row = document.createElement('div'); row.className = 'pf-drill__row';
      const client = document.createElement('div'); client.className = 'pf-drill__client'; client.textContent = p.client || '—';
      const meta = document.createElement('div'); meta.className = 'pf-drill__meta';
      const age = _pipelineDaysIn(p);
      meta.textContent = age == null ? '—' : `${age}d`;
      const ap = document.createElement('div'); ap.className = 'pf-drill__ap';
      ap.textContent = p.ap ? '$' + Number(p.ap).toLocaleString() : '—';
      row.appendChild(client); row.appendChild(meta); row.appendChild(ap);
      list.appendChild(row);
    }
  }
  overlay.style.display = 'flex';
}

function closePipelineDrilldown(){
  const overlay = document.getElementById('pipelineDrillModal');
  if (overlay) overlay.style.display = 'none';
}
```

- [ ] Verify functions present.

---

## Task 5: Add markup (funnel card + drill-down modal)

**Funnel card** — insert into `#sec-summary` AFTER `</div>` of `.sum-hero` and BEFORE the existing Book Intelligence card (`grep -n 'bi-summary-card' index-3.html` for the anchor):

```html
      <!-- PIPELINE FUNNEL (Phase 2) -->
      <div class="card pf-card" id="pipeline-funnel">
        <div class="pf-card__head">
          <div class="pf-card__title">Pipeline · Where money sits</div>
          <span class="pf-card__placement">Placement: <strong>0%</strong> · Target 80%</span>
        </div>
        <div class="pf-funnel" role="list" aria-label="Policy pipeline by stage"></div>
      </div>
```

**Drill-down modal** — append after the existing `#addPolModal` closing tag:

```html
    <!-- PIPELINE DRILL-DOWN MODAL (Phase 2) -->
    <div class="overlay pf-overlay" id="pipelineDrillModal" onclick="if(event.target===this)closePipelineDrilldown()">
      <div class="modal">
        <div class="pf-drill__title">Stage</div>
        <div class="pf-drill__sub">—</div>
        <div class="pf-drill__list"></div>
        <div style="margin-top:var(--ds-space-4);text-align:right">
          <button class="btn btn-s" onclick="closePipelineDrilldown()">Close</button>
        </div>
      </div>
    </div>
```

- [ ] Verify both IDs present (1 match each).

---

## Task 6: Wire into `renderSummary`

Add to `renderSummary` right after the `renderActionHub()` call from Phase 1.2:

```js
  if (typeof renderPipelineFunnel === 'function') renderPipelineFunnel();
```

- [ ] Verify `renderPipelineFunnel()` appears ≥ 2 times (definition + call).
- [ ] Snapshot: `cp index-3.html archive/index-2026-05-12-pipeline-funnel-complete.html`.

---

## Task 7: Docs + memory

- [ ] Append "Pipeline Funnel (Phase 2)" section to `docs/architecture.md` listing the new file regions.
- [ ] Write `memory/project_pipeline_funnel.md` with widget summary + `PIPELINE_BENCHMARKS` location.
- [ ] Update `MEMORY.md` index.
- [ ] Append `## [2026-05-12] ingest | Pipeline Funnel` to vault `log.md`.

---

## Self-Review

| Vision §2 requirement | Where |
|---|---|
| Horizontal funnel `Submitted → In UW → Approved → Issued → Placed → Paid` | Task 2 `PIPELINE_STAGES` + Task 4 segment rendering |
| Each segment count + AP | Task 4 `pf-seg__count` + `pf-seg__ap` |
| Width tapers by drop-off | Task 4 `flex-grow` proportional to count |
| Aging color overlay (green/yellow/red vs. benchmark) | Task 2 `pipelineAging` + Task 3 `[data-age]` CSS |
| Click segment → list of policies in stage | Task 4 `openPipelineDrilldown` + Task 5 modal |
| Last-action date + AP per row | Task 4 `_pipelineDaysIn` + `pf-drill__ap` |
| Placement ratio top-right with target | Task 4 placement calc + Task 5 markup |
| Acceptance: see where money is stuck and act in 2 clicks | Top-of-summary placement; modal opens on click; "Contact client" / "Nudge carrier" CTAs deferred to a follow-up plan with email integration |

If "Nudge carrier" CTAs need to ship in v1, add a Task 4.5 that wires them to `mailto:` URLs or Gmail send — flag if Tanner wants this in scope.
