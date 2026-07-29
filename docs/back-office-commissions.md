# Back Office — commissions dashboard

Built 2026-07-29 (Phase 4 of the Back Office mission). What the ingested
statements add up to: six headline figures, a weekly trend, a personal-vs-
override mix, and carrier debt — drillable, and rolled up across a downline for
an agency owner.

**Read this before touching anything named `cm*`, `comm*`, `get_commission_*`
or `get_downline_commission_rollup`.** Progress ledger:
`docs/back-office-progress.md`. Phase 1 (the ingestion this consumes):
`docs/back-office-ingestion.md`.

---

## The organising decision

> **The RPC returns BUCKETS, not answers.**

`get_commission_buckets()` groups the caller's own commission rows by week and
transaction type. Every headline figure and both charts are then derived from
that one result in the pure `// <comm-core>` block, which the unit tests
execute verbatim.

The alternative — six SQL expressions returning six numbers — puts the
definition of "net commission" somewhere no test runs, and makes each card a
separate round trip.

Grouping is also what keeps it **bounded**: a year is 52 rows back and an
all-time range on a five-year book is a few hundred, whatever the row count
behind them. Fetching the rows themselves would hit PostgREST's 1,000-row
ceiling and quietly return a **wrong total rather than an error** — on a
commission figure, the worst possible failure.

---

## Effective agent

`commission_rows.agent_id` is the **uploader** (the tenant, what RLS keys on).
`attributed_agent_id` is **who wrote the business**, resolved from a producer
code in Phase 2. Everything here attributes on:

```sql
coalesce(attributed_agent_id, agent_id)
```

- On a solo agent's own statement the two are the same id.
- On an agency owner's consolidated statement, a line attributed to a downline
  agent counts as **that agent's** production, not the owner's.
- An unattributed line falls back to the uploader — far more likely to be
  theirs than nobody's — and the dashboard **says how many such lines there
  are**, with a link to Settings → Producer Codes, rather than hiding them.

The coalesce is also what makes the rollup double-count-proof: a line uploaded
by the leader and attributed to a downline agent, and a line uploaded by that
agent with no attribution, both resolve to exactly one agent and are counted
once.

---

## The six cards

Each renders its definition underneath, always on. That is the card's point,
not a tooltip.

| Card | What it counts |
|---|---|
| **Total Commission** | advance + renewal + override + chargeback. *What your book earned.* |
| **Gross Commission** | every positive line. *What the carriers credited you.* |
| **Net Commission** | every line added up, bonuses and adjustments included. *What actually reached your bank.* |
| **Personal Sales** | your own advance + renewal, net of chargebacks on your own lines. |
| **Override Income** | override lines — from agents in your hierarchy. |
| **Outstanding Debt** | what carriers have taken back and not been repaid. |

**Three of these coincide on a simple book, and that is deliberate rather than
a bug.** Total and Net differ only when a bonus or an adjustment exists — money
that reached the bank without being commission on a policy. The definitions on
the cards say exactly that. A unit test asserts the six definitions are all
different and that Total and Net *can* diverge, so neither card is decoration.

---

## Debt

**Debt = chargeback + adjustment lines only, reported as a positive balance
when their sum is negative.**

- An **advance is not debt.** It is an advance. Treating unearned advance as a
  carrier balance would invent a number the carrier never reported.
- A **positive adjustment reduces the balance** — that is how a repayment
  appears on a statement.
- A carrier in credit is **not listed**, rather than listed at zero.
- An **unmatched debt line still counts.** It is real money owed; it shows in
  the total and is findable in the drill-down, and the row count says how many
  are unmatched.

**Debt is never range-filtered**, on any tab. You owe a carrier what you owe
them; a balance that shrank because someone clicked "MTD" would be a number
nobody could act on. The range chips govern the commission figures only.

Clicking a carrier opens every line behind its balance.

---

## The downline rollup — the first cross-agent read of commission data

`get_downline_commission_rollup()` closes checklist #100. It is the first
deliberate cross-tenant read in this schema, and Phase 1's ledger entry
deferred it here on purpose.

It has to be `SECURITY DEFINER`, because `commission_rows` is SELECT-only and
per-tenant and must stay that way. Three things make that safe:

1. **There is no parameter naming a leader.** Both parameters are time bounds.
   The downline is scoped solely by `ai.leader_id = auth.uid()`, so there is
   nothing to point at somebody else's agency. Same shape and reasoning as
   `get_team_summary` and `apply_producer_codes`. Verified live: passing an
   invented `p_leader_id` is **refused**, not honoured.
2. **It returns aggregates, never rows.** No client name, no insured name, no
   policy number, no carrier, no statement id — money totals and a row count.
   Enforced by what the `RETURNS TABLE` declares, not by what the UI renders,
   which is the lesson `docs/agency-team-screen.md` records. A test asserts it.
