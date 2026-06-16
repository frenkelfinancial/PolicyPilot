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

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) {
    return json({
      error: "telnyx_not_configured",
      detail: "TELNYX_API_KEY or TELNYX_CONNECTION_ID secret is missing from Supabase. Add them in Project Settings → Edge Functions → Secrets.",
    }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  // Verify the agent's JWT using the anon client
  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: { lead_id?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (!body.lead_id) return json({ error: "missing lead_id" }, 400);

  // Load agent — signalwire_caller_id column now stores the Telnyx number
  const { data: agent } = await sb.from("agents")
    .select("agent_phone, signalwire_caller_id, monthly_minute_limit")
    .eq("id", user.id)
    .maybeSingle();

  if (!agent?.agent_phone) {
    return json({ error: "not_assigned", detail: "Set your pickup phone in the Phone Book tab first." }, 422);
  }
  const callerIdE164: string = agent.signalwire_caller_id || "";
  if (!callerIdE164) {
    return json({ error: "no_caller_id", detail: "No Telnyx number assigned. Buy one in the Phone Book tab." }, 422);
  }

  // Get lead phone from the leads table
  const { data: leadRow } = await sb.from("leads")
    .select("id, data")
    .eq("agent_id", user.id)
    .eq("client_id", String(body.lead_id))
    .maybeSingle();

  const leadPhone: string = leadRow?.data?.phone || "";
  if (!leadPhone) {
    return json({ error: "lead_not_found", detail: "Lead has no phone number on file." }, 404);
  }

  // Enforce monthly minute cap
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: usageRows } = await sb.from("calls")
    .select("duration_sec")
    .eq("agent_id", user.id)
    .gte("started_at", monthStart.toISOString());
  const minutesUsed = Math.ceil(
    (usageRows || []).reduce((s: number, r: { duration_sec: number | null }) => s + (r.duration_sec || 0), 0) / 60
  );
  const minutesCap = agent.monthly_minute_limit || 500;
  if (minutesUsed >= minutesCap) {
    return json({ error: "minute_cap_exceeded", minutesUsed, minutesCap }, 422);
  }

  // Insert a placeholder calls row first so we have the UUID for client_state
  const { data: callRow, error: insertErr } = await sb.from("calls").insert({
    agent_id:   user.id,
    lead_id:    leadRow?.id || null,
    direction:  "outbound",
    phone_from: callerIdE164,
    phone_to:   leadPhone,
    started_at: new Date().toISOString(),
    status:     "initiated",
  }).select("id").single();

  if (insertErr || !callRow) {
    return json({ error: "db_insert_failed", detail: insertErr?.message }, 500);
  }

  // Encode context into client_state so the webhook knows what to do when agent answers
  const clientState = btoa(JSON.stringify({
    role:          "agent",
    lead_phone:    leadPhone,
    caller_id:     callerIdE164,
    call_row_id:   callRow.id,
    agent_id:      user.id,
    connection_id: TELNYX_CONN_ID,
  }));

  const webhookUrl = `${SUPABASE_URL}/functions/v1/telnyx-call-status`;

  // Place the outbound call to the agent's phone via Telnyx Call Control
  const telnyxRes = await fetch("https://api.telnyx.com/v2/calls", {
    method: "POST",
    headers: {
      "Authorization":  `Bearer ${TELNYX_API_KEY}`,
      "Content-Type":   "application/json",
    },
    body: JSON.stringify({
      connection_id:      TELNYX_CONN_ID,
      to:                 agent.agent_phone,
      from:               callerIdE164,
      client_state:       clientState,
      webhook_url:        webhookUrl,
      webhook_url_method: "POST",
    }),
  });

  if (!telnyxRes.ok) {
    const errText = await telnyxRes.text();
    await sb.from("calls").delete().eq("id", callRow.id);
    return json({ error: "telnyx_unreachable", detail: errText }, 502);
  }

  const telnyxData = await telnyxRes.json();
  // call_control_id is used for subsequent actions (bridge, hangup)
  const callSid: string = telnyxData?.data?.call_control_id || "";

  // Store the Telnyx call_control_id in sw_call_sid (reusing existing column)
  await sb.from("calls").update({ sw_call_sid: callSid }).eq("id", callRow.id);

  return json({ ok: true, callSid });
});
