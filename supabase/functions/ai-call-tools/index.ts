import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyTelnyxSignature } from "../_shared/webhook-verify.ts";
import { toE164 } from "../_shared/phone.ts";
import { knownTimezoneForPhone } from "../_shared/tcpa.ts";
import { runComplianceGate, resolveTextingNumber } from "../_shared/messaging-shared.ts";
import { sendMessageCore } from "../_shared/messaging-send-core.ts";
import {
  buildConfirmSms,
  parseAppointmentTime,
  speakTime,
} from "../_shared/ai-appointment.ts";

// ai-call-tools — the endpoint the Telnyx AI Assistant's webhook TOOLS call
// mid-conversation. Two tools:
//
//   transfer_to_agent  — the warm transfer. Reads the agent's availability
//                        FRESH, dials their cell, and returns immediately so
//                        the lead is not left listening to silence while it
//                        rings. The whisper, the press-1 confirm and the
//                        bridge all happen in ai-call-webhook, driven by the
//                        agent leg's own Call Control events.
//   book_appointment   — parses what the lead agreed to into an instant in
//                        THEIR timezone, writes ai_appointments, and fires the
//                        confirmation SMS off the critical path.
//
// verify_jwt = false in config.toml, and load-bearing: Telnyx signs tool calls
// the same Ed25519 way it signs call-control webhooks, and cannot supply a
// Supabase JWT. This function does its own auth — see below.
//
// ---- Auth: two independent gates, either of which is sufficient to REJECT --
//
// 1. A shared secret (`AI_TOOLS_SECRET`) carried in the URL. The tool URL
//    lives inside the assistant's configuration, which only we can write, so
//    this is a bearer credential we fully control.
// 2. The Telnyx Ed25519 signature, when the headers are present.
//
// A request with a BAD signature is rejected even if the secret is right. A
// request with NO signature headers is accepted on the secret alone, because
// the exact signing behaviour of assistant tool calls (as opposed to
// call-control webhooks) has not been observed on this account yet, and an
// endpoint that 401s the first live transfer would fail the way that is
// hardest to read: the lead hears "one moment" and then nothing. Every request
// records which gates it passed in ai_call_events, so the first real call
// tells us whether the signature path can be made mandatory.
//
// ---- Which call is this? --------------------------------------------------
//
// A tool call is not a call-control event: it carries the LLM's arguments, not
// a call_control_id. Identity is resolved in three ways, best first, because
// each one can be absent:
//
//   1. `ai_call_id`  — templated into the tool URL from a per-call dynamic
//      variable. Exact, but only present if `assistant.dynamic_variables` was
//      accepted on ai_assistant_start (rung 1 of the degrade ladder).
//   2. `telnyx_call_to` / `telnyx_call_from` — dynamic variables Telnyx merges
//      in AUTOMATICALLY on every assistant call. This is the reliable one: it
//      needs no change to the hot path at all.
//   3. the newest in-progress ai_calls row, as a last resort.
//
// An unresolved mustache (`{{telnyx_call_to}}` arriving literally) is treated
// as absent, not as a phone number.

const TRANSFER_RING_SECS = 30;
// Long enough for a real transferred sales conversation. The AI portion is
// separately capped by the assistant's own telephony_settings.time_limit_secs,
// which Telnyx documents as stopping the ASSISTANT — explicitly "not
// applying to portions of a call without an active assistant (for instance, a
// call transferred to a human representative)".
const LEG_TIME_LIMIT_SECS = 1800;

