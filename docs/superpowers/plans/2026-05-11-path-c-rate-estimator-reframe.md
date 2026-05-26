# Path C — Rate Estimator Reframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the Quote + Underwriting section so the Rate Estimator is the front door and the Insurance Toolkits iframe becomes a verification step beneath it. Remove the Rate Estimator / Live Rates sub-tabs; replace with a single scrollable page per product (FE / Term / IUL) plus a collapsible "Verify with live carrier rates" panel.

**Architecture:** Pure markup, CSS, and vanilla JS edits inside the single-file HTML app at `index-3.html`. No new dependencies, no build step, no backend changes. New JS units (`buildPrefillUrl`, `setVerifyChips`, `toggleVerifyPanel`, `reloadVerifyIframe`) sit alongside the existing `runFEQuote` / `runTermQuote` / `runIULQuote` functions and hook in at the end of each.

**Tech Stack:** HTML5, vanilla CSS (token-driven via `--border`, `--bg2`, `--bg3`, etc.), vanilla JS. Browser-only — no Node, no test runner. Verification is manual browser testing per the project's existing convention (`Patterns/Single-File HTML App`).

**Snapshot before edit:** `archive/index-2026-05-11-pre-verify-panel.html` (per the project's >5% file-change rule). No git in this project — snapshots are the rollback mechanism.

**Spec:** `docs/superpowers/specs/2026-05-11-path-c-rate-estimator-reframe-design.md`

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `index-3.html` | modified | All markup, CSS, JS changes (single source of truth) |
| `archive/index-2026-05-11-pre-verify-panel.html` | created | One-shot rollback snapshot of the pre-edit file |
| `docs/superpowers/plans/2026-05-11-path-c-rate-estimator-reframe.md` | this file | — |

All edits inside `index-3.html` are scoped to:

- **Markup:** lines 1273–1485 (the `#sec-quoter` FE / Term / IUL panels) and ~3 form-field additions for the new state dropdown
- **CSS:** new block inserted before the closing `</style>` at line 917 (component classes only — `.verify-panel`, `.verify-chips`, `.verify-cta`)
- **JS:** new helper functions inserted before `feTab` at line 6715; modifications at the tail of `runFEQuote` (line 3503), `runTermQuote` (line 3661), `runIULQuote` (line 3759); deletion of `feTab` / `termTab` / `iulTab` (lines 6715–6740)

**Important codebase fact:** `runFEQuote`, `runTermQuote`, `runIULQuote` accept a `pfx` parameter (`''` default for the main quoter, `'m-'` for a secondary modal variant near line 2547). All new hooks must be gated on `!pfx` so they only fire for the main dashboard quoter and the `m-` variant continues to behave as today. The `m-` variant has no sub-tabs and no Live Rates iframe — out of scope.

---

## TDD adaptation

This project has no automated test runner. The spec and project convention use manual browser verification. Each task's verification step calls out exact DOM checks, DevTools commands, and expected behavior. Treat these as the "tests" — every task ends with verification *before* moving to the next.

The development server: open `index-3.html` directly in the browser (it's already file:// servable), or use `python3 -m http.server 8000 --directory "/Users/tanner/Jace- Life Insurance"` and visit `http://localhost:8000/index-3.html`. Use the local server when testing anything that depends on the Supabase auth flow; `file://` is fine for everything else.

---

### Task 1: Snapshot the pre-edit file

**Files:**
- Create: `archive/index-2026-05-11-pre-verify-panel.html`

- [ ] **Step 1: Copy current file to archive**

```bash
cp "/Users/tanner/Jace- Life Insurance/index-3.html" \
   "/Users/tanner/Jace- Life Insurance/archive/index-2026-05-11-pre-verify-panel.html"
```

- [ ] **Step 2: Verify the copy is byte-identical**

```bash
diff "/Users/tanner/Jace- Life Insurance/index-3.html" \
     "/Users/tanner/Jace- Life Insurance/archive/index-2026-05-11-pre-verify-panel.html"
```

Expected: no output (files identical). If diff shows anything, abort and investigate.

---

### Task 2: Add state dropdown to all three estimator forms

**Files:**
- Modify: `index-3.html` (three insertions in the markup at the FE form ~line 1306, Term form ~line 1389, IUL form ~line 1469)

The state dropdown enables prefill of Insurance Toolkits' widget. 50 states + DC. Goes in the same `.frow` row as the other top-line fields per product.

- [ ] **Step 1: Add state dropdown to FE form**

Find the FE form's coverage/tobacco/payment row (it starts with `<div class="frow mt12">` and contains `id="fe-coverage"`). Add a new `.fg` block right before the closing `</div>` of that row, after the payment-method `.fg`:

```html
<div class="fg"><label>State</label>
  <select id="fe-state">
    <option value="">—</option>
    <option>AL</option><option>AK</option><option>AZ</option><option>AR</option><option>CA</option>
    <option>CO</option><option>CT</option><option>DE</option><option>DC</option><option>FL</option>
    <option>GA</option><option>HI</option><option>ID</option><option>IL</option><option>IN</option>
    <option>IA</option><option>KS</option><option>KY</option><option>LA</option><option>ME</option>
    <option>MD</option><option>MA</option><option>MI</option><option>MN</option><option>MS</option>
    <option>MO</option><option>MT</option><option>NE</option><option>NV</option><option>NH</option>
    <option>NJ</option><option>NM</option><option>NY</option><option>NC</option><option>ND</option>
    <option>OH</option><option>OK</option><option>OR</option><option>PA</option><option>RI</option>
    <option>SC</option><option>SD</option><option>TN</option><option>TX</option><option>UT</option>
    <option>VT</option><option>VA</option><option>WA</option><option>WV</option><option>WI</option><option>WY</option>
  </select>
</div>
```

- [ ] **Step 2: Add state dropdown to Term form**

Find the Term form's term-length/coverage/tobacco/payment row (it contains `id="term-len"`). Add the same `.fg` block right before that row's closing `</div>`, after the payment-method `.fg`:

```html
<div class="fg"><label>State</label>
  <select id="term-state">
    <option value="">—</option>
    <option>AL</option><option>AK</option><option>AZ</option><option>AR</option><option>CA</option>
    <option>CO</option><option>CT</option><option>DE</option><option>DC</option><option>FL</option>
    <option>GA</option><option>HI</option><option>ID</option><option>IL</option><option>IN</option>
    <option>IA</option><option>KS</option><option>KY</option><option>LA</option><option>ME</option>
    <option>MD</option><option>MA</option><option>MI</option><option>MN</option><option>MS</option>
    <option>MO</option><option>MT</option><option>NE</option><option>NV</option><option>NH</option>
    <option>NJ</option><option>NM</option><option>NY</option><option>NC</option><option>ND</option>
    <option>OH</option><option>OK</option><option>OR</option><option>PA</option><option>RI</option>
    <option>SC</option><option>SD</option><option>TN</option><option>TX</option><option>UT</option>
    <option>VT</option><option>VA</option><option>WA</option><option>WV</option><option>WI</option><option>WY</option>
  </select>
</div>
```

- [ ] **Step 3: Add state dropdown to IUL form**

Find the IUL form's age/gender/coverage/health-class row (contains `id="iul-cov"`). Add the same `.fg` block before that row's closing `</div>`, after the health-class `.fg`:

```html
<div class="fg"><label>State</label>
  <select id="iul-state">
    <option value="">—</option>
    <option>AL</option><option>AK</option><option>AZ</option><option>AR</option><option>CA</option>
    <option>CO</option><option>CT</option><option>DE</option><option>DC</option><option>FL</option>
    <option>GA</option><option>HI</option><option>ID</option><option>IL</option><option>IN</option>
    <option>IA</option><option>KS</option><option>KY</option><option>LA</option><option>ME</option>
    <option>MD</option><option>MA</option><option>MI</option><option>MN</option><option>MS</option>
    <option>MO</option><option>MT</option><option>NE</option><option>NV</option><option>NH</option>
    <option>NJ</option><option>NM</option><option>NY</option><option>NC</option><option>ND</option>
    <option>OH</option><option>OK</option><option>OR</option><option>PA</option><option>RI</option>
    <option>SC</option><option>SD</option><option>TN</option><option>TX</option><option>UT</option>
    <option>VT</option><option>VA</option><option>WA</option><option>WV</option><option>WI</option><option>WY</option>
  </select>
</div>
```

- [ ] **Step 4: Manual verification**

Open `index-3.html` in browser. Click Quote + Underwriting → FE. Confirm state dropdown appears in the form row, defaulting to "—". Click Term. Confirm state dropdown present. Click IUL. Confirm state dropdown present. Run a quote on FE without selecting a state — should still work (state is optional, only used for verify prefill).

---

### Task 3: Add verify-panel CSS

**Files:**
- Modify: `index-3.html` (insert before `</style>` at line 917)

- [ ] **Step 1: Find the insertion point**

The CSS block runs lines 9–917. Find the line immediately before `</style>` and insert the new component classes there.

- [ ] **Step 2: Insert the new CSS block**

```css
/* ===== Verify Panel (Live Rates verification) ===== */
.verify-panel { border:1px solid var(--border); border-radius:12px; background:var(--bg2); margin-top:16px; overflow:hidden }
.verify-panel-head { display:flex; align-items:center; gap:10px; padding:12px 16px; cursor:pointer; user-select:none; font-size:14px }
.verify-panel-head:hover { background:var(--bg3) }
.verify-panel-head strong { font-weight:600 }
.verify-panel-caret { margin-left:auto; transition:transform .14s; font-size:18px; color:var(--text3); line-height:1 }
.verify-panel.open .verify-panel-caret { transform:rotate(90deg) }
.verify-panel-body { display:none; padding:0 16px 16px; border-top:1px solid var(--border) }
.verify-panel.open .verify-panel-body { display:block }
.verify-chips { display:flex; flex-wrap:wrap; gap:6px; padding:12px 0; font-size:12px; color:var(--text2) }
.verify-chip { background:var(--bg3); border:1px solid var(--border); border-radius:4px; padding:3px 8px }
.verify-cta { display:flex; align-items:center; gap:12px; margin-top:12px; padding:10px 14px; background:var(--bg3); border:1px solid var(--border); border-radius:8px; font-size:13px }
.verify-cta-check { color:var(--text-g, #16a34a); font-weight:600 }
.verify-disclaimer { font-size:12.5px; padding:10px 14px; background:var(--bg3); border-left:3px solid var(--text-g, #16a34a); border-radius:6px; margin-bottom:12px }
@media (prefers-reduced-motion: reduce) { .verify-panel-caret { transition:none } }
```

- [ ] **Step 3: Manual verification**

Reload `index-3.html` in browser. Open DevTools → Console. Run:

```js
getComputedStyle(document.documentElement).getPropertyValue('--border')
```

Expected: a color value (the CSS still parses). Now run:

```js
const el = document.createElement('div'); el.className = 'verify-panel'; document.body.appendChild(el);
getComputedStyle(el).borderRadius
```

Expected: `12px`. Then remove: `el.remove()`.

If either check fails, the CSS block has a syntax error — fix before continuing.

---

### Task 4: Add JS helpers and state objects

**Files:**
- Modify: `index-3.html` (insert before `function feTab` at line 6715)

- [ ] **Step 1: Find the insertion point**

Locate `function feTab(id, el, pfx='') {` (around line 6715). Insert the new code immediately before this function.

- [ ] **Step 2: Insert state objects and helper functions**

```js
// ============================================================
// VERIFY PANEL — wraps Insurance Toolkits live rates iframe
// ============================================================
window._verifyOpen    = { fe:false, term:false, iul:false };
window._verifyArmed   = { fe:false, term:false, iul:false };
window._verifyLoaded  = { fe:false, term:false, iul:false };
window._verifyLastUrl = { fe:'',    term:'',    iul:''    };

const VERIFY_CONFIG = {
  fe: {
    base: 'https://app.insurancetoolkits.com/fex/lite/?token=gVmrMl2X_8jHtBRTsV9paeD8obu7dWalCgPf0AG-',
    fields: { age:'fe-age', face:'fe-coverage', tobacco:'fe-tobacco', gender:'fe-gender', state:'fe-state', payment:'fe-payment' }
  },
  term: {
    base: 'https://app.insurancetoolkits.com/term/lite/?token=gVmrMl2X_8jHtBRTsV9paeD8obu7dWalCgPf0AG-',
    fields: { age:'term-age', face:'term-cov', tobacco:'term-tob', gender:'term-gender', state:'term-state', payment:'term-payment', termLen:'term-len' }
  },
  iul: {
    base: 'https://app.insurancetoolkits.com/iul/lite/?token=gVmrMl2X_8jHtBRTsV9paeD8obu7dWalCgPf0AG-',
    fields: { age:'iul-age', face:'iul-cov', gender:'iul-gender', state:'iul-state' }
  }
};

function buildPrefillUrl(product) {
  const cfg = VERIFY_CONFIG[product];
  if (!cfg) return '';
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const params = new URLSearchParams();
  const f = cfg.fields;
  const age = val(f.age);          if (age)    params.set('age', age);
  const face = val(f.face);        if (face)   params.set('face', face);
  const gender = val(f.gender);    if (gender) params.set('gender', gender);
  const state = val(f.state);      if (state)  params.set('state', state);
  if (f.tobacco) { const t = val(f.tobacco); if (t) params.set('tobacco', t === 'yes' ? '1' : '0'); }
  if (f.termLen) { const tl = val(f.termLen); if (tl) params.set('termLen', tl); }
  const qs = params.toString();
  return cfg.base + (qs ? '&' + qs : '');
}

function setVerifyChips(product) {
  const cfg = VERIFY_CONFIG[product];
  if (!cfg) return;
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const f = cfg.fields;
  const chips = [];
  const age = val(f.age);       if (age)    chips.push('Age ' + age);
  const face = val(f.face);     if (face)   chips.push('$' + Number(face).toLocaleString());
  if (f.tobacco) { const t = val(f.tobacco); if (t) chips.push(t === 'yes' ? 'Tobacco' : 'Non-tobacco'); }
  const gender = val(f.gender); if (gender) chips.push(gender === 'M' ? 'Male' : 'Female');
  const state = val(f.state);   if (state)  chips.push(state);
  if (f.payment) { const p = val(f.payment); if (p) chips.push(p === 'bank' ? 'Bank Draft' : 'CC/Debit/SSI'); }

  const chipsEl = document.getElementById(product + '-verify-chips');
  if (chipsEl) chipsEl.innerHTML = chips.map(c => '<span class="verify-chip">' + c + '</span>').join('');

  const currentUrl = buildPrefillUrl(product);
  const stale = window._verifyLoaded[product] && currentUrl !== window._verifyLastUrl[product];
  const staleEl = document.getElementById(product + '-verify-stale');
  if (staleEl) staleEl.style.display = stale ? 'inline' : 'none';
}

function toggleVerifyPanel(product, forceOpen) {
  const panel = document.getElementById(product + '-verify-panel');
  if (!panel) return;
  const willOpen = forceOpen === true ? true : !window._verifyOpen[product];
  window._verifyOpen[product] = willOpen;
  panel.classList.toggle('open', willOpen);

  const preEl  = document.getElementById(product + '-verify-pre');
  const postEl = document.getElementById(product + '-verify-post');
  if (preEl && postEl) {
    preEl.style.display  = window._verifyArmed[product] ? 'none' : 'block';
    postEl.style.display = window._verifyArmed[product] ? 'block' : 'none';
  }

  if (willOpen && window._verifyArmed[product] && !window._verifyLoaded[product]) {
    const slot = document.getElementById(product + '-verify-iframe-slot');
    if (slot) {
      const url = buildPrefillUrl(product);
      slot.innerHTML = '<iframe style="border:none;height:820px;width:100%;display:block" src="' + url + '" loading="lazy"></iframe>';
      window._verifyLoaded[product] = true;
      window._verifyLastUrl[product] = url;
    }
  }

  if (willOpen) {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }
}

function reloadVerifyIframe(product) {
  if (!window._verifyLoaded[product]) return;
  const slot = document.getElementById(product + '-verify-iframe-slot');
  if (!slot) return;
  const url = buildPrefillUrl(product);
  slot.innerHTML = '<iframe style="border:none;height:820px;width:100%;display:block" src="' + url + '" loading="lazy"></iframe>';
  window._verifyLastUrl[product] = url;
  setVerifyChips(product);
}
```

- [ ] **Step 3: Manual verification**

Reload `index-3.html`. Open DevTools → Console. Run:

```js
typeof buildPrefillUrl + ' ' + typeof setVerifyChips + ' ' + typeof toggleVerifyPanel + ' ' + typeof reloadVerifyIframe
```

Expected: `"function function function function"`.

Run:

```js
window._verifyOpen
```

Expected: `{fe: false, term: false, iul: false}`.

No DOM elements exist yet for these helpers to act on — calling them won't do anything visible. That's fine; we wire up the DOM next.

---

### Task 5: Restructure FE markup (remove sub-tabs, add verify panel, update disclaimer)

**Files:**
- Modify: `index-3.html` lines 1273–1353 (the `#qt-fe` block)

- [ ] **Step 1: Replace the entire `#qt-fe` block**

Find the opening line `<div id="qt-fe">` (around line 1274) and the matching closing `</div><!-- /qt-fe -->` — if there's no comment, find the closing `</div>` immediately before `<!-- ===== TERM LIFE ===== -->`. The block ends around line 1353.

Replace the entire block with:

```html
      <div id="qt-fe">
        <div class="card">
          <div class="card-title">Client Information</div>
          <div class="frow">
            <div class="fg"><label>Age</label><input type="number" id="fe-age" placeholder="65" min="40" max="90"></div>
            <div class="fg"><label>Gender</label>
              <select id="fe-gender"><option value="M">Male</option><option value="F">Female</option></select>
            </div>
            <div class="fg"><label>Height <span style="color:var(--text3);font-size:10px">(optional)</span></label>
              <select id="fe-height">
                <option value="">Skip</option>
                <option value="56">4'8"</option><option value="57">4'9"</option><option value="58">4'10"</option><option value="59">4'11"</option>
                <option value="60">5'0"</option><option value="61">5'1"</option><option value="62">5'2"</option><option value="63">5'3"</option>
                <option value="64">5'4"</option><option value="65">5'5"</option><option value="66">5'6"</option><option value="67">5'7"</option>
                <option value="68">5'8"</option><option value="69">5'9"</option><option value="70">5'10"</option><option value="71">5'11"</option>
                <option value="72">6'0"</option><option value="73">6'1"</option><option value="74">6'2"</option><option value="75">6'3"</option>
                <option value="76">6'4"</option><option value="77">6'5"</option><option value="78">6'6"</option><option value="79">6'7"</option>
              </select>
            </div>
            <div class="fg"><label>Weight <span style="color:var(--text3);font-size:10px">(optional)</span></label>
              <input type="number" id="fe-weight" placeholder="lbs — optional" min="60" max="500" oninput="checkBuild('fe')">
            </div>
            <div id="fe-build-flag" style="display:none;align-self:flex-end;padding-bottom:2px">
              <span class="badge b-no" id="fe-build-badge">Build Check</span>
            </div>
          </div>
          <div class="frow mt12">
            <div class="fg" style="min-width:180px">
              <label>Coverage ($) — type any amount</label>
              <input type="number" id="fe-coverage" placeholder="10000" value="10000" min="1000" step="500">
            </div>
            <div class="fg"><label>Tobacco</label>
              <select id="fe-tobacco"><option value="no">Non-Tobacco</option><option value="yes">Tobacco User</option></select>
            </div>
            <div class="fg"><label>Payment Method</label>
              <select id="fe-payment" onchange="onPaymentChange('fe')">
                <option value="bank">Bank Draft / ACH</option>
                <option value="cc">Credit / Debit Card or SSI Billing</option>
              </select>
            </div>
            <div class="fg"><label>State</label>
              <select id="fe-state">
                <option value="">—</option>
                <option>AL</option><option>AK</option><option>AZ</option><option>AR</option><option>CA</option>
                <option>CO</option><option>CT</option><option>DE</option><option>DC</option><option>FL</option>
                <option>GA</option><option>HI</option><option>ID</option><option>IL</option><option>IN</option>
                <option>IA</option><option>KS</option><option>KY</option><option>LA</option><option>ME</option>
                <option>MD</option><option>MA</option><option>MI</option><option>MN</option><option>MS</option>
                <option>MO</option><option>MT</option><option>NE</option><option>NV</option><option>NH</option>
                <option>NJ</option><option>NM</option><option>NY</option><option>NC</option><option>ND</option>
                <option>OH</option><option>OK</option><option>OR</option><option>PA</option><option>RI</option>
                <option>SC</option><option>SD</option><option>TN</option><option>TX</option><option>UT</option>
                <option>VT</option><option>VA</option><option>WA</option><option>WV</option><option>WI</option><option>WY</option>
              </select>
            </div>
          </div>
          <div id="fe-cc-notice" style="display:none" class="pay-cc mt8">
            <span data-ico="credit-card" data-size="14" style="margin-right:6px;vertical-align:-2px"></span>Only <strong>Corebridge</strong> and <strong>Transamerica</strong> accept CC/Debit/SSI billing. Results filtered.
          </div>
          <div class="mt16">
            <div style="font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Health Conditions &amp; Medications</div>
            <div style="font-size:11.5px;color:var(--text3);margin-bottom:8px">Describe conditions, medications, symptoms — AI identifies and classifies everything automatically.</div>
            <div style="position:relative">
              <textarea id="fe-health-text" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:11px 13px;color:var(--text);font-family:var(--sans);font-size:13px;outline:none;resize:vertical;min-height:72px;transition:border-color .14s" placeholder="Describe health: conditions, medications, surgeries, symptoms..." oninput="onHealthInput('fe')"></textarea>
              <div id="fe-ai-spinner" style="display:none;position:absolute;right:10px;top:10px;font-size:11px;color:#60a5fa;background:var(--bg3);padding:2px 6px;border-radius:4px">AI analyzing…</div>
            </div>
            <div id="fe-parsed-tags" style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;min-height:10px"></div>
          </div>
          <div class="mt16">
            <button class="btn btn-p" onclick="runFEQuote()">Generate Quotes</button>
          </div>
        </div>

        <div id="fe-results" style="display:none" class="mt20">
          <div class="verify-disclaimer">
            ⚠ Quick estimate based on industry-average rates — <strong>verify before quoting your client.</strong> Use <strong>Verify Live →</strong> below for real-time carrier numbers.
          </div>
          <div class="flex jb aic mt4" style="margin-bottom:12px">
            <div style="font-size:15px;font-weight:600">Quote Results</div>
            <div style="font-size:11.5px;color:var(--text3)">Contract: <span class="mono text-g" id="fe-contract-disp">100%</span> &nbsp;|&nbsp; <span id="fe-client-summary" style="color:var(--text2)"></span></div>
          </div>
          <div class="g3" id="fe-cards"></div>
          <div class="verify-cta" id="fe-verify-cta" style="display:none">
            <span class="verify-cta-check">✓ Quote generated</span>
            <span style="margin-left:auto"><button class="btn btn-p" onclick="toggleVerifyPanel('fe', true)">Verify these rates live →</button></span>
          </div>
          <div class="note mt8">Adv. commission = AP × comm% × 0.75 (9-month advance payout).</div>
        </div>

        <div id="fe-verify-panel" class="verify-panel">
          <div class="verify-panel-head" onclick="toggleVerifyPanel('fe')">
            <span class="live-dot"></span>
            <strong>Verify with live carrier rates</strong>
            <span style="color:var(--text3);font-size:12px">Real-time rates from Insurance Toolkits</span>
            <span class="verify-panel-caret">›</span>
          </div>
          <div class="verify-panel-body">
            <div id="fe-verify-pre" style="padding:12px 0;color:var(--text2);font-size:13px">Run an estimate above first — we'll pre-fill the client info so you don't re-type it.</div>
            <div id="fe-verify-post" style="display:none">
              <div style="font-size:13px;color:var(--text2);margin-top:8px">Confirmed through Insurance Toolkits</div>
              <div class="verify-chips" id="fe-verify-chips"></div>
              <div style="font-size:11px;color:var(--text3);margin-bottom:8px">
                Prefill attempted (best-effort)
                <a id="fe-verify-stale" href="#" onclick="event.preventDefault(); reloadVerifyIframe('fe');" style="display:none;color:var(--text-g);margin-left:6px;text-decoration:underline">Re-load with new values</a>
              </div>
              <div id="fe-verify-iframe-slot" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#fff"></div>
            </div>
          </div>
        </div>
      </div>
```

Note Task 2 step 1's standalone state-dropdown insertion is now redundant because this replacement includes the dropdown. If Task 2 was already applied, the FE dropdown will be deduplicated by this replacement (the new markup is the source of truth). That's the intended ordering — Task 2 ensured the dropdown exists if implementation pauses between tasks; Task 5 locks in the final structure.

- [ ] **Step 2: Manual verification of FE markup**

Reload `index-3.html`. Click Quote + Underwriting → FE. Verify:

- No "Rate Estimator | Live Rates" sub-tabs above the form.
- Form renders normally with the state dropdown.
- "Generate Quotes" button present.
- Scroll down: a collapsed "Verify with live carrier rates" bar is visible at the bottom of the FE panel, even before running a quote.
- Click the verify bar — it expands, showing "Run an estimate above first — we'll pre-fill the client info..." text. No iframe in the DOM yet. Verify in Console:

```js
document.querySelectorAll('#fe-verify-panel iframe').length
```

Expected: `0`.

- Click the bar again to collapse it.

---

### Task 6: Wire `runFEQuote` to arm and reveal the verify CTA

**Files:**
- Modify: `index-3.html` at the end of `runFEQuote` (around line 3655, just before the closing `}`)

- [ ] **Step 1: Find the insertion point**

Locate the line `document.getElementById(pfx+'fe-results').scrollIntoView({behavior:'smooth',block:'start'});` at the end of `runFEQuote` (line 3655 in the pre-edit file).

- [ ] **Step 2: Insert the verify-panel arming logic**

Immediately after that `scrollIntoView` line, before the closing `}` of `runFEQuote`, add:

```js
  if (!pfx) {
    window._verifyArmed.fe = true;
    const cta = document.getElementById('fe-verify-cta');
    if (cta) cta.style.display = 'flex';
    setVerifyChips('fe');
    if (window._verifyOpen.fe) {
      const preEl  = document.getElementById('fe-verify-pre');
      const postEl = document.getElementById('fe-verify-post');
      if (preEl)  preEl.style.display  = 'none';
      if (postEl) postEl.style.display = 'block';
      if (!window._verifyLoaded.fe) {
        const slot = document.getElementById('fe-verify-iframe-slot');
        if (slot) {
          const url = buildPrefillUrl('fe');
          slot.innerHTML = '<iframe style="border:none;height:820px;width:100%;display:block" src="' + url + '" loading="lazy"></iframe>';
          window._verifyLoaded.fe = true;
          window._verifyLastUrl.fe = url;
        }
      }
    }
  }
```

The `if (!pfx)` guard prevents this from firing for the `m-` (modal) variant — that quoter is out of scope.

- [ ] **Step 3: Manual verification**

Reload. Open FE. Fill form: Age `65`, Gender Male, Coverage `25000`, Tobacco Non-Tobacco, Payment Bank Draft, State `NV`. Health text: leave empty. Click Generate Quotes.

Expected behavior:
- Carrier cards render as before (regression test — numbers should be identical to pre-edit).
- A new CTA row appears below the cards: `✓ Quote generated  ·  [Verify these rates live →]`.
- The disclaimer banner ("⚠ Quick estimate…") sits above the cards.

Click "Verify these rates live →".

Expected:
- Verify panel expands.
- Page smooth-scrolls to the panel.
- Chips row shows: `Age 65`, `$25,000`, `Non-tobacco`, `Male`, `NV`, `Bank Draft`.
- "Prefill attempted (best-effort)" text visible.
- Iframe loads inside `#fe-verify-iframe-slot`. Inspect in DevTools:

```js
document.querySelector('#fe-verify-iframe-slot iframe').src
```

Expected: URL starts with `https://app.insurancetoolkits.com/fex/lite/?token=…&age=65&face=25000&gender=M&state=NV&tobacco=0`.

Click the verify bar header to collapse. Click again to re-expand — iframe should still be present (not reloaded). Confirm via:

```js
document.querySelectorAll('#fe-verify-panel iframe').length
```

Expected: `1` (single iframe, not duplicated).

Change Age to `70` (without clicking Generate Quotes). The chips bar should NOT auto-update (only updates on next quote run). Click Generate Quotes again — chips should now show `Age 70`. The "Re-load with new values" link should appear next to "Prefill attempted (best-effort)" because the iframe's URL has age=65 but the form is now age=70. Click it. Iframe reloads with age=70 in the URL. Link disappears.

---

### Task 7: Restructure Term markup (remove sub-tabs, add verify panel)

**Files:**
- Modify: `index-3.html` lines 1355–1440 (the `#qt-term` block)

- [ ] **Step 1: Replace the entire `#qt-term` block**

Find `<div id="qt-term" style="display:none">` (around line 1356) and its matching closing `</div>` immediately before `<!-- ===== IUL ===== -->`. Replace with:

```html
      <div id="qt-term" style="display:none">
        <div class="card">
          <div class="card-title">Term Life Quote</div>
          <div class="frow">
            <div class="fg"><label>Age</label><input type="number" id="term-age" placeholder="35" min="18" max="75"></div>
            <div class="fg"><label>Gender</label>
              <select id="term-gender"><option value="M">Male</option><option value="F">Female</option></select>
            </div>
            <div class="fg"><label>Height <span style="color:var(--text3);font-size:10px">(optional)</span></label>
              <select id="term-height">
                <option value="">Skip</option>
                <option value="56">4'8"</option><option value="57">4'9"</option><option value="58">4'10"</option><option value="59">4'11"</option>
                <option value="60">5'0"</option><option value="61">5'1"</option><option value="62">5'2"</option><option value="63">5'3"</option>
                <option value="64">5'4"</option><option value="65">5'5"</option><option value="66">5'6"</option><option value="67">5'7"</option>
                <option value="68">5'8"</option><option value="69">5'9"</option><option value="70">5'10"</option><option value="71">5'11"</option>
                <option value="72">6'0"</option><option value="73">6'1"</option><option value="74">6'2"</option><option value="75">6'3"</option>
                <option value="76">6'4"</option><option value="77">6'5"</option><option value="78">6'6"</option><option value="79">6'7"</option>
              </select>
            </div>
            <div class="fg"><label>Weight <span style="color:var(--text3);font-size:10px">(optional)</span></label>
              <input type="number" id="term-weight" placeholder="lbs — optional" oninput="checkBuild('term')">
            </div>
            <div id="term-build-flag" style="display:none;align-self:flex-end;padding-bottom:2px">
              <span class="badge b-no" id="term-build-badge">Build Check</span>
            </div>
          </div>
          <div class="frow mt12">
            <div class="fg"><label>Term Length</label>
              <select id="term-len">
                <option value="10">10 Year</option><option value="15">15 Year</option>
                <option value="20" selected>20 Year</option><option value="25">25 Year</option><option value="30">30 Year</option>
              </select>
            </div>
            <div class="fg" style="min-width:180px">
              <label>Coverage ($) — type any amount</label>
              <input type="number" id="term-cov" placeholder="200000" value="200000" min="10000" step="5000">
            </div>
            <div class="fg"><label>Tobacco</label>
              <select id="term-tob"><option value="no">Non-Tobacco</option><option value="yes">Tobacco</option></select>
            </div>
            <div class="fg"><label>Payment Method</label>
              <select id="term-payment" onchange="onPaymentChange('term')">
                <option value="bank">Bank Draft / ACH</option>
                <option value="cc">Credit / Debit Card or SSI Billing</option>
              </select>
            </div>
            <div class="fg"><label>State</label>
              <select id="term-state">
                <option value="">—</option>
                <option>AL</option><option>AK</option><option>AZ</option><option>AR</option><option>CA</option>
                <option>CO</option><option>CT</option><option>DE</option><option>DC</option><option>FL</option>
                <option>GA</option><option>HI</option><option>ID</option><option>IL</option><option>IN</option>
                <option>IA</option><option>KS</option><option>KY</option><option>LA</option><option>ME</option>
                <option>MD</option><option>MA</option><option>MI</option><option>MN</option><option>MS</option>
                <option>MO</option><option>MT</option><option>NE</option><option>NV</option><option>NH</option>
                <option>NJ</option><option>NM</option><option>NY</option><option>NC</option><option>ND</option>
                <option>OH</option><option>OK</option><option>OR</option><option>PA</option><option>RI</option>
                <option>SC</option><option>SD</option><option>TN</option><option>TX</option><option>UT</option>
                <option>VT</option><option>VA</option><option>WA</option><option>WV</option><option>WI</option><option>WY</option>
              </select>
            </div>
          </div>
          <div id="term-cc-notice" style="display:none" class="pay-cc mt8">
            <span data-ico="credit-card" data-size="14" style="margin-right:6px;vertical-align:-2px"></span>Only <strong>Corebridge</strong> and <strong>Transamerica</strong> accept CC/Debit/SSI billing.
          </div>
          <div class="mt12">
            <div style="font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Health Conditions &amp; Medications</div>
            <div style="position:relative">
              <textarea id="term-health-text" style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:11px 13px;color:var(--text);font-family:var(--sans);font-size:13px;outline:none;resize:vertical;min-height:60px;transition:border-color .14s" placeholder="Describe health: conditions, medications, symptoms..." oninput="onHealthInput('term')"></textarea>
              <div id="term-ai-spinner" style="display:none;position:absolute;right:10px;top:10px;font-size:11px;color:#60a5fa;background:var(--bg3);padding:2px 6px;border-radius:4px">AI analyzing…</div>
            </div>
            <div id="term-parsed-tags" style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;min-height:10px"></div>
          </div>
          <div class="mt16">
            <button class="btn btn-p" onclick="runTermQuote()">Generate Quotes</button>
          </div>
        </div>

        <div id="term-results" style="display:none" class="mt20">
          <div class="verify-disclaimer">
            ⚠ Quick estimate based on industry-average rates — <strong>verify before quoting your client.</strong> Use <strong>Verify Live →</strong> below for real-time carrier numbers.
          </div>
          <div class="flex jb aic" style="margin-bottom:12px">
            <div style="font-size:15px;font-weight:600">Term Quote Results</div>
            <div style="font-size:11.5px;color:var(--text3)">Contract: <span class="mono text-g" id="term-contract-disp">100%</span></div>
          </div>
          <div class="g3" id="term-cards"></div>
          <div class="verify-cta" id="term-verify-cta" style="display:none">
            <span class="verify-cta-check">✓ Quote generated</span>
            <span style="margin-left:auto"><button class="btn btn-p" onclick="toggleVerifyPanel('term', true)">Verify these rates live →</button></span>
          </div>
          <div class="note mt8">Adv. commission = AP × comm% × 0.75 (9-month advance).</div>
        </div>

        <div id="term-verify-panel" class="verify-panel">
          <div class="verify-panel-head" onclick="toggleVerifyPanel('term')">
            <span class="live-dot"></span>
            <strong>Verify with live carrier rates</strong>
            <span style="color:var(--text3);font-size:12px">Real-time rates from Insurance Toolkits</span>
            <span class="verify-panel-caret">›</span>
          </div>
          <div class="verify-panel-body">
            <div id="term-verify-pre" style="padding:12px 0;color:var(--text2);font-size:13px">Run an estimate above first — we'll pre-fill the client info so you don't re-type it.</div>
            <div id="term-verify-post" style="display:none">
              <div style="font-size:13px;color:var(--text2);margin-top:8px">Confirmed through Insurance Toolkits</div>
              <div class="verify-chips" id="term-verify-chips"></div>
              <div style="font-size:11px;color:var(--text3);margin-bottom:8px">
                Prefill attempted (best-effort)
                <a id="term-verify-stale" href="#" onclick="event.preventDefault(); reloadVerifyIframe('term');" style="display:none;color:var(--text-g);margin-left:6px;text-decoration:underline">Re-load with new values</a>
              </div>
              <div id="term-verify-iframe-slot" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#fff"></div>
            </div>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Wire `runTermQuote` to arm and reveal the verify CTA**

Locate the end of `runTermQuote` (line 3661–3757-ish). Find the final line of the function body — likely a `scrollIntoView` call on `term-results` or similar. Immediately before the closing `}` of the function, add:

```js
  if (!pfx) {
    window._verifyArmed.term = true;
    const cta = document.getElementById('term-verify-cta');
    if (cta) cta.style.display = 'flex';
    setVerifyChips('term');
    if (window._verifyOpen.term) {
      const preEl  = document.getElementById('term-verify-pre');
      const postEl = document.getElementById('term-verify-post');
      if (preEl)  preEl.style.display  = 'none';
      if (postEl) postEl.style.display = 'block';
      if (!window._verifyLoaded.term) {
        const slot = document.getElementById('term-verify-iframe-slot');
        if (slot) {
          const url = buildPrefillUrl('term');
          slot.innerHTML = '<iframe style="border:none;height:820px;width:100%;display:block" src="' + url + '" loading="lazy"></iframe>';
          window._verifyLoaded.term = true;
          window._verifyLastUrl.term = url;
        }
      }
    }
  }
```

- [ ] **Step 3: Manual verification of Term**

Reload. Click Quote + Underwriting → Term. Verify:

- No sub-tabs.
- Form renders with state dropdown.
- Below: collapsed verify panel.

Fill: Age `35`, Gender Male, Term Length `20`, Coverage `200000`, Tobacco Non-Tobacco, Payment Bank Draft, State `TX`. Click Generate Quotes.

- Cards render.
- CTA appears below cards.

Click "Verify these rates live →". Verify chips: `Age 35`, `$200,000`, `Non-tobacco`, `Male`, `TX`, `Bank Draft`. Inspect iframe src in DevTools — expect `…&age=35&face=200000&gender=M&state=TX&tobacco=0&termLen=20`.

---

### Task 8: Restructure IUL markup and wire `runIULQuote`

**Files:**
- Modify: `index-3.html` lines 1442–1485 (the `#qt-iul` block)

- [ ] **Step 1: Replace the entire `#qt-iul` block**

Find `<div id="qt-iul" style="display:none">` (around line 1443) and its closing `</div>` immediately before `</div><!-- /sec-quoter -->`. Replace with:

```html
      <div id="qt-iul" style="display:none">
        <div class="card">
          <div class="card-title">IUL Estimate</div>
          <div class="alert alert-i"><span data-ico="info"></span><div>IUL quotes require full carrier illustrations. These are premium range estimates only.</div></div>
          <div class="frow">
            <div class="fg"><label>Age</label><input type="number" id="iul-age" placeholder="35" min="18" max="70"></div>
            <div class="fg"><label>Gender</label>
              <select id="iul-gender"><option value="M">Male</option><option value="F">Female</option></select>
            </div>
            <div class="fg" style="min-width:180px">
              <label>Death Benefit ($) — type any amount</label>
              <input type="number" id="iul-cov" placeholder="500000" value="500000" min="50000" step="10000">
            </div>
            <div class="fg"><label>Health Class</label>
              <select id="iul-health">
                <option value="preferred">Preferred</option>
                <option value="standard" selected>Standard</option>
                <option value="substandard">Substandard</option>
              </select>
            </div>
            <div class="fg"><label>State</label>
              <select id="iul-state">
                <option value="">—</option>
                <option>AL</option><option>AK</option><option>AZ</option><option>AR</option><option>CA</option>
                <option>CO</option><option>CT</option><option>DE</option><option>DC</option><option>FL</option>
                <option>GA</option><option>HI</option><option>ID</option><option>IL</option><option>IN</option>
                <option>IA</option><option>KS</option><option>KY</option><option>LA</option><option>ME</option>
                <option>MD</option><option>MA</option><option>MI</option><option>MN</option><option>MS</option>
                <option>MO</option><option>MT</option><option>NE</option><option>NV</option><option>NH</option>
                <option>NJ</option><option>NM</option><option>NY</option><option>NC</option><option>ND</option>
                <option>OH</option><option>OK</option><option>OR</option><option>PA</option><option>RI</option>
                <option>SC</option><option>SD</option><option>TN</option><option>TX</option><option>UT</option>
                <option>VT</option><option>VA</option><option>WA</option><option>WV</option><option>WI</option><option>WY</option>
              </select>
            </div>
          </div>
          <div class="mt16"><button class="btn btn-p" onclick="runIULQuote()">Estimate IUL Premiums</button></div>
        </div>

        <div id="iul-results" style="display:none" class="mt20">
          <div class="verify-disclaimer">
            ⚠ Quick estimate based on industry-average rates — <strong>verify before quoting your client.</strong> Use <strong>Verify Live →</strong> below for real-time carrier numbers.
          </div>
          <div style="font-size:15px;font-weight:600;margin-bottom:12px">IUL Carrier Estimates</div>
          <div class="g3" id="iul-cards"></div>
          <div class="verify-cta" id="iul-verify-cta" style="display:none">
            <span class="verify-cta-check">✓ Quote generated</span>
            <span style="margin-left:auto"><button class="btn btn-p" onclick="toggleVerifyPanel('iul', true)">Verify these rates live →</button></span>
          </div>
          <div class="note mt8">IUL commissions per comp guide. Always run full carrier illustration for exact figures.</div>
        </div>

        <div id="iul-verify-panel" class="verify-panel">
          <div class="verify-panel-head" onclick="toggleVerifyPanel('iul')">
            <span class="live-dot"></span>
            <strong>Verify with live carrier rates</strong>
            <span style="color:var(--text3);font-size:12px">Real-time rates from Insurance Toolkits</span>
            <span class="verify-panel-caret">›</span>
          </div>
          <div class="verify-panel-body">
            <div id="iul-verify-pre" style="padding:12px 0;color:var(--text2);font-size:13px">Run an estimate above first — we'll pre-fill the client info so you don't re-type it.</div>
            <div id="iul-verify-post" style="display:none">
              <div style="font-size:13px;color:var(--text2);margin-top:8px">Confirmed through Insurance Toolkits</div>
              <div class="verify-chips" id="iul-verify-chips"></div>
              <div style="font-size:11px;color:var(--text3);margin-bottom:8px">
                Prefill attempted (best-effort)
                <a id="iul-verify-stale" href="#" onclick="event.preventDefault(); reloadVerifyIframe('iul');" style="display:none;color:var(--text-g);margin-left:6px;text-decoration:underline">Re-load with new values</a>
              </div>
              <div id="iul-verify-iframe-slot" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#fff"></div>
            </div>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Wire `runIULQuote` to arm and reveal the verify CTA**

Locate the end of `runIULQuote` (line 3759–end). Immediately before the function's closing `}`, add:

```js
  if (!pfx) {
    window._verifyArmed.iul = true;
    const cta = document.getElementById('iul-verify-cta');
    if (cta) cta.style.display = 'flex';
    setVerifyChips('iul');
    if (window._verifyOpen.iul) {
      const preEl  = document.getElementById('iul-verify-pre');
      const postEl = document.getElementById('iul-verify-post');
      if (preEl)  preEl.style.display  = 'none';
      if (postEl) postEl.style.display = 'block';
      if (!window._verifyLoaded.iul) {
        const slot = document.getElementById('iul-verify-iframe-slot');
        if (slot) {
          const url = buildPrefillUrl('iul');
          slot.innerHTML = '<iframe style="border:none;height:820px;width:100%;display:block" src="' + url + '" loading="lazy"></iframe>';
          window._verifyLoaded.iul = true;
          window._verifyLastUrl.iul = url;
        }
      }
    }
  }
