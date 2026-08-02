# Back Office — commission statement ingestion

Built 2026-07-29 (Phase 1 of the Back Office mission). Turns a carrier
commission statement — PDF, Excel, CSV, or a ZIP of them — into normalized
commission lines matched against the Policy Tracker.

**Read this before touching anything named `bo*`, `statement*`, or
`commission_*`.** Progress ledger and per-phase decisions:
`docs/back-office-progress.md`.

---

## The organising idea

> **The model derives a template per file. It does not read the rows.**

A tabular statement costs **one Anthropic call per sheet**, whatever its row
count. The model sees the header row and a handful of sample rows and returns a
*column mapping*; `statement-core.ts` then applies that mapping to every row
deterministically. A 10,000-row statement and a 10-row statement cost the same.

This is still template-free in the sense that matters — nobody configures
anything per carrier — but it puts the per-row arithmetic (money, dates,
transaction types, dedupe keys) in code that is unit-tested and does the same
thing every time, instead of in a model that might not.

PDFs are the exception: there is no column structure to derive, so the document
goes to the model natively and rows come back directly.

---

## The pipeline

```
 upload                       statement-upload  (service role)
   │  raw bytes, filename in a header
   ├─ sha256 ────────────────► UNIQUE (agent_id, sha256): a repeat returns the
   │                            existing statement instead of ingesting twice
   ├─ detect kind from MAGIC BYTES (never the extension)
   ├─ ZIP? expand: archive row + one queued statement per member
   └─ store bytes ──────────► statement_files          status: queued
                                                             │
 parse                        statement-parse  (service role)│
   ├─ parsing    ── read the file, one AI call per sheet ────┤
   │                 └─ raw model output ► statement_extractions
   ├─ persisting ── normalize + dedupe keys
   ├─ matching   ── policy number → masked suffix → insured name
   └─ ingested   ── counters written back to the statement
                     (any step can land on `failed`, which is re-runnable)
```

`status` on `commission_statements` is the state machine the UI's live counters
render. It is real data, not an animation — the screen polls only while
something is genuinely in one of the four in-flight states.

---

## Nothing is discarded

Three separate guarantees, because "the parse is the only record" is how an
ingestion product loses somebody's money:

| What | Where | Why |
|---|---|---|
| The file exactly as uploaded | `statement_files.content` (bytea) | The agent can download the original from the row. Evidence, not a cache. |
| The model's verbatim answer | `statement_extractions.raw_output` | Written **before** our normalizer runs. If the normalizer is wrong, or a transaction-type mapping changes in six months, the extraction is still there to re-derive from without another API call. |
| Lines that matched nothing | `commission_rows` with `review_status='needs_review'` + a plain-English `review_reason` | Counted on the pipeline strip and highlighted in the drill-down. Phase 6 builds the triage screen; Phase 1 already stores everything it needs. |

---

## Idempotency, at two grains

