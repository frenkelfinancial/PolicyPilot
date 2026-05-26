# Architecture — `index.html` Internal Map

`index.html` is one file with three regions: `<style>`, `<body>` markup, and `<script>`.
Below are the line ranges as of the current snapshot — refresh this doc when ranges shift.

## Repo layout (Build B, 2026-05-07)

```
Jace- Life Insurance/
├── index.html                       # AGENT view — loads shared/data.js and shared/quote-engine.js
├── client.html                      # CLIENT view — public self-serve quote wizard (Build B)
├── shared/                          # Loaded by BOTH views
│   ├── data.js                      # COMP, FE_RATES, CARRIER_MULTS, UW_CLASS, BUILD_LIMITS
│   ├── quote-engine.js              # pure quoteFE / quoteTerm / quoteIUL
│   ├── tokens.css                   # client design tokens (Warm Ivory + Midnight Navy + Heritage Green)
│   ├── health-questions.json        # client question tree (canonical)
│   └── uw-translator.js             # answersToConditions / summarizeForLead + question-tree literal
├── client/                          # Client-only (never referenced by index.html)
│   ├── client.css                   # wizard + card styles, token-only
│   ├── card-client.js               # renderClientCard / renderClientCardSet
│   └── wizard.js                    # 6-step state machine + STUB submitLead
├── docs/
│   ├── architecture.md              # this file
│   ├── client-build-b.md            # Phase 0c contracts + Phase 3b scenario log
│   ├── data-sources.md
│   ├── security-notes.md
│   └── upgrade-roadmap.md
└── archive/                         # Snapshots taken before each refactor
    ├── index-2026-05-07-initial-import.html
    ├── index-2026-05-07-pre-extract.html
    └── index-2026-05-07-pre-pure-refactor.html
```

**Trust split:** `shared/quote-engine.js` always returns `commPct` and
`advComm` on every result. The agent renderer (inside `index.html`) shows
them; the client renderer (`client/card-client.js`) drops them. The split
lives in the renderer — the engine never branches on audience.

**`EAPP_URLS` stays inline in `index.html`** — agent-only carrier portal URLs
must never ship to `client.html`.

---


## CSS — lines 7–177
Inline `<style>` block. Sections in order:
- **Tokens** (`:root` vars) — colors, fonts. Lines 9–15.
- **Sidebar** — `.sidebar`, `.nav-item`, `.contract-box`. Lines 18–34.
- **Main / topbar / sections** — Lines 35–42.
- **Cards / grid / buttons / forms / tabs** — Lines 43–67.
- **Quote results** — `.carrier-card`, `.badge`, `.rrow`, `.comm-box`. Lines 68–85.
- **Conditions chips** — `.cond-grid`, `.chip`. Lines 86–90.
- **Policy table** — `.ptbl`, `.sp-*` status pills, payment notices. Lines 91–104.
- **Stats / progress / milestones** — Lines 105–129.
- **Modal** — `.overlay`, `.modal`. Lines 130–138.
- **Misc utilities** — `.alert`, `.empty`, `.flex`, `.text-*`. Lines 139–158.
- **Scrollbar / calendar / award gradients** — Lines 159–176.

## HTML body — lines 181–832

> ⚠️ Line numbers below are stale (predate the auth gate). Use `grep -n` at edit
> time, not these ranges.

- **Auth gate** (`#auth-gate`, just after `<body>`): inline login / sign-up /
  reset-password panel rendered on top of everything until Supabase resolves a
  session. `.sidebar` and `.main` are `display:none` until `hideGate()` runs.
- **Sidebar** (181–211): logo, nav items, contract-level input. Sign-out button
  was added at the bottom of `.sidebar-bot`.
- **Topbar** (214–219): page title, today's date.
- **Section: Quoter** (`#sec-quoter`, 222–446):
  - FE sub-section (`#qt-fe`, 232–312): rate estimator + live iframe.
  - Term sub-section (`#qt-term`, 314–399).
  - IUL sub-section (`#qt-iul`, 401–444).
- **Section: Policy Tracker** (`#sec-tracker`, 449–474): running totals strip + table.
- **Section: Drafts Calendar** (`#sec-drafts`, 477–540): month nav + calendar grid + list view.
- **Section: Bonus Tracker** (`#sec-bonuses`, 543–727): FFL / Americo / AmAm tabs.
- **Section: UW Cheat Sheet** (`#sec-uw`, 730–770): search + table + class guide + build chart.
- **Modal: Add Policy** (`#addPolModal`, 776–832).

## JavaScript — lines 834–2188

> ⚠️ Line numbers below are stale. Use `grep -n` at edit time.

