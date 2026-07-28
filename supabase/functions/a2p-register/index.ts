import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { submitBrand, submitCampaign, type BusinessInfo, type CampaignInfo } from "../_shared/telnyx-10dlc-adapter.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type AgencyProfile,
  agencyDisplayName,
  compliancePageUrls,
  DEFAULT_COMPLIANCE_BASE_URL,
  missingComplianceFields,
} from "../_shared/compliance-page.ts";
import { buildOptinDescription } from "../_shared/lead-vendors.ts";

// Drives Telnyx 10DLC brand + campaign registration on the agent's behalf.
// Submits both in one call (brand first, then campaign against the new
// brandId) and stores the row as 'pending' — a2p-status-poll (cron) is what
// flips it to approved/rejected once Telnyx/the carriers finish review.
// SMS/MMS sends are blocked by the compliance gate (_shared/messaging-
// shared.ts) until status = 'approved'.
//
// Fee handling: debits the wallet for brand_fee_mills + campaign_fee_mills
// as pass-through a2p_registration line items, using the TRUE amount from
// Telnyx's response when present, falling back to the billing_config
// defaults (flagged in the ledger description) when Telnyx doesn't return
// a price synchronously — see _shared/telnyx-10dlc-adapter.ts header for
// what to verify before go-live.
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

  let body: { business_info?: Partial<BusinessInfo>; campaign?: Partial<CampaignInfo> };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const info = body.business_info;
  if (!info?.displayName || !info?.companyName || !info?.ein || !info?.entityType || !info?.email || !info?.phone) {
    return json({ error: "business_info_incomplete" }, 400);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: existing } = await sb.from("a2p_registrations")
    .select("status")
    .eq("agent_id", user.id)
    .maybeSingle();
  if (existing && existing.status !== "not_started" && existing.status !== "rejected") {
    return json({ error: "already_registered", detail: `Current status: ${existing.status}` }, 409);
  }

  // ------------------------------------------------------------
  // PROMPT_16 gate: no published compliance page, no submission.
  //
  // 10DLC review requires a publicly reachable privacy policy and terms page
  // belonging to the messaging business. Submitting without one does not fail
  // fast — it fails DAYS later as a carrier rejection, after we have already
  // charged the agent a non-refundable brand + campaign fee below. So the
  // check happens here, before the first Telnyx call and before any debit.
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
    // Name the specific fields, so the UI can say "add your ZIP code" rather
    // than "something is missing".
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
  const agencyName = agencyDisplayName(agency) || info.companyName;

  const businessInfo: BusinessInfo = {
    displayName:  info.displayName,
    companyName:  info.companyName,
    ein:          info.ein,
    entityType:   info.entityType,
    vertical:     info.vertical || "INSURANCE",
    email:        info.email,
    phone:        info.phone,
    street:       info.street || "",
    city:         info.city || "",
    state:        info.state || "",
    postalCode:   info.postalCode || "",
    country:      info.country || "US",
    // The generated privacy policy IS the brand's website. Deliberately not
    // `info.website`: a client-supplied URL is exactly the mismatch this
    // whole feature exists to eliminate — a recruiting site aimed at other
    // agents, or the lead vendor's domain, neither of which describes the
    // business sending the messages. This URL always does.
    website:      complianceUrls.privacy,
  };

  const brandResult = await submitBrand(TELNYX_API_KEY, businessInfo);
  if (!brandResult.ok || !brandResult.brandId) {
    return json({ error: "brand_submit_failed", detail: brandResult.error }, 502);
  }

  const { data: billingConfig } = await sb.from("billing_config")
    .select("a2p_brand_fee_mills, a2p_campaign_fee_mills, a2p_monthly_fee_mills")
    .eq("id", 1)
    .maybeSingle();

  const campaignInfo: CampaignInfo = {
    brandId:          brandResult.brandId,
    usecase:          body.campaign?.usecase || "LOW_VOLUME",
    // PROMPT_16 Phase 5: one shared opt-in workflow description, reused for
    // every agent with only the vendor + agency name substituted, so it has
    // to survive carrier review once instead of once per agent. It names the
    // same vendors the generated privacy policy names — a reviewer comparing
    // the two and finding a mismatch is the fastest route to a rejection.
    description:      body.campaign?.description || buildOptinDescription(agencyName, agency.lead_vendors),
    sampleMessages:   body.campaign?.sampleMessages?.length ? body.campaign.sampleMessages : [
      "Hi {name}, this is {agent} from {company} confirming our appointment on {date}. Reply STOP to opt out.",
      "Hi {name}, your policy documents are ready for review. Reply STOP to opt out.",
    ],
    subscriberOptin:  body.campaign?.subscriberOptin ?? true,
    subscriberOptout: body.campaign?.subscriberOptout ?? true,
    subscriberHelp:   body.campaign?.subscriberHelp ?? true,
    embeddedLink:     body.campaign?.embeddedLink ?? false,
    embeddedPhone:    body.campaign?.embeddedPhone ?? false,
    ageGated:         body.campaign?.ageGated ?? false,
    directLending:    body.campaign?.directLending ?? false,
    privacyPolicyLink:      complianceUrls.privacy,
    termsAndConditionsLink: complianceUrls.terms,
  };

  const campaignResult = await submitCampaign(TELNYX_API_KEY, campaignInfo);
  if (!campaignResult.ok || !campaignResult.campaignId) {
    return json({ error: "campaign_submit_failed", detail: campaignResult.error, brand_id: brandResult.brandId }, 502);
  }

  const brandFeeMills    = brandResult.feeMills    ?? billingConfig?.a2p_brand_fee_mills    ?? 4000;
  const campaignFeeMills = campaignResult.feeMills ?? billingConfig?.a2p_campaign_fee_mills ?? 15000;
  const monthlyFeeMills  = campaignResult.monthlyFeeMills ?? billingConfig?.a2p_monthly_fee_mills ?? 10000;
  const totalFeeMills    = brandFeeMills + campaignFeeMills;

  await sb.from("a2p_registrations").upsert({
    agent_id:           user.id,
    brand_id:           brandResult.brandId,
    campaign_id:        campaignResult.campaignId,
    status:             "pending",
    brand_fee_mills:    brandFeeMills,
    campaign_fee_mills: campaignFeeMills,
    monthly_fee_mills:  monthlyFeeMills,
    business_info:      businessInfo,
    // Fulfils the sole-prop "website or social URL" requirement with the
    // agent's own generated page — this is what replaced the TODO(PROMPT_16)
    // marker on this column in 20260728_a2p_sole_proprietor.sql.
    website_url:        complianceUrls.privacy,
    rejection_reason:   null,
    registered_at:      new Date().toISOString(),
  }, { onConflict: "agent_id" });

  // Pass-through debit for the one-time registration fees. This is a
  // straight debit (not a hold) — the fee is owed the moment Telnyx accepts
  // the submission, regardless of eventual approval/rejection.
  const { error: debitErr } = await sb.rpc("wallet_debit", {
    p_agent:        user.id,
    p_category:     "a2p_registration",
    p_units:        null,
    p_amount_mills: totalFeeMills,
    p_ref_type:     "a2p_registration",
    p_ref_id:       campaignResult.campaignId,
    p_desc:         `A2P 10DLC brand + campaign registration — $${(totalFeeMills / 1000).toFixed(2)} (brand $${(brandFeeMills / 1000).toFixed(2)} + campaign $${(campaignFeeMills / 1000).toFixed(2)})`,
  });

  if (debitErr) {
    console.error("[a2p-register] pass-through debit failed (registration already submitted to Telnyx):", debitErr.message);
    // Do not fail the request — the registration is real and submitted;
    // an uncollectible fee here needs manual reconciliation, not a silent
    // retry that would double-submit to Telnyx.
  }

  return json({
    ok: true,
    brand_id: brandResult.brandId,
    campaign_id: campaignResult.campaignId,
    status: "pending",
    fees_charged_mills: debitErr ? 0 : totalFeeMills,
    compliance_urls: complianceUrls,
  });
});
