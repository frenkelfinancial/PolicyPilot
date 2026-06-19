import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DialerSession,
  closeCallRowById,
  reportMinutesToStripe,
  speakAndHangup,
  dialNextLead,
} from "../_shared/dialer-next-lead.ts";

// Telnyx Call Control webhook — receives call lifecycle events for both
// the agent-bridge click-to-call flow and the Power Dialer flow.
//
// Agent-bridge flow (unchanged):
//   1. call.answered (role=agent) → place outbound call to lead
//   2. call.answered (role=lead)  → bridge agent leg + lead leg
//   3. call.hangup (either leg)   → mark calls row completed
//
// Power Dialer flow:
//   1. call.initiated (incoming, to=TELNYX_DIALER_NUMBER) → answer
//   2. call.answered (role=dialer_ivr)  → gather PIN via speech
//   3. call.gather.ended (role=dialer_ivr) → validate PIN, find pending
//      dialer_sessions row, create a conference from this leg, dial the
//      first lead (dialNextLead)
//   4. call.answered (role=dialer_lead) → join that leg into the conference
//   5. call.hangup for the current lead leg → close its calls row and
//      clear the active call from the session. The frontend drives
//      advancement — dialNextLead is ONLY called from telnyx-dialer-skip.
//   6. call.hangup for the agent leg → cancel the session, hang up the
//      current lead leg if any

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

// Compare US numbers tolerating +1 vs no leading 1.
function normalizeE164(num: string | undefined | null): string {
  if (!num) return "";
  return num.replace(/[^\d]/g, "").slice(-10);
}

serve(async (req) => {
  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY    = Deno.env.get("TELNYX_API_KEY")!;
  const TELNYX_CONN_ID    = Deno.env.get("TELNYX_CONNECTION_ID")!;
  const TELNYX_DIALER_NUM = Deno.env.get("TELNYX_DIALER_NUMBER");
  const STRIPE_KEY        = Deno.env.get("STRIPE_SECRET_KEY");

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
      const leadPhone  = ctx.lead_phone;
      const callerId   = ctx.caller_id;
      const callRowId  = ctx.call_row_id;
      const connId     = ctx.connection_id || TELNYX_CONN_ID;

      if (!leadPhone || !callerId) return new Response("ok");

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

      if (callRowId) {
        await sb.from("calls").update({ status: "ringing" }).eq("id", callRowId);
      }

    } else if (role === "lead") {
      const agentCallControlId = ctx.agent_call_control_id;
      const callRowId          = ctx.call_row_id;

      if (!agentCallControlId) return new Response("ok");

      await fetch(`https://api.telnyx.com/v2/calls/${agentCallControlId}/actions/bridge`, {
        method: "POST",
        headers: telnyxHeaders,
        body: JSON.stringify({
          call_control_id: callControlId,
          command_id:      crypto.randomUUID(),
        }),
      });

      if (callRowId) {
        await sb.from("calls").update({
          status:      "answered",
          answered_at: new Date().toISOString(),
        }).eq("id", callRowId);
      }

    } else if (role === "dialer_ivr") {
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
    }, STRIPE_KEY);

  } else if (eventType === "call.hangup") {
    const callRowId = ctx.call_row_id;

    // Close a call row found by filter — idempotent (won't double-close).
    const findAndClose = async (filter: Record<string, string>) => {
      const query = Object.entries(filter).reduce(
        (q, [k, v]) => q.eq(k, v),
        sb.from("calls").select("id, status, answered_at, agent_id")
      );
      const { data: row } = await query.maybeSingle();
      if (!row || row.status === "completed") return null;

      const now = new Date();
      const durationSec = row.answered_at
        ? Math.max(0, Math.floor((now.getTime() - new Date(row.answered_at).getTime()) / 1000))
        : 0;
      await sb.from("calls").update({
        status:       "completed",
        ended_at:     now.toISOString(),
        duration_sec: durationSec,
      }).eq("id", row.id);

      return { agentId: row.agent_id as string, durationSec };
    };

    let closed: { agentId: string; durationSec: number } | null = null;
    if (callRowId) {
      closed = await findAndClose({ id: callRowId });
    } else if (callControlId) {
      closed = await findAndClose({ sw_call_sid: callControlId });
    }

    if (closed && STRIPE_KEY) {
      await reportMinutesToStripe(sb, STRIPE_KEY, closed.agentId, closed.durationSec);
    }

    // Power Dialer: handle leg hangups.
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
          // Lead leg ended naturally (not triggered by telnyx-dialer-skip).
          // Clear the active call from the session but do NOT auto-advance —
          // the agent must click an outcome/skip button to move to the next lead.
          await sb.from("dialer_sessions").update({
            status:                  "dialing",
            current_call_control_id: null,
            current_call_row_id:     null,
          }).eq("id", dialerSession.id);

        } else if (callControlId === dialerSession.agent_call_control_id) {
          // Agent hung up their phone — cancel the session.
          await sb.from("dialer_sessions").update({
            status:   "cancelled",
            ended_at: new Date().toISOString(),
          }).eq("id", dialerSession.id);

          if (dialerSession.current_call_control_id) {
            const dialerClosed = await closeCallRowById(sb, dialerSession.current_call_row_id);
            if (dialerClosed && STRIPE_KEY) {
              await reportMinutesToStripe(sb, STRIPE_KEY, dialerClosed.agentId, dialerClosed.durationSec);
            }
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
