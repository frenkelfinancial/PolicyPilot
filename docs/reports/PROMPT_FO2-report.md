# PROMPT FO2 — The Back Office gets its own Summary

**Round 2 of 2 of the office split. Shipped complete — all four strips, not the
reduced "strips 1 and 2" boundary.**

Feature doc: `docs/back-office-summary.md`. Round 1: `docs/office-split.md`,
`docs/reports/PROMPT_FO1-report.md`.

---

## Tripwires — all five passed before a line was written

| # | Check | Result |
|---|---|---|
| 1 | `grep -c 'OFFICE_OF' app.html > 0` | **9** — Round 1 is merged |
| 2 | `docs/reports/PROMPT_FO1-report.md` exists | present |
| 3 | one `OFFICE_HOME` definition, `back: 'tracker'` | one, at `app.html:29100`, `{ front: 'summary', back: 'tracker' }` — not yet built |
| 4 | clean `main`, `git pull` | clean (only the known-untracked `prompts/`); "Already up to date" |
| 5 | `npm test` green **before** starting | green — every suite, `check` clean |

---

## Step 0 — VERIFY, DON'T ASSUME

### RPC return shapes, read from the migrations that define them

Every one still exists. Shapes are the `RETURNS TABLE` declarations, verbatim.

| RPC | Migration | Returns |
|---|---|---|
| `get_commission_buckets(p_start date, p_end date)` | `20260742_commissions_dashboard.sql:75` | `week_start date`, `transaction_type text`, `is_own boolean`, `amount_cents bigint`, `positive_cents bigint`, `negative_cents bigint`, `row_count bigint` — **one row per (week, type, is_own)**, not one row of totals |
| `get_commission_debt(p_start date, p_end date)` | `20260742:130` | `carrier text`, `debt_cents bigint`, `chargeback_cents bigint`, `adjustment_cents bigint`, `row_count bigint`, `unmatched_rows bigint`, `last_at date` — **one row per carrier**, `having debt > 0` so a carrier in credit is absent, not zero |
| `get_reconciliation_summary(p_unpaid_days int default 45)` | `20260744_reconciliation.sql:80` | `match_review bigint`, `unlinked_policies bigint`, `stuck_uploads bigint`, `resolved_7d bigint`, `review_amount_cents bigint` — **a single row** |
| `get_downline_persistency(p_now date)` | `20260743_persistency.sql:56` | `agent_id uuid`, `agent_name text`, `agent_email text`, `is_self boolean`, `window_months int`, `cohort_count bigint`, `kept_count bigint`, `cohort_ap numeric`, `kept_ap numeric` — **one row per agent per window**, windows are `4, 9, 13, 25` |
| `get_ingestion_summary()` | `20260739_back_office_ingestion.sql:329` | `queued`, `parsing`, `persisting`, `matching`, `ingested`, `failed`, `ingested_7d`, `rows_7d`, `pending_review` — all `bigint`, **a single row** |
| `get_downline_commission_rollup(p_start date, p_end date)` | `20260742:200` | `agent_id uuid`, `agent_name text`, `agent_email text`, `is_self boolean`, `gross_cents`, `chargeback_cents`, `net_cents`, `personal_cents`, `override_cents`, `debt_cents`, `row_count` (all `bigint`) — **one row per team agent**, aggregates only |
| `get_carrier_summary(p_start, p_end)` | `20260745_carriers.sql:30` | verified present. **Not used** — see "Wanted and not used", below |
| `get_team_summary(…8 time bounds)` | `20260738_team_roster.sql` | verified present. **Not called directly** — see the one-call-site note below |

Two shapes changed how a card was built rather than merely being recorded:

- `get_commission_buckets` returns **buckets, not answers**. Every headline
  figure is derived in the pure `// <comm-core>` block. This screen therefore
  calls `commTotals()` rather than reading a column, which is also what keeps
  its Net identical to the Commissions panel's Net.
- `get_downline_persistency` returns **four windows per agent**, so
  `bosPersistency()` has to filter on `window_months` *and* on `is_self`. The
  team strip re-uses the same function with `selfOnly: false` — that is the
  only difference between "my persistency" and "my agency's".

### Existing helpers reused, not rewritten

All eight were present. Line numbers are **post-change** (`app.html`).

