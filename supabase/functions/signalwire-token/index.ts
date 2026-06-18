// ============================================================
// ⚠️ DEPRECATED (2026-05-17) — superseded by signalwire-bridge.
//
// This function was the browser-SDK path (Phases A+B) that
// minted Call Fabric Subscriber Tokens. The browser SDK route
// could not be made to dial PSTN out of our ProducerStack space
// without an SWML routing resource, so we pivoted to a REST
// agent-bridge flow (Phase D). See:
//   - docs/superpowers/specs/2026-05-17-signalwire-agent-bridge-design.md
//   - supabase/functions/signalwire-bridge/index.ts
//
// Left deployed but unused for ~2 weeks of operational soak on
// the new path, then delete. Frontend no longer invokes it.
// ============================================================
// supabase/functions/signalwire-token/index.ts
//
// Mints a short-lived (1 hour) SignalWire browser JWT for the
// calling agent. The PolicyPilot dashboard's softphone widget
// calls this before every dial — the browser never sees the
// SignalWire API token.
//
// Quota: each agent has a monthly minute cap stored on
// public.agents.monthly_minute_limit (default 500). This function
// sums duration_sec from public.calls in the current calendar
// month and returns 429 when the agent is at/over the cap.
//
// Required secrets (set via `supabase secrets set` or dashboard):
//   - SIGNALWIRE_SPACE_URL    e.g. producerstack.signalwire.com  (no scheme)
//   - SIGNALWIRE_PROJECT_ID   UUID from SignalWire dashboard
//   - SIGNALWIRE_API_TOKEN    Secret API token (NEVER expose to browser)
//
// SUPABASE_URL and SUPABASE_ANON_KEY are injected by the runtime.
//
// Auth: Edge Function platform verifies the caller's JWT (verify_jwt
// = true by default). Anonymous calls return 401 before our code
// executes — we re-decode here only to look up the agent's
// caller-ID + subscriber + minute usage.
//
// Request (POST, JSON body — empty {} is fine):
//   {}
//
// Response (200):
//   { ok: true, token: '<jwt>', callerId: '+1...', subscriberId: '...',
//     minutesUsed: 87, minutesCap: 500, expiresAt: '2026-05-14T...' }
// Response (409): { ok: false, error: 'not_assigned' }   — no caller-ID/subscriber on this agent
// Response (429): { ok: false, error: 'minute_cap_exceeded', minutesUsed, minutesCap }
// Response (502): { ok: false, error: 'signalwire_unreachable' }
// Response (5xx): { ok: false, error: string }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const spaceUrl  = Deno.env.get("SIGNALWIRE_SPACE_URL")  ?? "";
  const projectId = Deno.env.get("SIGNALWIRE_PROJECT_ID") ?? "";
  const apiToken  = Deno.env.get("SIGNALWIRE_API_TOKEN")  ?? "";
  if (!spaceUrl || !projectId || !apiToken) {
    console.error("[signalwire-token] missing SignalWire secrets on server");
    return json({ ok: false, error: "SignalWire not configured on server" }, 500);
  }

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let userId: string;
  try {
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user?.id) {
      return json({ ok: false, error: "unauthenticated" }, 401);
    }
    userId = data.user.id;
  } catch {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }

  // ---- Fetch this agent's caller-ID + subscriber + minute cap --------
  let callerId = "";
  let subscriberId = "";
  let minutesCap = 500;
  try {
    const { data: agent, error } = await userClient
      .from("agents")
      .select("signalwire_caller_id, signalwire_subscriber_id, monthly_minute_limit")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    callerId     = (agent?.signalwire_caller_id     as string) || "";
    subscriberId = (agent?.signalwire_subscriber_id as string) || "";
    if (typeof agent?.monthly_minute_limit === "number") {
      minutesCap = agent.monthly_minute_limit;
    }
  } catch (e) {
    console.error(`[signalwire-token] agent lookup failed for ${userId}:`, (e as Error)?.message);
    return json({ ok: false, error: "Couldn't load your calling settings. Please retry." }, 503);
  }

  if (!callerId || !subscriberId) {
    // Admin needs to assign this agent a caller-ID + subscriber in the
    // Settings → Calling tab (or via direct SQL) before they can dial.
    return json({ ok: false, error: "not_assigned" }, 409);
  }

  // ---- Sum this month's minutes used --------------------------------
  // calendar-month window: started_at >= date_trunc('month', now())
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString();

  let secondsUsed = 0;
  try {
    const { data: rows, error } = await userClient
      .from("calls")
      .select("duration_sec")
      .eq("agent_id", userId)
      .gte("started_at", monthStartIso);
    if (error) throw error;
    secondsUsed = (rows || []).reduce((s: number, r: { duration_sec: number | null }) => s + (r.duration_sec || 0), 0);
  } catch (e) {
    console.error(`[signalwire-token] minute count failed for ${userId}:`, (e as Error)?.message);
    return json({ ok: false, error: "Couldn't verify your minute allowance. Please retry." }, 503);
  }
  const minutesUsed = Math.floor(secondsUsed / 60);

  if (minutesUsed >= minutesCap) {
    console.log(`[signalwire-token] minute_cap_exceeded agent=${userId} used=${minutesUsed} cap=${minutesCap}`);
    return json({
      ok: false,
      error: "minute_cap_exceeded",
      minutesUsed,
      minutesCap,
    }, 429);
  }

  // ---- Mint Subscriber Token via SignalWire REST --------------------
  // Call Fabric Browser SDK (@signalwire/js v3) requires a "Subscriber
  // Access Token" minted by /api/fabric/subscribers/tokens — NOT the
  // older Relay /api/relay/rest/jwt endpoint, which mints tokens for
  // the legacy Relay SDK only. Using the wrong endpoint returns a
  // valid-looking token that the browser SDK then fails to use with
  // "Authentication service failed with status 401 Unauthorized"
  // when it opens its WebSocket.
  //
  // Body fields (per SignalWire docs):
  //   reference   required — any string that identifies this subscriber
  //               (commonly an email). Auto-created if it doesn't exist.
  //   expire_at   optional — unix-seconds expiry (defaults to 2h).
  //
  // Response shape: { subscriber_id, token, refresh_token }
  const space = spaceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const swEndpoint = `https://${space}/api/fabric/subscribers/tokens`;
  const swAuth = "Basic " + btoa(`${projectId}:${apiToken}`);

  const start = Date.now();
  let swRes: Response;
  try {
    swRes = await fetch(swEndpoint, {
      method: "POST",
      headers: {
        "Authorization": swAuth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reference: subscriberId,
        expire_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error(`[signalwire-token] network error: ${msg}`);
    return json({ ok: false, error: "signalwire_unreachable" }, 502);
  }
  const ms = Date.now() - start;

  const text = await swRes.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!swRes.ok) {
    console.error(`[signalwire-token] upstream ${swRes.status} ms=${ms}:`, data);
    return json({
      ok: false,
      error: typeof data?.error === "string" ? data.error : `SignalWire error ${swRes.status}`,
    }, 502);
  }

  const token = data?.token || "";
  if (!token) {
    console.error(`[signalwire-token] empty token in response:`, data);
    return json({ ok: false, error: "SignalWire returned no token" }, 502);
  }

  console.log(`[signalwire-token] minted agent=${userId} used=${minutesUsed}/${minutesCap}min ms=${ms}`);

  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  return json({
    ok: true,
    token,
    callerId,
    subscriberId,
    minutesUsed,
    minutesCap,
    expiresAt,
  });
});
