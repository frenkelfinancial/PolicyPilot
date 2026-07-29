# Back Office — Book of Business

Built 2026-07-29 (Phase 3 of the Back Office mission). Upgrades the existing
Policy Tracker into a master policy browser: ten statuses instead of six,
status tabs with counts, a per-policy status-history timeline carrying the
source of every change, and filters built from the data rather than from a
master list.

**Read this before touching anything named `bob*`, `pt*`, `PT_STATUS_*`, or
`policy_status_history`.** Progress ledger: `docs/back-office-progress.md`.
Phase 1 (the ingestion that feeds it): `docs/back-office-ingestion.md`.

---

## The organising idea

> **A status change is not a value. It is an event, with a source.**

The tracker used to hold one `status` string per policy and nothing else. When
it changed, the previous value was gone and there was no record of who or what
changed it — which is a problem the moment three different things can change
it: the agent, the carrier-mail parser, and now a commission statement.

So Phase 3 adds `public.policy_status_history`: append-only, one row per
change, carrying `old_status`, `new_status`, `source`, a plain-English
`source_detail` and `changed_at`. Every existing policy was backfilled with one
genesis entry, so nothing opens onto an empty timeline.

---

## The ten statuses

| Key | Label | New? |
|---|---|---|
| `pending` | Pending | |
| `approved` | **Approved Not Paid** | relabelled |
| `issued` | Issued | |
| `paid` | Paid | |
| `denied` | Denied | ✅ |
| `withdrawn` | Withdrawn | ✅ |
| `lapsed` | Lapsed | |
| `surrendered` | Surrendered | ✅ |
| `claim` | Claim | ✅ |
| `chargeback` | Chargeback | |

**The six original KEYS are unchanged.** They are stored verbatim in
`policies.data.status` for every policy in production and are read by
`get_team_summary`, the carrier-mail parser's `STATUS_MAP`, the Summary charts
and the bonus tracker. Renaming one is a data migration; nothing here needed
one. Only the `approved` *label* changed, to the "Approved Not Paid" the agent
actually worries about.

The four new ones are plain strings in a jsonb column, so `public.policies`
needed no schema change at all. They **do** appear in
`policy_status_history`'s check constraint, and a test asserts that list and
`BOB_STATUSES` in `app.html` are the same ten — a status the UI offers and the
database refuses is a save that fails at the last step.

### Three derived sets, each defined once

```js
BOB_NOT_A_SALE = ['lapsed','chargeback','denied','withdrawn']
BOB_ENDED      = BOB_NOT_A_SALE + ['surrendered','claim']
```

- **`BOB_NOT_A_SALE`** — a policy that never became a sale. It is the app-side
  half of `get_team_summary`'s predicate, and a test asserts the two agree.
  `surrendered` and `claim` are deliberately **not** in it: both describe
  business that *was* written and later ended, and excluding them would erase
  real production from every AP figure in the app.
- **`BOB_ENDED`** — no longer in force. This is what the Summary's five-segment
  status bar folds into its last segment, and what the draft-date auto-advance
  refuses to touch.

Both are used rather than re-typed everywhere. That is not tidiness: see
*"What the live runs found"* below.

---

## The status tabs

`All · Pending · Approved Not Paid · Issued / Paid · Denied · Withdrawn ·
Lapsed · Surrendered · Claim · Chargeback` — ten tabs, each with a count.

- **The tabs REPLACED the Status dropdown.** One control per question; two
  controls for one filter is how a filter and its count start disagreeing.
- **Counts span the whole book, never the filtered view.** A count that moved
  when you clicked a tab would be answering a different question from the one
  the tab asks.
- **Issued and Paid share one tab.** They are separate statuses — `issued` is
  the carrier's decision, `paid` is the app's own draft-date advance — but
  "Issued Paid" is one thing to an agent looking for the policies that made it.
  The compound value rides the `'+'`-joined filter the Summary drill-in already
  used, so nothing new had to parse it.
- **A tab matching nothing is dimmed, not hidden.** "You have no denied
  policies" is information, and a strip that changes shape as the book changes
  is hard to aim at.
- **Selecting a tab keeps the carrier / product / date filters.** It clears
  only the date *range* carried in from a Summary drill-in, because otherwise
  the count on the tab disagrees with the rows underneath it.
- **The Summary "ended" drill-in lights up NO tab.** It filters six statuses
  and no single tab covers that set; lighting up **All** would claim the table
  is unfiltered when it is not. `bobTabForFilter()` returns null, and that null
  is a real answer rather than a failure.

---

## The timeline

A **clock** button on each row opens the policy's status history, newest first.
Each entry shows the date, the transition in plain English
(*"Approved Not Paid → Paid"*, or *"Recorded as Pending"* for a first entry),
a provenance chip, and the reason.

| `source` | Chip | Written by |
|---|---|---|
| `manual` | Manual edit | the agent, in the app |
| `system` | Automatic | the draft-date auto-advance |
| `statement` | Commission statement | `statement-parse` (service role) |
| `carrier_email` | Carrier email | the carrier-mail pipeline |
| `migration` | Existing status | the 20260741 backfill |

