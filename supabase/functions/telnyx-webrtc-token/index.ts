import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SIP_USERNAME       = Deno.env.get("TELNYX_SIP_USERNAME");
  const SIP_PASSWORD       = Deno.env.get("TELNYX_SIP_PASSWORD");
  const FALLBACK_CALLER_ID = Deno.env.get("TELNYX_BROWSER_CALLER_ID") || "";

  if (!SIP_USERNAME || !SIP_PASSWORD) {
    return json({
      error: "sip_not_configured",
      detail: "TELNYX_SIP_USERNAME or TELNYX_SIP_PASSWORD secret is missing.",
    }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  // Each agent must dial out from their own Telnyx number (bought in the
  // Phone Book tab, mirrored onto agents.signalwire_caller_id whenever
  // their primary number changes) — Telnyx rejects outbound calls whose
  // caller ID isn't a number actually provisioned on the account. Using
  // one shared TELNYX_BROWSER_CALLER_ID for every agent meant browser
  // calls went out under a caller ID that likely didn't belong to
  // whichever agent placed the call, causing an instant CALL_REJECTED
  // before the callee's phone ever rang.
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: agent } = await sb.from("agents")
    .select("signalwire_caller_id")
    .eq("id", user.id)
    .maybeSingle();

  const callerId = agent?.signalwire_caller_id || FALLBACK_CALLER_ID;
  if (!callerId) {
    return json({
      error: "no_caller_id",
      detail: "No phone number is assigned to this agent yet. Buy or assign one in the Phone Book tab.",
    }, 400);
  }

  // Universal spend gate: a wallet under the configured minimum can't even
  // establish a softphone session. This only covers session start — each
  // individual dial within an already-connected session is separately
  // gated by wallet-hold-call (see _webrtcDial in app.html).
  const [{ data: wallet }, { data: billingConfig }] = await Promise.all([
    sb.from("wallet_accounts").select("balance_mills").eq("agent_id", user.id).maybeSingle(),
    sb.from("billing_config").select("min_call_start_mills").eq("id", 1).maybeSingle(),
  ]);
  const minStartMills = billingConfig?.min_call_start_mills ?? 30;
  const balanceMills  = wallet?.balance_mills ?? 0;
  if (balanceMills < minStartMills) {
    return json({
      error:  "insufficient_balance",
      detail: "Insufficient wallet balance — top up to continue.",
    }, 402);
  }

  return json({
    ok:           true,
    sip_username: SIP_USERNAME,
    sip_password: SIP_PASSWORD,
    caller_id:    callerId,
  });
});
