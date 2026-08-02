# PROMPT FIX2 — A parsed PDF line now knows when it happened and what kind it is

**Date:** 2026-08-02 · **Branch:** `main` · **Schema change:** none ·
**`app.html` change:** none · **Functions deployed:** `statement-parse`, and
only `statement-parse`.

> **A note on the tables below.** The owner's statement carries real client
> names, real policy numbers and his home address, and the ground rules forbid
> committing any of it here. So the rows below are **complete and verbatim in
> everything that was actually wrong** — type, date, amount, the carrier's own
> printed heading — while the insured is shown as a **neutral label** and the
> policy number is dropped. The labels are stable across the two tables, so
> the repeated line and the repeated insured are still visible. He can see the
> real rows on his own Reconciliation screen. Nothing in this repo, including
> the test fixture, uses a real name or a real policy number.
>
> (`ME NONRES`, which does appear below, is not a person — it is the carrier's
> own ledger wording for a Maine non-resident licence fee, and the fact that it
> was captured as a client's name is one of the defects.)

---

## Plain English — what was wrong

The reader was told to find "the transaction date". This carrier does not print
one. It prints an **ACCTG DATE**, a **DUE DATE** and an **ISSUE DATE**, and the
model — asked for one date with no way to say which — picked a different column
on different rows of the same page. Then none of them survived anyway, because
they are printed as `07-09` with **no year at all**, and the date parser needs
three components. Every line ended up with no date.

That is quiet in the worst way. The totals were right, the statement said
*Ingested*, the row count was right — and the trend chart, the persistency
windows and the debt drill-down all bucket on that column, so all nine lines
were simply invisible to them.

The second problem was the same shape. The prompt defined exactly one of our
seven transaction categories — chargeback — and left the model to work out the
rest from the words on the page. The page says `ORDINARY LIFE - 1ST YEAR`, in a
section heading rather than on each line, and the model reasonably read
"commission on a policy" as a renewal. Five first-year lines came back
`renewal` on a statement whose own summary line reads **TOTAL RENEWAL .00**.

So neither defect was really in the code. Both were in what the code **asked
for**. The reader was told to look for a date column this carrier does not
print, and was never told what our categories mean.

Now it is asked for each date **by what the date means**, with the names
carriers actually print (accounting, acctg, booked, posting, processed); the
year is worked out from the statement's own header date; all six categories are
spelled out along with the rule that a section heading governs the lines under
it; and the deterministic layer double-checks the answer against the carrier's
printed words rather than trusting the model alone.

---

## The owner's real statement — before and after

Run against **the actual stored bytes** of his `doc.pdf`, through the deployed
`statement-parse`, via a temporary shadow statement row pointing at the same
file. His own statement was not modified and the shadow was deleted afterwards.

### Before (what is in his book right now)

| # | Insured | Type | Date | Amount |
|---|---|---|---|---|
| 0 | `ME NONRES` ⚠️ *(not a person)* | adjustment | **—** | −$45.00 |
| 1 | Insured A | chargeback | **—** | −$41.33 |
| 2 | Insured B | **unknown** ⚠️ | **—** | $90.46 |
| 3 | Insured C | **unknown** ⚠️ | **—** | $13.75 |
| 4 | Insured D | **renewal** ⚠️ | **—** | $30.19 |
| 5 | Insured E | **renewal** ⚠️ | **—** | $36.95 |
| 6 | Insured E | **renewal** ⚠️ | **—** | $36.95 |
| 7 | Insured B | **renewal** ⚠️ | **—** | $90.46 |
| 8 | Insured F | **renewal** ⚠️ | **—** | $50.02 |

Nine rows, **nine null dates**, five wrong types, two `unknown`, and ledger
explanation text sitting in a client-name field.

### After (the fixed parser, same bytes)

| # | Insured | Type | Date | Amount | Printed heading | ACCTG |
|---|---|---|---|---|---|---|
| 0 | *(none)* ✅ | adjustment | **2026-07-27** | −$45.00 | PAYMENT OR MISC NON-INCOME ADJUSTMENT | 07-27 |
| 1 | Insured A | **chargeback** | **2026-07-09** | −$41.33 | ORDINARY LIFE - INITIAL | 07-09 |
| 2 | Insured B | **advance** | **2026-07-01** | $90.46 | ORDINARY LIFE - INITIAL | 07-01 |
| 3 | Insured C | **advance** | **2026-07-30** | $13.75 | ORDINARY LIFE - INITIAL | 07-30 |
| 4 | Insured D | **advance** | **2026-07-01** | $30.19 | ORDINARY LIFE - 1ST YEAR | 07-01 |
| 5 | Insured E | **advance** | **2026-07-01** | $36.95 | ORDINARY LIFE - 1ST YEAR | 07-01 |
| 6 | Insured E | **advance** | **2026-07-30** | $36.95 | ORDINARY LIFE - 1ST YEAR | 07-30 |
| 7 | Insured B | **advance** | **2026-07-30** | $90.46 | ORDINARY LIFE - 1ST YEAR | 07-30 |
| 8 | Insured F | **advance** | **2026-07-30** | $50.02 | ORDINARY LIFE - 1ST YEAR | 07-30 |

Every expectation the prompt set, met:

| Expected | Result |
|---|---|
| Every date populated from the accounting column | ✅ **9 of 9**, all from `ACCTG DATE` |
| Five 1st-year lines `advance` | ✅ rows 4–8 |
| Two initial lines `advance` | ✅ rows 2–3 |
| Row 1 still `chargeback` at −$41.33 | ✅ — and see the regression below |
| Misc line `adjustment` at −$45.00 with no insured | ✅ row 0 |
| Net still $262.45 | ✅ |

Type tally: **7 advance, 1 chargeback, 1 adjustment, 0 renewal, 0 unknown.**
Nine rows, nine dates, nothing unclassified.

### The net-total check

```
SELECT sum(amount_cents), count(*), count(transaction_date) ...
  net = 26245   n = 9   dated = 9
```

**$262.45.** Unchanged to the cent, and it still reconciles to the carrier's own
arithmetic: $307.45 first-year less the $45.00 misc adjustment. Money was the
one thing already correct and it stayed correct — `parseAmountCents` was not
touched.

### A detail worth recording

Comparing the two runs shows the original failure directly. On the old single
unlabelled field the model returned `07-27`, `06-15*`, `07-01*`, `08-03*`,
`07-05`, `07-13`, `08-13`, `08-01`, `08-01` — a **mix of accounting and due
dates**, inconsistent row to row, with no way for anything downstream to know
which was which. With the four labelled fields the same document yields a clean
accounting column (`07-27`, `07-09`, `07-01`, `07-30`, `07-01`, `07-01`,
`07-30`, `07-30`, `07-30`) and the due dates land in their own field. That mix
is the strongest evidence that the schema, not the model, was the defect.

**One correction to the prompt's premise, for the record:** it states the model
"correctly returned `""` for every row". It did not — it returned those MM-DD
values, and they were dropped by `parseDateISO`, which cannot read a two-part
date or one carrying a `*`. The fix needed the same shape either way, but the
mechanism was a parser gap as much as a prompt gap, which is why
`resolvePartialDate()` exists rather than just a longer prompt.

---

## 🔴 A regression this round caused, and caught

**Teaching the prompt made one line worse before it made it better.** Worth
stating plainly because it nearly shipped.

Once `PDF_SYSTEM` explained that `ORDINARY LIFE - INITIAL` means `advance`, the
model stopped answering `unknown` for row 1 and confidently answered `advance`
— for a line whose amount is **−$41.33**. And a confident answer switches OFF
the safety net: `normalizeTxnType` treats the sign as a tiebreak **only for
lines that do not name themselves**. So the chargeback became an advance.

The first verification run against the real file showed exactly that, and the
net still came to $262.45 — because a chargeback and an advance are the same
number, only pointed differently. Nothing would have complained. The line would
simply have left the **Debt tab**, which counts `chargeback` + `adjustment` and
nothing else.

Fixed as rule 3 of `refineTxnTypeFromText()`: **negative commission is a
chargeback whatever section it sits under.** Commission paid to an agent cannot
be negative; that is a reversal. Narrow on purpose —

- a negative **adjustment** stays an adjustment (a fee is not a reversal, and
  both already count as debt);
- `override` and `bonus` are left alone, not observed and not guessed;
- an existing `chargeback` is never relabelled, so a product named "Renewable
  Term" cannot undo one;
- **the tabular path's sign rule is unchanged** — there the type column carries
  the carrier's own transaction word, so "Adjustment" keeps its name whichever
  way it points. Only the PDF path, where the "type" is a product heading,
  needs the stronger rule. A test pins both halves.

---

## What changed

### `_shared/statement-ai.ts` — the instructions

- **`PDF_SCHEMA`** now asks for four dates by meaning — `transaction_date`
  (naming *accounting, acctg, booked, posting, processed* as synonyms, and
  saying plainly it is when the **carrier booked** it), `paid_date`,
  `effective_date`, `due_date` — each keeping the reproduce-exactly rule,
  explicitly permitting a year-less date, and forbidding inference. Plus
  `statement_date` from the page header, which is where a year-less date gets
  its year, and `transaction_type_text` for the carrier's own printed wording.
- **`PDF_SYSTEM`** now defines all six real categories in our terms, states
  that **a section heading governs every line beneath it**, and says outright
  that **FIRST-YEAR COMMISSION IS `advance`, NEVER `renewal`** with renewal
  defined as *past* the first year. It also tells the model an adjustment or
  balance line usually names no insured and empty is correct — generic wording,
  **no string blocklist**, since "NONRES" is one carrier's spelling of a
  problem every carrier has.

### `_shared/statement-core.ts` — the deterministic layer

- **`resolvePartialDate()`** — a bare `MM-DD` against the statement's own date,
  resolved to the **nearest** of {anchor−1, anchor, anchor+1}. Strips trailing
  markers (`06-15*`). Returns null for month 13, February 30th, a three-part
  date, or no anchor.
- **`resolveDateWithAnchor()`** — a full date if the line printed one, else the
  above. Never rewrites a real date.
- **`resolvePdfRowDates()`** — the chain, with a `source` field naming the hop
  that won.
- **`normalizePdfRows()`** — the model-rows-to-`NormalizedRow` projection,
  moved out of the edge function so the tests execute the code that ships.
- **`FIRST_YEAR_RE`** split out, and `normalizeTxnType`'s advance pattern now
  matches `1st year`, `1st yr`, `1styr`, `first yr` alongside `first year` and
  `initial`.
- **`refineTxnTypeFromText()`** — the three rules above.

### `statement-parse/index.ts`

The PDF branch is now four lines calling `normalizePdfRows`. The hard-coded
`effectiveDate: null, paidDate: null` is gone.

### Where the two chains agree and where they differ

| Hop | Tabular (`applyMapping`) | PDF (`resolvePdfRowDates`) |
|---|---|---|
| 1 | transaction date | transaction / **accounting** date |
| 2 | paid date | paid date |
| 3 | effective date | effective date |
| 4 | — | **due date** |
| 5 | — | **period end** |

The first three are identical and in the same order — a test runs the same
three shapes through both and compares. The two extra hops are PDF-only and
deliberate: a PDF has no column mapping, so there is no `-1` to distinguish
"this carrier has no such column" from "this cell is blank", and any date the
line printed is better evidence than none; `periodEnd` is the floor because a
line the carrier printed on a July statement is July money. **The tabular path
was not given them.** It shipped working, and its existing `applyMapping`
fixtures pass unchanged.

---

## Tests

`npm run test:backoffice`: **175 → 177**, and the whole suite is green
(36 suites, `fail 0`), `npm run check` clean, baseline not regenerated.

The fixture reproduces the ledger layout with **invented names and policy
numbers** — section headings, three date columns, `MM-DD` and `MM-YY`, a
trailing `*`, a negative-premium chargeback line, a misc adjustment naming
nobody, a due date after the statement date, a line with no date at all, and
two legitimately identical lines.

| Requirement | Test |
|---|---|
| Every line gets a date | `🔴 EVERY line off the ledger statement gets a transaction_date` — failure message says a null removes the row from three screens silently |
| Chain precedence, one assertion per hop | `the date chain's precedence, one hop at a time` |
| Tabular parity on the shared hops | `the first three hops are the tabular path's chain, in the tabular path's order` |
| `12-15` on `01-31-27` → Dec 2026 | `🔴 a bare MM-DD takes its year from the STATEMENT, over the December rollover` |
| `01-05` on `01-31-27` → Jan 2027 | `🔴 ...and the other direction` |
| Future due date stays future | `a due date a few days in the future stays in the future` |
| Year from the statement, not the clock | `the year comes from the statement, never from the clock` |
| MM-YY issue date not guessed | `🔴 an ISSUE date is never partial-resolved` |
| `1st year` → advance, all casings | `🔴 normalizeTxnType reads '1st year', which is what shipped broken` |
| Genuine renewal still renewal | `a genuine renewal is still a renewal` |
| Negative → chargeback regardless of section | `🔴 a negative amount is still a chargeback whatever section it sits in` + `🔴 NEGATIVE COMMISSION IS A CHARGEBACK EVEN WHEN THE MODEL SAYS advance` |
| Tabular sign rule untouched | `the tabular path's sign rule is deliberately NOT changed` |
| Both repeated lines survive | `🔴 the two identical lines both survive — the occurrence ordinal still works` |
| Money unchanged | `🔴 the money is untouched — the net still reconciles` (asserts 26245) |
| Instructions do not silently revert | 12 tests in `statement-ai.test.ts` pinning the schema and prompt |

No new npm script — these extend `test:backoffice`, which already runs before
`npm run check`.

---

## Deploy

```
$ supabase functions deploy statement-parse
Deployed Functions on project cweiaibjigjwspmshcrj: statement-parse
```

`supabase functions list` afterwards:

| Function | Version | Updated |
|---|---|---|
| **statement-parse** | **12** | **2026-08-02 14:31:48** |
| statement-upload | 11 | 2026-08-02 04:37:35 *(FIX1, untouched)* |
| statement-review | 8 | 2026-07-29 15:27:35 |

No bulk deploy. `supabase/config.toml` untouched, and `statement-parse` is
still absent from it, so it keeps the platform default `verify_jwt = true`:

```
$ curl -X POST '…/functions/v1/statement-parse' -H 'Content-Type: application/json' -d '{}'
401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}
```

That is the platform gate answering, which is the proof it is still on.

**The push does not fix this. The `statement-parse` deploy does.** `app.html`
is unchanged, so GitHub Pages is irrelevant here.

### Production residue: zero

The shadow statement and all nine of its rows were deleted. Before and after
the verification the owner's book reads identically:

```
statements 1 · files 1 · extractions 1 · rows 9 · net 26245
policies 26 · policy_status_history 41 (1 from a statement)
```

His existing statement was **not** modified — correcting it is his step below,
not mine. No policy status moved: both matched policies were already
`chargeback` / `paid`, neither of which is in `PAYABLE_FROM`, so
`status_changes` was `0` on every run.

---

## 🔴 Correcting the statement already in his book — and a gap

**Re-reading it is NOT a correction. It would double the money.**

`commission_rows` is unique on `(agent_id, dedupe_key)`, and the dedupe key is
built from carrier + policy + **date** + amount + insured + type. The nine rows
in his book were keyed with an **empty** date; the fixed parser produces dates,
so all nine keys change. The upsert uses `ignoreDuplicates`, so it would not
update the old rows — it would insert **nine new ones alongside them**. Eighteen
rows, and a net of **$524.90**.

So the old rows have to go first. And here is the gap:

> ### GAP — there is no delete-statement control in the app
>
> The Statements screen offers **Re-read** (`boParseNow`) and nothing else.
> `statement-review` handles row-level actions only — approve, reject, unmatch,
> match. There is no way for an agent to remove a statement they uploaded, and
> after this fix that is the only way to correct one.
>
> **Not built in this round** (one fix per round). It needs its own prompt: a
> delete action on `statement-review` taking the agent from the JWT,
> re-verifying ownership, cascading through `statement_files`,
> `statement_extractions` and `commission_rows`, and deciding what happens to
> any `policy_status_history` row a statement wrote. All four tables already
> cascade from `commission_statements`, so the database side is free.

### Steps for the owner, today

Until that exists, one SQL statement in the Supabase dashboard does it. It
deletes **only** the one statement; everything hanging off it cascades.

1. Open the **Supabase dashboard** → your project → **SQL Editor** → **New
   query**.
2. Paste and run exactly this, to see what you are about to delete:
   ```sql
   select id, filename, row_count, total_amount_cents, created_at
   from commission_statements
   where filename = 'doc.pdf';
   ```
   You should get **one** row, 9 lines, `26245`.
3. Then run:
   ```sql
   delete from commission_statements
   where id = '4f178e3b-497e-4f0a-b07f-9b2451f09b02';
   ```
   One row deleted. `statement_files`, `statement_extractions` and all nine
   `commission_rows` go with it automatically.
4. **Optional, and only if you want the history tidy.** The first ingestion
   moved one policy to `chargeback` and recorded why. That change was correct
   and re-uploading will not repeat it (the policy is already `chargeback`), so
   the normal answer is to **leave it alone**. It is a true record of what the
   carrier said.
5. Go back to **producerstackcrm.com** → **Back Office** → **Statements** and
   **upload `doc.pdf` again**. It will be treated as new, because the
   SHA-256 uniqueness row went with the delete.

If you would rather not touch SQL, say so and it can be done for you — but the
statement is yours and deleting rows from your book is not something a session
should do without you asking.

---

## 👤 THE ONE HUMAN STEP — Jace

**What no session can prove: that the numbers on your screen match the paper.**

### Do this

1. Delete the old statement — **steps 1–3 above**.
2. **producerstackcrm.com** → sign in → **Back Office** → **Statements**.
3. Drop **the same American-Amicable `doc.pdf`** on the drop zone.

### What success looks like

- *"1 statement queued."*, then the strip moves **Queued → Parsing →
  Persisting → Matching → Ingested**. Around **10–25 seconds** for this file.
- The statement row reads **9 lines**, **net $262.45**, carrier
  *American-Amicable*, and *(6 to review)*.
- **Open the lines.** Every one of the nine now shows a **date in July 2026**
  — `07-01`, `07-09`, `07-27`, `07-30`. **Not one blank.** That is the whole
  point of this round.
- The types read **7 advance, 1 chargeback (−$41.33), 1 adjustment (−$45.00)**.
  **No line says "renewal"** — your statement's own summary says
  `TOTAL RENEWAL .00`, and now the app agrees.
- The adjustment line shows **no client name** where it used to say
  `ME NONRES`.
- **Back Office → Commissions → the trend chart.** It should now show a July
  bar. Before this fix it was empty however much money the statement carried,
  because an undated row is invisible to it. **This is the check that matters
  most** — everything else was already visible on the Statements screen.
- **Back Office → Debt.** The −$41.33 chargeback and the −$45.00 adjustment
  should both appear. If the chargeback is missing, the regression above came
  back.

### Tell me

- Whether all nine lines carry a date, and whether **the trend chart now has a
  July bar**.
- Whether the net still reads **$262.45** on screen.
- Whether the dates match the **ACCTG DATE** column on your paper copy,
  line by line. They should — that is the column we now key on, by decision.
- Whether the 6 lines in review *should* have matched policies. Matching is a
  separate question from this round and the low match rate is expected while
  most of your policies carry no policy number.

---

## PENDING LIVE VERIFICATION

1. **This statement, re-uploaded through the browser by Jace** — the step
   above. Proven: the deployed parser produces nine correctly dated,
   correctly typed rows from these exact bytes. Unproven: that it looks right
   on his screen and that the trend chart fills in.
2. **🔴 ANY OTHER CARRIER'S PDF. Nothing else has ever been tested.** One
   carrier's layout is now known and handled. Americo, Transamerica, Mutual of
   Omaha, Corebridge, Aetna and Foresters have never had a PDF through this
   pipeline, and this round is direct evidence that each one can print dates
   and types in a shape nobody anticipated. Expect the next carrier to need its
   own round; the tests are structured so adding a layout is a fixture, not a
   rewrite.
3. **A date format still unhandled.** `resolvePartialDate` covers `MM-DD`. A
   carrier printing `DD-MM` (rare in the US), a Julian day, or a week number
   would fall through to the period-end floor — which is safe, not silent, but
   is not the right date.
4. **`MM-YY` is read by nothing.** An issue date of `06-26` is deliberately
   dropped rather than guessed. If a carrier's *only* date is `MM-YY`, its rows
   will bucket on the period end. Correct behaviour; worth knowing.
5. **A multi-page or long PDF.** This statement is one page and nine lines. The
   `truncated` path, `MAX_ROWS_PER_STATEMENT` and a statement spanning several
   accounting months have never run against real paper.
6. **The status write-back has still never fired from a PDF.** Both matched
   policies happened to be at `chargeback`/`paid`, outside `PAYABLE_FROM`, so
   `status_changes` was 0 on every run. The first statement that matches a
   `pending`/`approved` policy will exercise code no live run has touched.
7. **The delete-statement gap** — no UI control exists; see above. Until it is
   built, every statement correction needs dashboard SQL.
