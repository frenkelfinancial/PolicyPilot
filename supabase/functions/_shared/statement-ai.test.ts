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

import {
  coerceMapping, bytesToBase64, STATEMENT_MODEL, PDF_MAX_BYTES,
  PDF_SCHEMA, PDF_SYSTEM,
} from "./statement-ai.ts";
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

// ============================================================
// What the PDF reader is TOLD to look for
//
// Both defects in the 2026-08-02 American-Amicable ledger statement were
// instruction defects, not code defects: the schema asked for one unlabelled
// `transaction_date` on a page printing THREE date columns and calling none of
// them that, and the prompt defined exactly one of our seven transaction types
// (`chargeback`) and left the model to guess the rest — so five ORDINARY LIFE
// - 1ST YEAR lines came back `renewal` on a statement whose own summary read
// TOTAL RENEWAL .00.
//
// These tests pin the instructions. They cannot prove a model obeys them, but
// they do stop the instructions quietly reverting, which is how the schema and
// what the statements actually print drifted apart in the first place.
// ============================================================

const pdfRowProps = PDF_SCHEMA.properties.rows.items.properties as Record<string, { description?: string }>;
const pdfRowRequired = PDF_SCHEMA.properties.rows.items.required as readonly string[];

test("🔴 the PDF schema asks for each date BY MEANING, not one unlabelled date", () => {
  for (const f of ["transaction_date", "paid_date", "effective_date", "due_date"]) {
    assert.ok(pdfRowProps[f], `the PDF row schema must ask for ${f}`);
    assert.ok((pdfRowProps[f].description || "").length > 20, `${f} must say what it means`);
  }
});

test("🔴 transaction_date names the synonyms carriers actually print", () => {
  // "ACCTG DATE" is what American-Amicable prints. A schema that only says
  // "transaction date" gets an empty string from a model being honest.
  const d = (pdfRowProps.transaction_date.description || "").toLowerCase();
  for (const word of ["accounting", "acctg", "booked", "posting", "processed", "transaction date"]) {
    assert.ok(d.includes(word), `transaction_date's description must name "${word}" as a synonym`);
  }
  assert.ok(/carrier booked/i.test(pdfRowProps.transaction_date.description || ""),
    "it must say plainly that this is when the CARRIER booked the commission");
});

test("the other three dates are distinguishable from each other", () => {
  assert.match(pdfRowProps.paid_date.description || "", /agent was paid/i);
  assert.match(pdfRowProps.effective_date.description || "", /effective or ISSUE date/i);
  assert.match(pdfRowProps.due_date.description || "", /premium DUE DATE/i);
});

test("every date field keeps the reproduce-exactly rule, including a year-less date", () => {
  for (const f of ["transaction_date", "paid_date", "effective_date", "due_date"]) {
    const d = pdfRowProps[f].description || "";
    assert.match(d, /EXACTLY as printed/, `${f} must not invite the model to reformat`);
    assert.match(d, /do not add a year/i, `${f} must not invite the model to invent a year`);
    assert.match(d, /Empty string if/i, `${f} must say empty is the answer when the line is silent`);
  }
});

test("🔴 the statement header date is asked for — it is where a MM-DD gets its year", () => {
  assert.ok(PDF_SCHEMA.required.includes("statement_date"));
  assert.match(PDF_SCHEMA.properties.statement_date.description, /header/i);
  assert.match(PDF_SCHEMA.properties.statement_date.description, /year/i);
});

test("the PDF row schema's required list covers every property", () => {
  // Structured Outputs with additionalProperties:false and a short `required`
  // list is how a field silently comes back missing on some rows and not
  // others — which is exactly the kind of per-row inconsistency that made the
  // original single date field untrustworthy.
  assert.deepEqual([...pdfRowRequired].sort(), Object.keys(pdfRowProps).sort());
});

test("🔴 the prompt defines every transaction type, not just chargeback", () => {
  for (const t of ["advance", "renewal", "chargeback", "adjustment", "bonus", "override"]) {
    assert.ok(PDF_SYSTEM.includes("`" + t + "`"), `PDF_SYSTEM must define \`${t}\` in the app's own terms`);
  }
});

test("🔴 the prompt says first-year commission is advance and NEVER renewal", () => {
  assert.match(PDF_SYSTEM, /FIRST-YEAR COMMISSION IS `advance`, NEVER `renewal`/);
  assert.match(PDF_SYSTEM, /1st year/i);
  assert.match(PDF_SYSTEM, /initial/i);
  // And that renewal means past the first year, so the two cannot be conflated.
  assert.match(PDF_SYSTEM, /PAST its first year/i);
});

test("🔴 the prompt says a SECTION HEADING governs the lines beneath it", () => {
  // This carrier states the type once, in a heading, and never on a line.
  assert.match(PDF_SYSTEM, /SECTION HEADING GOVERNS EVERY LINE BENEATH IT/);
  assert.ok(pdfRowProps.transaction_type_text, "and the heading itself is captured");
  assert.match(pdfRowProps.transaction_type_text.description || "", /section heading/i);
});

test("the prompt tells the model to label each date by what it means", () => {
  assert.match(PDF_SYSTEM, /SEVERAL dates per line/i);
  assert.match(PDF_SYSTEM, /accounting date, ACCTG DATE/);
  assert.match(PDF_SYSTEM, /never infer a date a line does not print/i);
  assert.match(PDF_SYSTEM, /statement_date/);
});

test("🔴 an adjustment line names no insured, and the prompt says so", () => {
  // "ME NONRES" — the ledger's own explanation text — was captured as a
  // client's name. The instruction is generic on purpose: a blocklist of
  // carrier-specific strings would rot.
  assert.match(PDF_SYSTEM, /`insured_name` is a person/);
  assert.match(PDF_SYSTEM, /empty string there rather than putting the line's explanation text/);
  assert.match(pdfRowProps.insured_name.description || "", /Empty string if this line names no person/);
  assert.ok(!/NONRES/i.test(PDF_SYSTEM), "no carrier-specific string blocklist");
});

test("the rules that were already right are still there", () => {
  assert.match(PDF_SYSTEM, /Do not return summary, subtotal/);
  assert.match(PDF_SYSTEM, /commission paid to the agent, not the policy premium/);
  assert.match(PDF_SYSTEM, /Do not invent policy numbers or names/);
  assert.match(pdfRowProps.amount.description || "", /EXACTLY as printed/);
});
