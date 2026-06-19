import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type DialerSession = {
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

export function toE164(raw: string | undefined | null): string {
  if (!raw) return "";
  const d = String(raw).replace(/[^\d]/g, "");
  if (!d) return "";
  if (String(raw).trim().startsWith("+")) return "+" + d;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  return "";
}

export async function reportMinutesToStripe(
  sb: ReturnType<typeof createClient>,
  stripeKey: string,
  agentId: string,
  durationSec: number,
) {
  if (!agentId || durationSec <= 0) return;
  try {
    const [agentRes, configRes] = await Promise.all([
      sb.from("agents")
        .select("stripe_subscription_id, stripe_customer_id, stripe_minutes_item_id")
        .eq("id", agentId)
        .maybeSingle(),
      sb.from("billing_config")
        .select("stripe_minutes_price_id")
        .eq("id", 1)
        .maybeSingle(),
    ]);

    const agent  = agentRes.data;
    const config = configRes.data;

    if (!agent?.stripe_subscription_id || !agent?.stripe_customer_id) return;
    if (!config?.stripe_minutes_price_id) return;

    const stripeHdrs = {
      "Authorization": `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    if (!agent.stripe_minutes_item_id) {
      const addParams = new URLSearchParams({
        "subscription": agent.stripe_subscription_id,
        "price":        config.stripe_minutes_price_id,
      });
      const addRes = await fetch("https://api.stripe.com/v1/subscription_items", {
        method: "POST",
        headers: stripeHdrs,
        body: addParams,
      });
      if (!addRes.ok) {
        console.warn("[dialer] Stripe add minutes item failed:", await addRes.text());
        return;
      }
      const newItem = await addRes.json();
      await sb.from("agents")
        .update({ stripe_minutes_item_id: newItem.id })
        .eq("id", agentId);
    }

    const minutes = Math.max(1, Math.ceil(durationSec / 60));
    const eventParams = new URLSearchParams({
      "event_name":                  "call_minutes",
      "payload[stripe_customer_id]": agent.stripe_customer_id,
      "payload[value]":              String(minutes),
      "timestamp":                   String(Math.floor(Date.now() / 1000)),
    });
    const eventRes = await fetch("https://api.stripe.com/v1/billing/meter_events", {
      method: "POST",
      headers: stripeHdrs,
      body: eventParams,
    });
    if (!eventRes.ok) {
      console.warn("[dialer] Stripe meter event failed:", await eventRes.text());
    }
  } catch (e) {
    console.error("[dialer] Stripe minutes report error:", e);
  }
}

export async function closeCallRowById(
  sb: ReturnType<typeof createClient>,
  callRowId: string | null | undefined,
): Promise<{ agentId: string; durationSec: number } | null> {
  if (!callRowId) return null;
  const { data: row } = await sb.from("calls")
    .select("id, status, answered_at, agent_id")
    .eq("id", callRowId)
    .maybeSingle();
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
}

export async function speakAndHangup(
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
//
// NOTE: session.current_call_row_id should be null when called from
// telnyx-dialer-skip (the caller closes the row itself before calling this).
// When called from telnyx-call-status for completeness we leave the behavior
// as-is so dialNextLead is the single source of row close logic.
export async function dialNextLead(
  sb: ReturnType<typeof createClient>,
  telnyxHeaders: Record<string, string>,
  TELNYX_CONN_ID: string,
  webhookUrl: string,
  session: DialerSession,
  stripeKey: string | undefined,
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
        status:        "completed",
        current_index: nextIndex,
        ended_at:      new Date().toISOString(),
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
      await sb.from("dialer_sessions").update({ current_index: nextIndex }).eq("id", session.id);
      continue;
    }

    const clientId = session.lead_ids[nextIndex];
    const { data: leadRow } = await sb.from("leads")
      .select("id, data")
      .eq("agent_id", session.agent_id)
      .eq("client_id", clientId)
      .maybeSingle();

    const rawPhone: string = (leadRow?.data as { phone?: string } | undefined)?.phone || "";
    const leadPhone: string = toE164(rawPhone) || rawPhone;
    if (!leadPhone) {
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
      await sb.from("dialer_sessions").update({ current_index: nextIndex }).eq("id", session.id);
      continue;
    }

    const callData = await callRes.json();
    const leadCallControlId: string = callData?.data?.call_control_id || "";
    if (!leadCallControlId) {
      await sb.from("dialer_sessions").update({ current_index: nextIndex }).eq("id", session.id);
      continue;
    }

    // Close the previous lead call row (no-op when called from telnyx-dialer-skip
    // since it already closed the row and passed current_call_row_id = null).
    const closed = await closeCallRowById(sb, session.current_call_row_id);
    if (closed && stripeKey) {
      await reportMinutesToStripe(sb, stripeKey, closed.agentId, closed.durationSec);
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
