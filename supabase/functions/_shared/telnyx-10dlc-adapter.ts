// ============================================================
// TELNYX 10DLC ADAPTER
//
// Callers (a2p-register, a2p-verify-otp, a2p-status-poll, _shared/a2p-assign)
// depend on THIS FILE'S return shapes, never on Telnyx's raw JSON. If Telnyx
// changes a field name, only this file changes.
//
// ---- VERIFIED FACTS (live probing 2026-07-27/28; docs/telnyx-10dlc-brands.md)
//
//   • /v2/10dlc/* returns BARE OBJECTS — no {data:…} envelope. (Lists use
//     {records:[…]}.) /v2/phone_numbers/* DOES use the standard {data}
//     wrapper. Mixing these up is what produced the 2026-07-28 orphan brand,
//     so every read below goes through unwrap() rather than hand-rolling it.
//   • Brand review status is `identityStatus` (VERIFIED). There is a
//     secondary `status`="OK" which is NOT a review status — never key off it.
//   • Campaign status is `campaignStatus` (TCR_PENDING / TCR_FAILED /
//     TCR_ACCEPTED / ACTIVE).
//   • Campaign creation is POST /v2/10dlc/campaignBuilder — NOT /campaign.
//     `messageFlow` is REQUIRED (the probe returned "Missing required
//     parameter" for brandId, usecase, description AND messageFlow).
//   • campaignBuilder SILENTLY DISCARDS unknown fields — verified with a
//     deliberately bogus field name. So sending a field Telnyx does not know
//     is not an error, it is a NO-OP THAT LOOKS LIKE SUCCESS. Everything sent
//     from here is therefore filtered through CAMPAIGN_BUILDER_FIELDS below.
//   • Brand create returns no synchronous fee; the charge appears later on
//     `billedDate`. Fee amounts come from billing_config, not the response.
//
// ---- CONFIRMED 2026-07-28 BY CREATING A REAL MOCK CAMPAIGN
//
// scripts/a2p-phase2-smoke.ts created campaign 4b30019f-a751-7137-49de-
// f9834598ee05 on the sandbox brand, which settled every open question that
// only a live create could answer:
//   • POST /v2/10dlc/campaignBuilder returns the campaign with `campaignId`
//     on the BARE object. This is the exact parse the withdrawn code got
//     wrong; it now round-trips.
//   • `billedDate: null` and `mock: true` — a sandbox campaign really is
//     free, so the smoke test costs nothing to re-run.
//   • messageFlow, description, sample1-3, optinMessage, optoutMessage,
//     helpMessage, termsAndConditions, embeddedPhone and numberPool all
//     PERSIST and read back unchanged.
//   • privacyPolicyLink / termsAndConditionsLink read back as null on the
//     GET — they exist as response keys but cannot be set. Third
//     independent confirmation that the campaign has no link field.
//
// VALID `usecase` VALUES (the full enum, from Telnyx's own 10032 error —
// this was previously an unverified guess flagged "confirm before go-live"):
//   ACCOUNT_NOTIFICATION, AGENTS_FRANCHISES, CARRIER_EXEMPT, CHARITY,
//   CONVERSATIONAL, CUSTOMER_CARE, DELIVERY_NOTIFICATION, EMERGENCY,
//   FRAUD_ALERT, HIGHER_EDUCATION, K12_EDUCATION, LOW_VOLUME, MARKETING,
//   MIXED, POLITICAL, POLLING_VOTING, PROXY, PUBLIC_SAFETY_RESTRICTED,
//   PUBLIC_SERVICE_ANNOUNCEMENT, SECURITY_ALERT, SOCIAL, SWEEPSTAKE, 2FA,
//   UCAAS_LOW, M2M, SOLE_PROPRIETOR, TRIAL, UCAAS_HIGH
// Both values we rely on — LOW_VOLUME (standard) and SOLE_PROPRIETOR — are
// in the list and LOW_VOLUME was accepted on a real create.
//
// ---- CAMPAIGN FIELD NAMES — PROBED AGAINST LIVE TELNYX 2026-07-28
//
// Method: each candidate was sent with a WRONG-TYPED value. If the validator
// named it in an error, the field is real; if the request was accepted and
// the field vanished, it is not. Every probe also carried an invalid
// `usecase`, so nothing was ever created and nothing was ever billed.
//
// REAL (validator type-checked them):
//   termsAndConditions, subscriberOptin, subscriberOptout, subscriberHelp,
//   embeddedLink, embeddedPhone, ageGated, directLending, numberPool,
//   autoRenewal              -> booleans
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
// THE CAMPAIGN HAS NO COMPLIANCE-LINK FIELD. `termsAndConditions` is real but
// it is a BOOLEAN ATTESTATION, not a link — do not put a URL in it. The
// compliance URLs reach the reviewer by the two routes that ARE verified:
//   1. brand.website (probed real — errors "Invalid URL" on a bad value)
//   2. the free-text messageFlow / description, which the reviewer reads
// See docs/compliance-pages.md § "How the URLs actually reach the carrier".
// ============================================================

