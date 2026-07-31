import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { runComplianceGate, resolveTextingNumber } from "../_shared/messaging-shared.ts";
import { sendMessageCore } from "../_shared/messaging-send-core.ts";
import { chat, SMS_AI_TOOLS } from "../_shared/anthropic-chat.ts";
import { parseAppointmentTime, buildConfirmSms } from "../_shared/ai-appointment.ts";
import { knownTimezoneForPhone } from "../_shared/tcpa.ts";
import {
  buildSystemPrompt,
  hotAlertAllowed,
  hotAlertSms,
  matchCustomPair,
  normalizeSmsAiSettings,
  smsAiGate,
  tidyReply,
  warmHoldingLine,
  wantsHuman,
} from "../_shared/sms-ai-core.ts";
import {
  appendMessage,
  cancelNudges,
  loadSettings,
  muteAi,
  scheduleNextNudge,
} from "../_shared/sms-thread.ts";

// ============================================================
// sms-ai-respond — composes and sends ONE AI reply to ONE inbound text.
//
// WHO CALLS IT: messaging-inbound-webhook, fire-and-forget, presenting the
// SERVICE ROLE KEY as its bearer. That is the same arrangement
// voice-campaign-tick uses to call ai-call-start — the service key is itself a
// valid Supabase JWT, so this stays `verify_jwt = true` and is unreachable
// from a browser. The webhook must answer Telnyx in milliseconds and a model
// call is not milliseconds, which is why this is a second function rather than
// a branch in the first.
//
// 🔴 IT NEVER INITIATES. There is no path into this function that does not
// start with an inbound message from somebody whose SMS consent is already
// recorded. The nudges in sms-ai-nudge-sweep continue a conversation the lead
// started; nothing anywhere starts one.
//
// 🔴 IT IS NOT THE COMPLIANCE GATE. runComplianceGate() still runs on the send
// itself, exactly as it does for a broadcast or a hand-typed message. The
// consent check in smsAiGate() is an EARLIER and STRICTER refusal — do not
// read it as a replacement, and do not remove the gate below because "we
// already checked".
// ============================================================

// deno-lint-ignore no-explicit-any
type Db = any;

