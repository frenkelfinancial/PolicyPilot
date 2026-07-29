# PolicyPilot / ProducerStack — notes for Claude Code

## Carrier bonus tracker
- **Source of truth for bonus programs:** `data/carrier_bonuses.json` — carrier-official agent bonus/incentive programs (45 carriers, researched 07/2026). CARRIER-ONLY by design: never add IMO/agency-level bonuses (e.g. FFL VP bonus) to this file.
- **Mirror rule:** the `CARRIER_BONUSES` const in `app.html` mirrors this JSON (same pattern as `COMP` ↔ `data/compensation-table.json`). Any change to one must be applied to both.
- **Never invent tier numbers.** Entries with `bonus_type: portal_only` or empty `tiers` get no numeric projections in the UI. All displayed payouts are estimates ("est." prefix) subject to carrier persistency/quality metrics.
- Payout shapes differ per carrier — don't generalize: Am-Am Bonus Bucks = highest band only, not cumulative; MoO 4 Quarters Club = cliff (10% of TOTAL quarter ANBP once ≥$25k); Corebridge = cumulative policy-count ladder, SimpliNow Legacy SIWL only (GIWL excluded), tiers change every quarter; Americo UFirst = fixed window (last one ended 2026-05-29).
- **Data decays on a schedule:** Corebridge tiers flip quarterly (~Oct 1 next), Americo announces new UFirst windows after each one ends, MoO/Aetna publish new flyers each cycle. When refreshing, update `as_of` and per-entry `status`/`source_date`, and regenerate `data/carrier_bonuses_*.xlsx` if present.
- Build spec: `docs/bonus-tracker-build-prompt.md` (payout math, period engine, carrier-ID mapping, fixture tests).

## Carrier email parsing feature
- **Source of truth for email classification:** `docs/carrier_sender_map.json` — maps every carrier sender address to email type, content type (body / pdf / login_link), and routing destination (policy_tracker / commission_summary / nudge / ignore). Built from real inbox samples; do not invent sender addresses or types not listed there.
- **Build plan:** `docs/email-parsing-build-plan.md` — architecture, phased tasks, schema, matching rules, risks. Follow the phase order.
- **DB seed:** `supabase/seed_carrier_senders.sql` — inserts for the `carrier_senders` table (requires a `priority int default 10` column; see file header for matching semantics).

Autonomy layer (added 07/2026):
- **Pipeline runs unattended twice daily** (9 AM + 5 PM Central) via `supabase/functions/email-pipeline` (orchestrator: gmail-sync → parse-email looped → match-events), scheduled by `supabase/schedule_email_pipeline.sql` (pg_cron, UTC — has a DST note). The in-app "Sync & parse" button remains the on-demand path.
- **Auto-apply:** `match-events` now writes back to the tracker. Auto-attach requires parse confidence ≥ 0.9 AND (exact policy number | TA masked last-5 | UNIQUE strong name+carrier match). Status mapping lives in `match-events/index.ts` `STATUS_MAP` — forward-only (pending→approved→issued), `lapsed` from declined/withdrawn/closed; NEVER sets `paid`/`chargeback` and never downgrades. No match → review_queue, no tracker change. Every applied event is appended to `policy_events` (audit table, `supabase/migrations/20260717_policy_events.sql`).
- **Policies now carry an optional `policyNumber`** (Add/Edit Policy modals, `p-policyNum`/`ep-policyNum`); match-events backfills it from unmasked email matches. This is the primary path to high match accuracy — name+carrier is the fallback.
- **Summaries must lead with the client's name** (1–3 sentences, amounts/dates/next steps) — enforced in the `SYSTEM` prompt in `_shared/anthropic.ts`. Don't shorten it back to one nameless sentence.

## Back Office — commission statement ingestion