const TELNYX_BASE = "https://api.telnyx.com/v2/10dlc";

function telnyxHeaders(apiKey: string) {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type":  "application/json",
  };
}

/**
 * Read a /10dlc response body.
 *
 * /10dlc/* returns BARE objects (verified 2026-07-27). We still tolerate a
 * {data:…} envelope so a future Telnyx change to the standard v2 shape
 * degrades to "still works" instead of "silently reads undefined" — the exact
 * failure that created a paid-for orphan brand on 2026-07-28.
 */
// deno-lint-ignore no-explicit-any
function unwrap(body: any): Record<string, unknown> {
  if (body && typeof body === "object" && body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
    return body.data as Record<string, unknown>;
  }
  return (body ?? {}) as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Compact an error body to something loggable and safe to show an agent. */
async function errText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  return `${res.status}: ${raw.slice(0, 800)}`;
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

/**
 * Sole Proprietor brand — a 1099 producer with NO EIN.
 *
 * This is a first-class registration path, not a degraded one: most of our
 * agents are producers, not entities, and the old code hard-required an EIN
 * so they simply could not register at all.
 *
 * Telnyx's sole-prop flow is brand -> SMS OTP to the agent's personal mobile
 * -> verify -> campaign. The mobile is the identity proof that replaces the
 * EIN, which is why `mobilePhone` is required and why Telnyx caps how many
 * sole-prop brands one mobile number can back.
 */
export interface SoleProprietorInfo {
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  /** Business/contact phone, E.164. */
  phone: string;
  /** The agent's personal mobile, E.164 — this is where the PIN is delivered. */
  mobilePhone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  vertical: string;
  /** Required for sole prop. We always pass the generated compliance page. */
  website: string;
}

export interface BrandSubmitResult {
  ok: boolean;
  brandId?: string;
  tcrBrandId?: string;
  /** identityStatus as returned on create, when present. */
  identityStatus?: string;
  /** true when Telnyx reports this as a mock (sandbox) brand — no fee. */
  mock?: boolean;
  error?: string;
}

/**
 * Read a brand-create response.
 *
 * THE SINGLE MOST IMPORTANT PARSE IN THIS FILE. POST /10dlc/brand creates a
 * REAL, BILLABLE brand at Telnyx. If we fail to extract the id, the brand
 * exists and is charged for and we have no pointer to it — that is the
 * 2026-07-28 orphan-brand incident, caused by reading `data.data.brandId`
 * against a bare object.
 *
 * Hence: unwrap(), then try every id spelling Telnyx uses across its 10DLC
 * surface, and treat "created but unreadable" as a hard, loud failure so the
 * caller can log the raw body for manual recovery rather than silently
 * dropping it.
 */
// deno-lint-ignore no-explicit-any
function readBrandCreate(body: any): BrandSubmitResult {
  const d = unwrap(body);
  const brandId = str(d.brandId) ?? str(d.id) ?? str(d.brand_id);
  if (!brandId) {
    return {
      ok: false,
      error: `brand_created_but_id_unreadable: Telnyx accepted the brand but no id could be read from the response. ` +
        `A BILLABLE BRAND MAY NOW EXIST — recover it from the Telnyx portal or GET /v2/10dlc/brand before retrying. Raw: ${JSON.stringify(body).slice(0, 800)}`,
    };
  }
  return {
    ok: true,
    brandId,
    tcrBrandId: str(d.tcrBrandId),
    identityStatus: str(d.identityStatus),
    mock: d.mock === true,
  };
}

/**
 * Standard (EIN-backed) brand. POST /v2/10dlc/brand.
 *
 * `website` is deliberately load-bearing: it is the only VERIFIED field that
 * carries the agent's compliance URL to the carrier reviewer, since the
 * campaign has no link field at all.
 */
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

  if (!res.ok) return { ok: false, error: await errText(res) };
  return readBrandCreate(await res.json());
}

