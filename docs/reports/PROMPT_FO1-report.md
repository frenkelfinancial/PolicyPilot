# PROMPT FO1 — One product, two offices

**Round 1 of 2.** Built, tested and pushed. Round 2
(`prompts/PROMPT_FO2_back_office_summary_CLAUDE_CODE.md`) builds the Back
Office's own dashboard and is the only thing that should change
`OFFICE_HOME.back`.

Docs written this round: `docs/office-split.md`, plus a
`## Front Office / Back Office` section at the top of `CLAUDE.md`.

---

## Tripwires

| # | Check | Result |
|---|---|---|
| 1 | `git status` on `main`, no uncommitted tracked changes | ✅ clean, only untracked `prompts/`. `git pull` → already up to date |
| 2 | `grep -c 'data-office' app.html` / `grep -c 'OFFICE_OF' app.html` | ✅ `0` and `0` — not previously built |
| 3 | `grep -c 'function nav(id)' app.html` | ✅ exactly `1` |
| 4 | `ls docs/reports/` | ✅ exists (4 prior reports) |
| 5 | `node --version`, `ls node_modules/eslint` | ✅ v24.16.0, ESLint present |

---

## Step 0 — inventory

### Static sidebar nav, BEFORE

All seven groups were one flat list between `.logo-wrap` and `.sidebar-bot`.

| Group (`.nav-lbl`) | Label | `nav()` target |
|---|---|---|
| Overview | Summary | `summary` |
| Quoter | Quote + Underwriting | `api-quoter` |
| Business | Policy Tracker | `tracker` |
| Business | Carrier Mail | `carriermail` |
| Business | Bonus Tracker | `bonuses` |
| Business | **Back Office** | `backoffice` |
| Leads | Leads | `leads` |
| Integrations | Calendar | `calendar` |
| Integrations | Phone Book | `phonebook` |
| Integrations | Web Dialer | `webdialer` |
| Integrations | Agency | `agency` |
| *(`.sidebar-bot`)* | Support | *(modal, not a nav)* |
| *(`.sidebar-bot`)* | Settings | `settings` |
| *(`.sidebar-bot`)* | Sign out | *(`authSignOut()`)* |

### Static sidebar nav, AFTER

| Office | Group | Label | Target | New id |
|---|---|---|---|---|
| front | Overview | Summary | `summary` | — |
| front | Selling | Leads | `leads` | — |
| front | Selling | Quote + Underwriting | `api-quoter` | — |
| front | Selling | Calendar | `calendar` | — |
| front | Outreach | Web Dialer | `webdialer` | — |
| front | Outreach | Phone Book | `phonebook` | — |
| front | Team | Agency | `agency` | `nav-agency-front` |
| back | Book | Policy Tracker | `tracker` | — |
| back | Book | Carrier Mail | `carriermail` | — |
| back | Money | **Statements** *(was "Back Office")* | `backoffice` | — |
| back | Money | Bonus Tracker | `bonuses` | — |
| back | Team | Agency | `agency` | `nav-agency-back` |
| *neither* | `.sidebar-bot` | Support, Settings, Sign out | — | — |

The Outreach group carries `id="nav-group-outreach"` — that is the injection
target in step 10.

### Dynamically injected nav items

Confirmed the count: `grep -n "className = 'nav-item'"` returned **three**
sites, exactly as the prompt said.

| Item | Injected by | Insertion point BEFORE | Insertion point AFTER |
|---|---|---|---|
| `ds-playground` | `dsInitPlayground()` (gated on `?ds=1`) | after the Settings nav item | **unchanged** — still after Settings, still **no** `data-office` |
| `ai-test` | `aiTestInit()` (gated on `agentOn && globalOn`) | after the Settings nav item | appended to `#nav-group-outreach`, `dataset.office = 'front'` |
| `voice-campaigns` | `aiTestInit()`, same block, same gate | after the `ai-test` item | appended to `#nav-group-outreach`, `dataset.office = 'front'` |

