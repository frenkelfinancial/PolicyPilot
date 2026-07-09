import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DialerSession,
  closeCallRowById,
  reportMinutesToWallet,
  dialNextLead,
} from "../_shared/dialer-next-lead.ts";

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

// Advances the Power Dialer to the next lead.
//
// Steps:
//   1. Pre-clear current_call_control_id in the DB so that if Telnyx fires
//      a call.hangup event for the leg we're about to hang up, the webhook
//      handler won't try to process it (it won't find a matching session row).
//   2. Close the current call row for billing (idempotent).
//   3. Hang up the current lead leg if one is active.
//   4. Call dialNextLead() to place the call to the next lead and update the
//      session. dialNextLead is passed current_call_row_id=null so it doesn't
//      try to close a row that's already closed.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY        = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY  = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID  = Deno.env.get("TELNYX_CONNECTION_ID")!;

  if (!TELNYX_API_KEY) {
    return json({ error: "telnyx_not_configured", detail: "TELNYX_API_KEY secret is missing." }, 500);
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
    .select("*")
    .eq("id", sessionId)
    .eq("agent_id", user.id)
    .maybeSingle();

  if (!session) return json({ error: "not_found" }, 404);
  if (!["dialing", "connected"].includes(session.status)) {
    return json({ error: "session_not_active" }, 409);
  }

  const prevCallControlId = session.current_call_control_id as string | null;
  const prevCallRowId     = session.current_call_row_id as string | null;

  // Step 1: Pre-clear the active call from the session.
  // This prevents the call.hangup webhook from treating this as a natural
  // hangup — it won't find a matching current_call_control_id.
  if (prevCallControlId || prevCallRowId) {
    await sb.from("dialer_sessions").update({
      current_call_control_id: null,
      current_call_row_id:     null,
    }).eq("id", sessionId);
  }

  // Step 2: Close the current call row for billing.
  const closed = await closeCallRowById(sb, prevCallRowId);
  if (closed) {
    await reportMinutesToWallet(sb, closed.agentId, closed.durationSec, closed.id, closed.walletHoldId);
  }

  // Step 3: Hang up the current lead leg if active.
  if (prevCallControlId) {
    try {
      await fetch(`https://api.telnyx.com/v2/calls/${prevCallControlId}/actions/hangup`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TELNYX_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({ command_id: crypto.randomUUID() }),
      });
    } catch { /* best effort */ }
  }

  // Step 4: Advance to the next lead.
  // Pass the session with cleared call IDs so dialNextLead won't try to
  // close a row we already closed above.
  const webhookUrl = `${SUPABASE_URL}/functions/v1/telnyx-call-status`;
  const sessionForDial: DialerSession = {
    ...(session as DialerSession),
    current_call_control_id: null,
    current_call_row_id:     null,
  };

  const telnyxHeaders = {
    "Authorization": `Bearer ${TELNYX_API_KEY}`,
    "Content-Type":  "application/json",
  };

  // Play a short transition beep on the agent's bridge phone before dialing next lead
  const agentCallId     = (session as DialerSession).agent_call_control_id;
  const transitionUrl   = Deno.env.get("TRANSITION_AUDIO_URL") || "";
  if (agentCallId && transitionUrl) {
    try {
      // Stop any lingering ringback first
      await fetch(`https://api.telnyx.com/v2/calls/${agentCallId}/actions/playback_stop`, {
        method: "POST",
        headers: telnyxHeaders,
        body: JSON.stringify({ command_id: crypto.randomUUID() }),
      });
      // Play the transition beep
      await fetch(`https://api.telnyx.com/v2/calls/${agentCallId}/actions/playback_start`, {
        method: "POST",
        headers: telnyxHeaders,
        body: JSON.stringify({
          audio_url:  transitionUrl,
          loop:       1,
          command_id: crypto.randomUUID(),
        }),
      });
      // Brief pause so the beep plays before the next call starts dialing
      await new Promise((r) => setTimeout(r, 700));
    } catch { /* best effort */ }
  }

  await dialNextLead(sb, telnyxHeaders, TELNYX_CONN_ID, webhookUrl, sessionForDial);

  return json({ ok: true });
});
