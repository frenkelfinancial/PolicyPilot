// ============================================================
// csv.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsv } from "./csv.ts";

test("parses a simple header + rows CSV", () => {
  const { headers, rows } = parseCsv("phone,name\n5551234567,Alice\n5559876543,Bob\n");
  assert.deepEqual(headers, ["phone", "name"]);
  assert.deepEqual(rows, [
    { phone: "5551234567", name: "Alice" },
    { phone: "5559876543", name: "Bob" },
  ]);
});

test("handles a quoted field containing a comma", () => {
  const { rows } = parseCsv('phone,name\n5551234567,"Smith, Alice"\n');
  assert.equal(rows[0].name, "Smith, Alice");
});

test("handles an escaped quote (\"\") inside a quoted field", () => {
  const { rows } = parseCsv('phone,note\n5551234567,"She said ""hi"""\n');
  assert.equal(rows[0].note, 'She said "hi"');
});

test("handles an embedded newline inside a quoted field without breaking row boundaries", () => {
  const { headers, rows } = parseCsv('phone,note\n5551234567,"line one\nline two"\n5559876543,plain\n');
  assert.deepEqual(headers, ["phone", "note"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, "line one\nline two");
  assert.equal(rows[1].phone, "5559876543");
});

test("trims whitespace around headers and values", () => {
  const { headers, rows } = parseCsv(" phone , name \n 5551234567 , Alice \n");
  assert.deepEqual(headers, ["phone", "name"]);
  assert.equal(rows[0].phone, "5551234567");
  assert.equal(rows[0].name, "Alice");
});

test("no trailing newline on the last row still parses", () => {
  const { rows } = parseCsv("phone,name\n5551234567,Alice");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, "5551234567");
});

test("empty input yields no headers and no rows", () => {
  const { headers, rows } = parseCsv("");
  assert.deepEqual(headers, []);
  assert.deepEqual(rows, []);
});

test("a row with fewer fields than headers fills the rest with empty strings", () => {
  const { rows } = parseCsv("phone,name,notes\n5551234567,Alice\n");
  assert.equal(rows[0].phone, "5551234567");
  assert.equal(rows[0].name, "Alice");
  assert.equal(rows[0].notes, "");
});