### It reads TWO tables

`policy_status_history` (this phase) **and** `public.policy_events`, which the
carrier-mail pipeline has been writing since 20260717. `policy_events` was not
migrated into the new table and is not going away — the timeline merges both
rather than pretending the older entries do not exist. `policy_events` is keyed
on `policies.id` (a uuid) and the browser only ever holds `client_id`, so the
uuid map is loaded once per session rather than per policy opened.

### A policy with no rows still shows something

Derived from the policy itself and flagged `synthetic: true`. That happens for
a policy added while the device was offline. Better a dated first entry than an
empty panel, which reads as data loss.

---

## Who may write the trail, and what they may claim

`policy_status_history` is **owner-readable and owner-appendable, with no
UPDATE and no DELETE policy at all.**

This is a different posture from the four Phase 1 commission tables, which are
SELECT-only, and the reason is the write path. The policy tracker is a
browser-side app: `public.policies` is written directly from the client under
an owner RLS policy, and there is no edge function anywhere in the policy write
path. A history table the browser could not write would record nothing at all
for the source that produces most of the entries.

What the client must **not** be able to do is forge provenance. A row claiming
`source='statement'` asserts that a carrier said something, and Phase 6's
triage screen will treat it that way. So `policy_status_history_guard`:

- forces `agent_id` to `auth.uid()` for a client caller, and
- **rejects any `source` other than `manual` or `system`** from one.

`service_role` keeps the usual carve-out. Verified live: a browser holding a
valid session gets a `42501` for `source='statement'` and for
`source='carrier_email'`.

> **Protect the column, not only the function that sets it.** `20260703c`
> (`is_admin`), `20260730` (billing columns), `20260736` (`agency_code`) and
> `20260740` (`subject_agent_id`) each cost this schema once.

### The browser's write is BEST EFFORT, on purpose

`bobRecordStatusChange()` never blocks the status change it is recording. The
tracker works offline against `localStorage` and syncs afterwards, so an
unreachable network is an ordinary condition — and a policy whose status will
not change because an audit row could not be written is a worse product than a
trail with a visible gap in it. The two *authoritative* writers (statement
ingestion, the carrier-mail parser) run server-side where there is no such
trade-off.

---

## What a statement is allowed to change

`statement-parse` may advance a policy's status, because a carrier's own
commission statement is the best evidence the app holds about two things:

| Line | Effect |
|---|---|
| `advance` / `renewal`, amount > 0 | → `paid`, **only** from pending/approved/issued |
| `chargeback` | → `chargeback`, from any status except itself |
| anything else | nothing |

- **A payment never resurrects an ended policy.** A trailing renewal line on a
  lapsed policy leaves it lapsed.
- **A chargeback is sticky.** Lines are folded in order against the status the
  previous line left behind, so a payment *after* a chargeback in the same
  statement evaluates against `chargeback` and changes nothing. No special case
  was needed for that; it falls out of the fold.
- **Re-parsing changes nothing**, because every line is evaluated against the
  status it already produced — the same property the row-grain dedupe key gives
  the commission rows.

### A LAPSE is never inferred

Our seven transaction types have no "lapse", and the shapes that might imply
one — a negative adjustment, a missing renewal — are also what an ordinary fee
or a timing difference looks like. Guessing a lapse from a debit would mark
live business dead on the strength of a bookkeeping line. A lapse still arrives
through the carrier-mail parser, which reads a carrier *saying* the policy
lapsed.

### The history row is written FIRST

PostgREST has no transaction across calls, so the two writes cannot be atomic.
The history row goes first deliberately: an unexplained status change is worse
than a recorded change that then failed to apply, because the second is visible
and re-runnable and the first is not. A failure of the whole block never fails
the ingestion — the commission rows are already saved and are the primary
product.

---

## The filters

- **Carrier and product are built from the book.** `TRACKER_CARRIER_LIST` has
  24 carriers in it; an agent appointed with three was scrolling past 21
  options that could only ever return nothing. A currently-selected value is
  kept even if it now matches nothing, so the dropdown cannot silently reset
  itself while the table stays filtered.
- **Product resolves to `Final Expense · Term · IUL · Whole Life · Annuity`,
  and Final Expense/Annuity are recognised only from text that SAYS SO.** This
  app's Add Policy dropdown offers Whole Life / Term / IUL, so almost every
  final-expense policy in a real book is recorded as Whole Life. Re-labelling
  those from a COMP key (`mutual_fe`, `aflac_final_ex`, …) would disagree with
  what the agent chose and would move counts they recognise. Where the words do
  appear — a hand-typed value, or a product name carried in from an ingested
  statement — they are honoured. A test pins the COMP keys as Whole Life.

### The agent filter is GATED, not built

Filtering this table by agent means showing a leader another agent's client
names, premiums and policy numbers. Two things stand in the way and both are
deliberate: `policies` RLS is owner-only, and `docs/agency-team-screen.md`
records that leader views are aggregates only. Lifting either needs the
team-hierarchy work this mission explicitly defers.

