import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "https://producerstackcrm.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  if (!TELNYX_API_KEY) {
    return new Response(JSON.stringify({ error: "telnyx_not_configured" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let body: { call_sid?: string };
  try { body = await req.json(); } catch { body = {}; }

  const callSid = body.call_sid;
  if (!callSid) {
    return new Response(JSON.stringify({ error: "missing call_sid" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // call_sid is the Telnyx call_control_id stored in calls.sw_call_sid
  const res = await fetch(`https://api.telnyx.com/v2/calls/${callSid}/actions/hangup`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ command_id: crypto.randomUUID() }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn("[telnyx-hangup] hangup failed (non-fatal, call may have already ended):", err);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
