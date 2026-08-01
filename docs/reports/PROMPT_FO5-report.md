# PROMPT FO5 — One answer to "what month does this policy belong to"

Round 5 of the office split. Small round, fully shipped — the consolidation was
not tangled, so the fallback boundary in the prompt was not used.

**What it does:** the Back Office Summary now places a policy in the month it
was **submitted**, the same as the Front Office. The three hand-written copies
of that date chain became one resolver, `ppProductionDate()`.

---

## Tripwires

| Check | Result |
|---|---|
| `git status` clean on `main` (untracked `prompts/` only) | ✅ |
| `git pull` | `Already up to date.` |
| `ls docs/reports/PROMPT_FO4-report.md` | present |
| `grep -c 'PP_PRODUCTION_DATE\|ppProductionDate' app.html` | **0** — not built |
| `npm test` before starting | **green**, all 32 suites + `npm run check` |

---

## Step 0 — every production-date resolver in `app.html`

The prompt listed four and said the list was a starting point, not a finishing
one. `grep -n 'dateSubmitted' app.html` returned 18 lines; every one was read
and classified. Line numbers are pre-change (`git show HEAD:app.html`).

### The four that answer "which period does this policy count in"

| # | Where | Line | Chain | What happened |
|---|---|---|---|---|
| 1 | `_lgSubDate(p)` | 18309 | `dateSubmitted → draft → id` | **Now a one-line alias** over `ppProductionDate`. 5 call sites on the Ledger Summary, all untouched. |
| 2 | `_ptSubForRange(p)` | 14786 | identical, under another name | **Now a one-line alias**, keeping its own `\|\| ''` at the call site. |
| 3 | inline slice in `_lbCurrentTotals()` | 18068 | `dateSubmitted → draft` (**no id fallback**) | **Replaced** by `ppProductionDate(p)`; the `.slice(0, 10)` stayed at the call site. |
| 4 | `bosPolicyDay(p)` | 27982 | **`p.draft` only** | **Switched** to `ppProductionDate`. This is the one place behaviour genuinely changes. |

**Alias, not call-site replacement — and why.** `_lgSubDate` has five readers
and `_ptSubForRange` one; replacing them at 6 call sites would have produced a
larger diff with more places to get wrong, for no gain. As one-line
delegations they keep their screen-local names *and* there is exactly one
definition. A test pins each alias to its exact body text, so neither can quietly
grow a chain again.

### Extending the list — four more found, none of them the same question

These resolve a policy to a date but are **not** production dates. Each is
recorded in `test/production-date.test.mjs`'s `CLASSIFIED` table with its
reason, so they are documented rather than merely skipped.

| Where | Line | Chain | Why it is NOT the resolver |
|---|---|---|---|
| `_ptGetSub(p)` | 14780 | `dateSubmitted → id` (**no draft**) | Fills the Policy Tracker's **Submitted column**, its exact-date filter and its `sub-asc`/`sub-desc` sort. It answers "what does this policy say it was submitted on". Adding the draft fallback would print a **draft date under a heading that says Submitted**. Its existing comment already called the distinction deliberate; I made that comment say why, in red. |
| `bobTimeline()` genesis entry | 14724 | `dateSubmitted → draft → null` | Dates a synthetic entry on the policy **timeline**. No id fallback, and `null` means "not known" — the timeline sorts undated entries last. Routing it through the resolver would make an **audit row claim a date it does not have**. |
| `bobRecordPolicyCreated()` | 15208 | `dateSubmitted → draft` | The same, for `policy_status_history`. Same reason, and that table is append-only with no update policy — a wrong stamp there cannot be corrected. |
| `persistCohortDate()` (`persist-core`) | 27260 | **`issueDate → draft → dateSubmitted`** | The persistency **cohort** date, a different question, and CLAUDE.md records this chain as a deliberate bug fix of its own ("never narrow it back"). Out of scope by the prompt's ground rules and by its own history. |

The remaining `dateSubmitted` lines are DOM plumbing for the Add/Edit Policy
modals (`p-dateSubmitted` / `ep-dateSubmitted`, the value read on save, and the
saved policy object literal). All classified.