| Region | Lines | What it does |
|---|---|---|
| External script tags | 834 | `<script src="shared/data.js">`, `<script src="shared/quote-engine.js">`, and the Supabase SDK (`@supabase/supabase-js@2` UMD from jsdelivr) — load BEFORE the inline `<script>` block |
| Supabase config | top of inline | `SUPABASE_URL`, `SUPABASE_ANON_KEY` consts, `sb = supabase.createClient(...)`. Anon key is RLS-safe, see `security-notes.md`. |
| **Auth (Supabase Auth)** | top of inline | `currentAgent`, `authShowView`, `authMsg`, `authSignIn`, `authSignUp`, `authForgot`, `authUpdatePassword`, `authSignOut`, `showGate`/`hideGate`, `k(name)` namespace helper, `claimLegacyData`, `subscribeAuth` (registers `onAuthStateChange` listener — handles `PASSWORD_RECOVERY`, `SIGNED_IN`, `SIGNED_OUT`). |
| **Supabase Sync** | top of inline | `sbPullPolicies`, `sbPullLeads`, `sbUpsertPolicy`, `sbUpsertLead`, `sbUpsertAllLeads`, `sbDeletePolicy`, `sbDeleteLead`, `sbSaveContract`, `sbLoadContract`, `sbFirstSyncIfNeeded`. Hybrid CRUD per `Patterns/Supabase Hybrid CRUD`: localStorage = optimistic cache, Supabase = source of truth. Tables: `public.agents`, `public.policies`, `public.leads` (all RLS-locked to `auth.uid()`). |
| Inline-script preface | 836–840 | Comment pointing to `shared/data.js` for the extracted tables |
| Compensation helper | 840–852 | `getCommPct` (uses `COMP` from `shared/data.js`), `getContract`, `saveContract` |
| FE rate helpers | 856–871 | `interpRate` (uses `FE_RATES` from `shared/data.js`), `fmt$`, `fmtPct` |
| AI health parser | 873–1000 | `aiParseHealth`, `healthCache`, debounce, `renderHealthTags` — **broken as shipped, see security-notes.md** |
| UW classification helpers | 1002–1024 | `worstClass`, `classToApproval` (`UW_CLASS` lives in `shared/data.js`) |
| Conditions chip grid | 1026–1063 | `buildConditions`, `clearConditions` |
| E-app URLs | 1065–1080 | `EAPP_URLS` map — **agent-only**, intentionally NOT extracted to shared/ |
| FE quote engine (DOM wrapper) | 1066–1206 | `runFEQuote` — reads DOM, calls `quoteFE` from `shared/quote-engine.js`, renders agent cards with commission |
| Term quote engine (DOM wrapper) | 1208–1268 | `runTermQuote` — calls `quoteTerm` |
| IUL quote engine (DOM wrapper) | 1270–1316 | `runIULQuote` — calls `quoteIUL` |
| Policy tracker | 1416–1525 | `policies` (localStorage), `addPolicy`, `deletePolicy`, `renderPolicies`, modal helpers |
| FFL VP bonus | 1528–1571 | `calcFFL` — point breakdown across BP / legs / writers / persistency |
| Americo UFirst bonus | 1573–1629 | `AM_MS` milestones, `buildAmMilestones`, `calcAmerico` |
| Am-Am Bonus Bucks | 1631–1676 | `calcAmAm` — Silver/Gold/Platinum tier logic |
| UW cheat sheet data | 1678–1818 | `UW_DATA`, `BUILD_CHART`, `buildUWTable`, `buildBuildChart`, `filterUW` |
| Build check | 1820–1854 | `checkBuildOk` (uses `BUILD_LIMITS` from `shared/data.js`), `checkBuild`, `onPaymentChange` |
| Navigation | 1856–1917 | `nav`, tab switchers (`quoterTab`, `feTab`, `termTab`, `iulTab`, `bTab`), `updateBonusFromTracker` |
| Drafts calendar | 1919–2056 | `draftViewYear/Month`, `draftNavMonth`, `renderDraftsCalendar` |
| Init | end of inline | `DOMContentLoaded` calls `subscribeAuth()`. The auth listener calls `bootDashboard()` on every `SIGNED_IN` (re-entrant safe). `bootDashboard` hydrates `policies` and `leads` from namespaced localStorage and renders the dashboard. |

## State

### Bootstrap flow

1. Page loads → SDK script + inline script parse → all auth helpers and dashboard JS available.
2. `DOMContentLoaded` → `subscribeAuth()` registers `onAuthStateChange` listener.
3. Supabase emits `INITIAL_SESSION` immediately:
   - **Session present** → `currentAgent` set, `claimLegacyData()` runs, `hideGate()`, `bootDashboard()` mounts the UI.
   - **No session** → `showGate()`, sign-in view shown.
4. `PASSWORD_RECOVERY` event (from `#access_token=...&type=recovery` URL hash) → reset-password view shown.

### LocalStorage keys

Per-agent keys are namespaced by Supabase user UID (e.g. `ff_policies_<uid>`) via the `k(name)` helper. The legacy unscoped keys are claimed by the first signed-in agent on a given browser via `claimLegacyData()` (idempotent).

- `ff_contract` (per-agent) — agent's contract level (default 100). **Optimistic cache** for `public.agents.contract_level`.
- `ff_policies` (per-agent) — JSON array of policies. **Optimistic cache** for `public.policies` (`data` column).
- `pp_leads` (per-agent) — JSON array of leads. **Optimistic cache** for `public.leads` (`data` column).
- `gcal_client_id`, `gcal_api_key`, `pp_gcal_token`, `pp_gcal_events` (app-wide) — Google Calendar integration state. Not namespaced; will need treatment when multi-agent gcal becomes a concern.

### Supabase tables

- `public.agents` — 1:1 with `auth.users`; profile fields (`email`, `display_name`, `contract_level`, `npn`, `phone`). Auto-created via `handle_new_user()` trigger.
- `public.policies` — `(id uuid, agent_id uuid, client_id bigint, data jsonb)`. UNIQUE on `(agent_id, client_id)` for upsert from the front-end's `Date.now()` ID.
- `public.leads` — same shape as `policies`, `client_id` is `text`.

All three RLS-locked: `auth.uid() = id` (agents) or `auth.uid() = agent_id` (policies, leads). DDL in `data/sql/`.

## Where to add things

