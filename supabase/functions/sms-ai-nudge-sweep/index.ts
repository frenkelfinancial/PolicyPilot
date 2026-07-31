import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runComplianceGate, resolveTextingNumber } from "../_shared/messaging-shared.ts";
import { sendMessageCore } from "../_shared/messaging-send-core.ts";
import { knownTimezoneForPhone } from "../_shared/tcpa.ts";
import { chat } from "../_shared/anthropic-chat.ts";
import {
  buildSystemPrompt,
  deferNudge,
  normalizeSmsAiSettings,
  nudgeAllowedAt,
  tidyReply,
} from "../_shared/sms-ai-core.ts";
import { appendMessage, cancelNudges, loadSettings, scheduleNextNudge } from "../_shared/sms-thread.ts";

// ============================================================
// sms-ai-nudge-sweep — the quiet-lead follow-up worker.
//
// 🔴 WHY THIS IS A NEW FUNCTION AND NOT AN EXTENSION OF messaging-timeout-sweep
//
// The brief said to reuse messaging-timeout-sweep "if that is what it exists
// for". It is not. That function is a WALLET SAFETY NET: it finds `messages`
// rows whose hold never got a delivery receipt inside
// billing_config.message_dlr_timeout_hours and calls wallet_void on them, so
// money is never held forever for a send that was never confirmed. It has
// nothing to do with conversations, reads no lead, sends no message and is
// authenticated with WALLET_CRON_SECRET because it moves money.
//
// Bolting "text this consumer" onto it would put outbound messaging inside a
// billing reconciler that runs hourly against wallet_void — one function with
// two unrelated failure modes, where a bug in the nudge path can strand a
// wallet hold. They are scheduled separately and they stay separate.
//
// WHAT THIS ONE DOES: finds sms_nudges rows that are due, checks the follow-up
// is still wanted, defers anything outside the lead's 9am–8pm-no-Sunday
// window, and sends one message. Every send goes through runComplianceGate and
// sendMessageCore like any other — a nudge is a normal billable SMS.
// ============================================================

// deno-lint-ignore no-explicit-any
type Db = any;