### `_dailySeries()` — genuinely dead, evidence attached

```
$ grep -no '_dailySeries(' app.html
15873:_dailySeries(      <- its own declaration
27976:_dailySeries(      <- a comment inside // <bos-chart-core>
```

Two occurrences of the name in the entire file: the declaration, and the
comment in `bosPolicyDay()` that cited it as justification for bucketing on
`p.draft`. There is no call site. `grep -rn '_dailySeries' docs/ test/ scripts/`
finds it only in the FO4 report's own inventory.

**It is dead, and it was load-bearing as a source of misinformation.** Round 4's
`bosPolicyDay()` comment read *"`draft` is the field `_dailySeries()` already
buckets on, so the graph, the cards and the Ledger Summary's own sparkline all
put a policy in the same period."* Every clause is true of a function nothing
calls — which is precisely how this screen ended up disagreeing with the one it
was trying to match.

**Not deleted** (dead-code removal is its own decision, per the prompt). Instead
its declaration now carries a 🔴 header saying it has no callers and must not be
cited, and `docs/back-office-summary.md` carries the same warning as a block
quote. Nothing in the repo now points at it as evidence.

---

## What changed, in ordinary words

A policy has two dates on it that are easy to confuse. **Submitted** is the day
you sent the application to the carrier. **Draft** is the day the carrier takes
the first premium out of the client's bank account — usually a week or three
later, and very often in the *next* month.

The Front Office summary has always counted a policy in the month you
**submitted** it. The Back Office summary, which was built last, counted it in
the month it **drafts**. So a policy you sold on the 27th of June that drafts on
the 3rd of July was June business on one screen and July business on the other —
the same policy, two different months, one click apart on the same sidebar.

Now both screens count it in June, the month you did the work. On a test book of
eight policies, six of them moved to a different month on the Back Office
screen. **Nothing moved on the Front Office screen** — it was already right, and
proving it did not budge was most of this round's testing.

**One thing this did NOT change:** the Back Office's "Personal issued AP" card
still counts only what the carrier has actually issued or paid, while the Top
Producers board still counts everything you sold including pending
applications. Those two numbers still differ, both cards still say so, and that
was deliberately left alone. This round was about **when** a policy counts, not
**what** counts.

---

## Before and after — executed, not reasoned

A headless harness (`fo5-harness.mjs`) lifts the shipped pure logic out of
**two** versions of `app.html` — `git show HEAD:app.html` for "before" and the
working tree for "after" — and runs both against one fixture book. Nothing is
re-implemented; `bosIssuedAP`, `bosCarrierMix`, `bosChartSeries`, `_lgSubDate`,
`_lgInRange`, `_lgAdvComm` and `summaryPeriodRange` are all extracted verbatim
from each version.

The book: eight policies. Three straddle a month boundary, one has a draft date
only, one has **neither** date (id only), one is `pending` and one is `lapsed`
so the status predicates stay exercised. "Today" is 1 August 2026.

### Where each policy lands

```
client    submitted    draft        BEFORE       AFTER        moved
Alvarez   2026-06-27   2026-07-03   2026-07-03   2026-06-27   YES  2026-07-03 -> 2026-06-27
Boone     2026-06-29   2026-07-10   2026-07-10   2026-06-29   YES  2026-07-10 -> 2026-06-29
Cho       2026-07-30   2026-08-05   2026-08-05   2026-07-30   YES  2026-08-05 -> 2026-07-30
Delgado   2026-07-08   2026-07-08   2026-07-08   2026-07-08
Ellis     —            2026-07-15   2026-07-15   2026-07-15
Fowler    2026-07-20   2026-07-25   2026-07-25   2026-07-20   YES  2026-07-25 -> 2026-07-20
Grant     —            —            null         2026-07-12   YES  null -> 2026-07-12
Hobbs     2026-06-18   2026-07-01   2026-07-01   2026-06-18   YES  2026-07-01 -> 2026-06-18
```

Six of eight moved. **Delgado** (both dates equal) and **Ellis** (draft only)
did not — between them they are the shape of most of a real book.

