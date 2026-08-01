# PROMPT FO4 — The Back Office Summary reads the book, not just the statements

Round 4 of the office split. Rebuilds the Back Office Summary on **policy
data**, which every agent has from day one, and demotes the statement-derived
material from "the whole screen" to "one strip among several".

Full build. Steps 1–9 all shipped; nothing was deferred to the fallback
boundary.

---

## What was actually wrong

Round 2's screen rendered **nothing** for the owner. Every card read from a
carrier commission statement, and `bosIsEmpty()` blanked the entire page with a
*"Nothing here yet — drop your first carrier statement in"* panel when none had
been uploaded. An agency owner with a full book of policies and no parsed
statements flipped the toggle and got a welcome mat.

Verified by running the shipped renderer headlessly against a book of eleven
policies and an ingestion summary of all zeroes — see § "Rendered output",
state D.

---

## Step 0 — inventory, with line numbers

Every helper the prompt named was verified present before a line was written.
Line numbers are pre-change (`git show HEAD:app.html`).

### Period engine — reused, not rebuilt

| Helper | Line | Note |
|---|---|---|
| `LG_PERIODS` | 18211 | `['daily','weekly','monthly','lifetime']`, as stated |
| `ppPeriodPickerHTML(active, setter, surface, cls)` | 18293 | as stated |
| `summaryPeriodRange(period, today)` | 15739 | returns `{start,end,prevStart,prevEnd,label}`; delegates to `ppDynamicRange` first |
| `ppDynamicRange(key)` | 16760 | |
| `ppParsePeriodKey` / `ppDay` / `ppIsDynamicPeriod` | 16723 / 16737 / 16744 | |
| `ppToggleRange(id)` | 18315 | |
| `ppApplyRange(id, setter, surface)` | 18323 | **had moved on me — see "Two things that had moved"** |

### Design kit — reused, not restyled

| Helper | Line |
|---|---|
| `_lgCard(inner, pad)` | 18382 |
| `_lgStat(label, value, sub, color)` / `_lgLbl` | 18391 / 18390 |
| `_lgSkel(width)` | 18396 |
| `_lg$` / `_lgKk` | 18231 / 18232 |
| `.lg-af` (`--lg-min` / `--lg-gap`), `.lg-chip`, `.lg-click` | 3623 / 3637 / 3657 |
| `boFmtMoney(cents)` | 26807 |
| `--lg-*` tokens (dark then light) | 198–229 |

### Data — reused, not redefined

| Helper | Line | Note |
|---|---|---|
| `window.policies` | — | explicit `Object.defineProperty` alias, per CLAUDE.md |
| `BOB_NOT_A_SALE` | 14542 | **read, deliberately not used** — see § Divergence |
| `_lgAdvComm(p)` | 18263 | the ONE advance formula; taken as a parameter by the new core |
| `_dailySeries(pols, range, valueFn)` | 15832 | buckets on `p.draft` — confirmed |
| `_renderSparkline(svg, values)` | 15851 | studied for the SVG idiom; 200×50, not stretched into a chart |
| `get_commission_buckets` | 28090 | takes ISO-day strings, per `commRange()` at 26903 |
| `lbLoadBoards` / `LB_BOARDS` / `lbSplitRows` / `_lbState` / `lb_my_agency_state` | 17752 / 17437 / 17517 / 17714 / 17735 | |
| `bosAttentionHTML` / `bosHealthHTML` / `bosCount` / `bosCents` / `BOS_DEBT_NOTE` | 29254 / 29281 / 27636 / 27642 / 27648 | |

### Two things that had moved, or were not as the prompt assumed

1. **`p.draft` is not what the Ledger Summary's own cards bucket on.** The
   prompt says *"Bucket by the same date field `_dailySeries` already uses
   (`p.draft`), so this screen and the Ledger Summary place a policy in the same
   period."* The first half is right — `_dailySeries` does use `p.draft`
   (app.html:15841). The second half is only half right: the Ledger Summary's
   **sparkline** goes through `_dailySeries`, but its **KPI cards** slice with
   `_lgSubDate(p)` = `dateSubmitted → draft → id-date` (18246, 18431). So where
   a policy carries a `dateSubmitted` that differs from its `draft`, the Back
   Office AP card and the Front Office AP card will place it in different
   periods. I used `p.draft` as instructed and am flagging the discrepancy
   rather than silently choosing the other field. **Both screens agree whenever
   `dateSubmitted` is absent or equal to `draft`.**

