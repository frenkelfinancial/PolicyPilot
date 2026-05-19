# Phone Book — Basic / Pro / Max Pricing Tiers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the never-deployed `Starter / Pro / Scale` plan seed in `data/sql/009_phone_book.sql` with `Basic / Pro / Max` tiers that bundle outbound minutes, ITK quotes, included DID numbers, and recording retention — then wire the Phone Book UI to read/show/apply the new dimensions.

**Architecture:** Single-file HTML app (`index.html`) plus per-migration `data/sql/NNN_*.sql` files plus Supabase edge functions in `supabase/functions/`. Plan changes touch (a) one SQL migration that hasn't been pasted yet, so it's a revision-in-place, and (b) ~5 JS functions inside the Phone Book module in `index.html`. **No edge-function changes** — `signalwire-bridge` and `itk-quote` already read `agents.monthly_minute_limit` and `agents.monthly_quote_limit`; we keep those columns as the authoritative caps and have `pbApplyPlanChange()` write them from the chosen plan.

**Tech Stack:** Supabase Postgres (with RLS), SignalWire LaML REST (unchanged), single-file vanilla-JS `index.html`, browser-side rendering via `sb.from(...)` queries.

**Reference spec:** `docs/superpowers/specs/2026-05-18-phonebook-pricing-tiers-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `data/sql/009_phone_book.sql` | **Modify** | Add 3 columns to `plans`, replace seed with Basic/Pro/Max |
| `index.html` (Phone Book module, ~lines 10460–11130) | **Modify** | Render new dimensions, write both caps on plan change, include/extra DID UX |
| `docs/superpowers/specs/2026-05-18-phonebook-pricing-tiers-design.md` | Already written | Reference only |
| Memory: `project_phone_book.md` | **Modify (last)** | Update to record the rename + new dimensions |

No new files. Everything lives in existing surfaces.

---

## Task 1: Revise the `plans` table schema and seed

**Files:**
- Modify: `data/sql/009_phone_book.sql`

- [ ] **Step 1: Open the file**

Read `data/sql/009_phone_book.sql` from line 19 to line 65 (the `plans` table + seed + agent backfill).

- [ ] **Step 2: Add the three new columns to the `create table` block**

Replace the `create table if not exists public.plans (...)` definition. The new columns go between `monthly_cost` and `sort_order`:

```sql
create table if not exists public.plans (
  id                        uuid primary key default gen_random_uuid(),
  slug                      text not null unique,
  name                      text not null,
  monthly_minutes           int  not null,
  monthly_quote_limit       int  not null default 0,
  included_numbers          int  not null default 0,
  recording_retention_days  int  not null default 30,
  monthly_cost              numeric(8,2) not null,
  sort_order                int  not null default 0,
  active                    boolean not null default true,
  created_at                timestamptz not null default now()
);
```

- [ ] **Step 3: Update the `comment on table public.plans` block**

Replace with:

```sql
comment on table public.plans is
  'Subscription tiers for the Phone Book. Each plan bundles four caps: monthly_minutes (outbound calling), monthly_quote_limit (ITK live quotes, rolling 30-day), included_numbers (DIDs absorbed by the plan), recording_retention_days. Billing is not wired up — upgrading bumps plan_id and denormalizes the minute + quote caps onto public.agents for the edge functions to read.';
```

- [ ] **Step 4: Replace the 3-row seed**

Replace the `insert into public.plans ...` block with:

```sql
insert into public.plans
  (slug, name, monthly_minutes, monthly_quote_limit, included_numbers, recording_retention_days, monthly_cost, sort_order)
values
  ('basic', 'Basic',    750,    250,  1,  30,  29.00, 1),
  ('pro',   'Pro',    2500,   1000,  3,  90,  79.00, 2),
  ('max',   'Max',   10000,  10000, 10, 365, 199.00, 3)
