// ============================================================
// ADAPTER — VERIFY AGAINST CURRENT TELNYX 10DLC API DOCS BEFORE GO-LIVE.
// (Cowork hand-off, file 05 §2.)
//
// Every endpoint path, field name, and status-value string below is a
// best-effort reconstruction of Telnyx's 10DLC brand/campaign registration
// API — this build could not verify them against Telnyx's current docs.
// Everything that calls into this adapter (a2p-register, a2p-status-poll)
// is written against the return shape of the four functions below, NOT
// against Telnyx's raw response — so if the real field names differ, only
// this file needs to change.
//
// Known areas most likely to have drifted:
//   - Exact path (v2/10dlc/... vs a dedicated 10DLC subdomain/prefix).
//   - Required vs optional brand fields (EIN format, entityType enum
//     values, altBusinessId requirements for non-US entities).
//   - Campaign `usecase` enum values (CTIA/carrier-defined, changes
//     periodically) — confirm "LOW_VOLUME" / "MIXED" / whichever use case
//     best fits a life-insurance agent's outbound texting before submitting
//     for real, since the wrong usecase can cause campaign rejection.
//   - Status field names/values on the GET endpoints (identityStatus vs
//     brandStatus, campaignStatus values).
//   - Whether fee amounts are returned synchronously on submit or only
//     appear later on the Telnyx invoice/balance API.
// ============================================================

const TELNYX_BASE = "https://api.telnyx.com/v2/10dlc";

function telnyxHeaders(apiKey: string) {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type":  "application/json",
  };
}

export interface BusinessInfo {
  displayName: string;
  companyName: string;
  ein: string;
  entityType: "PRIVATE_PROFIT" | "PUBLIC_PROFIT" | "NON_PROFIT" | "GOVERNMENT" | "SOLE_PROPRIETOR";
  vertical: string; // e.g. "INSURANCE"
  email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2, e.g. "US"
  website?: string;
}

export interface BrandSubmitResult {
  ok: boolean;
  brandId?: string;
  feeMills?: number;
  error?: string;
}

// PHASE 2 — NOT verified end-to-end yet; DO NOT rely on submitBrand /
// submitCampaign as-is. What the 2026-07-27 live probing DID establish:
//   • /v2/10dlc/* returns BARE objects, so the `data?.data?.<field>` reads
//     below (brandId/campaignId) are WRONG — they must read the bare object,
//     e.g. (data?.data ?? data)?.brandId. (getBrandStatus/getCampaignStatus
//     were fixed for exactly this; these two still need it.)
//   • Campaign creation is NOT POST /v2/10dlc/campaign — that path is for
//     other ops. The real create is POST /v2/10dlc/campaignBuilder, and it
//     needs messageFlow + opt-in/opt-out/help keyword+message fields, not
//     just sample1/sample2 (confirmed by creating a real mock campaign).
//   • Brand create likely has no synchronous fee on the response; brand
//     review status is `identityStatus` (VERIFIED). Fee shows on billedDate.
// Fixing these is Phase 2 work (a2p-register) — left as-is here so this
// change set stays scoped to the Phase 1 assignment path.
export async function submitBrand(apiKey: string, info: BusinessInfo): Promise<BrandSubmitResult> {
  const res = await fetch(`${TELNYX_BASE}/brand`, {
    method: "POST",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({
      displayName:  info.displayName,
      companyName:  info.companyName,
      ein:          info.ein,
      entityType:   info.entityType,
      vertical:     info.vertical,
      email:        info.email,
      phone:        info.phone,
      street:       info.street,
      city:         info.city,
      state:        info.state,
      postalCode:   info.postalCode,
      country:      info.country,
      website:      info.website,
    }),
  });

  if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };

  const data = await res.json();
  const brandId = data?.data?.brandId ?? data?.data?.id;
  const feeMillsRaw = data?.data?.price ?? data?.data?.fee; // dollars, likely — confirm units
  const feeMills = typeof feeMillsRaw === "number" ? Math.round(feeMillsRaw * 1000) : undefined;
  return { ok: true, brandId, feeMills };
}

