import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Telnyx Call Control webhook — receives call lifecycle events for both
// the agent-bridge click-to-call flow and the Power Dialer flow.
//
// Agent-bridge flow (unchanged):
//   1. call.answered (role=agent) → place outbound call to lead
//   2. call.answered (role=lead)  → bridge agent leg + lead leg
//   3. call.hangup (either leg)   → mark calls row completed
//
// Power Dialer flow (new):
//   1. call.initiated (incoming, to=TELNYX_DIALER_NUMBER) → answer
//   2. call.answered (role=dialer_ivr)  → gather PIN via speech
//   3. call.gather.ended (role=dialer_ivr) → validate PIN, find pending
//      dialer_sessions row, create a conference from this leg, dial the
//      first lead (dialNextLead)
//   4. call.answered (role=dialer_lead) → join that leg into the conference
//   5. call.hangup for the current lead leg → close its calls row, then
//      dialNextLead() again (auto-advance to the next lead)
//   6. call.hangup for the agent leg → cancel the session, hang up the
//      current lead leg if any
//
// client_state (base64 JSON) is threaded through each Telnyx call so this
// function always knows which leg it's handling without DB lookups, except
// for the dialer's agent leg (an inbound call we don't originate), which is
// identified by matching call_control_id against dialer_sessions rows.

type CallStatusPayload = {
  call_control_id?: string;
  call_leg_id?: string;
  client_state?: string;
  direction?: string;
  to?: string;
  from?: string;
  digits?: string;
  status?: string;
};

type DialerSession = {
  id: string;
  agent_id: string;
  lead_ids: string[];
  current_index: number;
  status: string;
  conference_id: string | null;
  agent_call_control_id: string | null;
  current_call_control_id: string | null;
  current_call_row_id: string | null;
};

// Compare US numbers tolerating +1 vs no leading 1.
function normalizeE164(num: string | undefined | null): string {
  if (!num) return "";
  return num.replace(/[^\d]/g, "").slice(-10);
}

async function closeCallRowById(
  sb: ReturnType<typeof createClient>,
  callRowId: string | null | undefined,
) {
  if (!callRowId) return;
  const { data: row } = await sb.from("calls")
    .select("id, status, answered_at")
    .eq("id", callRowId)
    .maybeSingle();
  if (!row || row.status === "completed") return;

  const now = new Date();
  const durationSec = row.answered_at
    ? Math.max(0, Math.floor((now.getTime() - new Date(row.answered_at).getTime()) / 1000))
    : 0;
  await sb.from("calls").update({
    status:       "completed",
    ended_at:     now.toISOString(),
    duration_sec: durationSec,
  }).eq("id", row.id);
}

// Speak a message to a call leg, then hang it up. Used for IVR errors and
// the "end of list" goodbye on the agent's leg.
async function speakAndHangup(
  telnyxHeaders: Record<string, string>,
  callControlId: string,
  message: string,
) {
  try {
    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
      method: "POST",
      headers: telnyxHeaders,
      body: JSON.stringify({
        payload:    message,
        voice:      "female",
        language:   "en-US",
        command_id: crypto.randomUUID(),
      }),
    });
  } catch { /* best effort */ }

  // Give the message time to play before hanging up.
  await new Promise((resolve) => setTimeout(resolve, 4000));

  try {
    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, {
      method: "POST",
      headers: telnyxHeaders,
      body: JSON.stringify({ command_id: crypto.randomUUID() }),
    });
  } catch { /* best effort */ }
}

