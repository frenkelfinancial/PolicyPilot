import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { toE164 } from "../_shared/phone.ts";
import {
  isWithinAllowedHours,
  isWithinAllowedHoursUnknownTz,
  knownTimezoneForPhone,
} from "../_shared/tcpa.ts";

// ai-call-start — place ONE compliant AI Sales Agent qualification call.
//
// Same skeleton as telnyx-dialer-create-session: auth -> gates -> Telnyx
// API -> DB row. The gates here are the Phase 0 compliance foundation and
// run in a fixed order, each returning its own error code so the UI can
// explain exactly why a call was blocked:
//   1. ai_disabled          — global OR per-agent kill switch is off
//   2. upgrade_required     — plan tier isn't Pro or Team Leader
//   3. not_callable         — no consent / on DNC / on suppression list
//   4. quiet_hours          — outside 8am-9pm lead-local (most restrictive
//                             interpretation when the timezone is unknown)
//   5. insufficient_balance — wallet can't cover the AI call-start floor
//
// Only after all five pass does it dial. Billing happens later, in
// ai-call-webhook, via wallet_debit_ai_minutes.
serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY    = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID    = Deno.env.get("TELNYX_CONNECTION_ID");
  const TELNYX_ASSISTANT  = Deno.env.get("TELNYX_AI_ASSISTANT_ID");

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) {
    return json({
      error: "telnyx_not_configured",
      detail: "TELNYX_API_KEY or TELNYX_CONNECTION_ID secret is missing from Supabase. Add them in Project Settings → Edge Functions → Secrets.",
    }, 500);
  }
  if (!TELNYX_ASSISTANT) {
    return json({
      error: "assistant_not_configured",
      detail: "TELNYX_AI_ASSISTANT_ID secret is missing. Create the AI Assistant in Telnyx Mission Control and set its id as the TELNYX_AI_ASSISTANT_ID secret (Project Settings → Edge Functions → Secrets).",
    }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: { lead_id?: unknown; caller_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const leadId = typeof body.lead_id === "string" && body.lead_id.length > 0 ? body.lead_id : "";
  if (!leadId) return json({ error: "missing_lead_id", detail: "lead_id (public.leads.id uuid) is required." }, 400);

  // One parallel round-trip for everything the gates read.
  const [{ data: agent }, { data: billingConfig }, { data: wallet }, { data: lead }] = await Promise.all([
    sb.from("agents")
      .select("is_admin, ai_dialer_enabled, plan_id, display_name, agency_name, signalwire_caller_id, ai_voice, ai_agent_name")
      .eq("id", user.id)
      .maybeSingle(),
    sb.from("billing_config")
      .select("ai_dialer_enabled, ai_quiet_start, ai_quiet_end, min_ai_call_start_mills")
      .eq("id", 1)
      .maybeSingle(),
    sb.from("wallet_accounts")
      .select("balance_mills")
      .eq("agent_id", user.id)
      .maybeSingle(),
    sb.from("leads")
      .select("id, data, tcpa_consent, dnc, lead_timezone")
      .eq("agent_id", user.id)
      .eq("id", leadId)
      .maybeSingle(),
  ]);

  // ---- Gate 1: kill switches (global AND per-agent) ----------------------
  if (!billingConfig?.ai_dialer_enabled || !agent?.ai_dialer_enabled) {
    return json({
      error: "ai_disabled",
      detail: "The AI Sales Agent dialer is turned off for your account.",
    }, 403);
  }

  // ---- Gate 2: plan tier is Pro or Team Leader ---------------------------
  // Mirrors app.html _planTier(): admin => leader; else the plan name decides.
  let planName = "";
  if (agent?.plan_id) {
    const { data: plan } = await sb.from("plans").select("name").eq("id", agent.plan_id).maybeSingle();
    planName = (plan?.name || "").toLowerCase();
  }
  const isEntitled = !!agent?.is_admin ||
    planName.includes("leader") || planName.includes("pro");
  if (!isEntitled) {
    return json({
      error: "upgrade_required",
      detail: "The AI Sales Agent is available on the Pro Producer and Team Leader plans.",
    }, 402);
  }

  // ---- Gate 3: lead is callable (consent + not DNC + not suppressed) ------
  if (!lead) return json({ error: "not_callable", reason: "lead_not_found" }, 404);

  const rawPhone: string = (lead.data as { phone?: string } | null)?.phone || "";
  const phoneE164 = toE164(rawPhone);
  if (!phoneE164) {
    return json({ error: "not_callable", reason: "no phone on file" }, 422);
  }
  if (!lead.tcpa_consent) {
    return json({ error: "not_callable", reason: "no TCPA consent on file" }, 422);
  }
  if (lead.dnc) {
    return json({ error: "not_callable", reason: "lead is on your do-not-call list" }, 422);
  }

  const { data: suppressed } = await sb.from("suppression_list")
    .select("id")
    .eq("phone_e164", phoneE164)
    .or(`agent_id.eq.${user.id},agent_id.is.null`)
    .limit(1)
    .maybeSingle();
  if (suppressed) {
    return json({ error: "not_callable", reason: "number is on the suppression list" }, 422);
  }

  // ---- Gate 4: quiet hours (lead-local; most restrictive if unknown) -----
  const quietStart = billingConfig?.ai_quiet_start ?? 8;
  const quietEnd   = billingConfig?.ai_quiet_end ?? 21;
  const now = new Date();
  const explicitTz = (lead.lead_timezone || "").trim();
  const tz = explicitTz || knownTimezoneForPhone(phoneE164);
  const withinHours = tz
    ? isWithinAllowedHours(now, tz, quietStart, quietEnd)
    : isWithinAllowedHoursUnknownTz(now, quietStart, quietEnd);
  if (!withinHours) {
    return json({
      error: "quiet_hours",
      detail: `Outside the ${quietStart}:00–${quietEnd}:00 calling window in the lead's local time.`,
    }, 422);
  }

  // ---- Gate 5: wallet floor for an AI call -------------------------------
  const minStartMills = billingConfig?.min_ai_call_start_mills ?? 150;
  const balanceMills  = wallet?.balance_mills ?? 0;
  if (balanceMills < minStartMills) {
    return json({
      error: "insufficient_balance",
      detail: "Insufficient wallet balance to start an AI call — top up to continue.",
    }, 402);
  }

  // ---- Caller ID ---------------------------------------------------------
  const callerId = (typeof body.caller_id === "string" && body.caller_id) ||
    agent?.signalwire_caller_id || "";
  if (!callerId) {
    return json({
      error: "no_caller_id",
      detail: "No Telnyx number assigned. Buy one in the Phone Book tab before using the AI dialer.",
    }, 422);
  }

  // ---- Preflight: the assistant id must actually exist -------------------
  // A wrong TELNYX_AI_ASSISTANT_ID produces the worst possible failure mode:
  // the call connects, the webhook's ai_assistant_start 404s, and the lead
  // hears dead air until the hangup. Verify the id up front and fail loudly
  // with its own error code so the test rig can say exactly what's wrong.
  const preflight = await fetch(
    `https://api.telnyx.com/v2/ai/assistants/${TELNYX_ASSISTANT}`,
    { headers: { "Authorization": `Bearer ${TELNYX_API_KEY}` } },
  ).catch(() => null);
  if (!preflight || !preflight.ok) {
    const status = preflight ? preflight.status : "network_error";
    const detail = preflight ? await preflight.text().catch(() => "") : "";
    console.error("[ai-call-start] assistant preflight failed:", status, detail);
    return json({
      error: "assistant_not_found",
      detail: `Telnyx returned ${status} for assistant id "${TELNYX_ASSISTANT}". ` +
        "Check that the TELNYX_AI_ASSISTANT_ID secret exactly matches the id shown in " +
        "Mission Control -> AI -> AI Assistants (it looks like 'assistant-xxxxxxxx-...'). " +
        detail.slice(0, 300),
    }, 502);
  }

  // ---- Dynamic variables handed to the assistant -------------------------
  const d = (lead.data as Record<string, unknown> | null) || {};
  const asStr = (v: unknown) => (typeof v === "string" ? v : "");
  // Left EMPTY when unknown rather than defaulted to "there": buildGreeting()
  // in the webhook has a proper nameless opener, and the wallet-ledger
  // description falls back to the phone number — "AI Sales Agent call — there"
  // is what a placeholder leaking into a receipt looks like.
  const leadName = asStr(d.name) ||
    [asStr(d.first_name), asStr(d.last_name)].filter(Boolean).join(" ").trim();
  // The greeting addresses people by FIRST name only — "Hi Mark Johnson," is
  // a telemarketer reading a screen.
  const leadFirst = asStr(d.first_name).trim() || leadName.split(/\s+/)[0] || "";
  // Agent-chosen TTS voice (agents.ai_voice). Travels in client_state.vars;
  // the webhook sends it as the top-level `voice` override on
  // ai_assistant_start. Empty = use the assistant's Mission Control voice.
  const aiVoice = asStr((agent as { ai_voice?: unknown } | null)?.ai_voice).trim();
  // The name the assistant introduces itself by (agents.ai_agent_name, 20260730).
  // Empty is a real answer — the webhook renders the nameless greeting and
  // NEVER invents one.
  const aiName = asStr((agent as { ai_agent_name?: unknown } | null)?.ai_agent_name).trim();

  const dynamicVariables = {
    lead_name:   leadName,
    lead_first:  leadFirst,
    lead_state:  asStr(d.state),
    lead_type:   asStr(d.coverage_wanted) || asStr(d.lead_type) || asStr(d.type) || asStr(d.source),
    agent_name:  asStr(agent?.display_name) || "your agent",
    agency_name: asStr(agent?.agency_name) || asStr(agent?.display_name) || "our agency",
    ai_name:     aiName,
    voice:       aiVoice,
  };

  const telnyxHeaders = {
    "Authorization": `Bearer ${TELNYX_API_KEY}`,
    "Content-Type":  "application/json",
  };
  const webhookUrl = `${SUPABASE_URL}/functions/v1/ai-call-webhook`;

  // Insert the ai_calls row BEFORE dialing so its id can travel in
  // client_state — the webhook resolves the row by that id (race-free, no
  // dependence on the call_control_id backfill landing before the first
  // event). call_control_id is filled in once Telnyx accepts the call.
  const { data: aiCall, error: insertErr } = await sb.from("ai_calls").insert({
    agent_id:   user.id,
    lead_id:    lead.id,
    phone_e164: phoneE164,
    from_e164:  callerId,
    status:     "in_progress",
    outcome:    "in_progress",
    voice:      aiVoice || null,
    started_at: new Date().toISOString(),
  }).select("id").single();

  if (insertErr || !aiCall) {
    console.error("[ai-call-start] ai_calls insert failed:", insertErr?.message);
    return json({ error: "db_insert_failed", detail: insertErr?.message }, 500);
  }

  // client_state travels with every Call Control event for this call: the
  // ai_call_id (webhook row lookup) + the lead/agent context the webhook
  // renders into the assistant's greeting + system message.
  const clientState = btoa(JSON.stringify({
    role:       "ai_call",
    ai_call_id: aiCall.id,
    vars:       dynamicVariables,
  }));

  // Telnyx /v2/calls does NOT accept an assistant field. Dial PLAIN with AMD
  // premium + our webhook; the webhook attaches the assistant via a
  // POST /v2/calls/{id}/actions/ai_assistant_start action.
  //
  // AMD stays PREMIUM even though it no longer gates the greeting (2026-07-30):
  // the webhook now attaches the assistant on call.answered and treats the AMD
  // verdict as an async backstop that hangs up on a machine. Since nobody
  // waits on it any more, there is no reason to trade premium's accuracy for a
  // faster mode — the cost of a wrong verdict (hanging up on a real person) is
  // far higher than the cost of a late one.
  const callRes = await fetch("https://api.telnyx.com/v2/calls", {
    method: "POST",
    headers: telnyxHeaders,
    body: JSON.stringify({
      connection_id:              TELNYX_CONN_ID,
      to:                         phoneE164,
      from:                       callerId,
      answering_machine_detection: "premium",
      // Hard 5-min cap at the call-leg level, belt-and-suspenders with the
      // assistant's telephony_settings.time_limit_secs (=300). Telnyx force-
      // ends the leg at this many seconds even if the assistant runs long.
      time_limit_secs:            300,
      webhook_url:                webhookUrl,
      webhook_url_method:         "POST",
      client_state:               clientState,
    }),
  });

  const failRow = async () => {
    await sb.from("ai_calls")
      .update({ status: "error", outcome: "error", ended_at: new Date().toISOString() })
      .eq("id", aiCall.id);
  };

  if (!callRes.ok) {
    const detail = await callRes.text().catch(() => "");
    console.error("[ai-call-start] telnyx call create failed:", callRes.status, detail);
    await failRow();
    return json({ error: "telnyx_error", status: callRes.status, detail }, 502);
  }

  const callData = await callRes.json();
  const callControlId: string = callData?.data?.call_control_id || "";
  const callLegId: string     = callData?.data?.call_leg_id || "";
  if (!callControlId) {
    await failRow();
    return json({ error: "telnyx_error", detail: "Telnyx accepted the call but returned no call_control_id." }, 502);
  }

  // Backfill the Telnyx ids onto the row (secondary key + debit reference).
  await sb.from("ai_calls")
    .update({ call_control_id: callControlId, telnyx_call_leg_id: callLegId || null })
    .eq("id", aiCall.id);

  return json({ ok: true, ai_call_id: aiCall.id, call_control_id: callControlId });
});