on conflict (slug) do nothing;
```

- [ ] **Step 5: Update the file header comment**

Replace the bullet describing `plans` in the top comment block (lines 4-9) with:

```
--   • public.plans          — tiered subscription plans for the Phone Book
--                             (Basic/Pro/Max; bundles minutes + ITK quotes
--                             + included DIDs + recording retention)
```

- [ ] **Step 6: Update the `comment on column agents.plan_id`**

Replace the existing comment (around line 43-44) with:

```sql
comment on column public.agents.plan_id is
  'Current subscription plan. agents.monthly_minute_limit AND agents.monthly_quote_limit are denormalized from the plan whenever this changes — edge functions (signalwire-bridge, itk-quote) read those agent-level columns directly.';
```

- [ ] **Step 7: Verify the backfill block is still correct**

The existing backfill (lines 49-65) chooses the smallest plan whose `monthly_minutes >= agents.monthly_minute_limit`. With the new minute ladder (750/2500/10000) and existing agent default cap of 500, every agent will land on Basic. **No edits to the backfill block** — confirm it still reads as-is.

- [ ] **Step 8: Sanity-grep the file for orphaned references**

Run:

```bash
grep -nE "starter|scale" "/Users/tanner/Jace- Life Insurance/data/sql/009_phone_book.sql"
```

Expected: **no matches**. If anything matches, edit it out — the rename should be complete in this file.

- [ ] **Step 9: Commit**

```bash
cd "/Users/tanner/Jace- Life Insurance"
git add data/sql/009_phone_book.sql
git commit -m "feat(phone-book): rename plans to Basic/Pro/Max with bundled caps

Adds monthly_quote_limit, included_numbers, recording_retention_days to
public.plans. Reseeds with Basic (\$29 / 750 min / 250 quotes / 1 DID),
Pro (\$79 / 2500 / 1000 / 3), Max (\$199 / 10000 / 10000 / 10). Migration
hasn't been pasted yet so this is an in-place revision.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extend the Phone Book parallel fetch to include quote usage

**Files:**
- Modify: `index.html` (the `renderPhoneBook()` function, currently at ~line 10548)

**Context:** Right now `Promise.all` in `renderPhoneBook()` runs 5 reads in parallel: agent row, plans catalog, owned phone numbers, calls (last 100), and month-to-date calls (for minute usage). We add a 6th read: `quote_usage` from `005_quote_usage.sql`, restricted to the **trailing 30 days** (matching what `itk-quote` enforces — see `supabase/functions/itk-quote/index.ts:113`).

- [ ] **Step 1: Locate the `Promise.all` in `renderPhoneBook()`**

Open `index.html` and find the block starting `const [agentRes, plansRes, numbersRes, callsRes, monthCallsRes] = await Promise.all([` (around line 10566).

- [ ] **Step 2: Add a 6th read for quote usage**

Compute a `quoteWindowStart` just before the `Promise.all` (next to the existing `monthStart` declaration around line 10560), then add a 6th read inside the array. The full updated block:

```js
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0,0,0,0);

  // Quote usage uses a rolling 30-day window (itk-quote enforces this,
  // see supabase/functions/itk-quote/index.ts). Minutes are calendar-
  // month-since-the-1st; quotes are trailing-30-days. Keep both.
  const quoteWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [agentRes, plansRes, numbersRes, callsRes, monthCallsRes, quoteUsageRes] = await Promise.all([
    sb.from('agents')
      .select('id, agent_phone, signalwire_caller_id, monthly_minute_limit, monthly_quote_limit, plan_id')
      .eq('id', currentAgent.id).maybeSingle(),
    sb.from('plans')
      .select('id, slug, name, monthly_minutes, monthly_quote_limit, included_numbers, recording_retention_days, monthly_cost, sort_order')
      .eq('active', true).order('sort_order', { ascending: true }),
    sb.from('phone_numbers')
      .select('id, e164, friendly_name, locality, region, sw_phone_sid, monthly_cost, is_primary, status, purchased_at')
      .eq('agent_id', currentAgent.id)
      .order('is_primary', { ascending: false })
      .order('purchased_at', { ascending: true }),
    sb.from('calls')
      .select('id, lead_id, direction, phone_from, phone_to, started_at, ended_at, answered_at, duration_sec, status, outcome, sw_call_sid')
      .eq('agent_id', currentAgent.id)
      .order('started_at', { ascending: false })
      .limit(100),
    sb.from('calls')
      .select('duration_sec')
      .eq('agent_id', currentAgent.id)
      .gte('started_at', monthStart.toISOString()),
    sb.from('quote_usage')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', currentAgent.id)
      .gte('created_at', quoteWindowStart.toISOString()),
  ]);
```

