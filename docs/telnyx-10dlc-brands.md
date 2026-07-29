# Telnyx 10DLC brands (A2P) — reference

Recorded here (not hardcoded in any function). Brand IDs are identifiers, not
secrets; the sandbox brand ID is also exposed to code as the
`TELNYX_SANDBOX_BRAND_ID` env var (see below). Telnyx account:
`jace@frenkelfinancial.com`, org `9df0c073-2d34-4c9e-a1a5-e26fbd4b92d1`.
Verified live 2026-07-27.

| | Production | Sandbox (testing only) |
|---|---|---|
| Display name | Frenkel Financial Agency | ProducerStack Sandbox |
| Telnyx brand ID | `4b20019f-a5df-2721-e3c1-cea9522125a0` | `4b20019f-a5e2-5239-ca22-5a978e4de52f` |
| TCR brand ID | `BBTQ508` | `BI1PSHD` |
| `identityStatus` (Telnyx) | `VERIFIED` | `VERIFIED` (mock auto-verifies) |
| `mock` | `false` | `true` |
| Entity type | `PRIVATE_PROFIT` | `PRIVATE_PROFIT` (placeholder EIN) |
| Dashboard label | Verified | Unverified (mock, no fee) |

## Rule: use the SANDBOX brand for all Phase 1 / dev testing

Never register, assign, or otherwise mutate A2P state against the **production**
brand during development — an agent's real messaging routing lives there.
Testing goes through `TELNYX_SANDBOX_BRAND_ID`.

`TELNYX_SANDBOX_BRAND_ID=4b20019f-a5e2-5239-ca22-5a978e4de52f` is set in
`.env.local` (gitignored). If a **deployed** function ever needs it (e.g. a
dev-account A2P test path in Phase 2), also set it as a Supabase secret:
`supabase secrets set TELNYX_SANDBOX_BRAND_ID=4b20019f-a5e2-5239-ca22-5a978e4de52f`.
No deployed function reads it yet — today it is used only by the local smoke
test `scripts/a2p-sandbox-smoke.ts`.

## Important limitation found 2026-07-27: mock brands can't be approved

