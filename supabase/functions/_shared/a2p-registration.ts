// ============================================================
// supabase/functions/_shared/a2p-registration.ts
//
// THE A2P REGISTRATION STEP MACHINE. Shared by a2p-register (starts it) and
// a2p-verify-otp (resumes it after the sole-proprietor PIN is verified), so
// there is exactly one implementation of "what happens next".
//
// ---- WHY THIS IS A STEP MACHINE AND NOT A FUNCTION BODY
//
// a2p-register was pulled from production on 2026-07-28. The bug was not the
// bad response parse; the bad parse was just what exposed the real problem:
//
//   submitBrand() POSTs to a real endpoint, so TELNYX CREATES A REAL,
//   BILLABLE BRAND. Only after that did the old code parse the response,
//   fail, and return 502 — having written NO ROW. The brand existed, was
//   charged for, and nothing in our database pointed at it. Retrying made
//   a second one.
//
// Any flow that does [side effect] -> [side effect] -> [persist at the end]
// has that failure mode for every step. So the rule here is inverted:
//
//   EVERY STEP PERSISTS ITS OWN RESULT BEFORE THE NEXT STEP BEGINS,
//   and a re-invocation resumes from the furthest completed step.
//
// "Furthest completed step" is read from the row itself — brand_id set means
// the brand exists, campaign_id set means the campaign exists — never from a
// status string, which is a summary and can lag.
//
// Persistence is belt AND braces: the DB refuses to change a non-null
// brand_id/campaign_id at all (trigger a2p_registrations_guard_ids) and
// refuses a duplicate fee debit (wallet_ledger_a2p_fee_ref_uidx). See
// supabase/migrations/20260731_a2p_resumable_registration.sql. So even a
// logic bug here cannot produce a second billable brand.
//
// ---- THE STEPS
//
//   1. brand         POST /10dlc/brand            -> brand_id, brand_submitted_at
//   2. brand fee     wallet_debit $4              -> brand_fee_charged_at
//   3. otp  (sole prop only) POST …/smsOtp        -> otp_status=sent, otp_requested_at
//        ... machine STOPS here and returns awaiting_otp. a2p-verify-otp
//        verifies the PIN and calls back in, resuming at step 4.
//   4. campaign      POST /10dlc/campaignBuilder  -> campaign_id, campaign_submitted_at
//   5. campaign fee  wallet_debit $15             -> campaign_fee_charged_at, status=pending
//
// The fee split is the point of steps 2 and 5 being separate: an agent who
// starts a sole-proprietor registration and never enters their PIN is
// charged $4, not $18.50. We do not charge for a campaign Telnyx has not
// accepted.
// ============================================================
import {
  getBrand,
  requestBrandOtp,
  submitBrand,
  submitCampaign,
  submitSoleProprietorBrand,
  type BusinessInfo,
  type CampaignInfo,
  type SoleProprietorInfo,
} from "./telnyx-10dlc-adapter.ts";
import { buildOptinDescription, TCR_MESSAGE_FLOW_MAX } from "./lead-vendors.ts";
import { buildOptInAutoResponse } from "./sms-optin.ts";
import { SOLE_PROP_DAILY_MESSAGE_CAP } from "./messaging-shared.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

// ------------------------------------------------------------
// Sole Proprietor hard limits.
//
// These are Telnyx/TCR limits, not ours, and they are not negotiable by
// paying more — a sole-prop brand simply cannot exceed them. They are
// constants here so every enforcement site quotes the same number and the
// UI copy cannot drift from what the code actually enforces.
// ------------------------------------------------------------
export const SOLE_PROP = {
  /** One campaign per brand. */
  maxCampaignsPerBrand: 1,
  /** ONE phone number per campaign. The limit that changes the product. */
  maxNumbersPerCampaign: 1,
  /** Telnyx allows a given mobile number to back at most 3 sole-prop brands. */
  maxBrandsPerMobile: 3,
  /** Approximate daily throughput ceiling. Enforced in the send compliance gate. */
  dailyMessageCap: SOLE_PROP_DAILY_MESSAGE_CAP,
} as const;

/** Standard (EIN) brands are capped far higher; 49 is the Telnyx default. */
export const STANDARD_MAX_NUMBERS = 49;

