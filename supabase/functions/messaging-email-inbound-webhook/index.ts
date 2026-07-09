import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyResendSignature } from "../_shared/webhook-verify.ts";

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

  if (RESEND_INBOUND_WEBHOOK_SECRET) {
    const svixId  = req.headers.get("svix-id");
    const svixTs  = req.headers.get("svix-timestamp");
    const svixSig = req.headers.get("svix-signature");
    if (!await verifyResendSignature(rawBody, svixId, svixTs, svixSig, RESEND_INBOUND_WEBHOOK_SECRET)) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
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

  const parsed = parseInboundEmailPayload(raw);
  if (!parsed) return new Response(JSON.stringify({ ok: true, ignored: "unparseable" }), { status: 200 });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

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
