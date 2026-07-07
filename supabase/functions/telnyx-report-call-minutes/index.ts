import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { closeCallRowById, reportMinutesToStripe } from "../_shared/dialer-next-lead.ts";

const ALLOWED_ORIGINS = new Set([
  "https://producerstackcrm.com",
  "https://localhost", // iOS/Android app (Capacitor, iosScheme/androidScheme: "https")
]);

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://producerstackcrm.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// Closes out a `calls` row from the WebRTC softphone (app.html's
// _webrtcDial/_handleTelnyxNotification) and reports the elapsed minutes
// to Stripe's metered billing, at $0.02/min (billing_config.minute_rate_cents).
//
// This is the WebRTC-flow counterpart to the billing that already happens
// for the Power Dialer via telnyx-call-status's call.hangup handler and
// telnyx-dialer-skip — the softphone has no Telnyx Call Control webhook
// wired to it, so nothing server-side ever closed its calls rows or
// reported usage to Stripe until this endpoint existed.
//
// closeCallRowById is idempotent (no-ops once status is already
// 'completed'), so it's safe to call even if the client fires this more
// than once for the same call.
serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
  const STRIPE_KEY   = Deno.env.get("STRIPE_SECRET_KEY");

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { call_row_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const callRowId = typeof body.call_row_id === "string" ? body.call_row_id : "";
  if (!callRowId) return json({ error: "missing_call_row_id" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Confirm the row belongs to the caller before touching it — closeCallRowById
  // itself doesn't scope by agent, so that check has to happen here.
  const { data: row } = await sb.from("calls")
    .select("id, agent_id")
    .eq("id", callRowId)
    .maybeSingle();
  if (!row || row.agent_id !== user.id) return json({ error: "not_found" }, 404);

  const closed = await closeCallRowById(sb, callRowId);
  if (closed && STRIPE_KEY) {
    await reportMinutesToStripe(sb, STRIPE_KEY, closed.agentId, closed.durationSec);
  }

  return json({ ok: true, billed: !!closed });
});
