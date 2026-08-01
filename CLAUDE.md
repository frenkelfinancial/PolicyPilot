# PolicyPilot / ProducerStack — notes for Claude Code

## Front Office / Back Office

- **Read `docs/office-split.md` before touching the sidebar, `nav()`,
  `setOffice()` or anything named `OFFICE_*`.** The sidebar is two office
  blocks — Front Office (selling) and Back Office (money) — behind a toggle
  under the logo. Tests: `npm run test:office`
  (`test/office-split.test.mjs`).
- **`OFFICE_OF` is the ONLY place office membership is declared.** `nav()`,
  `setOffice()`, `_applyPlanGating()`, `restoreSectionFromCache()` and
  `bootDashboard()`'s post-auth restore all read it; nothing hard-codes an
  office anywhere else. Adding a screen means adding a line there **in the same
  commit** — a nav item with no office is invisible in BOTH offices, and a test
  fails on purpose. A second test cross-checks the map against the markup.
- **🔴 OFFICE HIDING IS A CSS RULE. PLAN GATING IS AN INLINE STYLE. NEVER MIX
  THEM.** `_applyPlanGating()` hides Bonus Tracker and Web Dialer with
  `el.style.display`; office visibility is `body[data-office=…] …{display:none}`
  in the stylesheet. They compose correctly only because they sit at different
  levels — inline `none` beats the office rule (hidden whichever office you are
  in) and inline `''` yields to it. Writing `style.display` for office
  visibility, or converting plan gating to a class, is the bug.
- **🔴 NAV HIGHLIGHTING USES `querySelectorAll`, NOT `querySelector`.** The
  existing rule was "`nav()` highlights by section name, not by position"; this
  extends it to *by name, and by ALL matches*. Agency is rendered TWICE
  (`#nav-agency-front`, `#nav-agency-back`) against one `#sec-agency`, so a
  singular query highlights the Front Office copy when the agent clicked the
  Back Office one. Three call sites, one test each.
- **🔴 NO HAND-WRITTEN DUPLICATE OF THE NAV LIST MAY EXIST ANYWHERE.** That is
  the general rule the two above are instances of, and three copies have now
  been killed for drifting: the positional `idxMap` in `nav()`, the map
  `restoreSectionFromCache()` used to carry, and — Round 3 — `const valid = {…}`
  in `bootDashboard()`, which decided what a refresh may restore into. Every one
  of them fell behind the sidebar, and the copy nobody remembers is always the
  one that breaks. The membership test is now derived:
  `_isRestorableSection(id)` = *declares an office* AND *something in the
  sidebar navigates to it*. It answers "does this screen exist", **NOT** "may
  this agent see it" — the plan gate (`_gated`) and the office guard sit on top
  and are still required, because the derived predicate is deliberately more
  permissive than the list it replaced. Both readers use it (the cached-section
  restore and the `?tab=` param). A fourth copy is a bug, not a convenience.
- **🔴 A REFRESH MUST *DRAW* THE SCREEN, NOT JUST SHOW IT.**
  `restoreSectionFromCache()` runs pre-auth and only swaps CSS classes;
  `bootDashboard()`'s block calls `nav()`, and **`nav()` is the only caller of
  every screen's renderer**. The four sections missing from `valid` therefore
  came back with their static chrome and an empty body — right tab, right
  title, no data — which reads as broken, not as "you were moved". Anything that
  restores a section without going through `nav()` recreates this.
- **🔴 VOICE CAMPAIGNS AND AI DIALER TEST RESTORE FROM `aiTestInit()`, NEVER
  FROM THE BOOT BLOCK.** Their nav items do not exist at restore time (async
  injection, after), so the derived predicate correctly says no — and
  `#sec-voice-campaigns`/`#sec-ai-test` are in the markup regardless of the kill
  switches, so naming either one in the boot restore would show an AI screen to
  an agent entitled to neither. Boot only records `_pendingLateRestore`; `nav()`
  clears it on ANY call (above every early return); the injection block reads
  and spends it below `if (!(agentOn && globalOn)) return;`. **The gate is the
  injection, not a list.** Accepted cost: a beat of Front Office Summary before
  it jumps. Do not "fix" that by moving the injection earlier.
- **The `backoffice` id is NOT the `Statements` label.** The tab reads
  "Statements"; the id stays `backoffice` because `sec-backoffice`,
  `renderBackOffice()`, `boArea()`, the `bopanel-*` prefixes,
  `test/back-office.test.mjs` and every `docs/back-office-*.md` key off it.