- **New carrier:** add to `COMP` and `CARRIER_MULTS` in `shared/data.js`,
  to `EAPP_URLS` in `index.html`, to `_FE_CARRIERS` / `_TERM_CARRIERS` in
  `shared/quote-engine.js`, and to every row in `UW_CLASS` (`shared/data.js`)
  and `UW_DATA` (in `index.html`).
- **New UW condition:** add to `UW_CLASS` in `shared/data.js`, to the AI
  system-prompt list inside `index.html`, to `UW_DATA` so it appears on the
  cheat sheet, and (if relevant for the public wizard) add a question or
  follow-up in `shared/health-questions.json` mapping to the new key.
- **New rate band:** edit `FE_RATES.americo_eagle.rates` in
  `shared/data.js`. Keep entries in ascending age order — `interpRate` (in
  both `index.html` and `shared/quote-engine.js`) walks the table
  sequentially.
- **New bonus program:** mirror the Americo / Am-Am pattern — add a section
  in the bonus-tracker partial, add a calc function with `oninput` wiring,
  and add a case to `bTab`.

## Book Intelligence (Phase 1 — Term Conversion Radar)

Lives in `index-3.html` as a new sidebar tab (`#sec-book-intel`) plus
inline helpers under `window.bookIntel`. No new tables, no new
infrastructure — extends `public.policies.data` jsonb with optional
fields and writes a sub-object back through the existing `sbUpsertPolicy`.

**Data flow:** existing tracked policies auto-feed the radar. The Policy
Tracker remains the canonical entry path; CSV import is an additional
backfill route for historic books. Scoring is in-memory on every tab
entry and on manual refresh — no nightly job in v1.

**Policy jsonb extensions** (all optional, nullable, additive):

| Field | Type | Notes |
|---|---|---|
| `productType` | enum | `TERM` / `WL` / `UL` / `IUL` / `VUL` / `GUL` |
| `productName` | string | free text, e.g. `"Term Essential 20"` |
| `faceAmount` | number | preferred over legacy `cov` when present |
| `issueDate` | `YYYY-MM-DD` | required for any deadline calc |
| `termLengthYears` | int | 10 / 15 / 20 / 25 / 30 |
| `clientDob` | `YYYY-MM-DD` | drives age-based conversion cutoff |
| `clientAge` | int | computed from `clientDob`, cached |
| `ratingClass` | string | "Preferred Plus", "Standard", "Table 2", … |
| `smokerStatus` | enum | `never` / `former` / `current` |
| `knownConditions` | string[] | keys from `UW_CLASS` |
| `conversionDeadline` | `YYYY-MM-DD` | cached output of `bookIntel.computeDeadline` |
| `opportunity` | object | `{ type, priority, estCommission, urgencyDays, whyNow, evidence, status, snoozedUntil, dismissedReason, closedOutcome, closedAt, lastScoredAt }` |
| `bookIntelSource` | string | `'csv'` when the row was imported via the BI CSV flow |

Carrier conversion rules live in `shared/data.js` under
`CARRIER_CONVERSION_RULES` (and mirrored at `data/conversion-rules.json`).
Unknown carriers return `null` and surface as a "Needs carrier setup"
card — we never guess deadlines.

Migration `data/sql/003_policies_book_intel.sql` adds two indexes:
one on `((data->>'conversionDeadline')::date)` and one on the
opportunity status path. No column changes.

**Reused modules:** `quoteIUL()` (`shared/quote-engine.js`) for the
permanent-premium estimate, `COMP.mutual_iule` (`shared/data.js`) for
the commission percent, `sbUpsertPolicy()` / `sbPullPolicies()` for
persistence, `parseCSV()` / `escapeHTML()` / `showToast()` for I/O.

LLM drafting is intentionally NOT used in Phase 1 — outreach drafts
are deterministic templates branched by urgency band and condition
presence. Revisit once a server proxy exists for the Anthropic key.

### Phase 1 automation pack (added 2026-05-10)

Five automations layered on top of the base radar:

1. **Smart inference** — `bookIntel.inferFromPolicy` / `applyInference`
   parses product names ("Term 20", "OPTerm 15", "IULE") to fill
   `productType` + `termLengthYears`, uses legacy `draft` as `issueDate`,
   pulls `clientDob` from a matching lead record. Runs at the top of
   `scoreAll`, inside `_biProcessRows` (CSV), and inside the Add Policy /
   Submit-As-Sold save paths. Never overwrites agent-entered values.

2. **Inline BI fields in Add Policy** — `#addPolModal` gained Issue Date,
   Client DOB, and Term Length (visible when product is Term Life)
   fields. Newly tracked policies are BI-ready by default.

3. **Daily digest** (`supabase/functions/daily-digest/`) — Deno Edge
   Function. Reads `digest_enabled = true` agents, scores their books
   server-side via `supabase/functions/_shared/scoring.ts` (port of the
   browser kernel), sends the top-3 via Resend. Migration
   `004_agent_digest_prefs.sql` adds `digest_enabled` + `digest_email`
   to `public.agents`. In-dashboard toggle in the BI header writes
   through. Cron is on the deployer (pg_cron or external). See
   `supabase/functions/daily-digest/README.md`.

4. **Auto follow-up cadence** — two new `opportunity.status` values:
   `AWAITING_RESPONSE` (set by "I sent it" or successful Gmail send,
   hides the card until `followUpAt` ≤ today, surfaces with "Follow-up
   due" badge) and `STALLED` (auto-set in `scoreAll` after 14 days
   awaiting with no input). New filter chips for both. Reopen / Bump 4d
   / Stall actions on the card.

