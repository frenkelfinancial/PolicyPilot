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

### Close the loop (Phase 7) — `docs/back-office-close-the-loop.md`

- **🔴 AN AUTO-REFERRAL LEAD CARRIES NO CONSENT, DELIBERATELY.**
  `referralsFromPolicy()` must never add `tcpa_consent`, a `consent_records`
  row, or any opt-in field, so `leadTextingState()` renders it `needs_optin`
  and `runComplianceGate()` refuses. A beneficiary named on an application has
  not asked to hear from anyone. Three tests enforce it — a unit test, the
  browser, and the row that synced to the server. This protects a LIVE 10DLC
  campaign that already has carrier review items on record.
- **A referral needs both a name and a phone**, and is deduped three ways:
  against the book by phone, against the insured themselves, and within the
  batch (beneficiary and emergency contact are often the same person).
- **The at-risk chargeback signal is `productionDown && (quiet || cbSpike)`** —
  production-down is still required, both original guards (prior AP ≥ 1,
  tenure ≥ 30 days) still hold, and it is still in-app only. A spike needs BOTH
  a $500 floor and a 30% ratio. **No commission data is never a spike.**
- **`teamChargebackSpike`/`teamChargebackPhrase` live in team-core**, not
  referral-core: `test/team-roster.test.mjs` extracts team-core and runs it
  standalone, so `teamAtRisk` must not reach into another block.
- **Carriers is DERIVED from `commission_rows`, never a table**, and
  `carrier_bonuses.json` / `TRACKER_CARRIER_LIST` are deliberately not joined
  in. Its debt definition is byte-identical to the Debt tab's.

### Reconciliation (Phase 6) — `docs/back-office-reconciliation.md`

- **`public.review_queue` was deliberately NOT used, NOT extended and NOT
  replaced.** It is keyed `NOT NULL` to `parsed_events` with a UNIQUE on it and
  holds ~30 live rows that `match-events` writes on a cron. `commission_rows`
  already IS the queue (`review_status`, `review_reason`, `match_method`,
  `match_confidence`). Do not merge them.
- **Every resolution goes through the `statement-review` edge function.** The
  agent comes from the JWT; there is no agent id in the body. `match`
  re-verifies the target policy belongs to the caller — the picker is a
  convenience, not a boundary. Never add an INSERT/UPDATE policy to
  `commission_rows`.
- **REJECT NEVER DELETES.** No `.delete(` may appear in `statement-review`; a
  test asserts it. Rejecting records a decision.
- **A row with no `match_confidence` sorts LAST on the match-% sort** — it
  never matched, it is not a zero-confidence match. `0` and `null` differ.
- **Unlinked Policies is IN-FORCE policies only**, 45 days past draft. A lapsed
  policy that was never paid is a lapse, not a reconciliation problem.
- **There is exactly ONE `statement-parse` call site and one
  `statement-upload` call site in `app.html`** — a test enforces it, and it
  caught the Phase 6 retry button adding a second. Call `boParseNow()`.

### Persistency (Phase 5) — `docs/back-office-persistency.md`

- **The cohort date is `issueDate → draft → dateSubmitted`, and that chain is a
  bug fix.** `issueDate` is optional and only 8 of 23 production policies carry
  one; the old widget keyed on it alone and reported a rate over a third of the
  book. Never narrow it back.
- **A policy that never issued is not in the cohort** (`pending`, `approved`,
  `denied`, `withdrawn`), and **a death claim is NOT a lapse** — `claim` is in
  `PERSIST_KEPT`. `20260743` carries the same two lists and a test asserts the
  browser and the SQL agree.
- **An empty cohort has NO rate, not 0%.** `persistBand(null)` is `null`.
  Painting red on an agent who has not been writing long enough is the most
  misleading thing this screen can do; segments with no rate sort LAST.
- **A thin segment (<3 policies) is shown and flagged, never made the
  outlier**, and the outlier only fires at a material gap (10 points).
- **`persistency13mo()`/`persistency25mo()` delegate to persist-core** and
  still return a 0–1 fraction, because the Summary rings multiply by 100.
