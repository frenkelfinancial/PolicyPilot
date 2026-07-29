import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyResendSignature, verifyResendSignatureAny } from "../_shared/webhook-verify.ts";
import {
  parseInboundStatementEmail,
  captureStatus,
  captureError,
  base64ToBytes,
  fetchAttachmentBytes,
} from "../_shared/statement-email.ts";

// ============================================================
// EVENT NAME CONFIRMED, PAYLOAD SHAPE STILL AN ADAPTER — VERIFY BEFORE
// GO-LIVE (see Cowork hand-off, docs/PHASE2_S2_COWORK_CHECKLIST.md §2.3).
//
// Cowork confirmed the real Resend event name is "email.received" (webhook
// id 06060a7c-efcb-4175-a046-f3eef8a36905) — the event-type check below is
// no longer a guess. The PAYLOAD SHAPE inside that event is still
// unverified: this build could not confirm it against a real inbound
// delivery (the sending domain's inbound MX isn't pointed at Resend yet —
// §2.1/§2.3 in the checklist above). The parsing below is a best-effort
// adapter behind parseInboundEmailPayload() — once a real email.received
// payload is captured (§2.3: "Resend inbound-parser TODO fed back to
// Code"), adjust that one function if the field names below don't match.
// Everything else in this file (signature verification, plus-address
// matching, DNC/thread logging) does not depend on Resend's exact field
// names and needs no changes once the parser is correct.
// ============================================================
function parseInboundEmailPayload(payload: Record<string, unknown>): {
  eventId: string | null;
  from: string;
  to: string;
  subject: string;
  bodyPreview: string;
} | null {
  const data = (payload?.data ?? payload) as Record<string, unknown> | undefined;
  if (!data) return null;

  const from = typeof data.from === "string" ? data.from : (data.from as { email?: string })?.email;
  const toRaw = data.to;
  const to = typeof toRaw === "string"
    ? toRaw
    : Array.isArray(toRaw)
      ? (typeof toRaw[0] === "string" ? toRaw[0] : (toRaw[0] as { email?: string })?.email)
      : (toRaw as { email?: string })?.email;

  if (!from || !to) return null;

  return {
    eventId:     typeof payload?.id === "string" ? payload.id as string : null,
    from:        String(from),
    to:          String(to),
    subject:     typeof data.subject === "string" ? data.subject : "",
    bodyPreview: (typeof data.text === "string" ? data.text : typeof data.html === "string" ? data.html : "").slice(0, 200),
  };
}

// Matches the plus-addressed Reply-To messaging-send-email sets:
// "local+r-<messageId>@domain".
function extractMessageIdFromPlusAddress(address: string): string | null {
  const match = address.match(/\+r-([0-9a-fA-F-]{36})@/);
  return match ? match[1] : null;
}

