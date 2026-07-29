// ============================================================
// A2P PHASE 2 smoke test — runs the REAL adapter against the Telnyx SANDBOX
// brand. Import-based, so it exercises _shared/telnyx-10dlc-adapter.ts exactly
// as the edge functions do rather than reimplementing it.
//
// Run (Node 24 strips the types; no Deno needed):
//   node --env-file=.env.local scripts/a2p-phase2-smoke.ts
//   node --env-file=.env.local scripts/a2p-phase2-smoke.ts --create-campaign
//
// WHAT IT COSTS: nothing. Every call is against the mock sandbox brand.
// Telnyx bills neither mock brands nor mock campaigns (billedDate stays
// null) — verified 2026-07-27, see docs/telnyx-10dlc-brands.md. The
// --create-campaign flag is opt-in anyway, so the default run creates
// nothing at all.
//
// WHAT IT PROVES (the Phase 2 claims that can only be checked live):
//   1. getBrand() reads the bare /10dlc object — mock + identityStatus.
//      This is what a2p-register's production guard depends on: if `mock`
//      could not be read, the guard would refuse everything or, worse,
//      wave a real brand through.
//   2. getBrandStatus() still normalises identityStatus -> approved.
//   3. submitCampaign() refuses to call out at all without messageFlow.
//   4. POST /v2/10dlc/campaignBuilder is the real create endpoint and
//      accepts our exact field set — probed with a deliberately invalid
//      usecase so nothing is created (the same method used to map the
//      field names on 2026-07-28).
//   5. --create-campaign: a real mock campaign, proving the id parse that
//      the old code got wrong and end-to-end campaign creation.
//
// It does NOT prove a successful number ASSIGNED — a mock brand's campaign
// fails TCR vetting, so Telnyx refuses assignment. That needs the VERIFIED
// production brand and is a deliberate spend decision.
// ============================================================
import {
  getBrand,
  getBrandStatus,
  submitCampaign,
} from "../supabase/functions/_shared/telnyx-10dlc-adapter.ts";
import { buildCampaignInfo } from "../supabase/functions/_shared/a2p-registration.ts";

const apiKey = process.env.TELNYX_API_KEY;
const sandboxBrandId = process.env.TELNYX_SANDBOX_BRAND_ID;
const createCampaign = process.argv.includes("--create-campaign");

if (!apiKey || !sandboxBrandId) {
  console.error("Missing env. Run with:  node --env-file=.env.local scripts/a2p-phase2-smoke.ts");
  console.error(`  TELNYX_API_KEY=${apiKey ? "set" : "MISSING"}  TELNYX_SANDBOX_BRAND_ID=${sandboxBrandId ? "set" : "MISSING"}`);
  process.exit(2);
}

let failures = 0;
function check(name: string, passed: boolean, detail: string) {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  if (!passed) failures++;
}

const URLS = {
  privacy: "https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy",
  terms:   "https://trust.producerstackcrm.com/a/frenkel-financial-agency/terms",
};

// ---- 1. getBrand: the production guard's foundation --------------------
const brand = await getBrand(apiKey, sandboxBrandId);
check(
  "getBrand(sandbox) reads the bare object",
  brand.ok && brand.brandId === sandboxBrandId,
  `ok=${brand.ok} brandId=${brand.brandId ?? "-"} ${brand.error ?? ""}`,
);
check(
  "sandbox brand reports mock=true (the guard's whole basis)",
  brand.mock === true,
  `mock=${brand.mock} identityStatus=${brand.identityStatus ?? "-"} entityType=${brand.entityType ?? "-"}`,
);

// ---- 2. getBrandStatus normalisation ------------------------------------
const status = await getBrandStatus(apiKey, sandboxBrandId);
check(
  "getBrandStatus normalises identityStatus VERIFIED -> approved",
  status.status === "approved" && (status.raw ?? "").toUpperCase() === "VERIFIED",
  `status=${status.status} raw=${status.raw ?? "-"} ${status.error ?? ""}`,
);

// ---- 3. messageFlow is required, and refused locally --------------------
const noFlow = await submitCampaign(apiKey, {
  ...buildCampaignInfo({
    brandId: sandboxBrandId,
    brandType: "standard",
    agencyName: "ProducerStack Smoke Test",
    complianceUrls: URLS,
  }),
  messageFlow: "",
});
check(
  "submitCampaign refuses a blank messageFlow without calling Telnyx",
  !noFlow.ok && (noFlow.error ?? "").startsWith("message_flow_required"),
  noFlow.error ?? "(no error returned — it should have refused)",
);

// ---- 4. campaignBuilder is the real endpoint ----------------------------
// Deliberately invalid usecase => the request is validated and REJECTED, so
// nothing is created. A 404 here would mean the endpoint path is wrong; a
// 4xx that names `usecase` means the path and our field set are right.
const probe = await submitCampaign(apiKey, {
  ...buildCampaignInfo({
    brandId: sandboxBrandId,
    brandType: "standard",
    agencyName: "ProducerStack Smoke Test",
    complianceUrls: URLS,
  }),
  usecase: "DEFINITELY_NOT_A_REAL_USECASE",
});
const probeErr = probe.error ?? "";
check(
  "POST /v2/10dlc/campaignBuilder exists and validated our payload",
  !probe.ok && !probeErr.startsWith("404") && /usecase/i.test(probeErr),
  probeErr.slice(0, 220) || "(unexpectedly succeeded — a campaign may have been created!)",
);

// ---- 5. Optional: create a real mock campaign ---------------------------
if (createCampaign) {
  const info = buildCampaignInfo({
    brandId: sandboxBrandId,
    brandType: "standard",
    agencyName: "ProducerStack Smoke Test",
    complianceUrls: URLS,
  });
  const created = await submitCampaign(apiKey, info);
  check(
    "campaignBuilder created a mock campaign and the id parsed",
    created.ok && !!created.campaignId,
    `campaignId=${created.campaignId ?? "-"} status=${created.campaignStatus ?? "-"} mock=${created.mock} ${created.error ?? ""}`,
  );
  if (created.ok) {
    console.log(`\n      NOTE: mock campaign ${created.campaignId} created on the sandbox brand.`);
    console.log("      It is free (mock, billedDate null) and will go TCR_PENDING -> TCR_FAILED,");
    console.log("      because the mock brand's placeholder EIN cannot pass TCR vetting.");
  }
} else {
  console.log("SKIP  create a real mock campaign\n      pass --create-campaign to exercise the full create path (free, sandbox only)");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