export interface CampaignInfo {
  brandId: string;
  usecase: string; // e.g. "LOW_VOLUME" or "MIXED" — CONFIRM before go-live
  description: string;
  sampleMessages: string[];
  subscriberOptin: boolean;
  subscriberOptout: boolean;
  subscriberHelp: boolean;
  embeddedLink: boolean;
  embeddedPhone: boolean;
  ageGated: boolean;
  directLending: boolean;
}

// ------------------------------------------------------------
// CAMPAIGN FIELD NAMES — PROBED AGAINST LIVE TELNYX 2026-07-28.
//
// Method: campaignBuilder SILENTLY IGNORES unknown fields (confirmed with a
// deliberately bogus field name), but type-checks fields it knows. So each
// candidate was sent with a wrong-typed value; if the validator named it in
// an error, the field is real. Every probe carried an invalid `usecase`, so
// nothing was ever created.
//
// REAL (validator type-checked them):
//   termsAndConditions, subscriberOptin, subscriberOptout, subscriberHelp,
//   embeddedLink, embeddedPhone, ageGated, directLending, numberPool,
//   autoRenewal            -> booleans
//   helpMessage, optinMessage, optoutMessage, sample1, sample2,
//   description, messageFlow -> strings
//   webhookURL, webhookFailoverURL -> URLs ("Invalid URL" when malformed)
//
// NOT REAL — silently dropped, every spelling tried:
//   privacyPolicyLink, termsAndConditionsLink, privacyPolicyURL,
//   termsAndConditionsURL, privacyPolicy, privacyPolicyUrl,
//   termsAndConditionsUrl, affiliateMarketing, optinKeywords,
//   optoutKeywords, helpKeywords, resellerId, subUsecases, tag, vertical
//
// THE CAMPAIGN HAS NO COMPLIANCE-LINK FIELD. An earlier revision of this file
// sent privacyPolicyLink/termsAndConditionsLink; Telnyx accepted the request
// and threw them away, so the compliance URLs would never have reached the
// carrier. They are now carried two ways that ARE verified to land:
//   1. brand.website — probed real ("Invalid URL"); a2p-register sets it to
//      the agent's privacy policy URL.
//   2. the opt-in workflow text (messageFlow / description) — free text the
//      reviewer actually reads; buildOptinDescription() appends both URLs.
//
// `termsAndConditions` is real but it is a BOOLEAN attestation, not a link —
// do not mistake it for somewhere to put a URL.
//
// STILL BROKEN, PRE-EXISTING (PROMPT_15 Phase 2, not fixed here): this
// function posts to /campaign, but the real create is /campaignBuilder, and
// `messageFlow` is REQUIRED — the probe returned "Missing required parameter"
// for brandId, usecase, description, and messageFlow. As written,
// submitCampaign cannot succeed. Fixing that is Phase 2 work.
// ------------------------------------------------------------

export interface CampaignSubmitResult {
  ok: boolean;
  campaignId?: string;
  feeMills?: number;
  monthlyFeeMills?: number;
  error?: string;
}

export async function submitCampaign(apiKey: string, info: CampaignInfo): Promise<CampaignSubmitResult> {
  const res = await fetch(`${TELNYX_BASE}/campaign`, {
    method: "POST",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({
      brandId:          info.brandId,
      usecase:          info.usecase,
      description:      info.description,
      sample1:          info.sampleMessages[0],
      sample2:          info.sampleMessages[1],
      subscriberOptin:  info.subscriberOptin,
      subscriberOptout: info.subscriberOptout,
      subscriberHelp:   info.subscriberHelp,
      embeddedLink:     info.embeddedLink,
      embeddedPhone:    info.embeddedPhone,
      ageGated:         info.ageGated,
      directLending:    info.directLending,
    }),
  });

  if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };

  const data = await res.json();
  const campaignId = data?.data?.campaignId ?? data?.data?.id;
  const feeRaw = data?.data?.price ?? data?.data?.fee;
  const monthlyFeeRaw = data?.data?.monthlyFee;
  return {
    ok: true,
    campaignId,
    feeMills: typeof feeRaw === "number" ? Math.round(feeRaw * 1000) : undefined,
    monthlyFeeMills: typeof monthlyFeeRaw === "number" ? Math.round(monthlyFeeRaw * 1000) : undefined,
  };
}

