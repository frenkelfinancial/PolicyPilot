# The Back Office Summary

> **🔴 RETIRED FROM THE SIDEBAR 2026-08-01 — THE CODE IS STILL HERE AND STILL
> TESTED.** The owner replaced this screen with the Front Office's Summary:
> *"instead of having different summary pages for front office and back office,
> just have the same summary page."* `OFFICE_HOME.back` is `'summary'`, the
> Back Office's nav item points at `nav('summary')`, and `OFFICE_OF.summary` is
> `'both'`. **Nothing was deleted** — `#sec-bo-summary`,
> `renderBackOfficeSummary()`, both pure cores and all 71 tests in
> `test/bo-summary.test.mjs` are unchanged and green, and the rest of this doc
> describes them accurately. What is no longer true is only that an agent can
> get here from the sidebar. `_isRestorableSection('bo-summary')` is now
> `false` by design. Details: `docs/office-split.md` § "Undone 2026-08-01".

The landing screen for the money office. An agency owner flips the toggle and
this answers, without a single click: **what I wrote, what it is worth, who is
producing, what came in, what is owed, what is stuck, and is my book healthy.**
Before it, the toggle landed on a policy list and the owner had to go looking.

Round 2 of the office split built it (`docs/office-split.md`); **Round 4
rebuilt it on policy data** — see below. Code: `app.html` — the
`// <bo-summary-core>` and `// <bos-chart-core>` blocks (pure math) and
`renderBackOfficeSummary()` (the renderer). Tests: `npm run test:bosummary` →
`test/bo-summary.test.mjs`.

---

## 🔴 Round 4 — why this screen was rebuilt

**Round 2 rendered nothing for the owner.** Not a bug — a design mistake. Every
card on it read from a **carrier commission statement**, and its own
`bosIsEmpty()` blanked the entire page with a *"Nothing here yet — drop your
first carrier statement in"* panel when none had been uploaded. An agency owner
with a full book of policies and no parsed statements got a welcome mat.

Round 4 rebuilds the top of the screen on **policy data**, which every agent has
from day one. The statement-derived material is unchanged and still there — it
just moved below, and it no longer decides whether the page has anything on it.

**The page-level empty state is gone.** What replaced it:

| Condition | What renders |
|---|---|
| Policies, no statements | the whole screen; "Commission paid" is a dash, and the money strip is one sentence |
| Statements, no policies | the whole screen; the graph draws a flat baseline and says so |
| Neither | ONE friendly panel pointing at **Add Policy** — not at statement upload |

---

## 🔴 Two AP questions on one screen, and they will not agree

`BOS_ISSUED_STATUSES` in `// <bos-chart-core>` is **a third, deliberate AP
question**, distinct from the sale predicate this app already had. It is named
for the question it answers precisely because the other one is one strip away.

| | Counts | Excludes |
|---|---|---|
| **Personal issued AP** (`BOS_ISSUED_STATUSES`) | `issued`, `paid` | everything else, including `pending` and `approved` |
| **Top Producers board** (`lb_agent_metrics` / `get_team_summary`) | everything except `BOB_NOT_A_SALE` | `lapsed`, `chargeback`, `denied`, `withdrawn` |

Worked example — one agent, July 2026, nine policies, $25,200 written:

```
Personal issued AP            $10,200   3 policies   issued + paid
Top Producers board, Net AP   $21,300   5 policies   + pending, approved, claim
                              -------
Divergence                    $11,100   = pending $5,100 + approved $3,300 + claim $2,700
```

**Both are right about their own question.** Do not "reconcile" them by changing
either. `lb_agent_metrics()` is byte-identical to `get_team_summary`'s `pol` CTE
and a test compares them character for character — editing it to match this
screen would break the boards and the team table together, which is the 8,610×
bug with a shorter fuse.

What the screen does instead is **say so, out loud, in two places**: the AP card
carries `BOS_ISSUED_DEF` underneath it, always on, and the Top Producers card
ends with *"…it counts pending and approved-not-paid business too, so it will
not match your issued figure above."*

### A past period can shrink, and that is intended

