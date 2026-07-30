import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyTelnyxSignature } from "../_shared/webhook-verify.ts";
import {
  computeBilledMinutes,
  debitAiCallOnce,
  type AiCallOutcome,
} from "../_shared/ai-call-billing.ts";
import {
  outcomeFromCallFlow,
  parseInsightPayload,
  shouldReplaceOutcome,
} from "../_shared/ai-call-outcome.ts";

// ai-call-webhook — Telnyx Call Control + AI Assistant webhook for one AI
// Sales Agent call, BOTH LEGS. Configured per-call by ai-call-start (the lead
// leg) and by ai-call-tools (the agent leg of a warm transfer). Does its OWN
// Ed25519 signature check (verify_jwt = false in config.toml — Telnyx can't
// supply a Supabase JWT), same as messaging-delivery-webhook.
//
// Which leg an event belongs to is read from client_state.role:
// 'ai_call' (the lead) or 'agent_leg' (the agent being warm-transferred to).
// Both legs' events land here on purpose — one function, one trace table, one
// place where the two are joined.
//
// LEAD LEG:
//   • call.answered      -> claim the start, stamp answered_at (billing
//     anchor) and attach the assistant IMMEDIATELY via
//     /actions/ai_assistant_start. This is the ONLY path that normally
//     speaks; AMD is a backstop behind it (see below).
//   • AMD says machine   -> hang up, mark 'voicemail'. Bills 0 either way.
//   • AMD says human     -> backstop only: start the assistant if
//     call.answered never claimed it (a lost event or a DB error).
//   • transcript/insights -> store transcript + parse the outcome (see
//     _shared/ai-call-outcome.ts); a dnc_request writes a suppression row +
//     flips leads.dnc.
//   • conversation.ended -> the ASSISTANT stopped. If no transfer is in
//     flight, hang the leg up rather than leave a person in silence.
//   • call.hangup        -> compute talk minutes (answered_at -> hangup),
//     debit the wallet ONCE via wallet_debit_ai_minutes (idempotent by
//     call_control_id), finalize the row.
//
// AGENT LEG (warm transfer, Phase 2):
//   • call.answered      -> play the whisper and gather ONE digit
//                           ("Hot lead: <summary>. Press 1 to take the call.")
//   • AMD says machine    -> the agent's voicemail picked up: hang up,
//                            transfer_status = agent_no_answer.
//   • call.gather.ended   -> '1' bridges the two legs (transfer_status
//                            'bridged', outcome 'transferred'); any other
//                            digit is agent_declined; a timeout is
//                            agent_no_answer.
//   • either failure     -> push a system message back into the LEAD's live
//                           conversation so the assistant apologizes and
//                           pivots to booking. The lead is never told to hold
//                           for something that is not coming.
//
// THE AGENT LEG NEVER DEBITS. The whole call — both legs — bills ONCE at the
// ai_call rate, anchored on the LEAD's answer, keyed on the LEAD's
// call_control_id (docs/ai-sales-agent-build-plan.md, Phase 2). Finalize is
// gated on role for exactly that reason.
//
// ---- Why the native Telnyx transfer tool is NOT used ----------------------
//
// Telnyx's assistant `transfer` tool does support a spoken briefing
// (`warm_transfer_instructions`) and AMD on the transferred leg
// (`voicemail_detection.detection_mode: 'premium'`, verified in the published
// OpenAPI spec). It has NO digit confirmation: nothing in
// InferenceEmbeddingTransferToolParams, InviteToolConfig or the DTMF tool
// gathers a keypress from the destination. Press-1 is what stops a lead being
// bridged into a car radio, a colleague, or an agent who answered without
// realising what the call was — so the flow below dials the agent leg through
// Call Control instead.
//
// ---- Two things here exist because of the "answered but silent" bug --------
//
// 1. NOTHING SENDS `message_history`. Telnyx's production validator rejects it
//    outright on this account — 422 code 10000 "Invalid message format",
//    pointer /message_history — and that single rejection is what made every
//    Phase 1 test call dead air: ai_assistant_start failed, so the assistant
//    never attached and the lead listened to silence until the 5-minute cap.
//    The lead context it used to carry (name, agent, agency, lead type) is all
//    in the greeting already, and the sales script lives in the assistant's
//    own `instructions`, so nothing of substance is lost. `assistant.id`,
//    `greeting` and `voice` are all PROVEN-accepted: the live 422 listed
//    exactly one error and it named only /message_history.
//    startAssistant() additionally degrades on any 4xx — voice dropped, then
//    greeting dropped — so a future field rejection costs the call its voice
//    override, never its audio.
//
// 2. THE DEAD-AIR FALLBACK. The assistant used to start ONLY on the premium-AMD
//    verdict, which makes a missing or slow AMD event indistinguishable from a
//    broken assistant: both are silence. call.answered arms a background timer,
//    and if nothing has claimed the call within ASSISTANT_START_GRACE_MS the
//    assistant starts anyway. Exactly one path ever starts it —
//    claimAssistantStart() is an atomic compare-and-set on `answered_at is
//    null` — so the fallback cannot double-start or double-bill.
//
// ---- Why AMD no longer gates the greeting (2026-07-30, humanize round 1) ---
//
// The assistant used to attach only AFTER premium AMD returned a human verdict.
// Measured on the 07-30 08:41 call (ai_call_events, call_control_id
// v3:pIHy1iU-...): call.answered 08:41:23.09 -> AMD verdict 08:41:26.60 (3.5s
// of AMD listening) -> ai_assistant_start accepted 08:41:29.10 (2.5s) -> first
// audio 08:41:29.63. 6.5 SECONDS of silence, of which AMD was the single
// largest slice, and premium AMD cannot be made fast — listening IS how it
// works. So it stopped being a gate:
//
//   • call.answered attaches the assistant right away.
//   • AMD still runs (premium, requested by ai-call-start) and is handled
//     ASYNCHRONOUSLY. A machine verdict arriving a few seconds later hangs the
//     call up and marks it 'voicemail'.
//   • A human verdict is now only a BACKSTOP: it starts the assistant if
//     call.answered never claimed the call.
//
// ACCEPTED TRADEOFF: the assistant may speak a sentence or two into a
// voicemail greeting before the machine verdict lands and hangs up. That is
// deliberate. It still leaves NO voicemail message (v1 drops none), and the
// call still bills ZERO — the `isVoicemail` rule in the finalize block keys
// off outcome, not off answered_at, precisely so that stamping the billing
// anchor before the AMD verdict cannot charge a minute for a voicemail.
//
// Every event received and every action taken is appended to ai_call_events
// (20260752) so the next silent call is read off a table, not guessed at.
//
// It does NOT write into public.calls: that table feeds the human dialer's
// monthly minute cap (telnyx-bridge/signalwire-bridge) and the Summary
// dial/contact analytics, both of which sum calls.duration_sec unfiltered.
// ai_calls is the AI call's activity/disposition record; Phase 4's timeline
// UI unions the two by lead_id for display.

