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
// Flow (AMD premium is always requested by ai-call-start, so an AMD result
// event always fires and is the human/machine fork):
//   • AMD says machine  -> hang up, mark 'voicemail'. No answered_at, no debit.
//   • AMD says human     -> stamp answered_at (billing anchor) AND attach the
//     assistant via /actions/ai_assistant_start. (call.answered fires BEFORE
//     the AMD result, so neither the assistant start nor the billing anchor
//     can live there without risking talking-to / billing a voicemail.)
//   • transcript/insights -> store transcript + parse the assistant outcome
//     JSON; a dnc_request writes a suppression row + flips leads.dnc.
//   • call.hangup       -> compute talk minutes (answered_at -> hangup), debit
//     the wallet ONCE via wallet_debit_ai_minutes (idempotent by
//     call_control_id), finalize the row.
//
// It does NOT write into public.calls: that table feeds the human dialer's
// monthly minute cap (telnyx-bridge/signalwire-bridge) and the Summary
// dial/contact analytics, both of which sum calls.duration_sec unfiltered.
// ai_calls is the AI call's activity/disposition record; Phase 4's timeline
// UI unions the two by lead_id for display.
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
    outcome: string | null;
    answered_at: string | null;
    started_at: string | null;
    error_detail: string | null;
  };
  async function loadAiCall(): Promise<AiCallRow | null> {
    const { data } = await sb.from("ai_calls")
      .select("id, agent_id, lead_id, phone_e164, outcome, answered_at, started_at, error_detail")
      .eq(idCol, idVal)
      .maybeSingle();
    return (data as AiCallRow | null) ?? null;
  }

  const vars = ctx.vars || {};
  const leadName = vars.lead_name || "";
  const isFinalize = eventType === "call.hangup" || eventType.endsWith("conversation.ended");

  try {
    // ------------------------------------------------------------------
    // AMD result — the human/machine fork.
    // ------------------------------------------------------------------
    if (eventType.includes("machine") && eventType.endsWith("detection.ended")) {
      const result = String(p.result || "").toLowerCase();
      const isMachine = result.startsWith("machine") || result === "fax_detected";

      if (isMachine) {
        // Never talk to voicemail: hang up, tag voicemail, leave answered_at
        // null so the hangup bills 0.
        await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({ command_id: crypto.randomUUID() }),
        }).catch(() => {});
        await sb.from("ai_calls").update({ outcome: "voicemail" }).eq(idCol, idVal);
        return new Response("ok");
      }

      // Human (or not_sure / silence — proceed rather than hang up on a real
      // person): this is the billing anchor AND where the assistant attaches.
      await sb.from("ai_calls")
        .update({ status: "in_progress", answered_at: new Date().toISOString() })
        .eq(idCol, idVal)
        .is("answered_at", null); // idempotent — don't clobber an earlier stamp

      if (TELNYX_ASSISTANT) {
        const greeting =
          `Hi ${vars.lead_name || "there"}, this is an automated AI assistant calling on behalf of ` +
          `${vars.agent_name || "your agent"} with ${vars.agency_name || "our agency"}. ` +
          `I'm reaching out about the ${vars.lead_type || "life insurance"} coverage you asked about. ` +
          `Do you have a quick minute?`;
        const systemContext =
          `Lead context — name: ${vars.lead_name || ""}; state: ${vars.lead_state || ""}; ` +
          `lead_type: ${vars.lead_type || ""}; agent: ${vars.agent_name || ""}; ` +
          `agency: ${vars.agency_name || ""}.`;

        // Only assistant.id is required; greeting overrides the assistant's
        // stored config for this call, and any field omitted falls back to
        // that stored config. `voice` (when the agent picked one —
        // client_state.vars.voice, from agents.ai_voice) overrides the
        // assistant's Mission Control voice for this call only.
        const baseBody: Record<string, unknown> = {
          assistant: { id: TELNYX_ASSISTANT },
          greeting,
        };
        if (vars.voice) baseBody.voice = vars.voice;

        const attemptStart = (body: Record<string, unknown>) =>
          fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/ai_assistant_start`, {
            method: "POST",
            headers: telnyxHeaders,
            body: JSON.stringify({ ...body, command_id: crypto.randomUUID() }),
          });

        // Telnyx's production validator 422-rejects {role:"system"} entries in
        // message_history ("Invalid message format", pointer /message_history)
        // even though the API reference lists System messages as allowed — hit
        // live on 2026-07-27. So: attempt WITH the lead-context message first
        // (in case the validator is fixed / differs by account), and on a 422
        // that points at message_history retry once WITHOUT it. The greeting
        // already carries the essential context (lead name, agent, agency,
        // lead type), so a context-less start loses almost nothing, while a
        // failed start loses the whole call.
        let startRes = await attemptStart({
          ...baseBody,
          message_history: [{ role: "system", content: systemContext }],
        });
        let failText = "";
        if (!startRes.ok) {
          failText = await startRes.text().catch(() => "");
          if (startRes.status === 422 && failText.includes("message_history")) {
            console.warn("[ai-call-webhook] message_history rejected (422) — retrying without it:", failText);
            startRes = await attemptStart(baseBody);
            failText = startRes.ok ? "" : await startRes.text().catch(() => "");
          }
        }
        if (!startRes.ok) {
          console.error("[ai-call-webhook] ai_assistant_start failed:", startRes.status, failText);
          // Make the failure VISIBLE (the "answered but silent" bug): store
          // the Telnyx response on the row so the test rig can display it...
          await sb.from("ai_calls").update({
            error_detail: `ai_assistant_start ${startRes.status}: ${failText.slice(0, 500)}`,
          }).eq(idCol, idVal);
          // ...and hang up rather than leaving the lead listening to dead
          // air until the 5-minute cap. Finalize (call.hangup) will mark the
          // outcome 'error' since answered_at is set but nothing terminal is.
          await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, {
            method: "POST",
            headers: telnyxHeaders,
            body: JSON.stringify({ command_id: crypto.randomUUID() }),
          }).catch(() => {});
        }
      } else {
        console.error("[ai-call-webhook] TELNYX_AI_ASSISTANT_ID not set — cannot start the assistant.");
        await sb.from("ai_calls").update({
          error_detail: "TELNYX_AI_ASSISTANT_ID secret not set — assistant never attached.",
        }).eq(idCol, idVal);
        await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({ command_id: crypto.randomUUID() }),
        }).catch(() => {});
      }
      return new Response("ok");
    }

    // call.answered fires BEFORE the AMD result — nothing billing- or
    // assistant-relevant happens here (see the AMD branch above).
    if (eventType === "call.answered") return new Response("ok");

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
      const billed = ourFault ? 0 : computeBilledMinutes(durationSecs);

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
