import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyTelnyxSignature } from "../_shared/webhook-verify.ts";
import {
  computeBilledMinutes,
  debitAiCallOnce,
  normalizeOutcome,
  type AiCallOutcome,
} from "../_shared/ai-call-billing.ts";

// ai-call-webhook — Telnyx Call Control + AI Assistant webhook for one AI
// Sales Agent call. Configured per-call by ai-call-start (webhook_url). Does
// its OWN Ed25519 signature check (verify_jwt = false in config.toml — Telnyx
// can't supply a Supabase JWT), same as messaging-delivery-webhook.
//
// Flow:
//   • call.answered      -> arm the DEAD-AIR FALLBACK (see below). Does NOT
//     stamp answered_at or start the assistant on its own.
//   • AMD says machine   -> hang up, mark 'voicemail'. No answered_at, no debit.
//   • AMD says human     -> claim the start, stamp answered_at (billing
//     anchor) and attach the assistant via /actions/ai_assistant_start.
//   • transcript/insights -> store transcript + parse the assistant outcome
//     JSON; a dnc_request writes a suppression row + flips leads.dnc.
//   • call.hangup        -> compute talk minutes (answered_at -> hangup),
//     debit the wallet ONCE via wallet_debit_ai_minutes (idempotent by
//     call_control_id), finalize the row.
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
//    broken assistant: both are silence. call.answered now arms a background
//    timer, and if no AMD verdict has claimed the call within
//    ASSISTANT_START_GRACE_MS the assistant starts anyway. Exactly one path
//    ever starts it — claimAssistantStart() is an atomic compare-and-set on
//    `answered_at is null` — so the fallback cannot double-start or double-bill.
//
// Every event received and every action taken is appended to ai_call_events
// (20260752) so the next silent call is read off a table, not guessed at.
//
// It does NOT write into public.calls: that table feeds the human dialer's
// monthly minute cap (telnyx-bridge/signalwire-bridge) and the Summary
// dial/contact analytics, both of which sum calls.duration_sec unfiltered.
// ai_calls is the AI call's activity/disposition record; Phase 4's timeline
// UI unions the two by lead_id for display.