function json(body: unknown, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** How much of the thread the model sees. Enough for context, bounded for cost. */
const HISTORY_LIMIT = 20;

Deno.serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");
  const APP_URL = Deno.env.get("APP_URL") || "https://producerstackcrm.com";

  // Service role only. There is no user-facing reason to invoke this: a person
  // who wants to send a message uses messaging-send-sms.
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth || auth !== SERVICE_KEY) return json({ error: "forbidden" }, 403, CORS);

  let body: { conversation_id?: string; text?: string; inbound_message_id?: string; dry_run?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400, CORS); }

  const conversationId = String(body.conversation_id || "");
  const inboundText = String(body.text || "").trim();
  const dryRun = body.dry_run === true;
  if (!conversationId) return json({ error: "missing_conversation_id" }, 400, CORS);

  const sb: Db = createClient(SUPABASE_URL, SERVICE_KEY);

  // ---- The thread ---------------------------------------------------------
  const { data: conv } = await sb.from("sms_conversations")
    .select("id, agent_id, lead_id, contact_phone, agent_number, status, ai_muted, hot, hot_alerted_at, campaign_type, last_inbound_at, nudge_step")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) return json({ error: "conversation_not_found" }, 404, CORS);

  const agentId: string = conv.agent_id;

  // ---- Who we are ---------------------------------------------------------
  const { data: agent } = await sb.from("agents")
    .select("id, is_admin, plan_id, sms_ai_enabled, ai_agent_name, display_name, agency_name, transfer_number, signalwire_caller_id")
    .eq("id", agentId)
    .maybeSingle();

  let planName = "";
  if (agent?.plan_id) {
    const { data: plan } = await sb.from("plans").select("name").eq("id", agent.plan_id).maybeSingle();
    planName = (plan?.name || "").toLowerCase();
  }
  // Byte-identical to ai-call-start's gate 2, deliberately: one answer to
  // "is this account entitled to the AI", whichever channel is asking.
  const planEntitled = !!agent?.is_admin || planName.includes("leader") || planName.includes("pro");

  // ---- Who they are -------------------------------------------------------
  const { data: lead } = conv.lead_id
    ? await sb.from("leads").select("id, data, tcpa_consent, dnc, lead_timezone").eq("id", conv.lead_id).maybeSingle()
    : { data: null };
  const leadData = (lead?.data || {}) as Record<string, unknown>;
  const leadName = String(leadData.name || [leadData.first_name, leadData.last_name].filter(Boolean).join(" ") || "").trim();

  // ---- Consent and suppression -------------------------------------------
  // Read directly rather than inferred: the gate below refuses on this, and a
  // refusal about somebody's consent must be based on the record, not a cache.
  const { data: consentRows } = await sb.from("consent_records")
    .select("id, consent_type, revoked_at")
    .eq("agent_id", agentId)
    .eq("contact_phone", conv.contact_phone)
    .is("revoked_at", null)
    .limit(5);
  const hasConsent = (consentRows || []).some((r: { consent_type?: string }) =>
    r.consent_type === "express_written" || r.consent_type === "express");

  const { data: dncRows } = await sb.from("dnc_list")
    .select("id, agent_id")
    .eq("contact_phone", conv.contact_phone)
    .limit(5);
  const onDnc = (dncRows || []).some((r: { agent_id: string | null }) =>
    r.agent_id === null || r.agent_id === agentId);

  const settings = await loadSettings(sb, agentId, conv.campaign_type, normalizeSmsAiSettings);

  // ---- The gates ----------------------------------------------------------
  const refusal = smsAiGate({
    text: inboundText,
    // STOP never reaches here — the webhook handles it and does not dispatch.
    // Passed as false rather than omitted so the gate's own ordering test
    // still exercises the branch.
    isOptOut: false,
    onDnc,
    hasConsent,
    accountEnabled: agent?.sms_ai_enabled !== false,
    planEntitled,
    conversationStatus: conv.status,
    aiMuted: conv.ai_muted === true,
    typeEnabled: settings.enabled,
    hasLead: !!conv.lead_id,
  });

  if (refusal) {
    // Nothing is sent, and the thread stays visible to the agent — which is
    // the whole point of refusing rather than failing.
    return json({ ok: true, replied: false, refusal }, 200, CORS);
  }

  // ---- The deterministic pre-match ---------------------------------------
  //
  // An unambiguous hit on the agent's own answers is used VERBATIM and the
  // model is never called. That is not an optimisation: an agent who wrote
  // "our waiting period is two years" wants those words sent, not a friendly
  // approximation of them.
  const pair = matchCustomPair(inboundText, settings.custom_pairs);

  let replyText = "";
  let usedModel = false;
  let flagReason: string | null = null;
  let bookingText: string | null = null;
  let bookingNotes = "";

  if (pair.reason === "hit" && pair.answer) {
    replyText = pair.answer;
  } else if (!ANTHROPIC_KEY) {
    // No key configured: surface rather than send something generic.
    return json({ ok: true, replied: false, refusal: "no_model_key" }, 200, CORS);
  } else {
    usedModel = true;

    const { data: history } = await sb.from("sms_messages")
      .select("direction, sent_by, body, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    const msgs = (history || [])
      .slice()
      .reverse()
      .filter((m: { body?: string }) => String(m.body || "").trim())
      .map((m: { direction: string; body: string }) => ({
        role: (m.direction === "inbound" ? "user" : "assistant") as "user" | "assistant",
        content: String(m.body),
      }));

    // The inbound that triggered this run may not be in the history read yet
    // (the webhook writes it and dispatches in the same breath), so make sure
    // it is the last thing the model sees.
    if (!msgs.length || msgs[msgs.length - 1].role !== "user" || msgs[msgs.length - 1].content !== inboundText) {
      msgs.push({ role: "user", content: inboundText });
    }

    const system = buildSystemPrompt({
      aiName: agent?.ai_agent_name,
      agentName: agent?.display_name,
      agencyName: agent?.agency_name,
      leadName,
      leadTimezone: lead?.lead_timezone || knownTimezoneForPhone(conv.contact_phone) || null,
      campaignLabel: conv.campaign_type,
      qualification: (leadData.ai_qualification as Record<string, unknown>) || null,
      settings,
    });

    let result;
    try {
      result = await chat({ apiKey: ANTHROPIC_KEY, system, messages: msgs, tools: SMS_AI_TOOLS });
    } catch (e) {
      console.error("[sms-ai-respond] model call failed:", (e as Error)?.message);
      // Hand it to the agent rather than guessing. A wrong answer on a
      // consumer's phone costs more than a missed one.
      await sb.from("sms_conversations").update({
        hot: true, hot_reason: "AI could not answer", hot_at: new Date().toISOString(),
      }).eq("id", conversationId);
      return json({ ok: true, replied: false, refusal: "model_error" }, 200, CORS);
    }

    replyText = result.text;
    for (const t of result.toolUses) {
      if (t.name === "flag_for_agent") flagReason = String(t.input.reason || "").slice(0, 120) || "ready to talk";
      if (t.name === "book_appointment") {
        bookingText = String(t.input.datetime_text || "").trim();
        bookingNotes = String(t.input.notes || "").trim();
        const personName = String(t.input.person_name || "").trim();
        // Only ever FILLS A BLANK, same rule as the voice tool: somebody
        // mistyping a name must not rename an existing lead in the book.
        if (personName && conv.lead_id && !leadName) {
          await sb.from("leads").update({ data: { ...leadData, name: personName.slice(0, 120) } })
            .eq("id", conv.lead_id);
        }
      }
    }
  }

  // ---- Booking ------------------------------------------------------------
  //
  // The SAME machinery voice uses: parseAppointmentTime() decides the instant,
  // ai_appointments is the row, buildConfirmSms() writes the confirmation.
  // Nothing about times is reimplemented here.
  let appointmentId: string | null = null;
  let bookingProblem: string | null = null;
  const leadTz = lead?.lead_timezone || knownTimezoneForPhone(conv.contact_phone) || "America/Chicago";

  if (bookingText && !dryRun) {
    const parsed = parseAppointmentTime(bookingText, leadTz, new Date());
    if (!parsed.ok) {
      // The model must re-ask rather than invent a time, so the reply says so.
      bookingProblem = parsed.reason;
      if (!replyText) replyText = "Sorry — what day and time works best for you?";
    } else {
      const { data: appt } = await sb.from("ai_appointments").insert({
        agent_id: agentId,
        lead_id: conv.lead_id,
        sms_conversation_id: conversationId,
        starts_at: parsed.at.toISOString(),
        lead_timezone: leadTz,
        spoken_time_text: bookingText.slice(0, 300),
        lead_name: leadName || null,
        lead_phone_e164: conv.contact_phone,
        notes: bookingNotes ? bookingNotes.slice(0, 2000) : null,
        source: "ai_text",
      }).select("id").maybeSingle();
      appointmentId = appt?.id ?? null;

      if (appointmentId) {
        // A booked conversation has no reason to be nudged.
        await cancelNudges(sb, conversationId, "booked");
      }
    }
  }

  // ---- Hot handoff --------------------------------------------------------
  //
  // Two ways in: the model's flag_for_agent tool, and a deterministic phrase
  // match that does not depend on the model noticing. A plain "can someone
  // call me" must never be missed because a model was terse that day.
  const deterministicHot = wantsHuman(inboundText, agent?.display_name);
  const isHot = !!flagReason || deterministicHot;
  let alerted = false;

  if (isHot && !dryRun) {
    const reason = flagReason || "asked to speak with someone";
    await sb.from("sms_conversations").update({
      hot: true, hot_reason: reason, hot_at: new Date().toISOString(),
    }).eq("id", conversationId);

    if (hotAlertAllowed(conv.hot_alerted_at, new Date()) && agent?.transfer_number && TELNYX_API_KEY) {
      const text = hotAlertSms({
        leadName: leadName || null,
        reason,
        link: `${APP_URL}/app.html#lead=${conv.lead_id || ""}`,
      });
      // The agent's OWN cell, through the platform path — this is a
      // notification to our customer, not marketing to a consumer, so it does
      // not go through runComplianceGate and is not billed to their wallet.
      // Same treatment as the opt-out confirmation.
      try {
        const from = agent?.signalwire_caller_id || conv.agent_number;
        if (from) {
          await fetch("https://api.telnyx.com/v2/messages", {
            method: "POST",
            headers: { "Authorization": `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from, to: agent.transfer_number, text,
              ...(TELNYX_MSG_PROFILE_ID ? { messaging_profile_id: TELNYX_MSG_PROFILE_ID } : {}),
            }),
          });
          alerted = true;
        }
      } catch (e) {
        console.error("[sms-ai-respond] hot alert failed:", (e as Error)?.message);
      }
      // Stamped only on an actual send, so a failed alert does not consume the
      // 4-hour window.
      if (alerted) {
        await sb.from("sms_conversations").update({ hot_alerted_at: new Date().toISOString() })
          .eq("id", conversationId);
      }
    }

    // Keep the conversation warm rather than going silent while they wait.
    if (!replyText) replyText = warmHoldingLine(agent?.display_name);
  }

  replyText = tidyReply(replyText);
  if (!replyText) return json({ ok: true, replied: false, refusal: "empty_reply" }, 200, CORS);
  if (dryRun) {
    return json({
      ok: true, dry_run: true, replied: false, reply: replyText,
      used_model: usedModel, pair_reason: pair.reason, hot: isHot,
      booking: bookingText ? { text: bookingText, problem: bookingProblem } : null,
    }, 200, CORS);
  }

  // ---- Send ---------------------------------------------------------------
  //
  // Through the ordinary path. runComplianceGate runs again here on purpose —
  // it is the send gate, and this function is not it.
  const gate = await runComplianceGate(sb, agentId, "sms", conv.contact_phone);
  if (!gate.ok) {
    return json({ ok: true, replied: false, refusal: `gate_${gate.reason}`, detail: gate.detail }, 200, CORS);
  }
  const sender = await resolveTextingNumber(sb, agentId, agent?.signalwire_caller_id || null);
  if (!sender.ok) {
    return json({ ok: true, replied: false, refusal: `sender_${sender.reason}` }, 200, CORS);
  }

  const sent = await sendMessageCore(
    {
      agentId, channel: "sms", to: gate.normalizedAddress,
      fromNumber: sender.fromNumber, text: replyText, consentId: gate.consentId,
    },
    { sb, supabaseUrl: SUPABASE_URL, telnyxApiKey: TELNYX_API_KEY!, telnyxMessagingProfileId: TELNYX_MSG_PROFILE_ID },
  );

  await appendMessage(sb, {
    conversationId,
    agentId,
    direction: "outbound",
    sentBy: "ai",
    body: replyText,
    messageId: sent.ok ? sent.messageId : null,
    providerMessageId: sent.ok ? sent.providerMessageId : null,
    status: sent.ok ? "sent" : "failed",
    failedReason: sent.ok ? null : `${sent.error}${sent.detail ? `: ${sent.detail}` : ""}`.slice(0, 300),
  });

  // ---- The confirmation text, if we just booked --------------------------
  if (appointmentId) {
    const parsedAt = await sb.from("ai_appointments").select("starts_at").eq("id", appointmentId).maybeSingle();
    const at = parsedAt.data?.starts_at ? new Date(parsedAt.data.starts_at) : null;
    if (at) {
      const confirm = buildConfirmSms({
        firstName: leadName.split(/\s+/)[0] || null,
        aiName: agent?.ai_agent_name,
        companyName: agent?.agency_name,
        at,
        timeZone: leadTz,
      });
      const c = await sendMessageCore(
        {
          agentId, channel: "sms", to: gate.normalizedAddress,
          fromNumber: sender.fromNumber, text: confirm, consentId: gate.consentId,
        },
        { sb, supabaseUrl: SUPABASE_URL, telnyxApiKey: TELNYX_API_KEY!, telnyxMessagingProfileId: TELNYX_MSG_PROFILE_ID },
      );
      // Never null on success or failure — the same rule the voice path keeps.
      await sb.from("ai_appointments").update({
        sms_confirm_status: c.ok ? "sent" : `failed:${c.error}`,
        ...(c.ok ? { sms_message_id: c.messageId } : {}),
      }).eq("id", appointmentId);
      await appendMessage(sb, {
        conversationId, agentId, direction: "outbound", sentBy: "system",
        body: confirm, messageId: c.ok ? c.messageId : null,
        status: c.ok ? "sent" : "failed",
      });
      // The AI stops volunteering once the job is done; the agent takes it
      // from here and can turn it back on.
      await muteAi(sb, conversationId, "booked");
    }
  }

  // ---- The follow-up schedule --------------------------------------------
  if (!appointmentId) {
    await scheduleNextNudge(sb, {
      conversationId,
      agentId,
      settings,
      lastInboundAt: conv.last_inbound_at || new Date().toISOString(),
      afterStep: 0, // they just replied — the schedule restarts from the top
    });
    await sb.from("sms_conversations").update({ nudge_step: 0 }).eq("id", conversationId);
  }

  return json({
    ok: true,
    replied: sent.ok,
    used_model: usedModel,
    pair_reason: pair.reason,
    hot: isHot,
    alerted,
    appointment_id: appointmentId,
    booking_problem: bookingProblem,
    ...(sent.ok ? {} : { send_error: sent.error }),
  }, 200, CORS);
});
