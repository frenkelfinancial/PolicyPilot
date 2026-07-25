import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { toE164 } from "../_shared/phone.ts";

// ai-dialer-test-reset — undo a Phase 1 DNC test for the CALLER'S OWN test
// lead so it can be dialed again. Two writes the browser can't make itself:
//   1. DELETE the agent-scoped suppression_list row for the test cell
//      (suppression_list has NO client insert/update/delete RLS policy — writes
//      are service-role only; see 20260725_ai_dialer_phase1.sql).
//   2. Clear leads.dnc / dnc_at on the caller's test lead (the client COULD do
//      this via leads_update_own RLS, but we do it here so a single call fully
//      resets the test — one round-trip, one gate).
//
// Blast radius is deliberately tiny: it only ever touches rows owned by the
// caller (agent_id = auth uid) whose lead client_id matches, and it NEVER
// deletes GLOBAL suppression rows (agent_id is null). Same auth+gate shape as
// ai-call-start: anon getUser -> gate -> service-role writes.
//
// Gate: caller must be an admin OR have BOTH AI-dialer kill switches on
// (agents.ai_dialer_enabled AND billing_config.ai_dialer_enabled) — i.e. the
// exact set of users who can see the in-app AI Dialer Test panel that calls it.
serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await sbAuth.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // ---- Gate: admin OR both kill switches on ------------------------------
  const [{ data: agent }, { data: billingConfig }] = await Promise.all([
    sb.from("agents").select("is_admin, ai_dialer_enabled").eq("id", user.id).maybeSingle(),
    sb.from("billing_config").select("ai_dialer_enabled").eq("id", 1).maybeSingle(),
  ]);
  const switchesOn = !!agent?.ai_dialer_enabled && !!billingConfig?.ai_dialer_enabled;
  if (!agent?.is_admin && !switchesOn) {
    return json({
      error: "forbidden",
      detail: "The AI Dialer test reset is only available while the AI dialer is enabled for your account.",
    }, 403);
  }

  let body: { client_id?: unknown; phone?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const clientId = (typeof body.client_id === "string" && body.client_id) || "ai-test-001";

  // Resolve the test lead (own row only). Phone comes from the lead's data blob,
  // or an explicit override in the body (fallback if the lead was deleted).
  const { data: lead } = await sb.from("leads")
    .select("id, data, dnc")
    .eq("agent_id", user.id)
    .eq("client_id", clientId)
    .maybeSingle();

  const leadPhone = (lead?.data as { phone?: string } | null)?.phone || "";
  const phoneE164 = toE164(typeof body.phone === "string" && body.phone ? body.phone : leadPhone);

  let clearedSuppression = 0;
  if (phoneE164) {
    // Agent-scoped only — never touch global (agent_id is null) suppression rows.
    const { data: deleted, error: delErr } = await sb.from("suppression_list")
      .delete()
      .eq("agent_id", user.id)
      .eq("phone_e164", phoneE164)
      .select("id");
    if (delErr) {
      console.warn("[ai-dialer-test-reset] suppression delete failed:", delErr.message);
      return json({ error: "reset_failed", detail: delErr.message }, 500);
    }
    clearedSuppression = deleted?.length ?? 0;
  }

  let leadReset = false;
  if (lead) {
    const { error: updErr } = await sb.from("leads")
      .update({ dnc: false, dnc_at: null })
      .eq("agent_id", user.id)
      .eq("client_id", clientId);
    if (updErr) {
      console.warn("[ai-dialer-test-reset] lead dnc clear failed:", updErr.message);
      return json({ error: "reset_failed", detail: updErr.message }, 500);
    }
    leadReset = true;
  }

  return json({
    ok: true,
    client_id: clientId,
    phone: phoneE164 || null,
    cleared_suppression: clearedSuppression,
    lead_reset: leadReset,
    lead_found: !!lead,
  });
});
