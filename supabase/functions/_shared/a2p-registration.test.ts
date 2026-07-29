// ============================================================
// a2p-registration.test.ts — run with:  npm run test:a2p   (Node 24, no deps)
//
// Covers the pure parts of the A2P step machine: the OTP clock, the mobile
// mask, and — most importantly — the campaign payload builder, which is where
// a silent mistake is most expensive. campaignBuilder DISCARDS unknown fields
// without complaining, so a wrong field name is not an error, it is a no-op
// that looks like success. These tests are the standing check that we never
// reintroduce one.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCampaignInfo,
  isOtpExpired,
  maskMobile,
  otpMsRemaining,
  ONE_NUMBER_EXPLANATION,
  OTP_WINDOW_HOURS,
  SOLE_PROP,
  STANDARD_MAX_NUMBERS,
} from "./a2p-registration.ts";

const URLS = {
  privacy: "https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy",
  terms:   "https://trust.producerstackcrm.com/a/frenkel-financial-agency/terms",
};

const baseOpts = {
  brandId: "brand-123",
  agencyName: "Frenkel Financial Agency",
  complianceUrls: URLS,
};

// ---------- OTP clock ----------

test("otpMsRemaining counts down from the 24h window", () => {
  const now = Date.parse("2026-07-28T12:00:00Z");
  const requested = new Date(now - 3600_000).toISOString(); // 1h ago
  assert.equal(otpMsRemaining(requested, now), (OTP_WINDOW_HOURS - 1) * 3600_000);
});

test("otpMsRemaining is 0 (not negative-as-valid) with no timestamp", () => {
  assert.equal(otpMsRemaining(null), 0);
  assert.equal(otpMsRemaining(undefined), 0);
  assert.equal(otpMsRemaining("not a date"), 0);
});

test("isOtpExpired: false at 23h59m, true at exactly 24h", () => {
  const now = Date.parse("2026-07-28T12:00:00Z");
  const almost = new Date(now - (24 * 3600_000 - 60_000)).toISOString();
  const exact  = new Date(now - 24 * 3600_000).toISOString();
  assert.equal(isOtpExpired(almost, now), false);
  assert.equal(isOtpExpired(exact, now), true);
});

test("isOtpExpired fails CLOSED when the timestamp is missing", () => {
  // An unknown OTP age must read as expired, never as valid — the cost of a
  // wrong "still valid" is the agent typing a dead PIN and being told it is
  // simply wrong.
  assert.equal(isOtpExpired(null), true);
});

// ---------- mobile mask ----------

test("maskMobile shows only the last four digits", () => {
  assert.equal(maskMobile("+19204227733"), "(•••) •••-7733");
});

test("maskMobile degrades to prose rather than leaking a partial number", () => {
  assert.equal(maskMobile(""), "your mobile number");
  assert.equal(maskMobile(null), "your mobile number");
  assert.equal(maskMobile("+1"), "your mobile number");
});

// ---------- campaign payload ----------

test("sole prop uses usecase SOLE_PROPRIETOR — never LOW_VOLUME", () => {
  const info = buildCampaignInfo({ ...baseOpts, brandType: "sole_proprietor" });
  assert.equal(info.usecase, "SOLE_PROPRIETOR");
});

test("a sole-prop campaign cannot be talked out of its usecase by an override", () => {
  // A sole-prop brand only accepts SOLE_PROPRIETOR; honouring a caller
  // override here would produce a rejection days later.
  const info = buildCampaignInfo({
    ...baseOpts,
    brandType: "sole_proprietor",
    overrides: { usecase: "LOW_VOLUME" },
  });
  assert.equal(info.usecase, "SOLE_PROPRIETOR");
});

test("standard brands default to LOW_VOLUME and accept an override", () => {
  assert.equal(buildCampaignInfo({ ...baseOpts, brandType: "standard" }).usecase, "LOW_VOLUME");
  assert.equal(
    buildCampaignInfo({ ...baseOpts, brandType: "standard", overrides: { usecase: "MIXED" } }).usecase,
    "MIXED",
  );
});

test("messageFlow is always populated — campaignBuilder rejects the campaign without it", () => {
  const info = buildCampaignInfo({ ...baseOpts, brandType: "standard" });
  assert.ok(info.messageFlow && info.messageFlow.trim().length > 50);
});