`mountIcons()` is still called on the parent after injection (now
`mountIcons(outreachGroup)`), and `setOffice(document.body.dataset.office,
{silent:true})` runs immediately after so an item injected while the agent is
sitting in the Back Office is hidden the instant it appears.

### Every `nav('…')` call site, and how it behaves now

Comment-only mentions (three: the Web Dialer header comment, `renderPhoneBook`'s
entry-point comment, `renderAgencySection`'s comment) are excluded. Sidebar
markup is in the tables above.

| Line | Where | Target | Office | Behaviour after the change |
|---|---|---|---|---|
| 5118 | AI Dialer Test panel — "Record consent →" | `leads` | front→front | unchanged |
| 6173 | Calendar — "Settings → Integrations" | `settings` | front→both | unchanged; Settings is in neither office |
| 8319 | Integrations modal — "Settings → Integrations" | `settings` | any→both | unchanged |
| **12612** | **Summary chargeback card `click` → Policy Tracker** | `tracker` | **front→back** | **flips the toggle to Back Office, then lands on Policy Tracker.** This is the headline cross-office case |
| 13325 | `ds-playground` injected nav item | `ds-playground` | both | unchanged; dev tool, no office |
| 17227 | `teamOpenAgent(…, 'summary')` → Agency | `agency` | any→both | unchanged; Agency is `both`, and **both** its nav items highlight |
| 20969 | Web Dialer, insufficient balance → Phone Book | `phonebook` | front→front | unchanged |
| 23433 | Power Dialer, insufficient balance → Phone Book | `phonebook` | front→front | unchanged |
| 23942 | Underwriting — "Settings → Carriers" | `settings` | front→both | unchanged |
| 30475 | `ai-test` injected nav item | `ai-test` | front→front | unchanged |
| 30492 | `voice-campaigns` injected nav item | `voice-campaigns` | front→front | unchanged |
| 33425 | `vcampOpenLead()` → Leads | `leads` | front→front | unchanged |
| 34357 | `openTextingSettings()` → Settings | `settings` | any→both | unchanged |
| 35101 | `lowBalanceTopUpNow()` → Phone Book | `phonebook` | any→front | **flips to Front Office if fired from the Back Office.** The low-balance modal is global, so this is reachable from Statements |
| 38379 | SMS registration — "Buy one in Phone Book" | `phonebook` | any→front | flips to Front Office if reached from the Back Office |
| 38593 | A2P registration submitted → Summary | `summary` | any→front | flips to Front Office |
| 39593 | SMS thread — "Open Phone Book →" | `phonebook` | any→front | flips to Front Office |
| — | `setOffice()` → `nav(OFFICE_HOME[office])` | dynamic | — | new; fires only when the current section belongs to the office you just left |
| — | `bootDashboard()` → `nav(saved)` / `nav(tabParam)` | dynamic | — | `saved` now guarded (see below); an explicit `?tab=` still wins and flips the office |

**Nothing broke, and one thing improved:** the Summary → Policy Tracker card
now visibly moves the toggle instead of landing on a screen whose nav item is
hidden.

### The three `onclick`-text resolvers

All three used singular `querySelector`. All three are now `querySelectorAll`,
each with a comment pointing at the existing `CLAUDE.md` rule and extending it
(*by name, and by **all** matches, because a section may appear in both
offices*).

| Function | Before | After |
|---|---|---|
| `nav()` | `const navItem = document.querySelector(…); if (navItem) navItem.classList.add('active')` | `document.querySelectorAll(…).forEach(n => n.classList.add('active'))` |
| `_applyPlanGating()` | `navBySection = name => document.querySelector(…)`, used in the hide loop and the Summary redirect | returns the NodeList; both callers `.forEach(…)` |
| `restoreSectionFromCache()` | `const navItem = …`; `if (!navItem …) return`; `navItem.classList.add('active')` | `const navItems = querySelectorAll(…)`; `if (!navItems.length …) return`; `navItems.forEach(…)` |

---

## What was built

Steps 1–11 are all complete. Nothing was deferred.

1. **`OFFICE_OF` / `OFFICE_HOME` / `DEFAULT_OFFICE`** — added verbatim
   immediately above `const NAV_TITLES = {`, with the prompt's comment block.
2. **Sidebar regrouped** into two `.nav-office` wrappers. Every `.nav-item`
   inside one carries a `data-office` matching its wrapper. Every
   `<span class="ico" data-ico="…">` and `<span class="nav-lbl-text">` is
   preserved unchanged.
3. **CSS** — the four-selector hiding rule, plus an explicit comment at *both*
   ends (the CSS block and `_applyPlanGating()`) recording that office
   visibility is a CSS rule and plan gating is an inline style, and why mixing
   them is the bug.
4. **The toggle** — inserted directly after `.logo-wrap`. Both icon keys were
   verified present in `ICONS` before use: `megaphone` (line 10331) and
   `currency-dollar` (line 10279). Neither had to be added, and no icon was
   substituted.
5. **`setOffice()`** — added immediately above `nav()`, as specified.
6. **`nav()` office flip** — the first three lines of the function, above the
   plan gate.
7. **`querySelectorAll` at all three sites** — see the table above.
8. **Boot order** — `setOffice(sessionStorage 'pp_office' || DEFAULT_OFFICE,
   {silent:true})` before `restoreSectionFromCache()`, storage read wrapped in
   try/catch. Plus the one new rule inside `restoreSectionFromCache()`.
9. **Label → "Statements"** — see the triage table below.
10. **Injections moved** — see the table above.
11. **Docs** — `CLAUDE.md` section + `docs/office-split.md`.

### One change beyond the prompt's literal text, and why

The prompt's step 8 named `restoreSectionFromCache()` as the place to guard the
restore. There is a **second** restore path it did not name:
`bootDashboard()`'s post-auth block reads the per-agent `pp_current_section`
key and calls `nav(saved)`. Because step 6 makes `nav()` flip the office for
any caller, that path would have dragged a fresh login straight into the Back
Office — a producer who ended yesterday on Policy Tracker logs in and lands in
the money app, which is exactly what the locked "Front Office, always, for a
fresh login" decision forbids.

The same rule is therefore applied in both places. It is four lines
(`_savedOffice` / `_otherOffice`) added to the existing `_gated` condition, and
it is commented as the second half of one rule. Without it the locked decision
does not actually hold.

I also added the office flip to `_applyPlanGating()`'s
Basic-user-redirect-to-Summary path, since `bonuses` is a Back Office section
and `summary` is a Front Office one — that redirect can cross offices.

### `sessionStorage` — kept, not changed

I agree with the prompt's reasoning and left it as `sessionStorage`. Fresh
login and new tab open in the Front Office; F5 mid-reconciliation stays put.

---

## The "Back Office" string triage

`grep -n "Back Office" app.html` → 22 hits before the change. Triage:

| Line(s) | Text | Verdict |
|---|---|---|
| 4863 *(old)* | sidebar nav label `Back Office` | **→ "Statements"** — names the tab |
| 28933 *(old)* | `backoffice:'Back Office'` in `NAV_TITLES` | **→ `backoffice:'Statements'`** — key unchanged, comment added |
| 5653 *(old)* | in-page heading above `id="bo-subtitle"` | **→ "Statements"** — names the tab. Subtitle copy left alone |
| 28609 *(old)* | `showToast('Back Office refreshed')` | **→ 'Statements refreshed'** — user-visible, names the tab |
| 34021 *(old)* | "…the same pipeline as dropping the file into Back Office." | **→ "…into Statements."** — user-visible, names the tab |
| 3712 | CSS comment: "Back Office — commission statement ingestion" | kept — describes the area |
| 5659 | HTML comment: "Back Office areas…" | kept — describes the area |
| 6736, 7843, 8048 | HTML comments naming Back Office Phase 1b / Phase 7 | kept — phase provenance |
| 12747, 14340, 14799, 16754, 26000, 26690, 26946, 27188, 27420, 27563, 27607, 27956, 28137, 28468, 33975 | JS comments: "(Back Office Phase N)", "Back Office areas" | kept — all describe the *area* and the build phases, none names the tab |

Post-change: **zero** user-visible strings read "Back Office" except the office
toggle button itself, which is supposed to.

### Marketing pages — reported, unchanged

```
grep -rn "Back Office" index.html index-redesign.html features.html \
    pricing.html how-it-works.html support.html power-dialer.html
```

| File | Exists | `Back Office` hits | Case-insensitive `back.office` hits |
|---|---|---|---|
| `index.html` | yes | 0 | 0 |
| `index-redesign.html` | yes | 0 | 0 |
| `features.html` | yes | 0 | 0 |
| `pricing.html` | yes | 0 | 0 |
| `how-it-works.html` | yes | 0 | 0 |
| `support.html` | yes | 0 | 0 |
| `power-dialer.html` | yes | 0 | 0 |

**There is nothing to decide.** No marketing page mentions the Back Office in
any casing. None was modified, and none appears in the diff.

---

## The AI dialer kill switch — before / after

**Before** (`aiTestInit()`):

```js
    agentOn  = !!(aRes.data && aRes.data.ai_dialer_enabled);
    globalOn = !!(bRes.data && bRes.data.ai_dialer_enabled);
  } catch (_) { return; }
  if (!(agentOn && globalOn)) return; // strict AND gate — everyone else sees nothing
```

**After:** byte-identical. The proof is that these lines **do not appear in the
diff at all**:

```
$ git diff app.html | grep -E "^[+-].*(agentOn|globalOn|ai_dialer_enabled)"
(none — condition untouched)
```

Only the lines *after* the gate changed — where the item is injected, not
whether it is. `test/office-split.test.mjs` also asserts
`if (!(agentOn && globalOn)) return;` is still present.

---

## Verification

| Check | Result |
|---|---|
| `npm run test:office` | ✅ **21/21 pass** |
| `npm test` (full suite) | ✅ **exit 0 — 1,737 passing, 0 failing** |
| `npm run check` | ✅ `0 new error(s), 0 new warning(s), 12 known (baselined)` |
| `scripts/check-app.baseline.json` | ✅ **not touched**; `check:update-baseline` never run |
| Sidebar markup balance | ✅ 35 `<div>` / 35 `</div>`, 3 `<button>` / 3 `</button>` (comments stripped) |
| `supabase/` in the diff | ✅ 0 files |
| Marketing HTML in the diff | ✅ 0 files |
| Stripe / checkout / wallet / price / `plan_id` lines changed | ✅ **0** changed lines match any of those, case-insensitive |

### Two existing assertions were updated — which, and why

`npm test` initially failed **two** assertions in `test/back-office.test.mjs`.
Both pinned the exact string this round deliberately changed, so the assertion
was genuinely now wrong. Neither test's *intent* changed:

1. **`the nav highlight is by section name, not by position`** pinned
   `const navItem = document.querySelector('.nav-item[onclick*="nav(`. The rule
   it protects ("by name, never by position") is unchanged and the
   anti-`idxMap` assertion beside it is untouched — only the arity moved, to
   `querySelectorAll`, because Agency is now rendered twice. Updated to match
   the plural form, with a comment saying so and pointing at
   `test/office-split.test.mjs`.

2. **`Back Office is reachable: nav item, title and section all exist and
   agree`** pinned `backoffice:'Back Office'`. The half this file actually
   cares about is the **key**, which is unchanged. Updated to
   `backoffice:'Statements'` with a comment recording that the id is the
   load-bearing part.

That makes `test/back-office.test.mjs` a fifth changed file, one the prompt's
`git diff --stat` allowlist did not name. It is changed under the prompt's own
verification instruction ("*fix the code, do not edit the assertion unless the
assertion is genuinely now wrong, and say which and why*").

### Level of visual proof actually achieved — read this plainly

**No rendering was verified. I did not look at this in a browser, and I could
not.** There is no headless DOM in this repo — no `jsdom`, `puppeteer`,
`playwright`, `happy-dom` or `linkedom` in `node_modules`, and
`scripts/preview-server.mjs` is a zero-dependency static file server that opens
a real browser for a human to look at. Running it proves nothing on its own.

What I *did* verify, and it is all static:

* **String / structure inspection** of the shipped `app.html` — this is what
  every assertion in `test/office-split.test.mjs` is.
* **Markup balance** of the sidebar slice (`<div>`/`</div>` and
  `<button>`/`</button>` counts match with comments stripped), so the two
  wrappers are well-formed and the CSS descendant selectors will match.
* **Map ↔ markup agreement** — a test walks each wrapper and asserts every
  `nav('X')` inside it is filed under that office (or `both`) in `OFFICE_OF`,
  and that every `'both'` section is rendered in both wrappers or neither.
  This is the closest thing to a behavioural check available without a DOM.
* **`npm run check`** parses the whole inline script with `node --check` and
  lints it for `no-undef`, which is what catches a `setOffice` or `OFFICE_OF`
  referenced from the wrong scope.

The CSS itself — how the pill looks expanded, how the stacked rail squares
look, whether the drawer override wins — is **unproven**. It is in the pending
list below.

---

## Plain-English summary

The app used to have one sidebar with eleven tabs in it, serving two people who
want completely different things. A producer selling policies had to scroll
past commission statements and persistency reports. An agency owner reconciling
carrier money had to scroll past the dialer and the quoter.

There is now a small two-button switch at the top of the sidebar, under the
logo: **Front Office** and **Back Office**. You see one office's tabs at a
time.

**What a producer sees.** Front Office: Summary, Leads, Quote + Underwriting,
Calendar, Web Dialer, Phone Book, Agency — plus Voice Campaigns and the AI
Dialer Test if their account has the AI dialer switched on. Seven tabs instead
of eleven, and every one of them is about selling.

**What an agency owner sees.** They click Back Office and get five: Policy
Tracker, Carrier Mail, Statements, Bonus Tracker, Agency. The tab that used to
be called "Back Office" is now called **Statements**, because the whole
right-hand half of the product is the Back Office now and having a tab with the
same name inside it would be confusing. It still does exactly what it did —
same uploader, same screen, nothing about it changed but the word on the
button.

**Agency is in both**, because a producer needs it to accept a team invitation
and an owner needs it to run the team. It is the same screen, just reachable
from both sides. **Settings, Support and Sign out** sit at the bottom and are
always there, in neither office.

**On login:** always the Front Office, on Summary. That is deliberate — most
people signing in are here to sell.

**On refresh:** you stay exactly where you were, including which office. An
owner three files into a reconciliation who hits F5 does not get thrown back
into the selling app. (The way this works: the "which office" memory is tied to
the browser tab, so it survives a refresh and dies when the tab closes.)

**On a link that crosses offices:** the app moves the switch for you. The
clearest example is the chargeback card on the Summary screen — click it and it
takes you to the Policy Tracker, which lives in the Back Office. You will see
the toggle slide over to Back Office as the page changes. Every link like this
in the app works this way; none of them dead-ends.

---

## Numbered eyeball checklist for Jace

Minutes, not hours. No phone needed for steps 1–10.

1. Open the app. **Confirm it lands in the Front Office**, on Summary, with the
   Front Office button filled in.
2. Count the tabs. **Confirm exactly seven** — Summary, Leads, Quote +
   Underwriting, Calendar, Web Dialer, Phone Book, Agency — and nothing else.
   (Plus Voice Campaigns / AI Dialer Test under Outreach if your account has
   both AI switches on. Yours does.)
3. Move the mouse off the sidebar so it collapses to the narrow rail.
   **Confirm the toggle becomes two stacked icon squares**, both still visible,
   with the Front Office one highlighted. Hover back — **confirm it becomes a
   horizontal pill with both labels**.
4. Click **Back Office**. Confirm you land on **Policy Tracker**.
5. Count the tabs. **Confirm exactly five** — Policy Tracker, Carrier Mail,
   Statements, Bonus Tracker, Agency.
6. Click **Statements**. Confirm the page heading reads "Statements", the
   subtitle is the same sentence as before, and **the file uploader still
   works** — drag a statement in, or at least confirm the Ingest area and the
   five area tabs (Ingest / Commissions / Persistency / Reconciliation /
   Carriers) render.
7. Click **Agency** from the Back Office. **Confirm the Back Office copy of the
   Agency item highlights** — not a hidden one, and the page renders normally.
   Flip to Front Office, click Agency there, confirm the Front copy highlights.
8. Go to **Summary** (Front Office) and click the **chargeback / at-risk card**.
   **Confirm the toggle flips itself to Back Office** and you land on Policy
   Tracker.
9. While sitting in the Back Office on Statements, press **F5**. **Confirm you
   stay in the Back Office, on Statements** — not thrown back to Summary.
10. **Sign out and sign back in. Confirm you land in the Front Office**, on
    Summary, even though you were last in the Back Office. (Same test in a
    brand-new browser tab.)
11. Open it on a phone. Tap the hamburger. **Confirm the toggle is a
    full-width horizontal pill with both labels showing** under the logo — not
    two stacked squares — and that tapping either one switches the list.

If step 3 or step 11 looks wrong, it is CSS only — the navigation itself is
covered by tests.

---

## PENDING LIVE VERIFICATION

Everything below is built and unit-tested as source text, but **not** proven by
a human or a browser. I could not do any of it from here.

1. **The whole visual appearance of the toggle**, in all three states —
   expanded pill, collapsed rail (stacked 40px icon squares), and mobile
   drawer. No DOM was rendered. Specifically unproven: that the rail rule
   (`.sidebar:not(:hover) .office-toggle`) does not leak into the drawer. I
   scoped it with `:not(:hover)` exactly like the existing `.nav-item` rail
   rules and added an explicit `.sidebar.mob-open .office-toggle` override with
   `!important`, matching the pattern the existing mobile block already uses
   for `.nav-lbl-text` — but that is reasoning, not a screenshot.
2. **The mobile drawer on a real device.** Touch never triggers `:hover`, which
   is exactly why the override exists; it needs one look on a real phone.
3. **Voice Campaigns and AI Dialer Test appearing inside the Outreach group**
   for an agent with both AI kill switches on. I cannot flip those switches
   (SQL-only, by design) and did not try. The injection target, the
   `dataset.office = 'front'` tagging and the unchanged `agentOn && globalOn`
   gate are all asserted as source text; that they *land in the right visual
   position* is not.
4. **The Basic-plan view**, where `_applyPlanGating()` hides Bonus Tracker and
   Web Dialer. The composition rule (inline `none` beats the office CSS rule;
   inline `''` yields to it) is standard CSS cascade and is asserted
   one-directionally by a test, but no Basic account was rendered. Worth one
   check that a Basic user sees four Back Office tabs (no Bonus Tracker) and
   six Front Office tabs (no Web Dialer).
5. **`ds-playground`** — needs `?ds=1`. Untouched this round, but it now sits
   next to Settings while everything else moved, so it is worth confirming it
   still appears and still shows in both offices.
6. **Safari private mode**, where `sessionStorage` access throws. The read is
   wrapped in try/catch and falls back to `DEFAULT_OFFICE`, so the expected
   behaviour is "always opens in the Front Office, never remembers" — not a
   crash. Unverified.
7. **The `?tab=` deep link** (from the low-balance email's "Add funds" link).
   It still wins over the cached section and `nav()` will flip the office for
   it; the specific `?tab=phonebook` path was not exercised.

---

## Commit

Files changed: `app.html`, `package.json`, `test/office-split.test.mjs` (new),
`test/back-office.test.mjs`, `CLAUDE.md`, `docs/office-split.md`,
`docs/reports/PROMPT_FO1-report.md`.

Commit SHA and push confirmation are appended below.