2. **`ppApplyRange()` could not have dispatched to a third screen.** It ended
   `if (setter==='teamSetPeriod') …; else setLedgerPeriod(key);` — so a custom
   range applied on this screen would have fallen through and written
   **`pp_summary_period`**, silently moving the Front Office Summary. Fixed with
   an explicit `setBosPeriod` branch. This was not in the prompt's inventory and
   would have violated its own period-isolation rule.

   Related, same class: `ppPeriodPickerHTML()` builds its range-picker element
   id as `'pp-rng-' + (surface || 'sum')`. The Front Office Summary passes no
   surface and therefore owns `pp-rng-sum`; both sections are in the DOM at the
   same time, merely hidden. This screen passes surface `'bos'`. Without it,
   `getElementById()` would have handed `ppToggleRange()` and `ppApplyRange()`
   the *other* screen's control.

3. **There is no carrier label resolver to reuse.** `CARRIER_REGISTRY` (34310)
   and `TRACKER_CARRIER_LIST` (34695) map key → label, but `policies[].carrier`
   already stores the **label**, and both existing consumers read it raw —
   `persistBySegment(..., p => p.carrier || null, ...)` (28511) and
   `_renderCarrierDonut` (15879). So the mix reads it raw too, but folds on a
   normalised key (trim + collapse whitespace + lowercase) so one carrier cannot
   appear twice under two spellings, and displays the most common spelling.

---

## The expected divergence, in numbers

**This is the thing to look at before you look at the screen.** Two AP figures
sit two strips apart and they will not agree. Both are correct.

Computed by running the shipped `bosIssuedAP()` and the sale predicate against
one book, one agent, one window — July 2026, nine policies, $25,200 written:

| Policy | Status | AP | In *issued AP*? | On the *board*? |
|---|---|---|---|---|
| 1 | `issued` | $4,200 | ✅ | ✅ |
| 2 | `paid` | $3,600 | ✅ | ✅ |
| 3 | `issued` | $2,400 | ✅ | ✅ |
| 4 | `pending` | $5,100 | ❌ | ✅ |
| 5 | `approved` | $3,300 | ❌ | ✅ |
| 6 | `lapsed` | $1,800 | ❌ | ❌ |
| 7 | `chargeback` | $1,200 | ❌ | ❌ |
| 8 | `claim` | $2,700 | ❌ | ✅ |
| 9 | `withdrawn` | $900 | ❌ | ❌ |

```
Personal issued AP  (BOS_ISSUED_STATUSES)     $10,200    3 policies
Top Producers, Net AP  (lb_agent_metrics)     $21,300    5 policies
                                              -------
Divergence                                    $11,100    +108.8% on the board
  = pending $5,100 + approved $3,300 + claim $2,700
```

For completeness, the board's other basis — `placed` (issued, paid **or**
claim) — comes to **$12,900 / 4 policies**, still not equal, because a death
claim is a placed policy but is not issued-and-in-force.

**Why they are not reconciled.** `lb_agent_metrics()` is byte-identical to
`get_team_summary`'s `pol` CTE and `test/leaderboards.test.mjs` compares them
character for character. Changing either to match this screen would break the
boards and the team table together — the 8,610× bug with a shorter fuse. So the
screen **says so instead**, in two places:

- under the AP card, always on: *"Policies the carrier issued or paid. Pending
  and approved-not-paid are not counted here."*
- under the board: *"Net AP written, the agency's one definition of a sale — it
  counts pending and approved-not-paid business too, so it will not match your
  issued figure above."*

### The consequence the owner accepted

Because a lapsed or charged-back policy **leaves** the issued-AP figure, a past
period can shrink: March's bar is lower in June if a March policy lapsed in May.
Executed proof (`test/bo-summary.test.mjs`): one `issued` policy in March reads
$1,200 for March; flip it to `lapsed` and March reads $0. Recorded as intended
behaviour in `docs/back-office-summary.md` and pinned by a test so nobody
"fixes" it with a snapshot.