- **Each core sentinel must appear EXACTLY ONCE in `app.html`** — the test
  harness extracts by lazy match, so a comment mentioning `// <x-core>` above
  the real block swallows the file. A test enforces this for all six cores.

### Commissions dashboard (Phase 4) — `docs/back-office-commissions.md`

- **`get_commission_buckets()` returns BUCKETS, not answers**, and every
  headline figure is derived from them in the pure `// <comm-core>` block. Do
  not "simplify" this into six SQL expressions: it would put the definition of
  net commission somewhere no test runs, and fetching the rows instead of
  grouping them hits PostgREST's 1,000-row ceiling and returns a **wrong total
  rather than an error**.
- **Everything attributes on `coalesce(attributed_agent_id, agent_id)`.** An
  unattributed line falls back to the uploader and is counted, never dropped.
- **`get_downline_commission_rollup` is the ONLY cross-agent read of commission
  data.** SECURITY DEFINER, no parameter naming a leader, aggregates only, and
  bounded by `cr.agent_id in (team)` — that predicate is what stops a
  stranger's row entering a leader's rollup, and it is not the same thing as
  the attribution fallback beside it. Never add an INSERT/UPDATE policy to
  `commission_rows`, and never widen this function's `RETURNS TABLE` to carry a
  client name, insured name, policy number or carrier.
- **A row whose attribution points outside the team falls back to the uploader
  — it must never be excluded.** Excluding it made a leader's totals silently
  shrink whenever an agent left the agency. Money vanishing from a total with
  nothing on screen to say so is the worst failure this schema can produce.
- **Debt is `chargeback` + `adjustment` only, and is NEVER range-filtered.** An
  advance is not debt. A positive adjustment is a repayment. An unmatched debt
  line still counts.
- **Back Office areas are resolved structurally** (`[id^="bopanel-"]`). Adding
  a Phase 5/6/7 panel is one edit, not two.
- **Bonuses is a link to the existing tracker, not a panel here.**

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

## Agency leaderboards, records & achievements

- **Read `docs/agency-leaderboards.md` before touching anything named `lb*` in `app.html` or `supabase/migrations/20260750_agency_leaderboards.sql`.** Five areas on the Agency tab: Team (unchanged), Leaderboards, Records, Achievements, Hall of Fame.
- **`lb_agent_metrics()` carries the sale predicate, the sale-date chain and the AP regex guard BYTE-IDENTICAL to `get_team_summary`'s `pol` CTE.** `test/leaderboards.test.mjs` extracts both from the migration text and compares them character for character. The boards and the team table sit one click apart; two definitions of "AP this month" on one screen is the 8,610× bug with a shorter fuse.
- **The leaderboard owns NO period engine.** `lbLoadBoards()` reads `teamPeriodRange()`, `lbRpcArgs()` mints no dates, and the period value is the same `pp_team_period` the team table stores. A test asserts the `// <leaderboard-core>` block contains no week-start or quarter arithmetic.
- **The top-10 cutoff is enforced by the SERVER.** `get_agency_leaderboards` returns `rank <= 10 OR agent_id = auth.uid()` — a below-top-10 viewer's private row is the only tail row ever sent, so a peer cannot read the rest out of the network tab. `lbSplitRows()` must keep trusting `in_top` and never re-derive the cutoff; a test asserts it never mentions `LB_TOP_N`.
- **Ties share a rank, so `leaderboard_snapshots` is keyed on `agent_id`, NOT on `rank`.** Keying on rank made the freeze lossy — two agents at rank 6 offered the same key twice and `ON CONFLICT DO NOTHING` swallowed the second. Caught by the behavioural pass before the table held a row.
- **🔴 `lb_visible_members()` is the single enforcement point for the opt-out** (`agents.hide_from_leaderboards`) and sits below EVERY peer-visible read — boards, agency records and the milestone feed. A hidden agent is on no board including their own view, cannot hold or lift an agency record, and writes no milestone; their personal records and achievements keep updating privately.
- **No browser-callable function takes a parameter naming an agent or a leader**; the agency comes from `lb_leader_for(auth.uid())`. Every `lb_*(uuid…)` helper is REVOKEd from `anon`/`authenticated`. **No table in the migration has an INSERT/UPDATE/DELETE policy** — three SELECT policies and nothing else. Do not add one.
- **The backfill is feed-silent on BOTH sides:** `lb_evaluate_all(true)` writes no milestone, and `lbNewlyEarned(list, null)` returns `[]` so a browser that has never looked fires no toasts for history. A personal best only announces when it BEAT something.
- **Early Bird and Closer are deliberately not built** — there is no sale-time timestamp in this schema, only entry time, and a badge on that rewards late-night data entry. Weekend Warrior survives because it reads the sale DATE. **Most Appointments Set and Best Placement Rate were cut too** (one qualifying `calls.outcome='appointment'` row in all of production; nobody has ever recorded a `denied`/`withdrawn` policy). All three decided by Jace 2026-07-30.
- **Talk time is `duration_sec`, the same expression the team table's Call time column uses** — `answered_at` exists and the two definitions differ by 13 seconds across 1,298 rows, which is not worth two numbers on one screen.
- **Both cron jobs call SQL directly**, not an edge function: no secret, no `verify_jwt` flag. `lb_rollover()` reasons in `America/Chicago`, so there is no CDT/CST job pair.