export type RegistrationStatus = "pending" | "approved" | "rejected" | "suspended" | "expired";

// VERIFIED against live Telnyx 2026-07-27 using the real Frenkel Financial
// (VERIFIED) + ProducerStack Sandbox (mock) brands and a mock campaign:
//   • brand.identityStatus observed: "VERIFIED" (there's also a secondary
//     brand.status="OK" which is NOT a review status — do NOT key off it).
//   • campaign.campaignStatus observed: "TCR_PENDING" (just created) then
//     "TCR_FAILED" (mock brand fails TCR vetting). Approved campaigns read
//     "TCR_ACCEPTED"/"ACTIVE".
// TCR_FAILED is now in the rejected set (it was missing — a failed campaign
// would otherwise have normalized to "pending" forever). SUSPENDED/EXPIRED
// strings are still inferred (no live approved-then-revoked campaign to
// observe); left as best-effort, and the gate stays fail-closed either way.
function normalizeStatus(rawStatus: string | undefined): RegistrationStatus {
  const s = (rawStatus || "").toUpperCase();
  if (["VERIFIED", "REGISTERED", "TCR_ACCEPTED", "APPROVED", "ACTIVE"].includes(s)) return "approved";
  if (["FAILED", "REJECTED", "TCR_REJECTED", "TCR_FAILED", "DELETED"].includes(s)) return "rejected";
  if (["SUSPENDED", "TCR_SUSPENDED"].includes(s)) return "suspended";
  if (["EXPIRED", "TCR_EXPIRED"].includes(s)) return "expired";
  return "pending";
}

// Brand/campaign GETs hit /v2/10dlc/*, which returns a BARE object (no
// {data} envelope) — VERIFIED 2026-07-27. We still read (data?.data ?? data)
// so a future wrapper wouldn't silently break this. (The earlier
// data?.data?.<field> parse read undefined on the real shape, which would
// have kept every brand/campaign stuck at "pending" — the poller could never
// mark a registration approved, and no number could ever be assigned.)
export async function getBrandStatus(apiKey: string, brandId: string): Promise<{ status: RegistrationStatus; raw?: string; error?: string }> {
  const res = await fetch(`${TELNYX_BASE}/brand/${brandId}`, { headers: telnyxHeaders(apiKey) });
  if (!res.ok) return { status: "pending", error: `${res.status}: ${await res.text()}` };
  const data = await res.json();
  const d = (data?.data ?? data) as { identityStatus?: string; brandStatus?: string } | undefined;
  const raw = d?.identityStatus ?? d?.brandStatus;
  return { status: normalizeStatus(raw), raw };
}

export async function getCampaignStatus(apiKey: string, campaignId: string): Promise<{ status: RegistrationStatus; raw?: string; error?: string }> {
  const res = await fetch(`${TELNYX_BASE}/campaign/${campaignId}`, { headers: telnyxHeaders(apiKey) });
  if (!res.ok) return { status: "pending", error: `${res.status}: ${await res.text()}` };
  const data = await res.json();
  const d = (data?.data ?? data) as { campaignStatus?: string } | undefined;
  const raw = d?.campaignStatus;
  return { status: normalizeStatus(raw), raw };
}

export type AssignmentStatus =
  | "PENDING_ASSIGNMENT" | "ASSIGNED" | "FAILED_ASSIGNMENT"
  | "PENDING_UNASSIGNMENT" | "FAILED_UNASSIGNMENT";