- **Read `docs/back-office-ingestion.md` before touching anything named `bo*`, `statement*`, or `commission_*`.** Mission ledger and per-phase decisions: `docs/back-office-progress.md` — that file is the resume point if a Back Office session ends mid-mission.
- **A tabular statement costs ONE Anthropic call per sheet, whatever its row count.** The model derives a *column mapping* from the header row plus a few sample rows; `_shared/statement-core.ts` then applies that mapping to every row deterministically. Do not "improve" this by sending rows to the model — it is still template-free (nobody configures a carrier), and the per-row arithmetic belongs in tested code. PDFs are the exception: no column structure to derive, so the document goes to the model natively.
- **Nothing is discarded, three ways.** The file exactly as uploaded lives in `statement_files.content`; the model's verbatim answer lands in `statement_extractions` **before** our normalizer runs; and a line that matched no policy is stored with `review_status='needs_review'` plus a plain-English `review_reason`, never dropped.
- **Idempotency is at two grains.** `UNIQUE (agent_id, sha256)` on the file, and `UNIQUE (agent_id, dedupe_key)` on the row — where the row key carries an **occurrence ordinal**, so a statement legitimately containing two identical lines keeps both while a re-parse still writes nothing new. Removing the ordinal silently deletes real commission lines.
- **`commission_statements`, `statement_files`, `statement_extractions` and `commission_rows` are SELECT-only for `authenticated`.** Every write goes through `statement-upload` / `statement-parse` under the service role, and both take the agent **from the JWT** — there is no agent id in either request body. Do not add an INSERT policy: one broad enough to let the browser record a commission row is broad enough to let it record one against another agent's book.
- **Money is parsed from the decimal STRING, never `value * 100`.** `0.145 * 100` is `14.499999999999998` in binary floating point, and this table is meant to reconcile against a carrier's own totals.
- **Every row gets a `transaction_date`,** falling back to the paid date and then the effective date. It is the column the trend chart, the persistency windows and the debt drill-down all bucket on, so a null there makes a row silently vanish from all three.
- **Zero new dependencies, on purpose** — a hand-rolled raw-DEFLATE inflate, ZIP/XLSX, and an OLE2/BIFF8 `.xls` reader covering *both* the mini-stream and FAT-chain layouts. `DecompressionStream('deflate-raw')` works today and would quietly stop working on an older runtime.
- **The `// <backoffice-core>` block in `app.html` is extracted verbatim and executed by `test/back-office.test.mjs`.** Keep it pure — no DOM, network, storage or app globals — or the tests stop running against the code that ships.
- **`nav()` highlights by section name, not by position.** The positional index map (duplicated in `restoreSectionFromCache()`) had to be hand-corrected every time the sidebar grew; a test asserts it does not come back.
- **Inbound forwarding addresses are NOT built and need one DNS record.** Resend is already signed up, paid for and wired (`messaging-email-inbound-webhook` verifies its signature); only the inbound MX is missing. Exact plan in `docs/back-office-progress.md` § "Forwarding email address".

### Book of Business (Phase 3) — `docs/back-office-book-of-business.md`

- **A status set written out by hand in more than one place is this feature's
  bug class.** It shipped four instances before Phase 3 caught them. There is
  now ONE list — `BOB_STATUSES` in the `// <bob-core>` block — and
  `PT_STATUS_ORDER`, `PT_STATUS_LABELS`, the Add modal and the Edit modal are
  all **derived** from it. `BOB_NOT_A_SALE` and `BOB_ENDED` are the two derived
  subsets; use them, never a literal `['lapsed','chargeback']`.
- **The six original status KEYS are unchanged and must stay so.** They are
  stored verbatim in `policies.data.status` for every policy in production and
  are read by `get_team_summary`, `match-events`' `STATUS_MAP`, the Summary
  charts and the bonus tracker. Only the `approved` LABEL changed, to
  "Approved Not Paid". The four new keys (`denied`, `withdrawn`, `surrendered`,
  `claim`) needed no change to `public.policies` — but they ARE in
  `policy_status_history`'s check constraint, and a test asserts that list and
  `BOB_STATUSES` are the same ten.
