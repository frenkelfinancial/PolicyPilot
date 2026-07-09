import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://producerstackcrm.com",
  "https://localhost", // iOS/Android Capacitor (iosScheme/androidScheme: "https")
]);

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://producerstackcrm.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// Universal spend gate for the WebRTC softphone: the Telnyx Call Control
// webhook is never wired to this call path (see telnyx-report-call-minutes'
// header comment), so there is no server-side interception point once a
// call is placed directly via the browser SDK. This function is the
// closest available choke point — the client calls it immediately before
// EVERY dial (not just session start, which telnyx-webrtc-token already
// gates) and must abort if it's rejected.
//
// Places a wallet_hold for billing_config.min_call_start_mills, which
// _handleTelnyxNotification's hangup handler later resolves via
// telnyx-report-call-minutes -> wallet_settle_call (refunding the unused
// portion, or charging the extra — never charging for undelivered/
// unanswered calls beyond the held minimum).
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
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { call_row_id?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const callRowId = typeof body.call_row_id === "string" ? body.call_row_id : null;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: billingConfig } = await sb.from("billing_config")
    .select("min_call_start_mills")
    .eq("id", 1)
    .maybeSingle();
  const holdMills = billingConfig?.min_call_start_mills ?? 30;

  const { data: holdLedgerId, error: holdErr } = await sb.rpc("wallet_hold", {
    p_agent:        user.id,
    p_category:     "call",
    p_units:        null,
    p_amount_mills: holdMills,
    p_ref_type:     "call",
    p_ref_id:       callRowId,
    p_desc:         `Call start hold — $${(holdMills / 1000).toFixed(2)} reserved`,
  });

  if (holdErr) {
    if (holdErr.message?.includes("insufficient_balance")) {
      return json({ error: "insufficient_balance", detail: "Insufficient wallet balance — top up to continue." }, 402);
    }
    return json({ error: "hold_failed", detail: holdErr.message }, 500);
  }

  return json({ ok: true, hold_id: holdLedgerId, hold_mills: holdMills });
});