---

## Proof of the leaderboard invariants

### One call site, still one

```
sb.rpc('get_agency_leaderboards')  call sites: 1
sb.rpc('get_team_summary')         call sites: 1
```

`test/leaderboards.test.mjs` and `test/team-roster.test.mjs` both pass
**unmodified** (60 and 57 tests). `git status` shows neither file changed.

### The diff of `lbLoadBoards()`

```diff
-async function lbLoadBoards(periodKey, basis, force) {
-  const range = teamPeriodRange(periodKey, new Date());
-  const key = periodKey + '|' + basis;
+async function lbLoadBoards(periodKey, basis, force, rangeOverride) {
+  const range = rangeOverride || teamPeriodRange(periodKey, new Date());
+  const key = periodKey + '|' + basis + '|' + lbRangeKey(range);
```

Plus one new pure helper beside `lbInvalidate()`:

```js
function lbRangeKey(range) {
  const r = range || {};
  const t = d => (d instanceof Date && isFinite(d.getTime())) ? String(d.getTime()) : '-';
  return t(r.start) + ':' + t(r.end) + ':' + t(r.prevStart) + ':' + t(r.prevEnd);
}
```

**The default is today's behaviour, executed and confirmed.** A harness ran the
shipped `lbLoadBoards()` with no range argument against a stubbed `sb` and
compared the RPC arguments it sent against
`lbRpcArgs(teamPeriodRange(periodKey, new Date()), basis)`:

```
week           args identical to teamPeriodRange(periodKey, new Date()): true
month          args identical to teamPeriodRange(periodKey, new Date()): true
quarter        args identical to teamPeriodRange(periodKey, new Date()): true
lifetime       args identical to teamPeriodRange(periodKey, new Date()): true
month:2026-04  args identical to teamPeriodRange(periodKey, new Date()): true
```

**The range key is load-bearing, executed and confirmed.** Calling
`lbLoadBoards('monthly','net')` and `lbLoadBoards('monthly','net',false,win)`
in the same session — same period *string*, two different resolvers, because
`'monthly'` is a `LG_PERIODS` key that `teamPeriodRange()` does not know and
falls back to `TEAM_PERIOD_DEFAULT` for:

```
cache entries: 2   (1 would mean one screen served the other a stale board)
RPC calls made: 2
```

### Everything else that was asked

- `lbSplitRows()` still contains no `LB_TOP_N` — asserted.
- The card renders through `lbBoardHTML()`, so the cutoff, the medals and the
  private own-rank row are the Agency tab's, not a copy. It contains no rank
  comparison of its own — asserted.
- `lb_visible_members()` is untouched and still under the card, because the card
  reaches the board only through `lbLoadBoards()`. A test greps the loader for
  `get_agency_leaderboards`, `lb_board_rows`, `lb_visible_members` and
  `from('agents')` and asserts none appear.
- No write to `pp_team_period` anywhere in the new code — asserted, and the
  `localStorage.setItem('pp_team_period'` count is still exactly 1.
- No SQL was edited. `git status --porcelain supabase/` is empty.

---

## What the agency owner now sees, in ordinary words

Flip the toggle to Back Office and the first thing on the screen is **your own
production**, not your paperwork.

A row of period buttons across the top — Today, Weekly, Monthly, Lifetime, plus
a drop-down for any past month and a custom date range. They work exactly like
the buttons on the Front Office summary, and they remember what you picked. They
are this screen's own: clicking Monthly here does not move the Front Office
summary or the Agency tab.

Under them, four numbers: **how much annual premium the carriers actually issued
or paid** for you in that window, **what that's worth in commission** at your
advance rate, **what your statements say you were actually paid**, and **how
many policies** that is. If you've never uploaded a statement, the third one is
a dash and a short line telling you why — it is never a misleading "$0.00".

Below that, a **line graph of issued AP building up over the window** — a
running total, so it only climbs. Pick Today and you get the last seven days
with today highlighted (there's no time-of-day recorded on a sale, so an hourly
chart would just show when you do your data entry). Pick Lifetime and it draws
month by month, back to your first issued policy.

Then a **carrier mix**: every carrier you wrote under in that window, how many
policies, how much AP, and a bar showing each one's share.