5. **Direct Gmail send** — extends existing Google OAuth (`gcalConnect`)
   to also request `gmail.send` scope. New `biGmailSend` builds an
   RFC 2822 message, base64url-encodes it, posts to the Gmail API.
   On success, automatically chains into `biMarkSent` (#4). Reuses the
   `pp_gcal_token` localStorage key; tracks granted scopes in
   `pp_google_scopes` so we can detect when re-auth is needed.

## Build B (client wizard) entry points

- `client.html` boots `client/wizard.js` after loading `shared/*` and
  `client/card-client.js`. The wizard drives 6 steps via
  `window.WizardSlots.step(id)` and `window.WizardSlots.progress(n,total)`.
- Submit handler (`submitLead` in `client/wizard.js`) is currently a STUB
  that `console.log`s a 15-field `params` object and returns `{ ok: true }`.
  Build B-2 swaps the body for an EmailJS or Supabase write — the
  signature does not change.
- See `docs/client-build-b.md` for the locked translation rules, schema,
  and 5-scenario verification log.

## Dashboard Design System (DS Layer — Phase 0, 2026-05-11)

The dashboard-redesign series authors against a `--ds-*` token layer added on
top of the existing Producer Stack tokens. Both layers coexist; legacy widgets
keep using `--bg`, `--accent`, `--text`; new widgets use `--ds-color-*`,
`--ds-radius-*`, `--ds-space-*`, `--ds-duration-*`.

**Where things live (all in `index-3.html`):**

- Tokens: bottom of the `:root` block, mirrored in `body.light{}`, with a
  `prefers-reduced-motion` override at the end of `<style>`.
- Primitive CSS: the `/* ---- DS PRIMITIVES ---- */` block right above
  `/* ---- AUTH GATE ---- */`.
- Primitive JS factories: the `// ---- DS PRIMITIVES ----` block right after
  `getContract` / `saveContract`.
- Data layer: the `// ---- DS DATA LAYER ----` block right after the factories.
- Playground: `#sec-ds-playground` (gated on `?ds=1`), init via
  `dsInitPlayground` called from the end of `bootDashboard`.

**Six primitives:** `dsStatCard`, `dsProgressRing`, `dsSparkline`,
`dsTrendBadge`, `dsActionItem`, `dsEmptyState`. All take a single options
object, return DOM elements, and read no globals (one documented exception:
`dsActionItem` reads `--ds-duration-base` via `getComputedStyle` to time the
fade callback). New accents are added by extending the `DS_ACCENTS` set and
adding the matching `[data-accent="..."]` CSS rule. Tones for `ActionItem` are
gated by `DS_ACTION_TONES` (`urgent`, `today`, `opportunity`).

**Four data shapes:** `Activity`, `Goals`, `ChargebackExposure`, `EventItem`.
Accessors: `getActivities`, `getGoals`, `getChargebackExposure`, `getEvents`.
Real persistence (Supabase `activities` / `goals` tables, per-carrier
chargeback schedules) is a follow-up plan — for now accessors derive from
`policies` or fall back to empty arrays / zero-totals.

**Verification surface:** open `index-3.html?ds=1`, click the **Design System**
nav entry (it sits below Settings — see "Nav highlight quirk" below). Every
primitive renders there in light + dark.

**Nav highlight quirk:** `nav()` highlights the active sidebar item via a
hardcoded positional `idxMap`. The dynamic `#nav-ds` entry is appended AFTER
Settings (so existing indices stay correct), and `dsInitPlayground` patches
`NAV_TITLES` and toggles the active class manually for that one item. If you
ever reorder nav items, update the `idxMap` literals at lines ~7518 and ~9876.

**Spec / plan trail:**

- Vision: `docs/superpowers/specs/2026-05-11-dashboard-redesign-vision.md`
- Phase 0 plan: `docs/superpowers/plans/2026-05-11-dashboard-redesign-phase-0-foundation.md`

## Action Hub (Phase 1.2 — 2026-05-12)

A full-width card at the top of `#sec-summary` that lists the agent's
prioritized actions. Three sections: Urgent, Today, Opportunities. Data source
is the `getEvents()` accessor from the Phase 0 data layer. Each row is a
`dsActionItem`; the CTA invokes `addActivity()` (Phase 1.2 writer) and removes
the row.

**Where things live:**
- CSS: `/* ---- ACTION HUB ---- */` inside the inline `<style>`, right above
  `/* ---- AUTH GATE ----`.
- Markup: `<div class="card ah-hub" id="action-hub">` as the first child of
  `#sec-summary`.
- Writer: `addActivity()` writes to `DS_LS.activities()` localStorage. Supabase
  sync is a follow-up.
- Renderer: `renderActionHub()` called from the top of `renderSummary()`.

**Activity persistence:** `addActivity()` is the first non-read function in the
DS data layer. It caps the array at 500 entries (oldest dropped). Real
persistence to Supabase requires a new `activities` table + the standard
hybrid CRUD pattern.

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-1-2-action-hub.md`

## Pipeline Funnel (Phase 2 — 2026-05-12)

A full-width card inserted into `#sec-summary` between the Action Hub / hero
band and the Book Intelligence card. Renders a 6-stage horizontal funnel
(`Submitted → In UW → Approved → Issued → Placed → Paid`) with aging color
overlay and a placement-ratio chip. Click any non-empty segment to open a modal
drill-down listing all policies in that stage with last-action days and AP.

**Where things live (all in `index-3.html`):**
- CSS: `/* ---- PIPELINE FUNNEL ---- */` inside inline `<style>`, right above
  `/* ---- AUTH GATE ---- */`.
- Constants: `PIPELINE_STAGES` (stage definitions + match predicates) and
  `PIPELINE_BENCHMARKS` (median days-in-stage, edit here to tune aging
  thresholds) — inserted right after `_ahFormatMeta`.
- Helpers: `pipelinePartition(pols)`, `_pipelineDaysIn(p)`,
  `pipelineAging(stageKey, pols)` — same location.
- Renderer: `renderPipelineFunnel()` — builds `.pf-seg` divs via
  `createElement`; no `innerHTML` on dynamic data.
- Drill-down opener: `openPipelineDrilldown(stage, pols, age)` — populates
  `#pipelineDrillModal` using `createElement`/`textContent`.
- Closer: `closePipelineDrilldown()` — hides overlay.
- Markup (funnel card): `<div class="card pf-card" id="pipeline-funnel">` inside
  `#sec-summary` just above the Book Intelligence card.
- Markup (modal): `<div class="overlay pf-overlay" id="pipelineDrillModal">` 
  right after `#addPolModal`.
- Boot wiring: `renderPipelineFunnel()` called from `renderSummary()` after
  `renderActionHub()`.

**Aging logic:** each stage gets a `data-age` attribute (`fast` / `on-pace` /
`stalled`) driven by comparing the median days-in-stage across all policies in
that bucket against `PIPELINE_BENCHMARKS[stageKey]`. Thresholds: < 70% of
benchmark = fast (green), > 150% = stalled (red), otherwise on-pace (yellow).
Empty stages get `data-empty="true"` and are non-clickable.

**Width algorithm:** `flex-grow = 0.6 + (count / maxCount) * 2.4` — zero-count
stages get the smallest sliver (0.6) and the fullest stage gets 3.0; `min-width:
48px` keeps labels readable.

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-2-pipeline-funnel.md`

## Smart Goal Hub (Phase 1.1 — 2026-05-12)

Replaces the single-ring monthly-AP donut (`.ring-wrap` + `.goal-side`) inside
`<div class="card hero-goal">` with a dual-ring **Smart Goal Hub**: outer ring
tracks AP goal, inner ring tracks apps goal, and a center overlay displays a
**Pulse Score** (0-100 composite). The outer card wrapper is unchanged so the
existing `.sum-hero` CSS grid layout is unaffected.

**Pulse Score formula (deterministic, 0-100):**
- 40% pace: `currentAp / paceTarget` (pace-to-date AP = `goalAp × elapsed/total days`)
- 30% activity: last-7-day submissions vs. `typicalWeek` (currently 4; tunable)
- 30% pipeline health: `1 − stalledRatio` where stalled = events with tone `urgent`
- Each component clamped at 1.5× before weighting; sum divided by 1.5 = clamped 0-100

**Adaptive weekday pacing:** `paceNeeded(currentAp, goalAp, today)` divides
remaining AP by `weekdaysRemaining(today)` (Mon–Fri count, inclusive) rather
than calendar days.

**Where things live (all in `index-3.html`):**
- CSS: `/* SMART GOAL HUB — Phase 1.1 */` block inside inline `<style>`, right
  above `/* ---- AUTH GATE ---- */`.
- Helpers: `weekdaysRemaining`, `paceNeeded`, `goalsResolved`, `pulseScore` —
  inserted right after `closePipelineDrilldown()` (end of Phase 2 region).
- Renderer: `renderSmartGoalHub(currentAp, monthApsCount, today)` — uses
  `dsProgressRing` (Phase 0) for both rings; no `innerHTML` on dynamic data.
- Markup: two `sgh-ring-mount` divs (not `.ds-ring` — see deviation note below)
  plus `.sgh-center` overlay and `.goal-side.sgh-meta` scorecard inside
  `<div class="card hero-goal">`.
- Boot wiring: `renderSmartGoalHub(monthAP, monthPolsHero.length, today)` inside
  `renderSummary()`, replacing the old `renderGoalRing` + `renderGoalScorecard`
  calls. The old function definitions are kept (orphaned) for safety.

**Deviation — ring mount approach:** The plan originally used `class="ds-ring"`
on the placeholder divs, which would have created a `.ds-ring` nested inside a
`.ds-ring` (from `dsProgressRing` output). To avoid this double-nesting, the
placeholders use `class="sgh-ring-mount"` and the CSS targets `.sgh-ring-mount`
(with `.sgh-ring-mount--inner` for the 24px inset). The appended `dsProgressRing`
output remains the sole `.ds-ring` in the tree.

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-1-1-smart-goal-hub.md`

## Income Reality Row (Phase 3 — 2026-05-12)

> **Breaking change:** The `.kpi-grid` block (AP Written / Adv Comm Paid / Projected Bonus / Active Policies) **is gone**. The four `.kpi-card` tiles and their IDs (`sum-ap-hero`, `sum-paid-hero`, `sum-bonus-hero`, `sum-active-hero`, `sum-bonus-breakdown`, `sum-ap-delta`, `sum-paid-delta`, `sum-active-delta`, `sum-ap-spark`, `sum-paid-spark`, `sum-active-spark`) have been deleted from both markup and `renderSummary`. The KPI data they showed is absorbed: AP Written → Smart Goal Hub; Adv Comm Paid → Net Commission card; Projected Bonus → Phase 6; Active Policies → Phase 4.

The `.kpi-grid` CSS rules and `.kpi-*` class definitions remain in `<style>` (still referenced by `.bi-sum-grid .kpi-hero` and similar legacy widgets). Removal is deferred to a CSS-cleanup phase.

**Three-card `.ir-row`** replaces the old strip:

1. **Net Commission Forecast** — `earned − exposed`: `earned = sum(advComm) for paid policies`; `exposed = getChargebackExposure().totalAdvanced`. Stacked horizontal bar + legend shows earned (green) vs. exposed (red) split. Hero accent is `success` when net ≥ 0, `danger` otherwise.

2. **Chargeback Exposure** — hero is `cb.totalAdvanced`; sub-label counts `cb.atRiskPolicies.length`. Sparkline uses `cb.earnDownSchedule[0..11].amount` (empty in v1 — placeholder renders). Clicking the card navigates to the Policy Tracker.

3. **Renewal / As-Earned Forecast** — 12-month cumulative projection of `inForceAP × RENEWAL_PCT / 12`. `RENEWAL_PCT = 0.05` (5%; carrier-tunable later, search that const to change it). Hero is `renewalSeries[11]`; sparkline is the 12-point series.

**Known gap (deferred to v2):** Net Commission trend vs. last month — needs a historical commission snapshot; not derivable from `policies` alone.

**Where things live (all in `index-3.html`):**
- CSS: `/* INCOME REALITY — Phase 3 */` block right above `/* ---- AUTH GATE ---- */`.
- Helpers: `RENEWAL_PCT`, `inForceAP`, `netCommission`, `renewalProjection12mo` — inserted right after `pulseScore` (end of Phase 1.1 region).
- Renderer: `renderIncomeReality()` — uses `dsStatCard` (Phase 0) for all three cards; no `innerHTML` on user data.
- Markup: `<div class="ir-row" id="income-reality"></div>` — replaces old `.kpi-grid` at the same DOM position in `#sec-summary`.
- Boot wiring: `renderIncomeReality()` called from `renderSummary()` right after `renderPipelineFunnel()`.

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-3-income-reality.md`

## Activity & Momentum Row (Phase 5 — 2026-05-12)

Two-card `.am-row` inserted in `#sec-summary` immediately after `#income-reality`, before `.bi-summary-card`.

**Card 1 — Activity Pulse (1.4fr):** 5-stage conversion funnel (Dials → Contacts → Appts → Apps → Issued) for the last 7 days plus a GitHub-style heatmap calendar (53 weeks × 7 days = 371 cells, CSS grid with `grid-auto-flow: column`).

**Card 2 — Streaks & Records (1fr):** Current streak + longest streak (consecutive days with at least one logged activity or policy draft). Achievement badges row — 5 deterministic badges rendered as `.am-badge` spans, earned/unearned distinguished by `data-earned` attribute.

**Data sources:**
- Top 4 funnel stages: `getActivities()` — type mapping: `call` → dials, `contact` → contacts, `appointment` → appts, `quote` → apps.
- Issued stage: `window.policies` filtered to `status in (issued, placed, paid)` within the range window.
- Streak: union of activity dates from `getActivities()` plus `p.draft` dates from `window.policies`.
- Heatmap: all `getActivities()` records, grouped by date; level 0-4 based on count (0, 1-2, 3-4, 5-6, 7+).

**Funnel conversion targets (fixed v1):** dial→contact 25%, contact→appt 40%, appt→app 50%, app→issued 80%. `[data-tone]` on the ratio row: `ok` (≥ target), `warn` (≥ 70% of target), `bad` (below 70%).

**Achievement list (ACHIEVEMENTS const):**
| id | label | predicate |
|---|---|---|
| `first-app` | First Application | totalApps ≥ 1 |
| `ten-month` | 10 Apps in a Month | bestMonthApps ≥ 10 |
| `week-streak` | 7-Day Streak | longestStreak ≥ 7 |
| `month-streak` | 30-Day Streak | longestStreak ≥ 30 |
| `multi-carrier` | 5 Carriers Active | uniqueCarriers ≥ 5 |

**Daily/weekly toggle deferred to v2** — hardcoded at 7 days in v1.

**No `innerHTML` on dynamic data** — all cards built with `createElement` + `textContent`.

**Where things live (all in `index-3.html`):**
- CSS: `/* ACTIVITY & MOMENTUM — Phase 5 */` block right above `/* ---- AUTH GATE ---- */`.
- Helpers: `ACTIVITY_FUNNEL_TARGETS`, `activityFunnel`, `activityHeatmapCells`, `streakStats`, `ACHIEVEMENTS`, `evaluateAchievements` — inserted right after `renderIncomeReality()`.
- Renderer: `renderActivityMomentum()` — extends `dsStatCard` (Phase 0) for both cards; hero element removed post-construction since funnel + heatmap replace it visually.
- Markup: `<div class="am-row" id="activity-momentum"></div>` in `#sec-summary` after `#income-reality`.
- Boot wiring: `renderActivityMomentum()` called from `renderSummary()` after `renderIncomeReality()` and before `biRenderSummaryTile()`.

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-5-activity-momentum.md`

## Persistency & Book Health Row (Phase 4 — 2026-05-12)

Two-card `.ph-row` inserted in `#sec-summary` immediately after `#activity-momentum`, before `#pipeline-funnel`. Lets the agent spot persistency risk before it becomes a chargeback.

**Card 1 — Persistency Dashboard (1.3fr):** Two `dsProgressRing` widgets (size 72, thickness 8) for the 13-month and 25-month rates side by side in `.ph-rates`. Below the rings: a free-look watch list (`.ph-watch__list`) of all in-force policies issued within the last 30 days, sorted ascending by days remaining. Read-only — no CTA (Action Hub handles ≤7-day urgencies).

**Card 2 — Book Composition (1fr):** Inline SVG donut (120×120, fresh element keyed off `productMix()` — NOT the legacy `.mix-donut`) with a side legend list. When a single carrier exceeds 50% of in-force AP, a `.ph-warn` strip appears below.

**Persistency math:**
- `persistency13mo(pols)` — cohort = policies with `issueDate` ≥ 13 months ago; rate = `kept / cohort.length` where `kept = status in (issued, placed, paid)`.
- `persistency25mo(pols)` — same for 25-month cohort.
- If cohort is empty (legacy data lacking `issueDate`), `rate` returns `null` and the ring renders `—` with "Not enough cohort data yet".
- Benchmark constants: `PERSIST_BENCH_13M = 0.85`, `PERSIST_BENCH_25M = 0.75`. Tune these two consts to adjust the industry reference lines.

**`IN_FORCE` set:** `new Set(['issued','placed','paid'])` — shared by all Phase 4 helpers. Defined once at module scope.

**Free-look watch:** `freeLookWatch(pols)` — policies with `issueDate` within last 30 calendar days AND `status in IN_FORCE`. Mutates `p._daysSinceIssue` and `p._daysLeftInFreeLook` on matching policies. Sorted by days-remaining ascending (most urgent first). Urgency coloring: `data-urgency="urgent"` for ≤1 day, `"today"` for ≤7 days, `"flat"` otherwise.

**Product mix:** `productMix(pols)` — groups in-force policies by `p.productType || regex match on p.productName || 'OTHER'`, sums AP per group.

**Carrier concentration:** `carrierConcentration(pols)` — returns `null` when no in-force policies exist; returns `{ carrier, pct, ap }` for the top carrier. Warning hidden when `pct ≤ 0.50`.

**No `innerHTML` on dynamic data** — all nodes built with `createElement` + `textContent`. The plan's inline `list.innerHTML` for the empty mix state was converted to `createElement`.

**Deferred (v2):**
- NSF / missed-draft alerts — requires real-time payment processor webhook; no `status === 'nsf'` field exists in the current data model.
- Avg face / avg AP / commission-per-app summary stats — design space reserved but empty in v1.
- Concentration drill-down panel.

**Where things live (all in `index-3.html`):**
- CSS: `/* PERSISTENCY HEALTH — Phase 4 */` block right above `/* ---- AUTH GATE ---- */`.
- Helpers: `PERSIST_BENCH_13M`, `PERSIST_BENCH_25M`, `IN_FORCE`, `_polsIssuedMonthsAgo`, `persistency13mo`, `persistency25mo`, `freeLookWatch`, `productMix`, `carrierConcentration` — inserted after Phase 5 helpers, before `renderSmartGoalHub`.
- Renderer: `renderPersistencyHealth()` — uses `dsStatCard` (Phase 0) for both cards; inline SVG donut built with `createElementNS`.
- Markup: `<div class="ph-row" id="persistency-health"></div>` in `#sec-summary` after `#activity-momentum`.
- Boot wiring: `renderPersistencyHealth()` called from `renderSummary()` after `renderActivityMomentum()` and before `biRenderSummaryTile()`.

**Snapshot:** `archive/index-2026-05-12-persistency-health-complete.html`

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-4-persistency-book-health.md`

---

## Phase 6 — Bonus Tier Intelligence (2026-05-12)

Replaced the static three-row **Bonus Milestones / Pace & Forecast** card with a dynamic **Bonus Tier Intelligence** card. The outer `<div class="card pace-card">` is preserved and gains a `bti-card` class; its interior is rewritten.

**New functions (all in `index-3.html`):**

- `bonusTierIntel()` — builds per-carrier ladder objects (Americo UFirst, Am-Am Bonus Bucks, FFL VP Track) from pre-existing globals (`AMERICO_WINDOW`, `AM_MS`, `amAmWindow`, `getContract`). Defensive `typeof` guards — if a global is missing the ladder is silently omitted.
- `recommendBestPush(ladders)` — finds the carrier with the highest `gapPayout / gapAp` ratio (best ROI for next push). Skips contract-level ladders (`isContract === true`) since they are not AP-driven.
- `renderBonusTierIntel()` — rewrites `.bti-card__body` with one `.bti-ladder` row per carrier (three-column grid: name/sub | progress bar | CTA). All dynamic data built with `createElement` + `textContent` — no `innerHTML` on user data.

**Rendering:**
- Each ladder: horizontal stepped progress bar (`.bti-bar` + `.bti-bar__fill`) with tier marker ticks (`.bti-tier`) positioned by AP threshold (not even spacing). Reached tiers shown in success color.
- CTA column: `$X more → Label → +$Y` for AP-driven ladders with a payout gap; `Reach Label at N%` for contract-level; `Top tier reached` when maxed.
- Recommendation pill (`.bti-recommend`): hidden when no qualifying push exists; shown with carrier name and gap amounts.

**Orphaned but preserved:** `renderPaceRow`, `pacePosition`, `paceTagFor`, `buildAmericoPaceOpts`, `buildAmAmPaceOpts`, `buildFFLVPPaceOpts`, `buildVPPaceOpts` — functions remain defined, call sites in `renderSummary` removed and replaced with single `renderBonusTierIntel()`.

**Where things live (all in `index-3.html`):**
- CSS: `/* BONUS TIER INTELLIGENCE — Phase 6 */` block right above `/* ---- AUTH GATE ---- */`.
- Helpers: `bonusTierIntel`, `recommendBestPush` — inserted after `renderPersistencyHealth` body, before `renderSmartGoalHub`.
- Renderer: `renderBonusTierIntel()` — inserted after `recommendBestPush`, before `renderSmartGoalHub`.
- Markup: `<div class="card pace-card bti-card">` in `#sec-summary` (same DOM position as old pace card).
- Boot wiring: `renderBonusTierIntel()` called from `renderSummary()` where the three `renderPaceRow(...)` calls were.

**Extending for new carriers:** Add another ladder object to the return array in `bonusTierIntel()`. No renderer changes needed — the for-loop over `ladders` handles any count.

**Snapshots:** `archive/index-2026-05-12-pre-bonus-tier-intel.html` (pre), `archive/index-2026-05-12-bonus-tier-intel-complete.html` (post)

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-6-bonus-tier-intelligence.md`

---

## Phase 7 — Polish, Motion & Stickiness (2026-05-12)

Cross-cutting layer that makes the dashboard feel inspiring. No new widgets — only enhancements layered on top of all existing renderers.

### New helpers (in `index-3.html`, inserted before `renderSummary`)

| Function | Purpose |
|---|---|
| `_esc(s)` | HTML-escape helper — wraps any user-data value before `innerHTML` interpolation |
| `_animateValue(el, from, to, fmt, duration)` | Count-up animation using ease-out-cubic; respects `--ds-duration-slow`; short-circuits when `from === to` |
| `_lastSeenValue(key)` | Read last persisted value from `Map` cache then localStorage (`k('ds_last_' + key)`) |
| `_storeLastValue(key, v)` | Write value to the Map cache and localStorage |
| `_kpi(key, el, newValue, fmt)` | Convenience: `_lastSeenValue` → `_animateValue` → `_storeLastValue` in one call |
| `_momentsEnabled()` | Returns `true` when agent has opted into celebration moments (localStorage `k('ds_moments_enabled') === '1'`) |
| `setMomentsEnabled(v)` | Toggle celebration moments on/off |
| `_showMomentOverlay(html, durationMs)` | Creates a `.dm-overlay` div, appends to `<body>`, animates in/out via Web Animations API, removes itself on completion |
| `dashboardMomentApp(policy)` | App-submit celebration — called from `addPolicy` |
| `dashboardMomentPlacement(policy)` | Policy-placed celebration — available; wired on status-change as follow-up (Phase 7.5) |
| `dashboardMomentStreak(days)` | Streak milestone celebration — called from `renderSummary` streak-diff logic |
| `dashboardMomentStreakBreak(prevDays)` | Streak break empathy overlay — called from `renderSummary` streak-diff logic |
| `renderGreeting()` | Writes a contextual greeting into `#pgTitle` using `currentAgent.display_name` + hour + streak/AP state |
| `applyDashboardLayout()` | Reads `k('dashboard_layout')` JSON array of card IDs; moves cards in `#sec-summary` to match stored order via `appendChild` |
| `saveDashboardLayout()` | Writes current `#sec-summary` child IDs to `k('dashboard_layout')` |
| `_wireReorder()` | Attaches HTML5 drag-and-drop listeners to all `.card[id]` children of `#sec-summary`; calls `saveDashboardLayout()` on drop |
| `requestDashboardNotifications()` | Async; requests `Notification` permission — **not called automatically**, must be invoked by a future settings toggle |
| `notifyIf(title, body)` | Fires a browser Notification if permission is granted |
| `scheduleDailySummary()` | Sends one Notification per day summarizing `getEvents()` counts — only when `_momentsEnabled()` and only once per calendar day |

### CSS additions

- `/* DASHBOARD MOMENTS — Phase 7 */` block inserted just before `/* ---- AUTH GATE ---- */`.
- `.dm-overlay` — fixed full-screen container, pointer-events none, z-index 400.
- `.dm-card` — modal-style card; variants `.dm-card--strong` (success border) and `.dm-card--momentum`.
- `.greet` / `.greet__hello` / `.greet__name` — topbar greeting strip styles.
- `.sum-v3 .card[draggable="true"]` / `.dragging` / `.drag-over` — drag-to-reorder visual feedback.
- `@media (prefers-reduced-motion: reduce){ .dm-overlay{display:none} }` — accessibility gate.

### Integration into existing code

- `renderSummary()`: `renderGreeting()` at top; streak-diff celebration + `applyDashboardLayout()` + `scheduleDailySummary()` at bottom.
- `addPolicy()`: `dashboardMomentApp(policy)` at the end (after field clear).
- `bootDashboard()`: `_wireReorder()` at the end (after `dsInitPlayground`).

### Deferred items (Phase 7.5)

- **Task 9 count-up migration** — Two key sites migrated (2026-05-12 v2): Pulse Score (`sgh-pulse-num`) and Streaks & Records (`streak-current`, `streak-longest`) now use `_kpi()` with ease-out-cubic count-up. Remaining sites (Income Reality, Pipeline Funnel counts, Bonus Tier AP totals) still use direct `.textContent` — deferred to Phase 7.5 to preserve stability.
- **Placement-status hook** — `dashboardMomentPlacement()` is defined and tested but no single clean `setPolicyStatus()` function exists in the architecture; wiring requires a small refactor of the tracker edit flow.
- **Sparkline draw-on animation** — `dsSparkline` paints instant; stroke-dashoffset animation noted as a v2 polish gap.
- **Goal-hit takeover** — needs a goal-hit detection point; deferred until Smart Goal Hub gets richer goal state.

### Snapshots

- Pre: `archive/index-2026-05-12-pre-polish-motion.html`
- Post: `archive/index-2026-05-12-phase7-polish-motion-complete.html`

**Plan:** `docs/superpowers/plans/2026-05-12-dashboard-redesign-phase-7-polish-motion.md`