// How long after call.answered the backstop timer waits before starting the
// assistant regardless. call.answered now starts it inline, so this only ever
// fires when that inline attempt could not claim the call (a transient DB
// error on the compare-and-set) — hence much shorter than the 6s it needed
// when it was waiting on an AMD verdict.
const ASSISTANT_START_GRACE_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Run work after the response is sent. Supabase's edge runtime exposes
// EdgeRuntime.waitUntil; if it is ever absent we fall back to awaiting inline
// (the caller holds the request open instead), because losing the fallback
// silently would bring the dead air back.
function scheduleBackground(task: Promise<unknown>): boolean {
  try {
    const er = (globalThis as {
      EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") {
      er.waitUntil(task.catch(() => {}));
      return true;
    }
  } catch { /* fall through to inline await */ }
  return false;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY    = Deno.env.get("TELNYX_API_KEY")!;
  const TELNYX_PUBLIC_KEY = Deno.env.get("TELNYX_PUBLIC_KEY");
  const TELNYX_ASSISTANT  = Deno.env.get("TELNYX_AI_ASSISTANT_ID");
  // The custom, JSON-schema'd insight (scripts/sync-ai-assistant.mjs creates
  // it and prints the id). Optional: when unset the parser simply has no
  // preferred insight and reads whichever result carries usable fields — which
  // is what it does for the stock prose Summary insight anyway.
  const TELNYX_OUTCOME_INSIGHT_ID = Deno.env.get("TELNYX_OUTCOME_INSIGHT_ID") || null;

  const rawBody = await req.text();

  // ---- Signature verification (same pattern as messaging-delivery-webhook) ----
  const telnyxSig = req.headers.get("telnyx-signature-ed25519");
  const telnyxTs  = req.headers.get("telnyx-timestamp");
  if (!TELNYX_PUBLIC_KEY) {
    return new Response(JSON.stringify({ error: "telnyx_not_configured" }), { status: 500 });
  }
  if (!await verifyTelnyxSignature(rawBody, telnyxSig, telnyxTs, TELNYX_PUBLIC_KEY)) {
    return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
  }

  let payload: { data?: { event_type?: string; payload?: Record<string, unknown> } };
  try { payload = JSON.parse(rawBody); } catch { return new Response("ok"); }

  const eventType = payload?.data?.event_type || "";
  const p = (payload?.data?.payload || {}) as Record<string, unknown>;
  const callControlId = (p.call_control_id as string) || "";
  if (!callControlId) return new Response("ok");

  // client_state carries { role, ai_call_id, vars } stamped by ai-call-start
  // (the lead leg) or { role:'agent_leg', ai_call_id, lead_ccid, summary,
  // lead_name } stamped by ai-call-tools (the agent leg of a warm transfer).
  let ctx: {
    role?: string;
    ai_call_id?: string;
    vars?: Record<string, string>;
    lead_ccid?: string;
    summary?: string;
    lead_name?: string;
  } = {};
  try {
    if (typeof p.client_state === "string" && p.client_state) {
      ctx = JSON.parse(atob(p.client_state));
    }
  } catch { /* ignore malformed state */ }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const telnyxHeaders = {
    "Authorization": `Bearer ${TELNYX_API_KEY}`,
    "Content-Type":  "application/json",
  };

  const isAgentLeg = ctx.role === "agent_leg";

  // Resolve the ai_calls row's id: prefer the id carried in client_state
  // (race-free), fall back to a lookup by call_control_id. Every ai_calls
  // update below targets (idCol = idVal); call_control_id is always present as
  // the last-resort target.
  //
  // On the AGENT leg the incoming call_control_id belongs to the agent's own
  // leg, so it can never match ai_calls.call_control_id — the fallback looks
  // at transfer_call_control_id instead. Without that, a lost client_state on
  // the agent leg would silently update nothing.
  let aiCallId = ctx.ai_call_id || "";
  if (!aiCallId) {
    const col = isAgentLeg ? "transfer_call_control_id" : "call_control_id";
    const { data } = await sb.from("ai_calls").select("id").eq(col, callControlId).maybeSingle();
    aiCallId = (data?.id as string) || "";
  }
  const idCol = aiCallId ? "id" : (isAgentLeg ? "transfer_call_control_id" : "call_control_id");
  const idVal = aiCallId || callControlId;

  type AiCallRow = {
    id: string;
    agent_id: string;
    lead_id: string | null;
    phone_e164: string;
    call_control_id: string | null;
    status: string | null;
    outcome: string | null;
    answered_at: string | null;
    started_at: string | null;
    error_detail: string | null;
    transfer_status: string | null;
    transfer_call_control_id: string | null;
    appointment_id: string | null;
    qualification: Record<string, unknown> | null;
  };
  const AI_CALL_COLS =
    "id, agent_id, lead_id, phone_e164, call_control_id, status, outcome, answered_at, " +
    "started_at, error_detail, transfer_status, transfer_call_control_id, appointment_id, qualification";
  async function loadAiCall(): Promise<AiCallRow | null> {
    const { data } = await sb.from("ai_calls")
      .select(AI_CALL_COLS)
      .eq(idCol, idVal)
      .maybeSingle();
    return (data as AiCallRow | null) ?? null;
  }

  // ---- Diagnostic trace (20260752) ---------------------------------------
  // Fire-and-forget by contract: a logging failure must never change how a
  // call is handled, so every path here swallows its own errors.
  //
  // Agent-leg events are filed under the LEAD's call_control_id when it is
  // known, so one call reads as ONE trace. The agent leg's own id travels in
  // the payload — losing which leg an event came from would make the transfer
  // chain unreadable, which is the exact thing this table exists to prevent.
  const traceCcid = (isAgentLeg && ctx.lead_ccid) ? ctx.lead_ccid : callControlId;
  async function logEvent(type: string, detail: unknown): Promise<void> {
    try {
      await sb.from("ai_call_events").insert({
        call_control_id: traceCcid,
        event_type:      type,
        payload: isAgentLeg
          ? { leg: "agent", agent_call_control_id: callControlId, ...(detail as Record<string, unknown>) }
          : detail as Record<string, unknown>,
      });
    } catch (e) {
      console.warn("[ai-call-webhook] ai_call_events insert failed:", (e as Error)?.message || e);
    }
  }

  async function hangupCall(target?: string): Promise<void> {
    await fetch(`https://api.telnyx.com/v2/calls/${target || callControlId}/actions/hangup`, {
      method:  "POST",
      headers: telnyxHeaders,
      body:    JSON.stringify({ command_id: crypto.randomUUID() }),
    }).catch(() => {});
  }

  /**
   * Push a message into the LEAD's live conversation.
   *
   * This is how a transfer that failed becomes something the assistant can
   * say. `trigger_response: true` makes it speak straight away instead of
   * waiting for the lead to talk first — the lead has just been told to hold,
   * so silence is precisely what must not happen next.
   *
   * NOTE the neighbouring hazard: `message_history` on ai_assistant_start is
   * 422-rejected on this account (see the header note), and this endpoint
   * takes the same message shape. It is a DIFFERENT endpoint and may well
   * behave differently, but it is treated as fallible for that reason: the
   * result is traced, and nothing downstream depends on it succeeding.
   */
  async function tellAssistant(leadCcid: string, content: string): Promise<boolean> {
    if (!leadCcid) return false;
    try {
      const res = await fetch(
        `https://api.telnyx.com/v2/calls/${leadCcid}/actions/ai_assistant_add_messages`,
        {
          method:  "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({
            messages: [{ role: "system", content }],
            trigger_response: true,
            command_id: crypto.randomUUID(),
          }),
        },
      );
      if (res.ok) {
        await logEvent("assistant.add_messages.ok", { chars: content.length });
        return true;
      }
      const body = await res.text().catch(() => "");
      await logEvent("assistant.add_messages.rejected", { status: res.status, body: body.slice(0, 600) });
      return false;
    } catch (e) {
      await logEvent("assistant.add_messages.error", { message: (e as Error)?.message || String(e) });
      return false;
    }
  }

  // Atomic compare-and-set on `answered_at is null`: whichever path wins gets
  // rows back and is the ONE that starts the assistant. This is what makes the
  // AMD verdict and the dead-air fallback safe to race — they cannot both
  // start the assistant, and answered_at (the billing anchor) is stamped once.
  // `at` lets the fallback back-date the anchor to the real answer time rather
  // than to the moment the grace period expired.
  async function claimAssistantStart(at?: string): Promise<boolean> {
    const { data, error } = await sb.from("ai_calls")
      .update({ status: "in_progress", answered_at: at || new Date().toISOString() })
      .eq(idCol, idVal)
      .is("answered_at", null)
      .select("id");
    if (error) {
      console.error("[ai-call-webhook] claimAssistantStart failed:", error.message);
      await logEvent("assistant_start.claim_error", { message: error.message });
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  }

  const vars = ctx.vars || {};
  const leadName = vars.lead_name || "";
  const isFinalize = eventType === "call.hangup" || eventType.endsWith("conversation.ended");

  // ---- Attach the assistant ------------------------------------------------
  // Called by the AMD-human branch and by the dead-air fallback, never both
  // (see claimAssistantStart). `trigger` is recorded in the trace so a silent
  // call shows which path tried and what Telnyx said back.
  async function startAssistant(trigger: string): Promise<void> {
    if (!TELNYX_ASSISTANT) {
      console.error("[ai-call-webhook] TELNYX_AI_ASSISTANT_ID not set — cannot start the assistant.");
      await logEvent("assistant_start.no_assistant_id", { trigger });
      await sb.from("ai_calls").update({
        error_detail: "TELNYX_AI_ASSISTANT_ID secret not set — assistant never attached.",
      }).eq(idCol, idVal);
      await hangupCall();
      return;
    }

    const greeting = buildGreeting(vars);

    // ---- NOTHING SPECULATIVE GOES ON THIS PATH ----------------------------
    //
    // Rung 1 is the body PROVEN accepted in production, and it is first
    // because every millisecond here is dead air on a real person's phone.
    //
    // `assistant.dynamic_variables` was briefly rung 1 above this one, to hand
    // the webhook tools an exact `ai_call_id`. On the first live call after
    // that change Telnyx answered **503 Service unavailable** and the lead
    // heard nothing (ai_call_events, call_control_id v3:hxdqhlTP2…, 2026-07-30
    // 20:37). Cause never established — it may have been the field, it may
    // have been a genuine blip — and that is precisely the point: this is the
    // one code path where an unproven field is not worth a convenience.
    // ai-call-tools identifies the call from `telnyx_call_to` /
    // `telnyx_call_from`, which Telnyx merges into every assistant call
    // AUTOMATICALLY and which therefore cost this path nothing at all. Do not
    // add fields here to make something downstream tidier.
    //
    // Each further rung drops the next-most-likely-rejected field, so a
    // validator change can cost the call its voice or its custom greeting but
    // never its audio. NOTHING here sends message_history — see the header note.
    const attempts: Array<{ label: string; body: Record<string, unknown> }> = [];

    const full: Record<string, unknown> = { assistant: { id: TELNYX_ASSISTANT }, greeting };
    if (vars.voice) full.voice = vars.voice;
    attempts.push({
      label: vars.voice ? "assistant+greeting+voice" : "assistant+greeting",
      body:  full,
    });

    if (vars.voice) {
      attempts.push({
        label: "assistant+greeting (voice override dropped)",
        body:  { assistant: { id: TELNYX_ASSISTANT }, greeting },
      });
    }
    attempts.push({
      label: "assistant only (Mission Control greeting + voice)",
      body:  { assistant: { id: TELNYX_ASSISTANT } },
    });

    let lastStatus: number | string = 0;
    let lastText = "";

    // ---- Failure policy: KEEP GOING ---------------------------------------
    //
    // Every rung is tried, whatever the previous one said. This used to break
    // out on any 5xx, reasoning that a smaller body cannot fix Telnyx's side —
    // true in isolation, and it still cost a live call its audio the first
    // time rung 1 came back 503 (see the note above). Two things were wrong
    // with it. A 503 is frequently transient, so it is worth ONE immediate
    // retry while a person is holding a silent phone. And "the server said
    // 5xx" is not reliable evidence about the body: a validator that dislikes
    // a field is free to answer 503, so refusing to degrade on 5xx removes the
    // ladder exactly when it is most needed.
    //
    // The cost of trying every rung is a few hundred milliseconds on a call
    // that is already failing. The cost of stopping early is silence.
    for (const attempt of attempts) {
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        let res: Response | null = null;
        try {
          res = await fetch(
            `https://api.telnyx.com/v2/calls/${callControlId}/actions/ai_assistant_start`,
            {
              method:  "POST",
              headers: telnyxHeaders,
              body:    JSON.stringify({ ...attempt.body, command_id: crypto.randomUUID() }),
            },
          );
        } catch (e) {
          lastStatus = "network_error";
          lastText   = (e as Error)?.message || String(e);
          await logEvent("ai_assistant_start.network_error", {
            trigger, attempt: attempt.label, try: tryNo + 1, message: lastText,
          });
          continue; // a transport blip is worth one more go too
        }

        if (res.ok) {
          await logEvent("ai_assistant_start.ok", {
            trigger,
            attempt: attempt.label,
            try:     tryNo + 1,
            status:  res.status,
            voice:   (attempt.body.voice as string) || null,
          });
          return;
        }

        lastStatus = res.status;
        lastText   = await res.text().catch(() => "");
        console.error("[ai-call-webhook] ai_assistant_start rejected:", lastStatus, attempt.label, lastText);
        await logEvent("ai_assistant_start.rejected", {
          trigger,
          attempt: attempt.label,
          try:     tryNo + 1,
          status:  lastStatus,
          body:    lastText.slice(0, 1000),
        });

        // Retry the SAME body only for a 5xx (transient). A 4xx is a verdict
        // on the body: stop repeating it and drop to the next rung.
        if (res.status < 500) break;
      }
    }

    // Every rung failed: make it visible on the row, then hang up rather than
    // leave the lead listening to dead air until the 5-minute cap. Finalize
    // (call.hangup) marks the outcome 'error' and, because error_detail is
    // set, bills nothing.
    await sb.from("ai_calls").update({
      error_detail: `ai_assistant_start ${lastStatus}: ${lastText.slice(0, 500)}`,
    }).eq(idCol, idVal);
    await hangupCall();
  }

  // ---- Dead-air fallback ---------------------------------------------------
  // Armed by call.answered alongside the inline start. If nothing has claimed
  // the call by the time the grace period expires, start the assistant anyway.
  async function deadAirFallback(answeredAtIso: string): Promise<void> {
    await sleep(ASSISTANT_START_GRACE_MS);
    const row = await loadAiCall();
    if (!row) return;
    // AMD already resolved it: human (answered_at claimed, assistant started),
    // machine (outcome voicemail), or the call is simply over.
    if (row.answered_at || row.error_detail) return;
    if (row.status === "completed" || row.outcome === "voicemail") return;
    if (!await claimAssistantStart(answeredAtIso)) return;

    console.warn("[ai-call-webhook] nothing claimed the call within grace — starting assistant anyway.");
    await logEvent("assistant_start.grace_fallback", {
      grace_ms:    ASSISTANT_START_GRACE_MS,
      answered_at: answeredAtIso,
    });
    await startAssistant("call.answered+fallback");
  }

  // ====================================================================
  // THE WARM TRANSFER — the agent leg.
  //
  // Everything here runs on the AGENT's call leg, which ai-call-tools dialed.
  // The lead is still on the line with the assistant throughout: nothing below
  // touches the lead's audio until the moment the two legs are bridged.
  //
  // Deliberately BEFORE the trace-then-handle block below so an agent-leg
  // event can never fall through into the lead-leg logic — in particular into
  // finalize, which would debit a second time and close the call while the
  // agent's phone is still ringing.
  // ====================================================================

  /** Where a transfer ended up, on the row and (when it failed) in the lead's ear. */
  async function endTransfer(
    status: "agent_declined" | "agent_no_answer" | "failed",
    why: string,
  ): Promise<void> {
    await sb.from("ai_calls").update({ transfer_status: status }).eq(idCol, idVal);
    await logEvent("transfer." + status, { why });
    await hangupCall(); // the agent leg only — the lead is still talking
    // Tell the assistant so it apologizes and books instead. The lead was
    // asked to hold; leaving them holding for something that is not coming is
    // the worst outcome this feature has.
    await tellAssistant(
      ctx.lead_ccid || "",
      "SYSTEM: The warm transfer did not connect — the agent could not be reached. " +
      "Do not mention keypads, voicemail, or any technical detail. Apologize once, briefly and warmly " +
      "(\"I'm sorry, I couldn't get hold of them just now\"), then offer two or three specific times " +
      "for the agent to call back, and when the caller picks one call the book_appointment tool with " +
      "exactly what they said. Do not try to transfer again.",
    );
  }

  if (isAgentLeg) {
    await logEvent(eventType || "unknown", p);
    try {
      // ---- The agent picked up: whisper, then ask for a digit ------------
      if (eventType === "call.answered") {
        await sb.from("ai_calls").update({ transfer_status: "whisper" }).eq(idCol, idVal);

        const who = (ctx.lead_name || "").trim();
        const summary = (ctx.summary || "").trim();
        // Spoken to the AGENT only. Says who, why, and what to do, in that
        // order, because the agent hears it having just picked up a call they
        // were not expecting.
        const whisper =
          `Hot lead${who ? `, ${who}` : ""}. ` +
          (summary ? `${summary}. ` : "") +
          `Press 1 to take the call.`;

        // valid_digits is deliberately EVERY digit, not just "1". Telnyx would
        // treat any other key as invalid and silently replay the prompt; we
        // want a wrong key to END the gather so it can be recorded as a
        // decline. maximum_tries 2 is the "repeat the whisper once" rule, and
        // it only applies to a timeout.
        const gatherBody = {
          payload:            whisper,
          invalid_payload:    "Press 1 to take the call.",
          minimum_digits:     1,
          maximum_digits:     1,
          valid_digits:       "0123456789*#",
          timeout_millis:     8000,
          maximum_tries:      2,
          client_state:       p.client_state as string,
          command_id:         crypto.randomUUID(),
        };

        // Voice ladder: a rejected TTS voice would cost the transfer its
        // whisper, so fall back to the plainest long-standing voice rather
        // than let one 400 end the handoff in silence.
        const voices = ["AWS.Polly.Joanna-Neural", "AWS.Polly.Joanna"];
        let spoke = false;
        for (const voice of voices) {
          const res = await fetch(
            `https://api.telnyx.com/v2/calls/${callControlId}/actions/gather_using_speak`,
            { method: "POST", headers: telnyxHeaders, body: JSON.stringify({ ...gatherBody, voice }) },
          ).catch(() => null);
          if (res && res.ok) {
            await logEvent("transfer.whisper.ok", { voice, whisper });
            spoke = true;
            break;
          }
          const status = res ? res.status : "network_error";
          const detail = res ? await res.text().catch(() => "") : "";
          await logEvent("transfer.whisper.rejected", { voice, status, body: detail.slice(0, 600) });
          if (res && (res.status < 400 || res.status >= 500)) break;
        }
        if (!spoke) await endTransfer("failed", "gather_using_speak rejected on every voice");
        return new Response("ok");
      }

      // ---- AMD on the agent leg: never bridge a lead into voicemail ------
      if (eventType.includes("machine") && eventType.endsWith("detection.ended")) {
        const result = String(p.result || "").toLowerCase();
        const isMachine = result.startsWith("machine") || result === "fax_detected";
        await logEvent("transfer.amd.verdict", { result, is_machine: isMachine });
        if (isMachine) await endTransfer("agent_no_answer", `AMD: ${result}`);
        return new Response("ok");
      }

      // ---- The digit ----------------------------------------------------
      if (eventType === "call.gather.ended") {
        const digits = String(p.digits || "").trim();
        const status = String(p.status || "").toLowerCase();
        await logEvent("transfer.gather.ended", { digits, status });

        if (digits === "1") {
          const row = await loadAiCall();
          const leadCcid = ctx.lead_ccid || row?.call_control_id || "";
          if (!leadCcid) { await endTransfer("failed", "no lead call_control_id to bridge to"); return new Response("ok"); }

          // Stop the assistant BEFORE bridging. Otherwise the agent and the
          // lead are talking with an AI still listening and taking turns in
          // the middle of the conversation.
          await fetch(`https://api.telnyx.com/v2/calls/${leadCcid}/actions/ai_assistant_stop`, {
            method: "POST", headers: telnyxHeaders,
            body: JSON.stringify({ command_id: crypto.randomUUID() }),
          }).catch(() => {});

          const bridgeRes = await fetch(
            `https://api.telnyx.com/v2/calls/${callControlId}/actions/bridge`,
            {
              method: "POST", headers: telnyxHeaders,
              body: JSON.stringify({ call_control_id: leadCcid, command_id: crypto.randomUUID() }),
            },
          ).catch(() => null);

          if (!bridgeRes || !bridgeRes.ok) {
            const st = bridgeRes ? bridgeRes.status : "network_error";
            const detail = bridgeRes ? await bridgeRes.text().catch(() => "") : "";
            await logEvent("transfer.bridge.rejected", { status: st, body: detail.slice(0, 600) });
            await endTransfer("failed", `bridge ${st}`);
            return new Response("ok");
          }

          // The one place the transfer is declared successful. `transferred`
          // is a terminal outcome, so the late insights event cannot downgrade
          // it (see shouldReplaceOutcome).
          await sb.from("ai_calls").update({
            transfer_status: "bridged",
            outcome:         "transferred",
          }).eq(idCol, idVal);
          await logEvent("transfer.bridged", { lead_call_control_id: leadCcid });
          return new Response("ok");
        }

        if (digits) await endTransfer("agent_declined", `agent pressed "${digits}"`);
        else        await endTransfer("agent_no_answer", `gather ended with status "${status}" and no digits`);
        return new Response("ok");
      }

      // ---- The agent leg ended ------------------------------------------
      // NOT a finalize. The lead leg owns the billing anchor, the debit and
      // the row's terminal state; this leg only records how far it got. If the
      // call was bridged, the lead leg's own hangup follows and finalizes
      // there — which is what makes the whole call bill exactly once.
      if (eventType === "call.hangup") {
        const row = await loadAiCall();
        const st = row?.transfer_status || "";
        if (st === "ringing_agent" || st === "whisper") {
          // Never answered, or hung up before pressing anything.
          await sb.from("ai_calls").update({ transfer_status: "agent_no_answer" }).eq(idCol, idVal);
          await logEvent("transfer.agent_no_answer", { why: `agent leg hung up while ${st}`, hangup_cause: p.hangup_cause });
          await tellAssistant(
            ctx.lead_ccid || "",
            "SYSTEM: The warm transfer did not connect — the agent could not be reached. " +
            "Apologize once, briefly and warmly, then offer two or three specific times for the agent to " +
            "call back and use the book_appointment tool with exactly what the caller says. " +
            "Do not mention keypads or voicemail, and do not try to transfer again.",
          );
        }
        return new Response("ok");
      }

      return new Response("ok");
    } catch (e) {
      console.error("[ai-call-webhook] agent leg error:", (e as Error)?.message || e);
      return new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });
    }
  }

  // Trace EVERY event before doing anything with it, so a call that breaks
  // half-way still shows what arrived. Never throws (see logEvent).
  await logEvent(eventType || "unknown", p);

  try {
    // ------------------------------------------------------------------
    // AMD result — the ASYNC BACKSTOP. By the time this arrives the assistant
    // is normally already talking (call.answered attached it). See the header
    // note on why AMD no longer gates the greeting.
    // ------------------------------------------------------------------
    if (eventType.includes("machine") && eventType.endsWith("detection.ended")) {
      const result = String(p.result || "").toLowerCase();
      const isMachine = result.startsWith("machine") || result === "fax_detected";
      await logEvent("amd.verdict", { result, is_machine: isMachine, event_type: eventType });

      if (isMachine) {
        // Never talk to voicemail. The assistant has very likely spoken a
        // sentence into the greeting by now — accepted, documented tradeoff —
        // so tag the call and end it.
        //
        // TAG BEFORE HANGING UP. This order is load-bearing since the assistant
        // started attaching on call.answered: answered_at is now stamped by the
        // time a machine verdict lands, so `computeBilledMinutes` would return
        // a real minute and the ONLY thing zeroing it is the finalize block
        // reading outcome === 'voicemail'. Hanging up first races our own
        // call.hangup event against this write — and losing that race bills an
        // agent a minute for a voicemail, which is the one thing this feature
        // promises never to do.
        await sb.from("ai_calls").update({ outcome: "voicemail" }).eq(idCol, idVal);
        await hangupCall();
        return new Response("ok");
      }

      // Human (or not_sure / silence — proceed rather than hang up on a real
      // person). Normally a no-op: call.answered has already claimed the call
      // and the assistant is mid-greeting. This only does work when the
      // call.answered event was lost or its claim errored.
      if (await claimAssistantStart()) {
        await logEvent("assistant_start.amd_backstop", { trigger: eventType, result });
        await startAssistant(eventType);
      } else {
        await logEvent("assistant_start.already_claimed", { trigger: eventType, result });
      }
      return new Response("ok");
    }

    // call.answered — THE HOT PATH. Everything between this event arriving and
    // ai_assistant_start being accepted is dead air on a real person's phone,
    // so it does the least possible work: one atomic claim (which is also the
    // billing anchor), then the Telnyx action. The grace timer is armed too,
    // but only ever fires if that claim could not be made at all.
    if (eventType === "call.answered") {
      const answeredIso = new Date().toISOString();
      const task = deadAirFallback(answeredIso);
      // Prefer running it after the response; if the runtime has no
      // background-task API, hold the request instead of dropping the timer.
      const backgrounded = scheduleBackground(task);

      if (await claimAssistantStart(answeredIso)) {
        await startAssistant("call.answered");
      } else {
        await logEvent("assistant_start.already_claimed", { trigger: "call.answered" });
      }

      if (!backgrounded) await task;
      return new Response("ok");
    }

    // ------------------------------------------------------------------
    // Transcript / insights.
    //
    // `call.conversation_insights.generated` arrives ~8 SECONDS AFTER the call
    // has already hung up and finalized, so this block's job is to CORRECT an
    // already-written row, not to write a fresh one. shouldReplaceOutcome
    // enforces the only rule that matters there: a terminal tag is never
    // downgraded by a later, vaguer one.
    //
    // The parsing itself lives in _shared/ai-call-outcome.ts — pure, and
    // pinned by a unit test against the exact production payload that used to
    // make every completed call land 'error'.
    // ------------------------------------------------------------------
    const transcript = extractTranscript(p);
    const insight = parseInsightPayload(p, TELNYX_OUTCOME_INSIGHT_ID);
    if (transcript !== null || insight.method !== "none") {
      const row = await loadAiCall();
      const update: Record<string, unknown> = {};
      if (transcript !== null) update.transcript = transcript;
      if (insight.summary) update.summary = insight.summary;
      if (insight.qualification) {
        // Merge, never replace: ai-call-tools already wrote what the assistant
        // gathered live (age, budget, the transfer summary), and the post-call
        // insight is a second opinion arriving late — it must not blank fields
        // that were captured during the actual conversation.
        const merged = { ...(row?.qualification || {}) };
        for (const [k, v] of Object.entries(insight.qualification)) {
          if (v != null && v !== "") merged[k] = v;
        }
        update.qualification = merged;
      }
      if (insight.outcome && shouldReplaceOutcome(row?.outcome, insight.outcome)) {
        update.outcome = insight.outcome;
      }

      if (insight.outcome === "dnc_request" && row) {
        await applyDnc(sb, row.agent_id, row.phone_e164, row.lead_id, callControlId);
      }

      if (Object.keys(update).length > 0) {
        await sb.from("ai_calls").update(update).eq(idCol, idVal);
      }
      await logEvent("insight.parsed", {
        method:  insight.method,
        outcome: insight.outcome,
        applied_outcome: update.outcome ?? null,
        had_qualification: !!insight.qualification,
        summary_chars: insight.summary?.length ?? 0,
      });
      if (!isFinalize) return new Response("ok");
    }

    // ------------------------------------------------------------------
    // The assistant stopped talking (`call.conversation.ended`).
    //
    // Two very different situations arrive on this one event:
    //
    //   • A warm transfer just bridged. The assistant was stopped ON PURPOSE
    //     and the agent and the lead are mid-conversation. Finalizing here
    //     would close the row, compute a duration and debit the wallet while
    //     two people are still talking — so this returns and lets the LEAD's
    //     own call.hangup finalize, which is also what keeps the whole call to
    //     exactly one debit.
    //   • The assistant ran out of things to say, or hit its own
    //     telephony_settings.time_limit_secs. Telnyx documents that cap as
    //     stopping the ASSISTANT, not the call — and the leg lives for up to
    //     LEG_TIME_LIMIT_SECS so that a transferred conversation is not cut
    //     off at five minutes. Left alone, that is a real person listening to
    //     silence on a billable call. Hang it up.
    // ------------------------------------------------------------------
    if (eventType.endsWith("conversation.ended")) {
      const row = await loadAiCall();
      const st = row?.transfer_status || "";
      if (st === "bridged" || st === "ringing_agent" || st === "whisper") {
        await logEvent("conversation.ended.transfer_live", { transfer_status: st });
        return new Response("ok");
      }
      if (row && row.status !== "completed") {
        await logEvent("conversation.ended.hangup", { transfer_status: st || null });
        await hangupCall();
      }
    }

    // ------------------------------------------------------------------
    // Hangup — finalize + debit exactly once.
    // ------------------------------------------------------------------
    if (isFinalize) {
      const row = await loadAiCall();
      if (!row) return new Response("ok"); // row not written yet — nothing to bill

      const answeredAt = row.answered_at ? new Date(row.answered_at) : null;
      // Webhook-receipt time; answered_at was also stamped on webhook receipt
      // (AMD human branch), so both ends are on the same clock.
      const endTime = new Date();
      const durationSecs = answeredAt
        ? Math.max(0, Math.floor((endTime.getTime() - answeredAt.getTime()) / 1000))
        : 0;
      // Don't charge the agent for OUR failures. error_detail is written only
      // by this webhook's own failure paths (ai_assistant_start rejected,
      // assistant secret missing) — the AI never joined the call, so the
      // minimum-1-minute rounding would bill a real minute for a few seconds
      // of dead air we caused. Legit answered calls that merely failed
      // outcome-classification have no error_detail and still bill normally.
      const ourFault = !!row.error_detail;
      // A VOICEMAIL IS NEVER BILLABLE, whatever the event order was. Screening
      // out voicemails is a headline benefit of this feature, not something
      // the agent pays a minimum minute for (see ai-call-billing.ts). This
      // used to be guaranteed by answered_at staying null on the AMD-machine
      // path — but the dead-air fallback can stamp answered_at at +6s while
      // premium AMD is still listening to a long voicemail greeting, and then
      // the whole-minute rounding would charge for it. The rule belongs on the
      // outcome, not on an ordering assumption.
      const isVoicemail = row.outcome === "voicemail";
      const billed = (ourFault || isVoicemail) ? 0 : computeBilledMinutes(durationSecs);

      // Debit exactly once, for the WHOLE call.
      //
      // ref_id is the LEAD leg's call_control_id and nothing else. A warm
      // transfer creates a second Telnyx leg with its own id, and that leg
      // never reaches this block at all (the agent-leg branch returns long
      // before it) — so the agent's conversation with the lead rides on the
      // same single ai_call debit, anchored at lead answer, exactly as
      // docs/ai-sales-agent-build-plan.md Phase 2 specifies. The pre-check
      // below plus the partial unique index on wallet_ledger are the race-safe
      // backstop (23505 -> no-op).
      if (billed > 0) {
        await debitAiCallOnce({
          hasExistingDebit: async () => {
            const { data } = await sb.from("wallet_ledger")
              .select("id")
              .eq("category", "ai_call")
              .eq("entry_type", "debit")
              .eq("ref_id", callControlId)
              .limit(1)
              .maybeSingle();
            return !!data;
          },
          debit: async () => {
            const desc = `AI Sales Agent call — ${leadName || row.phone_e164}`;
            const { error } = await sb.rpc("wallet_debit_ai_minutes", {
              p_agent:    row.agent_id,
              p_minutes:  billed,
              p_ref_type: "ai_call",
              p_ref_id:   callControlId,
              p_desc:     desc,
            });
            if (error) {
              const msg = error.message || "";
              if (error.code === "23505" || /duplicate key/i.test(msg)) return; // concurrent double-fire
              // insufficient_balance or other: the call already happened; log,
              // don't throw (a thrown error would make Telnyx retry forever).
              console.warn("[ai-call-webhook] wallet_debit_ai_minutes failed:", msg, (error as { details?: string }).details || "");
            }
          },
        });
      }

      // Finalize the outcome.
      //
      // A terminal tag already on the row (voicemail from AMD, a parsed
      // dnc_request, `transferred` written when the legs bridged) stands.
      // Otherwise the outcome is DERIVED FROM CALL-FLOW FACTS, never defaulted
      // to 'error' — see _shared/ai-call-outcome.ts. That default is the bug
      // this round fixed: six consecutive production calls, every one of them
      // a normal conversation, all stored as errors because the insight came
      // back as prose. `error` now means only what it says, and a later
      // insights event can still upgrade `completed` to something specific.
      const derived = outcomeFromCallFlow({
        answered:          !!answeredAt,
        ourFault,
        machineDetected:   row.outcome === "voicemail",
        transferStatus:    row.transfer_status,
        appointmentBooked: !!row.appointment_id,
      });
      const finalOutcome: AiCallOutcome = shouldReplaceOutcome(row.outcome, derived)
        ? derived
        : (row.outcome as AiCallOutcome);

      await sb.from("ai_calls").update({
        status:         "completed",
        outcome:        finalOutcome,
        duration_secs:  durationSecs,
        billed_minutes: billed,
        ended_at:       endTime.toISOString(),
      }).eq(idCol, idVal);

      await logEvent("finalize", {
        outcome_before: row.outcome, outcome_after: finalOutcome, derived,
        duration_secs: durationSecs, billed_minutes: billed,
        transfer_status: row.transfer_status, appointment_id: row.appointment_id,
      });

      // A qualified lead the agent never got to is the most valuable thing
      // this feature produces and the easiest to lose. Name it in the trace.
      if (row.transfer_status === "agent_declined" || row.transfer_status === "agent_no_answer") {
        await logEvent("qualified_missed", {
          transfer_status: row.transfer_status,
          transfer_to:     row.transfer_call_control_id ? "dialed" : "not dialed",
          booked:          !!row.appointment_id,
        });
      }

      return new Response("ok");
    }
  } catch (e) {
    // Return 500 so Telnyx retries; every mutation above is idempotent, so a
    // retry can't double-charge or double-suppress.
    console.error("[ai-call-webhook] error:", (e as Error)?.message || e);
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });
  }

  return new Response("ok");
});