- **The office lives in `sessionStorage`, on purpose.** A fresh login or a new
  tab opens in the Front Office (owner's decision); an F5 mid-reconciliation
  leaves an agency owner where they were. Both restore paths refuse to restore
  a section belonging to the other office — you need BOTH, or a producer who
  ended yesterday on Policy Tracker logs in straight into the Back Office.
- **Voice Campaigns and AI Dialer Test inject into `#nav-group-outreach`**, each
  tagged `dataset.office = 'front'`, behind the unchanged `agentOn && globalOn`
  double kill switch. `ds-playground` stays beside Settings with no
  `data-office` — a dev tool, not a product screen.

### The Back Office Summary (Rounds 2 + 4) — `docs/back-office-summary.md`

- **Read `docs/back-office-summary.md` before touching anything named `bos*`,
  `bo-summary` or `renderBackOfficeSummary()`.** `OFFICE_HOME.back` is now
  `'bo-summary'`. Tests: `npm run test:bosummary`
  (`test/bo-summary.test.mjs`).
- **🔴 `BOS_ISSUED_STATUSES` IS A THIRD, DELIBERATE AP QUESTION — NEVER
  "RECONCILE" IT WITH THE SALE PREDICATE.** Round 4 rebuilt the top of this
  screen on the POLICY BOOK, because Round 2 read only carrier statements and
  therefore rendered an owner with a full book a "Nothing here yet" welcome mat.
  `['issued','paid']` in `// <bos-chart-core>` answers *what did the carrier
  issue*; `lb_agent_metrics()` / `get_team_summary`'s `pol` CTE answer *what was
  sold* and count a pending application. On a sample July book the two differ by
  **$11,100 on $10,200** — and both are right. The constant is NAMED for its
  question, the card renders `BOS_ISSUED_DEF` underneath it always-on, and the
  Top Producers card one strip below says in words that it will not match.
  Editing `lb_agent_metrics` to agree breaks the byte-identical comparison
  `test/leaderboards.test.mjs` runs against `get_team_summary` — the 8,610× bug
  with a shorter fuse.
- **🔴 `ppProductionDate()` IS THE ONE PRODUCTION-DATE RESOLVER — SUBMITTED
  FIRST, AND A FOURTH COPY IS A TEST FAILURE.** `dateSubmitted → draft → the
  id's timestamp`, in `// <team-core>`, locked by the owner 2026-08-01. Three
  hand-written copies were consolidated into it — `_lgSubDate` (Ledger
  Summary), `_ptSubForRange` (Policy Tracker period drill-in, byte-identical
  under another name) and an inline slice in `_lbCurrentTotals` — and the first
  two are now one-line aliases. Round 5 moved the Back Office Summary onto it
  from `p.draft`: the same policy submitted in June and drafting in July was
  June production in the Front Office and July production in the Back Office,
  one sidebar toggle apart. On an eight-policy fixture book six policies
  changed bucket here, the Front Office moved on none of its six windows, and
  screen-to-screen disagreements went 6 → 0. **This is a *when* question, never
  a *what counts* question** — `BOS_ISSUED_STATUSES`, `BOB_NOT_A_SALE` and
  `lb_agent_metrics()` were untouched and the issued-vs-sold gap stays
  explained, not reconciled. `_ptGetSub()` is deliberately NOT the resolver (it
  fills the tracker's *Submitted* column and has no draft fallback), and
  `_dailySeries()` has **no callers** — do not cite it as evidence of what
  anything buckets on. Tests: `npm run test:productiondate`
  (`test/production-date.test.mjs`), which classifies every `dateSubmitted`
  line in `app.html` and fails on one it does not recognise.
- **🔴 A PAST PERIOD CAN SHRINK, AND THAT IS INTENDED.** A lapsed or
  charged-back policy LEAVES the issued-AP figure, so March's bar is lower in
  June if a March policy lapsed in May. Owner's decision, 2026-08-01. Do not add
  a snapshot, a freeze or an as-of date. A test pins it.
- **🔴 `lbLoadBoards()` TOOK AN OPTIONAL RANGE, AND THAT IS NOT A PERIOD
  ENGINE.** `rangeOverride || teamPeriodRange(periodKey, new Date())` — omit it
  and the Agency tab behaves byte for byte as before (verified for every period
  key). The leaderboard still mints no dates; the CALLER supplies the window,
  which is what the Agency tab already does implicitly with `_teamPeriod`. It is
  still the ONE `get_agency_leaderboards` call site, which is what keeps
  `lb_visible_members()` — the single opt-out enforcement point — under the Top
  Producers card. **The cache key carries the RANGE (`lbRangeKey()`), not just
  the period name**, because `'monthly'` means one thing to
  `summaryPeriodRange()` and falls back to `TEAM_PERIOD_DEFAULT` in
  `teamPeriodRange()`; two windows behind one string is how two screens serve
  each other a stale board.
- **🔴 THE PAGE-LEVEL EMPTY STATE IS GONE.** `bosIsEmpty()` is unchanged and
  still answers the statement question, but it now governs only the Commission
  paid card's dash and the money strip's sentence. `bosIsBrandNew()` — **no
  policies AND no statements** — is the only thing that blanks the page, and it
  points at Add Policy, not at statement upload.
- **This screen owns `pp_bos_period`, and writes NOTHING else.**
  `pp_summary_period` is the Front Office Summary's and `pp_team_period` is the
  Agency tab's; the Commissions panel keeps `pp_comm_range` and its own chips.
  Round 4 replaced Round 2's borrowed MTD/YTD/All chips with the shared
  `LG_PERIODS` + `ppPeriodPickerHTML()` control (owner's request). Two things
  had to change for that: `ppApplyRange()` now has an explicit `setBosPeriod`
  branch (it fell through to `setLedgerPeriod`, so Apply would have written
  `pp_summary_period`), and the picker is built with surface `'bos'` because the
  Front Office Summary already owns the element id `pp-rng-sum` and both
  sections are in the DOM at once.
- **🔴 IT ADDS NO BACKEND, AND THAT IS THE POINT.** Every figure comes from an
  RPC that already shipped — including Round 4's `lb_my_agency_state` and
  `get_agency_leaderboards`, both from `20260750`. It never selects
  `commission_rows` from the browser — that table is SELECT-only per tenant and
  the aggregates exist precisely so a screen does not do this — and it never
  selects `policies` either, because `bootDashboard()` already hydrated the
  book. A test pins the RPC list; a new name in it means a migration this round
  deliberately does not have.
- **The production graph is hand-rolled SVG with no library**, and all its
  bucketing lives in the pure `// <bos-chart-core>` block. **"Today" draws the
  LAST SEVEN DAYS, not twenty-four hours** — there is no sale-time timestamp in
  this schema, only entry time, so an hourly axis plots data-entry habits. Same
  evidence `docs/agency-leaderboards.md` records for cutting Early Bird and
  Closer. A test asserts the series is non-decreasing and that its last value
  equals `bosIssuedAP()` over the same window.
- **Two money units, two formatters, one definition each.** `policies[].ap` is
  dollars the agent typed (`_lg$` / `_lgKk`, as on the Front Office Summary);
  commission rows are integer cents from a carrier (`boFmtMoney`). What there is
  never two of is a definition.
- **🔴 THE TEAM ROSTER COMES THROUGH `loadTeamRoster()`, NEVER A SECOND
  `get_team_summary` CALL.** The one-call-site invariant is what stopped the
  8,610× AP overstatement coming back, and a landing screen wanting a headcount
  is exactly the innocent-looking reason a second call site appears.
- **🔴 DEBT IS NEVER RANGE-FILTERED.** `bosDebtArgs()` returns
  `{p_start:null, p_end:null}` and is a function so a test can pin it; a test
  passes MTD, YTD and All time and asserts the balance does not move. The card
  says so in small print because the chips sit directly above it.
- **🔴 NO RATE IS NOT A ZERO RATE, AND A THIN COHORT IS ALSO NO RATE HERE.**
  Absent or under `BOS_MIN_COHORT` (3) renders `—` plus a sentence saying
  which. That is a **deliberate difference** from the Persistency panel, which
  shows thin segments flagged: one lapse in a two-policy cohort is a 50%
  headline on the owner's landing screen. A REAL zero still renders `0%` in
  red. The card states the reason, so the difference is never silent.
- **The team strip is ABSENT for a non-leader** — not empty, not hidden, not a
  locked upsell card. `_planTier() !== 'leader'` returns `''` before anything
  is built. The upgrade gate already lives on the features that need it.
- **Override Income is DROPPED when it is zero AND there is no hierarchy.** A
  permanently empty card on the screen an owner sees every day is noise; it
  returns on its own the first time an override line lands.
- **~~The range chips ARE the Commissions panel's~~ — SUPERSEDED BY ROUND 4.**
  Round 2 borrowed `COMM_RANGES` / `commRange()` / `_cmRange` /
  `pp_comm_range` because every figure came off a statement. The screen now
  reads the book and carries the app's standard period control under its own
  key — see the `pp_bos_period` bullet above. **The Commissions panel is
  untouched** and keeps all four of those; do not add a fourth chip THERE
  without changing both screens.
- **`Promise.allSettled`, never `Promise.all`.** One rejected RPC puts a
  message on that strip and leaves the rest of the page standing.
- **Counts go through `bosCount()`.** `Number('x' || 0)` is `NaN` and
  `Math.max(0, NaN)` is `NaN` too, so the obvious guard is not one.
- **`bo-summary` is ungated in `_applyPlanGating()`, on purpose** — an office's
  landing screen must always be reachable, the same reasoning as the Agency
  tab. Round 2 hand-added it to `bootDashboard()`'s `valid` allow-list, where
  `carriermail`, `backoffice`, `voice-campaigns` and `ai-test` were all
  missing; **Round 3 deleted that list entirely** and derived the membership
  test from the sidebar instead — see the `_isRestorableSection` bullets above
  and `docs/reports/PROMPT_FO3-report.md`. Round 4's Top Producers card follows
  the same reasoning one level down: it is gated on **being in an agency**
  (`lb_my_agency_state().leader_id`), never on plan tier and never on being the
  leader. No agency means NO CARD — not an empty one, not an upsell.

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
  came back on. **`ai-call-tools` is pinned the same way** and answers
  `{"error":"invalid_secret"}` — same test, same meaning.

### Phase 2 — warm transfer, booking, structured outcomes (added 2026-07-30)

- **🔴 `error` IS NOT A CLASSIFICATION RESULT.** Six consecutive production
  calls — every one an ordinary conversation — finalized as `outcome='error'`
  because Telnyx's insight came back as a prose paragraph with no `outcome`
  key. `error` means WE broke, and it is *also* what suppresses the wallet
  debit, so using it for "the parser found nothing" both libels the call and
  gives away the minute. `outcomeFromCallFlow()` derives from facts instead and
  an unclassified answered call is **`completed`**. Pinned by a unit test
  against that exact production payload.
- **The parser degrades in four steps** (`_shared/ai-call-outcome.ts`): JSON →
  a brace-balanced `{…}` lifted out of prose → keyword-mapped prose → prose kept
  as the summary. The brace scan replaced a greedy regex that, given two JSON
  objects in one string, matched across both and parsed as neither.
  `shouldReplaceOutcome()` is the other half: insights arrive **~8s after the
  call already finalized**, so a late, vaguer tag must never downgrade a
  terminal one.
- **The NATIVE Telnyx transfer tool was rejected on evidence, not taste.** It
  has `warm_transfer_instructions` and premium AMD, but **no digit confirm** —
  nothing in `InferenceEmbeddingTransferToolParams`, `InviteToolConfig` or the
  DTMF tool gathers a keypress (checked in the published OpenAPI spec). Press-1
  is what stops a lead being bridged into a car radio. Hence the Call Control
  flow: `ai-call-tools` dials, `ai-call-webhook` whispers, gathers and bridges.
- **`ai_availability` is re-read FRESH at tool time, never captured at call
  start** — the agent can walk away between dial and qualification. `available`
  with no `transfer_number` is treated as busy, server-side *and* in the pill.
- **The transfer tool RETURNS IMMEDIATELY** (`status: "ringing"`). Blocking
  until the agent presses 1 is 15–30s of a blocked assistant, which on a phone
  call is 15–30s of nothing. Failure is pushed back into the live conversation
  with `ai_assistant_add_messages` so the assistant apologizes and books.
- **ONE debit for the whole call, both legs**, keyed on the LEAD's
  `call_control_id` and anchored at lead answer. The agent leg returns from the
  webhook long before the finalize block — that ordering *is* the guarantee.
- **Two call-length settings doing different jobs.** The lead leg is dialed
  `time_limit_secs = 1800` so a transferred conversation is not cut off at five
  minutes; the assistant's own `telephony_settings.time_limit_secs = 300` stops
  **the assistant** and Telnyx documents it as not applying to a transferred
  portion. Because that leaves the leg alive, the webhook hangs up on
  `call.conversation.ended` whenever no transfer is in flight.
- **Appointments are their own table, not the Google Calendar and not
  `leads.data.status`.** The Calendar tab is browser-side `calendar.readonly` —
  an edge function cannot write it. And `sbUpsertAllLeads()` re-upserts every
  lead on every save, so a server-side `data.status` write is silently
  overwritten the next time the agent edits anything.
- **`sms_confirm_status` is never null on success or failure.** A booking whose
  confirmation text did not go out must be distinguishable from one whose did.
  The send is fire-and-forget through the *same* `runComplianceGate` /
  `resolveTextingNumber` / `sendMessageCore` path as `messaging-send-sms` —
  no duplicated gate logic — and it starts working with zero code changes the
  moment the agent's number is attached to the campaign.
- **Telnyx silently drops fields it does not recognise, twice over here.**
  `insight_ids` on an insight-group write is ignored (membership goes through
  `.../insights/{id}/assign`), and the strict-schema rule rejects a `required`
  list shorter than `properties` (400 / code 10015). `sync-ai-assistant.mjs`
  READS BACK everything it writes — that read-back caught both.

### Phase 3 — daily call meter, recommended pace, ramp-up (added 2026-07-30)

- **Read `docs/ai-call-meter.md` before touching anything named `aiMeter*`,
  `ai-call-meter`, `ai_daily_call_cap`, `ai_first_used_at` or
  `ai_pace_events`.** Schema: `20260802_ai_call_meter.sql`.
- **🔴 THE RECOMMENDATION NEVER BLOCKS. ONLY THE AGENT'S OWN CAP DOES.**
  ~300 calls/day per active number (ramped `30,60,100,150,200,250,300` over a
  number's first seven days) is advice about carrier spam-labelling. Passing it
  turns the meter amber, writes ONE `ai_pace_events` row for the day, and
  **places the call**. A test asserts the over-recommendation branch in
  `ai-call-start` contains no `return`. Someone who wants 500 calls a day on one
  number gets the warning and then gets their 500 calls; "add another AI number
  raises the recommendation" is a line of copy, never a wall.
- **`ai_daily_call_cap IS NULL` means NO CAP — a state the agent chose**, not a
  missing value. The column default is 300 (the recommendation *is* the
  default). The migration contains no `update … set ai_daily_call_cap` and must
  not gain one: a blanket backfill hands the cap back to an agent who cleared it
  on purpose. Likewise **a recommendation of `null` (no active numbers) is not
  `0`** — 0 would flag every call on an account that cannot dial at all.
- **A number that has never carried an AI call is ramp day 1, not day 0**, so it
  is recommended 30. That is also what makes the upsell honest: a new number
  adds 30 today and +300 a week later. `ai_first_used_at` is stamped ONCE, only
  after Telnyx accepted the dial (`.is(…, null)`), and is client-immutable via
  the `phone_numbers` denylist trigger — a backdate would buy a fresh number a
  matured number's recommendation.
- **INBOUND IS NEVER COUNTED AND NEVER BLOCKED.** Both count queries (browser
  and server) carry `direction = 'outbound'` and a test greps for it in both.
  The consumer called us.
- **"Today" is the AGENT's day.** `agents.timezone` is written by the browser
  from `Intl…resolvedOptions().timeZone`; NULL falls back to `America/Chicago`.
  **No area-code inference for an agent's own zone** — that is `tcpa.ts`'s job
  for a *recipient*, and it is a different question. The day window is half-open
  and solved by fixed point so DST cannot move it an hour.
- **Gate order in `ai-call-start` is now 1 ai_disabled → 2 upgrade_required →
  3 not_callable → 4 quiet_hours → 5 `daily_cap_reached` → 6
  insufficient_balance.** The cap sits ABOVE the wallet floor deliberately:
  hitting a cap you set yourself is a pacing answer, not a money answer.
- **The math is duplicated on purpose and pinned by a parity test.**
  `_shared/ai-call-meter.ts` (server) and the `// <ai-meter-core>` block in
  `app.html` (screen); `test/ai-meter.test.mjs` runs several hundred shared
  cases through both and compares ramp days, day windows, verdicts and copy.
  Change one, change the other. Same arrangement as `pcNormalizeCode()`.
- **`ai_pace_events` is `unique (agent_id, local_day)` with ONE policy,
  SELECT.** The key does the remembering, not the caller — the stored
  `calls_today` is the count at the FIRST warning, not the day's total. Never
  add an INSERT policy. `ai_call_events` was deliberately not reused (Telnyx
  payloads, no `agent_id`, service-role-only).

### Phase 4 — voice campaigns: the AI dials the book by rules (added 2026-07-30)

- **Read `docs/voice-campaigns.md` before touching anything named `vcamp*`,
  `vc*`, `voice-campaign-*` or `voice_campaign_*`.** Schema:
  `20260802b_voice_campaigns.sql`. Closes `docs/ORION_GAP_ANALYSIS.md` § 1.3.
- **🔴 EVERY CAMPAIGN CALL GOES THROUGH `ai-call-start`, AND THERE IS NO SECOND
  PATH.** Consent, DNC, suppression, quiet hours, the daily cap and the wallet
  floor are enforced once, in one function, in a fixed order.
  `voice-campaign-tick` reimplements none of them — a test greps for
  `min_ai_call_start_mills`, `balance_mills`, `ai_daily_call_cap`,
  `evaluateDailyPace`, `wallet_accounts` and `api.telnyx.com/v2/calls` in it.
  What the engine owns is what to do when the answer is **no**.
- **🔴 EVERY TRIGGER GROUP MUST NAME A LEAD TYPE WITH A POSITIVE `is`
  CONDITION** (`VC_TAG_FIELDS`: campaign_tag, tags, lead_type, coverage_wanted,
  source). `is_not` does not count — "lead type is not trucker" excludes a
  sliver and admits everyone else, which is the campaign nobody meant to build.
  Enforced in the editor, in `voice-campaign-manage` before a re-evaluation
  sweeps a whole book, and by the `voice_campaigns_validate()` trigger on any
  row left `active`. A draft may be saved half-written; **activation** is when
  the rule has to hold.
- **`voice_campaign_enrollments` is SELECT-only for `authenticated`.** An
  enrollment is a standing instruction to phone a consumer. Every write goes
  through `voice-campaign-tick` (cron secret) or `voice-campaign-manage` (agent
  from the JWT, no agent id in the body). Do not add an INSERT/UPDATE policy.
  `voice_campaigns` and `voice_campaign_steps` ARE owner-writable — they are
  configuration, the same class as `producer_codes` — with triggers deriving
  `steps.agent_id` from the campaign and validating the rule.
- **The claim is the whole idempotency story.** One conditional
  `UPDATE … RETURNING`; Postgres re-checks the WHERE after the row lock, so of
  two concurrent ticks exactly one dials. It **leases** (10 min) so a dead tick
  strands nobody, and it is released by `recordCampaignCallResult()` in
  `ai-call-webhook`'s finalize — not by the tick — which is what stops a second
  call going out while the first is connected.
- **Three rejection behaviours, chosen per code** (`vcHandleGateRejection`):
  RESCHEDULE at a stated expiry (`daily_cap_reached` → `resets_at` from the 429
  body; `quiet_hours` → the next allowed instant, computed with gate 4's OWN
  predicate), PAUSE THE CAMPAIGN with a sentence on the card for account-level
  refusals (wallet, plan, kill switch, no caller ID), STOP THE ENROLLMENT for
  per-lead ones (`not_callable`). Never a one-minute retry loop; a test asserts
  no path backs off by less than a minute.
- **Caller-ID rotation closes the meter round's open item.** `vcPickCallerId()`
  picks the active number with the most headroom against ITS OWN ramp, using
  `numberRampValue()` from `_shared/ai-call-meter.ts` so the two cannot
  disagree. A brand-new number is NOT preferred for being unused — it is ramp
  day 1 and recommended 30. Manual test-rig calls still use
  `agents.signalwire_caller_id`.
- **`ai-call-start` now has two callers.** The browser with a session JWT
  (unchanged), and `voice-campaign-tick` presenting **the service role key** as
  its bearer — the only branch that reads `agent_id` from a body, reachable
  only by something a browser never holds. It stays `verify_jwt = true` (NOT in
  `config.toml`); the service key is itself a valid Supabase JWT. `dry_run` and
  every campaign field are gated on the same flag.
- **"Answered" is a TALK LENGTH, not a connect** — `stop_answer_talk_secs`
  (default 15), measured `answered_at → ended_at`, the same two stamps the
  biller uses. A three-second pickup is not a conversation. **DNC stops
  unconditionally**, above every campaign flag.
- **`double_dial` retries once, ~60s later, ON A NO-ANSWER ONLY.** Dialing
  somebody again a minute after they picked up is what gets a number labelled.
- **A drip throttle is not a reschedule** — a held-back enrollment stays due and
  the next tick tries again, so a 20-per-hour step drains over the hour itself.
- **`seed_key` is the seam for the next round's 12 default campaigns**, and its
  unique index is PARTIAL (`where seed_key is not null`). A partial index cannot
  be inferred from a bare column list, so the seed must write
  `on conflict (agent_id, seed_key) where seed_key is not null` — which
  PostgREST cannot express. **The seeder runs as SQL or in an edge function,
  never as a browser upsert.**
### Phase 5 — the 12 pre-built campaigns + bulk consent (added 2026-07-30)

- **Read `docs/voice-campaigns-defaults.md` before touching anything named
  `vc_seed_*`, `vc_default_campaigns`, `voice_campaign_seed_state`,
  `campaign_goal`, `lead_consent_events` or `leads-consent`.** Schema:
  `20260803_default_voice_campaigns.sql`. Closes `ORION_GAP_ANALYSIS.md` § 1.4.
- **🔴 THE TOMBSTONE IS WHAT MAKES A DELETE STICK.** `voice_campaign_seed_state`
  records that a default was OFFERED, and nothing automatic ever removes a row.
  Presence cannot be keyed on the campaign itself: an agent who DELETED one
  looks exactly like an agent who never had it, and re-creating it would restart
  a program that phones consumers. The seeder contains no `UPDATE`, no
  `DO UPDATE` and no `DELETE`; three tests and a production dry run pin
  re-run-adds-nothing, no-overwrite and no-resurrection.
- **`campaign_tag` is the canonical field, and this round created it.** The
  production book carries NO `lead_type`, `type`, `tags` or `campaign_tag`;
  `coverage_wanted` holds DOLLAR AMOUNTS and `source` holds vendor names — so
  the virtual `lead_type` chain matches almost nobody. Each lead-type campaign
  takes the canonical tag as group 1 and the natural vendor words as further OR
  groups. Settable from the Add Lead modal, the CSV importer and `lead-ingest`.
  **`military_status` was deliberately NOT added to `VC_TAG_FIELDS`** — its
  values are one vendor's dropdown wording.
- **The tag guard now accepts `status` for FOUR values only** — `sold`,
  `appointment`, `chargeback`, `lapsed` — because six of the twelve are
  lifecycle campaigns bounded by their trigger, not by a lead-type tag.
  **`status is new` still does not count**; that exclusion is the whole reason
  `status` was left out originally. Same four in `// <vcamp-core>`,
  `voice-campaign-core.ts` and `voice_campaigns_validate()`; a test compares all
  three.
- **`sort_order` is load-bearing, not cosmetic.** The seeder writes twelve rows
  in ONE transaction so `created_at` ties, and three of them trigger on the same
  sale while a lead may be ACTIVE in only one campaign. It is what makes
  Customer Care → Emergency Contact → Beneficiary Referral a stated queue rather
  than a race. The tick orders by it.
- **An anchored step whose moment has passed is SKIPPED, never fired late.**
  `steps.anchor`/`offset_minutes` + `vcResolveNextDue()`. A lead with no
  surviving reminder is not enrolled at all. **The Steps tab must keep carrying
  `anchor`/`offset_minutes` through its save** — that tab deletes and
  re-inserts every row, so dropping them turns "the day before" into
  "immediately".
- **`campaign_goal` changes ONLY the reason clause.** The opener and
  `I'm an assistant calling on behalf of {agent} with {agency}.` are identical
  on every call, because that part IS the disclosure. The column is
  CHECK-constrained and `ai-call-start` normalises an unknown value to
  `qualify`. **The assistant branches on the spoken phrases, not on a dynamic
  variable** — `assistant.dynamic_variables` is what 503'd on the greeting's
  critical path. Reword a clause in `buildReasonClause()` and you must reword
  the matching bullet in `docs/ai-assistant-script-v1.md` in the same commit.
- **🔴 `leads.tcpa_consent` IS NO LONGER WRITABLE FROM A BROWSER.**
  `leads_protect_consent_columns` — and it has **NO admin exemption**, unlike
  the `phone_numbers`/`agents` guards, because it records what a CONSUMER
  agreed to. `leads-consent` (agent from the JWT, no agent id in the body) is
  the only door; it requires the unticked-by-default attestation and writes an
  append-only `lead_consent_events` row carrying that sentence verbatim. The
  Phase 1 AI test rig goes through it too — exempting it would have left a hole
  shaped like that one function.
- **Revoking consent NEVER touches `dnc_list` or `suppression_list`.** Voice
  consent and text consent are different permissions and recording one must
  not widen the other. **AMENDED 2026-07-31 (owner's decision, prompt H/D2):**
  `leads-consent` may now write `consent_records` — but ONLY when the request
  carries the literal `sms_attestation: true`, from a **second, separate,
  never-pre-ticked** checkbox in the Record-consent modal. The rule was never
  "this function must not touch that table"; it was "recording calling consent
  must not silently record texting consent", and that is what the tests pin.
  Voice-only is the default and the common case. See the § below.
- **All twelve ship ACTIVE, and the screen has to say so.** With no consented
  leads they enrol nobody, so a calm banner says exactly that on both the
  Campaigns page and the AI dialer, from one `voiceCallableCount()`. It
  disappears when it stops being true.

- **`ai_inbound_enabled` now DEFAULTS TRUE** and is backfilled for every
  agent-owned number (20260802b). The power-dialer host (`+12625099123`) is
  excluded by e164 and forced false if it ever lands in the table. All three
  purchase paths (`telnyx-buy-number`, `-provision-number`, `-replace-number`)
  get it from the column default and name it nowhere — one default beats three
  call sites that have to remember. Per-number opt-out is in the Phone Book.

### Phase 6 — "Add to campaign": leads reach campaigns without tags (2026-07-31)

Prompt I. No schema change. Docs: `docs/voice-campaigns.md` § "The manual
door". Tests: `npm run test:ai` (`voice-campaign-enroll.test.ts`) and
`npm run test:voicecampaigns`.

- **🔴 `preview_enroll` AND `enroll_leads` ARE THE SAME CALL WITH ONE FLAG.**
  Both build a plan with `vcPlanManualEnrollment()`; only the second writes
  it. A test asserts the planner appears exactly once in that block and that
  the `if (!write)` split comes after it. A preview computed by separate code
  is a preview that eventually lies, and this modal's whole job is to promise
  what the button will do.
- **The door is not a way around consent.** The planner calls
  `vcEvaluateEnrollment()` — the same function the tick's sweep calls — and
  `ai-call-start`'s chain still runs per call. A test asserts `app.html`
  contains no copy of the gate, the planner, or a `suppression_list` query.
  It deliberately does NOT run `vcValidateTriggerGroups`: that guard stops a
  *rule* matching a whole book, and this door has no rule.
- **THREE DOORS, ONE FUNCTION.** Leads tab (`atcConfirm`), CSV importer and
  Add Lead modal (both via `atcEnrollByClientIds`) all reach `atcEnroll()`.
  `'enroll_leads'` and `'preview_enroll'` each appear exactly once in
  `app.html`; a test pins it.
- **Move writes `stop_reason = 'moved_by_user'`, and the stop goes BEFORE the
  insert.** The reverse order leaves a window where the lead is active in two
  campaigns and a tick inside it dials from both. `moved_by_user` is distinct
  from `manual` on purpose — "Unenrolled by hand" would make a move look like
  a loss on both cards. Default is **Skip**; moving ends a campaign somebody
  set up. Consent is checked ABOVE the conflict, so a lead with no consent is
  never reported as "already in another campaign".
- **🔴 `campaign_tag` IS THE ONLY LEAD FIELD THIS EVER WRITES**
  (`VC_ENROLL_TAG_FIELD`). A rule on `lead_type` yields NO tag — it is virtual
  and resolves through `coverage_wanted`, which holds DOLLAR AMOUNTS in this
  book. Two different tag values across groups is ambiguous and writes
  nothing. **The tag is written twice on purpose** — server-side for the tick,
  and by `atcApplyTagLocally()` because `sbUpsertAllLeads()` re-upserts the
  whole book from memory and would erase a server-only `leads.data` write.
  Same trap that keeps appointments out of `leads.data`.
- **The importer's consent step OPENS THE EXISTING MODAL**, scoped to
  `_csvChain.importedIds`. One implementation, never two: a test pins the
  `invoke('leads-consent')` call-site count at **three** (bulk grant, per-lead
  revoke, AI test rig). `openConsentModal({leadIds, label, onDone})` is the
  seam and `onDone` gets **null on cancel** — that is how the importer tells a
  recorded consent from a change of mind. `_consentScope` is dropped on every
  close, before the callback; a stale one records consent against the wrong
  leads.
- **Every summary ends "calls begin automatically at the next allowed time."**
  Assignment is not dialing, and the quiet hours / cap / slot limit / step
  timing that explain the gap are invisible from the leads tab.
- **`vcAutoEnrollPhrase()` says "leads", not "new leads"** —
  `auto_enroll_new_leads` sweeps every matching lead the campaign has not
  seen. A campaign with no trigger reads **"Only leads you add by hand."**,
  which is the whole point: a dormant campaign and an auto-filling one used to
  look identical.
- `.vc-check` / `.vc-pill` are declared under `#sec-voice-campaigns` and so do
  nothing in an overlay. An `.overlay` copy was added; that also gave the
  Record-consent modal the flex layout its inline styles always assumed.

### Phase 7 — mission control + what a call does to the lead (2026-08-05)

Prompt J. Schema: `20260805_campaign_mission_control.sql`. Docs:
`docs/campaign-mission-control.md`. Tests: `npm run test:ai`
(`ai-lead-effect.test.ts`, `voice-campaign-mission.test.ts`) and
`npm run test:mission`.

- **🔴 `ppSetLeadStatus()` IS THE ONLY PLACE THIS BROWSER WRITES A LEAD
  STATUS.** There were five, and that was fine right up until the AI started
  writing statuses too. `sbUpsertAllLeads()` re-upserts every lead's `data`
  blob from memory on every save, so a status the server wrote at 2:04 PM was
  erased at 2:05 PM by a stale copy of the old one — not by a conflicting
  decision, by an echo. A status now travels with **`status_at` +
  `status_source`**; a deliberate edit stamps fresh and wins. A test asserts
  nothing else assigns a status onto a lead.
- **🔴 `leads_preserve_ai_status()` is the database half of the ordering
  guard, and it is what makes a server-side status STICK.** Two enforcement
  points for one rule on purpose: `aiStatusVerdict()` in
  `_shared/ai-lead-effect.ts` decides not to write, and the trigger stops the
  write being undone. Browser writes only (`auth.role()`), it only ever
  protects a status whose `status_source = 'ai'`, and it parses stamps through
  **`pp_jsonb_ts()`** — a bare `::timestamptz` on a malformed jsonb string
  raises inside a BEFORE trigger and takes the agent's whole save with it.
- **A MISSED CALL IS NOT A PIPELINE EVENT.** `no_answer` / `voicemail` / `busy`
  change no status, ever. A six-step campaign dialling somebody five times
  would otherwise walk that lead back to "No Answer" on every attempt and the
  leads board would become a log of the robot's afternoon. **`sold` is human,
  always** — nothing writes it and nothing writes over it. `dnc_request` raises
  the flag and leaves the status alone: burying "do not call me" in a pipeline
  column is how it stops being visible as a legal instruction. `error` gets no
  disposition at all — it means WE broke, and a disposition would be a lie on
  the consumer's record.
- **The mapping covers all twelve values of `ai_calls_outcome_check`, including
  the ones whose answer is "nothing"**, and a test compares the table against
  the constraint's own list. Nothing may invent a status: every written value
  is checked against `STATUS_CONFIG`, and `appointment_booked` writes the same
  `appointment` the lifecycle campaigns trigger on so there are not two
  appointment vocabularies one click apart.
- **`applyLeadEffect()` runs BEFORE `recordCampaignCallResult()`** in the
  webhook's finalize, so the enrollment's stop evaluation reads the lead as it
  now stands. It never throws — it runs after the wallet debit, and a
  bookkeeping failure must not make Telnyx replay a paid, finished call.
- **`last_gate_code` is DISPLAY ONLY and is cleared the moment a call goes
  out** (in the tick when it dials, in `recordCampaignCallResult` when it
  finishes). `vcHandleGateRejection()` already knew why it deferred and threw
  it away, so "Tomorrow 9:05 AM" was the only thing a stalled campaign could
  say — which reads as broken. The engine branches on the plan, never on this
  column; a stale reason outliving its wait is the one thing it must not do.
- **Pause needs no new engine flag.** `status='paused'` is already excluded by
  the tick's due query and by `vcClaimEnrollment` (both require `'active'`), so
  there is nothing for the engine to forget to honour. **Pause leaves
  `next_action_at` alone** so resume returns the lead to its place in the queue
  — and **resume repairs a NULL one**, which is what a pause taken mid-call
  leaves behind; without that the lead is active, never due, and never called
  again. Resume also re-checks `one_active_uidx` (partial on `active`, so
  pausing releases the lead) and returns a sentence instead of a raw 23505.
- **`removed_by_user` ≠ `manual` ≠ `moved_by_user`.** Three stop reasons that
  must stay tellable apart. Remove never deletes and never touches `dnc_list`
  or `suppression_list` — "out of this campaign" and "never call me" are
  different statements.
- **`voice_campaign_enrollments` is STILL SELECT-only for `authenticated`** and
  the migration adds no write policy. A "pause" button is not a good enough
  reason to let a browser write a standing instruction to phone a consumer.
  **Preview and write are the same call with one flag**, same as the manual
  door.
- **The feed reads `ai_calls` — there is NO second event log.**
  `ai_call_events` is the Telnyx diagnostic trace (service-role-only, no
  `agent_id`) and a test asserts the browser never reads it. The only schema
  addition is `ai_calls_campaign_created_idx`. **A live call reports itself as
  live whatever the outcome column says** — the row is `in_progress` from dial
  until hangup, so a feed trusting the column would announce a result mid-call.
- **Polling stops when nobody is looking** — section `.active` AND
  `visibilityState === 'visible'`, on both the campaign screen (10s) and
  `leadEffectsSync()` (60s). The sync is newest-stamp-wins in both directions
  and writes **localStorage only**; pushing it back would be a whole-book
  upsert to tell the server what it already knows.
- **Row click reuses the EXISTING lead view** (`nav('leads')` +
  `expandedLeadIds`), and renders no lead markup of its own.

### Phase 8 — text campaigns on the same engine (SMS-2, added 2026-07-31)

Prompt SMS-2. Schema: `20260807_sms_campaigns.sql`. Docs:
`docs/sms-campaigns.md`. Tests: `npm run test:ai` (`campaign-sms.test.ts`) and
`npm run test:smscampaigns`.

- **🔴 THERE ARE NO NEW CAMPAIGN TABLES, AND THE `voice_` PREFIX IS NOW
  HISTORICAL.** `voice_campaigns` grew a `channel` (`voice` | `sms`); a row
  with `channel='sms'` IS a texting campaign, run by the same tick, the same
  enrollment model, the same claim, the same drip arithmetic and the same
  `seed_key`. Parallel `sms_*` tables were rejected because they produce two
  of every single thing this feature is made of — two ticks racing the same
  minute, two definitions of eligible, two doors, two seeders. Renaming three
  tables, three functions, a cron job and ~1,500 lines of `app.html` buys
  nothing an agent can see; the screen is called **Campaigns**.
- **🔴 EVERY CAMPAIGN TEXT GOES THROUGH `_shared/campaign-sms-send.ts`, AND
  THERE IS NO SECOND PATH** — `runComplianceGate` → `resolveTextingNumber` →
  `sendMessageCore` → the `sms_messages` thread. A test greps
  `voice-campaign-tick` and `voice-campaign-manage` for `runComplianceGate`,
  `sendMessageCore`, `resolveTextingNumber` and `api.telnyx.com/v2/messages`
  and asserts they appear in neither. **It is deliberately NOT
  `messaging-send-sms`**: that function MEANS "a person typed this" and SMS-1
  mutes the responder on it, so routing a drip through it would silence the
  conversation AI on every lead the campaign touched.
- **🔴 ONE ACTIVE CAMPAIGN PER LEAD *PER CHANNEL*.** The partial unique index
  moved from `(lead_id)` to `(lead_id, channel)`. Both halves matter: one of
  each is the point of the feature, two of a kind is the original rule.
  `enrollments.channel` is DERIVED BY A TRIGGER from the campaign — a
  client-supplied value could file a text enrollment as a voice one and defeat
  the index it exists to serve.
- **🔴 A TEXT CAMPAIGN READS TEXT CONSENT** (`consent_records`), never
  `leads.tcpa_consent`, and its suppression list is **`dnc_list`, not
  `suppression_list`** — the latter is the voice AI's. `leads.dnc` stops both
  channels. Getting either backwards would message people who agreed only to a
  phone call, or who already replied STOP.
- **A `wait` step FOLDS into the next actionable step** (`vcResolveNextDue`),
  so it costs no tick and never becomes a `current_step_position`. A voice
  campaign cannot contain one (the steps trigger refuses it), so `folded` is
  always empty there — a test runs the whole shipped Veteran Lead sequence
  through the changed function and compares every due time. **Every "has
  steps?" guard now asks `vcFirstActionableStep()`**: a campaign of nothing but
  waits passes a count check, then enrols people and texts none of them for
  ever while showing green.
- **🔴 A RAW `{{…}}` NEVER REACHES A PHONE.** Six documented variables, each
  with a non-blank fallback; an UNKNOWN one is stripped and the result tidied.
  Rendered SERVER-SIDE at send time, never stored rendered. `vcPersonName()`
  refuses an email — the `ppAgentName()` rule, and it matters more here because
  this decides what a CONSUMER is told the agent is called.
- **The hold is NOT a stop and NOT a pause.** `pause_on_active_conversation`
  moves the due time to when the 24h window closes (or +1h for an agent
  takeover, which has no expiry); the step is unchanged. `last_gate_code`
  carries `live_conversation`/`agent_takeover` so the screen says why.
  **`stop_on_reply` is measured against `enrolled_at`**, not "any inbound
  ever", and does NOT switch off the SMS-1 responder — the editor says so
  under the checkbox.
- **Slots are voice-only.** The tick used to return early for the whole agent
  at three concurrent calls; left alone that would have silently stopped every
  text campaign on the account.
- **Send Test is restricted to the agent's OWN numbers**
  (`resolveTestDestination`, four sources) and that check is the entire safety
  property. Everything else is real — same renderer, same sender, same wallet
  hold, same Telnyx call, rendered against a real lead. It skips
  `runComplianceGate` because the recipient is our customer, and **writes no
  conversation thread**.
- **🔴 THE TEXT COUNT IS COUNTED, NOT CAPPED, and must not grow into a cap.**
  The ~300/number/day call recommendation exists because a number that DIALS
  too much gets spam-labelled; texting throughput is carrier-assigned and the
  sole-prop ~1,000/day ceiling is already refused by the send gate with its own
  reset time. A test asserts the meter block contains no verdict or threshold.
- **Seeding order for SMS-3: INSERT INACTIVE → STEPS → ACTIVATE, one
  transaction.** `voice_campaigns_validate()` refuses an active text campaign
  with no message steps, and the campaign row necessarily precedes its steps.
  The dry run's own seed hit this. Do not relax the trigger.
- **🔴 NO NUMBER ON THIS ACCOUNT HAS `sms_capable = true`** (all 7 rows false,
  checked 2026-07-31), so today every text campaign pauses immediately with
  "none of your numbers is set up for texting yet". `CD2166Q` is ACTIVE and
  billed, so this is the number→campaign assignment not having propagated — a
  pre-existing 10DLC gap, and the one thing between this feature and a live
  send.

### Phase 9 — the twelve pre-written text campaigns (SMS-3, added 2026-07-31)

Prompt SMS-3. Schema: `20260808_default_sms_campaigns.sql`. Docs:
`docs/sms-campaigns-defaults.md`. Tests: `npm run test:defaultsms`.

- **🔴 THE TWELVE TEXT CAMPAIGNS SHIP `active = false`. THE TWELVE VOICE ONES
  SHIP ACTIVE.** Owner's decision, and the asymmetry is the reason: a calling
  campaign on a book with no consented leads dials nobody, so shipping it live
  costs nothing; a text arrives on a phone and stays there, and the agent did
  not write the wording. Never "helpfully" flip these on. The seeder's campaign
  insert writes `false` LITERALLY rather than reading the default's flag.
- **🔴 THE SEED KEYS ARE `SMS_AI_TYPES` MINUS `default`, CHARACTER FOR
  CHARACTER** (`final_expense`, not `sms_final_expense_v1`). `voice-campaign-tick`
  passes `seed_key` straight through as the conversation's `campaign_type` and
  `loadSettings()` matches it EXACTLY with a **silent fallback to `default`** —
  so a drifted key does not error, it answers that whole campaign in the wrong
  voice for ever. A test compares the two lists. They cannot collide with the
  voice defaults' `*_v1` keys, which is what lets one
  `voice_campaign_seed_state` table carry both channels.
- **Every trigger group and every enrollment-trigger flag is byte-identical to
  the voice sibling's** and a test `deepEqual`s them. One definition of "this is
  a veteran lead" per book.
- **`stop_on_reply` is FALSE on exactly two: Customer Care and Appointment
  Reminder.** A check-in sequence that ends when a client says "thanks" never
  runs, and "see you then" must not cancel the day-of reminder. Both still hold
  on a live conversation and both still stop on STOP/DNC.
- **🔴 EVERY BODY IS PLAIN ASCII AND A TEST ENFORCES IT.** One em dash, curly
  quote or emoji forces the whole message to UCS-2 — 67 characters a segment
  instead of 153 — on every send for ever. 201 of the 209 messages are one
  segment; none needs three. (`defaultSmsAiSettings()` has `emojis: false` for
  all thirteen types, which is why there are none.)
- **The opt-out rule is mechanical: position 1, every `position % 5 === 1`, and
  the first message after a gap of ≥ 45 days.** A separate test renders those
  steps with EVERY variable resolving to nothing and asserts the opt-out
  survives — a merge fallback must not be able to eat it.
- **🔴 BENEFICIARY REFERRAL ASKS THE CLIENT AND NEVER TEXTS A BENEFICIARY.** It
  triggers on `status is sold` and asks the insured to pass the agent's number
  on. This must not become the door that routes around
  `referralsFromPolicy()`'s deliberate no-consent rule.
- **🔴 A LIVE-CONVERSATION HOLD MUST NOT FIRE AN ANCHORED REMINDER LATE** —
  the one engine change this round. `vcSmsHoldWouldMissAnchor()` in
  voice-campaign-core; when true the tick SKIPS the step via `vcResolveNextDue`
  instead of holding it. Without it, a lead who texts on Monday morning gets
  "your call is in about an hour" on Tuesday. SMS-2 could not hit this — there
  was no anchored text campaign until now.
- **There is deliberately no `{{appointmentTime}}` merge variable.** The value
  exists on the enrollment, but rendering it for a consumer means picking a
  timezone and getting that wrong on a reminder is worse than not stating it.
  The anchored offsets let the copy say "in about 4 hours" truthfully instead.
- **"Off" is not "Paused".** The pill says `Off` for `active = false` and
  `Paused` only for an engine pause with a reason. An off text campaign gains a
  line and a `Turn on` button; `vcampTurnOn()` routes through
  `vcampToggleActive()` so it cannot skip `vcampConfirmTurnOn()`.
- **`agents_seed_sms_campaigns` is a SECOND trigger on `public.agents`**, not an
  edit to the voice one — a change to the text seeder must not be able to break
  sign-up seeding for the calling campaigns.

## AI texting agent (SMS-1, added 2026-07-31)

- **Read `docs/sms-ai-responder.md` before touching anything named `sms-ai-*`,
  `smsai*`, `sms_conversations`, `sms_messages`, `sms_nudges` or
  `sms_ai_settings`.** Schema: `20260806_sms_ai_responder.sql`. Tests:
  `npm run test:ai` (`sms-ai-core.test.ts`) and `npm run test:smsai`.
- **🔴 IT NEVER INITIATES.** Every path into `sms-ai-respond` starts with an
  inbound message from somebody whose SMS consent is already recorded. The
  nudges continue a conversation the lead started and stop the instant they say
  anything, including "stop".
- **🔴 THE AI GATE IS NOT THE SEND GATE.** `runComplianceGate()` still runs on
  the send itself. `smsAiGate()` is an EARLIER, STRICTER refusal — never remove
  the later one because "we already checked". Gate order is
  1 stop_keyword → 2 opted_out → 3 no_consent → 4 empty → 5 account_disabled
  → 6 upgrade_required → 7 conversation_closed → 8 ai_muted → 9
  type_disabled → 10 no_lead. The two that protect a CONSUMER sit above every
  gate that protects the business, deliberately.
- **`public.messages` / `public.inbound_messages` are the BILLING and PROVIDER
  records and were NOT replaced.** `sms_messages` is the conversation record and
  points at both. `messages.hold_ledger_id` is what wallet_settle/void resolve
  against; `inbound_messages.provider_event_id` is what makes Telnyx retries
  idempotent.
- **A custom-pair hit is sent VERBATIM with no model call.** Longest trigger
  wins; a genuine tie is ambiguous and falls to the model; **a blank trigger is
  dropped because every string contains the empty string**. The editor drops
  exactly what the server drops — a parity test compares them.
- **The compliance paragraph in `buildSystemPrompt()` is not style.** Same rule
  as voice: asked whether it is a person, it answers immediately and plainly
  that it is an **automated assistant**. A test asserts it survives every tone
  and emoji combination.
- **Booking by text uses the SAME machinery as voice** —
  `parseAppointmentTime()`, `ai_appointments`, `buildConfirmSms()` — with
  `source='ai_text'`. The model passes the lead's WORDS, never a timestamp.
  `sms_confirm_status` is never null on success or failure.
- **🔴 THE NUDGE SWEEPER IS ITS OWN WORKER.** `messaging-timeout-sweep` is a
  WALLET-HOLD VOIDER, not a nudge sweeper — it voids holds with no DLR and
  sends nothing. Extending it would put outbound messaging inside a billing
  reconciler. A test asserts neither mentions the other's tables.
  `sms-ai-nudge-sweep` is pg_cron jobid 23, every 10 min, `SMS_AI_CRON_SECRET`,
  `verify_jwt = false`.
- **Nudges are DEFERRED, never dropped** — 9am–8pm lead-local, never Sunday,
  stricter than `tcpa.ts` and not a replacement for it. Offsets are from the
  LEAD'S LAST MESSAGE, and **a step that is off is SKIPPED, not a stop**.
- **🔴 STOP now does all four things.** It did two (suppress + confirm from the
  originating number); it closed no conversation and cancelled no scheduled
  sends because neither existed. Both now do, in
  `closeConversationForOptOut()`, which runs **after** the `dnc_list` write so a
  failure there cannot lose the suppression.
- **A person typing mutes the AI on that thread** (`agent_takeover`); `system`
  sends do not, or a successful booking would silence it. The toggle goes
  through `sms-ai-manage` — `sms_conversations` is SELECT-only for the browser
  — and **turning it back on cannot reopen a conversation an opt-out closed**.
- **`sms_ai_settings` is the ONLY owner-writable table here** (wording, not
  permission to send), with `agent_id` derived by trigger and the 20-pair cap
  as a CHECK constraint. Everything else is SELECT-only.

### SMS consent joins the attestation tool + verify-to-activate (added 2026-07-31)

Prompt H. Schema: `20260804_sms_attestation_and_verification.sql`. Docs:
`docs/auth-verification.md`. Tests: `npm run test:auth`, `npm run test:bonus`,
`npm run test:leadfilters`.

- **🔴 THE PER-LEAD "OPT-IN LINK" BUTTON IS GONE, THE HOSTED PAGE IS NOT.**
  Owner's decision. `/a/<slug>/sms-opt-in`, `compliance-page` and
  `messaging-send-optin-invite` are untouched and still deployed — the carrier
  registration points at that page and it remains the strongest evidence we
  hold. What went away is the in-app button that emailed a lead a link to it,
  plus `smsSendOptInLink()` and the SMS thread's "Email the opt-in link".
  Agents copy the link out of the thread instead. Tests assert the button
  class, the sender and the thread button are all absent.
- **🔴 TEXT CONSENT IS WRITTEN ONLY BEHIND `sms_attestation === true`** — a
  literal boolean compare, not a truthy one, so a stray `1` or the string
  `"false"` cannot opt a consumer in. Exactly ONE `consent_records` insert
  exists in `leads-consent` and it lives inside that branch; a test slices the
  file by index to prove it. The box is un-ticked on **every** open of the
  modal, never remembered.
- **The row written is the shape the SEND GATE already reads** —
  `consent_type='express_written'` (anything weaker and the composer refuses
  it), differing from the hosted page only in `consent_method`
  (`agent_attested`, never `web_form`) and `source`
  (`SMS_ATTESTATION_SOURCE = 'agent_attestation'`, a fixed matchable string,
  not free text). Those two columns are how the grades of evidence stay
  tellable apart forever, which is what carrier review turned on.
- **`lead_consent_events.channel`** (`voice` | `sms`, default `voice`) is new.
  All four ledger inserts name their channel explicitly — a defaulted one
  would file a text event as a voice event and lose the distinction.
- **Revoking pulls back attested text consent, scoped to
  `source = 'agent_attestation'`.** A `web_form` row is the consumer's own
  statement; an agent deciding their attestation was wrong does not un-say it
  for them. Still never touches `dnc_list` or `suppression_list`.
- **🔴 EVERY AGENT THAT EXISTED AT 20260804 IS GRANDFATHERED** past both the
  email and phone gates — 9 of 9, verified at apply time. That is why both
  columns are nullable timestamps and not `boolean not null default false`; a
  default would have locked out all nine live agents including the owner. The
  migration must never gain a blanket re-lock.
- **`agents_protect_verification_columns` has NO admin exemption**, unlike the
  `phone_numbers`/`agents` denylist guards. "An administrator marked this
  phone verified" is not a verification.
- **`phone_verifications` stores a HASH and never the code**
  (`sha256(code + ':' + row.id)`), is SELECT-only, and enforces ~10 min / 5
  attempts / 45s resend **server-side**. Used-expired-exhausted is decided
  BEFORE the hash comparison so a dead code cannot be timed apart from a wrong
  one. Never add an INSERT/UPDATE policy: a client that can bump `attempts`
  can brute-force six digits at leisure.
- **`PLATFORM_SMS_FROM` must be a number on a messaging profile.** Only
  `+12029981783` qualifies on this account; `+12029703699` is rejected 400 /
  40305 *before queuing*. It has no 10DLC campaign yet — see
  `docs/auth-verification.md` § "Owner action — the sending number".
- **The password rule has ONE definition, two copies** —
  `_shared/auth-verify.ts` and the `// <password-core>` block — pinned by a
  several-hundred-case parity test. Same arrangement as `pcNormalizeCode()`.

### 🔴 `window.policies` is an explicit alias, and it has to stay one

- `let policies = []` at the top level of a classic `<script>` binds in the
  global **lexical** scope, not on the global **object**. So `window.policies`
  was `undefined`, and **thirteen** readers fell through their `|| []` and
  computed against an empty book while erroring nowhere: the bonus tracker's
  progress bars, the pipeline funnel, persistency health, chargeback exposure,
  the free-look watchlist, the greeting's MTD AP and the leaderboard record
  nudges. The Policy Tracker used the bare `policies` and always looked right,
  which is why it went unnoticed.
- Fixed once with an `Object.defineProperty(window, 'policies', …)` accessor
  beside the declaration — **not** by switching to `var`, so the alias is
  explicit and cannot be undone by someone modernising a `var` back to a
  `let`. **The setter is load-bearing**: `bootDashboard()` does
  `policies = remotePolicies` and the delete path does
  `policies = policies.filter(…)`; a getter-only property makes those throw.
- `bonusIsComputable()` now also requires a parsed `window` — Bankers Fidelity
  ("ongoing") and Oxford Life reached the bar renderer without one and printed
  "No tier data.", which is not what is wrong with them.
- The pure bonus math lives in `// <bonus-core>` and takes the policy→carrier
  resolver **as a parameter**, because the real one needs the COMP table to
  keep Corebridge GIWL out. Payout shapes are pinned per carrier against the
  real tiers — cliff (MoO/Americo), banded-flat-not-cumulative (Am-Am), banded
  percent (American Home Life), policy-count with an unparseable "up to" rung
  (Corebridge). Do not generalise them.

### Leads screen — filters and selection (2026-07-31)

- **Status / Source / State are multi-selects.** OR within a filter, AND
  across filters, empty set means "All". ONE predicate —
  `leadMatchesFilters()` in `// <leadfilter-core>` — replaces three
  hand-written copies that had already drifted (one normalised the phone
  number before searching it, two did not). `filterLeads`,
  `filterLeads_silent` and `updateLeadTabCounts` all go through it; a test
  asserts they do and that the old `lead-filter-*` selects are gone.
- **The selection lives in `_leadFilterSel`, never in the DOM** — which is
  what makes it survive pagination, re-renders and select-all-across-pages.
- **"Selected" has ONE writer: `syncLeadSelectionUI()`**, deriving the row
  class, the checkbox, the header tri-state and the bulk bar from
  `selectedLeadIds`. The highlight used to be an inline `style.outline`
  written only at render time, so a lead's own checkbox never lit its row —
  and the compact views carried a second copy of the same bug.

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

## Email verification at sign-up (6-digit, step 1)

- **🔴 THE ADDRESS IS PROVED BEFORE THE ACCOUNT EXISTS.** The Verify button and
  code box live on the wizard's "Tell us about you" panel, and
  `wizStep1Next()` refuses to advance until the address in the box has been
  proved. So no unverified account is ever created — there is no post-signup
  gate, no banner and nothing to chase. Schema:
  `20260809_email_verification.sql`. Tests: `npm run test:emailverify`.
- **🔴 `email-verify`'s `send` and `check` ARE UNAUTHENTICATED, AND THAT IS THE
  DESIGN.** There is no session at step 1, so `verify_jwt = false` in
  `config.toml` is load-bearing. It means the function will mail whatever
  address it is handed, so it is bounded three ways instead: **45s + 5/hour per
  ADDRESS** (nobody is mail-bombed), **20/hour per IP** (nobody sprays a list),
  and ~10 min / 5 attempts per code. All server-side; the browser only counts
  down a button. After a deploy an unauthenticated POST with a bad action must
  answer `{"error":"unknown_action"}` — that is the function's own check
  replying, i.e. proof the platform gate is still off.
- **🔴 VERIFYING AN ADDRESS IS NOT VERIFYING AN ACCOUNT.** `check` stamps
  `verified_at` on a row keyed to the ADDRESS and stops. `claim` is the separate
  authenticated step after sign-up: it takes the email **from the JWT, never
  from the body**, and only then writes `agents.email_verified_at`. Reading the
  address from the body would let anyone with an account claim a verification
  somebody else earned. A test asserts `claim` contains no `body.email` and that
  `email_verified_at` is written in exactly one place.
- **`_evVerified` holds the ADDRESS proved, not a boolean.** Editing the email
  after verifying revokes it, and comparing addresses is the only way to notice
  — a flag stays true while the field says something else, which is how somebody
  verifies one address and signs up with another.
- **`email_verifications` has RLS on and NOT ONE POLICY**, plus the grants
  revoked. A browser that could read it could read code hashes; one that could
  write it could forge a verification. Every access is the service role. Do not
  add a policy. It stores a **hash, never the code**, salted with the row's own
  id — same as `phone_verifications`.
- **The code rules are SHARED with `phone-verify`**, not a second copy —
  `generateCode`, `hashCode`, `codeUsable`, `resendAllowed`, the expiry and the
  attempt ceiling all come from `_shared/auth-verify.ts`. Only the **reason**
  from `codeUsable` crosses the wire: its `detail` is SMS wording ("this
  number"), and the whole verdict object in `error` is not the string every
  caller assumes. Email wording lives in `evVerifyMessage()`.
- **A row is claimed, never deleted.** `claimed_by` is set once, guarded by
  re-applying `.is('claimed_by', null)` on the UPDATE so two concurrent claims
  cannot both win. A used verification is evidence. **A failed send DOES delete
  its row** — a code nobody received must not shadow the next cooldown or burn
  an hourly slot.
- **An account with nothing to claim is not an error** (`no_verified_address`).
  Google sign-in and every pre-existing account never had a step-1
  verification, and the nine agents alive at `20260804` are already backfilled.
- **Supabase's "Confirm email" is OFF** (`mailer_autoconfirm` on), which is what
  lets `signUp()` return a session so checkout mounts inline. That also means
  `auth.users.email_confirmed_at` is stamped for everyone and is **no longer
  evidence of anything** — `agents.email_verified_at` is the real record.
  `sb.auth.resend({type:'signup'})` errors on an already-confirmed user, so
  `vgResendEmail()` is dead code on this path.

## Stripe checkout

- **🔴 `stripe-webhook` IS 100% OF FULFILLMENT, IN BOTH UI MODES.** Embedded
  Checkout's `onComplete` fires on the client and a client can be lied to, so
  it grants no plan, credits no wallet and writes no `plan_id` /
  `monthly_minute_limit`. A test greps the whole completion path for those
  writes and for any `sb.` call. It is a UI signal and nothing more.
- **Embedded is WEB ONLY, selected by `ui: 'embedded'` and a STRICT compare.**
  Anything else — including absent — keeps today's hosted behaviour byte for
  byte, which is what lets the native shell and any older cached `app.html`
  keep working with no change on their side. A truthy check would let the
  string `"false"` turn it on; same bug class as `leads-consent`'s
  `sms_attestation`. Native keeps `_wizOpenStripePopup()` /
  `_openStripeCheckoutPopup()` and `checkout-complete.html` — **those are not
  dead code**, they are the entire native purchase flow, and Apple's
  payment-info privacy exemption depends on checkout genuinely being outside
  the app.
- **`redirect_on_completion: 'never'` is chosen so the top window never
  navigates.** The default (`'always'`) sends the TOP window to `return_url` —
  the exact bug `checkout-complete.html` exists to fix, through a different
  door. Stripe rejects a session carrying `success_url`/`cancel_url` alongside
  it, so `applyEmbeddedCheckout()` deletes them; that is required, not tidying.
  **The tradeoff:** `'never'` disables redirect-based payment methods (bank
  authorisation flows). This account takes cards, so it costs nothing today.
  If one is ever wanted the answer is `'if_required'` plus a real `return_url`,
  **not** a revert to hosted.
- **The embedded shape is written in exactly ONE place** — the
  `// <embedded-checkout-core>` block in `stripe-create-checkout`, extracted
  and EXECUTED by `test/embedded-checkout.test.mjs`. Three session paths
  (`topup`, `numbers`, subscription) call it; the existing-subscriber path
  creates no session and must never be routed through checkout at all.
- **FIVE call sites in `app.html`, pinned by a test** — signup wizard,
  `planRequiredSubscribe()`, `_autoCheckout()`, `pbConfirmAddFunds()` and
  `pbApplyPlanChange()`. (Prompt 18's inventory said four and missed the last,
  which was doing a top-level `location.href` and unloading the whole
  dashboard.) Each checks **`client_secret` before `url`**, so a stale server
  that ignores the flag lands on the working hosted path instead of a blank
  modal. `mode: 'numbers'` is wired server-side but has **no call site** — a
  dead path, deliberately not given UI.
- **`_wizIsNative()` is the ONLY platform predicate**, and a test asserts
  `isNativePlatform` appears nowhere else. A second answer to "are we in the
  shell" puts the native build on a path nobody tested.
- **Closing the modal IS the cancel path.** The X button, `Escape` and a
  backdrop click all reach `closeStripeCheckout()`, which runs the caller's
  `onCancel` — `planRequiredSubscribe()` used to leave its button reading
  "Opening checkout…" forever when the flow died. `onComplete` **destroys the
  instance before** the caller's callback, because `_goToSuccessUrl()`
  navigates and an undestroyed Stripe iframe mid-navigation floods the console.
- **The subscription paths reuse `_goToSuccessUrl()`, never a toast.** It sets
  `?checkout=success` and reloads specifically so `bootDashboard()`'s already
  tested webhook-lag retry runs — the webhook may not have landed when
  `onComplete` fires, and that retry is the thing covering the gap.
- **Payment method domains are a Dashboard setting, not code.** Hosted Checkout
  handled it for us; embedded does not, so Apple Pay / Google Pay silently do
  not render inside the iframe until `producerstackcrm.com` is added under
  Stripe → Settings → Payments → Payment method domains.

## Carrier email parsing feature — key gotchas

Key gotchas encoded in the map (read its `key_findings`):
- Transamerica masks policy numbers (`xxxxx76911`) — match on last 5 digits.
- `noreply@aatx.com` sends two different email types — split on subject regex, match addresses case-insensitively.
- Ethos mixes marketing and transactional on one sender — subject allowlist, ignore by default.
- Mutual of Omaha underwriting mail comes from personal underwriter addresses — match domain + subject pattern.
- Never fetch links from login-link emails (Corebridge secure messages, Americo portal notifications) — they become dashboard nudges only.