**Grant is the second, smaller behaviour change** and is worth naming: a policy
with neither date was on *no* Back Office timeline at all and now lands on its
`id` timestamp. That is the resolver's third branch, which the Front Office has
always had. It makes the two screens agree; it does not invent anything the
Front Office was not already doing.

### Back Office Summary — the four cards

```
--- June 2026 ---
  BEFORE  issued AP $0        | est. comm $0        | policies 0   | (none)
  AFTER   issued AP $4,800    | est. comm $3,465    | policies 2   | Alvarez, Boone

--- July 2026 ---
  BEFORE  issued AP $6,900    | est. comm $4,939    | policies 4   | Alvarez, Boone, Delgado, Ellis
  AFTER   issued AP $5,100    | est. comm $3,229    | policies 4   | Cho, Delgado, Ellis, Grant

--- Lifetime ---
  BEFORE  issued AP $9,300    | est. comm $6,379    | policies 5   | Alvarez, Boone, Cho, Delgado, Ellis
  AFTER   issued AP $9,900    | est. comm $6,694    | policies 6   | Alvarez, Boone, Cho, Delgado, Ellis, Grant
```

June went from an empty screen to $4,800 — Round 4 had those two policies filed
under July. Lifetime grew by exactly Grant's $600.

**Commission paid** is the fourth card and reads `get_commission_buckets`, which
takes its bounds from the period control and touches no policy date. It is
unaffected in both directions, by construction.

### Back Office Summary — carrier mix

```
--- June 2026 ---
  BEFORE  total $0        | (no mix)
  AFTER   total $4,800    | Americo 1 $3,000 62.5% · Mutual of Omaha 1 $1,800 37.5%

--- July 2026 ---
  BEFORE  total $6,900    | Americo 2 $4,200 60.9% · Mutual of Omaha 1 $1,800 26.1% · Corebridge 1 $900 13.0%
  AFTER   total $5,100    | Foresters 1 $2,400 47.1% · Americo 1 $1,200 23.5% · Corebridge 1 $900 17.6% · Aetna 1 $600 11.8%

--- Lifetime ---
  BEFORE  total $9,300    | Americo 2 $4,200 45.2% · Foresters 1 $2,400 25.8% · Mutual of Omaha 1 $1,800 19.4% · Corebridge 1 $900 9.7%
  AFTER   total $9,900    | Americo 2 $4,200 42.4% · Foresters 1 $2,400 24.2% · Mutual of Omaha 1 $1,800 18.2% · Corebridge 1 $900 9.1% · Aetna 1 $600 6.1%
```

The mix total equals the AP card in every window, before and after — they run
through the same `bosIssuedPolicies()` and now the same resolver.

### Back Office Summary — chart series

```
--- June 2026 ---
  BEFORE  unit=day buckets=30 | (all zero)
          cumulative end $0 === card $0 ? YES | non-decreasing: YES
  AFTER   unit=day buckets=30 | 2026-06-27=$3,000 2026-06-29=$1,800
          cumulative end $4,800 === card $4,800 ? YES | non-decreasing: YES

--- July 2026 ---
  BEFORE  unit=day buckets=31 | 2026-07-03=$3,000 2026-07-08=$1,200 2026-07-10=$1,800 2026-07-15=$900
          cumulative end $6,900 === card $6,900 ? YES | non-decreasing: YES
  AFTER   unit=day buckets=31 | 2026-07-08=$1,200 2026-07-12=$600 2026-07-15=$900 2026-07-30=$2,400
          cumulative end $5,100 === card $5,100 ? YES | non-decreasing: YES

--- Lifetime ---
  BEFORE  unit=month buckets=2 | 2026-07-01=$6,900 2026-08-01=$2,400
          cumulative end $9,300 === card $9,300 ? YES | non-decreasing: YES
  AFTER   unit=month buckets=3 | 2026-06-01=$4,800 2026-07-01=$5,100
          cumulative end $9,900 === card $9,900 ? YES | non-decreasing: YES
```

**FO4's assertion still holds in every window**: the cumulative series ends
exactly on `bosIssuedAP()` over the same window, and never descends.

