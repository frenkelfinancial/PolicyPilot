// ============================================================
// statement-email.test.ts — run with:  npm run test:statementemail
//
// Back Office Phase 1b. The Resend `email.received` shape is now OBSERVED,
// from a real delivery on 2026-07-29, and the fixture below is that real
// payload's structure — metadata-only attachments, `received_for`, `email_id`.
//
// The first guess (that inbound would mirror Resend's OUTBOUND
// `{filename, content}`) was WRONG. These tests pin the observed shape so it
// cannot silently regress, and keep the tolerant paths covered so a provider
// that starts inlining bytes does not break us.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMISSION_EMAIL_PRIMARY,
  COMMISSION_EMAIL_BRANDED,
  COMMISSION_EMAIL_DOMAINS,
  commissionAddressFor,
  extractCommissionToken,
  isCommissionAddress,
  collectRecipients,
  extractAttachments,
  stripDataUrl,
  base64FromBytes,
  base64ToBytes,
  isIngestibleFilename,
  parseInboundStatementEmail,
  fetchAttachmentBytes,
  captureStatus,
  captureError,
} from "./statement-email.ts";

const TOK = "f8056f832d874a379587fca4af517b33";

// ------------------------------------------------------------
// Addresses
// ------------------------------------------------------------

test("the ACTIVE domain is Resend's own — the branded one is dormant", () => {
  assert.equal(COMMISSION_EMAIL_PRIMARY, "ouintiicri.resend.app");
  assert.equal(COMMISSION_EMAIL_BRANDED, "commissions.producerstackcrm.com");
  assert.equal(commissionAddressFor(TOK), `${TOK}@ouintiicri.resend.app`,
    "the address SHOWN to an agent must be one that actually receives today");
});

test("BOTH domains resolve, so the branded one lights up with no code change", () => {
  assert.equal(extractCommissionToken(`${TOK}@ouintiicri.resend.app`), TOK);
  assert.equal(extractCommissionToken(`${TOK}@commissions.producerstackcrm.com`), TOK);
  assert.deepEqual(COMMISSION_EMAIL_DOMAINS.length, 2);
});

test("a NEAR-MISS domain never resolves", () => {
  // This is the assertion that matters most: resolving a token is what grants
  // write access to an agent's book, so the domain check has to be exact.
  [
    `${TOK}@resend.app`,
    `${TOK}@evil-ouintiicri.resend.app`,
    `${TOK}@ouintiicri.resend.app.evil.com`,
    `${TOK}@producerstackcrm.com`,
    `${TOK}@commissions.producerstackcrm.com.evil.com`,
    `${TOK}@sub.ouintiicri.resend.app`,
  ].forEach((a) => assert.equal(extractCommissionToken(a), null, `${a} must not resolve`));
});

test("plus-addressing and display names are handled", () => {
  assert.equal(extractCommissionToken(`${TOK}+americo@ouintiicri.resend.app`), TOK);
  assert.equal(extractCommissionToken(`Jace <${TOK}@ouintiicri.resend.app>`), TOK);
  assert.equal(extractCommissionToken(`  ${TOK.toUpperCase()}@OUINTIICRI.RESEND.APP `), TOK);
});

test("a malformed local part is refused", () => {
  assert.equal(extractCommissionToken("short@ouintiicri.resend.app"), null);
  assert.equal(extractCommissionToken("has-dashes-here@ouintiicri.resend.app"), null);
  assert.equal(extractCommissionToken("@ouintiicri.resend.app"), null);
  assert.equal(extractCommissionToken(null), null);
  assert.equal(extractCommissionToken(""), null);
  assert.equal(isCommissionAddress("someone@gmail.com"), false);
});

// ------------------------------------------------------------
// Recipients — the CC case is real
// ------------------------------------------------------------

test("the forwarding address is found even when it is only in CC", () => {
  // An agent forwarding a carrier email will often leave the carrier's own
  // address in `to` and put us in cc.
  const e = parseInboundStatementEmail({
    id: "evt_1",
    data: {
      from: "statements@americo.com",
      to: ["agent@theiragency.com"],
      cc: [`${TOK}@ouintiicri.resend.app`],
      subject: "July commission",
      attachments: [{ filename: "july.csv", content: base64FromBytes(new TextEncoder().encode("a,b\n1,2")) }],
    },
  });
  assert.ok(e);
  assert.equal(e.token, TOK);
  assert.equal(e.ingestible.length, 1);
});

test("recipients are collected across every shape a provider might use", () => {
  assert.deepEqual(collectRecipients({ to: "a@b.com" }), ["a@b.com"]);
  assert.deepEqual(collectRecipients({ to: [{ email: "a@b.com" }] }), ["a@b.com"]);
  assert.deepEqual(collectRecipients({ recipient: { address: "a@b.com" } }), ["a@b.com"]);
  assert.deepEqual(collectRecipients({}), []);
});

// ------------------------------------------------------------
// Attachments — shape is unknown, so tolerance is the requirement
// ------------------------------------------------------------