The `quote_usage` read uses PostgREST's `head: true` + `count: 'exact'` so we get just the row count, not the rows themselves.

- [ ] **Step 3: Add quote-fetch error logging next to the others**

Right after the existing `if (monthCallsRes.error)` line, add:

```js
  if (quoteUsageRes.error) console.warn('[phonebook] quote usage fetch failed', quoteUsageRes.error);
```

- [ ] **Step 4: Compute `quotesUsed` and pass it to the plan card**

Below the existing `const usedMin = Math.floor(usedSec / 60);` line, add:

```js
  const quotesUsed = quoteUsageRes.count || 0;
```

Then change the call to `pbRenderPlanCard(_pbAgent, usedMin);` (around line 10605) to:

```js
  pbRenderPlanCard(_pbAgent, usedMin, quotesUsed);
```

- [ ] **Step 5: Verify by grep that all expected pieces are in place**

```bash
grep -nE "quoteUsageRes|quotesUsed|quoteWindowStart" "/Users/tanner/Jace- Life Insurance/index.html"
```

Expected: at least 5 hits (declaration, in array, error log, derived count, render call argument).

- [ ] **Step 6: Commit**

```bash
cd "/Users/tanner/Jace- Life Insurance"
git add index.html
git commit -m "feat(phone-book): fetch trailing-30d quote usage alongside plan data

Adds a 6th parallel read to renderPhoneBook() for quote_usage in a
30-day rolling window, matching itk-quote's enforcement cadence. The
plan-card renderer gets a third argument so it can draw the quote bar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Render the new plan-card dimensions (quotes, numbers, retention)

**Files:**
- Modify: `index.html` (the `pbRenderPlanCard()` function at ~line 10646, plus a small HTML block at ~line 2862)

**Context:** Today the plan card shows one progress bar (minutes), the cap line, the cost line, and a renews-on date. We're adding (1) a quote progress bar with its own usage row, (2) a one-liner showing owned vs. included numbers, (3) a one-liner showing recording retention.

- [ ] **Step 1: Add new HTML spans for the quote bar inside `#sec-phonebook .pb-card-plan`**

Find the existing plan card markup in `index.html` around line 2862-2875. After the existing minute-bar/`pb-bar-meta` block and before the `pb-plan-renews` div, insert:

```html
          <div class="pb-bar"><div class="pb-bar-fill" id="pb-plan-q-bar" style="width:0%"></div></div>
          <div class="pb-bar-meta">
            <span><span id="pb-plan-q-used">0</span> / <span id="pb-plan-q-cap">—</span> quotes used (last 30 days)</span>
            <span id="pb-plan-q-pct">0%</span>
          </div>
          <div class="pb-plan-numbers" id="pb-plan-numbers">—</div>
          <div class="pb-plan-retention" id="pb-plan-retention">—</div>
```

The final HTML for the plan card (lines ~2862-2876) should look like:

