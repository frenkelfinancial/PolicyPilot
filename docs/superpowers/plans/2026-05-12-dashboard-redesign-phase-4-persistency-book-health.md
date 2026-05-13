# Dashboard Redesign — Phase 4 (Persistency & Book Health) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Two-card row showing **Persistency Dashboard** (13-month + 25-month rates + free-look watch list + NSF alerts) and **Book Composition** (product mix donut + concentration warning + key averages). Lets the agent spot persistency risk before it becomes a chargeback.

**Architecture:** New `.ph-row` inserted below the Activity & Momentum row in `#sec-summary`. Card 1 reuses `dsProgressRing` (small variants) for 13-mo and 25-mo persistency rates with an industry-benchmark line drawn underneath. Free-look watch list reuses `dsActionItem`-styled rows but read-only (no CTA — those live in the Action Hub). Card 2 is a product-mix donut + side stats list.

**Tech Stack:** Same as Phase 0.

**Spec:** §4.

**Out of scope:**
- Real industry benchmarks per carrier — uses two configurable constants (`PERSIST_BENCH_13M = 0.85`, `PERSIST_BENCH_25M = 0.75`).
- NSF/missed-draft real-time alerts (would need a webhook into payment processors). v1 surfaces only the `policies[].status === 'nsf'` count if such a status exists.
- Concentration drill-down panel.

**Cross-cutting:**
- **Persistency math:** ratio of `(in-force at month M) / (issued at month M − 13)`. With `policies[].issueDate` and `policies[].status` we have enough.
- **In-force** = `status in (issued, placed, paid)`.
- **Free-look watch list** = policies with `issueDate` in the last 30 days AND in-force. Read-only — distinct from Action Hub Urgent (which surfaces ≤7-day expirations).
- **Concentration warning** triggers when any single carrier > 50% of in-force AP.

---

## File Structure

| Region | Where | What |
|---|---|---|
| `<style>` | Before AUTH GATE | `/* ---- PERSISTENCY HEALTH ---- */` block |
| `<script>` helpers | After Phase 5 helpers | `persistency13mo`, `persistency25mo`, `freeLookWatch`, `productMix`, `carrierConcentration` |
| `<script>` renderer | After helpers | `renderPersistencyHealth` |
| HTML body — `#sec-summary` | After `#activity-momentum` close | New `<div class="ph-row" id="persistency-health">…</div>` |
| `<script>` `renderSummary` | After `renderActivityMomentum()` | `renderPersistencyHealth()` |

---

## Task 1: Snapshot

- [ ] `cp index-3.html archive/index-2026-05-12-pre-persistency-health.html`

---

## Task 2: Helpers

```js
// ============================================================
// PERSISTENCY & BOOK HEALTH — added 2026-05-12 (Phase 4)
// ============================================================
const PERSIST_BENCH_13M = 0.85;
const PERSIST_BENCH_25M = 0.75;
const IN_FORCE = new Set(['issued','placed','paid']);

function _polsIssuedMonthsAgo(pols, monthsAgo){
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsAgo);
  return pols.filter(p => {
    if (!p.issueDate) return false;
    const d = new Date(p.issueDate);
    return Number.isFinite(d.getTime()) && d <= cutoff;
  });
}

function persistency13mo(pols){
  const cohort = _polsIssuedMonthsAgo(pols, 13);
  if (!cohort.length) return { rate: null, cohort: 0, kept: 0 };
  const kept = cohort.filter(p => IN_FORCE.has(p.status)).length;
  return { rate: kept / cohort.length, cohort: cohort.length, kept };
}

function persistency25mo(pols){
  const cohort = _polsIssuedMonthsAgo(pols, 25);
  if (!cohort.length) return { rate: null, cohort: 0, kept: 0 };
  const kept = cohort.filter(p => IN_FORCE.has(p.status)).length;
  return { rate: kept / cohort.length, cohort: cohort.length, kept };
}

/** Policies with issueDate within the last 30 days AND in-force — the free-look watch. */
function freeLookWatch(pols){
  const cutoff = Date.now() - 30 * 86400000;
  return (pols || []).filter(p => {
    if (!p.issueDate || !IN_FORCE.has(p.status)) return false;
    const d = new Date(p.issueDate).getTime();
    if (!Number.isFinite(d) || d < cutoff) return false;
    const daysSince = Math.round((Date.now() - d) / 86400000);
    p._daysSinceIssue = daysSince;
    p._daysLeftInFreeLook = 30 - daysSince;
    return p._daysLeftInFreeLook >= 0;
  }).sort((a,b) => a._daysLeftInFreeLook - b._daysLeftInFreeLook);
}

function productMix(pols){
  const inForce = (pols || []).filter(p => IN_FORCE.has(p.status));
  const groups = new Map();
  for (const p of inForce){
    const key = p.productType || (p.productName || '').match(/term|whole|iul|ul|wl|fe|annuity/i)?.[0] || 'OTHER';
    groups.set(key.toUpperCase(), (groups.get(key.toUpperCase()) || 0) + (Number(p.ap) || 0));
  }
  const total = [...groups.values()].reduce((a,b) => a + b, 0);
  return { groups, total, count: inForce.length };
}

function carrierConcentration(pols){
  const inForce = (pols || []).filter(p => IN_FORCE.has(p.status));
  const map = new Map();
  for (const p of inForce) if (p.carrier) map.set(p.carrier, (map.get(p.carrier) || 0) + (Number(p.ap) || 0));
  const total = [...map.values()].reduce((a,b) => a + b, 0) || 1;
  const top = [...map.entries()].sort((a,b) => b[1] - a[1])[0];
  return top ? { carrier: top[0], pct: top[1] / total, ap: top[1] } : null;
}
```

