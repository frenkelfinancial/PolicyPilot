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
| 2 | Producer codes + retroactive attribution | ✅ **shipped 2026-07-29** |
| 3 | Book of Business upgrades | ✅ **shipped 2026-07-29** |
| 4 | Commissions dashboard | ✅ **shipped 2026-07-29** |
| 5 | Persistency upgrades | ✅ **shipped 2026-07-29** |
| 6 | Reconciliation screen | ✅ **shipped 2026-07-29** |
| 7 | Close the loop (auto-referral, chargeback at-risk, carriers) | ✅ **shipped 2026-07-29** |

**Exact resume point:** none — **all seven phases are shipped.** The mission as
briefed is complete. What remains is the work the brief explicitly deferred
(see below) plus the one decision waiting on Jace.

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

## Phase 2 — Producer codes + retroactive attribution ✅ SHIPPED

Feature doc: **`docs/back-office-producer-codes.md`**.
Schema apply record: `docs/schema-state.md` → *Apply 2026-07-29 —
`20260740_producer_codes.sql`*.

### What shipped

- **Schema `20260740`**: `public.producer_codes` (owner-writable, with a
  subject guard trigger and a derived `code_key`), `pc_normalize_code()`,
  `apply_producer_codes()` (the reconcile), `get_producer_code_coverage()`.
- **Settings → Producer Codes**: add/remove an NPN or a per-carrier writing
  number; a coverage table of every code seen on ingested statements, with
  one-click **Record as mine** for the ones not yet recorded; and an
  agency-owner **bulk load** (sheet → preview → Apply).
- No edge function changed; the fleet is untouched at 72 / 16.

### Decisions taken without asking

1. **The reconcile is a full reconcile, not a one-way stamp.** Deleting a
   mistyped code and re-running *clears* what it attributed. A stamp-only
   version leaves the wrong agent's name on months of commission with no way
   back. It never clears an attribution made any other way, so Phase 6's manual
   corrections will survive it.

2. **No parameter naming an agent.** `apply_producer_codes()` is anchored
   solely on `auth.uid()` — the same shape, and the same reasoning, as
   `get_team_summary`. It must be `SECURITY DEFINER` because `commission_rows`
   is SELECT-only for `authenticated` and must stay that way.

3. **`producer_codes` IS owner-writable**, unlike the four Phase 1 tables. It
   holds the agent's own identifiers, not money — the same posture as
   `policies` and `leads`. The privileged column (`subject_agent_id`) gets its
   own trigger rather than relying on the write path being polite, and
   `code_key` is derived by a trigger so a client cannot file a code under a
   key of its choosing.

4. **A carrier-specific code beats a carrier-agnostic one.** An NPN recorded
   once covers everything; a writing number for one carrier overrides it there.

5. **Bulk load is parsed in the BROWSER with SheetJS, not by the AI.** The
   sheet is one the agency owner wrote; its columns are agent identifiers
   rather than carrier prose, and a preview the owner confirms is a better
   guarantee than a model's confidence score. It is also instant and free.

6. **Nothing is written until Apply.** `pcBulkPick()` plans, `pcBulkApply()`
   writes, and a test asserts the planner contains no write. The preview names
   every code it would create *and* every row it is skipping, with the reason.

7. **`carrier_key` (a generated column) was added mid-build** because
   PostgREST's `on_conflict` can only name real columns and the uniqueness rule
   folds a NULL carrier to `''`. Without it the bulk upsert fails the moment
   one code in the sheet is already recorded — the normal case for a re-upload.
   The original expression index is left in place rather than dropped.

8. **Settings panels are now resolved structurally**
   (`#sec-settings > [id^="stg-"]`) in both `settingsTab()` and
   `initSettingsSection()`, instead of two hand-written lists that both had to
   be edited for every new tab.

### Verification

| Layer | Result |
|---|---|
| Schema behavioural checks (rolled back) | **16/16** |
| Unit + structure tests (`npm run test:producercodes`) | **33** |
| Full suite (`npm test`) | **443 tests + `npm run check` clean** |
| End-to-end against production | **22/22** (leader + downline + unconnected stranger) |
| Headless click-through | **23/23** |
| Residue after both live runs | **zero** |

