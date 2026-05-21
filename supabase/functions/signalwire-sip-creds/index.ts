// ============================================================
// supabase/functions/signalwire-sip-creds/index.ts
//
// Idempotently provisions a SignalWire SIP endpoint for the
// calling agent and returns the credentials the browser
// softphone needs to register via JsSIP over WSS.
//
// The browser registers to wss://<space>.sip.signalwire.com as
// sip:<username>@<space>.sip.signalwire.com. signalwire-bridge
// then places outbound calls with To = that SIP address, so the
// agent leg of every bridged call lands in the browser instead
// of on a personal cell phone.
//
// Required secrets (already set for signalwire-bridge, reused):
//   - SIGNALWIRE_SPACE_URL    e.g. producerstack.signalwire.com  (no scheme)
//   - SIGNALWIRE_PROJECT_ID   UUID from SignalWire dashboard
//   - SIGNALWIRE_API_TOKEN    Secret API token (NEVER expose to browser)
//
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are
// injected by the runtime.
//
// Auth: Edge Function platform verifies the caller's Supabase
// JWT (verify_jwt = true by default — no config.toml needed).
//
// Request (POST, JSON body — empty {} is fine):  {}
//
// Response (200):
//   { ok: true, username, password, domain, wss_url }
// Response (401): { ok: false, error: 'unauthenticated' }
// Response (502): { ok: false, error: 'sip_provision_failed', detail }
// Response (500): { ok: false, error: string }   — server misconfig
// Response (503): { ok: false, error: string }   — transient DB error
//
// ── SignalWire SIP endpoint REST API ────────────────────────
// This function targets the Relay REST endpoints API:
//   POST   /api/relay/rest/endpoints/sip       create
//   GET    /api/relay/rest/endpoints/sip       list (conflict recovery)
//   PUT    /api/relay/rest/endpoints/sip/:id   reset password
// All three use Basic auth with PROJECT_ID:API_TOKEN.
//
// VERIFY ON FIRST DEPLOY: run the POST once against the live
// space and confirm the 201 body shape — especially the `id`
// field. If this account only exposes the newer Fabric API,
// change SIP_API_PATH below to "/api/fabric/resources/sip_endpoints".
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Swap this single constant if the account is on the Fabric API.
const SIP_API_PATH = "/api/relay/rest/endpoints/sip";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// 24 random bytes → base64url. Every char (A-Za-z0-9-_) is safe
// for a SIP digest-auth password.
function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Walk the paginated list endpoint looking for a SIP endpoint
// whose username matches. Used to recover when a prior run
// created the endpoint at SignalWire but crashed before saving
// the id/password to our DB.
async function findEndpointByUsername(
  base: string,
  auth: string,
  username: string,
): Promise<{ id: string } | null> {
  let url: string | null = base;
  for (let page = 0; page < 20 && url; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(data?.data) ? data.data : [];
    const hit = rows.find((r) => r?.username === username);
    if (hit?.id) return { id: String(hit.id) };
    url = typeof data?.links?.next === "string" ? data.links.next : null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const spaceUrl  = Deno.env.get("SIGNALWIRE_SPACE_URL")  ?? "";
  const projectId = Deno.env.get("SIGNALWIRE_PROJECT_ID") ?? "";
  const apiToken  = Deno.env.get("SIGNALWIRE_API_TOKEN")  ?? "";
  if (!spaceUrl || !projectId || !apiToken) {
    console.error("[signalwire-sip-creds] missing SignalWire secrets on server");
    return json({ ok: false, error: "SignalWire not configured on server" }, 500);
  }

  const SUPABASE_URL              = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";

  // ---- Auth: decode the agent's uuid -------------------------
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let userId: string;
  try {
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user?.id) return json({ ok: false, error: "unauthenticated" }, 401);
    userId = data.user.id;
  } catch {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }

  // Service-role client: reads + writes the agent's SIP columns
  // authoritatively (provisioning must not depend on RLS quirks).
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The SIP host is the space host with a ".sip." infix:
  //   producerstack.signalwire.com → producerstack.sip.signalwire.com
  const space   = spaceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const sipHost = space.replace(/^([^.]+)\./, "$1.sip.");

  // ---- Fast path: already provisioned ------------------------
  let agent: {
    sip_endpoint_username: string | null;
    sip_endpoint_password: string | null;
    sip_endpoint_sid: string | null;
  } | null = null;
  try {
    const { data, error } = await admin
      .from("agents")
      .select("sip_endpoint_username, sip_endpoint_password, sip_endpoint_sid")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    agent = data as typeof agent;
  } catch (e) {
    console.error(`[signalwire-sip-creds] agent lookup failed for ${userId}:`, (e as Error)?.message);
    return json({ ok: false, error: "Couldn't load your account. Please retry." }, 503);
  }
  if (!agent) {
    console.error(`[signalwire-sip-creds] no agents row for ${userId}`);
    return json({ ok: false, error: "No agent profile found for this account." }, 500);
  }

  if (agent.sip_endpoint_username && agent.sip_endpoint_password) {
    return json({
      ok: true,
      username: agent.sip_endpoint_username,
      password: agent.sip_endpoint_password,
      domain: sipHost,
      wss_url: `wss://${sipHost}`,
    });
  }

  // ---- Cold path: provision a SIP endpoint -------------------
  // Deterministic username so a re-run after a crash targets the
  // same logical endpoint. 8 hex chars (~4.3B space) is collision-
  // safe for a single firm.
  const username = "agent-" + userId.replace(/-/g, "").slice(0, 8);
  const password = randomPassword();
  const auth     = "Basic " + btoa(`${projectId}:${apiToken}`);
  const sipApiBase = `https://${space}${SIP_API_PATH}`;

  let endpointId = "";

  // 1. Try to create the endpoint.
  let createRes: Response;
  try {
    createRes = await fetch(sipApiBase, {
      method: "POST",
      headers: { "Authorization": auth, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, encryption: "required" }),
    });
  } catch (e) {
    console.error(`[signalwire-sip-creds] network error:`, (e as Error)?.message);
    return json({ ok: false, error: "sip_provision_failed", detail: "signalwire_unreachable" }, 502);
  }
  const createText = await createRes.text();
  let createData: any;
  try { createData = JSON.parse(createText); } catch { createData = { raw: createText }; }

  if (createRes.ok) {
    endpointId = String(createData?.id || "");
  } else {
    // 2. Create failed — most likely the username is already taken
    // because a prior run provisioned the endpoint but crashed
    // before persisting. Recover: find it, then reset its password
    // to the one we just generated.
    console.warn(
      `[signalwire-sip-creds] create ${createRes.status} for ${username}, attempting recovery:`,
      createText.slice(0, 300),
    );
    const found = await findEndpointByUsername(sipApiBase, auth, username);
    if (!found) {
      return json({
        ok: false,
        error: "sip_provision_failed",
        detail: createData?.errors || createData?.message || `SignalWire error ${createRes.status}`,
      }, 502);
    }
    endpointId = found.id;
    let putRes: Response;
    try {
      putRes = await fetch(`${sipApiBase}/${endpointId}`, {
        method: "PUT",
        headers: { "Authorization": auth, "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
    } catch (e) {
      console.error(`[signalwire-sip-creds] password reset network error:`, (e as Error)?.message);
      return json({ ok: false, error: "sip_provision_failed", detail: "signalwire_unreachable" }, 502);
    }
    if (!putRes.ok) {
      const putText = await putRes.text();
      console.error(`[signalwire-sip-creds] password reset failed:`, putText.slice(0, 300));
      return json({ ok: false, error: "sip_provision_failed", detail: "couldn't reset SIP password" }, 502);
    }
  }

  // ---- Persist to the agent row ------------------------------
  // If this write fails the SIP endpoint still exists and the
  // creds below are valid for this session — the next cold call
  // hits the recovery path above. Log loudly either way.
  try {
    const { error } = await admin
      .from("agents")
      .update({
        sip_endpoint_username: username,
        sip_endpoint_password: password,
        sip_endpoint_sid: endpointId || null,
      })
      .eq("id", userId);
    if (error) {
      console.error(`[signalwire-sip-creds] persist failed for ${userId}:`, error.message);
    }
  } catch (e) {
    console.error(`[signalwire-sip-creds] persist threw for ${userId}:`, (e as Error)?.message);
  }

  console.log(`[signalwire-sip-creds] provisioned agent=${userId} username=${username} sid=${endpointId}`);
  return json({
    ok: true,
    username,
    password,
    domain: sipHost,
    wss_url: `wss://${sipHost}`,
  });
});