---

## Task 3: CSS

```css
/* PERSISTENCY HEALTH — Phase 4 */
.ph-row{display:grid;grid-template-columns:1.3fr 1fr;gap:var(--ds-space-4);margin-bottom:var(--ds-space-5)}
@media (max-width:1100px){.ph-row{grid-template-columns:1fr}}

.ph-rates{display:grid;grid-template-columns:1fr 1fr;gap:var(--ds-space-4);margin-bottom:var(--ds-space-4)}
.ph-rate{display:flex;align-items:center;gap:var(--ds-space-3);padding:var(--ds-space-3);background:var(--bg2);border-radius:var(--ds-radius-md)}
.ph-rate__body{flex:1;min-width:0}
.ph-rate__pct{font:500 24px/28px var(--display);color:var(--text);font-variant-numeric:tabular-nums}
.ph-rate__lbl{font:10.5px/14px var(--sans);text-transform:uppercase;letter-spacing:.12em;color:var(--text3);font-weight:600}
.ph-rate__bench{font:11px/15px var(--mono);font-variant-numeric:tabular-nums;color:var(--text3);margin-top:4px}
.ph-rate__bench[data-tone="ok"]   {color:var(--ds-color-success)}
.ph-rate__bench[data-tone="warn"] {color:var(--ds-color-warning)}
.ph-rate__bench[data-tone="bad"]  {color:var(--ds-color-danger)}

.ph-watch__title{font:600 11px/14px var(--sans);text-transform:uppercase;letter-spacing:.12em;color:var(--text2);margin-bottom:var(--ds-space-2)}
.ph-watch__list{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow:auto}
.ph-watch__row{
  display:grid;grid-template-columns:1fr auto;gap:var(--ds-space-3);align-items:center;
  padding:var(--ds-space-2) var(--ds-space-3);
  background:var(--bg2);border-radius:var(--ds-radius-sm);
  font:12px/16px var(--sans);
}
.ph-watch__name{color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ph-watch__days{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text3)}
.ph-watch__days[data-urgency="urgent"]{color:var(--ds-color-danger)}
.ph-watch__days[data-urgency="today"]{color:var(--ds-color-warning)}

.ph-mix{display:flex;gap:var(--ds-space-4);align-items:center}
.ph-mix__donut{width:120px;height:120px;flex-shrink:0}
.ph-mix__list{flex:1;display:flex;flex-direction:column;gap:var(--ds-space-2);font:12px/16px var(--sans)}
.ph-mix__row{display:flex;align-items:center;gap:var(--ds-space-2)}
.ph-mix__swatch{width:10px;height:10px;border-radius:2px;flex-shrink:0}
.ph-mix__lbl{flex:1;color:var(--text2)}
.ph-mix__pct{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text)}

.ph-warn{
  margin-top:var(--ds-space-3);padding:var(--ds-space-3);
  background:var(--ds-color-warning-bg);color:var(--ds-color-warning);
  border-left:3px solid var(--ds-color-warning);border-radius:var(--ds-radius-sm);
  font:12px/16px var(--sans);
}
```