Because a lapsed or charged-back policy **leaves** the issued-AP figure, March's
bar is lower in June if a March policy lapsed in May. The owner was shown this
trade-off on 2026-08-01 and chose it deliberately. **Do not add a snapshot, a
freeze, or an as-of date to work around it.** A test pins the behaviour.

---

## 🔴 It adds no backend, and that is the constraint that shaped it

No migration, no edge function, no new RPC, no schema change — in Round 2 or
Round 4. Every figure comes from something that already shipped:

| Source | Feeds |
|---|---|
| `window.policies` (in memory, hydrated by `bootDashboard()`) | Personal issued AP, Est. commission, Policies issued, carrier mix, the graph |
| `get_commission_buckets(p_start, p_end)` | Commission paid, Net Commission, Personal Sales, Override Income |
| `get_commission_debt(null, null)` | Outstanding Debt |
| `get_reconciliation_summary(45)` | the three attention counts |
| `get_downline_persistency(null)` | 13-month and 25-month, and team persistency |
| `get_ingestion_summary()` | the "no statements" predicate |
| `get_downline_commission_rollup(p_start, p_end)` | team production, leaders only |
| `loadTeamRoster(_teamPeriod)` | downline headcount, leaders only |
| `lb_my_agency_state()` *(via `lbAgencyState()`)* | whether the Top Producers card exists at all |
| `get_agency_leaderboards(...)` *(via `lbLoadBoards()`)* | the Top Producers board |

**It never selects `commission_rows` from the browser.** That table is
SELECT-only per tenant and the aggregates exist precisely so a screen does not
do this. A test greps the loader for it. It does not select `policies` either —
the book is already in memory.

**The team roster comes through `loadTeamRoster()`, not a query of its own.**
There is exactly ONE `sb.rpc('get_team_summary')` call site in this app and a
second one is how the two team surfaces drifted into an 8,610× AP
overstatement — see `docs/agency-team-screen.md`. A test still pins the count
at one, and pins that this screen reaches it through the roster loader.

**The board comes through `lbLoadBoards()`, the ONE
`get_agency_leaderboards` call site.** That is what carries
`lb_visible_members()`, the single enforcement point for the leaderboard
opt-out: an agent who has hidden themselves is on no board including this one.
Querying around it would put them back on it. See "The period control" below
for how a second window rides that one call site without giving the leaderboard
a period engine.

---

## The period control — this screen's own window

Round 2 borrowed the Commissions panel's three MTD/YTD/All chips, because every
figure on the screen came off a statement. Round 4 reads the book, and the owner
asked for the control the rest of ProducerStack has: **Daily (labelled Today),
Weekly, Monthly, Lifetime, a past month, and a custom range** — the same
`LG_PERIODS` chips plus the same shared `ppPeriodPickerHTML()` the Front Office
Summary uses.

**It is stored under its own key, `pp_bos_period`.** `pp_summary_period` belongs
to the Front Office Summary and `pp_team_period` to the Agency tab; writing
either from here would move another screen's window when an owner clicked a chip
on this one. A test asserts this screen writes `pp_bos_period` and nothing else.

**Every date comes out of `summaryPeriodRange()`.** `bosRange()` is the only
caller and this screen mints no dates of its own.

Two things had to change elsewhere for that to be true, and both were bugs
waiting to happen:

- **`ppApplyRange()` dispatches on the setter name** and previously fell through
  to `setLedgerPeriod` for anything that was not the Agency tab. Applying a
  custom range here would have written `pp_summary_period` — silently moving the
  Front Office Summary. It now has an explicit `setBosPeriod` branch.
- **`ppPeriodPickerHTML()` builds its range-picker id as `'pp-rng-' + surface`,**
  and the Front Office Summary already owns `pp-rng-sum`. Both sections are in
  the DOM at the same time, merely hidden, so this screen passes the surface
  `'bos'`. Without it, `getElementById()` hands the toggle and the Apply button
  the *other* screen's control.

**The window is captioned by what it is, not by the comparison it enables.**
`summaryPeriodRange()` labels a window "This month vs last month" because the
Front Office Summary renders a delta against it. This screen renders no delta,
so `bosPeriodLabel()` says "This month". A picked month or a custom range
already labels itself and is used verbatim.