/**
 * Sole Proprietor brand. POST /v2/10dlc/brand with NO EIN.
 *
 * entityType SOLE_PROPRIETOR + mobilePhone is what tells Telnyx to run the
 * OTP identity flow instead of an EIN lookup. Sending an EIN alongside it is
 * rejected upstream in a2p-register, not here — the adapter's job is the wire
 * format, the policy lives with the caller.
 */
export async function submitSoleProprietorBrand(
  apiKey: string,
  info: SoleProprietorInfo,
): Promise<BrandSubmitResult> {
  const res = await fetch(`${TELNYX_BASE}/brand`, {
    method: "POST",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({
      entityType:   "SOLE_PROPRIETOR",
      displayName:  info.displayName,
      firstName:    info.firstName,
      lastName:     info.lastName,
      email:        info.email,
      phone:        info.phone,
      mobilePhone:  info.mobilePhone,
      street:       info.street,
      city:         info.city,
      state:        info.state,
      postalCode:   info.postalCode,
      country:      info.country,
      vertical:     info.vertical,
      website:      info.website,
      // No `ein` and no `companyName`: a sole proprietor has neither, and
      // sending an empty string is not the same as omitting the field.
    }),
  });

  if (!res.ok) return { ok: false, error: await errText(res) };
  return readBrandCreate(await res.json());
}

// ------------------------------------------------------------
// Sole-proprietor mobile OTP.
//
// The PIN is delivered by SMS to SoleProprietorInfo.mobilePhone and EXPIRES
// 24 HOURS AFTER DELIVERY. If it lapses, the brand submission has to start
// over — so a2p-register stores otp_requested_at and the UI counts down
// against it and offers a resend.
// ------------------------------------------------------------

export interface OtpResult {
  ok: boolean;
  /** Telnyx's own view of the OTP state, when it returns one. */
  status?: string;
  error?: string;
}

/** Ask Telnyx to send (or re-send) the PIN. POST /10dlc/brand/{id}/smsOtp. */
export async function requestBrandOtp(apiKey: string, brandId: string): Promise<OtpResult> {
  const res = await fetch(`${TELNYX_BASE}/brand/${encodeURIComponent(brandId)}/smsOtp`, {
    method: "POST",
    headers: telnyxHeaders(apiKey),
  });
  if (!res.ok) return { ok: false, error: await errText(res) };
  const d = unwrap(await res.json().catch(() => ({})));
  return { ok: true, status: str(d.status) ?? str(d.otpStatus) };
}

/** Read OTP state without sending one. GET /10dlc/brand/{id}/smsOtp. */
export async function getBrandOtpStatus(apiKey: string, brandId: string): Promise<OtpResult> {
  const res = await fetch(`${TELNYX_BASE}/brand/${encodeURIComponent(brandId)}/smsOtp`, {
    headers: telnyxHeaders(apiKey),
  });
  if (!res.ok) return { ok: false, error: await errText(res) };
  const d = unwrap(await res.json().catch(() => ({})));
  return { ok: true, status: str(d.status) ?? str(d.otpStatus) };
}

/**
 * Submit the PIN the agent typed. PUT /10dlc/brand/{id}/smsOtp.
 *
 * A wrong or expired PIN comes back as a 4xx, which we surface as ok:false
 * with Telnyx's own text — the caller decides whether that is "try again" or
 * "the 24h window lapsed, resend". We do NOT guess attempts-remaining:
 * Telnyx does not expose it, so a2p_registrations.otp_attempts is ours.
 */
