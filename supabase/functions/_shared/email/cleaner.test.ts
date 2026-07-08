// ============================================================
// cleaner.test.ts — run with:  npm run test:email   (Node 24, no deps)
//
// Verifies the HTML->text cleaner and pre-extraction trimmer: boilerplate is
// removed, data-bearing lines (policy #, client, dollar amounts) survive.
// When you export real .eml bodies, drop them in ./fixtures/ and extend the
// end-to-end test — see README.md.
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  htmlToText,
  stripQuotedReplies,
  stripDisclaimers,
  trimForExtraction,
} from "./cleaner.ts";

test("htmlToText strips tags and decodes entities", () => {
  const out = htmlToText("<p>Policy&nbsp;#: <b>xxxxx76911</b></p><p>Face&nbsp;Amount: $25,000</p>");
  assert.equal(out, "Policy #: xxxxx76911\nFace Amount: $25,000");
});

test("htmlToText drops script/style/head noise", () => {
  const html = "<head><title>ignore me</title></head><style>.x{color:red}</style><body>Approved<script>track()</script></body>";
  assert.equal(htmlToText(html), "Approved");
});

test("htmlToText turns block/br tags into line breaks", () => {
  const out = htmlToText("Line one<br>Line two<div>Line three</div>");
  assert.equal(out, "Line one\nLine two\nLine three");
});

test("htmlToText keeps table cells separated", () => {
  const out = htmlToText("<table><tr><td>WINGLER</td><td>xxxxx76911</td></tr></table>");
  assert.match(out, /WINGLER/);
  assert.match(out, /xxxxx76911/);
  assert.ok(!out.includes("WINGLERxxxxx76911"), "cells must not glue together");
});

test("htmlToText decodes numeric and hex entities", () => {
  assert.equal(htmlToText("Fee&#58; &#x24;100"), "Fee: $100");
});

test("stripQuotedReplies removes 'On ... wrote:' chains and > lines", () => {
  const text = [
    "New requirement received.",
    "",
    "On Mon, Jul 7, 2026 at 9:00 AM, Agent <a@x.com> wrote:",
    "> Please send the medical records",
    "> Thanks",
  ].join("\n");
  assert.equal(stripQuotedReplies(text), "New requirement received.");
});

test("stripDisclaimers truncates at a confidentiality footer", () => {
  const text = "Policy BU6691749 approved.\n\nCONFIDENTIALITY NOTICE: This email and any attachments are privileged...";
  assert.equal(stripDisclaimers(text), "Policy BU6691749 approved.");
});

test("stripDisclaimers truncates at unsubscribe/marketing footer", () => {
  const text = "Your commission balance is $1,240.55.\n\nYou are receiving this email because you are an Americo agent.\nUnsubscribe";
  assert.equal(stripDisclaimers(text), "Your commission balance is $1,240.55.");
});

test("trimForExtraction end-to-end: only data survives", () => {
  const html = `
    <html><head><style>.p{}</style></head><body>
    <img src="https://track.example/pixel.gif?id=abc" width="1" height="1">
    <table>
      <tr><td>Proposed Insured:</td><td>TERRY WINGLER</td></tr>
      <tr><td>Policy #:</td><td>xxxxx76911</td></tr>
      <tr><td>Status:</td><td>Approved Other Than Applied</td></tr>
    </table>
    <p>On Jul 7, 2026, Case Mgmt &lt;mocasemanagement@transamerica.com&gt; wrote:</p>
    <p>&gt; original request text</p>
    <p>CONFIDENTIALITY NOTICE: This message and any attachments are for the sole use...</p>
    </body></html>`;
  const out = trimForExtraction(html);
  assert.match(out, /TERRY WINGLER/);
  assert.match(out, /xxxxx76911/);
  assert.match(out, /Approved Other Than Applied/);
  assert.ok(!/CONFIDENTIALITY/i.test(out), "disclaimer removed");
  assert.ok(!/original request text/.test(out), "quoted reply removed");
  assert.ok(!/pixel\.gif/.test(out), "tracking pixel removed");
});

test("trimForExtraction caps length and marks truncation", () => {
  const long = "DATA " + "x".repeat(20000);
  const out = trimForExtraction(long, { maxChars: 500 });
  assert.ok(out.length <= 520, `expected ~500 chars, got ${out.length}`);
  assert.match(out, /\[truncated\]$/);
});

test("trimForExtraction is a no-op-ish on already-plain text", () => {
  const plain = "Policy BU6691749\nStatus: Approved";
  assert.equal(trimForExtraction(plain), plain);
});
