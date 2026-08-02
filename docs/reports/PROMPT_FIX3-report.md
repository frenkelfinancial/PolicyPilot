# PROMPT FIX3 — A statement you can remove, and a re-read that replaces instead of doubling

**Date:** 2026-08-02 · **Branch:** `main` · **Schema change:** none ·
**Functions deployed:** `statement-delete` (new) and `statement-parse`, and
only those two. **`app.html` changed**, so the push matters this time — see
[Which half does what](#which-half-does-what).

Both halves shipped. Neither was deferred.

---

## Plain English — what the owner can now do that he could not

**Before this round there was no way to remove a statement.** The only control
was a re-read, and a re-read did not replace anything — it *added*. So an agent
whose statement had been read wrongly had exactly two options: leave the wrong
numbers in their book, or open the Supabase dashboard and write SQL. That is
what the FIX2 report had to tell him to do.

Two things changed.

**You can remove a statement from the app.** There is a red **Remove** button on
every row of the Statements table. It shows you what is about to go — how many
commission lines, what they add up to, and which policies that statement moved
and to what — and makes you type the filename before the button will work. The
file, the raw extraction and the commission lines all go with it.

**Re-read now replaces.** It reads the original file again and puts the result
in place of that statement's lines, instead of stacking a second copy on top.
Approvals and manual policy matches you made by hand come with it, on any line
that comes back with the same policy number, insured and amount — and it tells
you how many carried and how many did not, rather than quietly dropping them.

Together those mean correcting a statement is now: click **Re-read**, or click
**Remove** and upload the file again. No SQL, ever.

---

## Step 0 — verify, don't assume

### 1. The cascade, from the live catalogue

Not from the migration text. Queried against `pg_constraint` on production:

| Child table | Column | Parent | On delete |
|---|---|---|---|
| `commission_rows` | `statement_id` | `commission_statements` | **CASCADE** |
| `statement_files` | `statement_id` | `commission_statements` | **CASCADE** |
| `statement_extractions` | `statement_id` | `commission_statements` | **CASCADE** |
| `commission_statements` | `parent_statement_id` | `commission_statements` | **CASCADE** |

**Four foreign keys reference `commission_statements`, and all four cascade.**
Deleting the parent row is sufficient. The same query asked what references
`commission_rows`, `statement_files` and `statement_extractions` and returned
**nothing** — so there is no path to an orphaned money row.

RLS, also live: exactly **four** policies across the four tables, all `SELECT`,
all `{authenticated}`. No INSERT, no UPDATE, no DELETE. Unchanged by this round.

### 2. `parent_statement_id` — children

It cascades. **Deleting a parent deletes its children**, and every commission
row those children produced. That is right — the archive *is* the upload — but
it is invisible from the row the agent clicked, so `statement-delete` counts the
children, names their filenames, and folds their rows into the line count and
the net. The confirmation shows all of it.

### 3. Where a statement's effect on the book is recorded

- **`policy_status_history`** — one row per change, `source='statement'`,
  `source_ref_id` = the statement id, written by `statement-parse` *before* the
  status update. Production holds **41** rows, **1** of them from a statement.
- **`source_ref_id` carries no foreign key** (`20260741`, bare `uuid` + a
  partial index). So these rows **survive the delete**, which is deliberate —
  the table is owner-appendable with no UPDATE and no DELETE policy, and the
  trail is not something a delete may rewrite.
- **`policy_events`** belongs to the carrier-mail pipeline, not to statement
  ingestion. Untouched.
- The transitions themselves are `PAYABLE_FROM` → `paid` and → `chargeback`
  only (`docs/back-office-book-of-business.md`); a lapse is never inferred.

None of this is reverted. It is read **for reporting**, and three tests assert
`statement-delete` never writes `policies`, `policy_status_history` or
`policy_events`.

### 4. What `statement-review` writes — the hand work decision 2 preserves

`review_status`, `matched_policy_id`, `match_method`, `match_confidence`,
`review_reason`, `review_note`, `reviewed_at`, `reviewed_by`. The carry-over
moves all eight, so a carried match stays coherent with the id it points at.

---

## The mechanism, stated plainly

The row dedupe key is `carrier | policy | insured | DATE | amount | type` plus
an occurrence ordinal. **The date is in it, and the key is correct** — the
ordinal is what keeps a carrier's two legitimately identical lines from
collapsing into one, and the owner's ledger has two such pairs.

But it means **any** parser fix that moves a date, an amount or an ordinal
re-fingerprints every line already ingested. The upsert is `ignoreDuplicates`,
so nothing collides and nothing is updated — the second read lands a complete
second set of rows beside the first.

A test now pins this rather than describing it: the nine fixture lines
fingerprinted as the pre-FIX2 parser left them (no dates) and as the fixed
parser produces them (July dates) share **zero** keys out of nine.

---

## The shadow run — the owner's real statement

Run against **the actual stored bytes** of his `doc.pdf`, through the deployed
functions, with a **real user JWT**, via a shadow statement row pointing at the
same file. His own statement was never named by any call and was not modified.

**26 checks, 26 passed.**

### Re-read: before and after

| | Rows | Net | Files | Extractions |
|---|---|---|---|---|
| After first parse | 9 | **$262.45** | 1 | 1 |
| After 5 decisions planted by hand | 9 | $262.45 | 1 | 1 |
| **After re-read (`replace: true`)** | **9** | **$262.45** | 1 | 2 |

**Nine lines in, nine lines out. Not eighteen. $262.45, not $524.90.**

The worker's own report of that re-read:

```
"rows": 9,  "inserted": 9,  "already_present": 0,
"replaced": true,
"lines_before": 9,  "lines_after": 9,
"hand_work_before": 5,  "hand_work_carried": 5,  "hand_work_lost": 0
```

Row ids were all new — the old rows were genuinely replaced, not left in place
— and no id appeared twice.

### The duplicate group, on real bytes

The file carries **two** groups of verbatim-identical lines (2 and 2). Each
twin was given a *different* decision before the re-read, so the positional rule
was actually exercised:

| # | Date | Type | Amount | Review status after re-read |
|---|---|---|---|---|
| 0 | 2026-07-27 | adjustment | −45.00 | approved |
| 1 | 2026-07-09 | chargeback | −41.33 | auto |
| 2 | 2026-07-01 | advance | 90.46 | **approved** ← twin A |
| 3 | 2026-07-30 | advance | 13.75 | needs_review |
| 4 | 2026-07-01 | advance | 30.19 | needs_review |
| 5 | 2026-07-01 | advance | 36.95 | **approved** ← twin A |
| 6 | 2026-07-30 | advance | 36.95 | **rejected** ← twin B |
| 7 | 2026-07-30 | advance | 90.46 | **rejected** ← twin B |
| 8 | 2026-07-30 | advance | 50.02 | needs_review |

Each twin kept **its own** decision. First-match-wins would have returned
approved/approved and rejected/rejected.

### Delete: before and after

| | Statement | Rows | Net | File | Extractions |
|---|---|---|---|---|---|
| Before | ingested | 9 | $262.45 | 1 | 2 |
| **After** | **(gone)** | **0** | **$0.00** | **0** | **0** |

The preview reported `line_count: 9`, `net_amount_cents: 26245`,
`deleted: false` — and nine rows were still present after it, i.e. the preview
really is a preview.

Asked to delete a statement id that is not the caller's, it answered
`{"error":"statement_not_found"}` — not "forbidden", because telling a caller
"that id is real but not yours" is itself a disclosure.

### 🔴 The delete did not rewrite the book

The owner's statement moved no policy (both its matches were already at
`chargeback`/`paid`, outside `PAYABLE_FROM`), so the real bytes could not
exercise this path. One `policy_status_history` row of exactly the shape
`statement-parse` writes was planted against the shadow, pointing at a real
policy, and then removed afterwards.