Two chart details worth noting. **Lifetime grew a bucket** (2 → 3): the earliest
issued policy is now 27 June rather than 3 July, so the axis starts a month
earlier — the graph's span is derived from the book through the same resolver.
And **the August bucket emptied**: Cho's $2,400 was the only thing in it and has
moved back to July, where it was sold.

### Front Office Ledger Summary — must NOT move

```
--- Today (daily) ---
  BEFORE  AP $0        | comm $0          | policies 0 | avg prem — | in period: (none)
  AFTER   AP $0        | comm $0          | policies 0 | avg prem — | in period: (none)

--- This week (weekly) ---
  BEFORE  AP $2,400    | comm est. $1,440 | policies 1 | avg prem $200 | in period: Cho
  AFTER   AP $2,400    | comm est. $1,440 | policies 1 | avg prem $200 | in period: Cho

--- This month (monthly) ---
  BEFORE  AP $0        | comm $0          | policies 0 | avg prem — | in period: (none)
  AFTER   AP $0        | comm $0          | policies 0 | avg prem — | in period: (none)

--- June 2026 ---
  BEFORE  AP $4,800    | comm est. $3,465 | policies 2 | avg prem $200 | in period: Alvarez, Boone, Hobbs
  AFTER   AP $4,800    | comm est. $3,465 | policies 2 | avg prem $200 | in period: Alvarez, Boone, Hobbs

--- July 2026 ---
  BEFORE  AP $6,600    | comm est. $4,354 | policies 5 | avg prem $110 | in period: Cho, Delgado, Ellis, Fowler, Grant
  AFTER   AP $6,600    | comm est. $4,354 | policies 5 | avg prem $110 | in period: Cho, Delgado, Ellis, Fowler, Grant

--- Lifetime ---
  BEFORE  AP $11,400   | comm est. $7,819 | policies 7 | avg prem $136 | in period: Alvarez, …, Hobbs
  AFTER   AP $11,400   | comm est. $7,819 | policies 7 | avg prem $136 | in period: Alvarez, …, Hobbs

Front Office moved on any window: NO — identical on all six
```

Byte-identical on all six window shapes, including `daily`, `weekly`, a picked
month and lifetime. The KPI block reproduced here is `renderSummary()`'s own:
`periodPols = pols.filter(p => _lgInRange(_lgSubDate(p), range))`, then
`periodSold` filtered by `BOB_NOT_A_SALE`, then AP / est. commission / count /
average premium.

### The point of the round, in one number

```
policies the two screens placed in DIFFERENT months
  BEFORE  6   (Alvarez, Boone, Cho, Fowler, Grant, Hobbs)
  AFTER   0
```

---

## Tests

### New — `test/production-date.test.mjs`, 17 tests

`npm run test:productiondate`, wired into the `test` chain immediately before
`npm run check`.

| Group | Tests |
|---|---|
| **The four branches** | `dateSubmitted` wins; falls back to `draft` (including when `dateSubmitted` is the empty string the Edit modal writes); falls back to the id timestamp, sliced in UTC; returns `null` when a policy has none of the three. |
| **Equivalence** | 10 fixtures covering every branch and every combination that reaches a different line of the chain — including two where the fields disagree about the month. The **pre-change source of `_lgSubDate` and `_ptSubForRange` is frozen verbatim in the test file** and run against the new resolver on each. Identical output, or the test names the fixture that moved. |
| **Alias shape** | Both aliases are pinned to their exact one-line bodies, so neither can grow a chain again. |
| **No fourth copy** | (a) every `dateSubmitted` line in `app.html` is matched against the `CLASSIFIED` table or the test fails naming it; (b) the three-step chain regex must match **zero** times outside the resolver. |
| **Call sites** | `_lbCurrentTotals()` calls the resolver, keeps its own `.slice(0, 10)`, and has no field chain of its own. |
| **Purity** | The resolver is inside `// <team-core>` and mentions no DOM, storage, network or `policies`. |
| **The Back Office moved** | A straddling policy counts in its submitted month and **not** in its draft month, on `bosIssuedAP`, `bosIssuedCount`, `bosCarrierMix` and `bosChartSeries` — plus the cumulative-ends-on-the-card assertion, re-run on a book whose two date fields disagree. |
| **Scope** | `BOS_ISSUED_STATUSES` is still `['issued','paid']`; a `pending` straddler is still not issued AP, it just now has the right month. |

