# Path C — Rate Estimator Reframe (Estimator-first, iframe-as-verification)

**Date:** 2026-05-11
**File touched:** `index-3.html` (agent dashboard, ~8,800 lines)
**Snapshot before edit:** `archive/index-2026-05-11-pre-verify-panel.html`
**Status:** Spec — awaiting plan
**Owner:** Tanner / Frenkel Financial

---

## Why this exists

The Quote + Underwriting section ships with two sibling sub-tabs per product (FE / Term / IUL): `Rate Estimator` (placeholder rates from `FE_RATES.americo_eagle` + `CARRIER_MULTS`) and `Live Rates` (Insurance Toolkits iframe). Agents see them as alternatives. They're not — the estimator is an unbranded approximation, the iframe is the real number. Today's tab arrangement makes that distinction invisible and forces agents to flip back and forth.

Insurance Toolkits' API key is in progress but not in hand. Until it lands, we cannot render branded live quotes inside our own UI. Path C is the no-regret move while we wait: reframe the relationship so the estimator becomes the front door and the iframe becomes a verification step beneath it. When the API arrives later, this same shape graduates to Path A — the iframe panel gets replaced by API-driven branded carrier cards in the same slot.

---

## What changes

### Conceptual shift

- **Before:** Two sibling sub-tabs per product. Each implies "pick one." Live Rates feels disconnected from the form the agent just filled in.
- **After:** Single scrollable page per product. Form → branded estimate cards → "Verify these rates live →" CTA → collapsible verification panel containing the iframe. One workflow, one direction of travel.

### Sub-tabs removed

The `Rate Estimator | Live Rates` sub-tab strip is deleted from all three products. The remaining markup (the contents of each `*-tab-quoter` div) becomes the only content of its product panel, with the verification panel appended.

The top-level `FE | Term | IUL` tabs stay untouched.

### Verification panel — three states

Lives below the existing results block (`#fe-results`, `#term-results`, `#iul-results`). One panel per product. Same shape for all three.

**State 1 — collapsed (default on page load):**

```
┌─ 🔴 Verify with live carrier rates ──────────── › ┐
│  Real-time rates from Insurance Toolkits          │
└────────────────────────────────────────────────────┘
```

Thin bar. `live-dot` reuses existing `.live-dot::before` red dot. Click anywhere on the bar toggles expand. Caret rotates 90° when open.

**State 2 — expanded, no quote run yet:**

```
┌─ 🔴 Verify with live carrier rates ──────────── ⌄ ┐
│                                                    │
│  Run an estimate above first — we'll pre-fill the │
│  client info so you don't re-type it.              │
│                                                    │
└────────────────────────────────────────────────────┘
```

Iframe **not** loaded. This keeps the page light for agents who only want estimates.

**State 3 — expanded, after a quote was run:**

```
┌─ 🔴 Live Carrier Rates ─────────────────────── ⌄ ┐
│  Confirmed through Insurance Toolkits             │
│  ┌─ Age 65 · $25,000 · Non-tobacco · Bank ─────┐ │
│  │  Prefill attempted (best-effort)             │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  [ Insurance Toolkits iframe — 820px tall ]       │
│                                                    │
└────────────────────────────────────────────────────┘
```

- Iframe `src` is built fresh on each expand via `buildPrefillUrl(product)` so the chips and the iframe stay in sync with whatever the agent just quoted.
- Iframe uses `loading="lazy"` and is only attached to the DOM after the first expand-with-quote (avoids three preloads per session).
- The "client info chips" bar at the top of the panel reflects the last `runFEQuote()` / `runTermQuote()` / `runIULQuote()` payload. Updates whenever a new quote runs.
- A small "Prefill attempted (best-effort)" hint sits below the chips — sets expectation that Insurance Toolkits may or may not honor the params, and we can't read across origins to confirm.

### The handoff CTA

Appended to the existing results block, right after the carrier cards grid and before the existing `.note mt8` line:

```
✓ Quote generated  ·  [ Verify these rates live → ]
```

