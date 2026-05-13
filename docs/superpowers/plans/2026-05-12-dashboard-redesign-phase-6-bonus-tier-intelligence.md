# Dashboard Redesign — Phase 6 (Bonus Tier Intelligence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Expand the existing **Bonus Milestones / Pace & Forecast** card into a **Bonus Tier Intelligence** card. Per-carrier ladders with current position, gap-to-next-tier with translated value ("Write $X more → unlocks Gold → +$Y bonus"), and a "best bang for your buck" recommendation.

**Architecture:** Reuse the existing `.pace-card` markup as the skeleton. Replace the three `.pace-row` instances (Americo / Am-Am / FFL VP) with a unified `.bti-ladder` row per carrier. Each ladder is a horizontal stepped progress bar with tier markers at known thresholds. Below the ladders, a recommendation pill highlights the carrier with the smallest gap-to-next-tier weighted by expected payout.

**Tech Stack:** Same as Phase 0. Pulls bonus structures from the existing `AM_MS` (Americo milestones), `AM_AM_*` (AmAm tier logic), and the FFL VP contract-level math already in the file.

**Spec:** §6.

**Out of scope:**
- Live carrier-portal scrape of real bonus thresholds (uses the existing hardcoded `AM_MS` etc.).
- Historical bonus payout tracking.
- More than three carrier ladders (Americo, AmAm, FFL VP — these are the ones currently calculated).

**Cross-cutting:**
- **Recommendation math:** for each carrier, compute `(value_of_next_tier - value_at_current_tier) / ap_needed_to_unlock`. Highest ratio = best ROI. Surfaces as a "Push: $X to Americo unlocks +$Y" hint.
- **Tier markers** on each ladder are positioned by AP threshold, not even spacing. So the bar shape itself reveals where the cliffs are.

---

## File Structure

| Region | Where | What |
|---|---|---|
| `<style>` | Before AUTH GATE | `/* ---- BONUS TIER INTELLIGENCE ---- */` block |
| `<script>` helpers | After Phase 4 helpers | `bonusTierIntel`, `recommendBestPush` |
| `<script>` renderer | After helpers | `renderBonusTierIntel` (rewrites the pace card body) |
| HTML body — `.pace-card` | `grep -n 'class="card pace-card"'` | Rewrite contents; keep the outer card |
| `<script>` `renderSummary` | Replace existing `renderPaceRow(...)` calls | Single `renderBonusTierIntel()` call |

---

## Task 1: Snapshot

- [ ] `cp index-3.html archive/index-2026-05-12-pre-bonus-tier-intel.html`

---

## Task 2: Helpers

