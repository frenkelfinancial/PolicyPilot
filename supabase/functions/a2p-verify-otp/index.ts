import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requestBrandOtp, verifyBrandOtp, type CampaignInfo } from "../_shared/telnyx-10dlc-adapter.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type AgencyProfile,
  agencyDisplayName,
  compliancePageUrls,
  DEFAULT_COMPLIANCE_BASE_URL,
} from "../_shared/compliance-page.ts";
import {
  advanceRegistration,
  buildCampaignInfo,
  isOtpExpired,
  maskMobile,
  otpMsRemaining,
  OTP_WINDOW_HOURS,
  SOLE_PROP,
  type RegistrationRow,
} from "../_shared/a2p-registration.ts";

// ============================================================
// a2p-verify-otp — the one step of Sole Proprietor registration that
// genuinely requires the agent.
//
// Telnyx's sole-prop flow proves identity with the producer's personal mobile
// instead of an EIN: brand -> PIN texted to that mobile -> PIN verified ->
// campaign. This function owns the middle two.
//
// Actions:
//   { action: "verify", pin: "123456" }   verify the PIN, then submit the
//                                          campaign and charge the $15
//   { action: "status" }                   countdown + state, no side effects
//   { action: "resend" }                   new PIN, resets the 24h clock
//
// THE $15 IS CHARGED HERE, NOT AT REGISTRATION. An agent who starts a
// sole-prop registration and never enters their PIN has paid $4 for a brand
// that exists, and nothing for a campaign that does not. Charging $19 up
// front for a registration that may never complete is the behaviour PROMPT_15
// explicitly forbids.
//
// THE PIN EXPIRES 24 HOURS AFTER DELIVERY. Past that the brand submission
// restarts at Telnyx's end, so the response always carries the remaining time
// and this function offers a resend rather than leaving the agent stuck on a
// dead PIN.
//
// On success it hands straight back to the shared step machine
// (_shared/a2p-registration.ts), which resumes at the campaign step — the
// same code path a standard brand takes, so there is one implementation of
// "submit the campaign and charge for it", not two.
// ============================================================
serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");

  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { action?: string; pin?: string };
  try { body = await req.json(); } catch { body = {}; }
  const action = body.action === "resend" ? "resend" : body.action === "status" ? "status" : "verify";

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: rowRaw } = await sb.from("a2p_registrations")
    .select("agent_id, brand_id, campaign_id, status, brand_type, telnyx_env, brand_submitted_at, campaign_submitted_at, brand_fee_charged_at, campaign_fee_charged_at, otp_status, otp_requested_at, otp_sent_to, otp_attempts, business_info")
    .eq("agent_id", user.id)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const row = rowRaw as (RegistrationRow & { otp_attempts?: number; business_info?: any }) | null;

  if (!row || !row.brand_id) {
    return json({
      error: "no_registration",
      detail: "There is no text-messaging registration to verify yet. Start one from Settings first.",
    }, 404);
  }
  if (row.brand_type !== "sole_proprietor") {
    return json({
      error: "not_sole_proprietor",
      detail: "PIN verification only applies to Sole Proprietor registrations. Your brand is registered with an EIN and needs no PIN.",
    }, 400);
  }

  const msLeft = otpMsRemaining(row.otp_requested_at);
  const expired = isOtpExpired(row.otp_requested_at);
  const maskedTo = maskMobile(row.otp_sent_to);

  const stateBlock = () => ({
    brand_id: row.brand_id,
    otp_status: row.otp_status,
    otp_requested_at: row.otp_requested_at,
    otp_expires_at: row.otp_requested_at
      ? new Date(Date.parse(row.otp_requested_at) + OTP_WINDOW_HOURS * 3600_000).toISOString()
      : null,
    otp_seconds_remaining: Math.max(0, Math.floor(msLeft / 1000)),
    otp_expired: expired,
    otp_sent_to_masked: maskedTo,
    otp_attempts: row.otp_attempts ?? 0,
  });

  // ------------------------------------------------------------
  // status — pure read, drives the countdown in the UI.
  // ------------------------------------------------------------
  if (action === "status") {
    return json({
      ok: true,
      status: row.status,
      ...stateBlock(),
      can_resend: row.otp_status !== "verified",
      detail: row.otp_status === "verified"
        ? "Your mobile number is verified."
        : expired
          ? `The PIN we texted to ${maskedTo} has expired. Send a new one to continue.`
          : `Enter the 6-digit PIN we texted to ${maskedTo}.`,
    });
  }

  // ------------------------------------------------------------
  // resend — new PIN, clock reset, attempts cleared.
  // ------------------------------------------------------------
  if (action === "resend") {
    if (row.otp_status === "verified") {
      return json({ ok: true, already_verified: true, detail: "Your mobile number is already verified." });
    }
    const otp = await requestBrandOtp(TELNYX_API_KEY, row.brand_id);
    if (!otp.ok) {
      await sb.from("a2p_registrations").update({
        last_error: `otp_resend: ${otp.error}`.slice(0, 2000),
        last_error_at: new Date().toISOString(),
      }).eq("agent_id", user.id);
      return json({ error: "otp_resend_failed", detail: otp.error }, 502);
    }
    const requestedAt = new Date().toISOString();
    await sb.from("a2p_registrations").update({
      status: "awaiting_otp",
      otp_status: "sent",
      otp_requested_at: requestedAt,
      otp_attempts: 0,
      last_error: null,
      last_error_at: null,
    }).eq("agent_id", user.id);

    return json({
      ok: true,
      status: "awaiting_otp",
      otp_requested_at: requestedAt,
      otp_expires_at: new Date(Date.parse(requestedAt) + OTP_WINDOW_HOURS * 3600_000).toISOString(),
      otp_seconds_remaining: OTP_WINDOW_HOURS * 3600,
      otp_sent_to_masked: maskedTo,
      detail: `A new PIN is on its way to ${maskedTo}. It is valid for ${OTP_WINDOW_HOURS} hours.`,
    });
  }

  // ------------------------------------------------------------
  // verify
  // ------------------------------------------------------------
  if (row.otp_status === "verified" && row.campaign_id) {
    return json({
      ok: true, already_verified: true, status: row.status,
      brand_id: row.brand_id, campaign_id: row.campaign_id,
      detail: "Already verified and submitted — nothing more to do.",
    });
  }

  const pin = typeof body.pin === "string" ? body.pin.replace(/\D/g, "") : "";
  if (!pin) {
    return json({ error: "pin_required", detail: "Enter the PIN we texted you.", ...stateBlock() }, 400);
  }

  // Refuse a PIN we already know is dead rather than spending a round trip
  // and giving the agent a confusing generic failure.
  if (expired && row.otp_status !== "verified") {
    await sb.from("a2p_registrations").update({ otp_status: "expired" }).eq("agent_id", user.id);
    return json({
      error: "otp_expired",
      detail: `That PIN expired — they are only valid for ${OTP_WINDOW_HOURS} hours. Tap Resend and we will text ${maskedTo} a new one.`,
      can_resend: true,
      ...stateBlock(),
    }, 409);
  }

  const verified = await verifyBrandOtp(TELNYX_API_KEY, row.brand_id, pin);
  if (!verified.ok) {
    const attempts = (row.otp_attempts ?? 0) + 1;
    await sb.from("a2p_registrations").update({
      otp_attempts: attempts,
      last_error: `otp_verify: ${verified.error}`.slice(0, 2000),
      last_error_at: new Date().toISOString(),
    }).eq("agent_id", user.id);
    return json({
      error: "otp_invalid",
      // Telnyx does not expose attempts-remaining, so we do not invent one.
      detail: `That PIN was not accepted. Check the message we sent to ${maskedTo} and try again, or resend a new PIN.`,
      telnyx_detail: verified.error,
      attempts,
      can_resend: true,
      ...stateBlock(),
    }, 400);
  }

  await sb.from("a2p_registrations").update({
    otp_status: "verified",
    otp_verified_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
  }).eq("agent_id", user.id);

  // ------------------------------------------------------------
  // Verified — hand back to the step machine, which resumes at the campaign
  // step and charges the $15 only after Telnyx accepts it.
  // ------------------------------------------------------------
  const { data: agentRow } = await sb.from("agents")
    .select([
      "dba_name", "business_legal_name", "business_entity_type", "formation_state",
      "business_street", "business_city", "business_state", "business_postal_code",
      "business_phone", "business_email", "lead_vendors",
      "compliance_slug", "compliance_page_published_at",
    ].join(","))
    .eq("id", user.id)
    .maybeSingle();
  const agency = (agentRow ?? {}) as unknown as AgencyProfile;

  if (!agency.compliance_slug) {
    return json({
      ok: true,
      status: "awaiting_otp",
      otp_verified: true,
      error: "compliance_page_missing",
      detail: "Your mobile is verified, but your compliance page is no longer published, so the campaign cannot be submitted. " +
        "Open Settings > Business Profile and save your details, then retry.",
    }, 409);
  }

  const complianceBaseUrl = Deno.env.get("COMPLIANCE_PAGE_BASE_URL") || DEFAULT_COMPLIANCE_BASE_URL;
  const complianceUrls = compliancePageUrls(complianceBaseUrl, agency.compliance_slug);
  const agencyName = agencyDisplayName(agency) || agency.business_legal_name || "";

  const { data: billingConfig } = await sb.from("billing_config")
    .select("a2p_brand_fee_mills, a2p_campaign_fee_mills, a2p_sole_prop_monthly_fee_mills")
    .eq("id", 1)
    .maybeSingle();
  const brandFeeMills    = billingConfig?.a2p_brand_fee_mills    ?? 4000;
  const campaignFeeMills = billingConfig?.a2p_campaign_fee_mills ?? 15000;
  const monthlyFeeMills  = billingConfig?.a2p_sole_prop_monthly_fee_mills ?? 2000;

  const campaign: CampaignInfo = buildCampaignInfo({
    brandId: row.brand_id,
    brandType: "sole_proprietor",
    agencyName,
    leadVendors: agency.lead_vendors,
    complianceUrls,
  });

  const result = await advanceRegistration(
    sb,
    { ...row, otp_status: "verified" } as RegistrationRow,
    {
      agentId: user.id,
      apiKey: TELNYX_API_KEY,
      env: row.telnyx_env === "production" ? "production" : "sandbox",
      sandboxBrandId: Deno.env.get("TELNYX_SANDBOX_BRAND_ID"),
      brandType: "sole_proprietor",
      campaign,
      brandFeeMills,
      campaignFeeMills,
      monthlyFeeMills,
      websiteUrl: complianceUrls.privacy,
    },
  );

  if (!result.ok) {
    return json({
      ok: false,
      otp_verified: true,
      error: result.error,
      detail: result.detail,
      failed_step: result.failedStep,
      brand_id: result.brandId ?? row.brand_id,
      campaign_id: result.campaignId ?? null,
      // The PIN is verified and stays verified — a campaign failure does not
      // send the agent back to the start.
      retryable: true,
    }, result.httpStatus ?? 502);
  }

  return json({
    ok: true,
    otp_verified: true,
    status: result.status,
    brand_id: result.brandId,
    campaign_id: result.campaignId,
    completed_steps: result.completed,
    resumed_steps: result.resumed,
    fees_charged_mills: result.feesChargedMills,
    monthly_fee_mills: monthlyFeeMills,
    max_numbers: SOLE_PROP.maxNumbersPerCampaign,
    detail: "Verified, and your campaign is submitted. Carrier review usually takes 3-7 business days. " +
      "As a Sole Proprietor you get one texting number — we will assign it automatically as soon as you are approved.",
  });
});
