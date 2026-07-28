import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { BusinessInfo, CampaignInfo, SoleProprietorInfo } from "../_shared/telnyx-10dlc-adapter.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type AgencyProfile,
  agencyDisplayName,
  compliancePageUrls,
  DEFAULT_COMPLIANCE_BASE_URL,
  missingComplianceFields,
} from "../_shared/compliance-page.ts";
import {
  advanceRegistration,
  buildCampaignInfo,
  countSolePropBrandsOnMobile,
  maskMobile,
  resolveTelnyxEnv,
  SOLE_PROP,
  STANDARD_MAX_NUMBERS,
  type RegistrationRow,
} from "../_shared/a2p-registration.ts";
import { toE164 } from "../_shared/phone.ts";

// ============================================================
// a2p-register — start (or RESUME) an agent's 10DLC registration.
//
// RESTORED TO PRODUCTION 2026-07-28 after being pulled the same day. Read
// _shared/a2p-registration.ts before changing anything here: this function is
// now a thin shell around a resumable step machine, and the ordering rules it
// enforces are the entire reason the previous version was withdrawn.
//
// What the old version did wrong, in one sentence: it created a real, billable
// Telnyx brand, misparsed the response, returned 502, and wrote no database
// row — leaving a paid-for brand that nothing pointed at, and creating another
// one on every retry.
//
// What changed:
//   • Each step persists before the next begins; re-invoking RESUMES.
//   • brand_id / campaign_id are write-once at the DATABASE level, and a
//     duplicate fee debit is a unique violation, so a code bug cannot
//     re-create either (20260731_a2p_resumable_registration.sql).
//   • Sole Proprietor is a first-class path — most of our agents are 1099
//     producers with no EIN and simply could not register before.
//   • Fees are split: $4 when the brand is accepted, $15 only when the
//     campaign actually submits (post-OTP for sole prop).
//   • PRODUCTION IS OPT-IN PER CALL. Without allow_production:true this
//     function will only touch the mock sandbox brand.
//
// Request body:
//   {
//     brand_type?: "standard" | "sole_proprietor",   // default "standard"
//     business_info?: {...},                          // standard: EIN required
//     sole_proprietor?: { firstName, lastName, mobilePhone, ... },
//     campaign?: {...},                               // optional overrides
//     allow_production?: true                         // opt in to real money
//   }
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

  let body: {
    brand_type?: string;
    business_info?: Partial<BusinessInfo>;
    sole_proprietor?: Partial<SoleProprietorInfo>;
    campaign?: Partial<CampaignInfo>;
    allow_production?: boolean;
  };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const brandType = body.brand_type === "sole_proprietor" ? "sole_proprietor" : "standard";
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // ------------------------------------------------------------
  // 1. Existing registration — resume, don't restart.
  //
  // The old code rejected anything that wasn't not_started/rejected with a
  // 409. That is wrong now: 'awaiting_otp' and a half-finished 'pending' are
  // exactly the states a resume exists to continue from. Only a registration
  // that has genuinely finished is refused.
  // ------------------------------------------------------------
  const { data: existingRaw } = await sb.from("a2p_registrations")
    .select("agent_id, brand_id, campaign_id, status, brand_type, telnyx_env, brand_submitted_at, campaign_submitted_at, brand_fee_charged_at, campaign_fee_charged_at, otp_status, otp_requested_at, otp_sent_to")
    .eq("agent_id", user.id)
    .maybeSingle();
  const existing = existingRaw as RegistrationRow | null;

  if (existing && (existing.status === "approved" || existing.status === "suspended")) {
    return json({
      error: "already_registered",
      detail: `Your 10DLC registration is already ${existing.status}. Nothing to submit.`,
      status: existing.status,
    }, 409);
  }
  // A campaign that is submitted and awaiting carrier review is complete as
  // far as this function is concerned — resuming would do nothing.
  if (existing && existing.status === "pending" && existing.campaign_id) {
    return json({
      ok: true,
      already_submitted: true,
      brand_id: existing.brand_id,
      campaign_id: existing.campaign_id,
      status: "pending",
      detail: "Your registration is already submitted and waiting on carrier review (typically 3-7 business days).",
    });
  }
  // Changing brand type mid-flight would mean a second brand. Refuse.
  if (existing?.brand_id && existing.brand_type !== brandType) {
    return json({
      error: "brand_type_locked",
      detail: `This registration was started as "${existing.brand_type}" and a Telnyx brand already exists for it. ` +
        `Switching to "${brandType}" would require a second brand, which is not allowed.`,
    }, 409);
  }

  // ------------------------------------------------------------
  // 2. Compliance page gate (PROMPT_16).
  //
  // 10DLC review requires a publicly reachable privacy policy and terms page
  // belonging to the messaging business. Submitting without one does not fail
  // fast — it fails DAYS later as a carrier rejection, after the fees are
  // already spent. So it is checked before the first Telnyx call.
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

  if (!agency.compliance_page_published_at || !agency.compliance_slug) {
    const missing = missingComplianceFields(agency);
    return json({
      error: "compliance_page_missing",
      detail: missing.length
        ? `Your compliance page is not published yet. Missing: ${missing.map((m) => m.label).join(", ")}.`
        : "Your compliance page is not published yet. Open Settings > Business Profile and save your details.",
      missing_fields: missing,
    }, 409);
  }

  const complianceBaseUrl = Deno.env.get("COMPLIANCE_PAGE_BASE_URL") || DEFAULT_COMPLIANCE_BASE_URL;
  const complianceUrls = compliancePageUrls(complianceBaseUrl, agency.compliance_slug);
  const agencyName = agencyDisplayName(agency) || agency.business_legal_name || "";

  // ------------------------------------------------------------
  // 3. Validate the brand inputs for the chosen type.
  // ------------------------------------------------------------
  let business: BusinessInfo | undefined;
  let soleProp: SoleProprietorInfo | undefined;

  if (brandType === "standard") {
    const info = body.business_info;
    if (!info?.displayName || !info?.companyName || !info?.ein || !info?.entityType || !info?.email || !info?.phone) {
      return json({
        error: "business_info_incomplete",
        detail: "A standard brand needs a display name, legal company name, EIN, entity type, email and phone. " +
          "If you do not have an EIN, register as a Sole Proprietor instead (brand_type: \"sole_proprietor\").",
      }, 400);
    }
    business = {
      displayName: info.displayName,
      companyName: info.companyName,
      ein:         info.ein,
      entityType:  info.entityType,
      vertical:    info.vertical || "INSURANCE",
      email:       info.email,
      phone:       info.phone,
      street:      info.street     || agency.business_street       || "",
      city:        info.city       || agency.business_city         || "",
      state:       info.state      || agency.business_state        || "",
      postalCode:  info.postalCode || agency.business_postal_code  || "",
      country:     info.country    || "US",
      // The generated privacy policy IS the brand's website. Deliberately not
      // a client-supplied URL: a recruiting site aimed at other agents, or the
      // lead vendor's domain, describes a different business than the one
      // sending the messages — which is exactly what carrier review rejects.
      // It is also the ONLY verified field that carries a compliance URL to
      // the reviewer, since the campaign has no link field at all.
      website:     complianceUrls.privacy,
    };
  } else {
    const sp = body.sole_proprietor ?? {};
    // An EIN plus SOLE_PROPRIETOR is a contradiction, and Telnyx would treat
    // the brand differently than the agent expects. Refuse it outright.
    if (body.business_info?.ein) {
      return json({
        error: "ein_with_sole_proprietor",
        detail: "A Sole Proprietor brand is for producers with no EIN. You supplied an EIN — register as a standard brand instead.",
      }, 400);
    }
    const mobile = toE164(sp.mobilePhone ?? "");
    const missing: string[] = [];
    if (!sp.firstName) missing.push("legal first name");
    if (!sp.lastName)  missing.push("legal last name");
    if (!mobile)       missing.push("mobile phone (a real mobile — the verification PIN is texted to it)");
    if (missing.length) {
      return json({
        error: "sole_proprietor_info_incomplete",
        detail: `Sole Proprietor registration needs: ${missing.join(", ")}.`,
        missing_fields: missing,
      }, 400);
    }

    // Telnyx caps sole-prop brands per mobile number at 3. Exceeding it does
    // not fail politely at submission — it fails at TCR vetting days later,
    // after the $4 is spent. So it is checked here, in plain language.
    const usedOnMobile = await countSolePropBrandsOnMobile(sb, mobile, user.id);
    if (usedOnMobile >= SOLE_PROP.maxBrandsPerMobile) {
      return json({
        error: "sole_prop_mobile_limit",
        detail: `The mobile number ${maskMobile(mobile)} is already used to verify ${usedOnMobile} Sole Proprietor text-messaging registrations, ` +
          `and the carriers allow at most ${SOLE_PROP.maxBrandsPerMobile}. Use a different mobile number that you personally answer.`,
      }, 409);
    }

    soleProp = {
      firstName:   sp.firstName!,
      lastName:    sp.lastName!,
      displayName: sp.displayName || agencyName || `${sp.firstName} ${sp.lastName}`,
      email:       sp.email  || agency.business_email || "",
      phone:       toE164(sp.phone || agency.business_phone || "") || mobile,
      mobilePhone: mobile,
      street:      sp.street     || agency.business_street      || "",
      city:        sp.city       || agency.business_city        || "",
      state:       sp.state      || agency.business_state       || "",
      postalCode:  sp.postalCode || agency.business_postal_code || "",
      country:     sp.country    || "US",
      vertical:    sp.vertical   || "INSURANCE",
      // Satisfies the sole-prop "website or social URL" requirement with the
      // agent's own generated page — no agent needs to own a website.
      website:     complianceUrls.privacy,
    };
    if (!soleProp.email || !soleProp.street || !soleProp.city || !soleProp.state || !soleProp.postalCode) {
      return json({
        error: "sole_proprietor_info_incomplete",
        detail: "Sole Proprietor registration needs a real physical address and email. Open Settings > Business Profile and complete it.",
      }, 400);
    }
  }

  // ------------------------------------------------------------
  // 4. PRODUCTION GUARD. Sandbox unless explicitly told otherwise.
  // ------------------------------------------------------------
  const envResolved = await resolveTelnyxEnv(TELNYX_API_KEY, body.allow_production === true, user.id);
  if (!envResolved.ok) {
    return json({ error: envResolved.error, detail: envResolved.detail }, envResolved.httpStatus);
  }
  const { env, sandboxBrandId } = envResolved;

  // An existing row from the other environment must not be silently reused —
  // except sandbox -> production, which is the intended promotion path and is
  // allowed by the DB trigger too.
  if (existing?.telnyx_env === "production" && env === "sandbox") {
    return json({
      error: "already_registered_in_production",
      detail: "This agent already has a real production registration. Refusing to overwrite it with a sandbox one.",
    }, 409);
  }
  const promotingToProduction = existing?.telnyx_env === "sandbox" && env === "production";

  // ------------------------------------------------------------
  // 5. Fee configuration. Sole prop's recurring fee is $2/mo, NOT the $10
  //    defaulted for standard brands in billing_config.
  // ------------------------------------------------------------
  const { data: billingConfig } = await sb.from("billing_config")
    .select("a2p_brand_fee_mills, a2p_campaign_fee_mills, a2p_monthly_fee_mills, a2p_sole_prop_monthly_fee_mills")
    .eq("id", 1)
    .maybeSingle();

  const brandFeeMills    = billingConfig?.a2p_brand_fee_mills    ?? 4000;
  const campaignFeeMills = billingConfig?.a2p_campaign_fee_mills ?? 15000;
  const monthlyFeeMills  = brandType === "sole_proprietor"
    ? (billingConfig?.a2p_sole_prop_monthly_fee_mills ?? 2000)
    : (billingConfig?.a2p_monthly_fee_mills ?? 10000);

  // ------------------------------------------------------------
  // 6. Ensure the row exists BEFORE any Telnyx call, so the step machine
  //    always has somewhere to persist to. Nothing billable has happened yet.
  // ------------------------------------------------------------
  const seed = {
    agent_id:          user.id,
    status:            existing?.status && existing.status !== "not_started" ? existing.status : "not_started",
    brand_type:        brandType,
    telnyx_env:        env,
    max_numbers:       brandType === "sole_proprietor" ? SOLE_PROP.maxNumbersPerCampaign : STANDARD_MAX_NUMBERS,
    monthly_fee_mills: monthlyFeeMills,
    brand_fee_mills:   brandFeeMills,
    campaign_fee_mills: campaignFeeMills,
    business_info:     brandType === "sole_proprietor" ? soleProp : business,
    website_url:       complianceUrls.privacy,
    rejection_reason:  null,
  };

  if (promotingToProduction) {
    // Clear the sandbox ids so the machine creates real ones. The DB trigger
    // permits exactly this transition (sandbox -> production) and nothing
    // else; mock brands are never billed, so nothing is orphaned.
    console.warn(`[a2p-register] promoting agent ${user.id} from sandbox to PRODUCTION — sandbox brand/campaign ids cleared.`);
    const { error: promoteErr } = await sb.from("a2p_registrations").update({
      ...seed,
      brand_id: null, campaign_id: null, tcr_brand_id: null, tcr_campaign_id: null,
      brand_submitted_at: null, campaign_submitted_at: null,
      brand_fee_charged_at: null, campaign_fee_charged_at: null,
      otp_status: null, otp_requested_at: null, otp_verified_at: null, otp_attempts: 0,
    }).eq("agent_id", user.id);
    if (promoteErr) return json({ error: "db_write_failed", detail: promoteErr.message }, 500);
  } else {
    const { error: seedErr } = await sb.from("a2p_registrations").upsert(seed, { onConflict: "agent_id" });
    if (seedErr) return json({ error: "db_write_failed", detail: seedErr.message }, 500);
  }

  // Re-read so the machine sees exactly what is stored (including anything a
  // concurrent call may have advanced).
  const { data: freshRaw } = await sb.from("a2p_registrations")
    .select("agent_id, brand_id, campaign_id, status, brand_type, telnyx_env, brand_submitted_at, campaign_submitted_at, brand_fee_charged_at, campaign_fee_charged_at, otp_status, otp_requested_at, otp_sent_to")
    .eq("agent_id", user.id)
    .maybeSingle();
  const row = freshRaw as RegistrationRow;

  // ------------------------------------------------------------
  // 7. Run the step machine.
  // ------------------------------------------------------------
  const campaign = buildCampaignInfo({
    brandId: row.brand_id || sandboxBrandId || "",
    brandType,
    agencyName,
    leadVendors: agency.lead_vendors,
    complianceUrls,
    overrides: body.campaign,
  });

  const result = await advanceRegistration(sb, row, {
    agentId: user.id,
    apiKey: TELNYX_API_KEY,
    env,
    sandboxBrandId,
    brandType,
    business,
    soleProp,
    campaign,
    brandFeeMills,
    campaignFeeMills,
    monthlyFeeMills,
    websiteUrl: complianceUrls.privacy,
  });

  if (!result.ok) {
    return json({
      error: result.error,
      detail: result.detail,
      failed_step: result.failedStep,
      // Even on failure, report what IS persisted — this is what makes the
      // next call a resume rather than a restart, and what tells support
      // whether a billable object exists.
      brand_id: result.brandId ?? null,
      campaign_id: result.campaignId ?? null,
      completed_steps: result.completed,
      resumed_steps: result.resumed,
      fees_charged_mills: result.feesChargedMills,
      telnyx_env: env,
    }, result.httpStatus ?? 502);
  }

  if (result.status === "awaiting_otp") {
    return json({
      ok: true,
      status: "awaiting_otp",
      brand_id: result.brandId,
      brand_type: brandType,
      telnyx_env: env,
      otp_requested_at: result.otpRequestedAt,
      otp_expires_at: result.otpRequestedAt
        ? new Date(Date.parse(result.otpRequestedAt) + 24 * 3600_000).toISOString()
        : null,
      otp_sent_to_masked: maskMobile(soleProp?.mobilePhone ?? row.otp_sent_to),
      detail: `We texted a 6-digit PIN to ${maskMobile(soleProp?.mobilePhone ?? row.otp_sent_to)}. ` +
        `Enter it to finish registering — it expires in 24 hours. You have been charged $${(brandFeeMills / 1000).toFixed(2)} for the brand; ` +
        `the $${(campaignFeeMills / 1000).toFixed(2)} campaign fee is only charged once you verify.`,
      completed_steps: result.completed,
      resumed_steps: result.resumed,
      fees_charged_mills: result.feesChargedMills,
    });
  }

  return json({
    ok: true,
    status: "pending",
    brand_id: result.brandId,
    campaign_id: result.campaignId,
    brand_type: brandType,
    telnyx_env: env,
    completed_steps: result.completed,
    resumed_steps: result.resumed,
    fees_charged_mills: result.feesChargedMills,
    monthly_fee_mills: monthlyFeeMills,
    compliance_urls: complianceUrls,
    max_numbers: brandType === "sole_proprietor" ? SOLE_PROP.maxNumbersPerCampaign : STANDARD_MAX_NUMBERS,
    detail: "Submitted. Carrier review usually takes 3-7 business days; we will assign your texting number automatically once it is approved.",
  });
});
