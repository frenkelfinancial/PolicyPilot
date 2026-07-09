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

function normalizeStatus(rawStatus: string | undefined): RegistrationStatus {
  const s = (rawStatus || "").toUpperCase();
  if (["VERIFIED", "REGISTERED", "TCR_ACCEPTED", "APPROVED", "ACTIVE"].includes(s)) return "approved";
  if (["FAILED", "REJECTED", "TCR_REJECTED"].includes(s)) return "rejected";
  // TODO(verify before go-live): this build could not confirm Telnyx's exact
  // raw status string(s) for a brand/campaign that was approved and then
  // SUSPENDED or EXPIRED — do not guess the spelling/casing here. Once
  // confirmed against current Telnyx docs (or an observed real payload),
  // add the matching branches, e.g.:
  //   if (["SUSPENDED", ...].includes(s)) return "suspended";
  //   if (["EXPIRED", ...].includes(s)) return "expired";
  // Until then, an actually-suspended/expired registration will normalize
  // to "pending" here — a2p-status-poll still re-polls 'approved' rows
  // (see that file), so filling in the real strings is enough to make
  // suspension/expiry detection work with no further code changes.
  return "pending";
}

export async function getBrandStatus(apiKey: string, brandId: string): Promise<{ status: RegistrationStatus; raw?: string; error?: string }> {
  const res = await fetch(`${TELNYX_BASE}/brand/${brandId}`, { headers: telnyxHeaders(apiKey) });
  if (!res.ok) return { status: "pending", error: `${res.status}: ${await res.text()}` };
  const data = await res.json();
  const raw = data?.data?.identityStatus ?? data?.data?.brandStatus;
  return { status: normalizeStatus(raw), raw };
}

export async function getCampaignStatus(apiKey: string, campaignId: string): Promise<{ status: RegistrationStatus; raw?: string; error?: string }> {
  const res = await fetch(`${TELNYX_BASE}/campaign/${campaignId}`, { headers: telnyxHeaders(apiKey) });
  if (!res.ok) return { status: "pending", error: `${res.status}: ${await res.text()}` };
  const data = await res.json();
  const raw = data?.data?.campaignStatus;
  return { status: normalizeStatus(raw), raw };
}