---

## Task 4: Renderer

```js
function renderPersistencyHealth(){
  const root = document.getElementById('persistency-health');
  if (!root) return;
  const pols = Array.isArray(window.policies) ? window.policies : [];
  root.replaceChildren();

  // ---- Card 1: Persistency Dashboard
  const p13 = persistency13mo(pols);
  const p25 = persistency25mo(pols);
  const card1 = dsStatCard({ label:'Persistency · 13 & 25 month', hero:'', accent:'success' });
  const hero = card1.querySelector('.ds-stat__hero'); if (hero) hero.remove();

  const rates = document.createElement('div'); rates.className = 'ph-rates';
  const buildRate = (key, lbl, p, bench) => {
    const wrap = document.createElement('div'); wrap.className = 'ph-rate';
    wrap.appendChild(dsProgressRing({
      value: p.rate == null ? 0 : Math.round(p.rate * 100),
      max: 100, size: 72, thickness: 8,
      accent: p.rate == null ? 'neutral' : p.rate >= bench ? 'success' : p.rate >= bench * 0.9 ? 'warning' : 'danger',
      centerValue: p.rate == null ? '—' : Math.round(p.rate * 100) + '%',
    }));
    const body = document.createElement('div'); body.className = 'ph-rate__body';
    const num = document.createElement('div'); num.className = 'ph-rate__pct'; num.textContent = p.rate == null ? '—' : Math.round(p.rate * 100) + '%';
    const l = document.createElement('div'); l.className = 'ph-rate__lbl'; l.textContent = lbl;
    const b = document.createElement('div'); b.className = 'ph-rate__bench';
    if (p.rate != null){
      const tone = p.rate >= bench ? 'ok' : p.rate >= bench * 0.9 ? 'warn' : 'bad';
      b.setAttribute('data-tone', tone);
      b.textContent = 'Benchmark ' + Math.round(bench * 100) + '% · ' + p.kept + '/' + p.cohort;
    } else { b.textContent = 'Not enough cohort data yet'; }
    body.appendChild(num); body.appendChild(l); body.appendChild(b);
    wrap.appendChild(body);
    return wrap;
  };
  rates.appendChild(buildRate('13', '13-Month', p13, PERSIST_BENCH_13M));
  rates.appendChild(buildRate('25', '25-Month', p25, PERSIST_BENCH_25M));
  card1.appendChild(rates);

  // Free-look watch list
  const watch = freeLookWatch(pols);
  const wtitle = document.createElement('div'); wtitle.className = 'ph-watch__title';
  wtitle.textContent = 'Free-look watch · ' + watch.length + ' polic' + (watch.length===1?'y':'ies') + ' in window';
  const wlist  = document.createElement('div'); wlist.className = 'ph-watch__list';
  if (!watch.length){
    const empty = document.createElement('div'); empty.className = 'ph-watch__row';
    empty.innerHTML = `<span class="ph-watch__name" style="color:var(--text3)">No policies in free-look window</span><span class="ph-watch__days">—</span>`;
    wlist.appendChild(empty);
  } else {
    for (const p of watch){
      const row = document.createElement('div'); row.className = 'ph-watch__row';
      const nm = document.createElement('span'); nm.className = 'ph-watch__name'; nm.textContent = p.client || 'Unnamed';
      const d  = document.createElement('span'); d.className = 'ph-watch__days';
      d.setAttribute('data-urgency', p._daysLeftInFreeLook <= 1 ? 'urgent' : p._daysLeftInFreeLook <= 7 ? 'today' : 'flat');
      d.textContent = p._daysLeftInFreeLook + 'd left';
      row.appendChild(nm); row.appendChild(d);
      wlist.appendChild(row);
    }
  }
  card1.appendChild(wtitle); card1.appendChild(wlist);
  root.appendChild(card1);

  // ---- Card 2: Book Composition
  const mix = productMix(pols);
  const conc = carrierConcentration(pols);
  const card2 = dsStatCard({ label:'Book Composition', hero:'', accent:'info' });
  const hero2 = card2.querySelector('.ds-stat__hero'); if (hero2) hero2.remove();

  // Mini donut (SVG, no library)
  const wrap = document.createElement('div'); wrap.className = 'ph-mix';
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ph-mix__donut');
  svg.setAttribute('viewBox', '0 0 120 120');
  const palette = ['var(--ds-color-momentum)','var(--ds-color-success)','var(--ds-color-warning)','var(--ds-color-info)','var(--ds-color-neutral)','var(--ds-color-danger)'];
  let cumAngle = -Math.PI / 2;
  let i = 0;
  for (const [name, amt] of mix.groups){
    const slice = (amt / (mix.total || 1)) * Math.PI * 2;
    const x1 = 60 + Math.cos(cumAngle) * 50;
    const y1 = 60 + Math.sin(cumAngle) * 50;
    cumAngle += slice;
    const x2 = 60 + Math.cos(cumAngle) * 50;
    const y2 = 60 + Math.sin(cumAngle) * 50;
    const large = slice > Math.PI ? 1 : 0;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M60,60 L${x1},${y1} A50,50 0 ${large} 1 ${x2},${y2} Z`);
    path.setAttribute('fill', palette[i % palette.length]);
    svg.appendChild(path);
    i++;
  }
  wrap.appendChild(svg);

  const list = document.createElement('div'); list.className = 'ph-mix__list';
  i = 0;
  for (const [name, amt] of mix.groups){
    const row = document.createElement('div'); row.className = 'ph-mix__row';
    const sw = document.createElement('span'); sw.className = 'ph-mix__swatch'; sw.style.background = palette[i % palette.length];
    const lbl = document.createElement('span'); lbl.className = 'ph-mix__lbl'; lbl.textContent = name;
    const pct = document.createElement('span'); pct.className = 'ph-mix__pct'; pct.textContent = Math.round(amt / (mix.total || 1) * 100) + '%';
    row.appendChild(sw); row.appendChild(lbl); row.appendChild(pct);
    list.appendChild(row);
    i++;
  }
  if (mix.groups.size === 0){
    list.innerHTML = `<div class="ph-mix__row" style="color:var(--text3)">No in-force policies yet</div>`;
  }
  wrap.appendChild(list);
  card2.appendChild(wrap);

  // Concentration warning
  if (conc && conc.pct > 0.5){
    const warn = document.createElement('div'); warn.className = 'ph-warn';
    warn.textContent = `Concentration: ${conc.carrier} holds ${Math.round(conc.pct * 100)}% of in-force AP. Consider diversifying.`;
    card2.appendChild(warn);
  }

  root.appendChild(card2);
}
```

---

## Task 5: Markup + wiring

Insert after `#activity-momentum`:

