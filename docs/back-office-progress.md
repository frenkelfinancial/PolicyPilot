# Back Office — build progress ledger

**This file is the single source of truth for the Back Office mission.** If a
session ends mid-mission, pasting the original mission prompt into a fresh
session plus reading this file and `docs/schema-state.md` must be enough to
resume cleanly.

Mission: commission statement ingestion and everything that feeds off it, in
seven independently-shippable phases. Started 2026-07-29.

---

## Status at a glance

| Phase | What | State |
|---|---|---|
| 1 | Ingestion engine (upload → parse → persist → match) | ✅ **shipped 2026-07-29** |
| 2 | Producer codes + retroactive attribution | not started |
| 3 | Book of Business upgrades | not started |
| 4 | Commissions dashboard | not started |
| 5 | Persistency upgrades | not started |
| 6 | Reconciliation screen | not started |
| 7 | Close the loop (auto-referral, chargeback at-risk, carriers) | not started |

**Exact resume point:** Phase 2 — Producer Codes + retroactive attribution.
Nothing from Phase 1 is outstanding. `commission_rows` already carries the
`producer_code`, `attributed_agent_id` and `attribution_method` columns Phase 2
needs, so Phase 2's schema is purely additive (a `producer_codes` table plus a
backfill RPC).

**Waiting on Jace:** one decision — see *"Forwarding email address"* below.
Nothing is blocked by it; Phase 1 shipped upload-only as planned.

---

## Deferred to later missions (deliberately NOT built here)

Recorded per the mission brief so they are not lost:

1. **Team Tree / leader-of-leader hierarchy** (checklist #99). Needs a real
   multi-level hierarchy engine; the current model is one leader ↔ many
   downline agents via `agency_invites`, with no grandparent link. Everything
   in §10.5 of `docs/ORION_GAP_ANALYSIS.md` that is gated on hierarchy is
   **noted as gated** in the phases below rather than built.
2. **Comp Ladder on top of the hierarchy** (checklist #101/#102). Needs both
   the hierarchy *and* real statement data, so it is downstream of this whole
   mission.
3. **Public back-office API** (§10.7, checklist #105).

---

## Standing constraints for this mission

Repeated here so a fresh session does not have to re-derive them:

- **Schema:** idempotent, additive, transaction-wrapped `.sql` under
  `supabase/migrations/`, applied with
  `supabase db query --linked -f <wrapped>`, audited before and after,
  `docs/schema-state.md` updated in the same commit. No `DROP` of tables /
  columns / data. Nothing in `auth.*` or `storage.*`.
- **Edge functions:** deployed **individually**, never a batch. Re-verify the
  `verify_jwt` fleet after every deploy (`supabase functions list -o json`
  diff — 16 functions are `verify_jwt = false` and that number must not move).
- **RLS:** never loosened. Commission data is the most sensitive data in the
  app. Cross-agent visibility only through deliberately-built `SECURITY
  DEFINER` aggregate RPCs that resolve the caller from `auth.uid()`.
- **A2P / campaign:** do not touch. Documented waiting state in
  `docs/a2p-campaign-draft.md`.
- **Before every push:** `npm test` (full suite, includes `npm run check`) and
  `npm run prebuild` so `www/` is in sync (`www/` is tracked and deployed — it
  goes stale silently).

---

## Phase 1 — Ingestion engine ✅ SHIPPED

Feature doc: **`docs/back-office-ingestion.md`** (architecture, the pipeline,
matching order, caps, security posture, hand-test script).
Schema apply record: `docs/schema-state.md` → *Apply 2026-07-29 —
`20260739_back_office_ingestion.sql`*.

### What shipped

- **Schema `20260739`**: `commission_statements` (the pipeline state machine),
  `statement_files` (raw bytes), `statement_extractions` (verbatim model
  output), `commission_rows` (normalized lines), plus
  `get_ingestion_summary()`. All four tables SELECT-only for `authenticated`.
- **`_shared/statement-core.ts`** — the pure, synchronous, dependency-free
  half: a raw-DEFLATE inflate, ZIP, XLSX, XLS (OLE2/BIFF8, both the mini-stream
  and FAT-chain layouts), CSV with delimiter sniffing, magic-byte format
  detection, header-row detection, money/date/transaction-type normalizers,
  mapping projection, dedupe keys, and policy matching.
- **`_shared/statement-ai.ts`** — the only Anthropic caller. One Haiku call per
  sheet for tabular files; native PDF document blocks for PDFs. Structured
  Outputs on both.
- **`statement-upload`** and **`statement-parse`** edge functions, deployed
  individually, both `verify_jwt = true`.
- **Back Office screen** in `app.html`: drag-and-drop + file picker, the live
  six-state pipeline strip, the "N ingested 7d · N pending review" line, the
  statements table with ZIP members nested under their archive, a per-statement
  line drill-down, and an "Original" download of the exact uploaded bytes.

### Decisions taken without asking

1. **Raw files are stored in Postgres (`statement_files.content bytea`), not
   Supabase Storage.** The mission's schema rules forbid touching `storage.*`,
   and creating a bucket writes `storage.buckets`. Keeping the bytes in a table
   we own also means one access-control system instead of two. The column lives
   in its own table keyed 1:1 to the statement, so no ordinary query pulls
   megabytes by accident. *Migration path if volume demands it:* move to
   Storage and keep `statement_files` as the pointer table — nothing outside
   the two edge functions reads `content`.

2. **Caps: 10 MB per file, 25 MB per upload batch, 25 members per ZIP, 50 MB
   uncompressed per ZIP, 20,000 rows per statement.** Not Orion's 500 MB. The
   bytes cross an edge function's request body and land in a Postgres column,
   and a real carrier statement is a few hundred KB. Enforced in the browser
   (so a 40 MB PDF is refused before a minute of uploading) *and* server-side
   (the browser is not a security boundary); a test asserts the two agree.

3. **Bytes are POSTed raw (`application/octet-stream`), not base64 JSON.**
   Base64 inflates by a third for no benefit; the filename rides in an
   `x-filename-b64` header because headers must be ASCII.

4. **Tabular files cost exactly one AI call per sheet.** The model derives a
   *column mapping* from the header row plus a few sample rows; the mapping is
   then applied to every row deterministically in code. Still template-free —
   nobody configures a carrier — but the per-row arithmetic lives in tested
   code rather than in a model. Measured on the live run: 3 calls, 5,869
   tokens, 10 commission lines.

5. **Model is `claude-haiku-4-5`,** matching the carrier-mail extraction path
   (`_shared/anthropic.ts`). Extraction is the cheap tier's job; the accuracy
   work is in the deterministic layer around it.

6. **Zero new dependencies.** A hand-rolled raw-DEFLATE inflate rather than
   `DecompressionStream('deflate-raw')` — the latter works on today's runtimes
   and would quietly stop working on an older one, and a synchronous inflate
   keeps the whole core testable. `.xlsx` is a ZIP, so one reader serves both.

7. **`.xls` (OLE2/BIFF8) is genuinely supported,** including both storage
   layouts — small workbooks live in the CFB mini stream, large ones in the FAT
   chain, and a reader handling only one fails on half the files it meets.
   Carriers still export `.xls`; "re-save it as something else" is a support
   burden, not an answer.

8. **Idempotency at two grains** — `UNIQUE (agent_id, sha256)` on the file and
   `UNIQUE (agent_id, dedupe_key)` on the row, where the row key carries an
   **occurrence ordinal** so a statement legitimately containing two identical
   lines keeps both while a re-parse still writes nothing new.

9. **Unmatched rows are stored, flagged and counted, never dropped** —
   `review_status='needs_review'` plus a plain-English `review_reason` that the
   drill-down renders. Phase 6 builds the triage screen; the data is already
   there.

10. **All four tables are SELECT-only for `authenticated`.** Every write goes
    through a service-role edge function that takes the agent from the JWT.
    Same shape as `consent_records`, `lead_transfers`, `reputation_config`.

11. **A ZIP archive gets its own statement row** (its bytes are evidence) with
    `status='ingested'` and `row_count=0`, and its members nest under it in the
    UI. A flat list would read as a duplicate upload.

12. **Naming one statement explicitly re-reads it whatever its state.** A
    *sweep* only picks up queued (and, with `retry`, failed) work, but "read
    this one again" is an operator action — and it is the only way to pick up a
    policy that was added to the tracker after the statement arrived. It is
    safe precisely because of the row-grain dedupe.

13. **`nav()` and `restoreSectionFromCache()` no longer highlight by
    position.** Both carried a hand-maintained positional index map that
    Back Office would have silently shifted. `_applyPlanGating()` had already
    fixed this same bug class once (its comment records what the drift broke);
    both are now resolved by section name, and a test stops the positional map
    returning.

### Verification

| Layer | Result |
|---|---|
| Schema behavioural checks (inside a rolled-back transaction) | **14/14** |
| Unit + `app.html` invariant tests (`npm run test:backoffice`) | **102** |
| Full suite (`npm test`) | **410 tests + `npm run check` clean** |
| End-to-end against production (real edge functions, real Haiku, throwaway accounts) | **36/36** |
| Headless click-through (real browser, real file input, rendered DOM) | **22/22** |
| Residue after both live runs | **zero** |

Both live runs are re-runnable:
`node <scratchpad>/e2e-backoffice.mjs` and `node <scratchpad>/ui-backoffice.mjs`
with `PP_ROOT` set. They create their own throwaway accounts and delete
everything they touched, including the auth users.

### Surprises worth recording

- **A float multiply lost a cent.** `parseAmountCents("0.145")` returned 14, not
  15 — `0.145 * 100` is `14.499999999999998` in binary floating point. It now
  works on the decimal string. On a table meant to reconcile against a
  carrier's own totals, that is not a rounding detail.
- **A carrier that prints only a "Paid Date" produced undated rows.** The AI
  mapped the column correctly to `paid_date`, which left `transaction_date`
  null — and that is the column the Phase 4 trend chart, the Phase 5
  persistency windows and the debt drill-down all bucket on. Every such row
  would have vanished from all three without ever looking wrong.
  `transactionDate` now falls back to the paid date, then the effective date.
- **Both were found by the live run, not by the unit tests**, which is the
  argument for running one. Both now have unit tests.
- **The headless harness cost three false starts**, all in the harness:
  `Runtime.evaluate` with `awaitPromise: true` errors on a non-promise; a
  Windows path check compared forward-slash `ROOT` against a backslash
  `join()` result and 404'd every request; and `window.currentAgent` is
  undefined because `currentAgent` is `let`-declared — the exact trap
  `docs/agency-team-screen.md` already records from the last end-to-end run.

### Forwarding email address — investigated, NOT built, needs one decision

**Question:** can a per-tenant forwarding inbox be built with the services
already in use, with no new signup and no DNS change?

**Answer: no — but it is much closer than expected, and the gap is exactly one
DNS record.**

What was found:

- **Resend is already a service in use.** `RESEND_API_KEY`,
  `RESEND_WEBHOOK_SECRET` and `RESEND_INBOUND_WEBHOOK_SECRET` are all live
  Supabase secrets; `messaging-email-inbound-webhook` is deployed, verifies the
  Resend signature, and already handles the `email.received` event (webhook id
  `06060a7c-efcb-4175-a046-f3eef8a36905`). **No new signup is required.**
- **The domain is already registered and outbound-verified in Resend** —
  `producerstackcrm.com`, registrar Porkbun. DKIM, SPF and the return-path MX
  are all green (`docs/PHASE2_S2_COWORK_CHECKLIST.md` §2.1).
- **Inbound MX is the only missing piece**, and it is marked
  🔴 *not started* in that same table. Nothing can receive mail until it exists.
- Nothing else in the stack can receive SMTP mail: Supabase has no inbound
  email, Telnyx is voice/messaging only, Vercel and GitHub Pages are hosting,
  and the Gmail integration is `gmail.readonly` against the **agent's own**
  mailbox — useful, but not a per-tenant address we control.

**So Phase 1 shipped upload-only, as the mission specified.** The exact plan,
for Jace:

| Item | Value |
|---|---|
| Service | **Resend** — already signed up, already paid for, already wired |
| New signups needed | **none** |
| DNS record needed | **one MX** |
| Host | **`commissions.producerstackcrm.com`** — see the warning below |
| Value | `inbound-smtp.us-east-1.amazonaws.com`, priority `9` |
| Where | Porkbun DNS for `producerstackcrm.com` |
| Cost | No new subscription. Confirm inbound parsing is included on the current Resend plan before relying on it — that is the one number this investigation could not verify from inside the repo. |
| Also worth adding while you are there | the `_dmarc` TXT record, still marked missing in §2.1 |

> ⚠️ **Put the MX on a subdomain, not on `@`.** The checklist drafts it on the
> apex, which would route **all** mail for `@producerstackcrm.com` into Resend.
> A `commissions.` subdomain gives every agent an address of the form
> `<token>@commissions.producerstackcrm.com` and leaves the apex untouched.

**Build estimate once the record exists:** small. The pipeline is already
per-statement and re-runnable, and `commission_statements.source` already
carries an `'email'` value. The work is a new `statement-email-webhook`
function that verifies the Resend signature, resolves the agent from the
address token, and calls the same storage path `statement-upload` already
uses — plus a per-agent token column and the address shown in the UI.
**Say the word and it goes in as Phase 1b.**

---

## Phases 2–7

Not started. Each will get its own decisions + work log section here as it
begins.

### Phase 2 notes carried forward

`commission_rows` already has `producer_code`, `attributed_agent_id` and
`attribution_method`, and `producer_code` is already populated from statements
that carry a writing number (the live CSV fixture exercised this). Phase 2 is
therefore additive: a `producer_codes` table, a Settings screen, and a
retroactive-attribution RPC that stamps `attributed_agent_id` on rows already
ingested under a code — with the retroactivity explicitly tested, since that is
the detail that makes the feature worth having.