export interface AssignNumberResult {
  ok: boolean;                       // true = the Telnyx call itself succeeded (HTTP + preconditions); read assignmentStatus for the outcome
  assignmentStatus?: AssignmentStatus;
  failureReasons?: string;
  error?: string;                    // set only when ok:false (precondition failure or HTTP error)
}

// Resolve a Telnyx phone-number resource id from its E.164 and read the
// messaging_profile_id it's attached to.
//
// VERIFIED against the live API 2026-07-27: the BASE phone-number object
// (GET /v2/phone_numbers?filter[phone_number]=...) already carries
// `messaging_profile_id` (null/"" when unattached) alongside `id` and
// `messaging_campaign_id` — so this is one call, not two. (An earlier build
// wrongly assumed messaging_profile_id lived only on the /messaging
// sub-resource.) /v2/phone_numbers/* uses the standard {data:[...]} wrapper.
async function getNumberMessaging(
  apiKey: string,
  e164: string,
): Promise<{ id: string; messagingProfileId: string | null } | null> {
  const listParams = new URLSearchParams({ "filter[phone_number]": e164 });
  const listRes = await fetch(`https://api.telnyx.com/v2/phone_numbers?${listParams}`, {
    headers: telnyxHeaders(apiKey),
  });
  if (!listRes.ok) return null;
  const listData = await listRes.json();
  const rec = (listData?.data as Array<{ id?: string; messaging_profile_id?: string | null }> | undefined)?.[0];
  if (!rec?.id) return null;
  const mpid = rec.messaging_profile_id;
  return { id: rec.id, messagingProfileId: typeof mpid === "string" && mpid ? mpid : null };
}

// Attach a number to the account's Messaging Profile if it isn't already.
// Idempotent — a no-op when the number already carries messagingProfileId.
// Number->campaign assignment FAILS unless the number is on a messaging
// profile first, so telnyx-buy-number / telnyx-provision-number call this at
// purchase and the assignment helper calls it again as a self-heal for
// legacy numbers bought before that change.
//
// VERIFIED 2026-07-27: PATCH /v2/phone_numbers/{id}/messaging with body
// { messaging_profile_id } returns 200 (tested idempotently by writing a
// number's current value back). Field name + endpoint confirmed correct.
export async function ensureNumberOnMessagingProfile(
  apiKey: string,
  e164: string,
  messagingProfileId: string,
): Promise<{ ok: boolean; error?: string }> {
  const info = await getNumberMessaging(apiKey, e164);
  if (!info) return { ok: false, error: `number_not_found_at_telnyx: ${e164}` };
  if (info.messagingProfileId === messagingProfileId) return { ok: true };

  const res = await fetch(`https://api.telnyx.com/v2/phone_numbers/${info.id}/messaging`, {
    method: "PATCH",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({ messaging_profile_id: messagingProfileId }),
  });
  if (!res.ok) return { ok: false, error: `messaging_profile_attach_failed: ${res.status}: ${await res.text()}` };
  return { ok: true };
}