// ---- The opening line ------------------------------------------------------
// Spoken verbatim by Telnyx as the call's `greeting`, so this string IS the
// TCPA disclosure. Every clause is load-bearing:
//   • who is calling      — the AI's name when the agent chose one
//   • on whose behalf     — the licensed agent + their agency
//   • that it is NOT a person — "I'm an assistant"
//   • why                 — the coverage they asked about
//
// WORDING (owner decision, 2026-07-30): "an assistant", NOT "an automated AI
// assistant". The honesty requirement did not move — it moved INTO the
// conversation: the assistant's instructions require it to say immediately and
// plainly that it is an automated assistant the moment anyone asks whether
// it's a person, a robot or AI. See docs/ai-assistant-script-v1.md
// § "Disclosure wording history".
//
// Written to be SPOKEN: contractions, em-dashes where a person would breathe,
// one question at the end and nothing after it.
//
// Every fact degrades on its own, because in production any of them can be
// blank. No name at all still produces a complete, compliant sentence — it
// must, since a nameless lead is the one most likely to hang up on a stumble.
export function buildGreeting(vars: Record<string, string>): string {
  const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");

  // lead_first is stamped by ai-call-start; fall back to the first word of
  // lead_name for calls already in flight when this shipped. 'there' is
  // ai-call-start's own historical placeholder, not a person's name.
  const rawFirst = clean(vars.lead_first) || clean(vars.lead_name).split(/\s+/)[0] || "";
  const first  = /^(there|null|undefined|unknown)$/i.test(rawFirst) ? "" : rawFirst;
  const aiName = clean(vars.ai_name);          // agents.ai_agent_name — never defaulted
  const agent  = clean(vars.agent_name) || "your agent";
  const agency = clean(vars.agency_name);
  const type   = clean(vars.lead_type) || "life insurance";

  // Four openers, because "Hi , this is  —" is how a robot sounds.
  const opener = first
    ? (aiName ? `Hi ${first}, this is ${aiName} — ` : `Hi ${first} — `)
    : (aiName ? `Hi, this is ${aiName} — `          : `Hi there — `);

  const behalf = agency
    ? `I'm an assistant calling on behalf of ${agent} with ${agency}.`
    : `I'm an assistant calling on behalf of ${agent}.`;

  return `${opener}${behalf} I'm reaching out about the ${type} coverage ` +
    `you asked about — do you have a quick minute?`;
}