| Helper | Line | Used for |
|---|---|---|
| `boFmtMoney(cents)` | 26807 | every dollar figure on the screen |
| `boStatusMeta(status)` | 26847 | *(present; not needed — no statement pills on this screen)* |
| `COMM_RANGES` | 26885 | the range chip row |
| `commRange(key, today)` | 26903 | the only range calculator |
| `persistBand(pct)` | 27165 | the band colour on both persistency cards |
| `persistBandLabel(pct)` | 27170 | the band's word |
| `persistWindowLabel(months)` | 27341 | "13-month" / "25-month" |
| `boArea(key)` | 28008 | every door into a Back Office panel |

Also reused rather than duplicated: `commTotals()` (26937),
`COMM_CARD_DEFS` (26957), `commDebtRanked()` (27109), `RECON_QUEUES`
(recon-core), `rcSetQueue()`, `_planTier()` (16529), `escHTML()`,
`loadTeamRoster()` (17180).

**`isoDay` was not needed and no copy was made.** The two range-bearing calls
take `range.start` / `range.end` straight from `commRange()`, which already
emits ISO day strings, and the debt call takes nulls. There is no date
arithmetic anywhere in this screen — a test asserts `bosSetRange()` contains no
second range calculator.

**Nothing on the list was rewritten.** A test asserts the screen contains no
second money formatter and never divides by 100.

---

## What was built

New section `#sec-bo-summary` (`app.html:5800`), inside the existing
`.ledger` / `.lg-wrap` shell so it inherits the Back Office design system.

Registration:
- `OFFICE_OF['bo-summary'] = 'back'` — first entry in the Back Office block
- `OFFICE_HOME.back = 'bo-summary'` (was `'tracker'`)
- `NAV_TITLES['bo-summary'] = 'Summary'`
- nav item in a new **Overview** group at the top of the `data-office="back"`
  wrapper, `gauge` icon — deliberate symmetry with the Front Office
- `nav()`: `if (id === 'bo-summary') renderBackOfficeSummary();`
- `bootDashboard()`'s `valid` allow-list: `'bo-summary':1`

Pure math in `// <bo-summary-core>` (`app.html:27603–27854`), renderer from
`app.html:29042`.

### The four strips

1. **The money** — Net Commission, Personal Sales, Override Income (dropped
   when zero *and* no hierarchy), Outstanding Debt. Range chips are the
   Commissions panel's own `COMM_RANGES`, sharing `_cmRange` and the
   `pp_comm_range` key: one range, one memory, one calculator. Debt is called
   with `bosDebtArgs()` — `{p_start: null, p_end: null}` — and says so in small
   print under the number.
2. **What needs you** — Policy Match Review, Unlinked Policies, Stuck Uploads
   from `get_reconciliation_summary(45)`, each opening its own queue via
   `bosOpenQueue()` (which selects the queue *before* showing the panel).
   Above them, always, one sentence: "6 things need a look" or "Nothing needs
   your attention right now."
3. **Book health** — 13-month and 25-month, banded by `persistBand()`, legend
   rendered, plus one line on why the bands matter. Absent or thin cohort →
   `—` and a sentence, never `0%`.
4. **Your team** — leaders only, absent for everyone else.

---

## Decisions worth arguing with

**The team headcount does not call `get_team_summary`.** The prompt named that
RPC, but `CLAUDE.md` and `test/team-roster.test.mjs` pin the app to *exactly
one* call site, inside `loadTeamRoster()` — that invariant is what stopped the
8,610× AP overstatement coming back, and "a new landing screen wants a
headcount" is precisely the innocent-looking reason a second call site appears.
The screen calls `loadTeamRoster(_teamPeriod)` instead and reads
`view.count - (view.you ? 1 : 0)`. Same number, same window arithmetic, no new
call site. When the roster is unknown it falls back to the rollup's non-self
rows, and the card says which it is (`headcountKnown`).

**A thin persistency cohort (< 3) renders `—`, which differs from the
Persistency panel.** The prompt asked for it, and it is right for a headline —
one lapse in a two-policy cohort is a 50% figure on the owner's landing screen.
But the panel one click away *does* show a thin segment, flagged. To keep the
difference from being silent, the card states it: *"Only 2 policies are old
enough to count — too few for a rate."* Recorded in `CLAUDE.md` and
`docs/back-office-summary.md` because a future session comparing the two
screens will otherwise read it as a bug.

