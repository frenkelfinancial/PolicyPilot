// ============================================================
// phone.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { toE164, isValidE164 } from "./phone.ts";

test("toE164: already-E.164 input passes through unchanged", () => {
  assert.equal(toE164("+15551234567"), "+15551234567");
});

test("toE164: bare 10-digit gets +1 prepended", () => {
  assert.equal(toE164("5551234567"), "+15551234567");
});

test("toE164: 1+10-digit (11 digits starting with 1) gets a + prepended", () => {
  assert.equal(toE164("15551234567"), "+15551234567");
});

test("toE164: punctuated US formats normalize the same way", () => {
  assert.equal(toE164("(555) 123-4567"), "+15551234567");
  assert.equal(toE164("555.123.4567"), "+15551234567");
  assert.equal(toE164("555-123-4567"), "+15551234567");
  assert.equal(toE164("+1 (555) 123-4567"), "+15551234567");
});

test("toE164: empty/garbage input returns \"\"", () => {
  assert.equal(toE164(""), "");
  assert.equal(toE164(null), "");
  assert.equal(toE164(undefined), "");
  assert.equal(toE164("not a phone number"), "");
  assert.equal(toE164("12345"), ""); // too short, no leading +
});

test("toE164: 11 digits NOT starting with 1 and no + is unparseable", () => {
  assert.equal(toE164("25551234567"), "");
});

test("toE164 is idempotent: re-normalizing an already-normalized value is a no-op", () => {
  const inputs = ["+15551234567", "5551234567", "15551234567", "(555) 123-4567"];
  for (const raw of inputs) {
    const once = toE164(raw);
    const twice = toE164(once);
    assert.equal(twice, once, `toE164(toE164(${JSON.stringify(raw)})) should equal toE164(${JSON.stringify(raw)})`);
  }
});

test("isValidE164: true for a well-formed US/CA number in any input format", () => {
  assert.equal(isValidE164("+15551234567"), true);
  assert.equal(isValidE164("5551234567"), true);
  assert.equal(isValidE164("(555) 123-4567"), true);
});

test("isValidE164: false for unparseable or non-US/CA input", () => {
  assert.equal(isValidE164(""), false);
  assert.equal(isValidE164("not a phone number"), false);
  assert.equal(isValidE164("+442071234567"), false); // UK number — not +1
});
