# PROMPT 15 — A2P 10DLC: unblock assignment, add Sole Proprietor, auto-register at signup

**Target:** Claude Code, ProducerStack repo
**Goal:** take an agent from signup to legally sending SMS with zero paperwork on their end.
**Depends on:** existing `a2p-register`, `a2p-status-poll`, `a2p-assign-number`, `_shared/telnyx-10dlc-adapter.ts`, `_shared/messaging-shared.ts`, `phone_numbers`, `a2p_registrations`, `billing_config`, wallet RPCs.

Work the phases in order. Each phase is independently shippable — stop after any one and the app is still coherent.

---

## Background you need before touching code

**The current state is broken end-to-end.** `assignNumberToCampaign()` in `_shared/telnyx-10dlc-adapter.ts` is a deliberate stub returning `ok:false`. So an agent can register a brand, get approved, be charged, and still never send a text, because no number is ever attached to the campaign and `_shared/messaging-shared.ts` blocks the send. Phase 1 fixes exactly that.

**We are NOT building a shared brand.** Telnyx's ISV guidance requires a separate brand per end customer and explicitly prohibits sharing numbers across brands. Every agent gets their own brand and their own campaign. The "zero touch" comes from automating the submission, not from pooling agents under Frenkel Financial LLC. Do not add any code path that registers multiple agents under one brand or reuses one `campaign_id` across `agent_id`s.

**Most of our agents have no EIN.** They're 1099 producers, not entities. The current `a2p-register` hard-fails without one. Sole Proprietor registration solves this and is a first-class path, not a fallback.

---

## Phase 1 — Implement number → campaign assignment

### 1.1 Fill in the adapter stub

In `_shared/telnyx-10dlc-adapter.ts`, replace the `assignNumberToCampaign` stub with a real implementation.

**Endpoint:** `POST https://api.telnyx.com/v2/10dlc/phone_number_campaigns`

**Request body:**
```json
{ "phoneNumber": "+19208758577", "campaignId": "<campaign id>" }
```

**Response fields to read:**
`phoneNumber`, `campaignId`, `brandId`, `tcrBrandId`, `tcrCampaignId`, `telnyxCampaignId`, `assignmentStatus`, `failureReasons`, `createdAt`, `updatedAt`

**`assignmentStatus` enum:** `PENDING_ASSIGNMENT` · `ASSIGNED` · `FAILED_ASSIGNMENT` · `PENDING_UNASSIGNMENT` · `FAILED_UNASSIGNMENT`

> ⚠️ Telnyx's own docs show two spellings for this route — the API reference uses `POST /10dlc/phone_number_campaigns` and a guide page uses `POST /10dlc/phoneNumberCampaign`. Hit the API reference form first. If it 404s, try the camelCase form before assuming anything else is wrong, and leave a comment recording which one worked.

Change the return type to carry the status through instead of a bare boolean:

```ts
export interface AssignNumberResult {
  ok: boolean;
  assignmentStatus?: "PENDING_ASSIGNMENT" | "ASSIGNED" | "FAILED_ASSIGNMENT"
                   | "PENDING_UNASSIGNMENT" | "FAILED_UNASSIGNMENT";
  failureReasons?: string;
  error?: string;
}
```

Also add a status-check helper:

```ts
export async function listCampaignNumbers(apiKey: string, campaignId: string)
// GET /v2/10dlc/phoneNumberCampaign?filter[campaignId]=<id>
```

Keep the existing adapter convention: callers depend on our return shape, never Telnyx's raw JSON.

### 1.2 Preconditions the adapter must respect

Assignment fails unless all of these hold. Check them before calling out, and return a specific error for each:

- Campaign status is approved/ACTIVE (carrier-approved, not just submitted)
- Number is in E.164
- **Number is already attached to a Telnyx Messaging Profile** — verify `telnyx-buy-number` / `telnyx-provision-number` set this at purchase. If they don't, fix that as part of this phase; assignment will fail without it.

### 1.3 Update `a2p-assign-number/index.ts`

- Remove the `not_implemented` / manual-SQL interim path from the header comment and the code.
- On `ASSIGNED` → set `phone_numbers.a2p_campaign_id`, return ok.
- On `PENDING_ASSIGNMENT` → **do not** set `a2p_campaign_id` yet. Write the pending state and let the poller confirm it.
- On `FAILED_ASSIGNMENT` → store `failureReasons`, return a 502 with the reason surfaced to the UI.
- Make it idempotent: re-calling for an already-assigned number returns ok without a second Telnyx call (the existing early-return does this — keep it).

### 1.4 Confirm assignment in `a2p-status-poll`

Extend the cron poller: for every `phone_numbers` row with a campaign but no confirmed assignment, call `listCampaignNumbers` and flip to assigned when Telnyx reports `ASSIGNED`.

Add to the UI copy: carrier propagation takes **24–72 hours** after assignment before delivery is fully reliable. Don't let the agent think a failed test send at hour 2 means it's broken.

### 1.5 Auto-assign on purchase

When an agent buys a number and their campaign is already approved, assign it automatically. The agent should never have to find an "assign number" button.