**Override Income is hidden by dropping the card, not by `style.display`.**
Office visibility is CSS and plan gating is an inline style; this is neither,
so it does the third thing — it is not in the list. Nothing in
`_applyPlanGating()` or the office CSS was touched.

**`bo-summary` is ungated in `_applyPlanGating()`.** An office's landing screen
has to be reachable at every tier, the same reasoning that keeps the Agency tab
ungated. The leader-only content inside it gates itself.

---

## A real bug the tests found

`bosAttention()` first read counts as `Math.max(0, Number(s[field] || 0))`.
`Number('x' || 0)` is `NaN`, and `Math.max(0, NaN)` is `NaN` — so the guard
that looks like it clamps does not, and a malformed count would have rendered
"NaN things need a look" across the strip. Fixed with `bosCount()` /
`bosCents()` (money keeps its sign; a count cannot be negative), used by the
attention roll-up, the persistency sums, the team totals and the empty-state
predicate. Caught by the unit test, not by inspection.

---

## Wanted and not available from existing RPCs

Recorded as decisions rather than left as silent gaps.

| Wanted | Why not | What it would take |
|---|---|---|
| **Debt aged by carrier** ("this balance has been sitting 90 days") | `get_commission_debt` returns `last_at` per carrier and no ageing buckets | a new RPC, or ageing derived in `comm-core` from a rows query the browser must not make |
| **Team production vs. the previous period** | `get_downline_commission_rollup` takes one window | a second call with the prior range — affordable, but a product decision about what the team strip is for |
| **Statements ingested this week** | available (`ingested_7d`, `rows_7d`) and `boSummaryLine()` already renders the sentence | nothing — it was **left off on purpose**: a fifth card competing with four is worse than four, and "what came in" is answered better by the money |
| **Per-carrier totals** (`get_carrier_summary`) | exists and works | nothing — deliberately not used. The Carriers panel owns it and a second surface for it would be a second thing to keep correct |
| **A quarter-to-date chip** | `COMM_RANGES` is shared with the Commissions panel | changing both screens. Raised as a suggestion, not added — the prompt asked for exactly that |

---

## The other four missing keys in `bootDashboard()`'s allow-list

`'bo-summary':1` was added, as instructed. The allow-list is still missing
`carriermail`, `backoffice`, `voice-campaigns` and `ai-test` — a pre-existing
gap, not caused by Round 1 or Round 2. **Not fixed here, as instructed.**

Effect today: F5 while on any of those four lands the agent on Summary rather
than where they were. `backoffice` is the one that stings — an agent
mid-reconciliation who refreshes loses their place.

**Recommendation:** add all four in one line, in a change of its own. The
restore path is already safe for them — `restoreSectionFromCache()` resolves
structurally (a section is restorable when a nav item points at it) and both
restore paths already refuse a section belonging to the other office — so the
allow-list is the only thing holding them back. Worth doing as a deliberate
decision about refresh behaviour, with its own test.

---

## Verification

### Automated

```
npm run test:bosummary   → 40 tests, 40 pass, 0 fail
npm run test:office      → 22 tests, 22 pass, 0 fail   (was 21; +1 new, 1 updated)
npm test                 → every suite green, 0 fail anywhere
npm run check            → ✓ app.html: 0 new error(s), 0 new warning(s), 12 known (baselined)
```

`scripts/check-app.baseline.json` was **not** regenerated and is not in the
diff.

`test/office-split.test.mjs` changed in two places, both genuine changes in the
expected result rather than a test being bent:
- the Back Office nav list gained `'Summary'` at the front;
- `OFFICE_HOME.back` is asserted as `'bo-summary'` (it asserted `'tracker'`,
  with a comment saying Round 2 would change it).
A new test was added there too: the Back Office lands on its own Summary and
that section exists.

### Proof of the no-backend rule

```
$ git diff --stat
 CLAUDE.md                  |  47 +++-
 app.html                   | 672 ++++++++++++++++++++++++++++++++++++++++++++-
 docs/office-split.md       |  29 +-
 package.json               |   5 +-
 test/office-split.test.mjs |  22 +-
 5 files changed, 755 insertions(+), 20 deletions(-)

$ git status --porcelain supabase/
(no output)
```

Plus two new files: `docs/back-office-summary.md`, `test/bo-summary.test.mjs`,
and this report. **Zero changes under `supabase/`.**

`git diff package.json` is script lines only — the `test` chain gained
`&& npm run test:bosummary` before `npm run check`, and one new
`"test:bosummary"` entry. **No dependency was added.**

