// ============================================================
// broadcast-gate.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyGateReason } from "./broadcast-gate.ts";

test("quiet_hours DEFERS (leaves pending) — it is never treated as a skip", () => {
  const outcome = classifyGateReason("quiet_hours");
  assert.deepEqual(outcome, { action: "defer" });
});

test("a2p_not_approved HALTS the whole broadcast, not just one recipient", () => {
  const outcome = classifyGateReason("a2p_not_approved");
  assert.deepEqual(outcome, { action: "halt" });
});

test("no_consent skips with skip_reason=no_consent", () => {
  assert.deepEqual(classifyGateReason("no_consent"), { action: "skip", skipReason: "no_consent" });
});

test("on_dnc_list skips with skip_reason=on_dnc", () => {
  assert.deepEqual(classifyGateReason("on_dnc_list"), { action: "skip", skipReason: "on_dnc" });
});

test("invalid_phone skips with skip_reason=invalid_phone", () => {
  assert.deepEqual(classifyGateReason("invalid_phone"), { action: "skip", skipReason: "invalid_phone" });
});

test("daily_limit_reached HALTS — the recipients are valid, the quota is spent", () => {
  // Skipping would permanently discard recipients who are simply on the wrong
  // side of a sole-prop campaign's ~1,000/day ceiling. Halting leaves them
  // pending so the next run sends them once the day rolls over.
  assert.deepEqual(classifyGateReason("daily_limit_reached"), { action: "halt" });
});

test("no_sms_capable_number HALTS — it is agent-wide, not recipient-specific", () => {
  assert.deepEqual(classifyGateReason("no_sms_capable_number"), { action: "halt" });
});

test("an unrecognized reason fails closed to skip, never to send", () => {
  const outcome = classifyGateReason("some_future_gate_reason_not_yet_handled");
  assert.notEqual(outcome.action, "send");
  assert.notEqual(outcome.action, "defer"); // fail-closed means skip, not silently retry forever either
});
