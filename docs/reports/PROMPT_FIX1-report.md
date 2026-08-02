# PROMPT FIX1 — Statement upload was blocked by its own CORS preflight

**Date:** 2026-08-01 · **Branch:** `main` · **Schema change:** none ·
**`app.html` change:** none · **Functions deployed:** `statement-upload`, and
only `statement-upload`.

---

## Plain English — what was broken and what works now

The Statements screen let you drop a commission statement on it, and then said
`doc.pdf could not be uploaded — Failed to fetch`. It had said that to every
upload since the feature shipped. Nobody could see why, because **nothing was
going wrong on the server — nothing was reaching the server at all.**

When a web page sends a request carrying a header the browser does not
recognise as standard, it does not just send it. It first sends a small
permission question — "may I send a request with a header called
`x-filename-b64`?" — and waits for the server to answer with a list of headers
it accepts. Our upload sends the filename in a header exactly like that (base64
encoded, so a filename with an accent or an emoji in it survives the trip). Our
answer listed four headers and neither of ours was among them.

So the browser refused on the server's behalf and never sent the upload. From
the page's point of view the network failed. From the server's point of view
nothing ever happened — no request, no log line, no error to find. That is why
this survived a full build-time verification pass: every one of those tests
called the function directly from a script, and a script does not ask
permission. Only a browser does.

The proof it had never worked once: on the day of this fix, the four tables
that hold uploaded statements — the statement record, the stored file bytes,
the model's extraction and the commission lines — were **all completely empty**,
against a book of 26 real policies.

The fix is two header names added to one list. The important half is that the
fix has to be **deployed**, not just committed: what answers that permission
question is the copy of the function running on Supabase, not the code in the
repo. `app.html` did not change, so pushing to GitHub Pages was irrelevant
here — and the function has been redeployed and the answer verified live.

I then drove the whole chain end to end with a real signed-in session and both
a CSV and a PDF statement. Everything downstream works: the bytes are stored,
the model reads the file, the commission lines land, and they match back to the
right policies. One real defect turned up on the PDF path, described below and
left for its own round. All test data was deleted; the tables are back at zero.

---

## The two `curl` preflights, verbatim

### BEFORE — the browser is refused

```
$ curl -i -X OPTIONS 'https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/statement-upload' \
    -H 'Origin: https://producerstackcrm.com' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: authorization, content-type, x-filename-b64, x-content-type'

HTTP/1.1 200 OK
Date: Sun, 02 Aug 2026 04:34:15 GMT
Content-Type: text/plain;charset=UTF-8
Transfer-Encoding: chunked
Connection: keep-alive
CF-Ray: a24a5e7cac1872e4-ORD
CF-Cache-Status: DYNAMIC
Access-Control-Allow-Origin: https://producerstackcrm.com
Server: cloudflare
Vary: Accept-Encoding, Origin
access-control-allow-headers: authorization, x-client-info, apikey, content-type
access-control-allow-methods: POST, OPTIONS
sb-gateway-version: 1
sb-project-ref: cweiaibjigjwspmshcrj
sb-request-id: 019fc0c0-49eb-7286-881c-21bd71ce497a
x-deno-execution-id: 431c9a91-702e-49ab-beff-be6dae8f213a
x-sb-edge-region: us-east-2
x-served-by: supabase-edge-runtime
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
alt-svc: h3=":443"; ma=86400

ok
```

`access-control-allow-headers` names neither `x-filename-b64` nor
`x-content-type`. The `200 OK` is the trap: the *preflight* succeeded, and the
browser then refused the real request on its own. There is nothing on the
server to see.

### AFTER — the browser is allowed

```
$ curl -i -X OPTIONS 'https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/statement-upload' \
    -H 'Origin: https://producerstackcrm.com' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: authorization, content-type, x-filename-b64, x-content-type'

HTTP/1.1 200 OK
Date: Sun, 02 Aug 2026 04:37:44 GMT
Content-Type: text/plain;charset=UTF-8
Transfer-Encoding: chunked
Connection: keep-alive
CF-Ray: a24a639749bb2c32-ORD
CF-Cache-Status: DYNAMIC
Access-Control-Allow-Origin: https://producerstackcrm.com
Server: cloudflare
Vary: Accept-Encoding, Origin
access-control-allow-headers: authorization, x-client-info, apikey, content-type, x-filename-b64, x-content-type
access-control-allow-methods: POST, OPTIONS
sb-gateway-version: 1
sb-project-ref: cweiaibjigjwspmshcrj
sb-request-id: 019fc0c3-7a8d-7f78-b3a1-02436d241da7
x-deno-execution-id: 6ba15986-4ed5-4494-a2ce-608bbd3114db
x-sb-edge-region: us-east-2
x-served-by: supabase-edge-runtime
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
alt-svc: h3=":443"; ma=86400

ok
```