### Phase 1 acceptance

- [ ] An approved agent's number reaches `assignmentStatus: ASSIGNED` via the API, with no manual SQL anywhere
- [ ] `messaging-send-sms` delivers a real text end-to-end to a real handset
- [ ] A number bought after approval self-assigns
- [ ] Failure reasons are visible in the UI, not just in logs

---

## Phase 2 — Sole Proprietor brand type

Reference: Telnyx sole-prop flow is brand → OTP to the agent's mobile → verify → campaign.

### 2.1 Constraints that must be enforced in code

Sole Proprietor is **not** just "standard brand without an EIN." Hard limits:

- **One campaign per brand**
- **One phone number per campaign** ← this is the big one
- Max **3 sole-prop brands per mobile number**
- ~**1,000 messages/day** throughput
- Requires a **website or social URL** (see Phase 2.5)
- Fees: **$4 brand + $15 campaign + $2/mo** — note the monthly is $2, not the $10 currently defaulted in `billing_config.a2p_monthly_fee_mills`

**The one-number limit changes the product.** A sole-prop agent can own several numbers for voice but only one can send SMS. The UI must show which number is the texting number, and number purchase must not imply texting capability it can't deliver. Add `phone_numbers.sms_capable` (bool) derived from assignment state and gate the SMS composer on it.

### 2.2 Adapter: new functions

```ts
export async function submitSoleProprietorBrand(apiKey, info: SoleProprietorInfo)
// POST /10dlc/brand  — no EIN; entityType SOLE_PROPRIETOR
// fields: firstName, lastName, displayName, email, phone, mobilePhone,
//         street, city, state, postalCode, country, vertical, website

export async function requestBrandOtp(apiKey, brandId)
// POST /10dlc/brand/{id}/smsOtp

export async function getBrandOtpStatus(apiKey, brandId)
// GET /10dlc/brand/{id}/smsOtp

export async function verifyBrandOtp(apiKey, brandId, pin)
// PUT /10dlc/brand/{id}/smsOtp
```

Campaign submission uses `usecase: "SOLE_PROPRIETOR"` (not `LOW_VOLUME`), two sample messages, and a flow description.

**OTP expiry:** the PIN must be verified within **24 hours** of delivery or the whole brand submission restarts. Build for that — see 2.4.

### 2.3 Branch `a2p-register`

Add `brand_type: "standard" | "sole_proprietor"` to the request body.

- `standard` → existing path, EIN required
- `sole_proprietor` → EIN must be **absent**; require `firstName`, `lastName`, `mobilePhone`, `website`; submit brand, request OTP, store status `awaiting_otp`, **do not submit the campaign yet**
- Reject any request that sends both an EIN and `sole_proprietor`

**Billing change:** for sole prop, do not debit the campaign fee at brand time. Debit $4 at brand submission and $15 only when the campaign is actually submitted post-OTP. An agent who never enters their PIN should not be charged $19 for nothing.

### 2.4 New function: `a2p-verify-otp`

- Auth'd, takes `{ pin }`
- Calls `verifyBrandOtp`
- On success: brand → `VERIFIED`, then immediately submit the campaign, debit the $15, set status `pending`
- On failure: return attempts-remaining if Telnyx exposes it; otherwise a clear retry message
- Add a `resend` action that re-calls `requestBrandOtp` and resets the 24h clock
- Store `otp_requested_at` so the UI can show a countdown and auto-offer resend after expiry

### 2.5 Website requirement

Sole prop registration needs a website or social URL proving the business is real. Many agents have neither. Two options — implement (a) now, plan for (b):