**The Commissions panel is untouched** — it keeps `COMM_RANGES`, `commRange()`,
`_cmRange` and `pp_comm_range`. **Debt is still never range-filtered on either
screen** (`bosDebtArgs()` returns `{p_start:null, p_end:null}` and a test passes
three different ranges through and asserts the balance does not move).

---

## The strips

### 0. Your production — the four cards

| Card | Source | Note |
|---|---|---|
| **Personal issued AP** | `bosIssuedAP(window.policies, range)` | carries `BOS_ISSUED_DEF` underneath, always on |
| **Est. commission** | `_lgAdvComm()` summed over the same policies | the app's ONE advance formula, taken as a parameter, never re-typed |
| **Commission paid** | `commTotals(get_commission_buckets(...)).net` | **a dash and a sentence when no statement exists — never `$0.00`** |
| **Policies issued** | count of the same set | same set, same window |

**Two units, two formatters, one definition each.** `policies[].ap` is a dollar
figure the agent typed, so AP and the estimate render through `_lg$()` — the
same formatter the Front Office Summary's AP card uses. Commission rows are
integer cents from a carrier statement, so they render through `boFmtMoney()`.
What there is never two of is a *definition*.

#### 🔴 Which month a policy counts in — `ppProductionDate()` (Round 5)

**A policy counts on `dateSubmitted → draft → the id's timestamp`, and that is
the app's one answer.** `bosPolicyDay()` is a one-line delegation to
`ppProductionDate()` in the `team-core` block, and it is the single seam every
figure on this screen runs through: the four cards, the carrier mix and every
bucket of the graph.

**This changed in Round 5, and the change was the point.** Round 4 bucketed on
`p.draft` alone — the field the (dead) `_dailySeries()` helper used. The Front
Office Ledger Summary's KPI cards have always sliced on the full chain via
`_lgSubDate()`. So a policy **submitted in June that drafts in July** was June
production in the Front Office and July production here: the same policy, two
months, one sidebar toggle apart. Owner's decision on 2026-08-01 was
submitted-first for both — *submitted is when the agent did the work; the draft
date is only when the carrier takes the premium.*

Measured on an eight-policy fixture book (`docs/reports/PROMPT_FO5-report.md`
has the full before/after): six of eight policies changed bucket here, the
Front Office moved on **none** of its six windows, and the count of policies the
two screens placed in different months went from **6 to 0**.

**🔴 THIS IS A *WHEN* QUESTION, NOT A *WHAT COUNTS* QUESTION.** Round 5 did not
touch `BOS_ISSUED_STATUSES`, the sale predicate, or `lb_agent_metrics()`. The
issued-vs-sold gap between Personal issued AP and the Top Producers board is
unchanged and still explained on both cards — see § "Two AP questions on one
screen". Consolidating the date did not, and must not, reconcile the statuses.

**A fourth copy of the chain is a test failure.** There were three
(`_lgSubDate`, `_ptSubForRange`, and an inline slice in `_lbCurrentTotals`);
`test/production-date.test.mjs` classifies every `dateSubmitted` line in
`app.html` and fails on one it does not recognise. `_ptGetSub()` is deliberately
**not** the resolver — it fills the tracker's *Submitted* column and has no
draft fallback on purpose.

### 0b. Issued AP over time — the production graph

Hand-rolled SVG. **No chart library and no new dependency.** All bucketing and
cumulative arithmetic lives in the pure `// <bos-chart-core>` block; the
renderer only draws what it returns. Every bucket boundary keys off
`bosPolicyDay()` → `ppProductionDate()`, so the graph cannot drift from the
cards above it.

> **Do not cite `_dailySeries()` as evidence of what anything buckets on.**
> Verified 2026-08-01: it has **no callers** — the only two occurrences of the
> name in `app.html` are its own declaration and one comment. It is the last
> place in the file still keying on `p.draft` alone, and quoting it is exactly
> how this screen came to disagree with the Front Office. It was left in place
> because deleting dead code is its own decision, not this round's.

**Cumulative**, so the line only climbs within the window shown. Granularity is
derived from the selected period:

| Period | Buckets |
|---|---|
| `daily` (Today) | **last 7 days**, one per day, today's segment emphasised |
| `weekly` | 7 daily buckets, Mon–Sun |
| `monthly` | one per day of the current month |
| `month:YYYY-MM` | one per day of that month |
| custom ≤ 62 days | one per day |
| custom > 62 days | weekly buckets, aligned to Monday |
| `lifetime` | monthly buckets, from the earliest issued policy to today |

**🔴 "Today" draws seven days, not twenty-four hours.** There is no sale-time
timestamp anywhere in this schema — only the moment a row was entered — so an
hourly axis would plot data-entry habits rather than production. That is the
same evidence `docs/agency-leaderboards.md` records for cutting the Early Bird
and Closer badges. It is also the one period where the graph's window is wider
than the cards': the cards count today, the graph shows the week around it, and
the graph says so in its own caption.

A test asserts the series is non-decreasing and that **its last value equals
`bosIssuedAP()` over the same window** — the assertion that catches the graph
and the card disagreeing. All-zero, single-bucket and empty inputs each return a
renderable series; the empty case draws a dashed baseline and *"No issued
production in this period."*, never a broken axis.

### 0c. Carrier mix

Every carrier written under in the window, with policy count, total AP and a
share bar, biggest first. `policies[].carrier` already holds a **label** (the
tracker stores the label from `TRACKER_CARRIER_LIST`, not a key) and the
persistency screen segments on it raw, so this does too — but grouping is case-
and whitespace-insensitive, so "Americo " and "americo" cannot become two rows.
The label shown is the spelling used most often, so nothing is invented either.
A blank carrier renders as "No carrier recorded" rather than vanishing.

### 0d. Top producers

The agency's **Net AP** board for the selected window, through `lbLoadBoards()`.

- **Visible to everyone in an agency** — not gated on plan tier and not gated on
  being the leader. Everyone sees where they stand.
- **An agent in no agency gets no card at all** — not an empty one, not an
  upsell. `_lbState.leader_id` decides, and the gate is checked before anything
  is built.
- It renders through `lbBoardHTML()`, so the medals, the top-10 cutoff and the
  private own-rank row are the Agency tab's, not a second copy. `lbSplitRows()`
  still trusts `in_top` and this card never mentions `LB_TOP_N` except in the
  sentence that explains it.
- The basis is pinned to `LB_BASIS_DEFAULT` (`net`), the app's one definition of
  a sale, and the card says what that means.

**How a second window rides the one call site.** `lbLoadBoards()` grew an
optional fourth argument, `rangeOverride`, defaulting to exactly what it read
before:

```js
const range = rangeOverride || teamPeriodRange(periodKey, new Date());
```

This does **not** give the leaderboard a period engine — it still has none and
still mints no dates. The *caller* supplies the window, which is what the Agency
tab already does implicitly by handing over `_teamPeriod`. Omit the argument and
the behaviour is byte for byte what it was; a test asserts the default, and a
parity run confirmed the RPC arguments are identical for every period key.

The cache is keyed by the **range**, not the period name (`lbRangeKey()`),
because `'monthly'` means one thing to `summaryPeriodRange()` and falls back to
`TEAM_PERIOD_DEFAULT` in `teamPeriodRange()`. Two windows behind one string is
exactly how two screens serve each other a stale board.

### 1. The money, from your statements

Unchanged from Round 2 except for two things: it sits **below** the policy
material now, and it is measured over `pp_bos_period` rather than the
Commissions panel's `pp_comm_range` (see "The period control", above).

**When no statement has been uploaded, this strip is one sentence, not four
`$0.00`s.** Every figure on it comes off a statement, so four zeroes read as
"the carriers paid you nothing" rather than "we have not been told yet" — the
same rule as the Commission paid card. This is where Round 2's page-level empty
state usefully survives, scoped to the one strip it was ever actually about.

| Card | Definition |
|---|---|
| Net Commission | every line added up, bonuses and adjustments included |
| Personal Sales | own advance + renewal, net of chargebacks on own lines |
| Override Income | override lines — from agents in your hierarchy |
| Outstanding Debt | chargeback + adjustment, reported as a positive balance |

