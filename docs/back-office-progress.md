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
| 4 | Commissions dashboard | not started |
| 5 | Persistency upgrades | not started |
| 6 | Reconciliation screen | not started |
| 7 | Close the loop (auto-referral, chargeback at-risk, carriers) | not started |

**Exact resume point:** Phase 4 — Commissions dashboard. Nothing from Phases
1–3 is outstanding. Phase 4 needs the first deliberate **cross-agent aggregate
RPC** in this schema (`SECURITY DEFINER`, anchored on `auth.uid()`, same shape
as `get_team_summary`) so a leader can see rolled-up downline debt without
`commission_rows` ever becoming readable across tenants — that is the piece
Phase 1's ledger entry explicitly deferred to Phase 4. Everything else it needs
(`commission_rows.transaction_date`, `attributed_agent_id`, the transaction
types) is already in place.

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

## Phases 4–7

Not started. Each will get its own decisions + work log section here as it
begins.

### Phase 4 notes carried forward

The debt rollup needs the **first deliberate cross-agent aggregate RPC** over
`commission_rows` — `SECURITY DEFINER`, no parameter naming an agent, anchored
on `auth.uid()` and scoped by `agency_invites.leader_id = auth.uid()`, exactly
the shape of `get_team_summary`. Phase 1's ledger entry (`docs/schema-state.md`
§ "Why `get_ingestion_summary()` is SECURITY INVOKER") deferred it here on
purpose. `commission_rows` must stay SELECT-only and per-tenant; the rollup
returns figures, never rows.

Everything else Phase 4 reads already exists: `transaction_date` (with its
paid-date/effective-date fallback), `transaction_type`, `amount_cents`,
`attributed_agent_id` and `attribution_method`. Checklist #100 closes here.