## AI Sales Agent (voice dialer)

- **Read `docs/ai-assistant-script-v1.md` before touching anything named
  `ai-call-*`, `aiTest*`, or the Telnyx assistant config.** That doc is the
  SOURCE OF TRUTH for the assistant's instructions, not a copy of them:
  `npm run sync:ai-assistant` extracts the fenced blocks and PATCHes the live
  assistant, then reads back to confirm (Telnyx silently ignores fields it does
  not recognise, so a 200 proves nothing). Never edit the prompt in Mission
  Control by hand — this prompt carries a TCPA disclosure and "which version
  was live on the 14th" is a question that can actually get asked.
- **AMD DOES NOT GATE THE GREETING** (changed 2026-07-30). It used to, and that
  was 3.5s of the measured 6.5s of dead air — premium AMD cannot be made fast,
  listening *is* how it works. `call.answered` now attaches the assistant
  inline; the AMD verdict is an async backstop that hangs up on a machine.
  Accepted tradeoff: the assistant may speak a sentence into a voicemail.
- **🔴 On the AMD-machine path, tag `outcome='voicemail'` BEFORE calling
  hangup.** `answered_at` is stamped on answer now, so `computeBilledMinutes`
  returns a real minute and the ONLY thing zeroing it is the finalize block
  reading `outcome === 'voicemail'`. Hanging up first races our own
  `call.hangup` event against that write, and losing it bills an agent for a
  voicemail — the one thing this feature promises never to do.
- **`buildGreeting()` in `ai-call-webhook` is the one place the opening line is
  built**, and that string IS the disclosure. Four openers, because every fact
  (lead first name, AI name, agent, agency, lead type) can be blank in
  production and "Hi , this is  —" is how a robot sounds.
- **A blank `agents.ai_agent_name` stays blank.** Nothing invents a default — a
  name the agent did not choose is a name they have to explain to a lead.
- **Disclosure wording is "an assistant", not "an automated AI assistant"**
  (owner decision, 2026-07-30, history table in the doc). What did NOT move:
  the instructions still require answering *immediately and plainly* that it is
  an **automated assistant** whenever anyone asks whether it's a real person.
  Transcript QA must match the CURRENT line — finding `automated AI assistant`
  now means a stale assistant version, i.e. someone edited Mission Control by
  hand.
- **`NOTHING SENDS message_history`** — Telnyx's validator 422s it on this
  account (code 10000, pointer `/message_history`) and that rejection is what
  made every early call dead air. `startAssistant()` degrades down a ladder
  (voice dropped, then greeting dropped) so a future field rejection costs the
  call its voice, never its audio. Rung 3 speaks the greeting stored ON the
  assistant, so that string must carry the disclosure too — it is synced from
  the doc's ```greeting block.
- **Every value in `AI_VOICES` was verified against the live API** by PATCHing
  `voice_settings.voice` (a wrong id is 400 / code 10015). A saved voice that
  drops off the list is MIGRATED to `AI_VOICE_DEFAULT`, not silently shown as
  "Assistant default" — the webhook would keep sending the retired id and eat a
  rejection on the greeting's critical path.