3. **It only ever reads inside the caller's own agency.** `cr.agent_id in
   (team)` bounds the scan to statements uploaded by the leader or their
   accepted downline. Without it, a row attributed to a downline agent by a
   **complete stranger** would be pulled into this leader's rollup —
   `producer_codes.subject_agent_id` is guarded to self-or-downline, but that
   guard is about who may *claim* a code, not about whose rollup the result may
   appear in.

### A row attributed outside the team falls back to the uploader

The first version *excluded* such a row. The behavioural check caught what that
means: an agent who leaves the agency flips their invite to `declined`, and
every line the leader's own statements had attributed to them **silently drops
out of the leader's totals**. A total that quietly shrinks is the worst failure
this schema can produce, and "nothing is discarded" is the rule the whole Back
Office is built on. The attribution is now applied only when it lands inside
the team and otherwise falls back to the uploader. The security bound is
unchanged — it was never the thing doing the security.

### Known gap, recorded rather than closed

**A downline agent cannot see rows their LEADER uploaded and attributed to
them.** `commission_rows` RLS is keyed on the uploader, so a downline agent
whose leader ingests the consolidated statement sees none of it in their own
dashboard. Closing that means a second reader on the most sensitive table in
the app, and it deserves its own decision rather than being bolted onto this
phase. A behavioural check pins the current state so a change is deliberate.

---

## The screen

Back Office grew a **top-level area strip** — `Ingest · Commissions` — with
more to come in Phases 5–7. Panels are resolved **structurally**
(`#sec-backoffice [id^="bopanel-"]`), never from a hand-written list: naming
them one by one is what shipped a Settings panel rendering on top of another
one in Phase 2.

Inside Commissions: range chips **MTD / YTD / All time** (persisted), and
sub-tabs **Trends · Payouts · Debt**, plus **Bonuses ↗** which *links* to the
existing bonus tracker. Bonuses is not a fourth panel — that feature is built,
researched and 45 carriers deep, and a second copy of it here would be a second
thing to keep correct.

Switching sub-tab **never re-queries**: the data does not depend on the tab.

### The trend chart

Hand-built SVG, following the app's existing approach (there is no chart
library anywhere in this repo). Commission bars above a zero line, personal and
override as lines, **debt as bars below the line**.

- **The zero line sits where the data puts it.** A period with no debt has it
  at the bottom, not floating in the middle of an empty half.
- **Empty weeks are filled in** when the range is bounded. A chart that skips
  quiet weeks compresses a bad month to the same width as a good one and reads
  as steady production.
- Every *n*th week is labelled; labelling all of them on a year view produces a
  grey smear rather than an axis.

### The mix

Largest-remainder rounding, the same rule the team roster uses, so the two
printed integers always total 100 and never read 49 / 50. Both zero is **0/0**,
not 100/0 — an agent who earned nothing has no mix.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260742_commissions_dashboard.sql` | three functions; no table, no column, no data |
| `app.html` — `// <comm-core>` block | Pure: ranges, totals, cards, weekly buckets, chart geometry, mix, formatting |
| `app.html` — `#bopanel-commissions`, `cm*`, `boArea` | The screen |
| `test/commissions.test.mjs` | 47 tests — `npm run test:commissions` |

---

## Verification performed at build time

| Layer | Result |
|---|---|
| Schema, behavioural (rolled back) | **28/28** — the arithmetic, the boundary from three directions, and the known gap |
| Unit tests | **47** (`npm run test:commissions`) |
| Full suite | **545 tests + `npm run check` clean** |
| End-to-end against production | **29/29** — three throwaway accounts, a real statement through the real pipeline |
| Headless click-through | **35/35** — real browser, rendered SVG geometry read back |
| Residue after both live runs | **zero** |

### What the checks found

**One real defect, and it was a design flaw rather than a typo.** The rollup
originally required the effective agent to be on the team, which made a row
attributed outside it vanish from every total with nothing on screen to say so.
The fix is above. It was caught because the behavioural check asserted a
*stranger's* own figures, not just the leader's — the assertion that looked
like paranoia is the one that found it.

---

## Testing it by hand

1. **Back Office → Commissions.** Six cards, each with its definition
   underneath.
2. **Click MTD / YTD / All time.** The commission figures move. **Outstanding
   Debt does not** — that is deliberate.
3. **Trends.** Commission bars above the line, debt bars below it, personal and
   override as lines. A period with no debt has the zero line at the bottom.
4. **Payouts.** One row per ingested statement, newest first, with what it paid
   and how many lines still need review.
5. **Debt.** One row per carrier, largest first, with a share bar and a total.
   **Click a carrier** — every chargeback and adjustment line behind it.
6. **As an agency owner**, the Trends and Debt tabs also show *Your agency*:
   one row per member with personal, override, net and debt, and an agency
   total. No client names — by construction.
7. **Reload.** The range and tab you left it on are still selected.