// Instant DNC: suppression row (idempotent — dup key on the unique index is a
// no-op) + flip the lead's dnc flag so no future session dials it.
async function applyDnc(
  // `ReturnType<typeof createClient>` resolves to a client whose schema
  // generics are `never`, so every insert/update through it failed to
  // type-check and `deno check` on this file has never passed. Same widened
  // signature the _shared modules use.
  // deno-lint-ignore no-explicit-any
  sb: SupabaseClient<any, any, any>,
  agentId: string,
  phoneE164: string,
  leadId: string | null,
  callControlId: string,
) {
  const { error } = await sb.from("suppression_list").insert({
    agent_id:       agentId,
    phone_e164:     phoneE164,
    reason:         "caller requested removal (dnc_request)",
    source_call_id: callControlId,
  });
  if (error && error.code !== "23505") {
    console.warn("[ai-call-webhook] suppression insert failed:", error.message);
  }
  if (leadId) {
    await sb.from("leads")
      .update({ dnc: true, dnc_at: new Date().toISOString() })
      .eq("id", leadId);
  }
}

// Best-effort transcript capture from whichever field Telnyx populates.
function extractTranscript(p: Record<string, unknown>): unknown {
  const candidates = [
    p.transcript, p.conversation, p.messages,
    p.conversation_insights, p.insights, p.result,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "object") return c;              // array or object
    if (typeof c === "string" && c.trim()) return c;  // plain-text transcript
  }
  return null;
}

// extractOutcomeObject() used to live here. It has moved, and grown teeth, in
// _shared/ai-call-outcome.ts — where it is a pure function with unit tests
// pinned to the real production payload it used to fail on. Its old greedy
// `/\{[\s\S]*"outcome"[\s\S]*\}/` is specifically covered by a test now: given
// prose containing two JSON objects it matched from the first `{` to the last
// `}` and parsed as neither.
