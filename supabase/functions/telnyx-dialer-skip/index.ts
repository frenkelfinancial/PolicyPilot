import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://producerstackcrm.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Skips the current lead in an active Power Dialer session by hanging up
// its leg. The resulting call.hangup webhook (role=dialer_lead) drives
// dialNextLead() in telnyx-call-status — this function doesn't advance the
// session itself.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");

  if (!TELNYX_API_KEY) {
    return json({ error: "telnyx_not_configured", detail: "TELNYX_API_KEY secret is missing from Supabase." }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: { session_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!sessionId) return json({ error: "missing_session_id" }, 400);

  const { data: session } = await sb.from("dialer_sessions")
    .select("id, agent_id, status, current_call_control_id")
    .eq("id", sessionId)
    .eq("agent_id", user.id)
    .maybeSingle();

  if (!session) return json({ error: "not_found" }, 404);
  if (!["dialing", "connected"].includes(session.status)) {
    return json({ error: "session_not_active" }, 409);
  }
  if (!session.current_call_control_id) {
    return json({ error: "no_active_lead" }, 409);
  }

  await fetch(`https://api.telnyx.com/v2/calls/${session.current_call_control_id}/actions/hangup`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ command_id: crypto.randomUUID() }),
  });

  return json({ ok: true });
});