Then, if you're in an agency, **Top producers** — the agency's AP board for the
same window, with your own row on it. If you're not in an agency, that card
isn't there at all.

Everything from Round 2 is still there, just underneath: what your statements
add up to, what needs your attention, how your book is holding up, and your team
figures if you're a leader.

**One thing to expect:** the AP number at the top and the AP number on the Top
Producers board **will not match**, and neither is broken. The top one counts
only what the carrier has issued or paid. The board counts everything you sold,
including applications still pending. Both cards say so underneath themselves.

---

## Rendered output — what was actually verified

**ACTUALLY RENDERED.** A headless harness extracted the *shipped* render
functions from `app.html` (the real slice, not a copy) together with
`comm-core`, `persist-core`, `recon-core`, `bo-summary-core`, `bos-chart-core`
and the shipped period engine, stubbed only `document` / `escHTML` / `sb` /
`nav` / `localStorage` / `_planTier`, and printed the HTML for each state.

### The six periods — chart granularity, computed not reasoned

Run on 2026-08-01 against an eleven-policy book:

| Period | Buckets | Unit | First → last | Today | Card AP | Chart total | Agree? |
|---|---|---|---|---|---|---|---|
| `daily` | **7** | day | Jul 26 → Aug 1 | idx 6 | $1,440 | $4,500 | ✅ (chart window ≠ card window, by design) |
| `weekly` | 7 | day | Jul 27 → Aug 2 | idx 5 | $4,500 | $4,500 | ✅ |
| `monthly` | 31 | day | Aug 1 → Aug 31 | idx 0 | $1,440 | $1,440 | ✅ |
| `lifetime` | 5 | **month** | Apr '26 → Aug '26 | idx 4 | $8,640 | $8,640 | ✅ |
| `month:2026-07` | 31 | day | Jul 1 → Jul 31 | none | $5,040 | $5,040 | ✅ |
| `custom:2026-07-12:2026-07-31` | 20 | day | Jul 12 → Jul 31 | none | $5,040 | $5,040 | ✅ |

Cumulative non-decreasing: **true for all six**. In every case the chart's last
value equals `bosIssuedAP()` over the chart's own window. On `daily` the chart's
window is the last seven days and the cards' is today, which is decision 5 — the
graph carries the caption *"Last 7 days — today is highlighted."*

Long-range switch, executed: `custom` of 62 days → `unit=day`; 63 days →
`unit=week`. `BOS_DAILY_MAX_DAYS = 62`.

### The states

| State | Verified output |
|---|---|
| **Populated (Lifetime)** | Personal issued AP `$8,640` + definition line · Est. commission `est. $5,832` · Commission paid `$4,645.00` · Policies issued `7` |
| **Carrier mix** | `Americo 3 $3,180 36.8%` · `Mutual of Omaha 1 $2,100 24.3%` · `Foresters 1 $1,560 18.1%` · `Corebridge 1 $1,200 13.9%` · `No carrier recorded 1 $600 6.9%` → "7 policies across 5 carriers · $8,640 AP". The fixture deliberately contains `Americo`, `americo ` and `Americo` — **folded into one row**, and the lapsed Corebridge policy is absent. |
| **Graph** | axis ticks `$0 $2.2k $4.3k $6.5k $8.6k`, x labels `Apr '26 … Aug '26`, `<svg class="bos-chart">`, footer "$8,640 issued in this window". |
| **🔴 No statements, full book** | `bosIsBrandNew() = false`. AP `$8,640`, 7 policies, full carrier mix and graph. Commission paid `—` + "Upload a statement to see this." Money strip: one sentence, not four `$0.00`s. **This is the bug the round exists to fix.** |
| **No policies, statements exist** | `bosIsBrandNew() = false`. AP `$0`, Commission paid `$4,645.00`. Mix: "No issued policies in this period, so there is no mix to show yet." Graph: dashed baseline (`bos-flat` present) + "No issued production in this period." |
| **Brand new (neither)** | `bosIsBrandNew() = true` → one panel: "Nothing here yet. Add a policy and this screen fills itself in…" with an **Add your first policy** button pointing at `nav('tracker')`. |
| **In an agency, non-leader, basic plan** | Top producers renders: `1 DW Dana Whitfield $18,400` / `2 JF Jace Frenkel You $12,300` / `3 MR Marco Reyes $7,600`, plus the divergence sentence and "Only the top 10 is ever shown." |
| **No agency** | `bosTopProducersHTML() === ""` — the empty string, not a hidden div. |
| **Board loading / failed** | skeleton; then "Couldn't load — open Agency to see this" with the rest of the page standing. |
| **Leader** | team strip: Downline `3`, Team Production `$6,745.00`, Team Persistency `86%` "18 of 21 still on the books". |
| **Non-leader** | `bosTeamHTML() === ""`. |
| **Loading (nothing landed)** | AP/estimate/count render immediately from memory; Commission paid shows a skeleton; money strip shows skeletons; top producers shows a skeleton. |
| **One RPC failed** (persistency rejected) | both persistency cards read "Couldn't load — open Persistency to see this"; the production cards rendered their real figures unchanged in the same pass. |
| **Full paint** | strip order in `#bos-body`: `bos-periods → bos-production → bos-chart → bos-mix → bos-top → bos-money → bos-attention → bos-health → bos-team`. All nine filled. |

