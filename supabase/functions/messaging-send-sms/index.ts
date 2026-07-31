import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runComplianceGate, resolveTextingNumber } from "../_shared/messaging-shared.ts";
import { sendMessageCore } from "../_shared/messaging-send-core.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  appendMessage,
  autoMuteIfAgentWrote,
  cancelNudges,
  getOrCreateConversation,
} from "../_shared/sms-thread.ts";

// Authorize-then-capture SMS send: compliance gate (A2P approved, consent,
// not on DNC, within TCPA quiet hours) -> shared send core (wallet_hold ->
// Telnyx send -> messages row). NEVER settled here — messaging-delivery-
// webhook resolves the hold on the carrier's DLR (delivered -> settle,
// failed/undelivered -> void, net $0). See 016_wallet_foundation.sql for
// the wallet_hold/settle/void RPCs and 019_messaging_compliance.sql for
// the messages/consent_records/dnc_list/a2p_registrations schema.
//
// The billing/never-charge core (messages row -> wallet_hold -> Telnyx
// send -> settle/void) lives in _shared/messaging-send-core.ts, shared
// with messaging-send-mms and messaging-broadcast-run so all three
// produce identical billing behavior.
serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");

  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { to?: unknown; body?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const toRaw = typeof body.to === "string" ? body.to.trim() : "";
  const text   = typeof body.body === "string" ? body.body : "";
  if (!toRaw || !text) return json({ error: "to_and_body_required" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- Compliance gate: charge nothing on any failure here. Normalizes
  //     toRaw to E.164 internally — `to` below is always that canonical
  //     form, never the raw client input, so every write (messages row,
  //     ledger description, provider call) agrees with consent_records/
  //     dnc_list on what "this recipient" means. ---
  const gate = await runComplianceGate(sb, user.id, "sms", toRaw);
  if (!gate.ok) return json({ error: gate.reason, detail: gate.detail }, 403);
  const to = gate.normalizedAddress;

  // --- Sender identity: the agent's TEXTING number, not merely their caller
  //     ID. Only a number confirmed assigned to their approved 10DLC
  //     campaign (phone_numbers.sms_capable) may carry A2P traffic; a voice
  //     caller ID often is not that number, and carriers silently filter
  //     texts sent from an unregistered one. ---
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", user.id)
    .maybeSingle();
  const sender = await resolveTextingNumber(sb, user.id, agent?.signalwire_caller_id);
  if (!sender.ok) return json({ error: sender.reason, detail: sender.detail }, 400);
  const fromNumber = sender.fromNumber;

  const result = await sendMessageCore(
    { agentId: user.id, channel: "sms", to, fromNumber, text, consentId: gate.consentId },
    { sb, supabaseUrl: SUPABASE_URL, telnyxApiKey: TELNYX_API_KEY, telnyxMessagingProfileId: TELNYX_MSG_PROFILE_ID },
  );

  if (!result.ok) return json({ error: result.error, detail: result.detail }, result.httpStatus);

  // ------------------------------------------------------------
  // The conversation record, and the takeover it implies.
  //
  // This endpoint is only ever reached by a PERSON typing into the composer —
  // the AI sends through sms-ai-respond and the sweeper, both of which append
  // their own rows with sent_by 'ai'. So a send here means the agent has
  // stepped in, and the AI mutes itself on that thread until they turn it back
  // on. Two of them answering the same person is worse than neither.
  //
  // Best-effort and after the send: the message has gone and been billed by
  // this point, and failing the response over a thread row would tell the
  // agent their text did not send when it did.
  // ------------------------------------------------------------
  let conversationId: string | null = null;
  let aiMuted = false;
  try {
    const conv = await getOrCreateConversation(sb, {
      agentId: user.id, contactPhone: to, agentNumber: fromNumber,
    });
    conversationId = conv?.id ?? null;
    if (conversationId) {
      await appendMessage(sb, {
        conversationId, agentId: user.id, direction: "outbound", sentBy: "agent",
        body: text, messageId: result.messageId,
        providerMessageId: result.providerMessageId, status: "sent",
      });
      aiMuted = await autoMuteIfAgentWrote(sb, conversationId, "agent");
      // A thread the agent is working by hand gets no robot follow-ups.
      await cancelNudges(sb, conversationId, "ai_muted");
    }
  } catch (e) {
    console.error("[messaging-send-sms] thread write failed:", (e as Error)?.message);
  }

  return json({
    ok: true,
    message_id: result.messageId,
    provider_message_id: result.providerMessageId,
    hold_id: result.holdLedgerId,
    segments: result.segments,
    amount_mills: result.amountMills,
    conversation_id: conversationId,
    ai_muted: aiMuted,
  });
});