Both custom headers are present. **This response is the proof, not the commit
and not the test.**

---

## Corroboration that it had never worked

`supabase db query --linked`, immediately before the fix:

```json
{ "statements": 0, "files": 0, "extractions": 0, "rows": 0, "policies": 26 }
```

Four empty ingestion tables against a live 26-policy book. Consistent with the
original commit's own note that the feature was "built and deployed, NOT
proven", and with the fact that `docs/back-office-ingestion.md`'s build-time
verification table records only server-to-server runs — which never send a
preflight.

---

## The change

`supabase/functions/_shared/cors.ts` — one string, plus a comment block
explaining the failure mode, and the value lifted into a named export so a test
can read it and `corsHeaders()` cannot keep a second copy:

```ts
export const ALLOW_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-filename-b64, x-content-type";
```

Nothing else in that file moved: `ALLOWED_ORIGINS`, `DEV_ORIGINS`,
`ALLOW_DEV_ORIGINS`, `resolveAllowedOrigin()` and the `X-Dev-Origins-Allowed`
diagnostic header are byte-identical, and the list is not widened to `*`.
`app.html`'s upload call is untouched — the headers carry the filename safely
and removing them would be fixing the wrong end.

---

## The test — derived, not hand-listed

`test/cors-headers.test.mjs`, wired in as `npm run test:cors` and added to the
`npm test` chain (35 suites → 36).

### How the extraction is scoped

Hand-listing is what caused this bug, so the test reads the callers instead.
The naive scan the prompt suggests — `grep -oE "'x-[a-z0-9-]+'" app.html` —
finds **three** distinct strings, and one of them is not a header:

| string | occurrences | what it is |
|---|---|---|
| `x-circle` | 3 | an icon name (`data-ico`), not a request header |
| `x-filename-b64` | 1 | a real request header |
| `x-content-type` | 1 | a real request header |

So the scan is scoped structurally rather than lexically:

1. Find every `headers:` occurrence in `app.html` and take the **brace-balanced
   `{ … }`** that follows it. There are **14**, and all 14 are simple object
   literals — this also covers `sb.functions.invoke(url, { headers: … })`, not
   just bare `fetch`.
2. Inside each, match **keys only** — `'quoted'`, `"quoted"` and bare
   (`Authorization`, `apikey`) are all used in this file. Values are ignored, so
   `'Authorization': 'Bearer ' + token` is not read as a header called `Bearer`.
3. Keep the keys matching `/^x-/i`, lowercased and deduped.