```js
// ============================================================
// BONUS TIER INTELLIGENCE — added 2026-05-12 (Phase 6)
// ============================================================
/** Build a per-carrier ladder description from existing bonus calculators. */
function bonusTierIntel(){
  const today = new Date();
  const pols = window.policies || [];

  // Americo
  const am = (typeof AMERICO_WINDOW === 'object' && typeof AM_MS !== 'undefined')
    ? (() => {
        const start = new Date(AMERICO_WINDOW.start + 'T00:00:00');
        const end   = new Date(AMERICO_WINDOW.end   + 'T23:59:59');
        const ap = pols.filter(p => p.carrier === 'Americo' && _inRange(p, start, end))
                       .reduce((s,p) => s + (Number(p.ap) || 0), 0);
        const tiers = AM_MS.map(m => ({ label: m.label || '$' + (m.threshold || m.ap || 0).toLocaleString(),
                                        threshold: m.threshold || m.ap || 0,
                                        payout: m.payout || m.bonus || 0 }));
        const sorted = tiers.sort((a,b) => a.threshold - b.threshold);
        const cur = sorted.filter(t => ap >= t.threshold).pop();
        const next = sorted.find(t => ap < t.threshold);
        return { carrier:'Americo UFirst', current: ap, tiers: sorted, cur, next, window: { start, end } };
      })()
    : null;

  // Am-Am (uses the existing `amAmWindow` + `calcAmAm` shape)
  const amam = (typeof amAmWindow === 'function')
    ? (() => {
        const win = amAmWindow(today);
        const start = new Date(win.start + 'T00:00:00');
        const end   = new Date(win.end   + 'T23:59:59');
        const ap = pols.filter(p => (p.carrier || '').includes('Amicable') && _inRange(p, start, end))
                       .reduce((s,p) => s + (Number(p.ap) || 0), 0);
        const tiers = [
          { label:'Silver',   threshold: 5000,  payout: 500 },
          { label:'Gold',     threshold: 12000, payout: 1500 },
          { label:'Platinum', threshold: 20000, payout: 4000 },
        ];
        const cur = tiers.filter(t => ap >= t.threshold).pop();
        const next = tiers.find(t => ap < t.threshold);
        return { carrier:'Am-Am Bonus Bucks', current: ap, tiers, cur, next, window:{ start, end } };
      })()
    : null;

  // FFL VP (contract-level)
  const vp = (typeof getContract === 'function')
    ? (() => {
        const level = Number(getContract()) || 100;
        const tiers = [
          { label:'Standard', threshold: 100, payout: 0 },
          { label:'Senior',   threshold: 120, payout: 0 },
          { label:'VP',       threshold: 145, payout: 0 },
        ];
        const cur = tiers.filter(t => level >= t.threshold).pop();
        const next = tiers.find(t => level < t.threshold);
        return { carrier:'FFL VP Track', current: level, tiers, cur, next, isContract: true };
      })()
    : null;

  return [am, amam, vp].filter(Boolean);
}

/** Pick the carrier whose next-tier upgrade has the highest payout-per-AP ratio. */
function recommendBestPush(ladders){
  let best = null;
  for (const L of ladders){
    if (!L || !L.next || L.isContract) continue;            // skip contract-level (not AP-driven)
    const gapAp     = L.next.threshold - L.current;
    const gapPayout = (L.next.payout || 0) - (L.cur ? L.cur.payout : 0);
    if (gapAp <= 0 || gapPayout <= 0) continue;
    const ratio = gapPayout / gapAp;
    if (!best || ratio > best.ratio) best = { ladder: L, gapAp, gapPayout, ratio };
  }
  return best;
}
```

---

## Task 3: CSS

```css
/* BONUS TIER INTELLIGENCE — Phase 6 */
.bti-card{padding:var(--ds-space-5)}
.bti-card__head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:var(--ds-space-4)}
.bti-card__title{font:600 13px/18px var(--sans);color:var(--text2);text-transform:uppercase;letter-spacing:.16em}

.bti-ladder{
  display:grid;grid-template-columns:140px 1fr 200px;gap:var(--ds-space-4);align-items:center;
  padding:var(--ds-space-3) 0;border-bottom:1px solid var(--border);
}
.bti-ladder:last-child{border-bottom:none}
.bti-ladder__name{font:600 13px/18px var(--sans);color:var(--text)}
.bti-ladder__sub{font:11px/15px var(--mono);color:var(--text3);font-variant-numeric:tabular-nums}

.bti-bar{position:relative;height:18px;border-radius:var(--ds-radius-pill);background:var(--bg2);overflow:visible}
.bti-bar__fill{
  height:100%;border-radius:var(--ds-radius-pill);
  background:var(--ds-color-momentum);
  transition:width var(--ds-duration-slow) var(--ds-ease-out);
}
.bti-tier{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--text3)}
.bti-tier[data-state="reached"]{background:var(--ds-color-success)}
.bti-tier__lbl{
  position:absolute;top:24px;transform:translateX(-50%);
  font:10px/14px var(--mono);font-variant-numeric:tabular-nums;color:var(--text3);
  white-space:nowrap;
}
.bti-tier[data-state="reached"] .bti-tier__lbl{color:var(--ds-color-success)}

.bti-cta{
  font:11.5px/15px var(--sans);color:var(--text3);text-align:right;
}
.bti-cta strong{color:var(--text);font-family:var(--mono);font-weight:400}

.bti-recommend{
  margin-top:var(--ds-space-4);padding:var(--ds-space-3) var(--ds-space-4);
  background:var(--ds-color-momentum-bg);color:var(--ds-color-momentum);
  border-left:3px solid var(--ds-color-momentum);border-radius:var(--ds-radius-sm);
  font:13px/18px var(--sans);font-weight:500;
}
.bti-recommend strong{font-family:var(--mono);font-weight:400}
```

---

## Task 4: Renderer