const b64 = base64FromBytes(new TextEncoder().encode("Policy,Amount\nX1,10.00"));

test("attachments are found under several plausible key names, and say which", () => {
  for (const [key, wrap] of [
    ["attachments", (a: unknown) => ({ attachments: a })],
    ["attachment", (a: unknown) => ({ attachment: a })],
    ["files", (a: unknown) => ({ files: a })],
  ] as const) {
    const got = extractAttachments(wrap([{ filename: "s.csv", content: b64 }]) as Record<string, unknown>);
    assert.equal(got.length, 1, `${key} should yield one attachment`);
    assert.equal(got[0].filename, "s.csv");
    // `via` is how the REAL shape gets learned from the first genuine event.
    assert.match(got[0].via, new RegExp(`^${key}\\[\\]\\.`));
  }
});

test("content is found whether it is called content, data or base64", () => {
  ["content", "data", "content_base64", "contentBase64", "base64", "body"].forEach((ck) => {
    const got = extractAttachments({ attachments: [{ filename: "s.csv", [ck]: b64 }] });
    assert.equal(got.length, 1, `${ck} should be read`);
    assert.equal(new TextDecoder().decode(base64ToBytes(got[0].contentBase64)), "Policy,Amount\nX1,10.00");
  });
});

test("a data: URL and a raw byte array both decode", () => {
  assert.equal(stripDataUrl(`data:text/csv;base64,${b64}`), b64);
  const bytes = Array.from(new TextEncoder().encode("hi"));
  const got = extractAttachments({ attachments: [{ filename: "s.csv", content: bytes }] });
  assert.equal(new TextDecoder().decode(base64ToBytes(got[0].contentBase64)), "hi");
  assert.match(got[0].via, /\(bytes\)$/);
});

test("an attachment with no name or no content is skipped, not half-built", () => {
  assert.equal(extractAttachments({ attachments: [{ content: b64 }] }).length, 0);
  assert.equal(extractAttachments({ attachments: [{ filename: "s.csv" }] }).length, 0);
  assert.equal(extractAttachments({ attachments: [] }).length, 0);
  assert.equal(extractAttachments({}).length, 0);
});

test("only formats the pipeline can actually read are ingestible", () => {
  ["a.pdf", "a.xlsx", "a.xls", "a.csv", "a.zip", "A.CSV"].forEach((f) =>
    assert.equal(isIngestibleFilename(f), true, f));
  ["a.docx", "a.png", "signature.jpg", "a", "a.txt"].forEach((f) =>
    assert.equal(isIngestibleFilename(f), false, f));
});

test("a signature image is separated from a real statement, with a reason", () => {
  const e = parseInboundStatementEmail({
    id: "evt_2",
    data: {
      from: "a@b.com", to: [`${TOK}@ouintiicri.resend.app`], subject: "stmt",
      attachments: [
        { filename: "logo.png", content: b64 },
        { filename: "july.csv", content: b64 },
      ],
    },
  });
  assert.equal(e!.ingestible.length, 1);
  assert.equal(e!.ingestible[0].filename, "july.csv");
  assert.equal(e!.skipped.length, 1);
  assert.match(e!.skipped[0].reason, /not a PDF, Excel, CSV or ZIP file/);
});

// ------------------------------------------------------------
// Degrading honestly — the point of the whole design
// ------------------------------------------------------------

test("an UNRECOGNISED payload shape yields a stored, explained row — not a guess", () => {
  const e = parseInboundStatementEmail({
    id: "evt_3",
    data: {
      from: "a@b.com", to: [`${TOK}@ouintiicri.resend.app`], subject: "stmt",
      // A shape nobody anticipated.
      enclosures: [{ title: "july.csv", blob: b64 }],
    },
  });
  assert.ok(e);
  assert.equal(e.token, TOK, "the agent is still resolved");
  assert.equal(e.attachments.length, 0);
  assert.equal(captureStatus(e, "agent-uuid"), "no_attachment");
  assert.match(captureError(e, "agent-uuid")!, /carried no attachment/);
  // …and the raw payload is what the webhook stores, so the real shape is
  // recoverable and the email is re-runnable.
});

test("an unresolvable token is captured, never dropped", () => {
  const e = parseInboundStatementEmail({
    id: "evt_4",
    data: { from: "a@b.com", to: ["deadbeefdeadbeefdeadbeefdeadbeef@ouintiicri.resend.app"], subject: "s" },
  });
  assert.equal(captureStatus(e, null), "unresolved");
  assert.match(captureError(e, null)!, /No agent owns the forwarding address/);
});

test("an event with no recipient at all is a malformed event, not a commission email", () => {
  assert.equal(parseInboundStatementEmail({ data: { from: "a@b.com" } }), null);
  assert.equal(captureStatus(null, null), "failed");
  assert.match(captureError(null, null)!, /could not be parsed at all/);
});

