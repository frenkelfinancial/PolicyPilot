# PROMPT FO3 — a refresh puts you back on the screen you left, drawn

Round 3 of the office split. One bug class: `bootDashboard()` decided what a
refresh may restore into by consulting a **hand-written list of section names**,
and that list had drifted four screens behind the sidebar.

It is gone. The membership test is now derived from the sidebar itself.

- Code: `app.html` (four edits)
- Tests: `test/office-split.test.mjs` (+10 tests), `test/bo-summary.test.mjs`
  (1 test rewritten — it pinned the list this round deleted)
- Docs: `CLAUDE.md`, `docs/office-split.md`
- **No schema, no edge function, no migration.** `git status --porcelain
  supabase/` → empty (pasted below).

---

## Tripwires

| # | Check | Result |
|---|---|---|
| 1 | `git status` clean on `main`, `git pull` | clean (`?? prompts/` only); `Already up to date.` |
| 2 | `grep -c 'const valid = {' app.html` | **1** — the round had not been done |
| 3 | `docs/reports/PROMPT_FO1-report.md`, `PROMPT_FO2-report.md` | both present (24,757 / 22,464 bytes) |
| 4 | `npm test` before starting | **green**, exit 0 |

---

## Step 0 — what I found before changing anything

### 1. The two restore paths, and which one draws