```

- [ ] **Step 3: Manual verification of IUL**

Reload. Click Quote + Underwriting → IUL. Verify no sub-tabs, form renders with state dropdown, verify panel collapsed below.

Fill: Age `40`, Gender Female, Death Benefit `500000`, Health Class Standard, State `FL`. Click Estimate IUL Premiums.

Cards render. CTA appears. Click "Verify these rates live →". Chips: `Age 40`, `$500,000`, `Female`, `FL`. (No tobacco or payment for IUL.) Iframe src should include `&age=40&face=500000&gender=F&state=FL` and NOT include `tobacco` or `termLen`.

---

### Task 9: Remove obsolete tab-switching functions

**Files:**
- Modify: `index-3.html` lines 6715–6740 (delete `feTab`, `termTab`, `iulTab`)

- [ ] **Step 1: Delete `feTab`**

Find `function feTab(id, el, pfx='') {` (around line 6715). Delete this function entirely, including its body and closing `}`. The function is around 6 lines.

- [ ] **Step 2: Delete `termTab`**

Find `function termTab(id, el, pfx='') {`. Delete entirely.

- [ ] **Step 3: Delete `iulTab`**

Find `function iulTab(id, el, pfx='') {`. Delete entirely.

- [ ] **Step 4: Sanity-check that nothing else calls them**

Run:

```bash
grep -n "feTab\|termTab\|iulTab" "/Users/tanner/Jace- Life Insurance/index-3.html"
```

Expected: no matches. If any remain, they're leftover `onclick` references — track them down and remove (they should already be gone via the Task 5/7/8 markup replacements).

- [ ] **Step 5: Manual verification**

Reload. Open DevTools → Console. Run:

```js
typeof feTab + ' ' + typeof termTab + ' ' + typeof iulTab
```

Expected: `"undefined undefined undefined"`. No console errors on page load.

Click through FE, Term, IUL tabs. All three render correctly with no sub-tabs.

---

### Task 10: Full integration verification (spec's 12-point checklist)

**Files:**
- None modified. Manual browser test against the complete spec.

- [ ] **Step 1: Run the spec's verification checklist**

Open `index-3.html` in a fresh browser tab (or Cmd+Shift+R hard reload). For each item, confirm before proceeding:

1. ✅ **Tabs collapsed:** Quote + Underwriting → FE. No sub-tabs. Estimator form is first visible content.
2. ✅ **Pre-quote panel state:** Scroll to bottom. Click verify bar. State 2 message shows. `document.querySelectorAll('#fe-verify-panel iframe').length === 0`.
3. ✅ **Post-quote flow:** Fill 40M / $10,000 / healthy / bank / state NV. Generate Quotes. Cards render. CTA appears.
4. ✅ **CTA expand + scroll:** Click CTA. Panel expands, iframe attaches, chips show `Age 40 · $10,000 · Non-tobacco · Male · NV · Bank Draft`. Smooth scroll lands on panel.
5. ✅ **Prefill URL constructed:** DevTools → inspect iframe src. Params present.
6. ✅ **Re-quote with different values:** Change age to 65, re-run. Chips update. "Re-load with new values" link appears. Click it. Iframe reloads with new URL.
7. ✅ **Term repeats:** Same flow on Term. `termLen` param present in URL.
8. ✅ **IUL repeats:** Same flow on IUL. No tobacco/termLen params (IUL form doesn't have those fields).
9. ✅ **Page reload:** Hard reload. All three verify panels return to collapsed state.
10. ✅ **Reduced motion:** DevTools → Rendering → Emulate CSS media feature `prefers-reduced-motion: reduce`. Re-trigger CTA. Scroll uses `auto`, not `smooth`.
11. ✅ **Regression — quote numbers unchanged:** Compare a known scenario before and after. Open `archive/index-2026-05-11-pre-verify-panel.html` in a second tab, fill 40M / $10k / healthy / bank, generate. Compare monthly / annual / comm% / adv-comm with the new file's results. Must be identical.
12. ✅ **Regression — other tabs work:** Policy Tracker, Drafts, Bonus Tracker, UW Cheat Sheet still render and navigate.

- [ ] **Step 2: Close out**

If all 12 pass, the implementation is complete. If any fail, document the failure inline below and fix before declaring done.

**Failures observed:**
- _none yet — fill in if any_

- [ ] **Step 3: Update project memory**

Update `/Users/tanner/.claude/projects/-Users-tanner-Jace--Life-Insurance/memory/project_policypilot.md` to record:

- File is `index-3.html` (memory currently says `index.html` — stale)
- Quote + Underwriting now uses verify-panel pattern; no more sub-tabs
- State field added to FE/Term/IUL forms
- Snapshot: `archive/index-2026-05-11-pre-verify-panel.html`

Update line ranges as needed since this edit shifts subsequent line numbers.

- [ ] **Step 4: Update vault**

Per global CLAUDE.md ingest rules, add a brief log entry to `/Users/tanner/Documents/Construct.AI/Construct.AI/log.md`:

```
## [2026-05-11] update | PolicyPilot — Path C verify-panel reframe shipped
Replaced FE/Term/IUL sub-tabs with single-page workflow + collapsible
Insurance Toolkits verify panel. State field added for prefill.
```

And update `Projects/PolicyPilot.md` to reflect the new structure (the "Sections" table mentions the old sub-tab pattern). Snapshot the change there.

---

## Self-Review

**Spec coverage:**

- §"Conceptual shift" → Tasks 5, 7, 8 (markup restructure)
- §"Sub-tabs removed" → Task 5/7/8 markup + Task 9 JS cleanup
- §"Verification panel — three states" → Tasks 5/7/8 (markup) + Task 4 (`toggleVerifyPanel` state logic)
- §"The handoff CTA" → Tasks 6/7/8 (per-product `run*Quote` hooks) + Task 5/7/8 markup
- §"Estimator labeling" → `.verify-disclaimer` in Task 3 CSS + Task 5/7/8 markup
- §"Best-effort prefill" → Task 4 `buildPrefillUrl`
- §"State the panel owns" → Task 4 (state objects on window)
- §"Error handling" → All four cases addressed in `setVerifyChips` (stale link), `toggleVerifyPanel` (lazy attach), `reloadVerifyIframe`, and the omit-empty-params logic in `buildPrefillUrl`
- §"Testing" → Task 10's 12-point checklist mirrors the spec exactly
- §"Out of scope" → No tasks for these (as designed)
- §"Migration to Path A" → Documented in spec; not implemented here

**Placeholder scan:** No "TBD," "TODO," or "handle edge cases later." Every step has runnable code or commands.

**Type consistency:** `buildPrefillUrl`, `setVerifyChips`, `toggleVerifyPanel`, `reloadVerifyIframe` defined in Task 4 — used by exact same names in Tasks 5/6/7/8. State objects (`_verifyOpen`, `_verifyArmed`, `_verifyLoaded`, `_verifyLastUrl`) defined Task 4, used in Tasks 6/7/8 hooks. Product keys (`fe`/`term`/`iul`) consistent throughout.

**One discovered gap, fixed:** Task 2 adds the state dropdown standalone, which Task 5/7/8 then replaces wholesale. This isn't a contradiction — Task 2 makes the dropdown available even if implementation pauses; Task 5/7/8 are the canonical structure. Both ordering paths converge to the same end state. Noted in Task 5 Step 1.