The button:
1. Expands the verification panel if collapsed.
2. Triggers iframe load if not yet attached.
3. Smooth-scrolls to the panel (`scrollIntoView({ behavior: 'smooth', block: 'start' })`, honors `prefers-reduced-motion`).
4. Updates the chips bar to reflect the just-rendered quote.

### Estimator labeling

The existing `<div class="note mt8">Estimates only — always verify in carrier portal. Adv. commission = AP × comm% × 0.75…</div>` line moves and changes.

**New copy, placed above the carrier cards grid (inside `#fe-results`, `#term-results`, `#iul-results`):**

> ⚠ Quick estimate based on industry-average rates — **verify before quoting your client.** Use **Verify Live →** below for real-time carrier numbers.

The "Adv. commission = AP × comm% × 0.75" sentence stays below the cards as a separate `.note` — it's accuracy disclosure for the commission math, not the rate math, and shouldn't get conflated.

### Best-effort prefill

`buildPrefillUrl(product)` reads the current form values and appends query params to the Insurance Toolkits base URL:

```
https://app.insurancetoolkits.com/{fex|term|iul}/lite/?token=<existing>
  &age=<int>&face=<int>&state=<2-letter>&tobacco=<0|1>&gender=<M|F>
  [ &termLen=<years>   ← term only ]
```

- Param names are a guess based on common partner-widget conventions. They may be ignored by Insurance Toolkits — we have no docs.
- We can't verify success cross-origin. We never claim "prefilled" — only "prefill attempted."
- When the API contract lands later (Path A migration), this function becomes obsolete; the chips bar persists.

---

## Architecture (units of change)

### Markup units

Inside `#sec-quoter`, three near-identical edits:

| Unit | Before | After |
|---|---|---|
| `#fe-subtabs` | tabs strip with Rate Estimator + Live Rates buttons | **deleted** |
| `#fe-tab-quoter` wrapper | conditionally hidden by `feTab()` | wrapper removed; contents promoted to direct child of `#qt-fe` |
| `#fe-tab-live` | iframe inline | **deleted** (iframe is moved into the verification panel) |
| *(new)* `#fe-verify-panel` | — | collapsible verify panel appended after `#fe-results` |
| *(new)* `#fe-verify-cta` | — | CTA row appended at bottom of `#fe-results` |

Same three edits for `term-*` and `iul-*` panels.

### JS units

| Function | Before | After |
|---|---|---|
| `feTab(id, btn)` | hides/shows quoter vs. live divs | **deleted** (line ~6719) |
| `termTab(id, btn)` | same for term | **deleted** (line ~6727) |
| `iulTab(id, btn)` | same for iul | **deleted** (line ~6735) |
| `runFEQuote()` | renders carrier cards | add: refresh chips bar via `setVerifyChips('fe')` after render; show the new CTA |
| `runTermQuote()` | same | same change for `term` |
| `runIULQuote()` | same | same change for `iul` |
| *(new)* `toggleVerifyPanel(product)` | — | expand/collapse panel; lazy-attach iframe on first expand-with-quote (i.e. when `_verifyArmed[product]` is true) |
| *(new)* `buildPrefillUrl(product)` | — | constructs the Insurance Toolkits URL with prefill params |
| *(new)* `setVerifyChips(product)` | — | renders the client-info chips row from current form values; shows the "Re-load with new values" link when the iframe is already attached and the chips no longer match the iframe's loaded params |
| *(new)* `reloadVerifyIframe(product)` | — | rebuilds the iframe `src` via `buildPrefillUrl()` and clears the stale-chips link |

### CSS units

One new component class, scoped under the existing token system (no new variables):