The definitions render **under** each number, always on — that is the card's
point, not a tooltip — and they are `COMM_CARD_DEFS` from comm-core rather than
re-typed strings. Two wordings of "what actually reached your bank", one click
apart, is exactly the drift the core blocks exist to stop.

**🔴 DEBT IS NEVER RANGE-FILTERED.** `bosDebtArgs()` returns
`{ p_start: null, p_end: null }` and nothing else, and it is a function rather
than a literal so a test can pin it. `bosMoneyCards()` accepts the selected
range and does not let it near the balance; a test passes MTD, YTD and All time
and asserts the figure does not move. The card says so in small print, because
the chips sit directly above it. You owe a carrier what you owe them.

**Override Income is DROPPED, not zeroed, when it is zero and the agent has no
hierarchy.** A permanently empty card on the screen an owner sees every day is
noise; it comes back on its own the first time an override line lands. "Has a
hierarchy" believes the roster first and the rollup second, because the rollup
only knows agents who already have a commission line.

### 2. What needs you

The three reconciliation queues, by the keys `rcSetQueue()` already accepts —
a test asserts they are `RECON_QUEUES`', so a card cannot open a queue the
panel does not have. Each card opens its own queue: `bosOpenQueue()` selects
the queue **before** showing the panel, so the agent lands on the count they
clicked rather than whichever queue they last looked at.

**One line of plain English sits above them, always.** "6 things need a look",
or "Nothing needs your attention right now." Three zeroes with no sentence
reads as a broken screen rather than a clean desk.

This strip **counts; it does not rank.** Priority follows the money and that
rule lives in the Reconciliation panel, which owns it.

### 3. Book health

13-month and 25-month persistency, banded green ≥ 85 / yellow 70–84 / red
< 70 by `persistBand()` — the same function the Persistency panel uses, because
those boundaries are what carrier bonus programmes are written against.
The legend is rendered, because a colour with no key is a decoration.

**🔴 NO RATE IS NOT A ZERO RATE.** An absent cohort renders `—` plus a
sentence, never `0%`. Painting a red band on an agent who has simply not been
writing long enough is the single most misleading thing this screen could do.
A **real** zero survives: a cohort of eight with nothing kept is `0%` in red,
because that is a fact about the book rather than a missing one.

**A thin cohort (< `BOS_MIN_COHORT`, 3) also renders `—`, and says which.**
One lapse in a two-policy cohort is a 50% headline on the owner's landing
screen. This is a **deliberate difference from the Persistency panel**, which
shows thin segments flagged rather than suppressed: the panel is where you go
to look at detail, this is the one screen that refuses to headline a number it
cannot support. The card says "Only 2 policies are old enough to count — too
few for a rate", so the difference is stated rather than silent.

### 4. Your team — LEADERS ONLY

`_planTier() === 'leader'`, checked before anything is built. Downline
headcount, team production for the selected range, and 13-month persistency
pooled across the whole agency.

**For everyone else the strip is ABSENT** — not empty, not hidden, not a locked
upsell card. `bosTeamHTML()` returns `''` and `bosTeam()` returns `null`. The
upgrade gate already lives on the features that need it; a permanently greyed
strip on the landing screen is noise every single day. A test asserts the
non-leader path produces no team markup at all, and that the gate is checked
before any card is constructed.

Aggregates only — no client, no policy, no agent's book. That is enforced by
what `get_downline_commission_rollup` selects, not by what this renders.

---

## Behaviour

**Skeletons, then numbers.** The frames paint before a single byte comes back
and each strip fills the moment its own data lands.

**`Promise.allSettled`, never `Promise.all`.** One rejected RPC puts
*"Couldn't load — open <the screen that owns it> to see this"* on that strip
and leaves the rest of the page standing. A dashboard that blanks because the
persistency RPC hiccuped is worse than no dashboard. A test asserts
`Promise.all(` does not appear in the loader.

**Every card is a door**, opened with `boArea()` — never by reaching into a
`bopanel-*` element, which is the two-place edit `boArea()` exists to prevent.