So what ships is the gate sentence, shown **only to a leader**, pointing at the
Agency tab for team production. A solo agent sees nothing — they have no agent
to filter by.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260741_book_of_business.sql` | `policy_status_history` + guard + backfill; `get_team_summary` replaced |
| `app.html` — `// <bob-core>` block | Pure: statuses, tabs, counts, product resolution, present-options, the timeline merge, the sentences |
| `app.html` — `#pt-status-tabs`, `bob*`, `renderStatusTabs`, `togglePolicyHistory` | The screen |
| `supabase/functions/_shared/statement-core.ts` § 12 | `nextPolicyStatusFromStatement`, `planStatementStatusChanges` |
| `supabase/functions/statement-parse/index.ts` | The write-back |
| `test/book-of-business.test.mjs` | 42 tests — `npm run test:bob` |

### Why the tests extract from `app.html`

Same reason as `test/team-roster.test.mjs` and `test/back-office.test.mjs`:
`app.html` has no build step and no module system, so a mirrored copy of the
logic in a `.mjs` file would be a second definition that drifts from the one
that ships. The test pulls the text between the `// <bob-core>` sentinels out
of `app.html` and executes it. **Keep that block pure** — no DOM, network,
storage or app globals; a test asserts that too.

---

## Verification performed at build time

| Layer | Result |
|---|---|
| Schema, behavioural (rolled back) | **22/22** — provenance guard, append-only, tenancy, both check constraints, backfill idempotency, and the four `get_team_summary` predicate cases |
| Unit tests | **42** (`npm run test:bob`) + **12** added to `statement-core` |
| Full suite | **498 tests + `npm run check` clean** |
| End-to-end against production | **31/31** — real edge functions, real Haiku parse, two throwaway accounts |
| Headless click-through | **40/40** — real browser, rendered DOM |
| Residue after both live runs | **zero** |

### What the live runs found

Three real defects, all fixed, all now covered by a test.

1. **Every genesis entry was dated one day early for any agent west of UTC.**
   `dateSubmitted` is a calendar date the agent typed; casting it lands on
   **midnight** UTC, and the browser renders a `timestamptz` in the reader's
   local zone. All 23 backfilled entries in production rendered as the previous
   day. Fixed to **noon** — correct from UTC-11 to UTC+11, and what
   `bobRecordPolicyCreated()` already did — plus a tightly-scoped corrective
   `UPDATE` for rows an earlier run of the same file had already written at
   midnight, so the fix reaches databases that had applied it and not only ones
   that had not. **Found by driving a real browser; no unit test would have
   caught it, because the bug is in how an instant renders.**

2. **The draft-date auto-advance would have marked DENIED policies paid.**
   `autoSetPaidOnDraftDate()` excluded `['paid','lapsed','chargeback']` and
   flipped everything else with a past draft date to `paid`. The four new
   statuses were not in that list, so a policy the carrier had denied — with a
   draft date already in the past, which is the normal case for one — would
   have been silently marked paid on the very next render, on the screen the
   agent reads to find out what they earned. The exclusion now derives from
   `BOB_ENDED`.

3. **The Summary's status bar would have stopped adding up to 100%.** Its five
   segments folded only `chargeback` into `lapsed`; a policy in any of the four
   new statuses counted toward the bar's total while appearing in no segment.
   The fold is now `BOB_ENDED`.

Two and three are the same bug class — **a set of statuses written out by hand
in more than one place** — which is why `BOB_NOT_A_SALE` and `BOB_ENDED` exist
and why `PT_STATUS_ORDER` / `PT_STATUS_LABELS` are now derived from
`BOB_STATUSES` rather than declared beside it. A fourth instance was found
while doing that: the **Add and Edit modals already carried different status
lists** (five options versus six), so a policy could hold a status one modal
could not display. Both are now generated from `BOB_STATUSES`.

---

## Testing it by hand

1. **Policy Tracker.** Ten status tabs across the top, each with a count. The
   counts add up to the All count.
2. **Click a tab.** The table filters; **the counts do not move.**
3. **Set the Product filter to Term, then click a status tab.** The product
   filter survives the click.
4. **Carrier dropdown.** It lists only carriers you have actually written, not
   all 24.
5. **The clock button on a row.** A timeline, newest first, each entry saying
   what changed and what changed it. A policy you have never touched shows one
   derived entry rather than an empty panel.
6. **Change a status on a row, then reopen the timeline.** A new entry, chip
   *Manual edit*, reading e.g. *"Pending → Withdrawn"*.
7. **Upload a statement (Back Office) with a chargeback line for a policy you
   hold.** That policy moves to Chargeback, and its timeline gains an entry
   chipped *Commission statement* naming the file. **Re-read the same
   statement** — no second entry.
8. **Add Policy and Edit Policy** both offer the same ten statuses.
9. **A denied policy with a draft date in the past stays denied**, however many
   times you reload.