**What it found:** exactly `x-content-type` and `x-filename-b64`, both from the
one object at [app.html:30995](../../app.html#L30995). `x-circle` is excluded,
and a second test asserts it stays excluded — if the icon name ever leaks into
the header set, the scan has stopped being scoped.

Deliberately over-inclusive in one respect: it reads **every** `headers:`
object, including the one call that goes to Google Calendar rather than to one
of our functions. Over-inclusion produces a loud, fixable test failure;
under-inclusion produces exactly the silent bug this round fixed. The failure
message says so, and says that a third-party header is a decision to record
rather than a reason to widen our CORS list.

### The failure message

Verified by mutation — reverting `ALLOW_HEADERS` to its old value and re-running
gives:

```
✖ 🔴 EVERY CUSTOM HEADER app.html SENDS IS ALLOWED BY THE PREFLIGHT
  AssertionError: These custom request headers are sent by app.html but are NOT in
  Access-Control-Allow-Headers in supabase/functions/_shared/cors.ts:

      x-filename-b64   (app.html:30995)
      x-content-type   (app.html:30995)

  A custom header the browser sends but CORS does not allow means that call is
  DEAD IN EVERY BROWSER, WITH NO SERVER LOG, BECAUSE THE REQUEST IS NEVER SENT.
  …
  Fix: add the header to ALLOW_HEADERS in cors.ts and REDEPLOY the function that
  receives it — the commit alone changes nothing, the running bundle is what
  answers the preflight. Do not widen the list to "*".
```

Five further tests in the same file: the decoy check, a pin on the current
contents plus the assertion that `statement-upload` actually reads both names,
a no-wildcard / originals-survive / origin-rules-untouched check, an assertion
that `corsHeaders()` returns the constant rather than its own copy of the
string, and an assertion that `statement-upload` stays absent from
`config.toml`.

### There was no existing CORS coverage to extend

The prompt suggested extending existing CORS-adjacent coverage. There is none:
a repo-wide search of every `*.test.ts` / `*.test.mjs` for `cors.ts`,
`corsHeaders`, `Allow-Origin`, `Allow-Headers`, `ALLOWED_ORIGINS`,
`DEV_ORIGINS` and `resolveAllowedOrigin` returns **one** file,
`test/sms-ai-responder.test.mjs`, and its only hit is a local `CORS` variable
name inside an unrelated assertion string. `_shared/cors.ts` had never been
tested. A new file was also the right home on its own merits: the invariant is
between `app.html` as a whole and one shared module, not a back-office concern
— the next stray header could come from any feature, and finding it asserted
inside `back-office.test.mjs` would be a misfile.

---

## The deploy

```
$ supabase functions deploy statement-upload
Uploading asset (statement-upload): supabase/functions/statement-upload/index.ts
Uploading asset (statement-upload): supabase/functions/_shared/statement-core.ts
Uploading asset (statement-upload): supabase/functions/_shared/cors.ts
Deployed Functions on project cweiaibjigjwspmshcrj: statement-upload
```

**Exactly one function.** `supabase functions list` afterwards shows
`statement-upload` at version 11, `UPDATED_AT 2026-08-02 04:37:35`. Every one of
the other 78 functions still carries its previous timestamp — the newest is
`messaging-inbound-webhook` / `messaging-send-sms` at `2026-07-31 17:56:18`. No
bulk deploy was run and `supabase/config.toml` was not touched.

Sixty-odd functions import `_shared/cors.ts` and none of them were redeployed,
which is harmless: `statement-upload` is the only caller in the app that sends
a custom header, so no other function needs the new list.

### `verify_jwt` is still on

`statement-upload` is absent from `config.toml` — correct, it is browser-called
with a real session JWT and wants the platform default `verify_jwt = true`. The
five-hour outage in `docs/audit-2026-07-09-calling-and-topup.md` was a deploy
silently changing this, so it was checked before and after:

```
$ curl -X POST '…/functions/v1/statement-upload' \
    -H 'Content-Type: application/octet-stream' --data-binary 'x'
HTTP/1.1 401 Unauthorized
{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}
```

That is the **platform gate** answering, not the function's own check — which
is the signal that `verify_jwt` is still `true`. A garbage bearer token also
returns `401`. A test now pins the `config.toml` absence too.

---

## End-to-end: how far a real statement got

Driven server-side with a **real user access token** for the owner's own
account (minted via `admin/generate_link` → `/auth/v1/verify`), sending
`Origin: https://producerstackcrm.com` and the exact header set `boUpload()`
sends. Two synthetic statements of the same three lines — a **CSV** (the
tabular path: one Anthropic call derives a column mapping, applied in code) and
a **PDF** (the native path: the document goes to the model).

The three lines were chosen to exercise all three match outcomes against the
owner's real book, using only policies **already at `paid`** so that
`planStatementStatusChanges()` plans nothing (`PAYABLE_FROM` is
`{pending, approved, issued}`) and no real policy could be mutated.

| Question | CSV | PDF |
|---|---|---|
| `statement-upload` accepted the bytes? | ✅ `200`, `{"queued":1,"duplicates":0}` | ✅ `200`, `{"queued":1,"duplicates":0}` |
| `commission_statements` row created? | ✅ | ✅ |
| `statement_files` row (the bytes)? | ✅ 1 | ✅ 1 |
| `statement_extractions` row (model's verbatim answer)? | ✅ 1, `kind=column_mapping` | ✅ 1, `kind=pdf_rows` |
| `commission_rows` landed? | ✅ 3 of 3 | ✅ 3 of 3 |
| any matched a policy? | ✅ **2** | ✅ **2** |
| unmatched handled, not dropped? | ✅ 1 `needs_review`, *"no policy in the tracker matches this line"* | ✅ same |
| status write-back | 0 changes (as designed) | 0 changes |
| final statement status | `ingested` | `ingested` |

Match detail, identical on both paths:

| line | method | confidence | matched |
|---|---|---|---|
| `0113615870` / James Leuchtmann | `policy_number` | `1` | James Leuchtmann |
| *(no number)* / John Langley | `name` | `0.75` | John Langley |
| `ZZ99001122` / Fictitious Testcase | `none` | `0` | — → `needs_review` |

Money was exact on both: `140904 + 94095 + 75000 = 309999` cents, matching
`total_amount_cents` on the statement row. Cost: one Haiku call each —
`claude-haiku-4-5`, 1,765 in / 151 out for the CSV, 2,563 in / 255 out for the
PDF. That is the one-call-per-sheet property the design exists to get.

**So the answer is: the whole chain works.** Upload, storage, extraction,
normalisation, persistence, matching and the review queue all behave as
documented, from a request shaped exactly the way the browser shapes one.

### Cleanup — nothing was left behind

Before: `{statements: 0, files: 0, extractions: 0, rows: 0, policies: 26, history: 40}`
After deleting the two statements and their children:
`{statements: 0, files: 0, extractions: 0, rows: 0, policies: 26, history: 40}`

No stray commission row can show up as real money on the Back Office Summary.
The owner's book was also verified untouched independently: zero
`policy_status_history` rows with `source='statement'`, and the newest
`policies.updated_at` was `2026-08-02 02:57:56Z` — an hour and forty minutes
*before* the run.

---

## THE ONE DOWNSTREAM DEFECT FOUND — reported, NOT fixed

**The PDF path writes a null `transaction_date` when the line items carry no
per-line date.** One fix per round; this needs its own.

`docs/back-office-ingestion.md` records this as one of the two defects the
original live runs found and fixed: *"`transactionDate` now falls back to the
paid date, then the effective date."* **That fix only ever landed on the
tabular path.** `applyMapping()` in
[statement-core.ts:1130](../../supabase/functions/_shared/statement-core.ts#L1130)
has it:

```ts
const transactionDate = parseDateISO(at(cells, "transaction_date")) ?? paidDate ?? effectiveDate;
```

The PDF branch of
[statement-parse/index.ts:205-213](../../supabase/functions/statement-parse/index.ts#L205-L213)
has no fallback at all — it hard-codes the other two to null:

```ts
transactionDate: parseDateISO(r.transaction_date),
effectiveDate: null,
paidDate: null,
periodStart, periodEnd,
```

**Evidence from the run.** The model read the PDF correctly and said so — the
stored `statement_extractions.raw_output` shows `"transaction_date": ""` on all
three rows (the document genuinely prints no per-line date) alongside
`"period_start": "2026-07-01", "period_end": "2026-07-31"`. All three
`commission_rows` then landed with `transaction_date = null` while
`period_start` and `period_end` were populated correctly **on the same rows**.
The CSV of the identical statement got `2026-07-15` on all three.

**Why it matters, in the repo's own words:** *"Every row gets a
`transaction_date` … It is the column the trend chart, the persistency windows
and the debt drill-down all bucket on, so a null there makes a row silently
vanish from all three."* A carrier PDF that prints a statement period in its
header and no date per line — a common shape — therefore ingests, reports
`ingested`, shows a correct row count and total on the Statements screen, and
contributes **nothing** to the trend chart, the persistency windows or the debt
drill-down.

Not fixed here, and worth noting the fix is not a one-liner: the tabular chain
falls back to fields the PDF branch never populates, and whether the sensible
final fallback is `period_end`, `period_start` or the statement date is a
product decision about what date a line without one should be counted on.

Nothing else downstream failed.

---

## Verification summary

| Check | Result |
|---|---|
| `npm test` before | **green** — 35 suites, `fail 0` on every one |
| `npm test` after | **green** — 36 suites, `fail 0` on every one |
| `npm run check` | `✓ app.html: 0 new error(s), 0 new warning(s), 12 known (baselined)` |
| `scripts/check-app.baseline.json` | untouched, not regenerated |
| New test fails when the fix is reverted | ✅ verified by mutation |
| Live preflight before / after | refused / allowed — both pasted above |
| Unauthenticated POST after redeploy | `401 UNAUTHORIZED_NO_AUTH_HEADER` (platform gate still on) |
| Functions deployed | `statement-upload` only, confirmed against `functions list` |
| `supabase/config.toml` | untouched |
| Production residue | **zero** — all four tables back at their pre-run counts |

`git status --porcelain` at the end shows only: `supabase/functions/_shared/cors.ts`,
`test/cors-headers.test.mjs`, `package.json` (the `test:cors` script and its
place in the chain), `CLAUDE.md`, `docs/back-office-ingestion.md`,
`docs/back-office-progress.md` and this report.

---

## 👤 THE ONE HUMAN STEP — Jace

**Everything above proves the request can now leave the browser and that the
server handles it correctly. What no session can prove is that a real carrier's
PDF parses correctly**, because we do not have one to test with — the synthetic
PDF above proves the pipeline, not the model's reading of Americo's or
American-Amicable's actual layout.

### What to do

1. Go to **https://producerstackcrm.com** and sign in.
2. **Hard-refresh once** — `Ctrl+Shift+R`. (Only to be sure you are not on a
   cached page mid-session; `app.html` did not change, so this is belt and
   braces.)
3. Sidebar → **Back Office** → **Statements**.
4. Drag a **real carrier commission statement** onto the drop zone, or click it
   and pick one. A PDF is the interesting case; a CSV or XLSX from a carrier
   portal is also worth doing if you have one. Up to 10 MB.

### What success looks like

- The drop zone goes busy and the sub-line reads **"Uploading 1 of 1 — <your
  filename>"**.
- Within a second or two, a green line: **"1 statement queued."**
- The statement appears in the list and its pipeline strip moves
  **Queued → Parsing → Persisting → Matching → Ingested**. Parsing is one
  Anthropic call, so expect roughly **5–20 seconds** for a normal statement —
  longer for a long multi-page PDF. The screen polls on its own and stops
  polling when nothing is in flight.
- The finished row shows the **carrier**, the **statement period**, the **line
  count**, the **matched count with *(N to review)***, and the **net total**.
- Then check the money actually arrived: **Back Office → Commissions** should
  show figures instead of dashes, and **Back Office → Reconciliation** should
  list any line that matched no policy, each with a plain-English reason.

### What to report back

- Whether **"1 statement queued."** appeared at all. If you still get
  **"… could not be uploaded — Failed to fetch"**, stop there and say so — that
  would mean a *second* blocked header or a cached preflight, and it is a
  different problem from the one fixed here.
- Whether the row reached **Ingested** or stopped at **Failed** (if Failed, the
  row carries a plain-English reason — paste it).
- **Whether the line count and the net total match what the carrier's own
  statement says.** This is the real test. The parser is template-free, so this
  is the first time it has read that carrier's layout.
- How many lines matched a policy versus went to review, and whether the ones
  that went to review *should* have matched.
- **Anything a real PDF shows on the Commissions trend chart.** Specifically:
  if the total looks right on the Statements screen but the trend chart looks
  empty or short, that is the `transaction_date` defect above, confirmed on a
  real document — say so and it gets its own round.

You can delete the statement afterwards if you would rather not keep it; a
re-upload of the identical file is deduplicated by SHA-256 and reports
*"already ingested"* rather than double-counting.

---

## PENDING LIVE VERIFICATION

1. **A real carrier statement uploaded from the browser by Jace** — the human
   step above. Proven: the preflight allows it, and the server handles a
   correctly-shaped request end to end. Unproven: that a real carrier's PDF or
   spreadsheet layout parses correctly, because no such file exists in this
   repo to test against.
2. **The `Failed to fetch` message is actually gone on the live page.** Proven
   at the protocol level by the `after` preflight; not observed in a real
   browser by anyone yet.
3. **The other two allowed origins.** The header list is origin-independent, so
   `https://www.producerstackcrm.com` and the Capacitor `https://localhost`
   (native app) get the same answer — but neither was exercised with a real
   upload. The native shell has no Statements screen today, so this is
   theoretical.
4. **The PDF `transaction_date` defect on a real document.** Confirmed here on a
   synthetic PDF and confirmed by reading the code; not yet seen on a carrier
   PDF, because a carrier that prints a date on every line will not hit it.
5. **A statement large enough to hit the caps** — `MAX_ROWS_PER_STATEMENT`, the
   PDF `truncated` path, the 10 MB limit and the ZIP member limit are all
   unit-tested but have never run against a real large statement.
6. **The inbound email path is unaffected and remains proven** —
   `messaging-email-inbound-webhook` calls `statement-upload` server-to-server
   with the service role and sends no `Origin`, so it never sent a preflight and
   was never broken by this. No re-verification needed.