export async function verifyBrandOtp(apiKey: string, brandId: string, pin: string): Promise<OtpResult> {
  const res = await fetch(`${TELNYX_BASE}/brand/${encodeURIComponent(brandId)}/smsOtp`, {
    method: "PUT",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) return { ok: false, error: await errText(res) };
  const d = unwrap(await res.json().catch(() => ({})));
  return { ok: true, status: str(d.status) ?? str(d.otpStatus) ?? "verified" };
}

export interface CampaignInfo {
  brandId: string;
  /**
   * "SOLE_PROPRIETOR" for sole-prop brands (required — a sole-prop brand
   * cannot carry any other use case), otherwise "LOW_VOLUME".
   */
  usecase: string;
  description: string;
  /**
   * REQUIRED by campaignBuilder. Free-text description of how the consumer
   * opts in. This is one of only two verified routes by which the agent's
   * compliance URLs reach a carrier reviewer, so it is never blank.
   */
  messageFlow: string;
  sampleMessages: string[];
  subscriberOptin: boolean;
  subscriberOptout: boolean;
  subscriberHelp: boolean;
  embeddedLink: boolean;
  embeddedPhone: boolean;
  ageGated: boolean;
  directLending: boolean;
  /** Keyword auto-responses. Real fields (probed); required in practice for approval. */
  optinMessage?: string;
  optoutMessage?: string;
  helpMessage?: string;
  /** Boolean ATTESTATION that terms exist — NOT a link. Never put a URL here. */
  termsAndConditions?: boolean;
  numberPool?: boolean;
  autoRenewal?: boolean;
}

/**
 * The ONLY field names campaignBuilder is verified to accept.
 *
 * This allowlist exists because campaignBuilder's failure mode for an unknown
 * field is SILENCE, not an error: Telnyx returns 200, drops the field, and we
 * would believe we had sent something we never sent. That is exactly how
 * privacyPolicyLink / termsAndConditionsLink shipped as a no-op for weeks.
 *
 * Adding a name here without probing it live re-opens that hole. The probe
 * method is in this file's header — send the candidate with a wrong-typed
 * value and see whether the validator names it.
 */
const CAMPAIGN_BUILDER_FIELDS = new Set([
  "brandId", "usecase", "description", "messageFlow",
  "sample1", "sample2", "sample3", "sample4", "sample5",
  "subscriberOptin", "subscriberOptout", "subscriberHelp",
  "optinMessage", "optoutMessage", "helpMessage",
  "embeddedLink", "embeddedPhone", "ageGated", "directLending",
  "numberPool", "autoRenewal", "termsAndConditions",
  "webhookURL", "webhookFailoverURL",
]);

/** Drop undefined values AND any key not on the verified allowlist. */
function campaignBody(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (!CAMPAIGN_BUILDER_FIELDS.has(k)) {
      // Loud, not silent — the whole point of the allowlist.
      console.error(`[telnyx-10dlc] refusing to send unverified campaignBuilder field "${k}" — Telnyx would discard it silently. See CAMPAIGN_BUILDER_FIELDS.`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export interface CampaignSubmitResult {
  ok: boolean;
  campaignId?: string;
  tcrCampaignId?: string;
  campaignStatus?: string;
  /** true when Telnyx reports a mock campaign (sandbox brand) — not billed. */
  mock?: boolean;
  error?: string;
}

/**
 * Create the campaign. POST /v2/10dlc/campaignBuilder — VERIFIED.
 *
 * NOT /10dlc/campaign: that path serves other operations and cannot create.
 * The previous implementation posted there and could never have succeeded.
 *
 * `messageFlow` is required and is enforced here rather than left to Telnyx,
 * because a missing-required-parameter round trip against a real brand is a
 * wasted call on a path where calls cost money.
 *
 * NO FEE IS READ FROM THE RESPONSE. Telnyx does not return a synchronous
 * price for 10DLC registration (the charge lands later against `billedDate`),
 * so the old `data.data.price` read was always undefined. Fee amounts come
 * from billing_config — see a2p-register.
 */
export async function submitCampaign(apiKey: string, info: CampaignInfo): Promise<CampaignSubmitResult> {
  if (!info.messageFlow || !info.messageFlow.trim()) {
    return { ok: false, error: "message_flow_required: campaignBuilder rejects a campaign with no opt-in workflow description." };
  }
  if (!info.sampleMessages?.[0] || !info.sampleMessages?.[1]) {
    return { ok: false, error: "two_sample_messages_required: campaignBuilder needs at least sample1 and sample2." };
  }

  const res = await fetch(`${TELNYX_BASE}/campaignBuilder`, {
    method: "POST",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify(campaignBody({
      brandId:            info.brandId,
      usecase:            info.usecase,
      description:        info.description,
      messageFlow:        info.messageFlow,
      sample1:            info.sampleMessages[0],
      sample2:            info.sampleMessages[1],
      sample3:            info.sampleMessages[2],
      subscriberOptin:    info.subscriberOptin,
      subscriberOptout:   info.subscriberOptout,
      subscriberHelp:     info.subscriberHelp,
      optinMessage:       info.optinMessage,
      optoutMessage:      info.optoutMessage,
      helpMessage:        info.helpMessage,
      embeddedLink:       info.embeddedLink,
      embeddedPhone:      info.embeddedPhone,
      ageGated:           info.ageGated,
      directLending:      info.directLending,
      numberPool:         info.numberPool,
      autoRenewal:        info.autoRenewal,
      termsAndConditions: info.termsAndConditions,
      // Deliberately absent: privacyPolicyLink / termsAndConditionsLink and
      // every spelling of them. They are not real fields — the compliance
      // URLs ride in messageFlow (above) and on the brand's `website`.
    })),
  });

  if (!res.ok) return { ok: false, error: await errText(res) };

  const d = unwrap(await res.json());
  const campaignId = str(d.campaignId) ?? str(d.id) ?? str(d.campaign_id);
  if (!campaignId) {
    return {
      ok: false,
      error: `campaign_created_but_id_unreadable: Telnyx accepted the campaign but returned no readable id. A BILLABLE CAMPAIGN MAY NOW EXIST — check the Telnyx portal before retrying. Raw: ${JSON.stringify(d).slice(0, 800)}`,
    };
  }
  return {
    ok: true,
    campaignId,
    tcrCampaignId: str(d.tcrCampaignId),
    campaignStatus: str(d.campaignStatus),
    mock: d.mock === true,
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
// {data} envelope) — VERIFIED 2026-07-27. unwrap() still tolerates a wrapper
// so a future Telnyx change degrades to "still works". (The earlier
// data?.data?.<field> parse read undefined on the real shape, which would
// have kept every brand/campaign stuck at "pending" — the poller could never
// mark a registration approved, and no number could ever be assigned.)
export async function getBrandStatus(apiKey: string, brandId: string): Promise<{ status: RegistrationStatus; raw?: string; error?: string }> {
  const res = await fetch(`${TELNYX_BASE}/brand/${encodeURIComponent(brandId)}`, { headers: telnyxHeaders(apiKey) });
  if (!res.ok) return { status: "pending", error: await errText(res) };
  const d = unwrap(await res.json());
  // identityStatus is the review status. The secondary `status`="OK" is NOT
  // one — never fall back to it.
  const raw = str(d.identityStatus) ?? str(d.brandStatus);
  return { status: normalizeStatus(raw), raw };
}

export async function getCampaignStatus(apiKey: string, campaignId: string): Promise<{ status: RegistrationStatus; raw?: string; error?: string }> {
  const res = await fetch(`${TELNYX_BASE}/campaign/${encodeURIComponent(campaignId)}`, { headers: telnyxHeaders(apiKey) });
  if (!res.ok) return { status: "pending", error: await errText(res) };
  const d = unwrap(await res.json());
  const raw = str(d.campaignStatus);
  return { status: normalizeStatus(raw), raw };
}

export interface BrandDetails {
  ok: boolean;
  brandId?: string;
  identityStatus?: string;
  entityType?: string;
  /** true = Telnyx mock brand (the sandbox). Mock brands are never billed. */
  mock?: boolean;
  error?: string;
}

/**
 * Fetch a brand's identity. Used by a2p-register's production guard to prove
 * that the brand it is about to operate on really is the mock sandbox brand,
 * rather than trusting an env var to be pointed where we think it is.
 */
export async function getBrand(apiKey: string, brandId: string): Promise<BrandDetails> {
  const res = await fetch(`${TELNYX_BASE}/brand/${encodeURIComponent(brandId)}`, { headers: telnyxHeaders(apiKey) });
  if (!res.ok) return { ok: false, error: await errText(res) };
  const d = unwrap(await res.json());
  return {
    ok: true,
    brandId: str(d.brandId) ?? str(d.id),
    identityStatus: str(d.identityStatus),
    entityType: str(d.entityType),
    mock: d.mock === true,
  };
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