test("a good email with a good attachment is simply received", () => {
  const e = parseInboundStatementEmail({
    id: "evt_5",
    data: {
      from: "Americo <statements@americo.com>",
      to: [`${TOK}@ouintiicri.resend.app`],
      subject: "Commission statement",
      attachments: [{ filename: "july.csv", content: b64 }],
    },
  });
  assert.equal(captureStatus(e, "agent-uuid"), "received");
  assert.equal(captureError(e, "agent-uuid"), null);
  assert.equal(e!.eventId, "evt_5");
});

test("every capture status is one the check constraint allows", () => {
  // The migration constrains these; a status it refuses would throw on insert
  // and lose the capture, which is the one thing this table exists to prevent.
  const allowed = ["received", "ingested", "no_attachment", "unresolved", "failed"];
  const e = parseInboundStatementEmail({
    data: { from: "a@b.com", to: [`${TOK}@ouintiicri.resend.app`] },
  });
  [captureStatus(null, null), captureStatus(e, null), captureStatus(e, "x")].forEach((s) =>
    assert.ok(allowed.includes(s), `${s} is not an allowed status`));
});


// ============================================================
// THE OBSERVED RESEND SHAPE — captured from a real delivery, 2026-07-29
// ============================================================

/** Exactly the structure a real `email.received` carried. */
const REAL = (to = `${TOK}@ouintiicri.resend.app`) => ({
  type: "email.received",
  data: {
    cc: [],
    to: [to],
    bcc: [],
    from: "ProducerStack <noreply@producerstackcrm.com>",
    subject: "Americo Commission Statement 07/24/2026",
    email_id: "497d02c1-84f1-4bca-ae64-dbf28830e9a7",
    created_at: "2026-07-29T22:40:00.000Z",
    message_id: "<abc@resend>",
    // METADATA ONLY. There is no content field — this is the finding.
    attachments: [{
      id: "8aa60296-3c06-4d8b-a616-abfd7893d796",
      filename: "americo-commissions-20260724.csv",
      content_id: "",
      content_type: "text/csv",
      content_disposition: "attachment",
    }],
    received_for: JSON.stringify([to]),
  },
});

test("the REAL Resend shape parses: token, email_id and a fetchable attachment", () => {
  const e = parseInboundStatementEmail(REAL())!;
  assert.equal(e.token, TOK);
  assert.equal(e.emailId, "497d02c1-84f1-4bca-ae64-dbf28830e9a7");
  assert.equal(e.ingestible.length, 1);
  const a = e.ingestible[0];
  assert.equal(a.filename, "americo-commissions-20260724.csv");
  assert.equal(a.contentBase64, null, "inbound carries NO bytes — they are fetched");
  assert.equal(a.remoteId, "8aa60296-3c06-4d8b-a616-abfd7893d796");
  assert.equal(a.via, "attachments[].id(fetch)");
});

test("`received_for` is honoured, and it is a JSON-encoded string", () => {
  // It is authoritative: present even when our address is only in bcc, which
  // is how a forwarded carrier email often reaches us.
  const p = REAL();
  p.data.to = ["someone-else@carrier.com"];
  p.data.received_for = JSON.stringify([`${TOK}@ouintiicri.resend.app`]);
  const e = parseInboundStatementEmail(p)!;
  assert.equal(e.token, TOK, "received_for must resolve the address");
});

test("a real event with a resolvable agent is `received`, not an error", () => {
  const e = parseInboundStatementEmail(REAL());
  assert.equal(captureStatus(e, "agent-uuid"), "received");
  assert.equal(captureError(e, "agent-uuid"), null);
});

test("the send-only key failure is reported in words an agent can act on", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ statusCode: 401, name: "restricted_api_key" }),
    { status: 401, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  try {
    const r = await fetchAttachmentBytes("e1", "a1", "re_sendonly");
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /send-only/);
    assert.match((r as { reason: string }).reason, /RESEND_FULL_API_KEY/);
  } finally { globalThis.fetch = orig; }
});

test("attachment bytes are read from a raw body, and from a JSON content field", async () => {
  const orig = globalThis.fetch;
  const payload = new TextEncoder().encode("Policy,Amount\nX1,10.00");
  globalThis.fetch = (async () => new Response(payload, {
    status: 200, headers: { "content-type": "text/csv" },
  })) as typeof fetch;
  try {
    const r = await fetchAttachmentBytes("e1", "a1", "k");
    assert.equal(r.ok, true);
    assert.equal(new TextDecoder().decode(base64ToBytes((r as { base64: string }).base64)),
      "Policy,Amount\nX1,10.00");
  } finally { globalThis.fetch = orig; }

  globalThis.fetch = (async () => new Response(
    JSON.stringify({ content: base64FromBytes(payload) }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  try {
    const r = await fetchAttachmentBytes("e1", "a1", "k");
    assert.equal(r.ok, true);
  } finally { globalThis.fetch = orig; }
});

test("a download failure NEVER throws — it returns a reason", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  try {
    const r = await fetchAttachmentBytes("e1", "a1", "k");
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /Could not reach Resend/);
  } finally { globalThis.fetch = orig; }
});