### Period isolation — executed

Calling the shipped `setBosPeriod()` four times (`weekly`, a past month, a valid
custom range, then an **invalid** custom range with the end before the start):

```
keys written: {"pp_bos_period":"custom:2026-04-01:2026-04-17"}
pp_summary_period touched: false
pp_team_period touched:    false
pp_comm_range touched:     false
```

The invalid range was refused rather than stored, so the last good value
survived. And the rendered picker carries `id="pp-rng-bos"` (not `pp-rng-sum`)
with `setBosPeriod` as its setter on all three controls.

### Colour and dependencies — executed

```
hard-coded hex in graph markup: false
hard-coded hex in mix markup:   false
hard-coded hex in cards markup: false
SVG present: true
```

`git diff package.json` → no change at all. No dependency, no chart library, no
`<script src>`. `scripts/check-app.baseline.json` untouched.

### Executed vs reasoned

- **Executed:** every figure, bucket count, label, sort order, empty state, HTML
  string and localStorage key above; the leaderboard argument parity; the
  divergence arithmetic; all 67 `test:bosummary` assertions; the full `npm test`
  suite; `npm run check`.
- **Reasoned, not executed:** anything requiring a browser — pixel layout,
  responsive reflow below 640px, dark/light rendering of the SVG, hover and
  focus states, and the actual shape of the RPC payloads from the live database
  (fixtures were built to the shapes the existing tests already use). These are
  in the PENDING LIVE VERIFICATION list.

---

## Verification summary

| Check | Result |
|---|---|
| `npm test` | **green** — every suite |
| `npm run check` | `0 new error(s), 0 new warning(s), 12 known (baselined)` |
| `git status --porcelain supabase/` | *(empty)* |
| `git diff package.json` | *(no change)* |
| `scripts/check-app.baseline.json` | untouched |
| `test/leaderboards.test.mjs` | 60/60, **unmodified** |
| `test/team-roster.test.mjs` | 57/57, **unmodified** |
| `test/office-split.test.mjs` | 32/32, unmodified |
| `test/bo-summary.test.mjs` | 67/67 (40 before this round) |

Files changed: `app.html`, `test/bo-summary.test.mjs`, `CLAUDE.md`,
`docs/back-office-summary.md`, and this report.

---

## Numbered eyeball checklist for Jace

Minutes, no phone needed.

1. **Flip the sidebar toggle to Back Office.** You should land on Summary and
   see **real numbers**, not "Nothing here yet." (This is the whole round. If
   you see the welcome mat and you have policies, stop and tell me.)
2. **Check the four cards.** Personal issued AP, Est. commission, Commission
   paid, Policies issued. Every card has a small grey line under it explaining
   what it counts.
3. **Click Today → Weekly → Monthly → Lifetime** and watch the graph's x-axis
   change shape: 7 day-labels, 7 day-labels, one per day of this month, then
   month names. The caption at the right of the chip row should read
   *Today / This week / This month / All time* — **not** "This month vs last
   month".
4. **On Today,** confirm the graph shows **seven days** with the last one (today)
   sitting in a lightly shaded band, and that the note under it says "Last 7
   days — today is highlighted."