- Preview and result **named the policy**: insured, `from_status: "issued"`,
  `to_status: "chargeback"`.
- After the delete, the policy's own status was **unchanged**
  (`chargeback` → `chargeback`).
- The history row **survived the delete**.
- The planted row was cleaned up: zero residue.

### A defect the shadow run caught that the unit tests did not

The first pass listed **the same policy twice** in the preview — one entry per
history row rather than per policy. A statement can legitimately write more than
one history row for a policy across re-reads, and a confirmation naming the same
person twice with the same status reads as a bug, not as history.

Fixed with `collapseMovedPolicies()`: one entry per policy, `from` the earliest
change and `to` the latest — what the statement actually did to that policy end
to end. The **trail itself is untouched**; this collapses the display, not the
record. Two tests added, and both functions redeployed.

### Production residue: zero

```
statements 1 · files 1 · extractions 1 · rows 9 · net 26245
policies 26 · policy_status_history 41 (1 from a statement)
```

Byte for byte the FIX2 baseline. **His existing statement was not modified —
correcting it is his step, below.**

---

## What was built

### `statement-delete` — an edge function, not an RPC

Chosen to **match `statement-review`**, which is the existing write path onto
these same four tables. A `SECURITY DEFINER` RPC would be equally sound on the
security axis and is how `apply_producer_codes` is built — but it would leave
the Back Office with two different doors onto commission data, two sets of
reasoning to keep in step, and a question for the next person about which door a
new action belongs in.

