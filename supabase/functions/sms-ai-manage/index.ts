import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { cancelNudges, loadSettings, scheduleNextNudge } from "../_shared/sms-thread.ts";
import { normalizeSmsAiSettings } from "../_shared/sms-ai-core.ts";

// ============================================================
// sms-ai-manage — the agent's switches on a conversation.
//
// sms_conversations is SELECT-only for the browser (an AI that answers a
// consumer on your behalf is not something a page should be able to reconfigure
// with a PATCH), so the toggle needs a door. This is it: agent from the JWT, no
// agent id in the body, and every action re-scoped to the caller.
//
//   set_ai      turn the responder on or off for one thread
//   clear_hot   the agent has seen the alert; drop the badge
//
// Turning the AI back ON is the one action that also re-arms the follow-up
// schedule, because muting cancelled it. Without that, an agent who muted and
// then resumed would get a thread the AI answers but never follows up on, and
// nothing on screen would explain the difference.
// ============================================================

// deno-lint-ignore no-explicit-any
type Db = any;

Deno.serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);
  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { action?: unknown; conversation_id?: unknown; enabled?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const action = typeof body.action === "string" ? body.action : "";
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : "";
  if (!conversationId) return json({ error: "missing_conversation_id" }, 400);

  const sb: Db = createClient(SUPABASE_URL, SERVICE_KEY);

  // Re-scoped to the caller. The id came from their own screen, and a screen
  // is a convenience, not a boundary.
  const { data: conv } = await sb.from("sms_conversations")
    .select("id, agent_id, status, ai_muted, campaign_type, last_inbound_at, nudge_step")
    .eq("id", conversationId)
    .eq("agent_id", user.id)
    .maybeSingle();
  if (!conv) return json({ error: "not_found" }, 404);

  if (action === "clear_hot") {
    await sb.from("sms_conversations").update({ hot: false }).eq("id", conv.id);
    return json({ ok: true, hot: false });
  }

  if (action === "set_ai") {
    const on = body.enabled === true;

    if (!on) {
      await sb.from("sms_conversations").update({
        ai_muted: true, ai_muted_reason: "agent_toggle", ai_muted_at: new Date().toISOString(),
      }).eq("id", conv.id);
      const cancelled = await cancelNudges(sb, conv.id, "ai_muted");
      return json({ ok: true, ai_muted: true, nudges_cancelled: cancelled });
    }

    // A CLOSED conversation is closed because the consumer opted out. Turning
    // the AI back on must not quietly reopen it — that would be an agent
    // clicking a toggle and thereby un-hearing a STOP.
    if (conv.status === "closed") {
      return json({ error: "conversation_closed", detail: "This conversation was closed by an opt-out." }, 409);
    }

    await sb.from("sms_conversations").update({
      ai_muted: false, ai_muted_reason: null, ai_muted_at: null,
    }).eq("id", conv.id);

    const settings = await loadSettings(sb, user.id, conv.campaign_type, normalizeSmsAiSettings);
    const next = await scheduleNextNudge(sb, {
      conversationId: conv.id, agentId: user.id, settings,
      lastInboundAt: conv.last_inbound_at, afterStep: conv.nudge_step || 0,
    });
    return json({ ok: true, ai_muted: false, next_nudge: next });
  }

  return json({ error: "bad_action", detail: "action must be set_ai or clear_hot" }, 400);
});