5. **Pick a past month** from the "Past month…" drop-down. The caption should
   become e.g. "July 2026" and the graph should draw one bucket per day of that
   month with no highlighted band.
6. **Click "Custom range…"**, pick two dates, hit Apply. Confirm the graph
   redraws and — importantly — **go to the Front Office Summary and confirm its
   period did not move.** Then check the Agency tab the same way. (This is the
   `ppApplyRange` bug I found; worth eyeballing once.)
7. **Reload the page (F5) while a custom range is picked.** The Back Office
   Summary should come back on that same range.
8. **Check the carrier mix against the Policy Tracker.** Filter the tracker to
   Issued + Paid for the same window and confirm the per-carrier counts match.
   No carrier should appear twice.
9. **Check Top producers.** Your row should be there with "You" on it. Then read
   the sentence underneath and compare its AP figure with the Personal issued AP
   card at the top — **they should differ**, and the difference should be your
   pending + approved-not-paid business.
10. **Scroll down** and confirm Round 2's strips are all still there and
    unchanged: the money, what needs you, book health, and (if you're on Leader)
    your team.
11. **Toggle dark mode.** Graph line, area fill, grid lines, axis text, share
    bars and the today band should all follow. Nothing should stay light.
12. **Narrow the window to phone width** (or open on your phone). The chip row
    should wrap, the cards should stack, the carrier mix should drop its bar onto
    its own line, and **the page must not scroll sideways**.

---

## PENDING LIVE VERIFICATION

Everything below is reasoned or fixture-tested and has **not** been seen in a
browser against the live database.

1. **Top Producers against a real agency with a real downline.** The board was
   rendered from a hand-built `get_agency_leaderboards` payload. Unverified
   live: that `lb_my_agency_state()` returns `agency_name` on this account
   (`lbRenderBoards` reads it, so it should), that the AP board comes back
   non-empty for the selected window, and that a hidden agent is genuinely
   absent. **Also unverified: the range-override path end to end** — the parity
   run proved the arguments, not the server's response to them.
2. **Commission paid against a real parsed statement.** `get_commission_buckets`
   is now called with bounds from `summaryPeriodRange()` rather than
   `commRange()`. Both emit `YYYY-MM-DD` local-calendar strings via the same
   shape, and `bosIso()` was unit-tested, but the RPC has not been called with a
   `daily` or `weekly` window before — those are much narrower than MTD/YTD/All
   and are the ones to watch.
3. **Every visual claim.** Layout, spacing, the SVG at real widths, the axis
   label density heuristic (`every = ceil(n/8)`, plus the first and last bucket
   always — so a 31-day month prints 9 labels, roughly every 4th day; the
   harness printed `Aug 1 Aug 5 Aug 9 Aug 13 …` and it reads fine as a string,
   but it has not been *seen*), dark mode, hover, focus rings, and the phone
   breakpoint.
4. ~~**The `p.draft` vs `_lgSubDate` discrepancy** in step 0, note 1. On the
   production book (23 policies) this may be a no-op if `dateSubmitted` and
   `draft` agree everywhere — worth one query to confirm, and worth a decision
   if they do not.~~ **CLOSED by Round FO5 (2026-08-01).** The decision went
   the other way from Round 4's instruction: this screen moved onto the
   submitted-date chain, and all three hand-written copies of that chain were
   consolidated into `ppProductionDate()`. See
   `docs/reports/PROMPT_FO5-report.md`. The "is it a no-op on the live book?"
   query is still worth running — it is now a question about *how much* the
   Back Office Summary's figures move on 2026-08-01, not about whether to act
   — and it is carried forward as item 1 of FO5's pending list.
5. **Performance on a large book.** `bosChartSeries()` is O(policies × buckets)
   and repaints on each of four `Promise.allSettled` settles. On 23 policies ×
   31 buckets this is nothing; at a few thousand policies on Lifetime it is
   worth a look.
6. **The money strip's new "no statements" sentence** — its link calls
   `bosOpen('ingest')`, matching `boArea()`'s panel key. Verified against
   `boArea()`'s source (it falls back to `ingest` for an unknown key anyway), not
   clicked.