/**
 * Plain-language explanation of the one-number rule.
 *
 * PROMPT_15 Phase 2 acceptance: "The 1-number-per-campaign limit is enforced,
 * with an explanatory message rather than a raw API error." An agent reading
 * `400 code 10036` learns nothing; this tells them what is true, why, and
 * what to do.
 */
export const ONE_NUMBER_EXPLANATION =
  "Your business is registered for texting as a Sole Proprietor, which lets you register without an EIN. " +
  "In exchange, the carriers allow exactly one texting number per business — that is their rule, not a plan limit, " +
  "and it cannot be raised by upgrading. You can still own as many numbers as you like for calling; only one of them can send texts. " +
  "To move texting to a different number, remove it from the current one first.";

export const OTP_WINDOW_HOURS = 24;

export type TelnyxEnv = "sandbox" | "production";

export interface RegistrationRow {
  agent_id: string;
  brand_id: string | null;
  campaign_id: string | null;
  status: string;
  brand_type: string;
  telnyx_env: string | null;
  brand_submitted_at: string | null;
  campaign_submitted_at: string | null;
  brand_fee_charged_at: string | null;
  campaign_fee_charged_at: string | null;
  otp_status: string | null;
  otp_requested_at: string | null;
  otp_sent_to: string | null;
}

export interface RegistrationContext {
  agentId: string;
  apiKey: string;
  env: TelnyxEnv;
  /** The shared mock brand, used instead of creating one when env === 'sandbox'. */
  sandboxBrandId?: string;
  brandType: "standard" | "sole_proprietor";
  business?: BusinessInfo;
  soleProp?: SoleProprietorInfo;
  campaign: CampaignInfo;
  /** Fee amounts from billing_config, in mills. */
  brandFeeMills: number;
  campaignFeeMills: number;
  monthlyFeeMills: number;
  websiteUrl: string;
}

export type StepName =
  | "brand" | "brand_fee" | "otp" | "campaign" | "campaign_fee";

export interface AdvanceResult {
  ok: boolean;
  /** Where the machine ended up. */
  status: "awaiting_otp" | "pending" | "failed";
  brandId?: string;
  campaignId?: string;
  /** Steps this invocation actually performed (an idempotent re-run does none). */
  completed: StepName[];
  /** Steps skipped because a previous invocation already did them. */
  resumed: StepName[];
  feesChargedMills: number;
  otpRequestedAt?: string;
  failedStep?: StepName;
  error?: string;
  detail?: string;
  httpStatus?: number;
}

/** Mask an E.164 for display: +19204227733 -> (•••) •••-7733 */
export function maskMobile(e164: string | null | undefined): string {
  const digits = (e164 || "").replace(/\D/g, "");
  if (digits.length < 4) return "your mobile number";
  return `(•••) •••-${digits.slice(-4)}`;
}

/** Milliseconds left in the OTP window; <= 0 means expired. */
export function otpMsRemaining(otpRequestedAt: string | null | undefined, now = Date.now()): number {
  if (!otpRequestedAt) return 0;
  const started = Date.parse(otpRequestedAt);
  if (!Number.isFinite(started)) return 0;
  return started + OTP_WINDOW_HOURS * 3600_000 - now;
}

export function isOtpExpired(otpRequestedAt: string | null | undefined, now = Date.now()): boolean {
  return otpMsRemaining(otpRequestedAt, now) <= 0;
}

/**
 * How many sole-proprietor brands already sit on this mobile number.
 *
 * Telnyx caps this at 3. Exceeding it does not fail politely at submission —
 * it fails at TCR vetting, days later, after the $4 is spent. So we count
 * first. Only PRODUCTION rows count: sandbox brands are mock and are not
 * registered against the mobile at all.
 */
export async function countSolePropBrandsOnMobile(
  sb: Sb,
  mobileE164: string,
  excludeAgentId: string,
): Promise<number> {
  const { count } = await sb.from("a2p_registrations")
    .select("agent_id", { count: "exact", head: true })
    .eq("brand_type", "sole_proprietor")
    .eq("otp_sent_to", mobileE164)
    .eq("telnyx_env", "production")
    .not("brand_id", "is", null)
    .neq("agent_id", excludeAgentId);
  return count ?? 0;
}