- **`policy_status_history` is owner-APPENDABLE with NO update and NO delete
  policy.** That is different from the four Phase 1 commission tables and the
  reason is the write path: the policy tracker is a browser-side app with no
  edge function in it. What keeps it safe is that the trail cannot be
  rewritten, and that `policy_status_history_guard` **refuses any `source`
  other than `manual`/`system` from a client** — a row claiming `statement`
  asserts a carrier said something. Do not relax either half.
- **The timeline reads BOTH `policy_status_history` and the older
  `policy_events`.** `policy_events` belongs to the carrier-mail pipeline and
  was deliberately not migrated or widened.
- **A statement may set `paid` and `chargeback` and nothing else. A LAPSE is
  never inferred** — there is no lapse transaction type and a negative
  adjustment looks exactly like a fee. `statement-parse` writes the history row
  **before** the status update, because PostgREST cannot make them atomic and
  an unexplained change is worse than a recorded one that failed to apply.
- **Dates derived from a calendar date are stamped at NOON UTC, never
  midnight.** `changed_at` is a `timestamptz` rendered in the reader's local
  zone; midnight shows the previous day for every agent west of UTC. This hit
  all 23 production rows once already.
- **The agent filter is deliberately GATED, not built** — it needs the deferred
  team hierarchy, and building it would break the aggregates-only rule in
  `docs/agency-team-screen.md`.

### Producer codes (Phase 2) — `docs/back-office-producer-codes.md`

