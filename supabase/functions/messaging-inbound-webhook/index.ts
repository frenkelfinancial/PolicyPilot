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
// INVARIANT, added 2026-07-28: an opt-out is ALWAYS recorded and always
// confirmed, whether or not the destination number can be attributed to an
// agent. It previously was not — see the block at the foot of this file.
// dnc_list is the single enforcement point (runComplianceGate reads it for
// every send; nothing reads inbound_messages.is_opt_out), so a STOP that
// writes no dnc_list row is a STOP we did not hear.
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

  const isOptOut = OPT_OUT_KEYWORDS.has(text.toUpperCase());

  // ------------------------------------------------------------
  // Resolve which agent this inbound belongs to.
  //
  // Four passes, cheapest and most exact first. This used to be two, and the
  // gap was not academic: on 2026-07-28 the Telnyx fleet held 8 DIDs and
  // public.phone_numbers held 6 of them. +12029703699 (the shared caller ID
  // leads actually see) and +12625099123 (the dialer host) were in neither
  // phone_numbers nor agents.signalwire_caller_id — so a STOP sent to either
  // resolved to NULL, and everything below used to be gated on that.
  // ------------------------------------------------------------
  const toNorm = last10Digits(toNumber);
  let agentId: string | null = null;
  let matchedBy = "none";

  // 1. Exact ownership. e164 carries a UNIQUE index, so this cannot be
  //    ambiguous and maybeSingle() cannot error on duplicates.
  const { data: numberRow } = await sb.from("phone_numbers")
    .select("agent_id")
    .eq("e164", toNumber)
    .maybeSingle();
  if (numberRow?.agent_id) { agentId = numberRow.agent_id; matchedBy = "phone_numbers.e164"; }

  // 2. Same number, stored in a different shape (a legacy row written before
  //    the E.164 rule, or a provider that punctuates differently).
  if (!agentId) {
    const { data: allNums } = await sb.from("phone_numbers").select("agent_id, e164");
    const hit = (allNums || []).find((n) => last10Digits(n.e164) === toNorm);
    if (hit?.agent_id) { agentId = hit.agent_id; matchedBy = "phone_numbers.last10"; }
  }

  // 3. THE CONVERSATION ITSELF. A STOP is a reply to something we sent, so
  //    the outbound leg names the agent even when the number inventory does
  //    not. Both sides are matched (we texted THIS contact FROM THIS number),
  //    so this cannot attribute the opt-out to the wrong agent when two
  //    agents have both messaged the same consumer.
  if (!agentId) {
    const { data: recent } = await sb.from("messages")
      .select("id, agent_id, from_number")
      .eq("to_address", fromNumber)
      .in("channel", ["sms", "mms"])
      .order("created_at", { ascending: false })
      .limit(25);
    const hit = (recent || []).find((m) => last10Digits(m.from_number) === toNorm);
    if (hit?.agent_id) { agentId = hit.agent_id; matchedBy = "prior_outbound_message"; }
  }

  // 4. Legacy caller-ID assignment (pre-phone_numbers model).
  if (!agentId) {
    const { data: byCallerId } = await sb.from("agents")
      .select("id, signalwire_caller_id")
      .not("signalwire_caller_id", "is", null);
    const hit = (byCallerId || []).find((a) => last10Digits(a.signalwire_caller_id) === toNorm);
    if (hit?.id) { agentId = hit.id; matchedBy = "agents.signalwire_caller_id"; }
  }

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

  // ------------------------------------------------------------
  // OPT-OUT IS PROCESSED WHETHER OR NOT WE KNOW WHOSE NUMBER IT IS.
  //
  // This block used to read `if (isOptOut && agentId)`, which meant an
  // unattributable STOP wrote no dnc_list row and sent no confirmation. The
  // only trace was inbound_messages.is_opt_out — and NOTHING reads that
  // column; dnc_list is the single enforcement point, checked by
  // runComplianceGate() for every 1:1 send and every broadcast recipient. So
  // a consumer telling us to stop, on a number we own but have not recorded,
  // was silently not heard.
  //
  // When the agent is unknown the row is written GLOBAL (agent_id null),
  // which runComplianceGate already honours for every agent:
  //     r.agent_id === null || r.agent_id === agentId
  // That is deliberately broader than necessary — it stops every agent
  // texting this one consumer. With four resolution passes above, the
  // fallback only fires for a number we genuinely cannot attribute, and
  // over-blocking one contact is the correct side to fail on when the
  // alternative is ignoring a STOP.
  // ------------------------------------------------------------
  if (isOptOut) {
    if (!agentId) {
      console.error(
        `[messaging-inbound-webhook] *** UNATTRIBUTED OPT-OUT *** ${fromNumber} sent "${text}" to ${toNumber}, ` +
        `which matches no phone_numbers row, no prior outbound message and no agent caller ID. ` +
        `Recording a GLOBAL do-not-contact entry so the opt-out is honoured anyway. ` +
        `Fix the inventory: this destination number is in the Telnyx fleet but not in public.phone_numbers.`,
      );
    }

    const { error: dncErr } = await sb.from("dnc_list").insert({
      agent_id:      agentId, // null => global entry, applies to every agent
      contact_phone: fromNumber,
      reason: agentId
        ? `Opted out via "${text}"`
        : `Opted out via "${text}" — destination ${toNumber} could not be attributed to an agent, recorded globally`,
      source:        "opt_out_keyword",
    });
    // A unique violation means they are already on the list, which is the
    // desired end state — anything else is a real failure to honour a STOP
    // and must be loud.
    if (dncErr && !/duplicate key|23505/i.test(dncErr.message || "")) {
      console.error(
        `[messaging-inbound-webhook] *** FAILED TO RECORD OPT-OUT *** ${fromNumber} -> ${toNumber}: ${dncErr.message}`,
      );
    }

    // The confirmation is a compliance obligation owed to the consumer, not
    // to the agent, so it does not depend on knowing who the agent is. Free —
    // no wallet hold, deliberately bypassing the send path and its gates.
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

  return new Response(JSON.stringify({
    ok: true,
    opted_out: isOptOut,
    agent_matched: !!agentId,
    matched_by: matchedBy,
    ...(isOptOut ? { dnc_scope: agentId ? "agent" : "global" } : {}),
  }), { status: 200 });
});
