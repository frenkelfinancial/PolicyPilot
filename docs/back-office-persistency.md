# Back Office — persistency

Built 2026-07-29 (Phase 5 of the Back Office mission). How much of what an
agent wrote stayed on the books: four windows, Flat vs Weighted, Policy vs
Agent, segmented by carrier and by lead source, with the worst segment
spotlighted in a sentence.

**Read this before touching anything named `ps*`, `persist*`, or
`get_downline_persistency`.** Progress ledger: `docs/back-office-progress.md`.

---

## The two definitions everything rests on

> **COHORT** — a policy that reached issue and is old enough for the window.
> **KEPT** — a policy still in force.

```js
PERSIST_COHORT_EXCLUDED = ['pending', 'approved', 'denied', 'withdrawn']
PERSIST_KEPT            = ['issued', 'paid', 'placed', 'claim']
```

- **A policy that never issued is not in the cohort.** It was never at risk of
  lapsing, and counting a declined application as a lapse punishes an agent for
  underwriting.
- **A death claim is not a lapse.** The policy stayed in force until the
  insured died — the policy doing its job. On a final-expense book this is
  common enough to matter, and counting it against the agent is simply wrong.
- `placed` is a legacy status some older policies still carry.

The same two lists are in `20260743_persistency.sql`, and **a test asserts the
browser and the SQL agree**. A figure an agent computes for themselves and a
figure their leader sees, computed differently, is the worst kind of
disagreement this app could ship.

---

## The bug this phase fixed

**The pre-existing persistency widget was computing its rate over a third of
the book.**

`_polsIssuedMonthsAgo()` keyed on `issueDate` alone. `issueDate` is an
**optional** field on the Add Policy form: in production **8 of 23 policies
carry one, while all 23 carry a draft date**. Every policy without one was
invisible to persistency — not counted as lapsed, just absent — so the widget
reported a rate over whatever happened to have the field, and presented it as
the book's persistency.

A persistency figure computed from a third of the policies is worse than no
figure, because it looks like a figure.

The start date is now a fallback chain, in the browser and in the SQL:

```
issueDate  ->  draft  ->  dateSubmitted
```

`persistency13mo()` and `persistency25mo()` — which the Summary rings and the
FFL bonus card call — now **delegate to this core**, so the app has one
definition rather than two. They still return a 0–1 fraction, because that is
what their callers already multiply by 100.

---

## Flat vs Weighted

**Flat** counts policies. **Weighted** counts annualised premium.

Keeping nine $300 policies and losing one $6,000 policy is **90% flat and 31%
weighted**. Carriers measure the second one. That gap is the entire reason the
toggle exists rather than a single number.

A cohort whose policies all have zero or missing AP has **no weighted rate**,
not a zero one — reported as `noPremium` and rendered as "—".

---

## No rate is not a zero rate

`persistRate()` returns `rate: null` for an empty cohort, and `persistBand()`
returns `null` for a null rate.

0/0 is not 0%. Painting a red band on an agent who simply has not been writing
long enough to have a 25-month cohort is the single most misleading thing this
screen could do, and it is the first thing a naive implementation does.

The same rule runs through the sorting: **a segment with no rate sorts last**,
not to the top where it would read as the worst thing in the book.

---

## The bands

```
Green  >= 85%      Yellow  70-84%      Red  < 70%
```

Not arbitrary — these are the bands carrier bonus programmes are written
against. `data/carrier_bonuses.json` is full of `13-mo persistency >= 85%`. The
legend is rendered on screen, because a colour with no key is a decoration.

---

## Segments, and the outlier

**By carrier** and **by lead source**, at whichever window is selected, ranked
worst first.

- **A thin segment is flagged, not hidden.** One policy is not a rate: one
  lapse makes it 0% and it would top every "worst" list forever. Segments below
  three policies are marked *thin cohort* and still shown — the **outlier
  picker** is what ignores them.