```html
      <!-- PERSISTENCY & BOOK HEALTH (Phase 4) -->
      <div class="ph-row" id="persistency-health"></div>
```

Add `renderPersistencyHealth()` to `renderSummary` after `renderActivityMomentum()`.

---

## Task 6: Snapshot + docs + memory

- [ ] Snapshot.
- [ ] `docs/architecture.md` Phase 4 section.
- [ ] `memory/project_persistency_health.md` noting `PERSIST_BENCH_*` and cohort math.
- [ ] `MEMORY.md` + vault log.

---

## Self-Review

| Vision §4 requirement | Where |
|---|---|
| 13-month + 25-month persistency rates | Task 2 + Task 4 `dsProgressRing` for each |
| Industry benchmark line | Task 4 `ph-rate__bench[data-tone]` |
| Free-look watch list | Task 2 `freeLookWatch` + Task 4 `ph-watch__list` |
| NSF / missed-draft alerts | **Deferred** — needs a real-time payment source. Doc'd as gap. |
| Donut: product mix | Task 4 inline SVG donut |
| Avg face / avg AP / commission per app | **Partial** — only product mix in v1; avg metrics deferred to a follow-up |
| Top carrier concentration % | Task 2 `carrierConcentration` + Task 4 `.ph-warn` when > 50% |