```html
        <div class="card pb-card-plan">
          <div class="cardhdr"><div class="cardttl">Plan</div></div>
          <div class="pb-plan-name" id="pb-plan-name">Loading…</div>
          <div class="pb-plan-cap"><span id="pb-plan-min-cap">—</span> minutes/month · <span id="pb-plan-cost">$—</span>/mo</div>
          <div class="pb-bar"><div class="pb-bar-fill" id="pb-plan-bar" style="width:0%"></div></div>
          <div class="pb-bar-meta">
            <span><span id="pb-plan-min-used">0</span> / <span id="pb-plan-min-cap-2">—</span> min used</span>
            <span id="pb-plan-pct">0%</span>
          </div>
          <div class="pb-bar"><div class="pb-bar-fill" id="pb-plan-q-bar" style="width:0%"></div></div>
          <div class="pb-bar-meta">
            <span><span id="pb-plan-q-used">0</span> / <span id="pb-plan-q-cap">—</span> quotes used (last 30 days)</span>
            <span id="pb-plan-q-pct">0%</span>
          </div>
          <div class="pb-plan-numbers" id="pb-plan-numbers">—</div>
          <div class="pb-plan-retention" id="pb-plan-retention">—</div>
          <div class="pb-plan-renews">Resets <span id="pb-plan-renews">—</span></div>
          <button class="btn btn-g pb-plan-upgrade" id="pb-plan-upgrade-btn" onclick="pbOpenUpgradeModal()">Upgrade Plan</button>
        </div>
```

- [ ] **Step 2: Add CSS for the two new lines**

In the `#sec-phonebook` CSS block, right after `#sec-phonebook .pb-plan-renews { ... }` (around line 1673), add:

```css
#sec-phonebook .pb-plan-numbers,
#sec-phonebook .pb-plan-retention{
  font-size:12px;
  color:var(--text2);
  margin-top:4px;
}
#sec-phonebook .pb-plan-numbers.over{ color:var(--ds-color-warning); }
```

- [ ] **Step 3: Update `pbRenderPlanCard()` signature and body**

Change the function signature (around line 10646) from `function pbRenderPlanCard(agent, usedMin)` to:

```js
function pbRenderPlanCard(agent, usedMin, quotesUsed) {
```

After the existing `const renews = document.getElementById('pb-plan-renews');` line, add the new element lookups:

```js
  const qBar    = document.getElementById('pb-plan-q-bar');
  const qUsedEl = document.getElementById('pb-plan-q-used');
  const qCapEl  = document.getElementById('pb-plan-q-cap');
  const qPctEl  = document.getElementById('pb-plan-q-pct');
  const numEl   = document.getElementById('pb-plan-numbers');
  const retEl   = document.getElementById('pb-plan-retention');
```

After the existing minute-bar render block (after the `planBar.classList.toggle('over', pct >= 90);` line), add quote-bar rendering:

```js
  // Quote bar — sourced from plan.monthly_quote_limit if a plan is
  // attached; falls back to agent.monthly_quote_limit (which the
  // itk-quote function reads as the authoritative cap).
  const qCap =
    (plan && typeof plan.monthly_quote_limit === 'number' && plan.monthly_quote_limit > 0) ? plan.monthly_quote_limit :
    (typeof agent.monthly_quote_limit === 'number') ? agent.monthly_quote_limit : 250;
  const qPct = qCap > 0 ? Math.min(100, Math.round(100 * (quotesUsed || 0) / qCap)) : 0;

  if (qUsedEl) qUsedEl.textContent = (quotesUsed || 0).toLocaleString();
  if (qCapEl)  qCapEl.textContent  = qCap.toLocaleString();
  if (qPctEl)  qPctEl.textContent  = qPct + '%';
  if (qBar) {
    qBar.style.width = qPct + '%';
    qBar.classList.toggle('warn', qPct >= 75 && qPct < 90);
    qBar.classList.toggle('over', qPct >= 90);
  }

  // Numbers count — needs the owned count, which lives in module-scope
  // _pbNumbers (already populated by renderPhoneBook before this call).
  const ownedCount    = Array.isArray(_pbNumbers) ? _pbNumbers.length : 0;
  const includedCount = (plan && typeof plan.included_numbers === 'number') ? plan.included_numbers : 0;
  if (numEl) {
    numEl.textContent = `Numbers: ${ownedCount} of ${includedCount} included`;
    numEl.classList.toggle('over', ownedCount > includedCount);
  }

  // Recording retention — informational; no purge job exists yet.
  const retDays = (plan && typeof plan.recording_retention_days === 'number') ? plan.recording_retention_days : 30;
  if (retEl) retEl.textContent = `Recordings kept for ${retDays} days`;
```