```css
.verify-panel { border:1px solid var(--border); border-radius:12px; background:var(--bg2); margin-top:16px; overflow:hidden }
.verify-panel-head { display:flex; align-items:center; gap:10px; padding:12px 16px; cursor:pointer; user-select:none }
.verify-panel-head:hover { background:var(--bg3) }
.verify-panel-caret { margin-left:auto; transition:transform .14s }
.verify-panel.open .verify-panel-caret { transform:rotate(90deg) }
.verify-panel-body { display:none; padding:0 16px 16px; border-top:1px solid var(--border) }
.verify-panel.open .verify-panel-body { display:block }
.verify-chips { display:flex; flex-wrap:wrap; gap:6px; padding:12px 0; font-size:12px; color:var(--text2) }
.verify-chip { background:var(--bg3); border:1px solid var(--border); border-radius:4px; padding:3px 8px }
.verify-cta { display:flex; align-items:center; gap:12px; margin-top:12px; padding:10px 14px; background:var(--bg3); border-radius:8px; font-size:13px }
```

Reuses existing `--border`, `--bg2`, `--bg3`, `--text2`, `--radius` tokens. No gradients, no shadows, 4px radius on chips per the canonical design system (`PolicyPilot_Design_System.docx`).

### State the panel owns

Three top-level booleans on `window` (matches the file's existing global-on-window pattern):

```js
window._verifyOpen     = { fe:false, term:false, iul:false };  // collapsed/expanded
window._verifyArmed    = { fe:false, term:false, iul:false };  // a quote was run since page load — controls State 2 vs State 3 on expand
window._verifyLoaded   = { fe:false, term:false, iul:false };  // iframe is attached to the DOM (only happens once per product per page-load)
window._verifyLastUrl  = { fe:'',    term:'',    iul:''    };  // last URL used for the iframe — compared against current form to detect stale chips
```

No localStorage persistence — these are ephemeral UI state. The panel re-collapses on page reload, which is the right default for a multi-client workflow (one client per session).

---

## Data flow

```
Agent fills form  →  clicks "Generate Quotes"
                      ↓
           runFEQuote() / runTermQuote() / runIULQuote()
                      ↓
        (existing) renders carrier cards into #fe-cards / etc.
                      ↓
              (new) setVerifyChips('fe')
              (new) reveals #fe-verify-cta
              (new) _verifyArmed.fe = true
                      ↓
Agent clicks "Verify these rates live →"
                      ↓
            toggleVerifyPanel('fe') with force-open
                      ↓
       buildPrefillUrl('fe') → iframe.src = <prefilled URL>
                      ↓
            Iframe attached to DOM, lazy-loads
                      ↓
        Smooth-scroll to #fe-verify-panel
```

If the agent expands the panel **before** running a quote, they see the State 2 "run an estimate first" hint. The iframe never loads in that branch.

---

## Error handling

Limited surface, but worth being explicit about each case.

| Case | Behavior |
|---|---|
| Insurance Toolkits iframe fails to load | Browser shows default iframe failure UI. We don't intercept — adding our own error handler would require a `load` event timeout we can't make reliable cross-origin. |
| Prefill params rejected by Insurance Toolkits | Invisible to us. Chips bar still shows the values, with the "Prefill attempted (best-effort)" hint. Agent can re-enter inside the iframe. |
| Agent runs a quote, expands panel, runs a different quote | `setVerifyChips()` updates the chips; iframe `src` is **not** reloaded automatically — would cause flicker. A small "Re-load with new values" link appears in the chips bar when stale chips ≠ form values. |
| Tobacco/payment/state fields missing | `buildPrefillUrl()` omits any param whose form field is empty. |
| Token rotation (Insurance Toolkits revokes the current token) | Out of scope — iframe shows their access-denied page. Token replacement is a one-line edit in `buildPrefillUrl()`. |

---

## Testing

No automated test infra exists in this project today. Manual verification checklist, run in the dev browser before commit:

1. **Tabs collapsed:** Open Quote + Underwriting → FE. Confirm no sub-tabs. Estimator form is the first thing visible.
2. **Pre-quote panel state:** Scroll to bottom of the FE page. Click the verify bar. Confirm State 2 ("Run an estimate above first…") shows. No iframe in DOM (`document.querySelectorAll('iframe').length === 0`).
3. **Post-quote flow:** Fill the form with a known-good payload (40M, $10k, healthy, bank draft). Click Generate Quotes. Confirm cards render AND the "Verify these rates live →" CTA appears beneath them.
4. **CTA expand + scroll:** Click the CTA. Confirm panel expands, iframe attaches, chips show `Age 40 · $10,000 · Non-tobacco · Bank Draft · Male`, smooth-scroll lands on the panel.
5. **Prefill URL constructed:** Open DevTools → inspect the iframe `src`. Confirm query params include the form values.
6. **Re-quote with different values:** Change age to 65, run again. Confirm chips update. Confirm "Re-load with new values" link appears.
7. **Term repeats:** Same flow on Term tab. Confirm term-specific `termLen` param is in the URL.
8. **IUL repeats:** Same flow on IUL tab. Confirm IUL's reduced field set doesn't crash `buildPrefillUrl()`.
9. **Page reload:** Confirm panel returns to collapsed state. No flash of open panel.
10. **Reduced motion:** Toggle `prefers-reduced-motion` in DevTools. Confirm scroll uses `instant` instead of `smooth`.
11. **Regression — quote results unchanged:** Compare 40M/$10k/healthy/bank carrier card numbers (monthly, annual, comm%, adv-comm) before and after. Must be identical — engine is untouched.
12. **Regression — existing tabs work:** Policy Tracker, Drafts, Bonus Tracker, UW Cheat Sheet still navigate and render normally.

---

## Out of scope (deliberately)

- **API-driven branded quotes (Path A).** Blocked on Insurance Toolkits API access. This spec is the prerequisite shape — same panel slot, different contents later.
- **`postMessage` driving of the iframe.** Insurance Toolkits has not published a postMessage protocol we know of. Don't speculate.
- **Reading iframe contents.** Cross-origin block; impossible regardless of effort.
- **Client.html changes.** The client-facing wizard is a separate surface (`feedback_dashboard_is_sales_side`). Path C is agent-only.
- **AI health parser fix.** Tracked separately (`project_ai_parser_broken`). The verify panel doesn't depend on parsed conditions.
- **Removal of `FE_RATES` placeholder tables.** The estimator still needs *something* until Path A. Re-labeling is enough for now.
- **Supabase persistence of verify-panel state.** Ephemeral on purpose.

---

## Migration to Path A (future)

When the Insurance Toolkits API arrives:

1. `runFEQuote()` etc. switch from `interpRate` + `CARRIER_MULTS` math to an `await fetch(...)` against the API.
2. Carrier cards render API responses instead of local-table approximations.
3. The verification panel becomes obsolete — kill the panel, the CTA, the chips, `buildPrefillUrl`. Keep the design-system styles (they may be reused).
4. The "Quick estimate" reframe disclaimer goes away.

Path C is intentionally shaped so this migration is additive then subtractive — no architectural lock-in.

---

## File touch summary

| Path | Change |
|---|---|
| `index-3.html` | ~150 lines net (mix of additions and deletions across markup, CSS block, and the `feTab` / `termTab` / `iulTab` / `runFEQuote` / `runTermQuote` / `runIULQuote` regions) |
| `archive/index-2026-05-11-pre-verify-panel.html` | new — pre-edit snapshot |
| `docs/superpowers/specs/2026-05-11-path-c-rate-estimator-reframe-design.md` | this file |

No new files in `shared/`, `client/`, `src/`, `data/`. No `package.json`. No build step.

---

## Open questions for the plan stage

1. Should the "Re-load with new values" link auto-trigger after N seconds of stale-chips, or stay manual? *Recommend manual — avoids surprise refreshes mid-comparison.*
2. Should the panel default to **collapsed** even after a quote runs, or **expand automatically** once a quote is generated? *Recommend collapsed — agents who don't need verification (estimates for filling out a tracker note) shouldn't get the iframe weight.*
3. State field — FE/Term/IUL forms today don't collect a state. Insurance Toolkits' lite widget asks for it. Do we add a state dropdown to the estimator forms, or let agents enter it in the iframe? *Recommend adding to the forms — it's one more select and it makes the prefill actually useful. Defer to the plan if a separate "add state field" change is preferred.*

These are flagged for the writing-plans phase, not for spec rev.
