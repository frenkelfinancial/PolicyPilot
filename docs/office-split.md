# Front Office / Back Office — one product, two apps

**Both rounds are done.** Round 1 split the sidebar; Round 2 built the Back
Office's own dashboard and switched `OFFICE_HOME.back` onto it. The Back Office
Summary has its own doc: `docs/back-office-summary.md`.

Code: `app.html` (`OFFICE_OF`, `OFFICE_HOME`, `DEFAULT_OFFICE`, `setOffice()`).
Tests: `npm run test:office` → `test/office-split.test.mjs`.

---

## The shape of the split

The sidebar used to be one long list serving two different jobs: a producer
selling policies, and an agency owner chasing money. Neither wanted the other's
screens. A segmented toggle under the logo now shows one office at a time.

There is still **one** set of sections. Nothing was duplicated except two nav
items (Agency, deliberately). The split is entirely in the sidebar and in which
screen you land on.

### Front Office — selling

| Group | Item | Section id |
|---|---|---|
| Overview | Summary | `summary` |
| Selling | Leads | `leads` |
| Selling | Quote + Underwriting | `api-quoter` |
| Selling | Calendar | `calendar` |
| Outreach | Web Dialer | `webdialer` |
| Outreach | Phone Book | `phonebook` |
| Outreach | *Voice Campaigns* (injected) | `voice-campaigns` |
| Outreach | *AI Dialer Test* (injected) | `ai-test` |
| Team | Agency | `agency` |

### Back Office — money

| Group | Item | Section id |
|---|---|---|
| Overview | **Summary** | `bo-summary` |
| Book | Policy Tracker | `tracker` |
| Book | Carrier Mail | `carriermail` |
| Money | **Statements** | `backoffice` |
| Money | Bonus Tracker | `bonuses` |
| Team | Agency | `agency` |

### Neither office

Support, Settings and Sign out stay in `.sidebar-bot`, with no `data-office`
and outside both `.nav-office` wrappers. They are always visible.
`ds-playground` (dev-only, `?ds=1`) is also untagged on purpose — it is a dev
tool, not a product screen.

---

## Decisions

| Decision | Answer |
|---|---|
| Agency tab | Appears in **both** offices. Two DOM nodes (`#nav-agency-front`, `#nav-agency-back`), one `#sec-agency`. |
| The old "Back Office" tab label | Renamed to **"Statements"**. The internal id stays `backoffice`. |
| Back Office landing screen | `bo-summary` (the Back Office Summary), since Round 2. It was `tracker` in Round 1, as a placeholder. |
| Which office opens on login | **Front Office**, always, for a fresh login. |
| Settings / Support | Unchanged, always visible, in **neither** office. |
| Where the office is remembered | `sessionStorage`, not `localStorage` — see below. |

### Why `sessionStorage`

"Always Front Office on login" taken literally would also throw an agency owner
who hits **F5** mid-reconciliation back into the selling app. Session storage
dies when the tab closes, so:

* a fresh login or a new tab starts in the Front Office, exactly as decided;
* a refresh in the middle of work leaves you where you were.

One line (`sessionStorage` → `localStorage` in `setOffice()`) reverses this.

---

## The rules that keep it working

### `OFFICE_OF` is the only place membership is declared

`nav()`, `setOffice()`, `_applyPlanGating()`, `restoreSectionFromCache()` and
`bootDashboard()`'s post-auth restore all read it. Nothing hard-codes an
office anywhere else. Adding a screen means adding a line here in the same
commit, or `test/office-split.test.mjs` fails — deliberately, because a nav
item with no office is invisible in **both**.

A test also cross-checks the map against the markup: a section filed under
`front` but rendered inside the Back Office block would flip the toggle on
click and then hide the item you just clicked.

### 🔴 Office hiding is CSS. Plan gating is an inline style. Never mix them.

`_applyPlanGating()` hides Bonus Tracker and Web Dialer with
`el.style.display`. Office visibility is a stylesheet rule:

```css
body[data-office="front"] .nav-office[data-office="back"],
body[data-office="back"]  .nav-item[data-office="front"] { display: none; }
```

They compose correctly **only** because they sit at different levels:

* plan gating sets `display:none` inline → inline wins → hidden regardless of
  office. Correct.
* plan gating clears it (`display:''`) → no inline value → the office rule
  applies. Correct.

Writing `style.display` for office visibility, or converting plan gating to a
class, breaks that. A test asserts `setOffice()` contains no `style.display`.

### 🔴 Nav highlighting uses `querySelectorAll`, because Agency exists twice

`CLAUDE.md` already said *"`nav()` highlights by section name, not by
position."* This round extends it: **by name, and by *all* matches.**
`document.querySelector('.nav-item[onclick*=…]')` returns only the first
match, so clicking Agency from the Back Office would highlight the Front Office
copy and leave the one you clicked dark. Three call sites — `nav()`,
`_applyPlanGating()`'s `navBySection`, `restoreSectionFromCache()` — and a test
per call site with a failure message explaining why.

### The `backoffice` id is not the `Statements` label

`sec-backoffice`, `renderBackOffice()`, `boArea()`, the `bopanel-*` prefixes,
`test/back-office.test.mjs` and every `docs/back-office-*.md` key off the id
`backoffice`. Only the label moved.

### A cross-office deep link flips the office