- **The retroactivity IS the feature.** `apply_producer_codes()` walks *every* one of the caller's commission rows, not just new ones, so saving a writing number attributes the statements uploaded last month. A version that only worked going forward would not be worth having — an agent's first act is to upload six months of history.
- **It is `SECURITY DEFINER` with NO parameter naming an agent** (anchored on `auth.uid()`), because `commission_rows` is SELECT-only for `authenticated` and must stay that way. Same shape and reasoning as `get_team_summary`.
- **It is a full reconcile, not a one-way stamp.** Deleting a mistyped code and re-running *clears* what it attributed; without that, a typo leaves the wrong agent on months of commission with no way back. It only ever clears rows whose `attribution_method = 'producer_code'`, so a manual correction survives.
- **`producer_codes` IS owner-writable** (it holds the agent's own identifiers, not money) — but `subject_agent_id` is guarded by a trigger to self-or-accepted-downline, and `code_key` is *derived* by a trigger, never accepted from the client. A client-supplied key could file `QA-777` under `SOMETHINGELSE` and make the reconcile match the wrong rows.
- **`pcNormalizeCode()` (browser) and `pc_normalize_code()` (SQL) must keep agreeing.** A test re-implements the SQL from the migration text and compares. If they drift, the bulk-load preview shows one thing and the database does another.
- **`carrier_key` is load-bearing, not decoration.** PostgREST's `on_conflict` can only name columns, and the uniqueness rule folds a NULL carrier to `''`. `producer_codes_key_uidx` is the index that must survive any tidy-up of the redundant expression index.
- **Settings panels are resolved structurally** (`#sec-settings > [id^="stg-"]`), never from a hand-written list. Naming them one by one meant a new tab had to be added in two places, and missing the second shipped a panel rendering *on top of* Account.

## Agency / team reporting
- **Read `docs/agency-team-screen.md` before touching anything named `team*`, `tm*`, `_ag*`, or `get_team_summary`.** The Agency tab and the Summary team mini-card are two VIEWS of one view-model.
- **Three invariants, all asserted by `test/team-roster.test.mjs` against `app.html` as source text:** exactly one `sb.rpc('get_team_summary')` call site (`loadTeamRoster`), exactly one period engine (`teamPeriodRange`), exactly one table renderer (`teamTableHTML`). Two independent team queries is what produced the 8,610× AP overstatement fixed in `20260736`.
- **`get_agency_stats` is deliberately no longer called from anywhere.** It still exists in the database (nothing was dropped); a test asserts zero call sites. Adding one back recreates the bug class.
- **The `// <team-core>` block in `app.html` is extracted verbatim and executed by the tests.** Keep it pure — no DOM, network, storage or app globals — or the tests stop running against the code that ships.
- **AT-RISK is in-app only, never emailed**, and needs BOTH halves: AP down ≥40% this calendar month vs last, AND no dial for ≥7 days. Guards: prior AP ≥ 1 (you cannot fall from zero) and ≥30 days' tenure. The leader's own row is never badged. The window is ALWAYS month-over-month regardless of the period selector, so the badge cannot blink as a leader clicks around.
- **`get_team_summary` takes no parameter naming a leader**, on purpose — the downline is scoped solely by `ai.leader_id = auth.uid()`, so there is nothing to point at someone else's team. All eight parameters are time bounds; NULL means unbounded, which is how "Lifetime" is expressed. Month bounds come from the browser, not `now()`, because the server only knows UTC and the badge would flip near a month boundary.
- **Leader views are aggregates only** — no client names, no policy detail, no commission figures. Now enforced by what the query selects, not by what the UI chooses to render.
- **The Agency nav item must stay ungated.** `_agRenderAgentView` is the only place an invitee can accept an invite or revoke access; a tier gate on `nav('agency')` made every emailed invite unacceptable once already.
- "Last activity" is built from `created_at`, never `updated_at` — `sbUpsertAllLeads()` re-upserts the whole book on every save, so `updated_at` tracks app usage, not work.

## Texting / A2P 10DLC UI
- **Read `docs/texting-ui.md` before touching anything named `a2p*` or `sms*` in `app.html`.** Three surfaces: the registration modal (`#a2pRegModal`), the status wizard (Settings → Texting, `#stg-texting`), and the per-lead SMS thread (`#smsThreadModal`, opened by the **Text** button on a lead row).
- **A lead row's texting state comes from a stored `consent_records` row, never from `phone_numbers.sms_capable`.** `sms_capable` says the AGENT's number may carry A2P traffic; it says nothing about the recipient. `leadTextingState(lead)` answers the per-contact question, and only `ready` renders a green Text button. The state loads in one pair of queries for the whole book (`smsLoadLeadConsent`), awaited before the first render — a flash of green that corrects itself reads as "you can text them".
- **`const A2P_ALLOW_PRODUCTION = false`** in `app.html` is the money switch. Off = every registration attaches to the shared mock sandbox brand (free, and can never be carrier-approved; the sole-prop OTP step is skipped entirely). On = $4 + $14.50 of real, non-refundable carrier fees **per agent**, then $1.50/month. Flip it only as a deliberate spend decision.
- **Never surface a raw API error in the composer.** Every reason `runComplianceGate()` returns already carries a plain-English `detail`; the UI's job is to add the link that clears it. The gate order in `smsEvaluateGate()` mirrors the server's on purpose — the composer must never look ready for a send the server would refuse.
- **Quiet hours are deliberately NOT computed in the browser.** The timezone inference lives in `_shared/tcpa.ts`; let the server refuse (it costs nothing) and render its sentence.
- **`consent_records` is service-role-write-only.** Three things write it: `messaging-recipients-import` (CSV), `messaging-consent-record` (agent attestation), and — since the campaign rejection — the **`compliance-page` POST** on `/a/<slug>/sms-opt-in`, which is the primary path. `lead-ingest` does not write it. Do not "fix" any of this by adding an INSERT policy: the opt-in page is public and every bound on it (published-slug lookup, honeypot, per-IP cap, never clearing a `dnc_list` row) lives inside the function, so a PostgREST INSERT policy would route around all four.
- **🔴 NO LEAD COMPANY IS NAMED ON ANY CARRIER-FACING SURFACE. Do not add one back.** Applied 2026-07-28. `agents.lead_vendors` now holds lead **source categories** (`lead_partners` | `own_forms` | `referrals`, `LEAD_SOURCE_CATEGORIES` in `_shared/lead-vendors.ts`); the privacy policy describes sources by type; `buildOptinDescription()` names no source at all and **no longer takes a vendor argument** so it cannot. `resolveLeadSourceLabels()` is a strict whitelist, so legacy `goatleads`/`builtleads`/`other:<name>` values render the generic sentence instead of a stale name. Two unit tests enforce the ban across every rendered page and the campaign description. Reason: the names in this repo were the wrong company anyway, and naming *any* lead company in an SMS-consent document is what produced review item 1.
- **The vendor's consent does not cover texting, and saying it does is what got review item 1.** Carrier review refused the vendor's "…and its licensed agents" wording as opt-in evidence for a campaign sending as the agency. The privacy policy now says the lead form covers **phone and email**, and the campaign opt-in description says text consent is collected **only** on `/a/<slug>/sms-opt-in`. Those two must keep agreeing — a unit test asserts it.
- **The campaign is LIVE and already paid for: `CD2166Q` / `4b30019f-a9df-e17b-3529-70677db27ec4`, `ACTIVE`, billed 2026-07-28.** It is not a draft. Three carrier review items came back; **one fixed, two open** — the opt-in auto-response never mentions marketing while the campaign declares `MARKETING`, and `buildOptInAutoResponse()` still emits the exact string that was objected to. Do not submit anything before reading `docs/a2p-campaign-draft.md`; a second campaign is another $14.50 and the existing one may be updatable in place for $0.
- **`consent_type` and `consent_method` are different columns on purpose.** `consent_type` is the TCPA legal basis the send gate reads (`express_written` | `express` | `none`); `consent_method` is how it was captured (`web_form` | `agent_attested` | `csv_import` | `inbound_keyword`). A web-form opt-in is `express_written` + `web_form`. Putting `web_form` in `consent_type` would make `isConsentTypeAcceptable()` reject the strongest consent we hold.
- **The opt-in disclosure is ONE string** — `buildOptInDisclosure()` in `_shared/sms-optin.ts` — rendered on the page, stored in `consent_records.disclosure_text`, and quoted verbatim in the campaign's `messageFlow`. Editing it changes what a submitted campaign describes, and resubmission is $15. The campaign description has a hard 2,048-char ceiling (`TCR_MESSAGE_FLOW_MAX`); if it needs shortening, cut the fixed prose, never the quote.
- **The opt-in auto-response must keep naming marketing/promotional messages** for as long as the campaign declares the `MARKETING` use case — that agreement *is* carrier review item 3. `buildOptInAutoResponse()` carries all seven elements Telnyx's keywords article requires, and is capped at `TCR_KEYWORD_MESSAGE_MAX` (320) because it grows with the agency name; a 60-character name lands at 308. Three unit tests hold this, including one pinning the rejected string so it cannot return.
- **`a2p-status-poll` has two callers**: pg_cron with `WALLET_CRON_SECRET` (full sweep) and the browser with a user JWT (refresh scoped to that agent, resolved from the token, never the body). It must stay `verify_jwt = false`.
- **An opt-out must NEVER be conditional on resolving the agent.** `dnc_list` is the single enforcement point — `runComplianceGate()` reads it for every send; nothing reads `inbound_messages.is_opt_out`. `messaging-inbound-webhook` resolves the agent in four passes (exact `e164` → last-10 `e164` → the prior outbound message on the same pair → legacy caller ID) and, if all four miss, writes a **global** `dnc_list` row and still sends the confirmation. Restoring an `&& agentId` guard there silently drops consumer STOPs — it did exactly that until 2026-07-28.
- **The Telnyx fleet is larger than `phone_numbers`.** As of 2026-07-28: 8 DIDs live, 6 rows. `+12029703699` (shared caller ID) and `+12625099123` (dialer host) are in neither `phone_numbers` nor `agents.signalwire_caller_id`. Assume inbound can arrive on a number the DB does not know.

## Carrier email parsing feature — key gotchas

Key gotchas encoded in the map (read its `key_findings`):
- Transamerica masks policy numbers (`xxxxx76911`) — match on last 5 digits.
- `noreply@aatx.com` sends two different email types — split on subject regex, match addresses case-insensitively.
- Ethos mixes marketing and transactional on one sender — subject allowlist, ignore by default.
- Mutual of Omaha underwriting mail comes from personal underwriter addresses — match domain + subject pattern.
- Never fetch links from login-link emails (Corebridge secure messages, Americo portal notifications) — they become dashboard nudges only.