// Dial the next lead in session.lead_ids, joining it to the existing
// conference once answered. Skips leads with no phone on file. Marks the
// session 'completed' (and says goodbye to the agent) once the list is
// exhausted.
async function dialNextLead(
  sb: ReturnType<typeof createClient>,
  telnyxHeaders: Record<string, string>,
  TELNYX_CONN_ID: string,
  webhookUrl: string,
  session: DialerSession,
) {
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", session.agent_id)
    .maybeSingle();
  const callerIdE164: string = agent?.signalwire_caller_id || "";

  let nextIndex = session.current_index;

  while (true) {
    nextIndex += 1;

    if (nextIndex >= session.lead_ids.length) {
      await sb.from("dialer_sessions").update({
        status:       "completed",
        current_index: nextIndex,
        ended_at:     new Date().toISOString(),
      }).eq("id", session.id);

      if (session.agent_call_control_id) {
        await speakAndHangup(
          telnyxHeaders,
          session.agent_call_control_id,
          "You've reached the end of your dialing list. Goodbye.",
        );
      }
      return;
    }

    if (!callerIdE164) {
      // No caller-ID to dial from — nothing more we can do.
      await sb.from("dialer_sessions").update({ current_index: nextIndex }).eq("id", session.id);
      continue;
    }

    const clientId = session.lead_ids[nextIndex];
    const { data: leadRow } = await sb.from("leads")
      .select("id, data")
      .eq("agent_id", session.agent_id)
      .eq("client_id", clientId)
      .maybeSingle();

    const leadPhone: string = (leadRow?.data as { phone?: string } | undefined)?.phone || "";
    if (!leadPhone) {
      // Skip leads with no phone number on file.
      await sb.from("dialer_sessions").update({ current_index: nextIndex }).eq("id", session.id);
      continue;
    }

    const leadClientState = btoa(JSON.stringify({
      role:          "dialer_lead",
      session_id:    session.id,
      conference_id: session.conference_id,
      lead_index:    nextIndex,
    }));

    const callRes = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: telnyxHeaders,
      body: JSON.stringify({
        connection_id:      TELNYX_CONN_ID,
        to:                 leadPhone,
        from:               callerIdE164,
        client_state:       leadClientState,
        webhook_url:        webhookUrl,
        webhook_url_method: "POST",
      }),
    });

    if (!callRes.ok) {
      // Couldn't place this call — skip to the next lead.
      await sb.from("dialer_sessions").update({ current_index: nextIndex }).eq("id", session.id);
      continue;
    }

    const callData = await callRes.json();
    const leadCallControlId: string = callData?.data?.call_control_id || "";
    if (!leadCallControlId) {
      await sb.from("dialer_sessions").update({ current_index: nextIndex }).eq("id", session.id);
      continue;
    }

    const { data: callRow } = await sb.from("calls").insert({
      agent_id:    session.agent_id,
      lead_id:     leadRow?.id || null,
      direction:   "outbound",
      phone_from:  callerIdE164,
      phone_to:    leadPhone,
      started_at:  new Date().toISOString(),
      status:      "initiated",
      sw_call_sid: leadCallControlId,
    }).select("id").single();

    await sb.from("dialer_sessions").update({
      current_index:           nextIndex,
      status:                  "dialing",
      current_call_control_id: leadCallControlId,
      current_call_row_id:     callRow?.id || null,
    }).eq("id", session.id);

    return;
  }
}