### Surprises worth recording

- **The bulk upsert could not name its conflict target.** An expression index
  is not a valid `on_conflict` target for PostgREST, so Apply silently failed
  whenever the sheet contained a code already recorded. Found by the
  click-through, fixed with the generated column.
- **Adding a Settings tab was a two-place edit, and missing the second place
  shipped a broken screen** — the Producer Codes panel rendered on top of
  Account instead of replacing it, because `initSettingsSection()` hid four
  panels by name and knew nothing about the fifth. Both call sites are now
  structural, with a test asserting neither enumerates panels and that every
  tab has a panel and every panel a tab.
- Neither was caught by unit tests. Both were caught by driving a real browser.

---

## Phase 3 — Book of Business ✅ SHIPPED

Feature doc: **`docs/back-office-book-of-business.md`**.
Schema apply record: `docs/schema-state.md` → *Apply 2026-07-29 —
`20260741_book_of_business.sql`*.

### What shipped

- **Schema `20260741`**: `public.policy_status_history` (append-only, with a
  provenance guard trigger), a genesis backfill of all 23 production policies,
  and `get_team_summary` replaced with one predicate change.
- **Four new statuses** — `denied`, `withdrawn`, `surrendered`, `claim` — plus
  `approved` relabelled **Approved Not Paid**. No change to `public.policies`:
  the status is a string in a jsonb column.
- **Status tabs with counts** replacing the Status dropdown; **per-policy
  status-history timeline** merging `policy_status_history` and the older
  `policy_events`; **product filter**; **carrier filter now data-driven**;
  **agent filter gated** with the hierarchy explanation.
- **`statement-parse` writes back policy status** for the two things a
  statement is authoritative about (paid, chargeback), always through the
  trail. Deployed individually, v3, `verify_jwt` unchanged; fleet still 72 / 16.

### Decisions taken without asking

1. **The six original status KEYS are unchanged.** They are stored verbatim in
   `policies.data.status` for every policy in production and are read by
   `get_team_summary`, `match-events`' `STATUS_MAP`, the Summary charts and the
   bonus tracker. Renaming one is a data migration; nothing here needed one.
   Only the `approved` LABEL changed.