**Empty state (Round 4).** The page-level branch is **gone**. `bosIsBrandNew()`
requires **no policies AND no statements**, and only then renders one friendly
panel pointing at Add Policy. `bosIsEmpty()` is unchanged and still answers the
statement question — it requires zero *processed* statements **and** nothing in
flight and nothing failed, because a statement still parsing is a screen about
to fill itself in and a failed one is a job to go and fix — but it now governs
only two things: the Commission paid card's dash, and the money strip's
sentence. It no longer decides whether the page has anything on it.

**Read-only.** Nothing on this screen writes. A test greps the whole renderer
for `.insert(`, `.update(`, `.upsert(`, `.delete(` and `functions.invoke(`.

**Money goes through the formatter that owns its unit** — `boFmtMoney()` for
statement cents, `_lg$()`/`_lgKk()` for the dollar AP the agent typed. Never a
second one, and never recomputed from a float.

**Both themes.** The screen's own CSS uses `var(--lg-*)` tokens only; a test
asserts there is no hard-coded hex in it, and a second test asserts the same of
the graph, the mix, the cards and the chip row as rendered markup.

---

## Counts are never NaN

`Number('x' || 0)` is `NaN`, and `Math.max(0, NaN)` is `NaN` too — so the
obvious guard is not one. `bosCount()` maps anything non-finite or negative to
zero and `bosCents()` does the same while keeping a negative, because on money
a negative is real. "NaN things need a look" is how a dashboard announces that
it has stopped working. Found by the unit test, not by inspection.

---

## Suggestions, deliberately not built

- **An hourly axis for "Today".** Refused on evidence — see the graph section.
  There is no sale-time timestamp in this schema.
- **A snapshot or as-of date so a past period cannot shrink.** Refused by the
  owner on 2026-08-01; the shrink is the honest reading of the definition.
- **A comparison delta against the prior period.** `summaryPeriodRange()`
  already returns `prevStart`/`prevEnd` and the graph could carry a ghost line,
  but "issued AP is down 12%" on a figure that re-writes history when a policy
  lapses is a sentence that needs thinking about before it is printed.
- **"Statements ingested this week."** `get_ingestion_summary()` already
  returns `ingested_7d` and `rows_7d`, and `boSummaryLine()` already renders
  the sentence. It was left off because the strip it would belong to ("what
  came in") is answered better by the money.

## Wanted and not available

- **Debt aged by carrier** — `get_commission_debt` returns `last_at` per
  carrier but no ageing buckets, so "how long has this balance been sitting"
  cannot be answered without a new RPC.
- **Team production versus last period** — `get_downline_commission_rollup`
  takes one window. A comparison needs a second call with the prior range,
  which is affordable but is a product decision about what the team strip is
  for, not a gap in the data.
- **A carrier mix weighted by commission rather than AP** — `commPct` is on the
  policy, so it is computable, but the Commissions panel already answers "what
  did each carrier pay me" from statements, which is the better source.

---

## Files

| File | What |
|---|---|
| `app.html` | `// <bo-summary-core>` and `// <bos-chart-core>` blocks, `renderBackOfficeSummary()` and the `bos*` renderers, `#sec-bo-summary`, the nav item, the CSS |
| `app.html` (`lbLoadBoards`) | the optional `rangeOverride` and `lbRangeKey()` |
| `app.html` (`team-core`) | `ppProductionDate()` — the app's one production-date resolver (Round 5) |
| `test/bo-summary.test.mjs` | 71 tests (40 before Round 4, 67 before Round 5) — both cores executed verbatim, plus the structural invariants |
| `test/production-date.test.mjs` | 17 tests — the resolver's four branches, the equivalence proof that the Front Office did not move, and the no-fourth-copy sweep |
| `test/office-split.test.mjs` | the Back Office nav list and `OFFICE_HOME.back` |
| `test/leaderboards.test.mjs` | the one-call-site and no-period-engine invariants, unmodified |
| `docs/reports/PROMPT_FO2-report.md` | Round 2 build report |
| `docs/reports/PROMPT_FO4-report.md` | Round 4 build report, divergence numbers, eyeball checklist |
| `docs/reports/PROMPT_FO5-report.md` | Round 5 — one production date, before/after for both screens |
