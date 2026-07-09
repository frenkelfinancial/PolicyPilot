import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runComplianceGate, bodyPreview } from "../_shared/messaging-shared.ts";
import { smsAmountMills } from "../_shared/segments.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Authorize-then-capture SMS send: compliance gate (A2P approved, consent,
// not on DNC, within TCPA quiet hours) -> wallet_hold for the segment cost
// -> Telnyx send -> messages row. NEVER settled here — messaging-delivery-
// webhook resolves the hold on the carrier's DLR (delivered -> settle,
// failed/undelivered -> void, net $0). See 016_wallet_foundation.sql for
// the wallet_hold/settle/void RPCs and 019_messaging_compliance.sql for
// the messages/consent_records/dnc_list/a2p_registrations schema.
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

  // --- Sender identity (agent's caller ID). ---
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", user.id)
    .maybeSingle();
  const fromNumber = agent?.signalwire_caller_id;
  if (!fromNumber) return json({ error: "sender_not_configured", detail: "No outbound caller ID configured for this agent." }, 400);

  // --- Cost + hold. ---
  const { data: billingConfig } = await sb.from("billing_config")
    .select("sms_segment_mills")
    .eq("id", 1)
    .maybeSingle();
  const segmentMills = billingConfig?.sms_segment_mills ?? 10;
  const { segments, amountMills } = smsAmountMills(text, segmentMills);

  // --- Insert the messages row first (no hold yet) so the ledger's
  //     ref_id can point at a real row from the moment the hold exists. ---
  const { data: messageRow, error: insertErr } = await sb.from("messages").insert({
    agent_id:            user.id,
    channel:             "sms",
    to_address:          to,
    from_number:         fromNumber,
    body_preview:        bodyPreview(text),
    segments,
    status:              "queued",
    consent_id:          gate.consentId,
  }).select("id").single();

  if (insertErr || !messageRow) {
    return json({ error: "db_insert_failed", detail: insertErr?.message }, 500);
  }

  const { data: holdLedgerId, error: holdErr } = await sb.rpc("wallet_hold", {
    p_agent:        user.id,
    p_category:     "sms",
    p_units:        segments,
    p_amount_mills: amountMills,
    p_ref_type:     "message",
    p_ref_id:       messageRow.id,
    p_desc:         `SMS to ${to} — ${segments} segment${segments === 1 ? "" : "s"} @ $${(segmentMills / 1000).toFixed(3)}`,
  });

  if (holdErr) {
    const reason = holdErr.message?.includes("insufficient_balance") ? "insufficient_balance" : "hold_failed";
    await sb.from("messages").update({ status: "failed", failed_reason: reason }).eq("id", messageRow.id);
    if (reason === "insufficient_balance") {
      return json({ error: "insufficient_balance", detail: "Insufficient wallet balance — top up to send this message." }, 402);
    }
    return json({ error: "hold_failed", detail: holdErr.message }, 500);
  }

  await sb.from("messages").update({ hold_ledger_id: holdLedgerId }).eq("id", messageRow.id);

  // --- Send via Telnyx. Any failure here voids the hold immediately —
  //     never-charge-undelivered applies to provider rejection too, not
  //     just carrier DLRs. ---
  const webhookUrl = `${SUPABASE_URL}/functions/v1/messaging-delivery-webhook`;
  const telnyxRes = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from: fromNumber,
      to,
      text,
      ...(TELNYX_MSG_PROFILE_ID ? { messaging_profile_id: TELNYX_MSG_PROFILE_ID } : {}),
      webhook_url: webhookUrl,
      webhook_failover_url: webhookUrl,
    }),
  });

  if (!telnyxRes.ok) {
    const errText = await telnyxRes.text();
    await sb.rpc("wallet_void", { p_ledger_id: holdLedgerId });
    await sb.from("messages").update({
      status: "failed",
      failed_reason: `telnyx_rejected: ${telnyxRes.status} ${errText}`,
    }).eq("id", messageRow.id);
    return json({ error: "send_failed", detail: errText }, 502);
  }

  const telnyxData = await telnyxRes.json();
  const providerMessageId = telnyxData?.data?.id ?? null;

  await sb.from("messages").update({
    status: "sent",
    provider_message_id: providerMessageId,
  }).eq("id", messageRow.id);

  return json({
    ok: true,
    message_id: messageRow.id,
    provider_message_id: providerMessageId,
    hold_id: holdLedgerId,
    segments,
    amount_mills: amountMills,
  });
});
