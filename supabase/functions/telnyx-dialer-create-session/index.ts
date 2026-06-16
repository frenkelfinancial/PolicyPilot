import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY    = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID    = Deno.env.get("TELNYX_CONNECTION_ID");
  const TELNYX_DIALER_NUM = Deno.env.get("TELNYX_DIALER_NUMBER");

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) {
    return json({
      error: "telnyx_not_configured",
      detail: "TELNYX_API_KEY or TELNYX_CONNECTION_ID secret is missing from Supabase. Add them in Project Settings → Edge Functions → Secrets.",
    }, 500);
  }
  if (!TELNYX_DIALER_NUM) {
    return json({
      error: "dialer_not_configured",
      detail: "TELNYX_DIALER_NUMBER secret is missing from Supabase. Buy a host number and set this secret to its E.164 value.",
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

  let body: { lead_ids?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const leadIds = Array.isArray(body.lead_ids)
    ? body.lead_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (leadIds.length === 0) return json({ error: "no_leads_selected" }, 400);
  if (leadIds.length > 500) return json({ error: "too_many_leads", detail: "Select 500 or fewer leads per session." }, 400);

  // Load agent — need a Telnyx caller-ID number to dial leads from, plus
  // any existing dialer PIN.
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id, dialer_pin")
    .eq("id", user.id)
    .maybeSingle();

  const callerIdE164: string = agent?.signalwire_caller_id || "";
  if (!callerIdE164) {
    return json({ error: "no_caller_id", detail: "No Telnyx number assigned. Buy one in the Phone Book tab before using the power dialer." }, 422);
  }

  const telnyxHeaders = {
    "Authorization": `Bearer ${TELNYX_API_KEY}`,
    "Content-Type":  "application/json",
  };

  // Ensure the agent has a dialer PIN, generating + reserving one if needed.
  let pin: string | null = agent?.dialer_pin || null;
  for (let i = 0; i < 5 && !pin; i++) {
    const candidate = String(Math.floor(1000 + Math.random() * 9000));
    const { data: updated, error } = await sb.from("agents")
      .update({ dialer_pin: candidate })
      .eq("id", user.id)
      .is("dialer_pin", null)
      .select("dialer_pin")
      .maybeSingle();

    if (updated?.dialer_pin) { pin = updated.dialer_pin; break; }
    if (error && error.code !== "23505") {
      return json({ error: "pin_generation_failed", detail: error.message }, 500);
    }
    // Either a collision on the candidate, or someone else set it concurrently.
    const { data: refetched } = await sb.from("agents").select("dialer_pin").eq("id", user.id).maybeSingle();
    if (refetched?.dialer_pin) pin = refetched.dialer_pin;
  }
  if (!pin) return json({ error: "pin_generation_failed" }, 500);

  // Cancel any prior non-terminal session for this agent, hanging up its
  // legs best-effort so a stale session doesn't keep ringing.
  const { data: oldSessions } = await sb.from("dialer_sessions")
    .select("id, agent_call_control_id, current_call_control_id")
    .eq("agent_id", user.id)
    .in("status", ["pending", "dialing", "connected"]);

  for (const old of oldSessions || []) {
    for (const callControlId of [old.current_call_control_id, old.agent_call_control_id]) {
      if (!callControlId) continue;
      try {
        await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({ command_id: crypto.randomUUID() }),
        });
      } catch { /* best effort */ }
    }
    await sb.from("dialer_sessions")
      .update({ status: "cancelled", ended_at: new Date().toISOString() })
      .eq("id", old.id);
  }

  // Create the new pending session.
  const { data: session, error: insertErr } = await sb.from("dialer_sessions").insert({
    agent_id:    user.id,
    pin,
    lead_ids:    leadIds,
    status:      "pending",
    host_number: TELNYX_DIALER_NUM,
  }).select("id").single();

  if (insertErr || !session) {
    return json({ error: "db_insert_failed", detail: insertErr?.message }, 500);
  }

  return json({ ok: true, session_id: session.id, pin, host_number: TELNYX_DIALER_NUM });
});
