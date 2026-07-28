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
- **`/10dlc` list filters use plain query params** (`?brandId=…`), NOT the `filter[brandId]` JSON:API style used elsewhere in Telnyx v2.
- **Campaign creation** (Phase 2) is `POST /v2/10dlc/campaignBuilder` (needs `messageFlow` + opt-in/opt-out/help keyword+message fields) — NOT `POST /v2/10dlc/campaign`.