// verify_jwt = false for this function (see supabase/config.toml) — Resend
// cannot supply a Supabase-signed JWT; Svix signature verified below instead.
//
// Resend issues a SEPARATE whsec_ signing secret per webhook endpoint, so
// this function verifies against its OWN dedicated secret,
// RESEND_INBOUND_WEBHOOK_SECRET — NOT the RESEND_WEBHOOK_SECRET used by
// messaging-delivery-webhook (webhook id 06060a7c-... vs 86308238-...).
// Mixing them up means every signature check here fails closed (400), never
// silently accepts the wrong endpoint's payload.
Deno.serve(async (req) => {
  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const RESEND_INBOUND_WEBHOOK_SECRET = Deno.env.get("RESEND_INBOUND_WEBHOOK_SECRET");

  const rawBody = await req.text();

  // Try this endpoint's OWN secret first, then the delivery endpoint's as a
  // fallback. Which whsec_ landed in which Supabase secret has never been
  // confirmed against a real event, and a swap would 401 every call and get
  // this endpoint auto-disabled a second time. `matched` names the one that
  // worked, so a swap shows up in the logs instead of silently costing mail.
  if (RESEND_INBOUND_WEBHOOK_SECRET || Deno.env.get("RESEND_WEBHOOK_SECRET")) {
    const v = await verifyResendSignatureAny(
      rawBody,
      req.headers.get("svix-id"),
      req.headers.get("svix-timestamp"),
      req.headers.get("svix-signature"),
      [
        { name: "RESEND_INBOUND_WEBHOOK_SECRET", value: RESEND_INBOUND_WEBHOOK_SECRET },
        { name: "RESEND_WEBHOOK_SECRET", value: Deno.env.get("RESEND_WEBHOOK_SECRET") },
      ],
    );
    if (!v.ok) {
      console.error("[inbound] signature rejected; tried:", v.tried.join(", "));
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
    }
    if (v.matched !== "RESEND_INBOUND_WEBHOOK_SECRET") {
      console.warn(`[inbound] SECRETS ARE SWAPPED: verified with ${v.matched}. ` +
        "Swap the values of RESEND_INBOUND_WEBHOOK_SECRET and RESEND_WEBHOOK_SECRET.");
    }
  }

  let raw: Record<string, unknown>;
  try { raw = JSON.parse(rawBody); } catch { return new Response(JSON.stringify({ ok: true }), { status: 200 }); }

  if (raw?.type && raw.type !== "email.received") {
    // Not an inbound-email event (could be a delivery event hitting the
    // wrong endpoint) — ignore rather than error. "email.received" is the
    // confirmed real event name for this webhook (Cowork, 2026-07-09).
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // ------------------------------------------------------------
  // COMMISSION FORWARDING ADDRESSES (Back Office Phase 1b)
  //
  // Resend allows ONE inbound webhook endpoint per account and it is already
  // pointed here (webhook id 06060a7c-…), so commission mail arrives at this
  // function rather than at one of its own. Dispatch on the recipient domain
  // BEFORE the messaging path runs: a statement forwarded to
  // <token>@commissions.producerstackcrm.com is not a reply to anything, and
  // letting it fall through would file it as an unmatched inbound message.
  //
  // This branch always returns 200. Resend retries a non-2xx, and a retry
  // storm on a statement we have already captured helps nobody — the capture
  // row and its provider_event_id are what make a retry a no-op.
  // ------------------------------------------------------------
  const statementEmail = parseInboundStatementEmail(raw);
  if (statementEmail && statementEmail.token) {
    return await handleCommissionEmail(sb, raw, statementEmail);
  }

  const parsed = parseInboundEmailPayload(raw);
  if (!parsed) return new Response(JSON.stringify({ ok: true, ignored: "unparseable" }), { status: 200 });

  if (parsed.eventId) {
    const { data: existing } = await sb.from("inbound_messages")
      .select("id")
      .eq("provider_event_id", parsed.eventId)
      .maybeSingle();
    if (existing) return new Response(JSON.stringify({ ok: true, deduped: true }), { status: 200 });
  }

  const messageId = extractMessageIdFromPlusAddress(parsed.to);
  let agentId: string | null = null;

  if (messageId) {
    const { data: origMessage } = await sb.from("messages")
      .select("id, agent_id")
      .eq("id", messageId)
      .maybeSingle();
    agentId = origMessage?.agent_id ?? null;
  }

  await sb.from("inbound_messages").insert({
    agent_id:               agentId,
    channel:                "email",
    from_address:            parsed.from,
    to_address:              parsed.to,
    body_preview:            parsed.bodyPreview,
    in_reply_to_message_id:  messageId,
    is_opt_out:              false,
    provider_event_id:       parsed.eventId,
  });

  return new Response(JSON.stringify({ ok: true, matched: Boolean(messageId) }), { status: 200 });
});

/**
 * A forwarded carrier statement.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *   1. capture the verbatim event FIRST (the payload shape is unverified, so
 *      the raw event is the only thing guaranteed to be worth keeping);
 *   2. resolve the token to an agent;
 *   3. hand each ingestible attachment to the SAME storage path the browser
 *      upload uses, so there is one ingestion route and not two.
 *
 * Nothing here throws. A failure is recorded on the capture row and answered
 * with 200, because a statement we have stored but not yet parsed is
 * recoverable and a Resend retry loop is not.
 */
async function handleCommissionEmail(
  // deno-lint-ignore no-explicit-any
  sb: any,
  raw: Record<string, unknown>,
  email: ReturnType<typeof parseInboundStatementEmail>,
): Promise<Response> {
  if (!email) return new Response(JSON.stringify({ ok: true }), { status: 200 });

  // Replay guard. Resend retries anything it did not get a 2xx for.
  if (email.eventId) {
    const { data: seen } = await sb.from("inbound_statement_emails")
      .select("id").eq("provider", "resend").eq("provider_event_id", email.eventId).maybeSingle();
    if (seen) {
      return new Response(JSON.stringify({ ok: true, deduped: true }), { status: 200 });
    }
  }

  const { data: agentId } = await sb.rpc("resolve_commission_email_token", { p_token: email.token });
  const resolved: string | null = (typeof agentId === "string" && agentId) ? agentId : null;

  // 1. CAPTURE, before anything can go wrong downstream.
  const { data: capture, error: capErr } = await sb.from("inbound_statement_emails").insert({
    agent_id:          resolved,
    provider:          "resend",
    provider_event_id: email.eventId,
    token:             email.token,
    to_address:        email.toAddress,
    from_address:      email.from,
    subject:           email.subject,
    payload:           raw,
    attachment_count:  email.attachments.length,
    status:            captureStatus(email, resolved),
    error:             captureError(email, resolved),
  }).select("id").maybeSingle();

  if (capErr) {
    // A unique violation here is the replay guard firing on a concurrent
    // retry, which is success, not failure.
    const dup = String(capErr.code) === "23505";
    return new Response(JSON.stringify({ ok: true, deduped: dup, error: dup ? null : capErr.message }),
      { status: 200 });
  }

  const captureId = capture?.id ?? null;
  if (!resolved || email.ingestible.length === 0) {
    return new Response(JSON.stringify({
      ok: true,
      captured: captureId,
      resolved: Boolean(resolved),
      attachments: email.attachments.length,
      ingestible: email.ingestible.length,
      // The `via` strings say which payload shape actually carried the
      // attachments, which is how the real Resend format gets learned from a
      // genuine delivery rather than guessed.
      shapes: email.attachments.map((a) => a.via),
    }), { status: 200 });
  }

  // 2. INGEST each attachment through the same edge function the browser uses.
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const statementIds: string[] = [];
  const failures: string[] = [];

  // Resend's inbound event carries attachment METADATA ONLY, so the bytes are
  // fetched here. A full-access Resend key is required; the stored
  // RESEND_API_KEY is send-only and returns 401 for every read endpoint, which
  // is why RESEND_FULL_API_KEY is looked for first and the failure is recorded
  // in plain English rather than thrown.
  const RESEND_KEY = Deno.env.get("RESEND_FULL_API_KEY") ?? Deno.env.get("RESEND_API_KEY") ?? "";

  for (const att of email.ingestible) {
    try {
      let b64 = att.contentBase64;
      if (!b64) {
        if (!email.emailId || !att.remoteId) {
          failures.push(`${att.filename}: no attachment id to download by`);
          continue;
        }
        if (!RESEND_KEY) {
          failures.push(`${att.filename}: no Resend API key configured to download it`);
          continue;
        }
        const got = await fetchAttachmentBytes(email.emailId, att.remoteId, RESEND_KEY);
        if (!got.ok) { failures.push(`${att.filename}: ${got.reason}`); continue; }
        b64 = got.base64;
      }
      const bytes = base64ToBytes(b64);
      const res = await fetch(`${SUPABASE_URL}/functions/v1/statement-upload`, {
        method: "POST",
        headers: {
          // The service role is a valid Supabase JWT, which is what
          // statement-upload's verify_jwt accepts. The agent is passed
          // explicitly because there is no user session here — and
          // statement-upload only honours x-agent-id from a service-role
          // caller (see the check there).
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/octet-stream",
          "x-filename-b64": btoa(unescape(encodeURIComponent(att.filename))),
          "x-agent-id": resolved,
          "x-source": "email",
        },
        body: bytes,
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { failures.push(`${att.filename}: ${out.error ?? res.status}`); continue; }
      const ids: string[] = out.statement_id ? [out.statement_id]
        : Array.isArray(out.statements) ? out.statements.map((x: { id: string }) => x.id) : [];
      statementIds.push(...ids.filter(Boolean));
    } catch (e) {
      failures.push(`${att.filename}: ${String((e as Error).message ?? e)}`);
    }
  }

  await sb.from("inbound_statement_emails").update({
    status: statementIds.length > 0 ? "ingested" : "failed",
    statement_ids: statementIds,
    error: failures.length ? failures.join("; ") : null,
    processed_at: new Date().toISOString(),
  }).eq("id", captureId);

  return new Response(JSON.stringify({
    ok: true,
    captured: captureId,
    ingested: statementIds.length,
    statement_ids: statementIds,
    failures,
    shapes: email.ingestible.map((a) => a.via),
  }), { status: 200 });
}