/**
 * Charge one registration fee, exactly once.
 *
 * ref_type/ref_id are the Telnyx brand or campaign id, which is what makes
 * wallet_ledger_a2p_fee_ref_uidx able to reject a double charge at the
 * database. A unique violation here is therefore GOOD NEWS — it means the
 * fee was already taken — so it is reported as already-charged, not as a
 * failure.
 */
async function chargeFee(
  sb: Sb,
  agentId: string,
  kind: "brand" | "campaign",
  refId: string,
  amountMills: number,
): Promise<{ charged: boolean; alreadyCharged: boolean; error?: string }> {
  const { error } = await sb.rpc("wallet_debit", {
    p_agent:        agentId,
    p_category:     "a2p_registration",
    p_units:        null,
    p_amount_mills: amountMills,
    p_ref_type:     kind === "brand" ? "a2p_brand" : "a2p_campaign",
    p_ref_id:       refId,
    p_desc: kind === "brand"
      ? `A2P 10DLC brand registration — $${(amountMills / 1000).toFixed(2)} (Telnyx brand ${refId})`
      : `A2P 10DLC campaign registration — $${(amountMills / 1000).toFixed(2)} (Telnyx campaign ${refId})`,
  });

  if (!error) return { charged: true, alreadyCharged: false };
  // 23505 = unique_violation on wallet_ledger_a2p_fee_ref_uidx.
  const msg = error.message || "";
  if (msg.includes("23505") || msg.includes("wallet_ledger_a2p_fee_ref_uidx") || msg.includes("duplicate key")) {
    return { charged: false, alreadyCharged: true };
  }
  return { charged: false, alreadyCharged: false, error: msg };
}

/**
 * Build the campaign payload for a brand type.
 *
 * A sole-prop brand can ONLY carry usecase SOLE_PROPRIETOR — sending
 * LOW_VOLUME against one is rejected. `messageFlow` is required by
 * campaignBuilder and is also one of only two verified routes by which the
 * agent's compliance URLs reach a carrier reviewer, so it is never blank.
 */
export function buildCampaignInfo(opts: {
  brandId: string;
  brandType: "standard" | "sole_proprietor";
  agencyName: string;
  leadVendors: string[] | null | undefined;
  // smsOptIn is what makes the opt-in workflow description checkable — the
  // reviewer can open the page and compare it against the quoted disclosure.
  // compliancePageUrls() has returned it since the opt-in page shipped, so
  // every real caller already passes it; optional only so a test fixture can
  // build a campaign without one.
  complianceUrls: { privacy: string; terms: string; smsOptIn?: string };
  overrides?: Partial<CampaignInfo>;
}): CampaignInfo {
  const optinWorkflow = buildOptinDescription(opts.agencyName, opts.leadVendors, opts.complianceUrls);
  const agency = opts.agencyName || "our agency";

  return {
    brandId: opts.brandId,
    usecase: opts.brandType === "sole_proprietor" ? "SOLE_PROPRIETOR" : (opts.overrides?.usecase || "LOW_VOLUME"),
    description: opts.overrides?.description
      || `Life insurance quote follow-up, appointment reminders, application status updates, and customer service messages sent by ${agency} to consumers who requested insurance information and consented to be contacted.`,
    // The single most-read field in the whole submission.
    messageFlow: opts.overrides?.messageFlow || optinWorkflow,
    sampleMessages: opts.overrides?.sampleMessages?.length
      ? opts.overrides.sampleMessages
      : [
        `Hi {name}, this is {agent} with ${agency} following up on the life insurance quote you requested. I can pull rates from several carriers for you - want me to send a few options? Reply STOP to opt out.`,
        `Hi {name}, ${agency} here - your life insurance application moved to Approved. I'll call today to walk you through the next steps. Reply STOP to opt out.`,
        `Hi {name}, ${agency} - thanks for sending your ID. Your policy documents are ready. Reply YES and I'll email them over. Reply STOP to opt out.`,
      ],
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    // The SAME string the opt-in page texts a consumer who just signed up
    // (compliance-page calls buildOptInAutoResponse too). A confirmation that
    // does not match the campaign's registered opt-in response is a
    // discrepancy a reviewer can see, and the messageFlow text above tells
    // them to look at this field for it.
    optinMessage: opts.overrides?.optinMessage || buildOptInAutoResponse(agency),
    optoutMessage: opts.overrides?.optoutMessage
      || `${agency}: You are unsubscribed and will receive no further messages. Reply START to resubscribe.`,
    helpMessage: opts.overrides?.helpMessage
      || `${agency}: For help, reply to this message or call our office. Msg&data rates may apply. Reply STOP to opt out.`,
    // Boolean attestation that terms exist — NOT a link. The terms URL rides
    // in messageFlow and on the brand's website field.
    termsAndConditions: true,
    embeddedLink: opts.overrides?.embeddedLink ?? false,
    // Our samples name a phone number to call, so this is true. Declaring it
    // false while sending a number in a sample is a rejection reason.
    embeddedPhone: opts.overrides?.embeddedPhone ?? true,
    ageGated: false,
    directLending: false,
    numberPool: false,
  };
}

