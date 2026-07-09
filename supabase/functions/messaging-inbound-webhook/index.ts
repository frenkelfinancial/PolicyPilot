import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyTelnyxSignature } from "../_shared/webhook-verify.ts";
import { toE164 } from "../_shared/phone.ts";

const OPT_OUT_KEYWORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_OUT_CONFIRMATION =
  "You have been unsubscribed and will not receive further messages from this number.";

// Last-10-digit compare, used ONLY to match the inbound `to` number against
// our own phone_numbers/agents.signalwire_caller_id rows (tolerates
// whatever format those happen to be stored in). NOT used for anything
// written to consent_records/dnc_list/messages — those always use the
// canonical toE164() from _shared/phone.ts so a stored phone number means
// the same thing everywhere it's compared.
function last10Digits(num: string | undefined | null): string {
  if (!num) return "";
  return num.replace(/[^\d]/g, "").slice(-10);
}

// Telnyx inbound SMS/MMS webhook (event_type = message.received). Inbound
// messages are free — this function only logs and, for opt-out keywords,
// auto-adds the sender to dnc_list and sends the one required confirmation
// reply (also free — no wallet_hold for this reply, it's a compliance
// obligation, not a billable send).
//
// verify_jwt = false for this function (see supabase/config.toml) — Telnyx
// cannot supply a Supabase-signed JWT; signature verified below instead.
Deno.serve(async (req) => {
  const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY   = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_PUBLIC_KEY = Deno.env.get("TELNYX_PUBLIC_KEY");
  const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");

  const rawBody = await req.text();

  if (TELNYX_PUBLIC_KEY) {
    const sig = req.headers.get("telnyx-signature-ed25519");
    const ts  = req.headers.get("telnyx-timestamp");
    if (!await verifyTelnyxSignature(rawBody, sig, ts, TELNYX_PUBLIC_KEY)) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
    }
  }

  let payload: {
    data?: {
      event_type?: string;
      payload?: {
        id?: string;
        from?: { phone_number?: string };
        to?: { phone_number?: string }[];
        text?: string;
      };
    };
  };
  try { payload = JSON.parse(rawBody); } catch { return new Response(JSON.stringify({ ok: true }), { status: 200 }); }

  const eventType = payload?.data?.event_type;
  const p = payload?.data?.payload;
  if (eventType !== "message.received" || !p) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const fromRaw = p.from?.phone_number || "";
  const toRaw    = p.to?.[0]?.phone_number || "";
  // Canonical E.164 for every write/compare below — Telnyx already sends
  // E.164, so this is normally a no-op, but it guarantees agreement with
  // consent_records/dnc_list/messages regardless of provider formatting.
  const fromNumber = toE164(fromRaw) || fromRaw;
  const toNumber    = toE164(toRaw) || toRaw;
  const text        = (p.text || "").trim();
  const providerEventId = p.id || null;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Idempotency: Telnyx retries undelivered webhooks — a unique index on
  // provider_event_id means a second insert attempt for the same event is
  // simply rejected, not double-processed.
  if (providerEventId) {
    const { data: existing } = await sb.from("inbound_messages")
      .select("id")
      .eq("provider_event_id", providerEventId)
      .maybeSingle();
    if (existing) return new Response(JSON.stringify({ ok: true, deduped: true }), { status: 200 });
  }

  // Find which agent owns the destination number.
  const toNorm = last10Digits(toNumber);
  const { data: numberRow } = await sb.from("phone_numbers")
    .select("agent_id")
    .eq("e164", toNumber)
    .maybeSingle();
  let agentId: string | null = numberRow?.agent_id ?? null;
  if (!agentId) {
    const { data: byCallerId } = await sb.from("agents")
      .select("id, signalwire_caller_id")
      .not("signalwire_caller_id", "is", null);
    agentId = (byCallerId || []).find((a) => last10Digits(a.signalwire_caller_id) === toNorm)?.id ?? null;
  }

  const isOptOut = OPT_OUT_KEYWORDS.has(text.toUpperCase());

  // Best-effort match to the most recent outbound message this agent sent
  // to this contact, so the reply logs against that conversation.
  let inReplyToMessageId: string | null = null;
  if (agentId) {
    const { data: lastOutbound } = await sb.from("messages")
      .select("id")
      .eq("agent_id", agentId)
      .in("channel", ["sms", "mms"])
      .eq("to_address", fromNumber)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    inReplyToMessageId = lastOutbound?.id ?? null;
  }

  await sb.from("inbound_messages").insert({
    agent_id:               agentId,
    channel:                "sms",
    from_address:            fromNumber,
    to_address:              toNumber,
    body_preview:            text.slice(0, 200),
    in_reply_to_message_id:  inReplyToMessageId,
    is_opt_out:              isOptOut,
    provider_event_id:       providerEventId,
  });

  if (isOptOut && agentId) {
    await sb.from("dnc_list").insert({
      agent_id:      agentId,
      contact_phone: fromNumber,
      reason:        `Opted out via "${text}"`,
      source:        "opt_out_keyword",
    }).select().maybeSingle(); // unique index may reject a duplicate opt-out — fine, already on the list

    if (TELNYX_API_KEY && toNumber) {
      await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TELNYX_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          from: toNumber,
          to:   fromNumber,
          text: OPT_OUT_CONFIRMATION,
          ...(TELNYX_MSG_PROFILE_ID ? { messaging_profile_id: TELNYX_MSG_PROFILE_ID } : {}),
        }),
      }).catch((err) => console.error("[messaging-inbound-webhook] opt-out confirmation send failed:", err));
    }
  }

  return new Response(JSON.stringify({ ok: true, opted_out: isOptOut }), { status: 200 });
});