```js
function renderBonusTierIntel(){
  const root = document.querySelector('.bti-card');
  if (!root) return;
  const ladders = bonusTierIntel();
  const body = root.querySelector('.bti-card__body');
  if (!body) return;
  body.replaceChildren();

  for (const L of ladders){
    const row = document.createElement('div'); row.className = 'bti-ladder';
    const left = document.createElement('div');
    const name = document.createElement('div'); name.className = 'bti-ladder__name'; name.textContent = L.carrier;
    const sub  = document.createElement('div'); sub.className  = 'bti-ladder__sub';
    sub.textContent = L.isContract ? (L.current + '% today') : ('$' + L.current.toLocaleString() + ' today');
    left.appendChild(name); left.appendChild(sub);

    const bar = document.createElement('div'); bar.className = 'bti-bar';
    const fill = document.createElement('div'); fill.className = 'bti-bar__fill';
    const maxT = Math.max(...L.tiers.map(t => t.threshold));
    const fillPct = Math.min(100, (L.current / maxT) * 100);
    fill.style.width = fillPct + '%';
    bar.appendChild(fill);
    for (const t of L.tiers){
      const m = document.createElement('div'); m.className = 'bti-tier';
      m.setAttribute('data-state', L.current >= t.threshold ? 'reached' : 'ahead');
      m.style.left = Math.min(100, (t.threshold / maxT) * 100) + '%';
      const ml = document.createElement('span'); ml.className = 'bti-tier__lbl';
      ml.textContent = t.label;
      m.appendChild(ml);
      bar.appendChild(m);
    }

    const cta = document.createElement('div'); cta.className = 'bti-cta';
    if (L.next){
      const gap = L.next.threshold - L.current;
      if (L.isContract){
        cta.innerHTML = `Reach <strong>${L.next.label}</strong> at ${L.next.threshold}%`;
      } else if (L.next.payout > (L.cur ? L.cur.payout : 0)){
        cta.innerHTML = `<strong>$${gap.toLocaleString()}</strong> more → <strong>${L.next.label}</strong> → +<strong>$${((L.next.payout || 0) - (L.cur ? L.cur.payout : 0)).toLocaleString()}</strong>`;
      } else {
        cta.innerHTML = `<strong>$${gap.toLocaleString()}</strong> to reach <strong>${L.next.label}</strong>`;
      }
    } else {
      cta.innerHTML = `<strong>Top tier reached</strong>`;
    }

    row.appendChild(left); row.appendChild(bar); row.appendChild(cta);
    body.appendChild(row);
  }

  // Recommendation
  const rec = recommendBestPush(ladders);
  const recEl = root.querySelector('.bti-recommend');
  if (recEl){
    if (rec){
      recEl.style.display = 'block';
      recEl.innerHTML = `Best bang for buck: push <strong>$${rec.gapAp.toLocaleString()}</strong> into <strong>${rec.ladder.carrier}</strong> → unlocks <strong>+$${rec.gapPayout.toLocaleString()}</strong>`;
    } else {
      recEl.style.display = 'none';
    }
  }
}
```

---

## Task 5: Rewrite `.pace-card` markup

Replace the `<div class="card pace-card">…</div>` contents (everything between its opening and closing `</div>`) with:

```html
        <div class="bti-card__head">
          <div class="bti-card__title">Bonus Tier Intelligence</div>
          <button class="btn-link" onclick="nav('bonuses')">Open Bonus Tracker &rarr;</button>
        </div>
        <div class="bti-card__body"></div>
        <div class="bti-recommend" style="display:none"></div>
```

Add the class `bti-card` to the card (`<div class="card pace-card bti-card">`). Replace the three `renderPaceRow(...)` calls in `renderSummary` with one `renderBonusTierIntel()`.

---

## Task 6: Snapshot + docs + memory

- [ ] Snapshot.
- [ ] `docs/architecture.md` Phase 6 section.
- [ ] `memory/project_bonus_tier_intel.md` noting the data sources (`AM_MS`, hardcoded Am-Am tiers, FFL contract level) and where to extend for new carriers.
- [ ] `MEMORY.md` + vault log.

---

## Self-Review

| Vision §6 requirement | Where |
|---|---|
| Per-carrier ladder visualized | Task 4 `.bti-ladder` with `.bti-tier` markers |
| Current position on ladder | Task 4 `bti-bar__fill` width |
| Gap-to-next-tier translated to dollars | Task 4 cta `…$X more → unlocks $Y` |
| "Best bang for buck" prompt | Task 2 `recommendBestPush` + Task 4 `.bti-recommend` |
