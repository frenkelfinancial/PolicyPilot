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