| | `restoreSectionFromCache()` | `bootDashboard()`'s restore block |
|---|---|---|
| Where | [app.html:42088](app.html#L42088), called from [app.html:42355](app.html#L42355) | [app.html:42044-42068](app.html#L42044-L42068) |
| When | `DOMContentLoaded`, **before auth**, before first paint | after auth and the first remote sync |
| Key | `pp_last_section` — unscoped (agent unknown pre-auth) | `k('pp_current_section')` — per agent |
| Does | removes/adds `.active` on `.section`, highlights all matching nav items, sets `#pgTitle` | **calls `nav(saved)`** |
| Calls `nav()`? | **No** | **Yes** |

**`nav()` is the only caller of every screen's renderer.** Confirmed by grep:
`renderCarrierMail()` and `renderBackOffice()` appear at
[app.html:34283-34284](app.html#L34283-L34284) inside `nav()`, and nowhere else
except inside Carrier Mail's own event handlers (four re-render call sites at
`app.html:26100/26109/26118/26179`, all reached by a click). Nothing else on the
boot path invokes either.

So path 1 makes a screen **appear**; only path 2 makes it **draw**.

### 2. Every reader of `valid` — confirmed, exactly two

Both inside the same `try` block, four lines apart:

- `if (saved && valid[saved] && …) nav(saved)` — the cached-section restore
- `if (tabParam && valid[tabParam]) nav(tabParam)` — the `?tab=` URL parameter

No other reference to `valid` exists in `app.html` (the only other matches are
unrelated locals `validProducts` / `validKeys` in the quoter).

### 3. Every producer of a `?tab=` link — confirmed, exactly one

Swept the whole repo (excluding `archive/`, `node_modules/`) across
`*.js|mjs|ts|html|md|json|yml|sql`:

```
supabase/functions/wallet-low-balance-notify/index.ts:162
  const topUpUrl = `${appUrl}/app.html?tab=phonebook`;
```

That is the only one. The other hits are: this prompt, the FO1 report, and the
`?tab=` comment inside the four build-output copies of `app.html`
(`www/`, `android/…/assets/public/`, `ios/…/public/`) — build outputs, not
sources, and none of them *produces* a link.

`?tab=phonebook` still resolves — executed, see the verification table.

### 4. `aiTestInit()` — where and how

Declared `async` at [app.html:31141](app.html#L31141); called at
[app.html:42071](app.html#L42071), **after** the restore block, and **not
awaited**. It performs two `sb` round-trips before its
`if (!(agentOn && globalOn)) return;` kill switch, then injects
`#nav-ai-test` and `#nav-voice-campaigns` into `#nav-group-outreach`.

Both facts matter: at restore time neither nav item exists, and the injection is
a network round-trip away.

### 5. 🔴 The prompt's "blank screen" reading — **mostly right, imprecise in two
places.** Correcting it, as asked

**Right:** the agent does land on the right screen with the right tab
highlighted and the right title, and the renderer never runs. That is the bug,
and it is worse than "dropped on Summary" because nothing looks wrong.

**Imprecise #1 — it is not literally blank.** Both sections carry static markup
that the pre-auth path reveals along with everything else:

- `#sec-backoffice` shows the "Statements" heading, the subtitle, the Refresh
  button, all five area tabs (Ingest / Commissions / Persistency /
  Reconciliation / Carriers) and the file drop zone. What is empty is
  `#bo-pipeline`, `#bo-body`, and `#bo-headline` — which reads `—`.
- `#sec-carriermail` shows its description line and the "Sync & parse" button.
  `#cm-body` is empty.

So: **the page frame draws and the data does not.** A Back Office with real
statements in it shows an upload prompt and an em-dash. Arguably worse than
blank, because it looks like an empty account rather than a failed load.

**Imprecise #2 — it only happens on a same-tab refresh, and only for two of the
four screens.**

- `restoreSectionFromCache()` refuses to restore a section belonging to the
  other office, and the office comes from **`sessionStorage`**. A fresh login or
  a new tab has no `pp_office`, so it defaults to `front`, so a saved
  `backoffice`/`carriermail` is refused there too and the agent correctly lands
  on the Front Office Summary. The stranded-blank state needs `pp_office` to
  still say `back` — i.e. **F5 in the same tab**, which is exactly the
  mid-reconciliation case `sessionStorage` was chosen for.
- **Voice Campaigns and AI Dialer Test genuinely were "dropped on Summary."**
  `restoreSectionFromCache()` returns early for them (`!navItems.length` — the
  items do not exist yet), so nothing ever made those sections visible. The
  prompt's headline applies to Carrier Mail and Statements only.

---

## What changed

### 1. The derived predicate replaces the hand-written list

`const valid = {…}` is deleted. In its place, beside `OFFICE_OF` /
`OFFICE_HOME` / `DEFAULT_OFFICE`:

```js
function _isRestorableSection(id) {
  if (!id || !OFFICE_OF[id]) return false;
  return document.querySelectorAll('.nav-item[onclick*="nav(\'' + id + '\')"]').length > 0;
}
```

Both call sites now use it. **`_gated`, the `_otherOffice` office guard,
`saved !== 'summary'` and the `?tab=`-wins ordering are all byte-identical** —
only the membership test changed.

The same `querySelectorAll` selector `nav()`, `_applyPlanGating()` and
`restoreSectionFromCache()` already use, so the "by name, and by ALL matches"
rule extends to it for free.

### 2. What the derived predicate allows that the list did not

Executed against the shipped sidebar:

```
now allowed : summary, leads, api-quoter, calendar, webdialer, phonebook,
              agency, bo-summary, tracker, carriermail, backoffice, bonuses, settings
GAINED      : carriermail, backoffice
LOST        : (none)
```

Two gains, nothing lost. The other two names the old list was missing —
`voice-campaigns`, `ai-test` — are correctly still `false` here, because they
have no static nav item; they are handled separately (§3).

**New `?tab=` values, stated out loud so they are a known fact rather than a
surprise:** `?tab=backoffice` and `?tab=carriermail` now resolve, as does
`?tab=bo-summary`. Nothing in the repo produces those links, but anyone typing
one gets the screen. This is a small capability gain, not a regression — the
plan gate and office guard sit above it exactly as before, and `nav()` already
flips the office for a cross-office deep link. `?tab=voice-campaigns` and
`?tab=ai-test` still do nothing.

### 3. The two AI screens — the kill-switch-safe path

Not special-cased into the boot restore. `#sec-voice-campaigns` and
`#sec-ai-test` exist in the markup whether or not the switches allow them, so a
name in that list would show an AI screen to an agent entitled to neither.

Three pieces:

1. **Boot remembers, and navigates nowhere.** One line, before the two `nav()`
   calls:
   `if (saved === 'voice-campaigns' || saved === 'ai-test') _pendingLateRestore = saved;`
2. **`nav()` clears it on any call**, as the *first statement in the function*,
   above the office flip and above the plan gate's early `return`. Any
   navigation — boot's own restore, an explicit `?tab=`, or the agent clicking
   something while injection is in flight — makes the late restore stale.
3. **`aiTestInit()` spends it**, at the end of the injection block: after
   `outreachGroup.appendChild(v)`, after `mountIcons()`, and after
   `setOffice(…, {silent:true})` has re-applied office visibility. Read into a
   local and cleared unconditionally, so it is spent whether or not it fires.

#### The kill-switch proof

The flag is read at [app.html:31211](app.html#L31211). Two independent gates sit
above it, and both are in the same function:

| Guard | Line | Effect |
|---|---|---|
| `if (!(agentOn && globalOn)) return;` | 31153 | the function returns 58 lines before the read |
| `if (outreachGroup && !document.getElementById('nav-ai-test')) {` | 31164 | the read is inside this block; no Outreach group, no read |

A test asserts `init.indexOf('_pendingLateRestore') > init.indexOf('if (!(agentOn && globalOn)) return;')`
and that the read is inside the brace-balanced injection block.

Belt and braces, there is a **third**, independent barrier: the late restore
calls `_isRestorableSection(_late)`, which needs a nav item. If the switches are
off, no item was injected, so even forcing the block to run navigates nowhere.
Executed both ways — see `saved=voice-campaigns, switches OFF` in the table.

And a source-level assertion pins that no fourth mention can appear: every
occurrence of `_pendingLateRestore` in `app.html` is `deepEqual`'d against the
exact five expected lines. A new one fails the test.

#### The accepted cosmetic cost

`aiTestInit()` is `async` and does two Supabase round-trips before the kill
switch. So **an agent refreshing on Voice Campaigns sees the Front Office
Summary for a beat before the screen jumps.** That is the honest price of not
showing AI screens to people who are not entitled to them. Not fixed by moving
the injection earlier or pre-rendering the section — both of those put the
screen on the page before the switches have been read.

One consequence worth recording: if `bootDashboard()` ever runs a **second**
time in a session (after `aiTestInit()` has already injected), the derived
predicate would return `true` for these two and the boot block would restore
them directly. That is safe — the items only exist because both switches were
on — but it is a property of the injection, not of the boot block, which is the
whole design.

### 4. Docs

- **`CLAUDE.md`** — the "by name, never by position" bullet grew three
  siblings: the general rule (**no hand-written duplicate of the nav list may
  exist anywhere**, naming all three copies now killed — the positional
  `idxMap`, `restoreSectionFromCache()`'s old map, and `valid`), the
  appear-vs-draw distinction, and the AI-screen late-restore rule. The Round 2
  bullet claiming `valid` still exists with four names missing is corrected.
- **`docs/office-split.md`** — new "What a refresh restores (Round 3)" section:
  the two-path table, the derived predicate and why it is not "may this agent
  see it", and why the two AI screens take a different path.

---

## Verification

Everything in this section is **executed code** unless the row says otherwise.

### Suites

| Command | Result |
|---|---|
| `npm run test:office` | **32 pass, 0 fail** (was 22 — 10 added) |
| `npm run test:bosummary` | **40 pass, 0 fail** |
| `npm test` (full suite) | **0 fail, exit 0** |
| `npm run check` | `0 new error(s), 0 new warning(s), 12 known (baselined)` — baseline untouched |
| `git status --porcelain supabase/` | *(empty — nothing printed)* |
| `git status --porcelain scripts/` | *(empty — nothing printed)* |

### The restore logic, driven

The harness extracts three things from `app.html` **verbatim** —
`_isRestorableSection()`, `bootDashboard()`'s restore block, and
`aiTestInit()`'s late-restore block — and executes them against a stub DOM whose
nav items are parsed from the **shipped sidebar markup**. This is the same
approach `test/bo-summary.test.mjs` uses for the core blocks (there is no jsdom
in this repo); it is the shipped code running, not a copy of it.

```
=== EXECUTED: shipped restore logic, every case ===

  saved=backoffice, office=back           nav(["backoffice"]) -> draws via renderBackOffice()
  saved=carriermail, office=back          nav(["carriermail"]) -> draws via renderCarrierMail()
  saved=backoffice, office=front          nav([])  (refused: other office)
  saved=bonuses, tier=basic               nav([])  (refused: plan gate)
  saved=voice-campaigns, switches OFF     boot nav([]) pending=voice-campaigns;
                                          late-block-never-runs -> nav([]);
                                          forced-run-anyway -> nav([])
  saved=voice-campaigns, switches ON      boot nav([]) pending=voice-campaigns;
                                          after injection nav(["voice-campaigns"])
  saved=ai-test, switches ON              boot nav([]); after injection
                                          nav(["ai-test"]) + aiTestOnShow x1
  ?tab=phonebook (no saved)               nav(["phonebook"]) -> draws via renderPhoneBook()
  ?tab=phonebook beats saved=tracker      nav(["tracker","phonebook"])  (last wins)
  saved=bo-summary, office=back           nav(["bo-summary"]) -> draws via renderBackOfficeSummary()
  saved=leads, office=front (regression)  nav(["leads"]) -> draws via renderLeads()
  saved=agency, tier=pro                  nav([])  (refused: leader-only)
  late restore with a cleared flag        nav([])  (stale -> no jump)
  late restore, agent now in Back Office  nav([])  (refused: other office)
```

The `-> draws via …` column is not decoration: it is the renderer name matched
out of `nav()`'s own body in the same run, which is what proves the restore
reaches the code that fills the screen.

**"Checked twice", as the prompt asks** — `saved=voice-campaigns` with the
switches off is verified two independent ways in one row: the realistic path
(`aiTestInit()` returned at the kill switch, so the late block never executes →
no navigation), and a deliberately unrealistic one (force the late block to run
anyway with no AI nav items injected → still no navigation). Plus the
source-level assertion that the read sits below the kill switch. Three barriers,
any one of which is sufficient.

### Reasoning, not executed

Three things are argued rather than run, and they are the PENDING LIVE
VERIFICATION list below:

1. **`nav()` actually clearing the flag at runtime.** The harness stubs `nav()`,
   so the *clear* is pinned by a source assertion (it is the first statement in
   the function, above `showUpgradeGate`) and the *effect* is executed
   separately (late restore with `pending: null` → no navigation). The
   composition of the two is reasoning.
2. **That `renderBackOffice()` / `renderCarrierMail()` produce correct output**
   once called. This round proves they are *called*; what they draw is Round
   1/2 territory and unchanged.
3. **Real browser timing** — how long the beat of Summary lasts before a Voice
   Campaigns restore jumps. Depends on two Supabase round-trips.

---

## In plain English

Before: an agent working in the Back Office who hit refresh on **Statements**
came back to a page that said Statements at the top, had the Statements tab lit
up in the sidebar — and showed an upload box and a dash where their commission
figures should be. Same on **Carrier Mail**. Nothing said anything was wrong.
Clicking any other tab and clicking back fixed it, which is how it went
unnoticed. Refreshing on **Voice Campaigns** or the **AI Dialer Test** dumped
them back on the Front Office Summary.

After: a refresh puts them back on the screen they left, with it drawn.

The reason it was broken is duplication. Somewhere in the boot code was a
typed-out list of which screens a refresh was allowed to return to, and every
time a new screen shipped, somebody had to remember to add it. Four times,
nobody did. That list is deleted; the app now works it out from the sidebar
itself, so a new screen is covered the day it is added.

The two AI screens come back a beat later than the others. They only exist for
agents whose AI dialer is switched on, and the app has to ask the server about
that before it can know — so it waits, rather than flashing an AI screen at
someone who does not have the feature.

---

## Eyeball checklist for Jace — minutes, no phone

Do these in one browser tab. Hard-refresh once first (`Ctrl+Shift+R`) so you
have the new `app.html`.

1. **Statements comes back drawn.** Back Office → **Statements**. Wait for your
   figures to appear. **F5.** ✅ You land on Statements *with the pipeline
   numbers and statement list filled in* — not an upload box and a `—`. This is
   the whole round.
2. **Carrier Mail comes back drawn.** Back Office → **Carrier Mail**, let the
   list load. **F5.** ✅ The mail list is there, not just the "Sync & parse"
   button.
3. **Back Office Summary still works.** Back Office → **Summary**. **F5.** ✅
   Unchanged — this one already worked and must not have broken.
4. **Nothing changed in the Front Office.** **Leads**. **F5.** ✅ Back on Leads,
   your leads drawn. Repeat on **Policy Tracker** if you like.
5. **A fresh session still opens in the Front Office.** From the Back Office,
   sign out, sign back in. ✅ You land on the **Front Office Summary** — not
   wherever you were. (Same check: open the app in a brand-new tab.)
6. **The office guard still holds.** Sit on **Statements**, flip the toggle to
   **Front Office**, then **F5**. ✅ You stay in the Front Office on Summary —
   you are not dragged back to a Back Office screen.

If step 1 shows the upload box and a dash, the deploy has not landed yet — check
the Actions run on the commit below and hard-refresh.

---

## PENDING LIVE VERIFICATION

Cannot be closed from here; none blocks the deploy.

1. **🔴 Voice Campaigns restore** — needs an account with **both** kill switches
   on (`agents.ai_dialer_enabled` AND `billing_config.ai_dialer_enabled`).
   Navigate to Voice Campaigns, F5, expect: Front Office Summary for roughly a
   second, then the screen jumps to Voice Campaigns with its campaign list
   drawn. **Also verify the negative:** on an account with either switch off,
   F5 while `pp_current_section` is `voice-campaigns` must leave you on the
   Front Office Summary permanently, with no AI nav item and no flash of the
   campaign screen at any point.
2. **🔴 AI Dialer Test restore** — same account, same shape. Additionally
   confirm the panel's own data loads (voice, AI name, transfer number, meter),
   which is `aiTestOnShow()` — the restore calls it explicitly because `nav()`
   has no `ai-test` hook, unlike `voice-campaigns`.
3. **`?tab=phonebook` end to end** — needs a real low-balance email from
   `wallet-low-balance-notify`. The link resolving is executed above; what is
   unverified is the whole chain (cron → Resend → click → land on Phone Book).
   Unchanged by this round.
4. **The one-second beat** — subjective, and only observable on an
   AI-enabled account. If it reads as a glitch rather than a load, that is a
   copy/spinner decision for a later round, **not** a reason to move the
   injection earlier.

---

## Files changed

| File | Change |
|---|---|
| `app.html` | `_isRestorableSection()` + `_pendingLateRestore` declared beside `OFFICE_OF`; `const valid = {…}` deleted and both call sites switched; `nav()` clears the flag first; `aiTestInit()` spends it inside the injection block |
| `test/office-split.test.mjs` | +10 tests, + the executable restore harness |
| `test/bo-summary.test.mjs` | 1 test rewritten — it asserted `const valid = {…}` still existed with `'bo-summary':1`; its intent (F5 restores the Back Office landing screen) is preserved against the derived predicate |
| `CLAUDE.md` | 3 new office-split bullets; the stale Round 2 `valid` bullet corrected |
| `docs/office-split.md` | new "What a refresh restores (Round 3)" section |
| `docs/reports/PROMPT_FO3-report.md` | this file |

Nothing under `supabase/`, `scripts/`, `data/`, `www/`, `ios/` or `android/`.
`scripts/check-app.baseline.json` untouched.