// How long after call.answered to wait for a premium-AMD verdict before
// starting the assistant regardless. Premium AMD resolves a human in roughly
// 2–5s; past this the caller is just listening to nothing.
const ASSISTANT_START_GRACE_MS = 6000;

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

  // client_state carries { role, ai_call_id, vars } stamped by ai-call-start.
  let ctx: { role?: string; ai_call_id?: string; vars?: Record<string, string> } = {};
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

  // Resolve the ai_calls row's id: prefer the id carried in client_state
  // (race-free), fall back to a lookup by call_control_id. Every ai_calls
  // update below targets (idCol = idVal); call_control_id is always present as
  // the last-resort target.
  let aiCallId = ctx.ai_call_id || "";
  if (!aiCallId) {
    const { data } = await sb.from("ai_calls").select("id").eq("call_control_id", callControlId).maybeSingle();
    aiCallId = (data?.id as string) || "";
  }
  const idCol = aiCallId ? "id" : "call_control_id";
  const idVal = aiCallId || callControlId;

  type AiCallRow = {
    id: string;
    agent_id: string;
    lead_id: string | null;
    phone_e164: string;
    status: string | null;
    outcome: string | null;
    answered_at: string | null;
    started_at: string | null;
    error_detail: string | null;
  };
  async function loadAiCall(): Promise<AiCallRow | null> {
    const { data } = await sb.from("ai_calls")
      .select("id, agent_id, lead_id, phone_e164, status, outcome, answered_at, started_at, error_detail")
      .eq(idCol, idVal)
      .maybeSingle();
    return (data as AiCallRow | null) ?? null;
  }

  // ---- Diagnostic trace (20260752) ---------------------------------------
  // Fire-and-forget by contract: a logging failure must never change how a
  // call is handled, so every path here swallows its own errors.
  async function logEvent(type: string, detail: unknown): Promise<void> {
    try {
      await sb.from("ai_call_events").insert({
        call_control_id: callControlId,
        event_type:      type,
        payload:         detail as Record<string, unknown>,
      });
    } catch (e) {
      console.warn("[ai-call-webhook] ai_call_events insert failed:", (e as Error)?.message || e);
    }
  }

  async function hangupCall(): Promise<void> {
    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, {
      method:  "POST",
      headers: telnyxHeaders,
      body:    JSON.stringify({ command_id: crypto.randomUUID() }),
    }).catch(() => {});
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

    const greeting =
      `Hi ${vars.lead_name || "there"}, this is an automated AI assistant calling on behalf of ` +
      `${vars.agent_name || "your agent"} with ${vars.agency_name || "our agency"}. ` +
      `I'm reaching out about the ${vars.lead_type || "life insurance"} coverage you asked about. ` +
      `Do you have a quick minute?`;

    // The attempt ladder. Rung 1 is the proven-accepted body; each further rung
    // drops the next-most-likely-rejected field so a validator change can cost
    // the call its voice or its custom greeting but never its audio. NOTHING
    // here sends message_history — see the header note.
    const full: Record<string, unknown> = { assistant: { id: TELNYX_ASSISTANT }, greeting };
    if (vars.voice) full.voice = vars.voice;

    const attempts: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: vars.voice ? "assistant+greeting+voice" : "assistant+greeting", body: full },
    ];
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

    for (const attempt of attempts) {
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
        await logEvent("ai_assistant_start.network_error", { trigger, attempt: attempt.label, message: lastText });
        break; // a transport failure won't be fixed by sending a smaller body
      }

      if (res.ok) {
        await logEvent("ai_assistant_start.ok", {
          trigger,
          attempt: attempt.label,
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
        status:  lastStatus,
        body:    lastText.slice(0, 1000),
      });

      // Only a 4xx is a body problem worth degrading for. A 5xx is Telnyx's
      // side and a smaller body won't help.
      if (res.status < 400 || res.status >= 500) break;
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
  // Armed by call.answered. If the AMD verdict has not claimed the call by the
  // time the grace period expires, start the assistant anyway.
  async function deadAirFallback(answeredAtIso: string): Promise<void> {
    await sleep(ASSISTANT_START_GRACE_MS);
    const row = await loadAiCall();
    if (!row) return;
    // AMD already resolved it: human (answered_at claimed, assistant started),
    // machine (outcome voicemail), or the call is simply over.
    if (row.answered_at || row.error_detail) return;
    if (row.status === "completed" || row.outcome === "voicemail") return;
    if (!await claimAssistantStart(answeredAtIso)) return;

    console.warn("[ai-call-webhook] no AMD verdict within grace — starting assistant anyway.");
    await logEvent("assistant_start.amd_fallback", {
      grace_ms:    ASSISTANT_START_GRACE_MS,
      answered_at: answeredAtIso,
    });
    await startAssistant("call.answered+fallback");
  }

  // Trace EVERY event before doing anything with it, so a call that breaks
  // half-way still shows what arrived. Never throws (see logEvent).
  await logEvent(eventType || "unknown", p);

  try {
    // ------------------------------------------------------------------
    // AMD result — the human/machine fork.
    // ------------------------------------------------------------------
    if (eventType.includes("machine") && eventType.endsWith("detection.ended")) {
      const result = String(p.result || "").toLowerCase();
      const isMachine = result.startsWith("machine") || result === "fax_detected";
      await logEvent("amd.verdict", { result, is_machine: isMachine, event_type: eventType });

      if (isMachine) {
        // Never talk to voicemail: hang up, tag voicemail, leave answered_at
        // null so the hangup bills 0. (If the dead-air fallback already
        // started the assistant, this still ends the call — the fallback
        // window is deliberately shorter than a voicemail greeting.)
        await hangupCall();
        await sb.from("ai_calls").update({ outcome: "voicemail" }).eq(idCol, idVal);
        return new Response("ok");
      }

      // Human (or not_sure / silence — proceed rather than hang up on a real
      // person). Claim the start: if the dead-air fallback already won the
      // race the assistant is running and answered_at is stamped, so there is
      // nothing left to do here.
      if (await claimAssistantStart()) {
        await startAssistant(eventType);
      } else {
        await logEvent("assistant_start.already_claimed", { trigger: eventType, result });
      }
      return new Response("ok");
    }

    // call.answered fires BEFORE the AMD result. It does not stamp the billing
    // anchor or start the assistant — that is the AMD verdict's job — but it
    // DOES arm the dead-air fallback, so a verdict that never arrives (or
    // arrives late) can no longer leave the caller listening to silence.
    if (eventType === "call.answered") {
      const task = deadAirFallback(new Date().toISOString());
      // Prefer running it after the response; if the runtime has no
      // background-task API, hold the request instead of dropping the timer.
      if (!scheduleBackground(task)) await task;
      return new Response("ok");
    }

    // ------------------------------------------------------------------
    // Transcript / insights — store transcript, parse the assistant outcome.
    // The exact Telnyx AI Assistant event name + payload shape for this is
    // still settling; capture defensively from several likely locations and
    // confirm during the manual test-call step.
    // ------------------------------------------------------------------
    const transcript = extractTranscript(p);
    const outcomeObj = extractOutcomeObject(p);
    if (transcript !== null || outcomeObj) {
      const row = await loadAiCall();
      const update: Record<string, unknown> = {};
      if (transcript !== null) update.transcript = transcript;
      if (outcomeObj) {
        const outcome = normalizeOutcome(outcomeObj.outcome, "in_progress");
        if (outcome !== "in_progress") update.outcome = outcome;
        if (typeof outcomeObj.summary === "string" && outcomeObj.summary) update.summary = outcomeObj.summary;

        if (outcome === "dnc_request" && row) {
          await applyDnc(sb, row.agent_id, row.phone_e164, row.lead_id, callControlId);
        }
      }
      if (Object.keys(update).length > 0) {
        await sb.from("ai_calls").update(update).eq(idCol, idVal);
      }
      if (!isFinalize) return new Response("ok");
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

      // Debit exactly once. Pre-check the ledger by ref_id; the partial unique
      // index on wallet_ledger is the race-safe backstop (23505 -> no-op).
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

      // Finalize the outcome. Terminal outcomes (voicemail from AMD, or a
      // qualified/not_interested/dnc_request already parsed) stand; a call
      // that never answered is 'no_answer'; an answered call we couldn't
      // classify is left 'error' (a later insights event still corrects it).
      const terminal: AiCallOutcome[] = ["voicemail", "busy", "not_interested", "qualified", "dnc_request", "no_answer"];
      let finalOutcome: AiCallOutcome;
      if (row.outcome && (terminal as string[]).includes(row.outcome)) {
        finalOutcome = row.outcome as AiCallOutcome;
      } else if (!answeredAt) {
        finalOutcome = "no_answer";
      } else {
        finalOutcome = "error";
      }

      await sb.from("ai_calls").update({
        status:         "completed",
        outcome:        finalOutcome,
        duration_secs:  durationSecs,
        billed_minutes: billed,
        ended_at:       endTime.toISOString(),
      }).eq(idCol, idVal);

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

// Instant DNC: suppression row (idempotent — dup key on the unique index is a
// no-op) + flip the lead's dnc flag so no future session dials it.
async function applyDnc(
  sb: ReturnType<typeof createClient>,
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

// Best-effort parse of the assistant's end-of-call outcome JSON:
//   { outcome, age_band, coverage_type, tobacco, budget, callback_window, summary }
// Looks in structured insight fields, then falls back to JSON-parsing the last
// assistant message in a transcript array.
function extractOutcomeObject(p: Record<string, unknown>): Record<string, unknown> | null {
  const direct = [p.insights, p.result, p.metadata, p.conversation_insights]
    .find((v) => v && typeof v === "object" && "outcome" in (v as object));
  if (direct) return direct as Record<string, unknown>;

  const parseMaybe = (s: unknown): Record<string, unknown> | null => {
    if (typeof s !== "string") return null;
    const m = s.match(/\{[\s\S]*"outcome"[\s\S]*\}/);
    if (!m) return null;
    try {
      const o = JSON.parse(m[0]);
      return o && typeof o === "object" && "outcome" in o ? o : null;
    } catch { return null; }
  };

  const fromString = parseMaybe(p.transcript) || parseMaybe(p.summary);
  if (fromString) return fromString;

  const arr = (Array.isArray(p.transcript) ? p.transcript
    : Array.isArray(p.messages) ? p.messages
    : Array.isArray(p.conversation) ? p.conversation
    : null) as Array<Record<string, unknown>> | null;
  if (arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const parsed = parseMaybe(arr[i]?.content) || parseMaybe(arr[i]?.text);
      if (parsed) return parsed;
    }
  }
  return null;
}