- `supabase/config.toml` pins `[functions.ai-call-webhook] verify_jwt = false`
  and it is load-bearing (Telnyx signs Ed25519, not a Supabase JWT). After any
  deploy, an unauthenticated POST must come back `{"error":"invalid_signature"}`
  — that is the function's own check answering, i.e. proof the platform gate is
  still off. A `{"code":401,"message":"Missing authorization header"}` means it
  came back on.

## Identity — a person has a name, not an address

- **`pp_display_name()` (SQL, `20260751`) and `ppAgentName()` (browser, in `// <team-core>`) are the ONE identity resolver.** `lb_agent_name`, `get_team_summary` and `get_agency_members` all delegate to the SQL one; every renderer goes through the browser one. Read `docs/agency-leaderboards.md` § "Who an agent is called".
- **🔴 NO PEER-VISIBLE SURFACE MAY RENDER AN EMAIL ADDRESS.** Before `20260751` every name expression ended `..., au.email)` and `agents.display_name` was NULL for all 8 production agents, so the fallback WAS the answer — the leader of the only live agency showed as `jacef8778099@gmail.com` on the team table, all seven boards, both record scopes, and stored on four `agency_records.holder_name` rows. A test sweeps `app.html` as source text for `agent_name || agent_email` and its variants.
- **`ppAgentName()` refuses any string containing `@`** and derives from the local part instead. That is the belt-and-braces half: a stale cache or an unmigrated RPC cannot publish an address just because it reached the browser. `ppInitials()` builds avatars from the resolved name for the same reason.
- **The identity-provider name (`raw_user_meta_data->>'full_name'`) outranks the business profile**, deliberately and against the brief's literal wording. A board row names a PERSON; "Frenkel Financial LLC" ranked against ten people reads as a bug, and "renders as Jace Frenkel" was the acceptance test.
- **An email is still shown on a PENDING or DECLINED invite card**, where no account exists and it is the row's only identifier. A CONNECTED agent is named. Search-by-email in the transfer picker is untouched — the rule is about what is rendered, not what is matched.
- **The Settings display-name field writes `agents.display_name`**, not just localStorage. It used to write localStorage only, so an agent could type their name, watch it stick, and stay an address to their whole agency.
- **`persist-core` and `producer-codes-core` now load `team-core` in their test harnesses**, because both label agents through `ppAgentName()`. Same arrangement as `leaderboards.test.mjs` pulling in `tmDur()`.

## Period controls — Lifetime, month picker, custom ranges

- **One key grammar, one parser, both engines.** `'month:2026-04'` and `'custom:2026-04-01:2026-04-17'` are parsed by `ppParsePeriodKey()` / `ppDynamicRange()` in `// <team-core>`, called by BOTH `summaryPeriodRange()` and `teamPeriodRange()`. No schema change was needed — every window rides bounds the RPCs already accept.
- **`end` is exclusive, the picker is inclusive.** Every consumer in this app is half-open; a person saying "the 1st to the 17th" means the 17th counts.
- **Most Improved compares against the preceding range of EQUAL LENGTH** (a picked month compares to the month before). That is why the board stays available on a custom range instead of being hidden, and why `20260750` needed no change: `ppDynamicRange` emits the `prevStart`/`prevEnd` `lb_board_rows` already reads. The screen states which comparison it made.
- **The AT-RISK window never moves** — always this calendar month vs last, for every key including a picked one. A leader browsing last April must not see agents flagged for April's numbers. A test asserts the at-risk pair is identical across all six key shapes.
- **Both `ledgerPeriod` and `_teamPeriod` initialise from localStorage and must accept a stored dynamic key** (and reject one that no longer resolves). Teaching only the setters is what made a picked window silently revert to the default on the next page load — caught by the headless run, not by a unit test.
- **Null bounds mean unbounded.** `_lgInRange`, `_lgWhenInRange` and the Summary calls query all had to learn this; they used to dereference `range.start` unconditionally, so Lifetime would have thrown on arrival.

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