**(a) Short term:** accept a Facebook/Instagram/LinkedIn business URL and validate the format.
**(b) Real fix:** the per-agent compliance website from the gap analysis (checklist item #2). Auto-generate a hosted page at `producerstack.com/a/<agent-slug>` with the agent's name, agency, contact info, privacy policy, terms, and SMS opt-in disclosure. That URL then satisfies both this requirement and the TCR compliance-website stage for standard brands. Leave a `TODO(PROMPT_16)` marker where the generated URL will slot in.

### Phase 2 acceptance

- [ ] An agent with no EIN completes registration end-to-end
- [ ] OTP is received, entered, verified; campaign auto-submits on success
- [ ] Expired OTP is detected and resend works
- [ ] Only $4 is charged if the agent abandons before OTP
- [ ] SMS composer is disabled on numbers that aren't the assigned texting number
- [ ] The 1-number-per-campaign limit is enforced, with an explanatory message rather than a raw API error

---

## Phase 3 — Schema

New migration `supabase/migrations/20260728_a2p_sole_proprietor.sql`:

**`a2p_registrations`** — add:
- `brand_type text not null default 'standard'` — check in `('standard','sole_proprietor')`
- `otp_status text` — `('not_sent','sent','verified','expired','failed')`
- `otp_requested_at timestamptz`
- `otp_verified_at timestamptz`
- `assignment_status text`
- `assignment_failure_reason text`
- `tcr_brand_id text`, `tcr_campaign_id text`
- `website_url text`
- `max_numbers int` — 1 for sole prop, 49 for standard

Widen the `status` check constraint to include `awaiting_otp`.

**`phone_numbers`** — add:
- `sms_capable boolean not null default false`
- `a2p_assignment_status text`
- `a2p_assigned_at timestamptz`

**`billing_config`** — add `a2p_sole_prop_monthly_fee_mills int default 2000`, and audit whether `a2p_monthly_fee_mills = 10000` is correct for standard brands or was a placeholder.

RLS: agents read their own rows only; only the service role writes. Match the existing pattern in `20260709b_wallet_foundation.sql`.

---

## Phase 4 — Register automatically at signup

Today A2P is a settings page the agent has to discover. It should fire on its own.

- Extend the signup wizard to collect what registration needs: legal first/last name, mobile, physical address, and either EIN + entity type or the sole-prop declaration. Most of this is already collected — reuse it, don't re-ask.
- Add a branch point: *"Do you have an EIN for your business?"* → Yes = standard, No = sole proprietor. Plain language, no jargon, one sentence explaining that either works.
- On wizard completion, call `a2p-register` in the background. The agent lands on the dashboard with registration already submitted.
- For sole prop, surface the OTP entry as the next activation step — it's the only thing that genuinely requires them.
- Never block dashboard access on A2P. Voice, quoting, tracker, and the dialer all keep working while SMS pends.

---

## Phase 5 — Status wizard UI

In `app.html`, under `nav('settings')`, build a Trust Center–style panel driven by `a2p_registrations`.

Stages with status chips (mirror the shape Orion uses — it reads well):

`Brand type → Business info → Website → Brand submitted → OTP verified (sole prop only) → Campaign submitted → Carrier approved → Number assigned`

Requirements:

- Each stage shows pending / in-progress / complete / failed
- Failed stages show the actual rejection reason and a Retry action
- Show realistic timing inline: brand verification 24–48h, campaign approval 3–7 business days, carrier propagation 24–72h after assignment
- OTP entry inline with a countdown to the 24h expiry and a Resend button
- Show the assigned texting number, and for sole prop explain plainly why it's only one
- A "Refresh status" button that force-runs the poll for this agent
- Do **not** copy Orion's "$20 to skip the queue" upsell — decide that separately

---

## Fee reconciliation (do this while you're in here)

`a2p-register` currently debits `brand_fee_mills + campaign_fee_mills` up front, defaulting to $4 + $15, with `monthly_fee_mills` defaulting to $10/mo. Verify against real Telnyx invoices:

- Standard brand: confirm actual brand, campaign, and monthly amounts
- Sole prop: $4 + $15 + $2/mo per Telnyx's published pricing
- The monthly fee is stored but **never charged anywhere** — find out whether that's intentional. Right now it looks like you're absorbing the recurring campaign cost on every agent.

---

## Do not do

- Do not create a shared brand or reuse a campaign across agents
- Do not remove the fail-closed behavior in `_shared/messaging-shared.ts` — no sends before approval, ever
- Do not guess Telnyx field names. If a shape can't be confirmed, fail closed and comment it, same as the current adapter does. That convention was right; it just needs finishing.
- Do not charge the campaign fee before the campaign is actually submitted
- Do not let number purchase imply SMS capability that assignment hasn't granted

---

## Test plan

1. **Standard, happy path** — EIN agent registers, brand + campaign approve, number assigns, real SMS delivers
2. **Sole prop, happy path** — no-EIN agent registers, OTP arrives, verifies, campaign submits and approves, single number assigns, SMS delivers
3. **OTP expiry** — wait past 24h, confirm expired state and successful resend
4. **Abandoned registration** — start sole prop, never enter PIN; confirm only $4 debited
5. **Assignment failure** — force a failure (unapproved campaign), confirm the reason surfaces in the UI and `a2p_campaign_id` stays null
6. **Second number, sole prop** — confirm the 1-number cap is enforced with a readable message
7. **Compliance gate** — confirm a pending agent still cannot send, via API and via UI
8. **Idempotency** — call `a2p-assign-number` twice; confirm one Telnyx call

---

## Sources

- Telnyx — [ISVs and 10DLC](https://support.telnyx.com/en/articles/5593977-independent-service-vendors-isvs-and-10dlc) (separate brand per end user; no number sharing)
- Telnyx — [ISV/reseller onboarding](https://developers.telnyx.com/docs/messaging/10dlc/isv-reseller-onboarding)
- Telnyx — [Create new phone number campaign](https://developers.telnyx.com/api-reference/phone-number-campaigns/create-new-phone-number-campaign)
- Telnyx — [Phone number assignment](https://developers.telnyx.com/docs/messaging/10dlc/phone-number-assignment)
- Telnyx — [Sole Proprietor registration guide](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration)
- Telnyx — [Sole Proprietor API flow](https://developers.telnyx.com/docs/messaging/10dlc/sole-proprietor/index)
- Telnyx — [10DLC shared campaigns](https://support.telnyx.com/en/articles/5617538-10dlc-shared-campaigns)