**The no-fourth-copy guards were negative-tested**, not merely asserted — three
mutated copies of `app.html` were run past them:

```
clean app.html                         chain-hits=0  unclassified=0  -> PASSES (green)
a fourth copy, exact old shape         chain-hits=1  unclassified=1  -> FAILS (caught)
a fourth copy, reformatted over lines  chain-hits=1  unclassified=1  -> FAILS (caught)
an UNCLASSIFIED dateSubmitted line     chain-hits=0  unclassified=1  -> FAILS (caught)
```

The multi-line case matters: a re-formatted copy is exactly how a duplicate
survives a regex written to catch the original's one-liner.

### Extended — `test/bo-summary.test.mjs`, 67 → 71

Four new tests: the submitted month decides; **every draft-only fixture in the
file is unchanged** (branch 2, the common case); the cards, mix and chart move
together across three window shapes with the cumulative assertion re-run; and
`bos-chart-core` contains no date-field chain of its own — asserting the block
mentions neither `p.dateSubmitted` nor a bare `p.draft`, since `draft` is when
the premium is taken, not when the policy was sold.

The existing test *"a policy with no draft date is on no timeline"* **passes
unmodified** — its fixture id is `'x'`, not a millisecond stamp, so the third
branch yields `null`. Its title and comment were corrected to say why, because
"no draft date" no longer describes what it tests.

### One deliberate divergence from byte-equivalence

`ppProductionDate()` returns `null` for a junk id where all three old copies
**threw** — `new Date(NaN).toISOString()` is a `RangeError`, raised from inside
a `.filter()`, i.e. the Ledger Summary would have rendered nothing at all rather
than one policy wrong. A test asserts both halves: the new resolver returns
`null`, and `OLD_lgSubDate` throws. No real policy is affected (every id is a
`Date.now()` stamp), so this changes no screen — it removes a way one could go
blank.

### Unmodified, as required

```
$ git status --porcelain test/leaderboards.test.mjs test/team-roster.test.mjs
(empty)
```

`test:leaderboards` 60/60 and `test:team` 57/57, both green against unedited
files.

---

## A note on a mistake worth recording

The first run of `npm test` after the code change failed `test:team` with a
`SyntaxError`, not an assertion. Cause: a comment I added to `_dailySeries`
contained the literal text `// <team-core>` while explaining where the live
resolver lives. That is a **second sentinel**, 850 lines above the real block,
and the harness extracts by lazy match — so `block('team-core')` swallowed
everything from my comment to the real closing sentinel.