- [ ] **Step 4: Smoke-grep for the new selectors**

```bash
grep -nE "pb-plan-q-bar|pb-plan-q-used|pb-plan-q-cap|pb-plan-q-pct|pb-plan-numbers|pb-plan-retention" "/Users/tanner/Jace- Life Insurance/index.html"
```

Expected: each selector appears at least twice (HTML def + JS lookup).

- [ ] **Step 5: Commit**

```bash
cd "/Users/tanner/Jace- Life Insurance"
git add index.html
git commit -m "feat(phone-book): render quote-usage bar, included-numbers count, retention

Plan card now shows the four plan dimensions: minutes, quotes (rolling
30d), DID inventory vs. included count, recording retention days. Quote
bar warns >=75% and goes red >=90%, matching the minute bar styling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Upgrade modal shows the full plan dimensions per option

**Files:**
- Modify: `index.html` (the `pbRenderUpgradeOptions()` function at ~line 11058)

**Context:** Today each plan option shows only minutes ("2,500 minutes per month"). We replace that with a 3-line breakdown.

- [ ] **Step 1: Update the option-row template inside `pbRenderUpgradeOptions()`**

Replace the existing `.pb-plan-opt-detail` div block (around line 11073) inside the `_pbPlans.map(p => { ... })` call. The new template:

```js
  wrap.innerHTML = _pbPlans.map(p => {
    const isCurrent = p.id === currentId;
    const mins   = Number(p.monthly_minutes || 0).toLocaleString();
    const quotes = Number(p.monthly_quote_limit || 0).toLocaleString();
    const nums   = Number(p.included_numbers || 0);
    return `
      <label class="pb-plan-opt ${isCurrent ? 'current' : ''}" data-id="${escapeHTML(p.id)}">
        <input type="radio" name="pb-upgrade-plan" value="${escapeHTML(p.id)}" ${isCurrent ? 'disabled checked' : ''}>
        <div class="pb-plan-opt-body">
          <div class="pb-plan-opt-name">${escapeHTML(p.name)}${isCurrent ? '<span class="pb-plan-opt-current">Current</span>' : ''}</div>
          <div class="pb-plan-opt-detail">${mins} minutes / month</div>
          <div class="pb-plan-opt-detail">${quotes} live quotes / month</div>
          <div class="pb-plan-opt-detail">${nums} phone number${nums === 1 ? '' : 's'} included</div>
        </div>
        <div class="pb-plan-opt-price">$${Number(p.monthly_cost).toFixed(2)}/mo</div>
      </label>
    `;
  }).join('');
```

The click handler below this block does not need changes.

- [ ] **Step 2: Verify there are exactly three `.pb-plan-opt-detail` divs in the new template**

```bash
grep -nE "pb-plan-opt-detail" "/Users/tanner/Jace- Life Insurance/index.html"
```

Expected: 1 CSS rule + 3 JS template lines = 4 matches.

- [ ] **Step 3: Update the billing note text in the modal**

The existing `pb-billing-note` (around line 3166-3168) should mention the included-numbers semantics. Replace its inner text with:

```html
      Billing isn't wired up yet — switching plans just updates your monthly minute and quote caps right now. Included numbers absorb the SignalWire per-number fee up to your plan's count; "extras" are informational ($1.50/mo each) until payment processing lands.
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/tanner/Jace- Life Insurance"
git add index.html
git commit -m "feat(phone-book): upgrade modal shows minutes/quotes/numbers per tier

