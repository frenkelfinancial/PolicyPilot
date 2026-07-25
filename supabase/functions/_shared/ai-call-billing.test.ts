// ============================================================
// ai-call-billing.test.ts — run with:  npm run test:ai   (Node 24, no deps)
//
// Covers the webhook-side helpers:
//   • computeBilledMinutes — talk-time rounding (ceil, min 1; 0 for a call
//     that never connected — voicemail / no-answer).
//   • debitAiCallOnce — the idempotency contract that guarantees a REPLAYED
//     hangup webhook debits the wallet exactly once (the prompt's "same
//     hangup event twice → exactly one ledger debit").
//   • normalizeOutcome — coercion of assistant/AMD outcome strings.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeBilledMinutes,
  debitAiCallOnce,
  normalizeOutcome,
} from "./ai-call-billing.ts";

// ---- computeBilledMinutes ----------------------------------------------

test("computeBilledMinutes: a call that never connected bills 0", () => {
  assert.equal(computeBilledMinutes(0), 0);
  assert.equal(computeBilledMinutes(-5), 0);
  assert.equal(computeBilledMinutes(NaN), 0);
});

test("computeBilledMinutes: answered calls round UP with a 1-minute minimum", () => {
  assert.equal(computeBilledMinutes(1), 1);
  assert.equal(computeBilledMinutes(59), 1);
  assert.equal(computeBilledMinutes(60), 1);
  assert.equal(computeBilledMinutes(61), 2);
  assert.equal(computeBilledMinutes(120), 2);
  assert.equal(computeBilledMinutes(121), 3);
  assert.equal(computeBilledMinutes(300), 5); // the 5-minute assistant cap
});

// ---- debitAiCallOnce: webhook replay → exactly one debit ---------------

test("debitAiCallOnce: replayed hangup event debits exactly once", async () => {
  // In-memory stand-in for wallet_ledger keyed by ref_id (call_control_id).
  const ledger: Array<{ ref: string }> = [];
  const ref = "v3:call-control-abc";
  const deps = {
    hasExistingDebit: () => ledger.some((r) => r.ref === ref),
    debit: () => { ledger.push({ ref }); },
  };

  const first  = await debitAiCallOnce(deps);
  const second = await debitAiCallOnce(deps); // the replay

  assert.equal(first.debited, true, "first delivery debits");
  assert.equal(second.debited, false, "replay is a no-op");
  assert.equal(ledger.length, 1, "exactly one ledger debit after two deliveries");
});

test("debitAiCallOnce: honors async hasExistingDebit / debit", async () => {
  const ledger: string[] = [];
  const ref = "async-ref";
  const deps = {
    hasExistingDebit: async () => ledger.includes(ref),
    debit: async () => { await Promise.resolve(); ledger.push(ref); },
  };

  await debitAiCallOnce(deps);
  await debitAiCallOnce(deps);
  await debitAiCallOnce(deps);

  assert.equal(ledger.length, 1);
});

test("debitAiCallOnce: a fresh call still debits after a different call was billed", async () => {
  const ledger: string[] = [];
  const mk = (ref: string) => ({
    hasExistingDebit: () => ledger.includes(ref),
    debit: () => { ledger.push(ref); },
  });

  await debitAiCallOnce(mk("call-1"));
  await debitAiCallOnce(mk("call-1")); // replay of call-1
  const other = await debitAiCallOnce(mk("call-2")); // a different call

  assert.equal(other.debited, true);
  assert.deepEqual(ledger, ["call-1", "call-2"]);
});

// ---- normalizeOutcome ---------------------------------------------------

test("normalizeOutcome: passes through known outcomes (case/space/dash tolerant)", () => {
  assert.equal(normalizeOutcome("qualified"), "qualified");
  assert.equal(normalizeOutcome("  Qualified "), "qualified");
  assert.equal(normalizeOutcome("no-answer"), "no_answer");
  assert.equal(normalizeOutcome("NOT_INTERESTED"), "not_interested");
});

test("normalizeOutcome: maps opt-out + machine synonyms", () => {
  assert.equal(normalizeOutcome("dnc"), "dnc_request");
  assert.equal(normalizeOutcome("remove me"), "dnc_request");
  assert.equal(normalizeOutcome("stop"), "dnc_request");
  assert.equal(normalizeOutcome("machine"), "voicemail");
  assert.equal(normalizeOutcome("answering machine"), "voicemail");
});

test("normalizeOutcome: unknown input falls back (default error; overridable)", () => {
  assert.equal(normalizeOutcome("blahblah"), "error");
  assert.equal(normalizeOutcome(undefined), "error");
  assert.equal(normalizeOutcome(null), "error");
  assert.equal(normalizeOutcome("blahblah", "in_progress"), "in_progress");
});