### States rendered — what was actually run vs. only reasoned about

**ACTUALLY RENDERED.** A headless harness extracted the *shipped* render
functions from `app.html` (the real slice, not a copy) together with
`backoffice-core`, `comm-core`, `persist-core`, `recon-core` and
`bo-summary-core`, stubbed only `escHTML`/`document`/`sb`/`nav`, and printed
the HTML for each state. What that produced, verbatim:

| State | Verified output |
|---|---|
| **Loading** | three skeleton money cards (Net, Personal, Debt — Override correctly withheld until known), three skeleton attention cards, two skeleton persistency cards. Legend and card definitions already present. |
| **Populated, non-leader** | Net `$5,950.00`, Personal `$4,450.00`, Override `$1,200.00`, Debt `$420.00` in `cm-neg` red with the "All time — the range above does not apply" note. "6 things need a look" over 4 / 1 / 1. 13-mo `92%` `ps-green`, 25-mo `67%` `ps-red`, both with fill bars. **Team strip: `""` — the empty string, not a hidden div.** |
| **All clear** | "Nothing needs your attention right now." in `bos-clear`, over three `bos-zero` zeroes. |
| **One RPC failed** (persistency rejected) | both persistency cards read *"Couldn't load — open Persistency to see this"*; the money strip rendered its four real figures unchanged in the same pass. |
| **Leader** | Downline `3` (roster count 4 minus self), Team Production `$7,850.00` (whole agency), Team Persistency `81%` `ps-yellow` with "17 of 21 still on the books". |
| **Young book** | 13-mo `—` + "Only 2 policies are old enough to count — too few for a rate."; 25-mo `—` + "No policy has had 25 months to lapse yet." **Neither rendered `0%`.** Override card absent. |
| **Empty account** | the single friendly panel with the "Upload a statement" button. `bosIsEmpty({ingested:0})` → `true`; `bosIsEmpty({ingested:0,parsing:1})` → `false`. |

**REASONED ABOUT, NOT RENDERED IN A BROWSER.** Everything visual: that
`.bos-card:hover` reads as clickable, that the cards wrap sensibly at phone
width, that dark and light both look right, and that the skeleton→number
transition is not jarring. The CSS is `var(--lg-*)` tokens only (asserted by a
test) and every class it leans on — `.cm-card`, `.ps-win`, `.tracker-tabs`,
`.pt-btn` — is an existing Back Office class that already renders correctly in
both themes, but *"the tokens are correct"* is not the same claim as *"it looks
right"*. That is what the checklist below is for.

**NOT VERIFIED AT ALL:** anything requiring a live session — see PENDING LIVE
VERIFICATION.

---

## In plain English — what an agency owner sees

You click **Back Office** on the toggle. Instead of a list of policies, you get
a page that has already done the looking for you.

Across the top, **the money**: what actually reached your bank this month, how
much of it was business you wrote yourself, how much came from your agents, and
what you still owe the carriers. That last number ignores the MTD/YTD buttons
on purpose, and says so underneath — you owe what you owe, and a debt figure
that shrank because you clicked a button is not a number you can do anything
with.

Under that, in one sentence, **what needs you**: *"6 things need a look."* Then
three boxes telling you which six — commission lines the parser could not match
to a policy, policies in force that nothing has paid on, and uploads that
failed. Click any box and you land in that exact queue.

Then **book health**: your 13-month and 25-month persistency, coloured green,
amber or red against the bands the carriers' own bonus programmes use. If your
book is too young to have a real rate, it says so in words rather than showing
you a red 0%.

If you run an agency, there is a fourth row: how many agents are under you,
what the agency wrote this period, and how the agency's book is persisting. If
you do not run an agency, that row simply is not there — no greyed-out box
advertising something you have not bought.

Every box on the page is a door. Nothing on it can be edited, so nothing on it
can be broken by clicking.

---

## Eyeball checklist for Jace — minutes, no phone required

1. Open the app, click **Back Office** on the toggle under the logo. You should
   land on **Summary** — not Policy Tracker. The topbar should read "Summary"
   and the first nav item should be highlighted.
2. Read the four money cards. Then click **Statements → Commissions** and set
   the same range chip. **Net Commission, Personal Sales and Override Income
   must match exactly.** (They come from the same function; if they differ,
   something is wrong that matters more than this screen.)