Each plan row in the upgrade modal renders a 3-line breakdown instead of
just minutes. Billing note clarifies included-numbers vs. extras
semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `pbApplyPlanChange()` writes both minute + quote caps

**Files:**
- Modify: `index.html` (the `pbApplyPlanChange()` function at ~line 11093)

**Context:** Today the function writes only `{ plan_id, monthly_minute_limit }`. We extend the payload so `itk-quote` sees the new quote cap immediately.

- [ ] **Step 1: Update the `sb.from('agents').update(...)` payload**

Replace the existing update call (around line 11100-11103) with:

```js
    const { error } = await sb.from('agents').update({
      plan_id:              plan.id,
      monthly_minute_limit: plan.monthly_minutes,
      monthly_quote_limit:  plan.monthly_quote_limit,
    }).eq('id', currentAgent.id);
```

- [ ] **Step 2: Verify the surrounding error handling and toast logic still works as-is**

The `try / catch` and `showToast(\`Switched to ${plan.name}\`, ...)` block around it does not need changes — we're only widening the update payload.

- [ ] **Step 3: Commit**

```bash
cd "/Users/tanner/Jace- Life Insurance"
git add index.html
git commit -m "feat(phone-book): plan switch denormalizes monthly_quote_limit too

When an agent picks a new plan, write both monthly_minute_limit (read by
signalwire-bridge) and monthly_quote_limit (read by itk-quote) onto the
agents row so enforcement matches the new plan instantly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Buy-Number flow distinguishes "included" from "extra"

**Files:**
- Modify: `index.html` (the `pbSearchNumbers()` and `pbConfirmBuy()` functions at ~lines 10932 and 11005)

**Context:** Right now Search Numbers shows a generic `$1.00` cost column, and Confirm Buy says "~$1.00/month to your SignalWire bill". We surface whether the next purchase falls **inside** the plan's included count or **beyond** it. The actual fee is informational — there is no billing wiring — but the disclosure is truthful about what the future state will be.

- [ ] **Step 1: Add a helper to compute included-remaining**

Just above `function pbOpenBuyModal()` (around line 10911), add:

```js
function _pbIncludedRemaining() {
  if (!_pbAgent || !_pbAgent.plan_id || !Array.isArray(_pbPlans)) return 0;
  const plan = _pbPlans.find(p => p.id === _pbAgent.plan_id);
  if (!plan || typeof plan.included_numbers !== 'number') return 0;
  const owned = Array.isArray(_pbNumbers) ? _pbNumbers.length : 0;
  return Math.max(0, plan.included_numbers - owned);
}
```

- [ ] **Step 2: Update the status message in `pbSearchNumbers()`**

Find the line `status.textContent = \`${list.length} numbers available for ${area}. Click Buy to purchase ($1.00/mo each).\`;` (around line 10973) and replace it with:

```js
    const remaining = _pbIncludedRemaining();
    const hint = remaining > 0
      ? `${remaining} included with your plan, $1.50/mo each after that (billing not yet active).`
      : `All included slots used — $1.50/mo each (billing not yet active).`;
    status.textContent = `${list.length} numbers available for ${area}. ${hint}`;
```

- [ ] **Step 3: Update the per-row cost rendering inside the buy table**

Find the row template inside `pbSearchNumbers()` (the `tbody.innerHTML = list.map(...)` block around line 10975-10988). Replace the `const cost = ...` line and the cost-cell rendering:

```js
    const remaining = _pbIncludedRemaining();
    tbody.innerHTML = list.map((n, i) => {
      const isIncluded = i < remaining;
      const label = isIncluded
        ? `<span class="pb-included-pill">Included</span>`
        : `<span class="mono">$1.50/mo</span>`;
      return `
        <tr>
          <td class="mono">${escapeHTML(_pbFmtPhone(n.phone_number))}</td>
          <td>${escapeHTML(n.locality || '—')}</td>
          <td>${escapeHTML(n.region || '—')}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${label}</td>
          <td style="text-align:right">
            <button class="btn btn-g btn-sm pb-buy-btn" data-idx="${i}">Buy</button>
          </td>
        </tr>
      `;
    }).join('');
```

