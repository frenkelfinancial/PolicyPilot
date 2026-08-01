# The Back Office Summary

The landing screen for the money office. An agency owner flips the toggle and
this answers, without a single click: **what came in, what is owed, what is
stuck, and is my book healthy.** Before it, the toggle landed on a policy list
and the owner had to go looking.

Round 2 of the office split (`docs/office-split.md`). Code: `app.html` —
the `// <bo-summary-core>` block (pure math) and `renderBackOfficeSummary()`
(the renderer). Tests: `npm run test:bosummary` → `test/bo-summary.test.mjs`.

---

## 🔴 It adds no backend, and that is the constraint that shaped it

No migration, no edge function, no new RPC, no schema change. Every figure
comes from something that already shipped:

| RPC | Feeds |
|---|---|
| `get_commission_buckets(p_start, p_end)` | Net Commission, Personal Sales, Override Income |
| `get_commission_debt(null, null)` | Outstanding Debt |
| `get_reconciliation_summary(45)` | the three attention counts |
| `get_downline_persistency(null)` | 13-month and 25-month, and team persistency |
| `get_ingestion_summary()` | the empty-state predicate |
| `get_downline_commission_rollup(p_start, p_end)` | team production, leaders only |
| `loadTeamRoster(_teamPeriod)` | downline headcount, leaders only |

**It never selects `commission_rows` from the browser.** That table is
SELECT-only per tenant and the aggregates exist precisely so a screen does not
do this. A test greps the loader for it.

**The team roster comes through `loadTeamRoster()`, not a query of its own.**
There is exactly ONE `sb.rpc('get_team_summary')` call site in this app and a
second one is how the two team surfaces drifted into an 8,610× AP
overstatement — see `docs/agency-team-screen.md`. A test still pins the count
at one, and pins that this screen reaches it through the roster loader.

---

## The four strips

### 1. The money

Range chips are **the Commissions panel's own** — `COMM_RANGES` and
`commRange()`, MTD / YTD / All time, sharing `_cmRange` and the
`pp_comm_range` key. One range, one memory, one calculator: picking YTD here
and finding MTD one click away would make two screens disagree about the same
money. There is deliberately no fourth chip (see "Suggestions", below).

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

**Empty state.** An agent who has never uploaded a statement gets one friendly
panel and a button, not a grid of dashes. `bosIsEmpty()` requires zero
*processed* statements **and** nothing in flight and nothing failed: a
statement still parsing is a screen about to fill itself in, and a failed one
is a job to go and fix. Neither should be greeted with "Nothing here yet."

**Read-only.** Nothing on this screen writes. A test greps the whole renderer
for `.insert(`, `.update(`, `.upsert(`, `.delete(` and `functions.invoke(`.

**Money goes through `boFmtMoney()`** — the shared formatter, never a second
one, and never recomputed from a float.

**Both themes.** The screen's own CSS uses `var(--lg-*)` tokens only; a test
asserts there is no hard-coded hex in it.

---

## Counts are never NaN

`Number('x' || 0)` is `NaN`, and `Math.max(0, NaN)` is `NaN` too — so the
obvious guard is not one. `bosCount()` maps anything non-finite or negative to
zero and `bosCents()` does the same while keeping a negative, because on money
a negative is real. "NaN things need a look" is how a dashboard announces that
it has stopped working. Found by the unit test, not by inspection.

---

## Suggestions, deliberately not built

- **A quarter-to-date range chip.** Carrier bonus periods are quarterly and a
  QTD chip would sit naturally beside MTD/YTD — but `COMM_RANGES` is shared
  with the Commissions panel, so adding one changes two screens and is a
  decision, not a dashboard tweak.
- **"Statements ingested this week."** `get_ingestion_summary()` already
  returns `ingested_7d` and `rows_7d`, and `boSummaryLine()` already renders
  the sentence. It was left off because the strip it would belong to ("what
  came in") is answered better by the money, and a fifth card competing with
  four is worse than four.

## Wanted and not available

- **Debt aged by carrier** — `get_commission_debt` returns `last_at` per
  carrier but no ageing buckets, so "how long has this balance been sitting"
  cannot be answered without a new RPC.
- **Team production versus last period** — `get_downline_commission_rollup`
  takes one window. A comparison needs a second call with the prior range,
  which is affordable but is a product decision about what the team strip is
  for, not a gap in the data.

---

## Files

| File | What |
|---|---|
| `app.html` | `// <bo-summary-core>` block, `renderBackOfficeSummary()` and the `bos*` renderers, `#sec-bo-summary`, the nav item, the CSS |
| `test/bo-summary.test.mjs` | 40 tests — the core executed verbatim, plus the structural invariants |
| `test/office-split.test.mjs` | the Back Office nav list and `OFFICE_HOME.back` |
| `docs/reports/PROMPT_FO2-report.md` | build report, RPC shapes, eyeball checklist |
