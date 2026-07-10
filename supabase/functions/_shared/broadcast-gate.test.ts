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

test("an unrecognized reason fails closed to skip, never to send", () => {
  const outcome = classifyGateReason("some_future_gate_reason_not_yet_handled");
  assert.notEqual(outcome.action, "send");
  assert.notEqual(outcome.action, "defer"); // fail-closed means skip, not silently retry forever either
});
