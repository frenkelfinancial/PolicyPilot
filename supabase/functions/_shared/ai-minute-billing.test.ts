// ============================================================
// ai-minute-billing.test.ts — run with:  node --test supabase/functions/_shared/ai-minute-billing.test.ts
// Proves the AI-minute volume tier boundary: the 2,000th minute of the month
// bills at the base rate, the 2,001st bills at the volume rate. Keep in sync
// with the SQL RPC public.wallet_debit_ai_minutes.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitAiMinutes,
  aiMinuteCostMills,
  DEFAULT_AI_MINUTE_RATES,
} from "./ai-minute-billing.ts";

const R = DEFAULT_AI_MINUTE_RATES; // { base 75, volume 65, threshold 2000 }

// ── The load-bearing boundary: minute 2,000 vs minute 2,001 ────────────────

test("the 2,000th AI minute of the month bills at the BASE rate (75 mills)", () => {
  // 1,999 already used this month; this 1 minute is the 2,000th → still base.
  const split = splitAiMinutes(1999, 1, R);
  assert.equal(split.baseMinutes, 1);
  assert.equal(split.volumeMinutes, 0);
  assert.equal(split.amountMills, 75);
});

test("the 2,001st AI minute of the month bills at the VOLUME rate (65 mills)", () => {
  // Exactly 2,000 already used; this 1 minute is the 2,001st → volume rate.
  const split = splitAiMinutes(2000, 1, R);
  assert.equal(split.baseMinutes, 0);
  assert.equal(split.volumeMinutes, 1);
  assert.equal(split.amountMills, 65);
});

// ── A batch that straddles the threshold splits correctly ──────────────────

test("a batch straddling the threshold splits base + volume minutes", () => {
  // mtd 1,998 + 5 minutes → minutes 1,999 & 2,000 at base, 2,001-2,003 volume.
  const split = splitAiMinutes(1998, 5, R);
  assert.equal(split.baseMinutes, 2);
  assert.equal(split.volumeMinutes, 3);
  assert.equal(split.amountMills, 2 * 75 + 3 * 65); // 150 + 195 = 345
});

// ── Ends of the range ──────────────────────────────────────────────────────

test("entirely below the threshold is all base rate", () => {
  assert.equal(aiMinuteCostMills(0, 100, R), 100 * 75);
});

test("entirely above the threshold is all volume rate", () => {
  assert.equal(aiMinuteCostMills(5000, 10, R), 10 * 65);
});

test("landing exactly on the threshold keeps every minute at base", () => {
  // 0 used + exactly 2,000 minutes = minutes 1..2,000, all base rate.
  const split = splitAiMinutes(0, 2000, R);
  assert.equal(split.baseMinutes, 2000);
  assert.equal(split.volumeMinutes, 0);
  assert.equal(split.amountMills, 2000 * 75);
});

test("one minute past a full-base month is all volume", () => {
  // 0 used + 2,001 minutes = 2,000 base + 1 volume.
  const split = splitAiMinutes(0, 2001, R);
  assert.equal(split.baseMinutes, 2000);
  assert.equal(split.volumeMinutes, 1);
  assert.equal(split.amountMills, 2000 * 75 + 1 * 65);
});

// ── Guards ─────────────────────────────────────────────────────────────────

test("zero minutes costs nothing", () => {
  assert.equal(aiMinuteCostMills(1990, 0, R), 0);
});

test("negative / fractional inputs are floored and clamped", () => {
  assert.equal(aiMinuteCostMills(-50, 3.9, R), 3 * 75); // mtd floored to 0, minutes floored to 3
});
