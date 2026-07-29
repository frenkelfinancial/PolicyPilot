// ============================================================
// statement-ai.test.ts — run with:  npm run test:backoffice
//
// Covers the pure parts of the AI layer: the coercion that turns a model's
// answer into a ColumnMapping, and the base64 encoder that feeds a PDF to the
// document block. Nothing here makes a network call.
//
// The coercion is worth testing hard for one reason: a wrong column index is
// applied to every row of the sheet mechanically, so it does not fail — it
// produces thousands of confidently blank or confidently wrong rows.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceMapping, bytesToBase64, STATEMENT_MODEL, PDF_MAX_BYTES } from "./statement-ai.ts";
import { applyMapping, previewSheet, type Sheet } from "./statement-core.ts";

test("coerceMapping keeps valid indexes and drops the -1 placeholders", () => {
  const { mapping } = coerceMapping({
    columns: {
      policy_number: 0, insured_name: 1, carrier: -1, producer_code: -1, product: -1,
      transaction_type: 2, amount: 3, premium: -1, commission_rate: -1,
      transaction_date: 4, effective_date: -1, paid_date: -1,
    },
    carrier: "Americo",
    period_start: "2026-07-01",
    period_end: "2026-07-31",
    type_map: [{ value: "First Year", type: "advance" }],
    confidence: 0.92,
    notes: "",
  }, 5);

  assert.deepEqual(mapping.columns, {
    policy_number: 0, insured_name: 1, transaction_type: 2, amount: 3, transaction_date: 4,
  });
  assert.equal(mapping.carrier, "Americo");
  assert.equal(mapping.periodStart, "2026-07-01");
  assert.equal(mapping.notes, null, "an empty note is no note");
});

test("coerceMapping records a type map case-insensitively", () => {
  const { mapping } = coerceMapping({
    columns: {}, carrier: "", period_start: "", period_end: "", confidence: 1, notes: "",
    type_map: [{ value: "CHARGE BACK", type: "chargeback" }],
  }, 3);
  assert.equal(mapping.typeMap!["CHARGE BACK"], "chargeback");
  assert.equal(mapping.typeMap!["charge back"], "chargeback");
});

test("coerceMapping discards a transaction type outside our vocabulary", () => {
  const { mapping } = coerceMapping({
    columns: {}, carrier: "", period_start: "", period_end: "", confidence: 1, notes: "",
    type_map: [{ value: "Weird", type: "teleport" }, { value: "Good", type: "renewal" }],
  }, 3);
  assert.equal(mapping.typeMap!["Weird"], undefined);
  assert.equal(mapping.typeMap!["Good"], "renewal");
});

test("coerceMapping refuses an index far outside the sheet", () => {
  const { mapping } = coerceMapping({
    columns: { policy_number: 0, amount: 9999 },
    carrier: "", period_start: "", period_end: "", type_map: [], confidence: 1, notes: "",
  }, 4);
  assert.equal(mapping.columns.policy_number, 0);
  assert.equal(mapping.columns.amount, undefined, "an out-of-range index must not become a silently blank column");
});

test("coerceMapping survives a malformed answer without throwing", () => {
  for (const junk of [{}, { columns: null }, { columns: { amount: "two" } }, { type_map: "nope" }]) {
    const { mapping, confidence } = coerceMapping(junk as Record<string, unknown>, 3);
    assert.deepEqual(mapping.columns, {});
    assert.equal(typeof confidence, "number");
  }
});

test("coerceMapping clamps confidence into 0-1", () => {
  assert.equal(coerceMapping({ confidence: 7 } as Record<string, unknown>, 3).confidence, 1);
  assert.equal(coerceMapping({ confidence: -3 } as Record<string, unknown>, 3).confidence, 0);
  assert.equal(coerceMapping({} as Record<string, unknown>, 3).confidence, 0.5);
});

test("a coerced mapping drives the deterministic projection end to end", () => {
  const sheet: Sheet = {
    name: "S",
    rows: [
      ["Policy", "Insured", "Type", "Commission"],
      ["BU1", "Smith, Jane", "FY", "$100.00"],
      ["BU2", "Doe, John", "CB", "(25.00)"],
    ],
  };
  const { mapping } = coerceMapping({
    columns: { policy_number: 0, insured_name: 1, transaction_type: 2, amount: 3 },
    carrier: "Americo", period_start: "", period_end: "", confidence: 0.9, notes: "",
    type_map: [{ value: "FY", type: "advance" }, { value: "CB", type: "chargeback" }],
  }, 4);

  const rows = applyMapping(sheet, previewSheet(sheet), mapping);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amountCents, 10000);
  assert.equal(rows[0].transactionType, "advance");
  assert.equal(rows[1].amountCents, -2500);
  assert.equal(rows[1].transactionType, "chargeback");
  assert.equal(rows[1].carrier, "Americo");
});

test("bytesToBase64 round-trips, including past the chunk boundary", () => {
  const small = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
  assert.equal(bytesToBase64(small), Buffer.from(small).toString("base64"));

  const big = new Uint8Array(0x8000 * 2 + 517);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  assert.equal(bytesToBase64(big), Buffer.from(big).toString("base64"));
});

test("the extraction tier is pinned to Haiku and the PDF cap is under the API's own", () => {
  assert.equal(STATEMENT_MODEL, "claude-haiku-4-5");
  assert.ok(PDF_MAX_BYTES < 32 * 1024 * 1024, "must stay under the 32 MB request ceiling");
});
