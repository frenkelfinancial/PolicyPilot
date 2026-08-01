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
* The Front Office's landing screen (`OFFICE_HOME.front = 'summary'`) and
  `DEFAULT_OFFICE` did **not** change, and neither did `_applyPlanGating()`.
  `bo-summary` is ungated on purpose: an office's landing screen must always be
  reachable, for the same reason the Agency tab is ungated.
