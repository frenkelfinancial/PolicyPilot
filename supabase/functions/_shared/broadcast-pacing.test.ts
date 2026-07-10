// ============================================================
// broadcast-pacing.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { sendDelayMs } from "./broadcast-pacing.ts";

test("1 send/sec paces at 1000ms between sends", () => {
  assert.equal(sendDelayMs(1), 1000);
});

test("2 sends/sec paces at 500ms between sends", () => {
  assert.equal(sendDelayMs(2), 500);
});

test("10 sends/sec paces at 100ms between sends", () => {
  assert.equal(sendDelayMs(10), 100);
});

test("zero, negative, or NaN tps falls back to the conservative 1/s default", () => {
  assert.equal(sendDelayMs(0), 1000);
  assert.equal(sendDelayMs(-5), 1000);
  assert.equal(sendDelayMs(NaN), 1000);
});