/**
 * Run the registration forward from wherever it currently is.
 *
 * Safe to call repeatedly. Each step checks the row first and skips itself if
 * already done, so a retry after any failure resumes rather than restarts.
 */
export async function advanceRegistration(
  sb: Sb,
  row: RegistrationRow,
  ctx: RegistrationContext,
): Promise<AdvanceResult> {
  const completed: StepName[] = [];
  const resumed: StepName[] = [];
  let feesChargedMills = 0;

  let brandId = row.brand_id;
  let campaignId = row.campaign_id;
  const isSoleProp = ctx.brandType === "sole_proprietor";
  const isSandbox = ctx.env === "sandbox";

  const fail = async (step: StepName, error: string, detail: string, httpStatus = 502): Promise<AdvanceResult> => {
    await sb.from("a2p_registrations").update({
      last_error: `${step}: ${detail}`.slice(0, 2000),
      last_error_at: new Date().toISOString(),
    }).eq("agent_id", ctx.agentId);
    return {
      ok: false, status: "failed", brandId: brandId ?? undefined, campaignId: campaignId ?? undefined,
      completed, resumed, feesChargedMills, failedStep: step, error, detail, httpStatus,
    };
  };

  // ---------------------------------------------------------------
  // STEP 1 — brand.
  //
  // In sandbox we attach to the existing mock brand instead of creating one.
  // That is the whole point of the production guard: a dev run must never
  // mint a real billable brand.
  // ---------------------------------------------------------------
  if (brandId) {
    resumed.push("brand");
  } else if (isSandbox) {
    if (!ctx.sandboxBrandId) {
      return await fail("brand", "sandbox_brand_not_configured", "TELNYX_SANDBOX_BRAND_ID is not set.", 500);
    }
    brandId = ctx.sandboxBrandId;
    const { error: writeErr } = await sb.from("a2p_registrations").update({
      brand_id: brandId,
      brand_submitted_at: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
    }).eq("agent_id", ctx.agentId);
    if (writeErr) return await fail("brand", "db_write_failed", writeErr.message, 500);
    completed.push("brand");
  } else {
    const result = isSoleProp
      ? await submitSoleProprietorBrand(ctx.apiKey, ctx.soleProp!)
      : await submitBrand(ctx.apiKey, ctx.business!);

    if (!result.ok || !result.brandId) {
      // If the id was unreadable the brand may exist anyway — the adapter
      // says so explicitly and includes the raw body. Log it at error level
      // so it is recoverable from function logs rather than lost.
      console.error(`[a2p] brand submit failed for agent ${ctx.agentId}: ${result.error}`);
      return await fail("brand", "brand_submit_failed", result.error ?? "unknown error");
    }

    // *** THE CRITICAL WRITE. *** Telnyx has now created a real, billable
    // brand. Persist the id before doing anything else — before the fee,
    // before the OTP, before the campaign. If the process dies on the very
    // next line, the next invocation resumes instead of creating a second
    // brand. This single ordering is what the 2026-07-28 incident was about.
    brandId = result.brandId;
    const { error: writeErr } = await sb.from("a2p_registrations").update({
      brand_id: brandId,
      tcr_brand_id: result.tcrBrandId ?? null,
      brand_submitted_at: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
    }).eq("agent_id", ctx.agentId);

    if (writeErr) {
      // The brand EXISTS at Telnyx and we could not record it. This is the
      // orphan scenario; make it impossible to miss.
      console.error(
        `[a2p] *** ORPHAN BRAND RISK *** agent=${ctx.agentId} telnyx_brand_id=${brandId} ` +
        `was created but could not be written to a2p_registrations: ${writeErr.message}`,
      );
      return await fail("brand", "brand_created_but_not_recorded",
        `Telnyx brand ${brandId} was created but could not be saved (${writeErr.message}). It has been logged for recovery — do not retry until it is linked.`, 500);
    }
    completed.push("brand");
  }

  // ---------------------------------------------------------------
  // STEP 2 — the $4 brand fee.
  //
  // Charged the moment the brand is ACCEPTED, not at the end. Sandbox brands
  // are mock and Telnyx never bills them, so charging the agent would be
  // inventing a charge.
  // ---------------------------------------------------------------
  if (isSandbox) {
    // no fee
  } else if (row.brand_fee_charged_at) {
    resumed.push("brand_fee");
  } else {
    const fee = await chargeFee(sb, ctx.agentId, "brand", brandId, ctx.brandFeeMills);
    if (fee.error) {
      // Do NOT abort: the brand is real and already submitted. An
      // uncollectible fee needs reconciliation, not a retry that would
      // re-run the whole flow.
      console.error(`[a2p] brand fee debit failed for agent ${ctx.agentId} (brand ${brandId} already submitted): ${fee.error}`);
    } else {
      if (fee.charged) feesChargedMills += ctx.brandFeeMills;
      await sb.from("a2p_registrations").update({
        brand_fee_charged_at: new Date().toISOString(),
      }).eq("agent_id", ctx.agentId);
      completed.push("brand_fee");
    }
  }

  // ---------------------------------------------------------------
  // STEP 3 — sole-proprietor mobile OTP.
  //
  // The machine STOPS here. The campaign is not submitted and the $15 is not
  // charged until the PIN is verified, because an agent who never enters
  // their PIN must not be charged $18.50 for nothing.
  // ---------------------------------------------------------------
  if (isSoleProp && !isSandbox && row.otp_status !== "verified") {
    if (row.otp_status === "sent" && !isOtpExpired(row.otp_requested_at)) {
      // A PIN is already in flight and still valid — do not send another,
      // that would reset nothing and confuse the agent about which PIN works.
      resumed.push("otp");
      return {
        ok: true, status: "awaiting_otp", brandId, completed, resumed, feesChargedMills,
        otpRequestedAt: row.otp_requested_at ?? undefined,
      };
    }

    const otp = await requestBrandOtp(ctx.apiKey, brandId);
    if (!otp.ok) return await fail("otp", "otp_request_failed", otp.error ?? "unknown error");

    const requestedAt = new Date().toISOString();
    await sb.from("a2p_registrations").update({
      status: "awaiting_otp",
      otp_status: "sent",
      otp_requested_at: requestedAt,
      otp_sent_to: ctx.soleProp?.mobilePhone ?? row.otp_sent_to ?? null,
      otp_attempts: 0,
      last_error: null,
      last_error_at: null,
    }).eq("agent_id", ctx.agentId);
    completed.push("otp");

    return {
      ok: true, status: "awaiting_otp", brandId, completed, resumed, feesChargedMills,
      otpRequestedAt: requestedAt,
    };
  }

  // ---------------------------------------------------------------
  // STEP 4 — campaign. POST /10dlc/campaignBuilder.
  // ---------------------------------------------------------------
  if (campaignId) {
    resumed.push("campaign");
  } else {
    const campaignInfo: CampaignInfo = { ...ctx.campaign, brandId };
    const result = await submitCampaign(ctx.apiKey, campaignInfo);
    if (!result.ok || !result.campaignId) {
      console.error(`[a2p] campaign submit failed for agent ${ctx.agentId} (brand ${brandId}): ${result.error}`);
      return await fail("campaign", "campaign_submit_failed", result.error ?? "unknown error");
    }

    // Same ordering rule as the brand: persist before charging.
    campaignId = result.campaignId;
    const { error: writeErr } = await sb.from("a2p_registrations").update({
      campaign_id: campaignId,
      tcr_campaign_id: result.tcrCampaignId ?? null,
      campaign_submitted_at: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
    }).eq("agent_id", ctx.agentId);

    if (writeErr) {
      console.error(
        `[a2p] *** ORPHAN CAMPAIGN RISK *** agent=${ctx.agentId} telnyx_campaign_id=${campaignId} ` +
        `was created but could not be written to a2p_registrations: ${writeErr.message}`,
      );
      return await fail("campaign", "campaign_created_but_not_recorded",
        `Telnyx campaign ${campaignId} was created but could not be saved (${writeErr.message}).`, 500);
    }
    completed.push("campaign");
  }

  // ---------------------------------------------------------------
  // STEP 5 — the $15 campaign fee, and only now does the row become pending.
  // ---------------------------------------------------------------
  if (isSandbox) {
    // no fee
  } else if (row.campaign_fee_charged_at) {
    resumed.push("campaign_fee");
  } else {
    const fee = await chargeFee(sb, ctx.agentId, "campaign", campaignId, ctx.campaignFeeMills);
    if (fee.error) {
      console.error(`[a2p] campaign fee debit failed for agent ${ctx.agentId} (campaign ${campaignId} already submitted): ${fee.error}`);
    } else {
      if (fee.charged) feesChargedMills += ctx.campaignFeeMills;
      await sb.from("a2p_registrations").update({
        campaign_fee_charged_at: new Date().toISOString(),
      }).eq("agent_id", ctx.agentId);
      completed.push("campaign_fee");
    }
  }

  await sb.from("a2p_registrations").update({
    status: "pending",
    registered_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
  }).eq("agent_id", ctx.agentId);

  return { ok: true, status: "pending", brandId, campaignId, completed, resumed, feesChargedMills };
}

