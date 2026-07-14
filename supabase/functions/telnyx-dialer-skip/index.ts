import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DialerSession,
  closeCallRowById,
  reportMinutesToWallet,
  dialNextLead,
  advanceToNextLeadNoDial,
} from "../_shared/dialer-next-lead.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Advances, re-dials, or tears down the Power Dialer's current call.
//
// body: { session_id, mode?: 'advance' | 'advance_nodial' | 'redial' | 'hangup', expected_index?: number }
//   - mode defaults to 'advance' so an old cached frontend that never sends
//     `mode` behaves exactly as it did before this endpoint grew modes.
//   - expected_index, when provided, guards against double-invocation: if the
//     session has already moved past that index (e.g. a duplicate click that
//     fired while the first request was still in flight), this call returns
//     a harmless no-op instead of advancing or hanging up a second time.
//
// Steps (advance/redial):
//   1. Pre-clear current_call_control_id in the DB so that if Telnyx fires
//      a call.hangup event for the leg we're about to hang up, the webhook
//      handler won't try to process it (it won't find a matching session row).
//   2. Close the current call row for billing (idempotent).
//   3. Hang up the current lead leg if one is active.
//   4. advance: call dialNextLead() to place the call to the NEXT lead.
//      redial:  call dialNextLead() to re-place the call to the SAME lead
//               (current_index is rewound by one before the call, since
//               dialNextLead always starts from current_index + 1 — this
//               reuses the exact same dial/hold logic instead of duplicating it).
//      hangup:  teardown only (steps 1-3), no dial — used by Pause. The
//               session is left exactly as it would be after a lead hangs up
//               naturally: status 'dialing', both call ids null.
//      advance_nodial: teardown, then advance current_index to the next
//               dialable lead WITHOUT placing a call — used by preview mode.
//               The agent reviews the lead in the UI and clicks Dial, which
//               arrives here as mode 'redial'.
serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
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

  let body: { session_id?: unknown; mode?: unknown; expected_index?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!sessionId) return json({ error: "missing_session_id" }, 400);

  const mode: "advance" | "advance_nodial" | "redial" | "hangup" =
    body.mode === "redial" ? "redial"
    : body.mode === "hangup" ? "hangup"
    : body.mode === "advance_nodial" ? "advance_nodial"
    : "advance";
  const expectedIndex = typeof body.expected_index === "number" ? body.expected_index : null;

  const { data: session } = await sb.from("dialer_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("agent_id", user.id)
    .maybeSingle();

  if (!session) return json({ error: "not_found" }, 404);
  if (!["dialing", "connected"].includes(session.status)) {
    return json({ error: "session_not_active" }, 409);
  }

  // Idempotency guard: a stale/duplicate request targeting an index we've
  // already moved past (double-click, slow-network retry, cold-start retry)
  // is a harmless no-op rather than a second advance/hangup.
  if (expectedIndex !== null && session.current_index !== expectedIndex) {
    return json({ ok: true, noop: true, current_index: session.current_index });
  }

  const prevCallControlId = session.current_call_control_id as string | null;
  const prevCallRowId     = session.current_call_row_id as string | null;

  // Step 1: Pre-clear the active call from the session, and drop status back
  // to 'dialing' (matching what a natural lead-leg hangup already does in
  // telnyx-call-status). Without this, tearing down a *connected* call via
  // mode 'hangup' would leave status='connected' with no call ids — the
  // frontend's idle/re-dial detection only exists for status='dialing', so
  // the agent would be stuck looking at a stale "Connected" banner.
  if (prevCallControlId || prevCallRowId) {
    await sb.from("dialer_sessions").update({
      status:                  "dialing",
      current_call_control_id: null,
      current_call_row_id:     null,
    }).eq("id", sessionId);
  }

  // Steps 2 + 3 in parallel — billing close/settle (DB + RPC), the Telnyx
  // hangup, and stopping the agent-leg ringback are independent of each
  // other, and running them sequentially added a full round-trip of dead air
  // to every skip. Internal ordering that matters (closeCallRowById BEFORE
  // reportMinutesToWallet) is preserved inside the first branch.
  //
  // The ringback playback_stop is REQUIRED here (not just in the beep block
  // below): mode 'hangup' returns early and never reaches the beep block, so
  // without this a Pause during a ringing call left the infinite-loop
  // ringback playing on the agent's phone forever.
  const agentLegId = (session as DialerSession).agent_call_control_id;
  await Promise.all([
    (async () => {
      const closed = await closeCallRowById(sb, prevCallRowId);
      if (closed) {
        await reportMinutesToWallet(sb, closed.agentId, closed.durationSec, closed.id, closed.walletHoldId);
      }
    })(),
    (async () => {
      if (!prevCallControlId) return;
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
    })(),
    (async () => {
      if (!agentLegId) return;
      try {
        await fetch(`https://api.telnyx.com/v2/calls/${agentLegId}/actions/playback_stop`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${TELNYX_API_KEY}`,
            "Content-Type":  "application/json",
          },
          body: JSON.stringify({ command_id: crypto.randomUUID() }),
        });
      } catch { /* best effort */ }
    })(),
  ]);

  // mode: 'hangup' — teardown only, no dial. Used by Pause: the session is
  // left exactly as it would be after a lead hangs up naturally (status
  // 'dialing', both call ids null), so the frontend's existing "call ended"
  // idle UI applies without any special-casing.
  if (mode === "hangup") {
    return json({ ok: true });
  }

  // mode: 'advance_nodial' — preview mode's advance. Teardown is done (above);
  // move to the next dialable lead WITHOUT placing a call. The agent reviews
  // the lead and clicks Dial (mode 'redial') when ready.
  if (mode === "advance_nodial") {
    await advanceToNextLeadNoDial(sb, {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type":  "application/json",
    }, {
      ...(session as DialerSession),
      current_call_control_id: null,
      current_call_row_id:     null,
    });
    return json({ ok: true });
  }

  // Step 4: Place the next call — the SAME lead for 'redial' (current_index
  // rewound by one, since dialNextLead always starts from current_index + 1),
  // the NEXT lead for 'advance'. Pass the session with cleared call IDs so
  // dialNextLead won't try to close a row we already closed above.
  const webhookUrl = `${SUPABASE_URL}/functions/v1/telnyx-call-status`;
  const sessionForDial: DialerSession = {
    ...(session as DialerSession),
    current_call_control_id: null,
    current_call_row_id:     null,
    current_index:
      mode === "redial" ? (session.current_index as number) - 1 : (session.current_index as number),
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
      // Brief pause so the beep starts before the next call begins dialing.
      // Kept short: placing the next call takes its own ~1s+ before the far
      // end rings, which gives the beep plenty of room to finish — the old
      // 700ms here was pure added dead air on every skip.
      await new Promise((r) => setTimeout(r, 250));
    } catch { /* best effort */ }
  }

  await dialNextLead(sb, telnyxHeaders, TELNYX_CONN_ID, webhookUrl, sessionForDial);

  return json({ ok: true });
});