- Agent **from the JWT**. The body carries exactly `action` and `statement_id`,
  and a test parses the body declaration to prove it.
- `preview` and `delete` are **the same call with one flag**, through one
  `summarizeStatementDeletion()`. A test asserts the planner appears once and
  that the preview/delete split comes *after* it.
- **One** delete — the parent row — scoped to `id` *and* `agent_id`. The
  cascade does the rest.
- Returns line count, net, child count and child filenames, and the list of
  policies moved — **before** deleting, so the confirmation and the result show
  the same thing.

### The confirmation

`#boDeleteModal`, not `confirm()`. A one-line browser dialog cannot show a list
of policies, and that list is the point. It states the line count and the net,
names the ZIP members if any, names the policies moved with the status each was
set to plus the sentence that they **keep** it and are worth checking, says it
cannot be undone — and requires the **filename typed** before the button
enables.

### Re-read replaces

`statement-parse` takes `replace: true`, for one **named** statement only (a
sweep must not rewrite everybody's book).

**Chosen approach: re-parse first, swap only on success — plus a restore.**
PostgREST has no transaction across calls, so the choice was one transaction or
this. The model call, the slow step and the only one that realistically fails,
finishes before anything is deleted. The remaining window is the milliseconds
between the delete and the insert, and the whole-row snapshot closes even that:
if the insert fails, the half-written new set is cleared (otherwise the restore
collides on the dedupe key and silently restores nothing) and the originals go
back, ids and all. **A statement is never left with zero rows.**

`statement_extractions` is deliberately **not** deleted. Every parse already
appends one, so accumulating is the existing behaviour, and the extraction is
the raw evidence that "nothing is discarded" exists to protect. Only
`commission_rows` — the derived product, and the thing that doubles — is
replaced.

### The hand-work carry-over

`carryStatementHandWork()` in `// statement-core`, so the tests execute the code
that ships.

Identity is **policy number + insured + amount, all three**, normalized with the
same normalizers the dedupe key uses. Deliberately *not* the dedupe key — that
carries the date and the type, which are exactly what a parser fix changes, so
it would carry nothing forward on the only statements that need it.

Hand work means a decision a **person** made (`approved`, `rejected`, or
`match_method='manual'`). An `auto` match is the parser's opinion, and copying
it forward would freeze a stale verdict over the fresher one the re-read exists
to get.

Positional within a duplicate group: old rows are queued in order per key and
consumed in order. **Every** old row joins the queue, hand work or not, because
the queue models position — filtering first would shift an approved second twin
onto an untouched first one.

### Telling the truth in the UI

The re-read says what it does in four places **before** the click: the button
label reads `Re-read (replaces lines)`, its tooltip, the table footer, and the
confirmation. Not in a toast afterwards.

---

## Tests

`npm run test:backoffice`: **177 → 212**. Whole suite **1,976 tests across 36
suites, `fail 0`**; `npm run check` clean; **baseline not regenerated**.

No new npm script — these extend `test:backoffice`, which already runs before
`npm run check`.

| Prompt requirement | Test |
|---|---|
| 1. Refuses another agent's statement; no parameter naming an agent | `🔴 statement-delete takes the agent from the JWT and has NO parameter naming one` + `🔴 statement-delete refuses a statement that is not the caller's` (and proved live) |
| 2. No write policy on the four tables | `🔴 NO WRITE POLICY ON ANY COMMISSION TABLE, IN ANY MIGRATION` — sweeps **every** migration, quotes CLAUDE.md on failure |
| 3. Parent delete removes children and their rows | `deleting a parent statement removes its children and all their rows — by cascade` |
| 4. Delete changes no policy status, writes no history | `🔴 DELETING A STATEMENT NEVER REWRITES THE BOOK — decision 1, pinned` (and proved live) |
| 5. Result names the policies moved and the status set | `🔴 the delete result names the policies the statement moved…` + two core tests |
| 6. Re-read replaces: 9 → 9, not 18 | `🔴 A PARSER FIX RE-FINGERPRINTS EVERY LINE` — failure message carries the $262.45 → $524.90 case — plus `🔴 RE-READ REPLACES: the rows are deleted before the new ones are inserted` |
| 7. Carries on an exact three-field match, not otherwise | `an approval carries over onto an identical line, with its match` + `hand work does NOT carry when the amount, the insured or the policy number changed` |
| 8. Duplicate group, positional | `🔴 THE DUPLICATE GROUP: two identical lines keep their OWN decisions, positionally` + `position is preserved even when only the SECOND twin was touched` (Browning/Smith shapes) |
| 9. Failed re-parse leaves the originals | `🔴 A FAILED RE-PARSE LEAVES THE ORIGINAL ROWS — never zero` (both guards) |
| 10. Dedupe key and ordinal unchanged | `🔴 THE DEDUPE KEY AND ITS OCCURRENCE ORDINAL ARE UNCHANGED` — extracts `buildDedupeKeys` and asserts every part |

Plus: preview/delete are one call; `statement-delete` matches the
`statement-review` pattern; it sends no custom header (so nothing to add to
`ALLOW_HEADERS`); it is absent from `config.toml`; one call site; the
confirmation copy; and that no click reaches the replace path without the
confirmation.

---

## Deploy

```
$ supabase functions deploy statement-delete
$ supabase functions deploy statement-parse
```

| Function | Version | Updated |
|---|---|---|
| **statement-delete** | **2** | **2026-08-02 15:19:09** |
| **statement-parse** | **14** | **2026-08-02 15:19:11** |
| statement-upload | 11 | 2026-08-02 04:37:35 *(FIX1, untouched)* |
| statement-review | 8 | 2026-07-29 15:27:35 *(untouched)* |

No bulk deploy. `supabase/config.toml` **untouched**, and both are absent from
it, so both keep the platform default `verify_jwt = true`:

```
$ curl -X POST '…/functions/v1/statement-delete' -H 'Content-Type: application/json' -d '{}'
401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}