This is the exact trap CLAUDE.md documents ("a comment mentioning `// <x-core>`
above the real block swallows the file"), walked straight into while writing a
comment about not repeating past mistakes. Both mentions were reworded to "the
team-core block". All six sentinels re-counted at exactly 1.

---

## Verification

| Check | Result |
|---|---|
| `npm test` | **green** — 33 suites, every one `fail 0` |
| `npm run check` | `0 new error(s), 0 new warning(s), 12 known (baselined)` |
| `scripts/check-app.baseline.json` | untouched |
| `git status --porcelain supabase/` | *(empty — pasted below)* |
| `git diff package.json` | two lines: the new `test:productiondate` script and its place in the chain |
| New dependency | none |
| Office split / billing / Stripe / wallet / AI kill switches | untouched |

```
$ git status --porcelain supabase/
$
```

*(empty — no backend change of any kind)*

Files changed: `app.html`, `package.json`, `test/bo-summary.test.mjs`,
`test/production-date.test.mjs` (new), `CLAUDE.md`,
`docs/back-office-summary.md`, `docs/reports/PROMPT_FO4-report.md` (pending item
4 marked closed) and this report.

### Executed vs reasoned

- **Executed:** every figure, bucket, carrier row, series and KPI card in the
  before/after section; the equivalence fixtures; the negative test of the
  no-fourth-copy guards; the `_dailySeries` call-site count; the sentinel
  count; all 17 new and 71 `bosummary` assertions; the full `npm test` suite;
  `npm run check`.
- **Reasoned, not executed:** anything needing a browser or the live database —
  see the pending list.

---

## Numbered eyeball checklist for Jace

Short one. You need a policy whose **Submitted** and **Draft** dates are in
different months; if you do not have one, make one on the Policy Tracker with
status Issued.

1. **Open the Policy Tracker** and find (or add) a policy with Submitted in one
   month and Draft in the next — e.g. submitted 27 June, drafts 3 July. Note its
   client name, its AP, and both dates.
2. **Front Office → Summary.** Pick that policy's **submitted** month from the
   period control. Confirm the policy is in the count and its AP is in the
   total. (This is the screen that was already right — it should look exactly
   as it did yesterday.)
3. **Flip the sidebar to Back Office → Summary.** Pick the **same** month.
   Confirm the policy now appears here too: it should be in "Policies issued"
   and its AP in "Personal issued AP".
4. **Now pick the DRAFT month on the Back Office Summary.** The policy should
   **not** be there. Before this change it was — that reversal is the whole
   round.
5. **Check the graph on the submitted month.** The step up should land on the
   **submitted day**, not the draft day.
6. **Check the carrier mix on both months** and confirm it agrees with the cards
   above it — that carrier's count and AP should sit in the submitted month.
7. **Compare the two summaries side by side** on the same month. The set of
   policies each one is counting should now be consistent. They will still show
   **different AP totals** — the Front Office counts everything you sold, the
   Back Office counts only what the carrier issued or paid — and both cards say
   so underneath. That difference is intended and was not touched.
8. **Look at your lifetime totals on both screens** before and after you next
   deploy, if you want a sanity check on scale — see pending item 1.

---

## PENDING LIVE VERIFICATION

Everything below is fixture-tested or reasoned and has **not** been seen against
the live database or in a browser.

1. **🔴 HOW MUCH THE REAL BOOK MOVES.** This is FO4's pending item 4, inherited
   and still open — the decision it was waiting on is made, but the *size* of
   the effect on the live book is unmeasured. One query answers it:
   ```sql
   select count(*) filter (where data->>'dateSubmitted' is not null
                             and data->>'draft' is not null
                             and substr(data->>'dateSubmitted',1,7)
                                 <> substr(data->>'draft',1,7)) as straddlers,
          count(*) filter (where coalesce(data->>'dateSubmitted','') = ''
                             and coalesce(data->>'draft','') = '')       as neither,
          count(*)                                                        as total
   from public.policies;
   ```
   `straddlers` is how many policies change month on the Back Office Summary;
   `neither` is how many appear on its timeline for the first time (the "Grant"
   case). If both are 0, this round is a no-op on today's data and pure
   insurance against tomorrow's. **Worth running before telling anyone their
   numbers changed.**
2. **The monthly/lifetime figures an owner actually sees.** The before/after
   above is a fixture book, not the production one. The AP card, the graph and
   the carrier mix have not been rendered against the live 23-policy book since
   the change.
3. **Every visual claim.** No browser was opened. The graph's axis at real
   widths after the Lifetime span grew by a bucket, the label-density heuristic
   on a longer axis, dark mode, hover, focus and the phone breakpoint are all
   unverified — as they were at the end of FO4.
4. **The Policy Tracker's period drill-in.** `_ptSubForRange` is proved
   equivalent by fixture, but the drill-in was not clicked. Its filter
   string-compares against `''`, which is why the alias keeps `|| ''` at the
   call site; that is unit-tested, not exercised.
5. **The record nudges** (`_lbCurrentTotals`). Now gains the id-timestamp
   fallback it never had, so a policy with neither date can newly count toward
   best-day / best-week / best-month. Consistent with the Ledger Summary by
   design, but it means a *record* could in principle be set by a policy that
   previously counted nowhere. Unverified live; likely zero policies affected —
   pending item 1's `neither` count is the same number.
6. **`_dailySeries()` is still in the file.** Confirmed to have no callers and
   now labelled as dead, but not deleted. If it is ever revived, it must be
   moved onto `ppProductionDate()` first — it is the only remaining
   `p.draft`-only bucketer in `app.html`.