- **The outlier only fires when the segment is materially worse** than the book
  (10 points by default). A "worst carrier" one point below average is noise,
  and a screen that always accuses somebody trains an agent to ignore it.
- **The reason is a sentence with numbers in it**, never a bare label:

  > *Lead source BadSource persists at 25%, 25 points below your book — 3 of 4
  > policies did not stay on the books.*

### The lead-source join

`submitAsSold()` already writes `soldLeadId` and `leadSource` on every policy
created from a lead; a policy typed straight into the tracker carries neither.
`persistLeadSource()` consults the live lead first (its source is current) and
falls back to the snapshot taken at sale (so a deleted lead does not lose the
link).

Where there is no link at all the policy is **counted as unlinked, never put in
a fake bucket**, and the panel says:

> *Link policies to leads to populate this. A policy created with **Submit as
> Sold** from a lead carries its source; one typed straight into the tracker
> does not. **N** of the M policies in this window are not linked to a lead.*

---

## Policy view vs Agent view

**Policy view** is computed entirely in the browser from the agent's own
`policies` array. No RPC — it is their own book, already loaded.

**Agent view** needs the server. For a solo agent it is one row; for an agency
owner it is the whole point of the screen — *which of my agents writes business
that sticks* is the question persistency exists to answer, and `policies` RLS
is owner-only so the browser cannot answer it.

`get_downline_persistency()` is `SECURITY DEFINER` with the same three
guarantees as every other cross-agent function in this schema:

1. **No parameter names a leader** — the only argument is a date. The downline
   is scoped solely by `ai.leader_id = auth.uid()`.
2. **It returns four counts per (agent, window)** — cohort and kept, by policy
   count and by premium — so Flat vs Weighted costs one round trip. No client
   name, no policy number, no carrier, no lead source, not even a status.
3. **A stranger gets a team of one**, and a downline agent cannot see up the
   tree. Both exercised, not asserted.

The solo agent's Agent-view panel says so explicitly: *"their persistency
appears here too — as a rate, never as their client list."*

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260743_persistency.sql` | one function; no table, no column, no data |
| `app.html` — `// <persist-core>` block | Pure: windows, bands, cohort, rate, segments, outliers, agent folding |
| `app.html` — `#bopanel-persistency`, `ps*` | The screen |
| `test/persistency.test.mjs` | 44 tests — `npm run test:persistency` |

---

## Verification performed at build time

| Layer | Result |
|---|---|
| Schema, behavioural (rolled back) | **16/16** |
| Unit tests | **44** (`npm run test:persistency`) |
| Full suite | **589 tests + `npm run check` clean** |
| Headless click-through | **31/31** — including that the server's Agent view and the browser's window cards report the **same 50%** |
| Residue | **zero** |

### What the checks found

**A latent trap in the test harness itself, which had already been laid three
times.** Each core block is extracted from `app.html` with a lazy match from
its opening sentinel. A comment *mentioning* `// <persist-core>` above the real
block made the match start at the comment and swallow ten thousand lines, and
the extracted code stopped parsing. Two more copies existed below their blocks
— harmless today, the same trap tomorrow. All four are cleaned, and a test now
asserts **every core sentinel appears exactly once in `app.html`**.

---

## Testing it by hand

1. **Back Office → Persistency.** Four cards: 4 / 9 / 13 / 25 month, each with
   its band colour, its bar, and "N of M still on the books".
2. **Click a card.** The tables below re-break at that window.
3. **Flat → Weighted.** The rates change. If they change a lot, one big policy
   is carrying the book.
4. **By carrier.** Worst first. A carrier with one or two policies is marked
   *thin cohort* — shown, but never accused.
5. **The banner.** At most one carrier and one lead source, each with a
   sentence saying how far behind and how many policies.
6. **By lead source.** Sources you have linked, plus a note saying how many
   policies are not linked and how to link them.
7. **Agent view.** Your own row. With agents connected through Agency, one row
   each — a rate, never a client list.
8. **Reload.** View, basis and window are where you left them.