**File grain** — `UNIQUE (agent_id, sha256)`. Re-uploading identical bytes
returns the existing statement. The UI says so ("One file was already ingested,
so it was not read again") rather than appearing to do nothing, because silence
reads as a bug. It is per-agent on purpose: two agents legitimately receive the
same carrier statement.

**Row grain** — `UNIQUE (agent_id, dedupe_key)`, where the key hashes
carrier + policy number + insured + date + amount + transaction type, **plus an
occurrence ordinal**.

The ordinal is the whole point. A statement legitimately containing two
identical adjustment lines must keep both; re-parsing that same statement must
still produce exactly those two keys and write nothing new. Counting
occurrences in row order gives both properties at once. Verified live: a
re-read of an ingested statement reports `inserted=0, already_present=4`.

---

## Correcting a statement — removing one, and re-reading one (FIX3)

### 🔴 Why a re-read has to REPLACE

The row key above carries the transaction **date**, the **amount** and the
**occurrence ordinal**. That is correct, and none of it changes. But it means
**any** parser improvement touching one of them re-fingerprints every line of
every statement already ingested — and the upsert is `ignoreDuplicates`, so
nothing collides and nothing is *updated*. A second read lands a complete
second set of rows **beside** the first.

FIX2 turned nine null dates into real July dates. Re-reading the owner's
statement would have produced **18 lines and $524.90** for a statement that
carries nine lines and $262.45. This is not a one-off caused by FIX2: it is the
shape of every future parser fix.

So `statement-parse` takes **`replace: true`**, for ONE named statement (a
sweep must never rewrite everybody's book).

**The order is the safety property.**

1. Snapshot the statement's existing rows — **whole rows**, ordered by
   `row_index`. It does two jobs: it is what the carry-over reads, and it is
   what goes back if step 4 fails.
2. **Parse.** The model call — the slow step, the network step, the only one
   that realistically fails — finishes here, with nothing yet deleted. A failed
   re-parse therefore leaves the original rows exactly where they were.
3. Delete the statement's `commission_rows`, scoped to the statement *and* the
   agent.
4. Insert the new rows. If this fails, clear whatever part of the new set
   landed (otherwise the restore collides on the dedupe key and silently
   restores nothing) and put the snapshot back, ids and all.

PostgREST has no transaction across calls, so the choice was one transaction or
re-parse-first-and-swap-on-success. This is the second, plus the restore, which
closes the millisecond window the second option leaves open. **A statement left
with zero rows is worse than the doubling this fixed**, so it must not be
reachable from any path.

`statement_extractions` is **not** deleted by a replace. Each parse already
appends one (tabular appends one per sheet), so accumulating is the existing
behaviour, and the extraction is the raw evidence — the thing "nothing is
discarded" protects.

### The hand-work carry-over

`carryStatementHandWork()` in `// statement-core`.

**The identity is policy number + insured name + amount, all three**,
normalized with the same normalizers the dedupe key uses. Deliberately **not**
the dedupe key: that carries the date and the type, which are exactly what a
parser fix changes, so a rule strict enough to include them would carry nothing
forward on the only statements that need it.

**Hand work is a decision a PERSON made** — `review_status` of `approved` or
`rejected`, or `match_method = 'manual'`. An `auto` match is the parser's
opinion; copying it forward would freeze a stale verdict on top of the fresher
one the re-read exists to get. What carries is `review_status`,
`matched_policy_id`, `match_method`, `match_confidence`, `review_reason`,
`review_note`, `reviewed_at`, `reviewed_by` — the decision *and* its
provenance, so a carried match stays coherent with the id it points at.

**🔴 POSITIONAL WITHIN THE DUPLICATE GROUP.** The owner's own ledger prints
Browning $36.95 twice and Smith $90.46 twice — identical on all three fields,
which is why the dedupe key has an ordinal at all. Old rows are queued **in
order** per key and consumed in order; first-match-wins would attach one twin's
approval to the other. **Every** old row joins the queue, hand work or not,
because the queue models POSITION — filtering first would shift an approved
second twin onto an untouched first one.

Anything not matched on all three is left at whatever the parse produced. What
did not carry is **counted and reported** (`hand_work_carried`,
`hand_work_lost`), never quietly absorbed: a line whose amount the fix
corrected genuinely is a different line, and the agent has to know their
approval went with the old reading of it.

### Removing a statement — `statement-delete`

An **edge function**, matching `statement-review` rather than introducing a
second pattern: agent from the JWT, no agent id in the body, service-role
client, CORS by origin, `OPTIONS` handled, no custom request headers (so
nothing to add to `ALLOW_HEADERS`), absent from `config.toml` so `verify_jwt`
stays true.

**The four commission tables remain SELECT-only for `authenticated`.** This
round added no INSERT/UPDATE/DELETE policy to any of them, and a test now
sweeps *every* migration for one.

`preview` and `delete` are **the same call with one flag**, through one
`summarizeStatementDeletion()`. A preview computed by separate code is a
preview that eventually lies, and this confirmation's whole job is to promise
what the button will do.

It issues **ONE** delete — the parent statement row — and lets the cascade do
the rest. Four foreign keys reference `commission_statements` and all four
cascade (verified against the live catalogue, not just the migration text):

| Child | Column | On delete |
|---|---|---|
| `commission_rows` | `statement_id` | CASCADE |
| `statement_files` | `statement_id` | CASCADE |
| `statement_extractions` | `statement_id` | CASCADE |
| `commission_statements` (ZIP members) | `parent_statement_id` | CASCADE |

Nothing else references any of the four tables. Deleting a ZIP therefore
removes every statement that came out of it and every row those produced — the
archive **is** the upload — but that is invisible from the row the agent
clicked, so the confirmation counts and names them.

### 🔴 A delete never rewrites the book

Policies keep whatever status the statement set. `policy_status_history` is
owner-appendable with no update and no delete policy, and its `source_ref_id`
carries no foreign key, so those rows **survive the delete deliberately**: a
carrier having said "charged back" stays true after the paperwork proving it is
removed, and the trail is not something a delete may rewrite.

What the agent gets instead is the **list** — insured, policy number, and the
status the statement set — in the confirmation *and* in the result, with the
plain sentence that those policies keep that status and are worth checking.
Collapsed to **one entry per policy** (`from` the earliest change, `to` the
latest); a statement that moved the same policy twice listing that person twice
reads as a bug rather than as history. That collapse was caught by the live
shadow run, not by a unit test.

### The confirmations

Neither irreversible action uses `confirm()` — a one-line browser dialog cannot
show the list of policies, and that list is the point. Both go through
`#boDeleteModal`. The delete additionally requires the **filename to be typed**
(trimmed, case-insensitive: the requirement is deliberateness, not
transcription) and its button starts disabled.

The re-read says what it does **before** the click, in four places: the button
label (`Re-read (replaces lines)`), its tooltip, the table footer, and the
confirmation. Not in a toast afterwards.

---

## Matching

In order, stopping at the first that resolves to exactly one policy:

1. **Exact policy number** (compared on alphanumerics only — carriers print
   separators inconsistently). Confidence 1.
2. **Masked suffix**, last five digits. Transamerica prints `xxxxx76911`.
   Confidence 0.9.
3. **Unique insured name**, normalized (`SMITH, JOHN A.` → `john a smith`,
   honorifics dropped). Confidence 0.75.
4. **Name + carrier**, when the name alone is ambiguous but exactly one
   candidate is on the statement's carrier. Confidence 0.8.

Anything ambiguous is **refused, not guessed**, and the refusal carries the
reason the agent sees on screen (*"2 policies share that insured name"*).

---

## Known carrier shapes

### American-Amicable — AGENT LEDGER STATEMENT (PDF)

The first real carrier statement put through this pipeline, 2026-08-02. It
broke two assumptions the PDF reader was built on, and both fixes are in
`PROMPT_FIX2` (`docs/reports/PROMPT_FIX2-report.md`).

**Three date columns per line, and none of them is called "transaction date":**

| Printed | Format | Example | Maps to | Why |
|---|---|---|---|---|
| `ACCTG DATE` | `MM-DD` | `07-09` | **`transaction_date`** | When the carrier BOOKED the commission. On every line, and it keeps a July statement in July. |
| `DUE DATE` | `MM-DD` | `08-13` | `due_date` | The premium's next due date. Legitimately **after** the statement date. |
| `ISSUE DATE` | `MM-YY` | `06-26` | `effective_date` | June 2026 — a month, not a day. |

Consequences that generalise beyond this carrier:

- **The year is not printed.** It is resolved against the statement header's
  own `DATE 07-31-26`, by nearest year, so December on a January statement is
  *last* December and a due date a fortnight out stays in the future. Never
  from `new Date()`.
- **`ISSUE DATE` is never partial-resolved.** `06-26` as a string is
  indistinguishable from June 26th, so reading it would invent a day and then
  bucket the row on it. It falls through the chain instead.
- **Dates carry markers** — `06-15*` — which are stripped, not fatal.

**The transaction type lives in a SECTION HEADING, never on a line.** The
statement is divided into `ORDINARY LIFE - INITIAL` and
`ORDINARY LIFE - 1ST YEAR`, plus a `PAYMENT OR MISC NON-INCOME ADJUSTMENT`
line. **Both life sections are `advance`** — neither is a renewal, and the
statement's own summary confirms it with `TOTAL RENEWAL .00`. The heading is
captured verbatim into `transaction_type_text` so the deterministic layer can
overrule a model that disagrees.

**A negative line under a life heading is a chargeback**, established by the
sign and not by the heading — see `refineTxnTypeFromText()` rule 3.

**The misc adjustment line names no insured.** Its ledger explanation text is
not a person and must not be captured as one; empty is the right answer.

A nine-line example of this layout — real structure, **invented names and
policy numbers** — is the fixture in `statement-core.test.ts`. The owner's
actual statement is never committed to this repo.

---

## Where the caps are, and why they are there twice

| Cap | Value | Enforced |
|---|---|---|
| Per file | 10 MB | Browser (`BO_MAX_FILE_BYTES`) **and** `statement-upload` |
| Per upload batch | 25 MB | Browser (`BO_MAX_BATCH_BYTES`) |
| ZIP members | 25 | `statement-upload` |
| ZIP uncompressed total | 50 MB | `readZip` — a zip-bomb guard |
| Rows per statement | 20,000 | `statement-parse` |

Not Orion's 500 MB: the bytes cross an edge function's request body and land in
a Postgres column, and a real carrier statement is a few hundred KB. The
browser copy exists so a 40 MB PDF is refused *before* a minute of uploading;
the server copy exists because the browser is not a security boundary. A test
asserts the two agree.

---

## Security posture

`commission_statements`, `statement_files`, `statement_extractions` and
`commission_rows` are **SELECT-only for `authenticated`**. There is no INSERT,
UPDATE or DELETE policy on any of them — RLS-enabled-with-no-write-policy is
how "service-role only" is expressed in Postgres, the same shape as
`consent_records`, `lead_transfers` and `reputation_config`.

Every write goes through `statement-upload` or `statement-parse`, both of which
take the agent **from the JWT**. There is no agent id anywhere in either
request body; a body-supplied one would be a way to write into someone else's
book.

Verified live against production: another agent sees zero rows, zero
statements and zero stored bytes, and even the owner gets `403` attempting a
direct `POST /commission_rows`.

`get_ingestion_summary()` is `SECURITY INVOKER` — it reads through the
caller's own RLS, so it cannot return anyone else's figures even by accident.
Cross-agent aggregates arrive in Phase 4 as a deliberate `SECURITY DEFINER`
RPC, not as a loosened policy.

---

## Zero dependencies, on purpose

This repo imports exactly two external modules across every edge function
(`std/http/server`, `supabase-js`). Ingestion adds none:

- **Raw DEFLATE** is a ~200-line pure-JS inflate. `DecompressionStream('deflate-raw')`
  would work on today's runtimes and quietly stop working on an older one;
  inflate never will, and it keeps the whole core synchronous and therefore
  trivially testable.
- **XLSX** is a ZIP of XML, so one reader serves `.xlsx` and `.zip` both.
- **XLS** is a minimal OLE2/CFB + BIFF8 reader. Carriers still export it, and
  "please re-save that as something else" is a support burden, not an answer.
  Both storage layouts are covered: small workbooks live in the CFB *mini
  stream*, large ones in the ordinary FAT chain, and a reader that handles only
  one fails on half the files it meets.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260739_back_office_ingestion.sql` | 4 tables + `get_ingestion_summary()` |
| `supabase/functions/_shared/statement-core.ts` | Pure: inflate, ZIP, XLSX, XLS, CSV, header detection, normalizers, mapping projection, dedupe keys, matching |
| `supabase/functions/_shared/statement-core.test.ts` | 57 tests, fixtures **built** not checked in |
| `supabase/functions/_shared/statement-ai.ts` | The only Anthropic caller — column mapping + PDF rows |
| `supabase/functions/_shared/statement-ai.test.ts` | 9 tests over the coercion and base64 |
| `supabase/functions/statement-upload/index.ts` | Bytes in, statement queued |
| `supabase/functions/statement-parse/index.ts` | The worker — and, with `replace: true`, the re-read that replaces |
| `supabase/functions/statement-delete/index.ts` | Removing a statement: `preview` / `delete`, agent from the JWT (FIX3) |
| `app.html` — `// <backoffice-core>` block | Pure UI logic, extracted and executed by the tests |
| `app.html` — `#sec-backoffice`, `bo*` functions | The screen |
| `test/back-office.test.mjs` | 36 behaviour + structure tests against `app.html` as source text |

### Why the tests extract from `app.html`

Same reason as `test/team-roster.test.mjs`: `app.html` has no build step and no
module system, so a mirrored copy of the logic in a `.mjs` file would be a
second definition that drifts. The test pulls the text between the
`// <backoffice-core>` sentinels out of `app.html` and executes it. Keep that
block pure — no DOM, network, storage or app globals; a test asserts that too.

---

## Verification performed at build time

| Layer | Result |
|---|---|
| Schema, behavioural (rolled back) | **14/14** — both idempotency grains, both check constraints, bytea round-trip, RLS from two agents, summary RPC scoping |
| Unit tests | **102** across the parsing core, the AI coercion and the `app.html` core |
| End-to-end against production | **36/36** — real edge functions, real Haiku parsing, throwaway accounts, synthetic statements |
| Headless click-through | **22/22** — real browser, real file input, rendered DOM |
| Residue after both runs | **zero** |

The whole end-to-end run cost **5,869 tokens across 3 API calls** for 10
commission lines — one call per sheet, which is the cost property the design
exists to get.

### What the live runs found

Two real defects, both fixed and both now covered by a unit test:

1. **A statement that prints only a "Paid Date" produced rows with a null
   `transaction_date`.** That is the column the trend chart, the persistency
   windows and the debt drill-down all bucket on, so every such row would have
   silently vanished from all three. `transactionDate` now falls back to the
   paid date, then the effective date; the specific fields stay as printed.
2. **`parseAmountCents` lost a cent on `0.145`** — `value * 100` in binary
   floating point is `14.499999999999998`. It now works on the decimal string,
   so money is exact. On a table meant to reconcile against a carrier's own
   totals, a cent is not a rounding detail.

### 🔴 What the live runs did NOT find — browser upload never worked at all

**Fixed 2026-08-01 (`PROMPT_FIX1`). Everything in the table above was true and
none of it touched the browser's CORS preflight, so the one path an agent
actually uses had never run.**

`boUpload()` in `app.html` POSTs the raw bytes with two custom request headers,
`x-filename-b64` and `x-content-type` (see the transport note at the top of
`statement-upload/index.ts` for why the filename travels in a header). A custom
header forces the browser to send a preflight `OPTIONS` naming it, and
`Access-Control-Allow-Headers` in `_shared/cors.ts` listed only
`authorization, x-client-info, apikey, content-type`. So the browser **blocked
the request before sending it**: the `fetch` rejected with `Failed to fetch`,
the edge function was never invoked, and there was no log, no error row and
nothing to grep. Every upload from the Statements screen had failed this way
since the day the feature shipped.

The corroboration was in the database: `commission_statements`,
`statement_files`, `statement_extractions` and `commission_rows` were **all
zero rows** on 2026-08-01, against a book of 26 policies.

The reason the build-time verification missed it is that **every layer in the
table above reaches the function without a browser origin** — the end-to-end
runs were server-to-server against the deployed functions, where no preflight
is ever sent. A test now derives the set of custom headers from `app.html` and
asserts each one is allowed (`npm run test:cors`,
`test/cors-headers.test.mjs`), because the list and its callers were previously
connected by nothing but memory.

**The fix is a redeploy, not a push.** `app.html` is unchanged; what answers the
preflight is the running bundle of `statement-upload`.

### The end-to-end run after the fix (2026-08-01)

Driven with a real user JWT for the owner's own account, `Origin:
https://producerstackcrm.com`, and the exact headers `boUpload()` sends — a
three-line CSV and a three-line PDF of the same statement.

| Step | CSV | PDF |
|---|---|---|
| `statement-upload` accepted the bytes | ✅ 200, `queued: 1` | ✅ 200, `queued: 1` |
| `commission_statements` + `statement_files` row | ✅ | ✅ |
| `statement_extractions` row (model's verbatim answer) | ✅ `column_mapping` | ✅ `pdf_rows` |
| `commission_rows` landed | ✅ 3 | ✅ 3 |
| matched to a policy | ✅ 2 (`policy_number` 1.0, `name` 0.75) | ✅ 2 (same) |
| `needs_review` with a reason | ✅ 1 | ✅ 1 |
| status write-back | 0 changes (by design — the matched policies were already `paid`) | 0 changes |

Both parsed on `claude-haiku-4-5`; the CSV cost one call (1,765 in / 151 out),
the PDF one call (2,563 in / 255 out). Both totalled `309999` cents, exact.
All rows were deleted afterwards and the four tables verified back at zero.

**One defect found and deliberately NOT fixed in that round** — see
`docs/reports/PROMPT_FIX1-report.md`: the `transaction_date` fallback recorded
above as fix (1) lives in `applyMapping()` (the tabular path) and **the PDF
branch of `statement-parse` has no fallback at all**. It hard-codes
`effectiveDate: null, paidDate: null` and writes `parseDateISO(r.transaction_date)`
straight through, so a PDF whose line items carry no per-line date writes
`transaction_date = null` on every row — and those rows vanish from the trend
chart, the persistency windows and the debt drill-down exactly as described
above. `period_start` / `period_end` are resolved correctly and are on the same
object, unused.

**FIXED in `PROMPT_FIX2` (2026-08-02)**, together with a second defect the
owner's first real carrier PDF exposed — first-year commission labelled
`renewal` — after that statement ingested with all nine amounts exact and not
one date. See § "Known carrier shapes" below and
`docs/reports/PROMPT_FIX2-report.md`.

A third change came out of adding the nav item rather than from ingestion:
`nav()` and `restoreSectionFromCache()` each carried a **positional** nav-item
index map that had to be hand-corrected whenever the sidebar grew.
`_applyPlanGating()` had already learned that lesson expensively (see its
comment). Both are now resolved by section name, and a test asserts the
positional map does not come back.

---

## Testing it by hand

1. **Back Office** in the sidebar. With no statements you should get a real
   empty state explaining what to drop, not a blank panel.
2. **Drop a statement** — or click the zone and pick one. Watch the pipeline
   strip: Queued → Parsing → … → Ingested. The screen stops polling once
   nothing is in flight.
3. **The row** shows carrier, statement period, line count, matched count with
   *(N to review)*, and the net total — negative if chargebacks outweigh
   commission.
4. **View lines.** Chargebacks render as negative money; unmatched lines are
   highlighted with the reason on screen.
5. **Drop the same file again.** Expect *"One file was already ingested, so it
   was not read again"* and no second row.
6. **Drop a `.docx`.** Expect *"notes.docx was not sent — not a PDF, Excel, CSV
   or ZIP file"*, refused in the browser without an upload.
7. **Original** downloads the exact bytes you uploaded.
8. **A failed statement** shows the reason inline and a **Try again** button;
   re-running it never duplicates lines.
