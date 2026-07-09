// ============================================================
// segments.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { countSegments, smsAmountMills } from "./segments.ts";

test("short ASCII body is GSM-7, 1 segment", () => {
  const info = countSegments("Hello, your quote is ready.");
  assert.equal(info.encoding, "GSM7");
  assert.equal(info.segments, 1);
});

test("GSM-7 body exactly at the 160 single-segment boundary", () => {
  const info = countSegments("a".repeat(160));
  assert.equal(info.encoding, "GSM7");
  assert.equal(info.length, 160);
  assert.equal(info.segments, 1);
});

test("GSM-7 body one over the boundary concatenates at 153/segment", () => {
  const info = countSegments("a".repeat(161));
  assert.equal(info.encoding, "GSM7");
  assert.equal(info.segments, 2); // ceil(161/153) = 2
});

test("GSM-7 body at 306 chars needs 2 segments, 307 needs 3", () => {
  assert.equal(countSegments("a".repeat(306)).segments, 2); // ceil(306/153) = 2
  assert.equal(countSegments("a".repeat(307)).segments, 3); // ceil(307/153) = 3
});

test("GSM-7 extension characters count as 2 septets each", () => {
  // 80 euro signs = 160 septets -> still fits in one segment.
  const oneSegment = countSegments("€".repeat(80));
  assert.equal(oneSegment.encoding, "GSM7");
  assert.equal(oneSegment.length, 160);
  assert.equal(oneSegment.segments, 1);

  // 81 euro signs = 162 septets -> pushes into a second (153-boundary) segment.
  const twoSegments = countSegments("€".repeat(81));
  assert.equal(twoSegments.length, 162);
  assert.equal(twoSegments.segments, 2);
});

test("emoji forces UCS-2 encoding", () => {
  const info = countSegments("Thanks! 😀");
  assert.equal(info.encoding, "UCS2");
});

test("10-emoji message bills as a single UCS-2 segment (under the 70-unit boundary)", () => {
  const info = countSegments("😀".repeat(10));
  assert.equal(info.encoding, "UCS2");
  assert.ok(info.length <= 70, `expected <=70 UTF-16 units, got ${info.length}`);
  assert.equal(info.segments, 1);
});

test("UCS-2 body exactly at the 70 single-segment boundary", () => {
  const info = countSegments("驗".repeat(70));
  assert.equal(info.encoding, "UCS2");
  assert.equal(info.length, 70);
  assert.equal(info.segments, 1);
});

test("UCS-2 body one over the boundary concatenates at 67/segment", () => {
  const info = countSegments("驗".repeat(71));
  assert.equal(info.encoding, "UCS2");
  assert.equal(info.segments, 2); // ceil(71/67) = 2
});

test("smsAmountMills multiplies segments by the configured rate", () => {
  const oneSeg = smsAmountMills("Hello", 10);
  assert.deepEqual(oneSeg, { segments: 1, amountMills: 10, encoding: "GSM7" });

  const threeSeg = smsAmountMills("a".repeat(400), 10); // ceil(400/153) = 3
  assert.equal(threeSeg.segments, 3);
  assert.equal(threeSeg.amountMills, 30);
});

test("empty body counts as a single segment", () => {
  const info = countSegments("");
  assert.equal(info.segments, 1);
});