serve(async (req) => {
  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY")!;
  const TELNYX_PUBLIC_KEY = Deno.env.get("TELNYX_PUBLIC_KEY");
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");
  const TOOLS_SECRET   = Deno.env.get("AI_TOOLS_SECRET") || "";
  const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");

  const url = new URL(req.url);

  // The LLM reads this body. Keep it small, plain and unambiguous — every
  // field here becomes something a person hears said out loud.
  function toolJson(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "GET") return new Response("ok");
  if (req.method !== "POST") return toolJson({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();

  // ---- Gate 1: the shared secret ------------------------------------------
  const presented = url.searchParams.get("k") || req.headers.get("x-pp-tools-secret") || "";
  if (!TOOLS_SECRET) {
    console.error("[ai-call-tools] AI_TOOLS_SECRET is not set — refusing every request.");
    return toolJson({ error: "not_configured" }, 500);
  }
  if (presented !== TOOLS_SECRET) {
    return toolJson({ error: "invalid_secret" }, 401);
  }

  // ---- Gate 2: the Telnyx signature, when it is there ---------------------
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts  = req.headers.get("telnyx-timestamp");
  let signatureState = "absent";
  if (sig && ts) {
    if (!TELNYX_PUBLIC_KEY) {
      signatureState = "unverifiable_no_public_key";
    } else if (await verifyTelnyxSignature(rawBody, sig, ts, TELNYX_PUBLIC_KEY)) {
      signatureState = "valid";
    } else {
      return toolJson({ error: "invalid_signature" }, 401);
    }
  }

  let body: Record<string, unknown> = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { /* the LLM sent nothing parseable */ }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const telnyxHeaders = {
    "Authorization": `Bearer ${TELNYX_API_KEY}`,
    "Content-Type":  "application/json",
  };

  // A value that is still a mustache template never resolved — treat as blank.
  const resolved = (v: string | null | undefined): string => {
    const s = (v ?? "").trim();
    if (!s || /\{\{|\}\}/.test(s)) return "";
    return s;
  };
  const param = (name: string): string => resolved(
    url.searchParams.get(name) ??
    req.headers.get(`x-pp-${name.replace(/_/g, "-")}`) ??
    (typeof body[name] === "string" ? body[name] as string : ""),
  );

  const tool       = param("tool") || url.pathname.split("/").filter(Boolean).pop() || "";
  const aiCallIdIn = param("ai_call_id");
  const callTo     = param("telnyx_call_to") || param("to");
  const callFrom   = param("telnyx_call_from") || param("from");

  // Trace EVERY tool call before doing anything, so the first live transfer is
  // read off a table rather than guessed at. Fire-and-forget by contract.
  async function logEvent(ccid: string, type: string, detail: unknown): Promise<void> {
    try {
      await sb.from("ai_call_events").insert({
        call_control_id: ccid || "unknown",
        event_type:      type,
        payload:         detail as Record<string, unknown>,
      });
    } catch (e) {
      console.warn("[ai-call-tools] ai_call_events insert failed:", (e as Error)?.message || e);
    }
  }

  // ---- Resolve the call ----------------------------------------------------
  type AiCallRow = {
    id: string; agent_id: string; lead_id: string | null;
    phone_e164: string; from_e164: string | null; call_control_id: string | null;
    status: string | null; outcome: string | null;
    transfer_status: string | null; qualification: Record<string, unknown> | null;
    appointment_id: string | null; direction: string | null;
  };
  // Kept as ONE string literal, not a concatenation: the supabase-js types
  // parse the select list at compile time, and a computed string collapses the
  // row type to GenericStringError.
  const SELECT = "id, agent_id, lead_id, phone_e164, from_e164, call_control_id, status, outcome, transfer_status, qualification, appointment_id, direction";

  async function resolveCall(): Promise<AiCallRow | null> {
    if (aiCallIdIn) {
      const { data } = await sb.from("ai_calls").select(SELECT).eq("id", aiCallIdIn).maybeSingle();
      if (data) return data as AiCallRow;
    }
    const toE = toE164(callTo);
    if (toE) {
      let q = sb.from("ai_calls").select(SELECT).eq("phone_e164", toE).eq("status", "in_progress");
      const fromE = toE164(callFrom);
      if (fromE) q = q.eq("from_e164", fromE);
      const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (data) return data as AiCallRow;
    }
    // Last resort: exactly one call is in flight per agent in Phase 2 (the
    // batch runner with its one-active-call rule is Phase 3), so the newest
    // in-progress row is the right one far more often than nothing is.
    const { data } = await sb.from("ai_calls").select(SELECT)
      .eq("status", "in_progress")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    return (data as AiCallRow | null) ?? null;
  }

  const call = await resolveCall();
  const traceId = call?.call_control_id || aiCallIdIn || "unresolved";

  await logEvent(traceId, `tool.${tool || "unknown"}.received`, {
    signature: signatureState,
    resolved_via: aiCallIdIn ? "ai_call_id" : (callTo ? "telnyx_call_to" : "newest_in_progress"),
    ai_call_id: call?.id ?? null,
    query: Object.fromEntries([...url.searchParams].filter(([k]) => k !== "k")),
    // The raw arguments the LLM produced. This is the only place they exist.
    args: body,
  });

  if (!call) {
    // The assistant must still be able to say something sensible.
    return toolJson({
      ok: false,
      status: "unavailable",
      message: "Could not identify this call. Do not attempt a transfer; continue the conversation.",
    });
  }

  const { data: agent } = await sb.from("agents")
    .select("display_name, agency_name, ai_agent_name, transfer_number, ai_availability, signalwire_caller_id")
    .eq("id", call.agent_id)
    .maybeSingle();

  const { data: lead } = call.lead_id
    ? await sb.from("leads").select("id, data, lead_timezone, tcpa_consent, dnc").eq("id", call.lead_id).maybeSingle()
    : { data: null };

  const leadData = (lead?.data as Record<string, unknown> | null) || {};
  const asStr = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const leadFirst = asStr(leadData.first_name) ||
    (asStr(leadData.name).split(/\s+/)[0] || "");
  const leadName = asStr(leadData.name) ||
    [asStr(leadData.first_name), asStr(leadData.last_name)].filter(Boolean).join(" ").trim();

  // ------------------------------------------------------------------
  // Merge whatever qualification fields the assistant has gathered so far.
  // The tool call is often the ONLY place these ever arrive — the post-call
  // insight can be late, prose, or absent — so they are persisted here rather
  // than waiting for the end of the call.
  // ------------------------------------------------------------------
  async function mergeQualification(extra: Record<string, unknown>): Promise<void> {
    const pick = (k: string) => {
      const v = body[k];
      return typeof v === "string" && v.trim() ? v.trim() : (typeof v === "number" ? String(v) : null);
    };
    const fresh: Record<string, unknown> = {
      age:                pick("age"),
      coverage_interest:  pick("coverage_interest") ?? pick("coverage_type"),
      budget_text:        pick("budget_text") ?? pick("budget"),
      best_callback_text: pick("best_callback_text") ?? pick("callback_window"),
      notes:              pick("notes"),
      summary:            pick("summary"),
      ...extra,
    };
    const merged = { ...(call!.qualification || {}) };
    for (const [k, v] of Object.entries(fresh)) if (v != null && v !== "") merged[k] = v;
    if (Object.keys(merged).length === 0) return;
    await sb.from("ai_calls").update({ qualification: merged }).eq("id", call!.id);
  }

  try {
    // ==================================================================
    // transfer_to_agent
    // ==================================================================
    if (tool === "transfer_to_agent") {
      const summary = (typeof body.summary === "string" ? body.summary : "").trim();
      await mergeQualification({ transfer_summary: summary || null });

      // ---- NEVER TRANSFER ON AN INBOUND CALL ---------------------------
      // The AI is only on this call because the agent's phone already rang
      // for fifteen seconds and they did not pick up. Ringing them a second
      // time, mid-conversation, is the behaviour that makes people hang up on
      // automated systems — and the caller would sit in silence through it.
      // Enforced HERE rather than only in the prompt, because an instruction
      // is a request and this is a rule.
      if (call.direction === "inbound") {
        await logEvent(traceId, "transfer.refused_inbound", { transfer_status: call.transfer_status });
        return toolJson({
          ok: true,
          status: "unavailable",
          message: "A live transfer is not possible on this call. Do not mention transferring. " +
            "Offer two or three specific times and book with the book_appointment tool.",
        });
      }

      // THE FRESH READ. Never a value captured at call start: the agent may
      // have gone into a meeting since the phone started ringing, and a
      // transfer to someone who has stepped away is a lead listening to a
      // ringtone and then an apology.
      const availability = asStr(agent?.ai_availability) || "busy";
      const transferTo   = toE164(asStr(agent?.transfer_number));

      if (availability !== "available" || !transferTo) {
        await sb.from("ai_calls").update({ transfer_status: "offered" }).eq("id", call.id);
        await logEvent(traceId, "transfer.unavailable", {
          availability, has_transfer_number: !!transferTo,
        });
        return toolJson({
          ok: true,
          status: "unavailable",
          // "Do not invent a reason" is load-bearing. Told only that the agent
          // was unavailable, the assistant told a live caller he was "with
          // another client" — a specific claim about a real person's
          // whereabouts that nothing in this system knows to be true.
          message: "The agent cannot take a live transfer right now. Apologize briefly and move on. " +
            "Do NOT state or invent a reason — not 'with another client', not 'in a meeting', not " +
            "'on another call'. You do not know why. Then offer two or three specific times and book " +
            "with the book_appointment tool.",
        });
      }

      if (!TELNYX_CONN_ID) {
        await sb.from("ai_calls").update({ transfer_status: "failed" }).eq("id", call.id);
        return toolJson({
          ok: false, status: "unavailable",
          message: "Transfer is not possible on this call. Offer to book an appointment instead.",
        });
      }

      // The agent leg carries its own client_state so ai-call-webhook can tell
      // the two legs apart, find the parent row, and know what to whisper.
      const agentState = btoa(JSON.stringify({
        role:        "agent_leg",
        ai_call_id:  call.id,
        lead_ccid:   call.call_control_id,
        summary:     summary.slice(0, 400),
        lead_name:   leadName,
      }));

      const dialBody: Record<string, unknown> = {
        connection_id: TELNYX_CONN_ID,
        to:   transferTo,
        from: call.from_e164 || asStr(agent?.signalwire_caller_id),
        answering_machine_detection: "premium",
        timeout_secs:    TRANSFER_RING_SECS,
        time_limit_secs: LEG_TIME_LIMIT_SECS,
        webhook_url:        `${SUPABASE_URL}/functions/v1/ai-call-webhook`,
        webhook_url_method: "POST",
        client_state:       agentState,
      };

      // ---- The caller-ID name is DECORATION and is treated as such ---------
      //
      // Showing the lead's name on the agent's screen is a nicety. On the first
      // live transfer it was the entire reason the transfer never happened:
      // the test lead was called "AI Test (my cell)" and Telnyx 422'd the whole
      // dial — `pointer: /from_display_name`, "only letters, numbers, spaces,
      // and -_~!.+". Parentheses. A cosmetic field took down the feature.
      //
      // So it is sanitised to exactly the documented charset, AND the dial is
      // retried without it if Telnyx objects anyway. A name we cannot send is
      // a name the agent does not see; it is never a transfer that does not
      // happen.
      const displayName = (leadName || "AI transfer")
        .replace(/[^A-Za-z0-9 \-_~!.+]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 128);

      const dialAttempts: Array<{ label: string; body: Record<string, unknown> }> = [];
      if (displayName) {
        dialAttempts.push({ label: "with from_display_name", body: { ...dialBody, from_display_name: displayName } });
      }
      dialAttempts.push({ label: "without from_display_name", body: dialBody });

      let dialRes: Response | null = null;
      let dialDetail = "";
      for (const attempt of dialAttempts) {
        dialRes = await fetch("https://api.telnyx.com/v2/calls", {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify(attempt.body),
        }).catch(() => null);
        if (dialRes && dialRes.ok) break;
        dialDetail = dialRes ? await dialRes.text().catch(() => "") : "network_error";
        await logEvent(traceId, "transfer.dial_rejected", {
          attempt: attempt.label,
          status:  dialRes ? dialRes.status : "network_error",
          body:    dialDetail.slice(0, 800),
        });
      }

      if (!dialRes || !dialRes.ok) {
        await sb.from("ai_calls").update({ transfer_status: "failed", transfer_to: transferTo }).eq("id", call.id);
        await logEvent(traceId, "transfer.dial_failed", {
          status: dialRes ? dialRes.status : "network_error", body: dialDetail.slice(0, 800),
        });
        return toolJson({
          ok: false,
          status: "unavailable",
          message: "The agent could not be reached. Apologize briefly — do NOT say why, and do not invent a " +
            "reason such as being with another client — then offer times and book an appointment.",
        });
      }

      const dialData = await dialRes.json().catch(() => ({}));
      const agentCcid = dialData?.data?.call_control_id || "";

      await sb.from("ai_calls").update({
        transfer_status: "ringing_agent",
        transfer_to:     transferTo,
        transfer_call_control_id: agentCcid || null,
      }).eq("id", call.id);
      await logEvent(traceId, "transfer.ringing_agent", {
        to: transferTo, agent_call_control_id: agentCcid, summary_len: summary.length,
      });

      // RETURN IMMEDIATELY. Waiting here for the agent to pick up and press 1
      // would be 15-30 seconds during which the assistant is blocked and the
      // lead hears nothing at all. The assistant keeps them company instead
      // (its instructions say so), and the outcome is pushed back into the
      // conversation later via ai_assistant_add_messages from the webhook.
      return toolJson({
        ok: true,
        status: "ringing",
        message: "The agent's phone is ringing. Tell the caller you're connecting them now and to hold " +
          "for just a moment. Stay with them, keep it brief and warm, and do not promise how long it will take. " +
          "If you are told the agent could not be reached, apologize and book an appointment instead.",
      });
    }

    // ==================================================================
    // book_appointment
    // ==================================================================
    if (tool === "book_appointment") {
      const datetimeText = (typeof body.datetime_text === "string" ? body.datetime_text
        : typeof body.datetime === "string" ? body.datetime
        : "").trim();
      const notes = (typeof body.notes === "string" ? body.notes : "").trim();

      // An INBOUND caller we had never seen was turned into a lead the moment
      // they rang, with a blank name — nothing invents one. If the assistant
      // has since been told a name, write it on, so the agent gets a person
      // rather than a phone number.
      //
      // Only ever FILLS A BLANK. A caller mumbling their name on a bad line
      // must not rename an existing lead in the book.
      const callerName = (typeof body.caller_name === "string" ? body.caller_name : "").trim();
      if (callerName && call.lead_id && !leadName) {
        const merged = { ...leadData, name: callerName.slice(0, 120) };
        const { error: nameErr } = await sb.from("leads")
          .update({ data: merged }).eq("id", call.lead_id);
        await logEvent(traceId, "inbound.lead_named", {
          lead_id: call.lead_id, name_chars: callerName.length, error: nameErr?.message ?? null,
        });
      }

      const leadTz = asStr(lead?.lead_timezone) ||
        knownTimezoneForPhone(call.phone_e164) ||
        "America/Chicago";

      const parsed = parseAppointmentTime(datetimeText, leadTz, new Date());
      if (!parsed.ok) {
        await logEvent(traceId, "booking.parse_failed", { datetime_text: datetimeText, reason: parsed.reason, tz: leadTz });
        // An error the assistant can act on: it must re-ask, not invent a time.
        return toolJson({
          ok: false,
          status: "needs_confirmation",
          message: `${parsed.reason} Ask the caller for a specific day and time, then call this tool again.`,
        });
      }

      // ONE APPOINTMENT PER CALL. A caller correcting the time — "no, I said
      // ten" — makes the assistant call this tool again, and on the first live
      // booking that produced THREE rows for one conversation, all with
      // different spoken text and only the last one right. A re-book is an
      // edit of the same appointment, not a second appointment.
      const fields = {
        agent_id:         call.agent_id,
        lead_id:          call.lead_id,
        ai_call_id:       call.id,
        starts_at:        parsed.at.toISOString(),
        lead_timezone:    leadTz,
        spoken_time_text: datetimeText.slice(0, 300),
        lead_name:        leadName || null,
        lead_phone_e164:  call.phone_e164,
        notes:            notes ? notes.slice(0, 2000) : null,
        source:           "ai_call",
      };

      let appt: { id: string } | null = null;
      let apptErr: { message?: string } | null = null;
      if (call.appointment_id) {
        // Re-booking: overwrite the time and clear the previous send status so
        // the confirmation text describes the time that actually stands.
        const { data, error } = await sb.from("ai_appointments")
          .update({ ...fields, sms_confirm_status: null, sms_message_id: null })
          .eq("id", call.appointment_id)
          .select("id").maybeSingle();
        appt = data as { id: string } | null;
        apptErr = error;
        if (appt) await logEvent(traceId, "booking.rebooked", { appointment_id: appt.id, at: fields.starts_at });
      }
      if (!appt) {
        const { data, error } = await sb.from("ai_appointments").insert(fields).select("id").single();
        appt = data as { id: string } | null;
        apptErr = apptErr ?? error;
      }

      if (!appt) {
        console.error("[ai-call-tools] ai_appointments write failed:", apptErr?.message);
        await logEvent(traceId, "booking.insert_failed", { message: apptErr?.message });
        return toolJson({
          ok: false,
          status: "needs_confirmation",
          message: "That time could not be saved. Tell the caller the agent will follow up to confirm, and wrap up.",
        });
      }

      await sb.from("ai_calls").update({
        appointment_id: appt.id,
        outcome:        "appointment_booked",
        transfer_status: call.transfer_status === "ringing_agent" ? "agent_no_answer" : call.transfer_status,
      }).eq("id", call.id);
      await mergeQualification({
        outcome: "appointment_booked",
        appointment_at: parsed.at.toISOString(),
        appointment_spoken: parsed.spoken,
        notes: notes || null,
      });
      await logEvent(traceId, "booking.created", {
        appointment_id: appt.id, at: parsed.at.toISOString(),
        spoken: parsed.spoken, tz: leadTz, approximate: parsed.approximate,
      });

      // ---- The confirmation SMS: FIRE AND FORGET ------------------------
      // An SMS failure must never break or delay a booking. The appointment is
      // already committed above; this runs after the response is handed back
      // where the runtime allows it, and its result is recorded on the row so
      // "did the text go out?" is answerable without reading logs.
      const smsTask = sendConfirmSms({
        sb, appointmentId: appt.id, agentId: call.agent_id,
        toPhone: call.phone_e164, firstName: leadFirst,
        aiName: asStr(agent?.ai_agent_name),
        companyName: asStr(agent?.agency_name) || asStr(agent?.display_name),
        at: parsed.at, timeZone: leadTz,
        callerId: asStr(agent?.signalwire_caller_id),
        supabaseUrl: SUPABASE_URL, telnyxApiKey: TELNYX_API_KEY,
        telnyxMessagingProfileId: TELNYX_MSG_PROFILE_ID,
        log: (t, d) => logEvent(traceId, t, d),
      });
      if (!scheduleBackground(smsTask)) await smsTask;

      // The assistant repeats the resolved time back. `approximate` means an
      // am/pm or a vague period was inferred, so it MUST be confirmed aloud.
      return toolJson({
        ok: true,
        status: "booked",
        appointment_time: parsed.spoken,
        message: parsed.approximate
          ? `Booked for ${parsed.spoken}. Say that back to the caller in full and make sure it is right — ` +
            `if it is not, ask for the exact time and call this tool again.`
          : `Booked for ${parsed.spoken}. Confirm it back to the caller, tell them the agent will call then, ` +
            `and that they will get a text confirmation. Then wrap up warmly and end the call.`,
      });
    }

    return toolJson({ ok: false, error: "unknown_tool", message: "Continue the conversation." }, 400);
  } catch (e) {
    console.error("[ai-call-tools] error:", (e as Error)?.message || e);
    await logEvent(traceId, `tool.${tool}.error`, { message: (e as Error)?.message || String(e) });
    // NEVER 500 at the assistant: a tool error it cannot read becomes dead air.
    return toolJson({
      ok: false,
      status: "unavailable",
      message: "That could not be completed. Continue the conversation and offer to have the agent follow up.",
    });
  }
});

// Run work after the response is sent, when the runtime offers it. Same helper
// and same reasoning as ai-call-webhook: losing this silently is worse than
// holding the request open.
function scheduleBackground(task: Promise<unknown>): boolean {
  try {
    const er = (globalThis as {
      EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") {
      er.waitUntil(task.catch(() => {}));
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

/**
 * The booking confirmation text.
 *
 * Reuses the EXACT gates messaging-send-sms runs — runComplianceGate (A2P
 * approval, consent, DNC, quiet hours) and resolveTextingNumber — rather than
 * reimplementing any of them. It cannot call that function directly because
 * that one takes the agent from a user JWT and there is no user here; this is
 * a call, not a click. Everything downstream of the gate is the same shared
 * core, so the billing and never-charge-undelivered behaviour is identical.
 *
 * Every exit writes ai_appointments.sms_confirm_status. There is no silent
 * path: a booking whose text did not go out must be distinguishable from one
 * whose text did, and today the likeliest reason is simply that the agent's
 * number is not attached to the 10DLC campaign yet — at which point this
 * starts working with no code change at all.
 */
async function sendConfirmSms(opts: {
  // deno-lint-ignore no-explicit-any
  sb: any;
  appointmentId: string;
  agentId: string;
  toPhone: string;
  firstName: string;
  aiName: string;
  companyName: string;
  at: Date;
  timeZone: string;
  callerId: string;
  supabaseUrl: string;
  telnyxApiKey: string;
  telnyxMessagingProfileId?: string;
  log: (type: string, detail: unknown) => Promise<void>;
}): Promise<void> {
  const { sb } = opts;
  const record = async (status: string, extra?: Record<string, unknown>) => {
    try {
      await sb.from("ai_appointments")
        .update({ sms_confirm_status: status.slice(0, 200), ...(extra || {}) })
        .eq("id", opts.appointmentId);
    } catch { /* the booking still stands */ }
    await opts.log("booking.sms", { status, ...(extra || {}) });
  };

  try {
    const gate = await runComplianceGate(sb, opts.agentId, "sms", opts.toPhone);
    if (!gate.ok) { await record(`skipped_${gate.reason}`); return; }

    const sender = await resolveTextingNumber(sb, opts.agentId, opts.callerId);
    if (!sender.ok) { await record(`skipped_${sender.reason}`); return; }

    const text = buildConfirmSms({
      firstName: opts.firstName, aiName: opts.aiName,
      companyName: opts.companyName, at: opts.at, timeZone: opts.timeZone,
    });

    const result = await sendMessageCore(
      {
        agentId: opts.agentId, channel: "sms", to: gate.normalizedAddress,
        fromNumber: sender.fromNumber, text, consentId: gate.consentId,
      },
      {
        sb, supabaseUrl: opts.supabaseUrl, telnyxApiKey: opts.telnyxApiKey,
        telnyxMessagingProfileId: opts.telnyxMessagingProfileId,
      },
    );

    if (!result.ok) { await record(`failed:${result.error}`, {}); return; }
    await record("sent", { sms_message_id: result.messageId });
  } catch (e) {
    await record(`failed:${((e as Error)?.message || String(e)).slice(0, 120)}`);
  }
}

// Re-exported for the sync script's URL builder and for documentation: the
// tool URLs the assistant is configured with.
export function toolUrl(supabaseUrl: string, secret: string, tool: string): string {
  const base = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/ai-call-tools`;
  return `${base}?k=${encodeURIComponent(secret)}&tool=${tool}` +
    `&ai_call_id={{ai_call_id}}&telnyx_call_to={{telnyx_call_to}}&telnyx_call_from={{telnyx_call_from}}`;
}

export { speakTime };