3. Still on Summary: click **MTD**, then **YTD**, then **All time**.
   Net/Personal/Override should move. **Outstanding Debt must not move at
   all.** Read the small print under it.
4. Click each of the three attention cards in turn. Each should land you in
   **Statements → Reconciliation** with *that* queue already selected — Policy
   Match Review, Unlinked Policies, Stuck Uploads. Come back to Summary each
   time.
5. Check the sentence above them matches the three numbers. If all three are
   zero it must read "Nothing needs your attention right now." — never three
   bare zeroes.
6. Click either persistency card → **Statements → Persistency**. The 13-month
   and 25-month figures and their colours must match the panel's own. If
   Summary shows `—` where the panel shows a number, check the card's sentence
   says "too few for a rate" — that is the deliberate difference, not a bug.
7. Confirm the legend under the persistency cards is there and readable.
8. **Non-leader check:** on an account that is not on a Leader plan, confirm
   there is **no team row at all** — not a greyed box, not an empty one.
   Nothing.
9. Hit the **Refresh** button top-right. The cards should blank to skeleton
   bars and refill.
10. Press **F5** while on Summary. You should come back to Summary, not
    somewhere else.
11. Toggle dark/light (Settings). Every number, label and band colour should
    stay legible in both.
12. Open it on a phone. The card rows should wrap to one or two columns and the
    page must not scroll sideways.

---

## PENDING LIVE VERIFICATION

Nothing below was reachable without a live session; all of it is honestly
untested.

1. **The leader-only team strip against a real agency with a real downline.**
   The headcount path (`loadTeamRoster` → `view.count - 1`) and the rollup
   fallback have only been run against fixtures. The one thing to watch: a
   leader whose downline has never uploaded a statement should still see a
   correct headcount (from the roster) beside a `$0.00` production figure.
2. **The numbers matching a real carrier statement.** Net / Personal /
   Override / Debt have been proved to equal what `commTotals()` and
   `commDebtRanked()` produce from a fixture. They have not been compared with
   money a carrier actually paid.
3. **The empty state on a genuinely brand-new account.** `bosIsEmpty()` is
   unit-tested in every combination, but no account with zero statements has
   loaded the real screen.
4. **The persistency figures agreeing with the Persistency panel on the live
   book.** The panel's four headline windows are computed from the local
   `policies` array; this screen reads `get_downline_persistency`. Both use the
   same cohort rules and the same fallback date chain (a test in
   `test/persistency.test.mjs` pins browser and SQL together), but browser-vs-
   server agreement on the live 23-policy book has not been observed.
5. **The failure path against a real failure.** The "Couldn't load" branch was
   rendered from an injected rejection, not from an RPC that actually failed.
6. **Dark mode and phone width**, as noted above — tokens verified, appearance
   not.

---

## Commit and deploy

**Commit: `579c17cdcd51e473543e98d46c40f3c07390fb36`** (`579c17c`) — *"The Back
Office answers its own question before you ask it"*.

Pushed to `main`: `3f2fc01..579c17c`. `git status -sb` reports
`## main...origin/main` with no ahead/behind, i.e. in sync with the remote.
The pre-push hook ran and passed; `--no-verify` was not used.

`prompts/` was left **untracked**, the same call Round 1 made — `git add -A`
would otherwise sweep the prompt files into the repo, and the commit is meant
to contain exactly the change.

Deployment is automatic via `.github/workflows/pages.yml` on push to `main`.
`app.html` is already in the Pages allowlist, so this needed no workflow
change; the new doc and test file are not web-served and do not affect the
build.

*(This section was added in a follow-up commit, since the SHA cannot be known
before the commit exists.)*

---

## Files changed

| File | What |
|---|---|
| `app.html` | the section, the nav item, the CSS, the `// <bo-summary-core>` block, `renderBackOfficeSummary()` and the `bos*` renderers, the three registration edits, the `valid` allow-list |
| `test/bo-summary.test.mjs` | **new** — 40 tests |
| `test/office-split.test.mjs` | Back Office nav list + `OFFICE_HOME.back`, plus one new test |
| `package.json` | `test:bosummary` script, wired into the `test` chain before `check` |
| `docs/back-office-summary.md` | **new** — the feature doc |
| `docs/office-split.md` | Round 2 marked done; the nav table and the landing-screen decision updated |
| `CLAUDE.md` | the Back Office Summary rules |
| `supabase/**` | **nothing** |
