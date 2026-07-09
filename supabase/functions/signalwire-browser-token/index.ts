// ============================================================
// supabase/functions/signalwire-browser-token/index.ts
//
// Mints a short-lived SignalWire Call Fabric Subscriber Token
// for the currently logged-in agent. The browser uses this token
// to initialize @signalwire/js and make outbound PSTN calls
// from the computer's mic/speakers.
//
// Unlike signalwire-token (which looked up agents table columns),
// this function uses the authenticated user's email as the subscriber
// reference — no additional DB setup required.
//
// Required Supabase secrets (set via dashboard or `supabase secrets set`):
//   SIGNALWIRE_SPACE_URL   — e.g. producerstack.signalwire.com  (no scheme)
//   SIGNALWIRE_PROJECT_ID  — UUID from SignalWire dashboard
//   SIGNALWIRE_API_TOKEN   — API token (NEVER expose to browser)
//   SIGNALWIRE_CALLER_ID   — purchased number in E.164, e.g. +15551234567
//
// SignalWire space setup (one-time, in SignalWire dashboard):
//   The space must allow outbound PSTN calls from subscribers, OR
//   you must configure an SWML routing resource. See the
//   signalwire-swml-outbound function for the SWML option.
//
// Request:  POST {} (empty body is fine)
// Response: { ok: true, token: '<jwt>', callerId: '+1...' }
// Errors:   { ok: false, error: string }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const spaceUrl  = Deno.env.get("SIGNALWIRE_SPACE_URL")  ?? "";
  const projectId = Deno.env.get("SIGNALWIRE_PROJECT_ID") ?? "";
  const apiToken  = Deno.env.get("SIGNALWIRE_API_TOKEN")  ?? "";
  const callerId  = Deno.env.get("SIGNALWIRE_CALLER_ID")  ?? "";

  if (!spaceUrl || !projectId || !apiToken) {
    console.error("[signalwire-browser-token] missing SignalWire secrets");
    return json({ ok: false, error: "SignalWire not configured on server" }, 500);
  }

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  let userEmail: string;
  try {
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user?.email) return json({ ok: false, error: "unauthenticated" }, 401);
    userEmail = data.user.email;
  } catch {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }

  // Mint subscriber token via SignalWire Fabric API.
  // The 'reference' is any stable identifier for this subscriber —
  // using the agent's email is natural and idempotent (SignalWire
  // auto-creates the subscriber on first mint, reuses it after).
  const space = spaceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const endpoint = `https://${space}/api/fabric/subscribers/tokens`;
  const auth = "Basic " + btoa(`${projectId}:${apiToken}`);
  const expireAt = Math.floor(Date.now() / 1000) + 3600;

  const start = Date.now();
  let swRes: Response;
  try {
    swRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Authorization": auth, "Content-Type": "application/json" },
      body: JSON.stringify({ reference: userEmail, expire_at: expireAt }),
    });
  } catch (e) {
    console.error("[signalwire-browser-token] network error:", (e as Error)?.message);
    return json({ ok: false, error: "signalwire_unreachable" }, 502);
  }

  const text = await swRes.text();
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!swRes.ok) {
    console.error(`[signalwire-browser-token] upstream ${swRes.status} ms=${Date.now() - start}:`, data);
    return json({
      ok: false,
      error: typeof data?.error === "string" ? data.error : `SignalWire error ${swRes.status}`,
    }, 502);
  }

  const token = (data?.token as string) ?? "";
  if (!token) {
    console.error("[signalwire-browser-token] no token in response:", data);
    return json({ ok: false, error: "SignalWire returned no token" }, 502);
  }

  console.log(`[signalwire-browser-token] minted subscriber=${userEmail} ms=${Date.now() - start}`);
  return json({ ok: true, token, callerId });
});