(The previous `const remaining = ...` from Step 2 is computed twice in this function — that's fine, it's a single-array indexOf-free integer; if you want to dedup, hoist it just inside the `try { }` block before the status assignment.)

- [ ] **Step 4: Add CSS for the `.pb-included-pill` chip**

In the `#sec-phonebook .pb-modal ...` CSS block (around line 1785-1815), add:

```css
.pb-modal .pb-included-pill{
  display:inline-block;
  padding:2px 8px;
  border-radius:6px;
  font-size:11.5px;
  font-weight:600;
  background:rgba(16,185,129,.18);
  color:#34d399;
}
```

- [ ] **Step 5: Update the confirm dialog in `pbConfirmBuy()`**

Find the existing `window.confirm(...)` call (around line 11007-11011) and replace it with:

```js
  const remaining = _pbIncludedRemaining();
  const msg = remaining > 0
    ? `Purchase ${_pbFmtPhone(e164)}?\n\n` +
      `This number is included with your plan — no extra subscription charge. ` +
      `SignalWire's own per-number fee still applies to your SignalWire account.`
    : `Purchase ${_pbFmtPhone(e164)}?\n\n` +
      `This is beyond your plan's included numbers. When billing goes live this ` +
      `will add $1.50/mo to your subscription; today the charge is informational only. ` +
      `SignalWire's own per-number fee applies regardless.`;
  const ok = window.confirm(msg);
  if (!ok) return;
```

- [ ] **Step 6: Verify the buy modal text/CSS hooks are all present**

```bash
grep -nE "_pbIncludedRemaining|pb-included-pill" "/Users/tanner/Jace- Life Insurance/index.html"
```

Expected: helper definition + 3+ callsites, CSS rule + 1 usage.

- [ ] **Step 7: Commit**

```bash
cd "/Users/tanner/Jace- Life Insurance"
git add index.html
git commit -m "feat(phone-book): show included vs. extra DID status in buy flow

Search results show 'Included' pill for purchases inside the plan's
included_numbers count, '\$1.50/mo' for the rest. Confirm dialog mirrors
the same distinction. Billing wiring still deferred — the dollar figure
is a truthful disclosure of future state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Update the project-memory note

**Files:**
- Modify: `/Users/tanner/.claude/projects/-Users-tanner-Jace--Life-Insurance/memory/project_phone_book.md`

- [ ] **Step 1: Append a "Pricing tiers (Basic/Pro/Max)" subsection**

Open the memory file and add a new subsection just before the existing "Out of scope (deferred)" block. Insert:

```markdown
**Pricing tiers (2026-05-18):**
- Basic — $29/mo · 750 min · 250 ITK quotes · 1 DID included · 30d recordings
- Pro — $79/mo · 2,500 min · 1,000 ITK quotes · 3 DIDs included · 90d recordings
- Max — $199/mo · 10,000 min · 10,000 ITK quotes · 10 DIDs included · 365d recordings
- Extras beyond included DIDs: $1.50/mo each (informational; billing not yet wired)
- Hard caps on minutes + quotes; SignalWire's underlying per-number/per-minute fees still post to the SignalWire account directly
- Plan's quote/minute caps denormalize onto `agents.monthly_quote_limit` and `agents.monthly_minute_limit` on plan change; edge functions (`signalwire-bridge`, `itk-quote`) read those agent columns unchanged
- Spec: `docs/superpowers/specs/2026-05-18-phonebook-pricing-tiers-design.md`; plan: `docs/superpowers/plans/2026-05-18-phonebook-pricing-tiers.md`
```

- [ ] **Step 2: Update the "What landed" bullet about plans**

In the same file, find the bullet that mentions `Starter/Pro/Scale, $25/$60/$150` (in the "What landed" section, first bullet) and replace it with:

```markdown
- `data/sql/009_phone_book.sql` — `plans` (Basic/Pro/Max, $29/$79/$199, with monthly_quote_limit + included_numbers + recording_retention_days columns), `agents.plan_id`, `phone_numbers` table with partial-unique-index `is_primary`, RLS, backfill agents' existing `signalwire_caller_id` into `phone_numbers` as primary.
```

- [ ] **Step 3: No git commit for this file**

Memory files live outside the repo. The previous tasks have already committed all repo changes.

---

## Self-Review

**Spec coverage check (vs. `docs/superpowers/specs/2026-05-18-phonebook-pricing-tiers-design.md`):**

| Spec requirement | Covered by |
|---|---|
| Rename Starter/Pro/Scale → Basic/Pro/Max | Task 1, Steps 4-5 |
| Add `monthly_quote_limit` column to `plans` | Task 1, Step 2 |
| Add `included_numbers` column to `plans` | Task 1, Step 2 |
| Add `recording_retention_days` column to `plans` | Task 1, Step 2 |
| Reseed with new prices/caps | Task 1, Step 4 |
| Update agents-backfill behavior | Task 1, Step 7 (verified unchanged) |
| Upgrade modal shows feature matrix per option | Task 4, Step 1 |
| `pbApplyPlanChange()` writes both caps | Task 5, Step 1 |
| Plan card adds quote bar | Task 2 + Task 3 |
| Plan card adds numbers count line | Task 3, Step 3 |
| Plan card surfaces recording retention | Task 3, Step 3 |
| Buy Number modal: included vs. extra | Task 6, Steps 1-5 |
| `pb-billing-note` reworded | Task 4, Step 3 |
| Memory update | Task 7 |

All spec requirements have a task. No gaps.

**Placeholder scan:** No "TBD", "TODO", "implement later" markers in the plan. Every code block is concrete.

**Type consistency:** Function signatures verified consistent across tasks:
- `pbRenderPlanCard(agent, usedMin, quotesUsed)` — defined in Task 2 Step 4 (callsite), implemented in Task 3 Step 3
- `_pbIncludedRemaining()` — defined in Task 6 Step 1, called in Task 6 Steps 2, 3, 5
- Selector IDs consistent (`pb-plan-q-bar`, `pb-plan-q-used`, etc.) between Task 3 Step 1 (HTML) and Step 3 (JS)
- New plan columns (`monthly_quote_limit`, `included_numbers`, `recording_retention_days`) consistent between Task 1 SQL and Tasks 2-4 JS

Plan is self-consistent.

---

## Manual verification after all tasks

1. Paste revised `data/sql/009_phone_book.sql` into Supabase SQL Editor.
2. Run:
   ```sql
   select slug, name, monthly_minutes, monthly_quote_limit, included_numbers, recording_retention_days, monthly_cost
     from public.plans order by sort_order;
   ```
   Expected: exactly three rows — Basic, Pro, Max — with the values from the seed.
3. Hard-reload the app, sign in, navigate to Phone Book.
4. Plan card: shows current plan name, minutes bar, quotes bar (with "last 30 days" label), numbers line, retention line.
5. Click Upgrade Plan → modal lists three options, each with minutes / quotes / numbers triplet.
6. Select Pro → click Switch plan → toast confirms. SQL check:
   ```sql
   select plan_id, monthly_minute_limit, monthly_quote_limit from public.agents where id = '<your uuid>';
   ```
   Expected: `monthly_minute_limit = 2500`, `monthly_quote_limit = 1000`.
7. Open Buy Number with the test agent on Basic (1 included DID, 0 owned): search result row shows "Included" pill, confirm dialog says "included with your plan".
8. Buy one number → reload → search again: now shows "$1.50/mo" instead of "Included".

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-18-phonebook-pricing-tiers.md`.** Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session with checkpoints

Defaulting to **inline execution** per the no-pausing directive.