2. **Issued and Paid share ONE tab.** The brief names ten tabs and this app has
   ten statuses, but `issued` and `paid` are separate here (`issued` is the
   carrier's decision, `paid` is the draft-date advance) while "Issued Paid" is
   one thing to an agent. The compound tab rides the `'+'`-joined filter the
   Summary drill-in already used. The per-row dropdown still offers both
   separately, so nothing is lost.

3. **The tabs REPLACED the Status dropdown rather than joining it.** Two
   controls for one filter is how a filter and its count start disagreeing.
   `summaryDrillTo()` now writes `ptFilter.status` directly, because there is
   no longer a `#ptf-status` element for it to set.

4. **Tab counts span the whole book, never the filtered view**, and selecting a
   tab preserves the carrier / product / date filters.

5. **A new table rather than widening `policy_events`.** `policy_events` is the
   carrier-mail pipeline's, keyed to `parsed_events`, service-role-write-only
   and with no concept of a manual edit. Widening it risked changing what
   `match-events` writes. The timeline reads **both** rather than migrating one
   into the other, so no existing history is lost or rewritten.

6. **`policy_status_history` IS owner-appendable**, unlike the four Phase 1
   commission tables — because the policy write path is the browser, and a
   table the browser could not write would record nothing for the source that
   produces most entries. There is **no UPDATE and no DELETE policy**: the
   trail is append-only. A trigger stops a client claiming `statement` or
   `carrier_email` provenance, which is the claim Phase 6 has to be able to
   trust.

7. **The browser's history write is best effort and never blocks the status
   change.** The tracker works offline; a policy that would not change status
   because an audit row failed to write is a worse product than a visible gap.
   The two authoritative writers run server-side, where there is no trade-off.

8. **A statement may set `paid` and `chargeback` and nothing else — a LAPSE is
   never inferred.** There is no "lapse" transaction type, and a negative
   adjustment looks exactly like an ordinary fee. Guessing would mark live
   business dead on a bookkeeping line.

9. **The history row is written BEFORE the status update.** PostgREST cannot
   make them atomic; an unexplained status change is worse than a recorded one
   that failed to apply, because the second is visible and re-runnable.

10. **`get_team_summary` was replaced to exclude `denied` and `withdrawn`.**
    Both mean the policy never issued, so counting either as team production
    would overstate a downline's AP the moment an agent used them.
    `surrendered` and `claim` are deliberately still counted — the predicate is
    about whether a sale ever happened, not whether it is still in force. The
    file is byte-identical to 20260738's apart from that one list, and the
    team test now resolves the predicate from whichever migration most recently
    defines the function rather than naming a file that goes stale.

11. **Final Expense and Annuity are recognised only from text that says so.**
    Deriving Final Expense from COMP keys (`mutual_fe`, `aflac_final_ex`, …)
    would re-label as FE a policy the agent recorded as Whole Life, moving
    counts they recognise. The filter is data-driven, so when Add Policy gains
    those categories it picks them up with no further change.

12. **The agent filter is GATED, not built** — per the mission's own
    instruction to note §10.5's hierarchy gates rather than build them.
    Filtering by agent means showing a leader another agent's client names and
    premiums, which needs both the deferred hierarchy and a decision to break
    the aggregates-only rule `docs/agency-team-screen.md` records. Shown only
    to a leader, with the reason and a pointer to the Agency tab.

13. **The carrier filter is now data-driven too** (the brief asked only that it
    be, and it was not). 24 options for an agent appointed with three is 21
    that can only return nothing.

### Verification

| Layer | Result |
|---|---|
| Schema behavioural checks (inside a rolled-back transaction) | **22/22** |
| Unit + `app.html` invariant tests (`npm run test:bob`) | **42** |
| Added to `statement-core` | **12** |
| Full suite (`npm test`) | **498 tests + `npm run check` clean** |
| End-to-end against production (real edge functions, real Haiku, throwaway accounts) | **31/31** |
| Headless click-through (real browser, rendered DOM) | **40/40** |
| Residue after both live runs | **zero** |

Both live runs are re-runnable: `node <scratchpad>/e2e-bob.mjs` and
`node <scratchpad>/ui-bob.mjs` with `PP_ROOT` set.

### Surprises worth recording

- **Every backfilled genesis entry was dated one day early for any agent west
  of UTC.** `dateSubmitted` is a calendar date; casting it lands on midnight
  UTC, and the browser renders a `timestamptz` in the reader's local zone. All
  23 production entries were affected. Fixed to noon, plus a tightly-scoped
  corrective `UPDATE` so the fix reaches a database that had already applied
  the file. **Only the headless browser could have found this** — the bug is in
  how an instant renders, not in any value.
- **The draft-date auto-advance would have marked DENIED policies paid.**
  `autoSetPaidOnDraftDate()` flipped anything not in
  `['paid','lapsed','chargeback']` with a past draft date to `paid`. A denied
  policy normally *has* a past draft date, so it would have been silently
  marked paid on the next render — on the screen the agent reads to find out
  what they earned.
- **The Summary status bar would have stopped summing to 100%**, since a policy
  in any new status counted toward the total but appeared in no segment.
- Those two are one bug class — **a status set written out by hand in more than
  one place** — which is why `BOB_NOT_A_SALE` / `BOB_ENDED` exist and why
  `PT_STATUS_ORDER` is now derived. Looking for more instances found a fourth:
  **the Add and Edit modals already shipped different status lists** (five
  options vs six), so a policy could hold a status one modal could not display.
  Both are now generated.

---

## Phase 4 — Commissions dashboard ✅ SHIPPED

Feature doc: **`docs/back-office-commissions.md`**.
Schema apply record: `docs/schema-state.md` → *Apply 2026-07-29 —
`20260742_commissions_dashboard.sql`*.

### What shipped

- **Schema `20260742`** — three functions, nothing else. No table, no column,
  no data change, no RLS change.
  `get_commission_buckets` and `get_commission_debt` are SECURITY INVOKER (they
  read through the caller's own RLS); `get_downline_commission_rollup` is the
  first deliberate cross-agent read in this schema and closes checklist #100.
- **Back Office grew an area strip** — `Ingest · Commissions` — with panels
  resolved structurally, ready for Phases 5–7.
- **Six headline cards**, each with its definition rendered underneath; range
  chips MTD / YTD / All time; sub-tabs Trends · Payouts · Debt, with Bonuses
  linking out to the existing tracker.
- **Weekly trend chart** (commission above the line, debt below, personal and
  override as lines) and a **personal-vs-override mix**, both hand-built SVG.
- **Debt per carrier, drillable to the underlying lines**, plus the agency
  rollup for a leader.

### Decisions taken without asking

1. **The RPC returns BUCKETS, not answers.** Six SQL expressions returning six
   numbers would put the definition of "net commission" somewhere no test runs
   and make each card a round trip. SQL groups by week and transaction type;
   every figure is derived in the pure `// <comm-core>` block the tests
   execute. Grouping is also what keeps the result bounded — fetching the rows
   would hit PostgREST's 1,000-row ceiling and return a **wrong total rather
   than an error**.

2. **Everything attributes on `coalesce(attributed_agent_id, agent_id)`.** An
   unattributed line falls back to the uploader rather than being dropped, and
   the dashboard says how many there are with a link to Producer Codes. The
   coalesce is also what makes the rollup double-count-proof.

3. **Total, Gross and Net are three genuinely different questions**, and they
   coincide on a book with no bonus and no adjustment. Rather than invent a
   difference or ship two cards showing the same number, the definitions say
   exactly what separates them, and a test asserts all six differ and that
   Total and Net *can* diverge.

4. **Debt is chargeback + adjustment only.** An advance is not debt; treating
   unearned advance as a carrier balance would invent a number the carrier
   never reported. A positive adjustment reduces the balance, which is how a
   repayment appears.

5. **Debt is never range-filtered.** You owe a carrier what you owe them; a
   balance that shrank because someone clicked "MTD" is a number nobody could
   act on. The range chips govern the commission figures only, and the panel
   says so.

6. **An unmatched debt line still counts.** It is real money owed. It shows in
   the total, is findable in the drill-down, and the row count says how many
   are unmatched.

7. **Bonuses is a LINK, not a fourth panel.** `data/carrier_bonuses.json` is 45
   carriers deep and already has a screen; a second copy here would be a second
   thing to keep correct.

8. **Back Office panels are resolved structurally** (`[id^="bopanel-"]`),
   applying the Phase 2 lesson before it could cost anything a second time.

9. **Switching sub-tab never re-queries.** The data does not depend on the tab,
   so a tab click costs nothing.

10. **Empty weeks are filled in on a bounded range.** A chart that skips quiet
    weeks compresses a bad month to the same width as a good one and reads as
    steady production.

11. **A downline agent still cannot see rows their leader uploaded and
    attributed to them.** That is a real gap; it is recorded in the feature doc
    and *pinned by a behavioural check* rather than closed here, because
    closing it means a second reader on the most sensitive table in the app.

### Verification

| Layer | Result |
|---|---|
| Schema behavioural checks (rolled back) | **28/28** |
| Unit tests (`npm run test:commissions`) | **47** |
| Full suite (`npm test`) | **545 tests + `npm run check` clean** |
| End-to-end against production | **29/29** (leader + downline + stranger, real statement) |
| Headless click-through | **35/35** |
| Residue after both live runs | **zero** |

### Surprises worth recording

- **The rollup made money disappear.** It originally required the *effective
  agent* to be on the team as well as the uploader, so a line whose attribution
  pointed outside the team was excluded entirely. In production that fires the
  moment an agent leaves an agency: their invite flips to `declined` and every
  line the leader's statements had attributed to them silently drops out of the
  leader's totals. Now the attribution applies only when it lands inside the
  team and otherwise falls back to the uploader. **The security bound was never
  the thing being relaxed** — `cr.agent_id in (team)` was always doing that
  work.
- **It was caught by an assertion that looked like paranoia**: checking a
  *stranger's own* figures, not just the leader's. The leader's numbers were
  right the whole time.

---

## Phase 5 — Persistency ✅ SHIPPED

Feature doc: **`docs/back-office-persistency.md`**.
Schema apply record: `docs/schema-state.md` → *Apply 2026-07-29 —
`20260743_persistency.sql`*.

### What shipped

- **Schema `20260743`** — one function, `get_downline_persistency()`. No table,
  no column, no data change.
- **A third Back Office area, Persistency**: four windows (4 / 9 / 13 / 25
  month) with band colours and bars, a **Flat vs Weighted** toggle, a **Policy
  vs Agent** toggle, breakouts **by carrier** and **by lead source**, and an
  outlier banner with a plain-language reason.
- **`persistency13mo()` / `persistency25mo()` now delegate to the shared
  core**, so the Summary rings and the FFL bonus card read the same definition
  the new screen does.

### Decisions taken without asking

1. **The cohort date is a fallback chain — and that is a bug fix, not a
   preference.** `issueDate` is optional and only 8 of 23 production policies
   carry one, while all 23 carry a draft date. The existing widget keyed on
   `issueDate` alone and was therefore reporting a rate over a third of the
   book. Now `issueDate → draft → dateSubmitted`, in the browser and in SQL.

2. **A policy that never issued is not in the cohort.** It was never at risk of
   lapsing; counting a declined application as a lapse punishes an agent for
   underwriting.

3. **A death claim is not a lapse.** The policy stayed in force until the
   insured died. On a final-expense book this is common enough to matter.

4. **An empty cohort has NO rate, not a zero rate.** 0/0 is not 0%, and
   painting a red band on an agent who has not been writing long enough is the
   most misleading thing this screen could do. Segments with no rate sort last,
   never to the top as “the worst”.

5. **A thin segment is flagged, not hidden, and never accused.** One policy is
   not a rate. It stays in the table; the outlier picker ignores it.

6. **The outlier only fires at a material gap** (10 points). A screen that
   always accuses somebody trains an agent to ignore it.

7. **The policy view needs no RPC** — it is the agent’s own book, already
   loaded. Only the agent view goes to the server, because `policies` RLS is
   owner-only and “which of my agents writes business that sticks” is exactly
   what a leader cannot compute in the browser.

8. **Unlinked policies are counted and named**, never put in a fake bucket, and
   the panel says how to link them.

### Verification

| Layer | Result |
|---|---|
| Schema behavioural checks (rolled back) | **16/16** |
| Unit tests (`npm run test:persistency`) | **44** |
| Full suite (`npm test`) | **589 tests + `npm run check` clean** |
| Headless click-through | **31/31** |
| Residue | **zero** |

### Surprises worth recording

- **The test harness had a trap laid three times over.** Each core block is
  extracted from `app.html` by a lazy match from its opening sentinel, so a
  comment merely *mentioning* `<persist-core>` above the real block made the
  match start at the comment and swallow ten thousand lines. Two more copies
  sat below their blocks — harmless that day, the same trap the next. All four
  are cleaned and a test now asserts **every core sentinel appears exactly once
  in `app.html`**.
- **The click-through’s “worst first” assertion was wrong, not the code.** A 0%
  carrier with one policy legitimately outranks a 25% carrier with four; being
  a thin cohort excludes it from the outlier, not from the table.

---

## Phase 6 — Reconciliation ✅ SHIPPED

Feature doc: **`docs/back-office-reconciliation.md`**.
Schema apply record: `docs/schema-state.md` → *Apply 2026-07-29 —
`20260744_reconciliation.sql`*.

### What shipped

- **Schema `20260744`** — three columns on `commission_rows` (`reviewed_at`,
  `reviewed_by`, `review_note`), two partial indexes, and
  `get_reconciliation_summary()`. No table, no policy, no data change.
- **`statement-review` edge function** — the only write path. Deployed
  individually, v1, `verify_jwt = true`; fleet 72 → 73, the 16
  `verify_jwt = false` unchanged.
- **A fourth Back Office area, Reconciliation**: three priority-ranked queues,
  a status filter, a match-% sort, single and bulk approve / reject, a policy
  picker for manual matching, and a Try again for stuck uploads.

### Decisions taken without asking

1. **`review_queue` is neither built on nor replaced — it is left alone and
   not used.** It is keyed `NOT NULL` to `parsed_events` with a UNIQUE on it,
   its `reason` vocabulary is the carrier-mail pipeline's, and **it holds 30
   live rows that `match-events` writes on a cron**. Filing a commission row
   there means a fake parent or a dropped constraint. `commission_rows` already
   IS the queue — `review_status`, `review_reason`, `match_method`,
   `match_confidence` all shipped in Phase 1.

2. **What was actually missing was provenance**, so that is all the migration
   adds. Without `reviewed_by`/`reviewed_at`, an approved row is
   indistinguishable from one the parser matched itself.

3. **Priority follows the money, not the age.** A chargeback is never low
   priority however small; a failed upload is always high, because nothing was
   ingested at all and no total anywhere says so.

4. **A row with no match confidence sorts LAST on the match-% sort.** It never
   matched; it is not a zero-confidence match. `0` and `null` are both
   preserved and mean different things.

5. **REJECT NEVER DELETES.** The row, its amount and its statement all stay.
   The bulk bar says so on screen. A reconciliation screen that could delete a
   commission line is where "nothing is discarded" would break.

6. **Approving a line that was never matched is refused with a reason**, rather
   than quietly claiming a link that does not exist.

7. **`match` re-checks the target policy server-side.** The picker lists only
   the agent's own policies, but a picker is a convenience, not a security
   boundary.

8. **A row belonging to someone else is skipped, not reported.** "That row
   exists but is not yours" is itself a disclosure.

9. **Unlinked Policies is scoped to IN-FORCE policies 45 days past their draft
   date.** A lapsed policy that was never paid is not a reconciliation problem.

10. **No cross-agent reconciliation view.** Resolving a match means seeing a
    client name, which is the line `docs/agency-team-screen.md` draws.

### Verification

| Layer | Result |
|---|---|
| Unit tests (`npm run test:recon`) | **39** |
| Full suite (`npm test`) | **628 tests + `npm run check` clean** |
| End-to-end against production | **29/29** |
| Headless click-through | **31/31** |
| Residue after both live runs | **zero** |

### Surprises worth recording

- **An existing invariant caught this phase's own code.**
  `test/back-office.test.mjs` asserts exactly one `statement-parse` call site;
  the stuck-upload **Try again** button had added a second. Fixed by calling
  `boParseNow()` — which already owns the session header, the retry flag and
  the failure reporting — rather than re-implementing it. The test was right.
- **The click-through could not reach the edge function at first**, because the
  CORS allowlist does not cover a random `127.0.0.1` port. Web security was
  relaxed inside the throwaway Chrome profile only, exactly as the
  `transfer-leads` run did; no production secret was touched, and the
  end-to-end run exercises the same calls with real CORS.

---

## Phase 7 — Close the loop ✅ SHIPPED

Feature doc: **`docs/back-office-close-the-loop.md`**.
Schema apply record: `docs/schema-state.md` → *Apply 2026-07-29 —
`20260745_carriers.sql`*.

### What shipped

- **Auto-referral generation.** Six optional fields on Add Policy and Submit as
  Sold (beneficiary + emergency contact, each name/phone/relationship). On
  save they become leads tagged `referral — auto`, deduped three ways, and
  **carrying no consent of any kind**.
- **A chargeback signal on the at-risk flag.** `teamAtRisk` now reads
  `productionDown && (quiet || cbSpike)`.
- **A read-only Carriers screen**, the fifth Back Office area, derived from
  ingested rows. Closes checklist #103.
- **Schema `20260745`** — one SECURITY INVOKER function. No table, no column,
  no data, no policy. No edge function deployed; fleet untouched at 73 / 16.

### Decisions taken without asking

1. **A referral lead is created WITHOUT consent, deliberately — and the
   capture had to be built too.** Nothing was recording beneficiaries at sale,
   so "captured at sale" meant building the capture. The lead carries no
   `tcpa_consent` and no consent record, so `leadTextingState()` renders it
   `needs_optin` and the send gate refuses. A beneficiary named on an
   application has not asked to hear from anyone, and this repo already carries
   three carrier review items from that class of mistake. Verified in three
   places: the unit test, the browser, and the row that synced to the server.

2. **A contact needs both a name and a phone.** A lead an agent cannot call is
   not a lead.

3. **Three dedupes, each a real case** — against the book by phone, against
   the insured themselves (a policy naming the client as their own emergency
   contact), and within the batch (beneficiary and emergency contact are
   frequently the same person).

4. **Referral fields are stored on the POLICY as well as becoming leads**,
   because the policy is where an agent looks a year later for who was named.

5. **A chargeback SPIKE, not a chargeback.** Both a $500 floor and a 30% ratio
   are required. One clawback is ordinary in this business.

6. **Production-down is still required.** A good month with chargebacks is not
   the flight-risk pattern. What changed is that an agent whose production
   halved *and* whose book is coming back is flagged even while still dialling
   — arguably worse off than a quiet one, and silence would never have said so.

7. **No commission data is never a spike.** An agent who has not uploaded a
   statement must not be flagged for not having uploaded one; a test asserts
   the pre-Phase-7 behaviour is unchanged when the figures are absent.

8. **The reason names the half that fired.** Telling a leader "no dials" about
   an agent who dialled this morning is worse than no badge.

9. **The chargeback helpers live in team-core, not referral-core**, because the
   at-risk rule is theirs — and because `test/team-roster.test.mjs` extracts
   team-core and runs it standalone, so a `teamAtRisk` reaching into another
   block would stop parsing there.

10. **The chargeback figures come from `get_downline_commission_rollup`**
    rather than by widening `get_team_summary` a second time, and the call is
    best effort: a failure leaves the rule exactly as it was.

11. **Carriers is derived, not a table**, and `carrier_bonuses.json` /
    `TRACKER_CARRIER_LIST` are deliberately not joined in — they answer
    different questions, and folding them in would list carriers the agent has
    never written with.

12. **Carriers debt uses the Debt tab's definition byte for byte.** Two screens
    disagreeing about what an agent owes a carrier is worse than either being
    absent.

### Verification

| Layer | Result |
|---|---|
| Unit tests (`npm run test:referrals`) | **33** |
| Full suite (`npm test`) | **661 tests + `npm run check` clean** |
| Headless click-through | **26/26** |
| Residue | **zero** |

### Surprises worth recording

- **The chargeback helper had to move.** Written first into `referral-core`, it
  was called from `teamAtRisk` — which `test/team-roster.test.mjs` extracts and
  runs on its own, where the function would not exist. Moved into team-core,
  where the rule it serves already lives.
- **Two click-through assertions were wrong rather than the code**, both times
  a selector that forgot the Total row or assumed an ordering by name.

### Phase 6 notes carried forward

Everything Phase 6 reads already exists. `commission_rows.review_status` is
already `'auto' | 'needs_review' | 'approved' | 'rejected'` with a check
constraint, and `review_reason` already carries the plain-English sentence the
Phase 1 drill-down renders. `commission_statements.status = 'failed'` plus
`error` and `attempts` is the "stuck uploads" queue.

Two decisions the brief asks for explicitly:

1. **`public.review_queue` — build on it or replace it.** It belongs to the
   carrier-mail pipeline (`20260708_review_queue.sql`) and is keyed to
   `parsed_events`, not to commission rows. Make the call and write it down.
2. **The write path.** `commission_rows` is SELECT-only for `authenticated` and
   must stay so — approve / correct / reject needs a service-role edge
   function that takes the agent from the JWT, in the same shape as
   `statement-upload` / `statement-parse`. Do not add an INSERT/UPDATE policy.