serve(async (req) => {
  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY    = Deno.env.get("TELNYX_API_KEY")!;
  const TELNYX_CONN_ID    = Deno.env.get("TELNYX_CONNECTION_ID")!;
  const TELNYX_DIALER_NUM = Deno.env.get("TELNYX_DIALER_NUMBER");

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const telnyxHeaders = {
    "Authorization": `Bearer ${TELNYX_API_KEY}`,
    "Content-Type":  "application/json",
  };
  const webhookUrl = `${SUPABASE_URL}/functions/v1/telnyx-call-status`;

  let payload: { data?: { event_type?: string; payload?: CallStatusPayload } };
  try { payload = await req.json(); } catch { return new Response("ok"); }

  const eventType = payload?.data?.event_type;
  const p         = payload?.data?.payload;
  if (!p || !eventType) return new Response("ok");

  const callControlId = p.call_control_id || "";

  // Decode the client_state that was set when the call was placed/answered
  let ctx: Record<string, string> = {};
  try {
    if (p.client_state) ctx = JSON.parse(atob(p.client_state));
  } catch { /* ignore malformed state */ }

  // ---- Power Dialer: agent calling into the host number ------------------
  if (eventType === "call.initiated") {
    if (
      p.direction === "incoming" &&
      TELNYX_DIALER_NUM &&
      normalizeE164(p.to) === normalizeE164(TELNYX_DIALER_NUM)
    ) {
      await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`, {
        method: "POST",
        headers: telnyxHeaders,
        body: JSON.stringify({
          command_id:   crypto.randomUUID(),
          client_state: btoa(JSON.stringify({ role: "dialer_ivr" })),
        }),
      });
    }
    return new Response("ok");
  }

  if (eventType === "call.answered") {
    const role = ctx.role;

    if (role === "agent") {
      // Agent picked up — now place the outbound call to the lead
      const leadPhone  = ctx.lead_phone;
      const callerId   = ctx.caller_id;
      const callRowId  = ctx.call_row_id;
      const connId     = ctx.connection_id || TELNYX_CONN_ID;

      if (!leadPhone || !callerId) return new Response("ok");

      // client_state for the lead leg identifies it as role=lead and carries the agent's call_control_id
      const leadClientState = btoa(JSON.stringify({
        role:                   "lead",
        agent_call_control_id:  callControlId,
        call_row_id:            callRowId,
        connection_id:          connId,
      }));

      await fetch("https://api.telnyx.com/v2/calls", {
        method: "POST",
        headers: telnyxHeaders,
        body: JSON.stringify({
          connection_id:      connId,
          to:                 leadPhone,
          from:               callerId,
          client_state:       leadClientState,
          webhook_url:        webhookUrl,
          webhook_url_method: "POST",
        }),
      });

      // Update DB: agent answered, now ringing the lead
      if (callRowId) {
        await sb.from("calls").update({ status: "ringing" }).eq("id", callRowId);
      }

    } else if (role === "lead") {
      // Lead picked up — bridge the agent leg and lead leg together
      const agentCallControlId = ctx.agent_call_control_id;
      const callRowId          = ctx.call_row_id;

      if (!agentCallControlId) return new Response("ok");

      await fetch(`https://api.telnyx.com/v2/calls/${agentCallControlId}/actions/bridge`, {
        method: "POST",
        headers: telnyxHeaders,
        body: JSON.stringify({
          call_control_id: callControlId,  // lead's call_control_id
          command_id:      crypto.randomUUID(),
        }),
      });

      // Update DB: both legs connected
      if (callRowId) {
        await sb.from("calls").update({
          status:      "answered",
          answered_at: new Date().toISOString(),
        }).eq("id", callRowId);
      }

    } else if (role === "dialer_ivr") {
      // Agent's inbound call to the dialer host number was answered —
      // prompt for their PIN.
      await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/gather_using_speak`, {
        method: "POST",
        headers: telnyxHeaders,
        body: JSON.stringify({
          payload:            "Welcome to your power dialer. Enter your 4 digit pin, then press pound.",
          voice:              "female",
          language:           "en-US",
          minimum_digits:     4,
          maximum_digits:     4,
          terminating_digit:  "#",
          client_state:       btoa(JSON.stringify({ role: "dialer_ivr" })),
          command_id:         crypto.randomUUID(),
        }),
      });

    } else if (role === "dialer_lead") {
      // A dialed lead picked up — join them into the agent's conference.
      const conferenceId = ctx.conference_id;
      const sessionId    = ctx.session_id;

      if (conferenceId) {
        await fetch(`https://api.telnyx.com/v2/conferences/${conferenceId}/actions/join`, {
          method: "POST",
          headers: telnyxHeaders,
          body: JSON.stringify({ call_control_id: callControlId, command_id: crypto.randomUUID() }),
        });
      }

      if (sessionId) {
        const { data: session } = await sb.from("dialer_sessions")
          .select("current_call_row_id")
          .eq("id", sessionId)
          .maybeSingle();

        await sb.from("dialer_sessions").update({
          status:                  "connected",
          current_call_control_id: callControlId,
        }).eq("id", sessionId);

        if (session?.current_call_row_id) {
          await sb.from("calls").update({
            status:      "answered",
            answered_at: new Date().toISOString(),
          }).eq("id", session.current_call_row_id);
        }
      }
    }

  } else if (eventType === "call.gather.ended") {
    if (ctx.role !== "dialer_ivr") return new Response("ok");

    const digits = p.digits || "";
    const { data: matchedAgent } = await sb.from("agents")
      .select("id")
      .eq("dialer_pin", digits)
      .maybeSingle();

    if (!matchedAgent) {
      await speakAndHangup(telnyxHeaders, callControlId, "Sorry, that pin was not recognized. Goodbye.");
      return new Response("ok");
    }

    const { data: session } = await sb.from("dialer_sessions")
      .select("*")
      .eq("agent_id", matchedAgent.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session) {
      await speakAndHangup(
        telnyxHeaders,
        callControlId,
        "No active dialing session was found. Start one from the app, then call back. Goodbye.",
      );
      return new Response("ok");
    }

    // Turn the agent's leg into a conference so leads can be joined/removed
    // one at a time without disturbing the agent's call.
    const confRes = await fetch("https://api.telnyx.com/v2/conferences", {
      method: "POST",
      headers: telnyxHeaders,
      body: JSON.stringify({
        call_control_id: callControlId,
        name:            `dialer-${session.id}`,
        command_id:      crypto.randomUUID(),
      }),
    });

    const conferenceId: string = confRes.ok ? ((await confRes.json())?.data?.id || "") : "";

    if (!conferenceId) {
      await speakAndHangup(telnyxHeaders, callControlId, "Sorry, something went wrong starting your session. Goodbye.");
      await sb.from("dialer_sessions").update({ status: "cancelled", ended_at: new Date().toISOString() }).eq("id", session.id);
      return new Response("ok");
    }

    await sb.from("dialer_sessions").update({
      status:                 "dialing",
      agent_call_control_id:  callControlId,
      conference_id:          conferenceId,
      started_at:             new Date().toISOString(),
    }).eq("id", session.id);

    await dialNextLead(sb, telnyxHeaders, TELNYX_CONN_ID, webhookUrl, {
      ...(session as DialerSession),
      conference_id:          conferenceId,
      agent_call_control_id:  callControlId,
    });

  } else if (eventType === "call.hangup") {
    const callRowId = ctx.call_row_id;

    const findAndClose = async (filter: Record<string, string>) => {
      const query = Object.entries(filter).reduce(
        (q, [k, v]) => q.eq(k, v),
        sb.from("calls").select("id, status, answered_at")
      );
      const { data: row } = await query.maybeSingle();
      if (!row || row.status === "completed") return;

      const now = new Date();
      const durationSec = row.answered_at
        ? Math.max(0, Math.floor((now.getTime() - new Date(row.answered_at).getTime()) / 1000))
        : 0;
      await sb.from("calls").update({
        status:       "completed",
        ended_at:     now.toISOString(),
        duration_sec: durationSec,
      }).eq("id", row.id);
    };

    if (callRowId) {
      await findAndClose({ id: callRowId });
    } else if (callControlId) {
      await findAndClose({ sw_call_sid: callControlId });
    }

    // Power Dialer: advance to the next lead, or end the session, when a
    // dialer-controlled leg hangs up. Identified by call_control_id since
    // the agent's inbound leg has no call_row_id in its client_state.
    // Two separate .eq() lookups (rather than .or()) avoid PostgREST
    // filter-string escaping issues with the colons in Telnyx call_control_ids.
    if (callControlId) {
      let dialerSession: DialerSession | null = null;
      const { data: byLeadLeg } = await sb.from("dialer_sessions")
        .select("*")
        .eq("current_call_control_id", callControlId)
        .in("status", ["dialing", "connected"])
        .maybeSingle();
      if (byLeadLeg) {
        dialerSession = byLeadLeg as DialerSession;
      } else {
        const { data: byAgentLeg } = await sb.from("dialer_sessions")
          .select("*")
          .eq("agent_call_control_id", callControlId)
          .in("status", ["dialing", "connected"])
          .maybeSingle();
        if (byAgentLeg) dialerSession = byAgentLeg as DialerSession;
      }

      if (dialerSession) {
        if (callControlId === dialerSession.current_call_control_id) {
          await closeCallRowById(sb, dialerSession.current_call_row_id);
          await dialNextLead(sb, telnyxHeaders, TELNYX_CONN_ID, webhookUrl, dialerSession as DialerSession);
        } else if (callControlId === dialerSession.agent_call_control_id) {
          await sb.from("dialer_sessions").update({
            status:   "cancelled",
            ended_at: new Date().toISOString(),
          }).eq("id", dialerSession.id);

          if (dialerSession.current_call_control_id) {
            await closeCallRowById(sb, dialerSession.current_call_row_id);
            try {
              await fetch(`https://api.telnyx.com/v2/calls/${dialerSession.current_call_control_id}/actions/hangup`, {
                method: "POST",
                headers: telnyxHeaders,
                body: JSON.stringify({ command_id: crypto.randomUUID() }),
              });
            } catch { /* best effort */ }
          }
        }
      }
    }
  }

  return new Response("ok");
});