// Attach one owned number to a 10DLC campaign. Real implementation of the
// former fail-closed stub. Callers depend on THIS return shape (ok +
// assignmentStatus + failureReasons), never Telnyx's raw JSON.
//
// VERIFIED against the live API 2026-07-27:
//   • Route is POST /v2/10dlc/phone_number_campaigns with a JSON body of
//     { phoneNumber, campaignId } — confirmed by a probe POST that Telnyx
//     accepted the fields on (it 404'd only because the probe number
//     wasn't on the account). The camelCase alias /phoneNumberCampaign also
//     resolves, but the snake form is the API-reference canonical, so there
//     is NO endpoint fallback here anymore. (The old 404 fallback was a bug:
//     a legitimate "phone number not found" is ALSO a 404, so it would have
//     retried the wrong route on a real per-number error.)
//   • /10dlc/* returns BARE objects (no {data} envelope); we still read
//     (data?.data ?? data) so a future wrapper wouldn't break us.
//
// Campaign carrier-approval is NOT re-checked here: the only caller path
// (_shared/a2p-assign.ts) already gates on a2p_registrations.status ===
// 'approved' (which the poller derives from Telnyx), and Telnyx's own POST
// validation rejects an unapproved campaign as a backstop. Re-fetching
// campaign status here would be redundant AND depends on a response shape we
// can't confirm until a real campaign exists (this account has none) — so it
// was removed rather than left as an unverifiable gate that could wrongly
// block a genuinely-approved campaign.
//
// Preconditions kept (both verified shapes), each with a specific error:
//   (1) number in E.164;  (2) number attached to a Messaging Profile.
export async function assignNumberToCampaign(
  apiKey: string,
  campaignId: string,
  e164: string,
): Promise<AssignNumberResult> {
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) {
    return { ok: false, error: `number_not_e164: "${e164}" is not a valid E.164 number.` };
  }

  const msg = await getNumberMessaging(apiKey, e164);
  if (!msg) return { ok: false, error: `number_not_found_at_telnyx: ${e164}` };
  if (!msg.messagingProfileId) {
    return {
      ok: false,
      error: `number_not_on_messaging_profile: ${e164} must be attached to a Telnyx Messaging Profile before campaign assignment.`,
    };
  }

  const res = await fetch(`${TELNYX_BASE}/phone_number_campaigns`, {
    method: "POST",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({ phoneNumber: e164, campaignId }),
  });
  if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };

  const data = await res.json();
  const d = (data?.data ?? data) as { assignmentStatus?: AssignmentStatus; failureReasons?: string } | undefined;
  return {
    ok: true,
    assignmentStatus: d?.assignmentStatus,
    failureReasons: typeof d?.failureReasons === "string" ? d.failureReasons : undefined,
  };
}

export interface NumberAssignmentStatus {
  ok: boolean;                 // false = a real API/read error (not "unassigned")
  found: boolean;              // true = Telnyx has a phone_number_campaign record for this number
  assignmentStatus?: AssignmentStatus;
  failureReasons?: string;
  error?: string;
}

// Status-check helper for a2p-status-poll: fetch ONE number's campaign
// assignment straight from Telnyx.
//
// VERIFIED 2026-07-27: GET /v2/10dlc/phone_number_campaigns/{e164} returns
// the single assignment (bare object) when it exists, or 404 "Phone Number
// Campaign does not exist on account" when the number isn't (yet) assigned.
// This is why we DON'T list-and-filter: the /10dlc list envelope is
// {records:[...]} (not {data}) and its filter[campaignId] couldn't be
// confirmed to actually filter (0 records on this account), whereas the
// per-number GET is exact and confirmed. The 200 body field names
// (assignmentStatus / failureReasons) are inferred from Telnyx's 10DLC
// camelCase convention — no live assignment exists yet to confirm them, so
// we also accept snake_case defensively.
export async function getNumberAssignmentStatus(
  apiKey: string,
  e164: string,
): Promise<NumberAssignmentStatus> {
  const res = await fetch(`${TELNYX_BASE}/phone_number_campaigns/${encodeURIComponent(e164)}`, {
    headers: telnyxHeaders(apiKey),
  });
  if (res.status === 404) return { ok: true, found: false };
  if (!res.ok) return { ok: false, found: false, error: `${res.status}: ${await res.text()}` };

  const data = await res.json();
  const d = (data?.data ?? data) as {
    assignmentStatus?: AssignmentStatus;
    assignment_status?: AssignmentStatus;
    failureReasons?: string;
    failure_reasons?: string;
  } | undefined;
  return {
    ok: true,
    found: true,
    assignmentStatus: d?.assignmentStatus ?? d?.assignment_status,
    failureReasons: d?.failureReasons ?? d?.failure_reasons,
  };
}
