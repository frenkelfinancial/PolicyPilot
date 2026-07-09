import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runComplianceGate, bodyPreview } from "../_shared/messaging-shared.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Authorize-then-capture MMS send — same shape as messaging-send-sms, but
// billed as a flat billing_config.mms_mills per send (not per-segment;
// carriers bill MMS per-message, not per-character) and carries media_urls.
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

  let body: { to?: unknown; body?: unknown; media_urls?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const toRaw      = typeof body.to === "string" ? body.to.trim() : "";
  const text       = typeof body.body === "string" ? body.body : "";
  const mediaUrls: string[] = Array.isArray(body.media_urls)
    ? body.media_urls.filter((u): u is string => typeof u === "string")
    : [];
  if (!toRaw || mediaUrls.length === 0) return json({ error: "to_and_media_urls_required" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- Compliance gate: charge nothing on any failure here. Normalizes
  //     toRaw to E.164 internally — `to` below is always that canonical
  //     form, agreeing with consent_records/dnc_list on what "this
  //     recipient" means. ---
  const gate = await runComplianceGate(sb, user.id, "mms", toRaw);
  if (!gate.ok) return json({ error: gate.reason, detail: gate.detail }, 403);
  const to = gate.normalizedAddress;

  // --- Sender identity (agent's caller ID). ---
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", user.id)
    .maybeSingle();
  const fromNumber = agent?.signalwire_caller_id;
  if (!fromNumber) return json({ error: "sender_not_configured", detail: "No outbound caller ID configured for this agent." }, 400);

  // --- Cost + hold (flat per-send rate). ---
  const { data: billingConfig } = await sb.from("billing_config")
    .select("mms_mills")
    .eq("id", 1)
    .maybeSingle();
  const amountMills = billingConfig?.mms_mills ?? 30;

  const { data: messageRow, error: insertErr } = await sb.from("messages").insert({
    agent_id:            user.id,
    channel:             "mms",
    to_address:          to,
    from_number:         fromNumber,
    body_preview:        bodyPreview(text || `[${mediaUrls.length} attachment(s)]`),
    segments:            null,
    status:              "queued",
    consent_id:          gate.consentId,
  }).select("id").single();

  if (insertErr || !messageRow) {
    return json({ error: "db_insert_failed", detail: insertErr?.message }, 500);
  }

  const { data: holdLedgerId, error: holdErr } = await sb.rpc("wallet_hold", {
    p_agent:        user.id,
    p_category:     "mms",
    p_units:        1,
    p_amount_mills: amountMills,
    p_ref_type:     "message",
    p_ref_id:       messageRow.id,
    p_desc:         `MMS to ${to} — $${(amountMills / 1000).toFixed(3)}`,
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
      text: text || undefined,
      media_urls: mediaUrls,
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
    amount_mills: amountMills,
  });
});