/**
 * Resolve which Telnyx brand environment this invocation may touch.
 *
 * PRODUCTION IS OPT-IN, PER CALL. Without an explicit `allow_production:
 * true`, the function may only operate against TELNYX_SANDBOX_BRAND_ID —
 * and we verify with Telnyx that the id really is a mock brand rather than
 * trusting the env var to be pointed where we believe it is.
 *
 * Real money is the reason: a production brand is $4 and a campaign is $15
 * per submission, non-refundable, and there is no "undo" for a registration
 * a carrier has already seen.
 */
export async function resolveTelnyxEnv(
  apiKey: string,
  allowProduction: boolean,
  agentId: string,
): Promise<
  | { ok: true; env: TelnyxEnv; sandboxBrandId?: string }
  | { ok: false; error: string; detail: string; httpStatus: number }
> {
  if (allowProduction) {
    console.warn(
      `[a2p-register] *** PRODUCTION REGISTRATION AUTHORISED *** agent=${agentId}. ` +
      `A REAL, BILLABLE Telnyx brand ($4) and campaign ($15) will be created. ` +
      `allow_production:true was explicitly passed by the caller.`,
    );
    return { ok: true, env: "production" };
  }

  const sandboxBrandId = Deno.env.get("TELNYX_SANDBOX_BRAND_ID");
  if (!sandboxBrandId) {
    return {
      ok: false,
      error: "sandbox_brand_not_configured",
      detail: "TELNYX_SANDBOX_BRAND_ID is not set, so this function has no safe brand to work against. " +
        "Set it (see docs/telnyx-10dlc-brands.md) or pass allow_production:true to register for real.",
      httpStatus: 500,
    };
  }

  // Trust, then verify. An env var pointed at the PRODUCTION brand by
  // accident would silently defeat the whole guard.
  const brand = await getBrand(apiKey, sandboxBrandId);
  if (!brand.ok) {
    return {
      ok: false,
      error: "sandbox_brand_unreachable",
      detail: `Could not read TELNYX_SANDBOX_BRAND_ID (${sandboxBrandId}) from Telnyx: ${brand.error}`,
      httpStatus: 502,
    };
  }
  if (brand.mock !== true) {
    console.error(
      `[a2p-register] *** REFUSING *** TELNYX_SANDBOX_BRAND_ID=${sandboxBrandId} is NOT a mock brand ` +
      `(mock=${brand.mock}, identityStatus=${brand.identityStatus}). Refusing to treat a real brand as the sandbox.`,
    );
    return {
      ok: false,
      error: "sandbox_brand_is_not_mock",
      detail: `TELNYX_SANDBOX_BRAND_ID (${sandboxBrandId}) is a REAL brand, not a mock one. Refusing to use it as a sandbox.`,
      httpStatus: 500,
    };
  }

  return { ok: true, env: "sandbox", sandboxBrandId };
}