A campaign **can** be created on the unverified mock sandbox brand
(`POST /v2/10dlc/campaignBuilder` → 200, `mock:true`, `billedDate:null` = no
fee). BUT the mock brand's placeholder EIN makes the campaign **fail TCR
vetting**: `campaignStatus` went `TCR_PENDING` → `TCR_FAILED` within ~2 min.
Telnyx then **refuses to assign a number** to any non-approved campaign
(`POST /v2/10dlc/phone_number_campaigns` → 400 code 10036 "Campaign is still
pending and has not been approved yet").

**Consequence:** the sandbox proves campaign creation, the assignment endpoint,
its error path, and every data shape — but it **cannot** prove a successful
`ASSIGNED`. That requires an approved campaign, which only the VERIFIED
production brand can produce. A single controlled production test (create one
campaign on Frenkel Financial, let it approve, assign one number, then
unassign) is the only way to exercise the full `ASSIGNED` path — do that
deliberately, not as part of routine dev testing.

## Verified API facts (drive the adapter — `_shared/telnyx-10dlc-adapter.ts`)

- **Assignment:** `POST /v2/10dlc/phone_number_campaigns` body `{phoneNumber, campaignId}`. (`/phoneNumberCampaign` is an alias; snake is canonical. No 404 fallback — a "number not found" is also a 404.)
- **Per-number status:** `GET /v2/10dlc/phone_number_campaigns/{e164}` → the assignment, or 404 when unassigned. Used by `a2p-status-poll`.
- **`/v2/10dlc/*` returns BARE objects** (`{records:[…]}` for lists, no `{data}` wrapper). `/v2/phone_numbers/*` uses the standard `{data}` wrapper.
- **Brand status field:** `identityStatus` (`VERIFIED`). Ignore the secondary `status`=`OK`.
- **Campaign status field:** `campaignStatus` (`TCR_PENDING`/`TCR_FAILED`/`TCR_ACCEPTED`/`ACTIVE`). `TCR_FAILED` = rejected.
- **Messaging profile:** the account has ONE — "Jarvis" `40019edb-acf4-47da-ae79-9a712deda81a` (`TELNYX_MESSAGING_PROFILE_ID`). A number's `messaging_profile_id` is on the **base** `/v2/phone_numbers` object; set it via `PATCH /v2/phone_numbers/{id}/messaging {messaging_profile_id}`.
- **Brand update is `PUT`, NOT `PATCH`.** `PATCH /v2/10dlc/brand/{id}` returns
  `404 Resource not found` (probed live 2026-07-28). The update verb is `PUT`,
  and `PUT` replaces — a partial body nulls the fields it omits, on a
  **VERIFIED** brand. Safe procedure: `GET` the brand, echo back every
  currently-set field except the server-managed ones (`brandId`,
  `tcrBrandId`, `cspId`, `identityStatus`, `status`, `createdAt`, `updatedAt`,
  `mock`, `failureReasons`, `assignedCampaignsCount`,
  `businessContactEmailVerifiedDate`, `universalEin`), change the one field you
  mean to, `PUT` that, then diff before/after to prove nothing else moved.
  Changing `website` this way did **not** re-trigger vetting —
  `identityStatus` stayed `VERIFIED`.
- **Carrier review feedback lives on the CAMPAIGN, in `failureReasons[]`, and
  a campaign can carry it while still being `ACTIVE`.** `GET
  /v2/10dlc/campaign?brandId=<id>` returns `{records:[…]}`; each record has
  `status`, `tcrCampaignId`, `billedDate` and `failureReasons[].description`.
  Do not read `status: ACTIVE` as "no problems" — `CD2166Q` is `ACTIVE` with
  three unresolved review items. Read `failureReasons` explicitly.
- **`/10dlc` list filters use plain query params** (`?brandId=…`), NOT the `filter[brandId]` JSON:API style used elsewhere in Telnyx v2.
- **Campaign creation** is `POST /v2/10dlc/campaignBuilder` (needs `messageFlow` + opt-in/opt-out/help keyword+message fields) — NOT `POST /v2/10dlc/campaign`. **Implemented and verified live 2026-07-28** — see below.

## Verified by a real mock campaign — 2026-07-28

`scripts/a2p-phase2-smoke.ts` created campaign
`4b30019f-a751-7137-49de-f9834598ee05` on the sandbox brand. Re-runnable at
any time; it costs nothing.

- `campaignBuilder` returns the campaign as a **bare object with
  `campaignId`** — the parse the withdrawn `a2p-register` got wrong now
  round-trips.
- `billedDate: null`, `mock: true` → **a sandbox campaign is genuinely free.**
- `messageFlow`, `description`, `sample1-3`, `optinMessage`, `optoutMessage`,
  `helpMessage`, `termsAndConditions`, `embeddedPhone`, `numberPool` all
  persist and read back unchanged.
- `privacyPolicyLink` / `termsAndConditionsLink` read back **null** on the
  GET. They exist as response keys but cannot be set — a third independent
  confirmation that the campaign has no compliance-link field.

**`usecase` enum — no longer a guess.** Telnyx's own `10032` error lists all
28 valid values:

```
ACCOUNT_NOTIFICATION, AGENTS_FRANCHISES, CARRIER_EXEMPT, CHARITY,
CONVERSATIONAL, CUSTOMER_CARE, DELIVERY_NOTIFICATION, EMERGENCY, FRAUD_ALERT,
HIGHER_EDUCATION, K12_EDUCATION, LOW_VOLUME, MARKETING, MIXED, POLITICAL,
POLLING_VOTING, PROXY, PUBLIC_SAFETY_RESTRICTED, PUBLIC_SERVICE_ANNOUNCEMENT,
SECURITY_ALERT, SOCIAL, SWEEPSTAKE, 2FA, UCAAS_LOW, M2M, SOLE_PROPRIETOR,
TRIAL, UCAAS_HIGH
```

Both values we depend on are present: `LOW_VOLUME` (standard brands, accepted
on a real create) and `SOLE_PROPRIETOR` (sole-prop brands, which accept no
other use case).

## The production guard (`a2p-register`, from 2026-07-28)

`a2p-register` will **not** create a production brand unless the request body
explicitly carries `allow_production: true`. Without it the function attaches
to `TELNYX_SANDBOX_BRAND_ID` and charges nothing — and it verifies with Telnyx
that the id really reports `mock: true` rather than trusting the env var to be
pointed where we think it is. A production run logs loudly before it spends
anything.

`TELNYX_SANDBOX_BRAND_ID` is therefore now read by a **deployed** function, so
it must exist as a Supabase secret, not only in `.env.local`:

```bash
supabase secrets set TELNYX_SANDBOX_BRAND_ID=4b20019f-a5e2-5239-ca22-5a978e4de52f
```

The sandbox brand is deliberately **shared** across agents — one mock brand
that every dev registration points at. The uniqueness guarantees in
`20260731_a2p_resumable_registration.sql` exclude `telnyx_env = 'sandbox'` for
exactly that reason, and the immutability trigger permits a sandbox →
production promotion without a manual unlock.