/** Bounded so one sweep cannot run away; the cron comes round again. */
const BATCH = 100;

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET = Deno.env.get("SMS_AI_CRON_SECRET") || Deno.env.get("WALLET_CRON_SECRET");
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");

  const authHeader = req.headers.get("Authorization") || "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const sb: Db = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = new Date();

  const { data: due, error } = await sb.from("sms_nudges")
    .select("id, conversation_id, agent_id, step, due_at")
    .eq("status", "scheduled")
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    return new Response(JSON.stringify({ error: "fetch_failed", detail: error.message }), { status: 500 });
  }

  const out = { due: (due || []).length, sent: 0, deferred: 0, cancelled: 0, skipped: 0, failed: 0 };

  for (const nudge of due || []) {
    try {
      const { data: conv } = await sb.from("sms_conversations")
        .select("id, agent_id, lead_id, contact_phone, agent_number, status, ai_muted, campaign_type, last_inbound_at, last_outbound_at, nudge_step")
        .eq("id", nudge.conversation_id)
        .maybeSingle();

      // ---- Is this still wanted? ----------------------------------------
      // Every one of these is a NUDGE_CANCEL_REASON, and the check is here as
      // well as at the event that caused it. Belt and braces on purpose: the
      // cost of a missed cancellation is a text to somebody who told us to
      // stop, so it is checked again at the last possible moment.
      if (!conv || conv.status === "closed") {
        await cancel(sb, nudge.id, "conversation_closed"); out.cancelled++; continue;
      }
      if (conv.ai_muted) { await cancel(sb, nudge.id, "ai_muted"); out.cancelled++; continue; }

      const { data: dncRows } = await sb.from("dnc_list")
        .select("agent_id").eq("contact_phone", conv.contact_phone).limit(5);
      if ((dncRows || []).some((r: { agent_id: string | null }) => r.agent_id === null || r.agent_id === conv.agent_id)) {
        await cancel(sb, nudge.id, "on_dnc"); out.cancelled++; continue;
      }

      // They answered after this was scheduled — sms-ai-respond reschedules
      // from the new inbound, so this row is stale.
      if (conv.last_inbound_at && new Date(conv.last_inbound_at).getTime() > new Date(nudge.due_at).getTime() - 1000) {
        await cancel(sb, nudge.id, "lead_replied"); out.cancelled++; continue;
      }

      const { data: booked } = await sb.from("ai_appointments")
        .select("id").eq("sms_conversation_id", conv.id).eq("status", "scheduled").limit(1);
      if ((booked || []).length) { await cancel(sb, nudge.id, "booked"); out.cancelled++; continue; }

      // ---- Quiet hours: DEFER, never drop -------------------------------
      const tz = knownTimezoneForPhone(conv.contact_phone) || "America/Chicago";
      if (!nudgeAllowedAt(now, tz)) {
        const next = deferNudge(now, tz);
        await sb.from("sms_nudges").update({ due_at: next.toISOString() }).eq("id", nudge.id);
        out.deferred++;
        continue;
      }

      const settings = await loadSettings(sb, conv.agent_id, conv.campaign_type, normalizeSmsAiSettings);
      if (!settings.enabled) { await cancel(sb, nudge.id, "settings_disabled"); out.cancelled++; continue; }

      const { data: agent } = await sb.from("agents")
        .select("sms_ai_enabled, ai_agent_name, display_name, agency_name, signalwire_caller_id")
        .eq("id", conv.agent_id).maybeSingle();
      if (agent?.sms_ai_enabled === false) { await cancel(sb, nudge.id, "settings_disabled"); out.cancelled++; continue; }

      // ---- Compose ------------------------------------------------------
      const { data: lead } = conv.lead_id
        ? await sb.from("leads").select("data").eq("id", conv.lead_id).maybeSingle()
        : { data: null };
      const leadData = (lead?.data || {}) as Record<string, unknown>;
      const leadName = String(leadData.name || "").trim();

      const { data: history } = await sb.from("sms_messages")
        .select("direction, body").eq("conversation_id", conv.id)
        .order("created_at", { ascending: false }).limit(10);
      const msgs = (history || []).slice().reverse()
        .filter((m: { body?: string }) => String(m.body || "").trim())
        .map((m: { direction: string; body: string }) => ({
          role: (m.direction === "inbound" ? "user" : "assistant") as "user" | "assistant",
          content: String(m.body),
        }));

      let text = fallbackNudge(nudge.step, leadName);
      if (ANTHROPIC_KEY && msgs.length) {
        try {
          const system = buildSystemPrompt({
            aiName: agent?.ai_agent_name, agentName: agent?.display_name,
            agencyName: agent?.agency_name, leadName, leadTimezone: tz,
            campaignLabel: conv.campaign_type, qualification: null, settings,
          }) + "\n\nThe person has gone quiet. Send ONE short, friendly follow-up that gives them an easy way " +
            "back into the conversation. Do not apologise for texting, do not repeat what you already said, " +
            "and do not use the word 'just'. Never imply they are ignoring you.";
          // No tools on a nudge. A follow-up nobody asked for must not be able
          // to book anything or raise an alert; it is one sentence.
          const r = await chat({
            apiKey: ANTHROPIC_KEY, system,
            messages: [...msgs, { role: "user", content: "(no reply yet)" }],
            maxTokens: 200,
          });
          if (r.text.trim()) text = r.text;
        } catch (e) {
          console.error("[sms-ai-nudge-sweep] model call failed, using fallback:", (e as Error)?.message);
        }
      }
      text = tidyReply(text);
      if (!text) { await cancel(sb, nudge.id, "settings_disabled"); out.skipped++; continue; }

      // ---- Send, through the ordinary gates ------------------------------
      const gate = await runComplianceGate(sb, conv.agent_id, "sms", conv.contact_phone);
      if (!gate.ok) {
        // Quiet hours from the LEGAL gate is a deferral too — it is a wait,
        // not a refusal, and dropping it would lose the follow-up entirely.
        if (gate.reason === "quiet_hours") {
          await sb.from("sms_nudges")
            .update({ due_at: deferNudge(new Date(now.getTime() + 60 * 60 * 1000), tz).toISOString() })
            .eq("id", nudge.id);
          out.deferred++;
        } else {
          await cancel(sb, nudge.id, gate.reason === "on_dnc_list" ? "on_dnc" : "settings_disabled");
          out.cancelled++;
        }
        continue;
      }

      const sender = await resolveTextingNumber(sb, conv.agent_id, agent?.signalwire_caller_id || null);
      if (!sender.ok) { out.skipped++; continue; }

      const sent = await sendMessageCore(
        {
          agentId: conv.agent_id, channel: "sms", to: gate.normalizedAddress,
          fromNumber: sender.fromNumber, text, consentId: gate.consentId,
        },
        { sb, supabaseUrl: SUPABASE_URL, telnyxApiKey: TELNYX_API_KEY!, telnyxMessagingProfileId: TELNYX_MSG_PROFILE_ID },
      );

      const smsMessageId = await appendMessage(sb, {
        conversationId: conv.id, agentId: conv.agent_id,
        direction: "outbound", sentBy: "ai", body: text,
        messageId: sent.ok ? sent.messageId : null,
        providerMessageId: sent.ok ? sent.providerMessageId : null,
        status: sent.ok ? "sent" : "failed",
        failedReason: sent.ok ? null : sent.error,
      });

      await sb.from("sms_nudges").update({
        status: sent.ok ? "sent" : "failed",
        sent_at: new Date().toISOString(),
        sms_message_id: smsMessageId,
        ...(sent.ok ? {} : { cancel_reason: sent.error }),
      }).eq("id", nudge.id);

      await sb.from("sms_conversations").update({ nudge_step: nudge.step }).eq("id", conv.id);

      // Queue the step after this one. Offsets are measured from the lead's
      // last message, so an exhausted schedule simply returns null and the
      // conversation goes quiet — which is the correct ending.
      await scheduleNextNudge(sb, {
        conversationId: conv.id, agentId: conv.agent_id, settings,
        lastInboundAt: conv.last_inbound_at, afterStep: nudge.step,
      });

      if (sent.ok) out.sent++; else out.failed++;
    } catch (e) {
      console.error("[sms-ai-nudge-sweep] nudge failed:", (e as Error)?.message);
      out.failed++;
    }
  }

  return new Response(JSON.stringify({ ok: true, ...out }), {
    headers: { "Content-Type": "application/json" },
  });
});

// deno-lint-ignore no-explicit-any
async function cancel(sb: any, id: string, reason: string) {
  await sb.from("sms_nudges").update({ status: "cancelled", cancel_reason: reason }).eq("id", id);
}

/**
 * What goes out if the model is unavailable.
 *
 * Deliberately plain and step-aware. A follow-up that has to be perfect is a
 * follow-up that does not get sent when the model is down, and the point of
 * the schedule is that somebody hears from us.
 */
function fallbackNudge(step: number, leadName: string): string {
  const hi = leadName ? `Hi ${leadName.split(/\s+/)[0]}, ` : "Hi, ";
  switch (step) {
    case 1: return `${hi}wanted to make sure you got my last message — happy to answer any questions.`;
    case 2: return `${hi}still happy to help whenever you have a minute.`;
    case 3: return `${hi}is now a better time to pick this back up?`;
    default: return `${hi}I'll leave this here — reply any time and I'll pick it straight back up.`;
  }
}
