// ============================================================
// supabase/functions/_shared/messaging-send-core.ts
//
// Shared authorize-then-capture SEND core for SMS/MMS: messages row ->
// wallet_hold -> provider (Telnyx) send -> messages row updated to
// sent/failed. NEVER settled here — messaging-delivery-webhook resolves
// the hold on the carrier's DLR (delivered -> wallet_settle,
// failed/undelivered -> wallet_void, net $0).
//
// Factored out of messaging-send-sms so messaging-send-mms AND
// messaging-broadcast-run all produce byte-identical billing/never-charge
// behavior instead of three copies that can drift. Callers MUST run
// runComplianceGate (messaging-shared.ts) first and only call
// sendMessageCore on ok:true — this module charges the wallet, it does
// not gate.
//
// Plain-enough module to unit test under `node --test` (see
// messaging-send-core.test.ts): the Supabase client and fetch are both
// passed in as deps, so a test can supply an in-memory fake for both
// instead of hitting a real database or the real Telnyx API.
// ============================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { smsAmountMills } from "./segments.ts";
import { bodyPreview } from "./messaging-shared.ts";

export type SendChannel = "sms" | "mms";

export interface SendMessageParams {
  agentId: string;
  channel: SendChannel;
  /** Already-normalized E.164 — the output of runComplianceGate's normalizedAddress, never raw input. */
  to: string;
  fromNumber: string;
  text: string;
  mediaUrls?: string[];
  consentId: string;
}

export interface SendMessageDeps {
  // deno-lint-ignore no-explicit-any
  sb: SupabaseClient<any, any, any>;
  supabaseUrl: string;
  telnyxApiKey: string;
  telnyxMessagingProfileId?: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export type SendMessageResult =
  | {
      ok: true;
      messageId: string;
      providerMessageId: string | null;
      holdLedgerId: string;
      segments: number | null;
      amountMills: number;
    }
  | { ok: false; httpStatus: number; error: string; detail?: string };

export async function sendMessageCore(
  params: SendMessageParams,
  deps: SendMessageDeps,
): Promise<SendMessageResult> {
  const { sb, supabaseUrl, telnyxApiKey, telnyxMessagingProfileId } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { agentId, channel, to, fromNumber, text, consentId } = params;
  const mediaUrls = params.mediaUrls ?? [];

  // --- Cost. SMS bills per-segment; MMS bills flat per-send (carriers
  //     bill MMS per-message, not per-character). ---
  const { data: billingConfig } = await sb.from("billing_config")
    .select("sms_segment_mills, mms_mills")
    .eq("id", 1)
    .maybeSingle();

  let segments: number | null = null;
  let amountMills: number;
  if (channel === "sms") {
    const segmentMills = billingConfig?.sms_segment_mills ?? 10;
    const info = smsAmountMills(text, segmentMills);
    segments = info.segments;
    amountMills = info.amountMills;
  } else {
    amountMills = billingConfig?.mms_mills ?? 30;
  }

  // --- Insert the messages row first (no hold yet) so the ledger's
  //     ref_id can point at a real row from the moment the hold exists. ---
  const { data: messageRow, error: insertErr } = await sb.from("messages").insert({
    agent_id:     agentId,
    channel,
    to_address:   to,
    from_number:  fromNumber,
    body_preview: bodyPreview(text || (mediaUrls.length ? `[${mediaUrls.length} attachment(s)]` : "")),
    segments,
    status:       "queued",
    consent_id:   consentId,
  }).select("id").single();

  if (insertErr || !messageRow) {
    return { ok: false, httpStatus: 500, error: "db_insert_failed", detail: insertErr?.message };
  }

  const { data: holdLedgerId, error: holdErr } = await sb.rpc("wallet_hold", {
    p_agent:        agentId,
    p_category:     channel,
    p_units:        segments ?? 1,
    p_amount_mills: amountMills,
    p_ref_type:     "message",
    p_ref_id:       messageRow.id,
    p_desc:         channel === "sms"
      ? `SMS to ${to} — ${segments} segment${segments === 1 ? "" : "s"}`
      : `MMS to ${to} — $${(amountMills / 1000).toFixed(3)}`,
  });

  if (holdErr) {
    const reason = holdErr.message?.includes("insufficient_balance") ? "insufficient_balance" : "hold_failed";
    await sb.from("messages").update({ status: "failed", failed_reason: reason }).eq("id", messageRow.id);
    return {
      ok: false,
      httpStatus: reason === "insufficient_balance" ? 402 : 500,
      error: reason,
      detail: holdErr.message,
    };
  }

  await sb.from("messages").update({ hold_ledger_id: holdLedgerId }).eq("id", messageRow.id);

  // --- Send via Telnyx. Any failure here voids the hold immediately —
  //     never-charge-undelivered applies to provider rejection too, not
  //     just carrier DLRs. ---
  const webhookUrl = `${supabaseUrl}/functions/v1/messaging-delivery-webhook`;
  const telnyxRes = await fetchImpl("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${telnyxApiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from: fromNumber,
      to,
      text: text || undefined,
      ...(channel === "mms" ? { media_urls: mediaUrls } : {}),
      ...(telnyxMessagingProfileId ? { messaging_profile_id: telnyxMessagingProfileId } : {}),
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
    return { ok: false, httpStatus: 502, error: "send_failed", detail: errText };
  }

  const telnyxData = await telnyxRes.json();
  const providerMessageId = telnyxData?.data?.id ?? null;

  await sb.from("messages").update({
    status: "sent",
    provider_message_id: providerMessageId,
  }).eq("id", messageRow.id);

  return {
    ok: true,
    messageId: messageRow.id,
    providerMessageId,
    holdLedgerId,
    segments,
    amountMills,
  };
}