test("messageFlow carries BOTH compliance URLs — the campaign has no link field", () => {
  // This is the only campaign-side route by which a reviewer sees them.
  const info = buildCampaignInfo({ ...baseOpts, brandType: "standard" });
  assert.ok(info.messageFlow.includes(URLS.privacy), "privacy URL missing from messageFlow");
  assert.ok(info.messageFlow.includes(URLS.terms), "terms URL missing from messageFlow");
});

// Inverted 2026-07-28. This test used to assert messageFlow NAMED the lead
// vendor. Carrier review item 1 on campaign CD2166Q was that our opt-in
// evidence pointed at a third party's disclosure while the campaign sends as
// the agency — naming a lead company in this field is what sends the reviewer
// to that document. The vendor names in this repo were also the wrong
// companies. So the requirement is now the opposite one.
test("messageFlow names NO lead company, and says the opt-in page is the only route in", () => {
  const info = buildCampaignInfo({ ...baseOpts, brandType: "standard" });
  for (const name of ["GoatLeads", "Built Leads", "The Veteran Resource Center", "TrustedForm"]) {
    assert.ok(!info.messageFlow.includes(name), `"${name}" is named in messageFlow`);
  }
  assert.ok(info.messageFlow.includes("sole way a mobile number enters this campaign"));
});

test("NO compliance-link fields are ever emitted — they are silently discarded by Telnyx", () => {
  const info = buildCampaignInfo({ ...baseOpts, brandType: "standard" }) as Record<string, unknown>;
  for (const dead of [
    "privacyPolicyLink", "termsAndConditionsLink", "privacyPolicyURL",
    "termsAndConditionsURL", "privacyPolicy", "privacyPolicyUrl", "termsAndConditionsUrl",
  ]) {
    assert.equal(info[dead], undefined, `${dead} is not a real Telnyx field and must not be sent`);
  }
});

test("termsAndConditions is a boolean attestation, never a URL", () => {
  const info = buildCampaignInfo({ ...baseOpts, brandType: "standard" });
  assert.equal(typeof info.termsAndConditions, "boolean");
  assert.equal(info.termsAndConditions, true);
});

test("at least two samples are produced — campaignBuilder requires sample1 and sample2", () => {
  const info = buildCampaignInfo({ ...baseOpts, brandType: "sole_proprietor" });
  assert.ok(info.sampleMessages.length >= 2);
  for (const s of info.sampleMessages) {
    assert.ok(s.includes("STOP"), "every sample must show the opt-out keyword");
  }
});

test("embeddedPhone is declared true because our samples name a phone number", () => {
  // Declaring false while a sample contains a number is a rejection reason.
  const info = buildCampaignInfo({ ...baseOpts, brandType: "standard" });
  assert.equal(info.embeddedPhone, true);
});

test("keyword auto-responses are populated and carry the required disclosures", () => {
  const info = buildCampaignInfo({ ...baseOpts, brandType: "standard" });
  assert.ok(info.optinMessage?.includes("Msg&data rates may apply"));
  assert.ok(info.optinMessage?.includes("Consent is not a condition of purchase"));
  assert.ok(info.optoutMessage?.includes("unsubscribed"));
  assert.ok(info.helpMessage?.includes("STOP"));
});

// ---------- limits ----------

test("sole-prop limits match the documented Telnyx caps", () => {
  assert.equal(SOLE_PROP.maxCampaignsPerBrand, 1);
  assert.equal(SOLE_PROP.maxNumbersPerCampaign, 1);
  assert.equal(SOLE_PROP.maxBrandsPerMobile, 3);
  assert.equal(SOLE_PROP.dailyMessageCap, 1000);
  assert.equal(STANDARD_MAX_NUMBERS, 49);
});

test("the one-number message explains the rule in plain language, with no API jargon", () => {
  assert.ok(ONE_NUMBER_EXPLANATION.includes("one texting number"));
  // PROMPT_15: "an explanatory message rather than a raw API error".
  for (const jargon of ["10036", "assignmentStatus", "FAILED_ASSIGNMENT", "campaignId", "400"]) {
    assert.ok(!ONE_NUMBER_EXPLANATION.includes(jargon), `explanation must not leak "${jargon}"`);
  }
});