There are ~20 `nav('…')` call sites, several of them inline `onclick` handlers
inside page copy ("Open Phone Book →", "Settings → Integrations") and a Summary
card that jumps to Policy Tracker. `nav()`'s first three lines flip the office
when the target belongs to the other one, so every one of them keeps working —
and the Summary → Policy Tracker card now visibly moves the toggle.

### Two restore paths, one rule

Both must refuse to restore a section belonging to the office we are *not* in:

* `restoreSectionFromCache()` — pre-paint, reads `pp_last_section`;
* `bootDashboard()`'s post-auth restore — reads `pp_current_section` and calls
  `nav(saved)`, which would otherwise flip the office itself.

Without **both**, a producer who ended yesterday on Policy Tracker logs in
fresh and is dropped straight into the Back Office, which is exactly what
"always Front Office on login" was supposed to prevent.

---

## What a refresh restores (Round 3)

### The two paths do different jobs, and only one of them draws anything

| | `restoreSectionFromCache()` | `bootDashboard()`'s restore block |
|---|---|---|
| When | pre-paint, before auth | after auth and the first sync |
| Key | `pp_last_section` (unscoped) | `pp_current_section` (per agent) |
| Does | swaps the `.active` class, the nav highlight and the page title | calls **`nav(saved)`** |
| Why | no Summary → target flash | `nav()` is the only caller of `renderBackOffice()`, `renderCarrierMail()`, `renderBackOfficeSummary()`, `renderPhoneBook()`, … |

That division is the whole bug this round fixed. The first path made a screen
*appear*; only the second one makes it **draw**. A section the second path
skipped stayed on screen with its static chrome and no data — right tab, right
title, empty body — until the agent clicked away and back.

### The membership test is derived, never hand-listed

```js
function _isRestorableSection(id) {
  if (!id || !OFFICE_OF[id]) return false;
  return document.querySelectorAll('.nav-item[onclick*="nav(\'' + id + '\')"]').length > 0;
}
```

A section is restorable when it **declares an office** and **something in the
sidebar navigates to it**. Add a screen, and this is true for free.

It replaced `const valid = {…}` in `bootDashboard()` — the third hand-written
copy of the sidebar this app has carried, after the positional `idxMap` in
`nav()` and the map `restoreSectionFromCache()` used to hold. Like both of
those, it drifted: Carrier Mail, Statements, Voice Campaigns and AI Dialer Test
were all missing, and Round 2 had to remember to hand-add `bo-summary`.

**It answers "does this screen exist", not "may this agent see it."** The plan
gate (`_gated`) and the office guard sit on top and are still required. The
derived predicate is deliberately *more* permissive than the list it replaced;
those two are what stops that mattering. Tests pin all three.

Both readers use it — the cached-section restore and the `?tab=` URL parameter.
`?tab=phonebook` (sent by `wallet-low-balance-notify`) is unchanged;
`?tab=backoffice`, `?tab=carriermail` and `?tab=bo-summary` now resolve too.

### Voice Campaigns and AI Dialer Test take a different path, on purpose

At restore time neither nav item exists — `aiTestInit()` injects them, `async`,
*after* the restore block runs. So `_isRestorableSection()` correctly returns
`false` for both, and **they must not be named in the boot restore**:
`#sec-voice-campaigns` and `#sec-ai-test` are in the markup whether or not the
two kill switches allow them, so a hand-added entry there would show an AI
screen to an agent entitled to neither.

Instead the intent is carried:

1. Boot sets `_pendingLateRestore = saved` when the saved id is one of the two,
   and navigates nowhere.
2. **`nav()` clears it on any call**, above every early return. Any navigation
   — boot's own, an explicit `?tab=`, or the agent clicking something in the
   second before injection lands — makes the restore stale.
3. At the end of the injection block in `aiTestInit()`, below
   `if (!(agentOn && globalOn)) return;` and after `setOffice(…)` has
   re-applied office visibility, the flag is read, spent, and honoured if the
   section is now reachable and in the current office.

**The gate is the injection, not a list.** An agent whose switches are off
returns at the kill switch and never reaches step 3, so the flag just expires.

The cost, accepted: because `aiTestInit()` is `async`, an agent refreshing on
Voice Campaigns sees the Front Office Summary for a beat before it jumps. That
is the honest price of not showing AI screens to people who are not entitled to
them. Do not "fix" it by moving the injection earlier or pre-rendering the
section.

`?tab=voice-campaigns` and `?tab=ai-test` still do nothing — the flag is set
from the saved section only, and no email or link produces those values.

---

## What Round 2 changed

Done — see `docs/back-office-summary.md` and
`docs/reports/PROMPT_FO2-report.md`.

* `OFFICE_HOME.back` — `'tracker'` became `'bo-summary'`.
* `OFFICE_OF['bo-summary'] = 'back'`, `NAV_TITLES['bo-summary'] = 'Summary'`,
  and a nav item at the top of the Back Office wrapper in an **Overview**
  group — the same word and the same `gauge` icon as the Front Office's
  Summary, which is fine because you can only be in one office at a time.
* `bootDashboard()`'s restore allow-list gained `'bo-summary':1`, or F5 on the
  Back Office's own landing screen would have dropped the agent elsewhere.
  (Round 3 deleted that list — having to *remember* an entry is exactly how it
  ended up four screens behind the sidebar. See above.)
* The Front Office's landing screen (`OFFICE_HOME.front = 'summary'`) and
  `DEFAULT_OFFICE` did **not** change, and neither did `_applyPlanGating()`.
  `bo-summary` is ungated on purpose: an office's landing screen must always be
  reachable, for the same reason the Agency tab is ungated.
