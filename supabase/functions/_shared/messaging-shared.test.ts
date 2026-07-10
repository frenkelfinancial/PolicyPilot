// ============================================================
// messaging-shared.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
//
// Only exercises the pure helpers exported from messaging-shared.ts —
// runComplianceGate itself takes a live Supabase client and isn't unit
// tested here.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { isConsentTypeAcceptable, bodyPreview } from "./messaging-shared.ts";

test("strict mode (sms_require_written_consent=true, the default) only accepts express_written", () => {
  assert.equal(isConsentTypeAcceptable("express_written", true), true);
  assert.equal(isConsentTypeAcceptable("express", true), false);
  assert.equal(isConsentTypeAcceptable("none", true), false);
});

test("relaxed mode (sms_require_written_consent=false) accepts express_written or express", () => {
  assert.equal(isConsentTypeAcceptable("express_written", false), true);
  assert.equal(isConsentTypeAcceptable("express", false), true);
  assert.equal(isConsentTypeAcceptable("none", false), false);
});

test("CSV import legal guardrail: a plain 'express' consent basis (never auto-upgraded to express_written) is rejected under the default strict TCPA rule", () => {
  // messaging-recipients-import writes exactly the consent_type the agent
  // supplied — it never invents express_written. This proves that an
  // honestly-recorded 'express' row is correctly blocked by the default
  // gate, matching PROMPT_07 §3/§6's "skipped by the gate, zero holds".
  assert.equal(isConsentTypeAcceptable("express", true), false);
});

test("bodyPreview passes short text through trimmed, unmodified", () => {
  assert.equal(bodyPreview("  hello there  "), "hello there");
});

test("bodyPreview truncates long text at 200 chars with an ellipsis", () => {
  const long = "a".repeat(250);
  const preview = bodyPreview(long);
  assert.equal(preview.length, 201); // 200 chars + the ellipsis character
  assert.ok(preview.endsWith("…"));
});
