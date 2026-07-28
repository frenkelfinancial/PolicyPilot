// A2P Phase 1 smoke test — runs the REAL adapter code against the Telnyx
// SANDBOX brand so it never touches production A2P data. Import-based, so it
// exercises _shared/telnyx-10dlc-adapter.ts exactly as the edge functions do
// (not a reimplementation) — a live regression test for the bare-object
// response parsing fixed on 2026-07-27.
//
// Run:
//   set -a; . ./.env.local; set +a       # loads TELNYX_API_KEY + TELNYX_SANDBOX_BRAND_ID
//   deno run --allow-env --allow-net scripts/a2p-sandbox-smoke.ts
//   # optional: also probe one number's assignment status
//   deno run --allow-env --allow-net scripts/a2p-sandbox-smoke.ts +12026143091
//
// What it asserts:
//   • getBrandStatus(sandbox brand) resolves to status="approved"
//     (identityStatus VERIFIED) — proves the bare /10dlc/* object is parsed.
//   • getNumberAssignmentStatus(number), if given, returns cleanly (404 =>
//     found:false when the number isn't assigned).
//
// NOTE: this does NOT create a campaign or assign a number. Mock-brand
// campaigns fail TCR (TCR_FAILED), so Telnyx refuses assignment — a full
// ASSIGNED path can only be proven on the VERIFIED production brand. See
// docs/telnyx-10dlc-brands.md.

import { getBrandStatus, getNumberAssignmentStatus } from "../supabase/functions/_shared/telnyx-10dlc-adapter.ts";

const apiKey = Deno.env.get("TELNYX_API_KEY");
const sandboxBrandId = Deno.env.get("TELNYX_SANDBOX_BRAND_ID");
const probeNumber = Deno.args[0];

if (!apiKey || !sandboxBrandId) {
  console.error("Missing env. Load them first, e.g.:  set -a; . ./.env.local; set +a");
  console.error(`  TELNYX_API_KEY=${apiKey ? "set" : "MISSING"}  TELNYX_SANDBOX_BRAND_ID=${sandboxBrandId ? "set" : "MISSING"}`);
  Deno.exit(2);
}

let failures = 0;

// 1. Brand status — proves the bare-object identityStatus parse.
const brand = await getBrandStatus(apiKey, sandboxBrandId);
const brandOk = brand.status === "approved" && (brand.raw ?? "").toUpperCase() === "VERIFIED";
console.log(`getBrandStatus(sandbox): status=${brand.status} raw=${brand.raw ?? "-"}${brand.error ? " error=" + brand.error : ""}  -> ${brandOk ? "PASS" : "FAIL"}`);
if (!brandOk) failures++;

// 2. Optional per-number assignment status.
if (probeNumber) {
  const st = await getNumberAssignmentStatus(apiKey, probeNumber);
  const stOk = st.ok; // a clean call (found true/false) is a pass; only a real API error fails
  console.log(`getNumberAssignmentStatus(${probeNumber}): ok=${st.ok} found=${st.found} assignmentStatus=${st.assignmentStatus ?? "-"}${st.error ? " error=" + st.error : ""}  -> ${stOk ? "PASS" : "FAIL"}`);
  if (!stOk) failures++;
}

console.log(failures === 0 ? "\nSMOKE TEST PASSED" : `\nSMOKE TEST FAILED (${failures})`);
Deno.exit(failures === 0 ? 0 : 1);