$ curl -X POST '…/functions/v1/statement-parse'  -H 'Content-Type: application/json' -d '{}'
401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}
```

That is the platform gate answering, which is the proof it is still on.

`statement-upload` was **not** redeployed. It imports `statement-core.ts`, which
gained a section this round, but nothing it calls changed.

### Which half does what

- **The git push ships `app.html`** — the Remove button, the Re-read button,
  the confirmation modal and the copy. GitHub Pages serves it, so those appear
  after the push.
- **The two function deploys ship the behaviour** — the delete itself and the
  replace. Those are already live, done above; the commit changes nothing about
  them on its own.

Both halves are needed. The buttons call functions that are already deployed.

---

## 👤 THE ONE HUMAN STEP — Jace

**What no session can prove: that this works from your browser, and that the
trend chart fills in.**

This is the same correction FIX2 asked for, except **you no longer need SQL**.
That is the point of this round.

### Do this

1. **producerstackcrm.com** → sign in → **Back Office** → **Statements**.
2. Find the **doc.pdf** row. It reads **9 lines**, **$262.45**.
3. Click **Remove** (the red one, on the right).
4. Read the confirmation. It should say:
   - *"This removes **9 commission lines totalling $262.45.**"*
   - Nothing about policies moved — that statement moved none (both of its
     matched policies were already at chargeback/paid). If it *does* name a
     policy, read it: that policy keeps its status and is worth a look.
5. **Type `doc.pdf`** in the box. The **Remove statement** button turns on.
   Click it.
6. The row disappears and the log says *"Removed doc.pdf — 9 commission lines
   totalling $262.45."*
7. **Drag the same `doc.pdf` onto the drop zone again.**

### What success looks like

- *"1 statement queued."*, then **Queued → Parsing → Persisting → Matching →
  Ingested**. About **10–25 seconds** for this file.
- The row reads **9 lines**, net **$262.45**, carrier *American-Amicable*,
  *(6 to review)*.
- **Open the lines.** All nine carry a **July 2026 date** — `07-01`, `07-09`,
  `07-27`, `07-30`. **Not one blank.**
- Types read **7 advance, 1 chargeback (−$41.33), 1 adjustment (−$45.00)**. **No
  line says "renewal."**
- The adjustment line shows **no client name** where it used to say `ME NONRES`.
- **🔴 Back Office → Commissions → the trend chart. THIS IS THE CHECK THAT
  MATTERS.** It should now show a **July bar**. Before FIX2 it was empty
  whatever money the statement carried, because an undated row is invisible to
  it.
- **Back Office → Debt.** The **−$41.33** chargeback and the **−$45.00**
  adjustment should both be there.

### If you would rather not delete it

Click **Re-read (replaces lines)** on the same row instead. Same nine lines,
same $262.45, same July dates — without removing anything. It is the shorter
path and it is what the shadow run above exercised end to end. Delete +
re-upload is written out first only because it is the one you asked for.

### Tell me

- Whether **Remove** worked from the app, and whether the typed-filename step
  read as reasonable rather than annoying.
- Whether all nine lines carry a date, and **whether the trend chart now has a
  July bar**.
- Whether the net still reads **$262.45** on screen.
- Whether the dates match the **ACCTG DATE** column on your paper copy, line by
  line.

---

## PENDING LIVE VERIFICATION

1. **Both new controls, clicked in a real browser by Jace** — the step above.
   Proven: the deployed functions do the right thing against his real bytes with
   a real user token, 26 checks out of 26. Unproven: that the modal renders,
   that the typed-filename gate feels right, and that the trend chart fills in.
2. **🔴 A ZIP has never been deleted.** The cascade is confirmed from the live
   catalogue and the child-counting is tested, but production holds **no ZIP
   statement**, so no real archive has ever been removed. The first one will
   exercise the `child_count` path for real.
3. **A re-read whose parse FAILS has never happened in production.** The restore
   is tested structurally and the ordering is pinned, but the only way to
   exercise it live is a file the model refuses mid-way. Worth knowing the
   guard has never actually fired.
4. **The moved-policies list was proved with a PLANTED history row**, because
   the owner's statement moved no policy. The shape is exactly what
   `statement-parse` writes and it was cleaned up afterwards — but the first
   statement that genuinely moves a policy *and* is then deleted is the first
   fully organic run of that path.
5. **Hand work lost has never been observed live.** Every decision carried in
   the shadow run (5 of 5) because only the dates moved. A fix that changes an
   *amount* would produce `hand_work_lost > 0`, and that copy path has only been
   unit-tested.
6. **No other carrier's PDF has ever been through any of this** — carried
   forward from FIX2 and still true. One carrier's layout is known and handled.
7. **A statement with more lines than one insert batch** (500) has never been
   replaced. The batching is unchanged, but the restore path now spans it.
