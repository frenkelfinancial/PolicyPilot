// ============================================================
// supabase/functions/signalwire-search-numbers/index.ts
//
// Proxies SignalWire's LaML "available phone numbers" search so the
// Phone Book tab can show real, buy-able US Local numbers by area code
// without ever exposing SIGNALWIRE_API_TOKEN to the browser.
//
// Required secrets (already set for signalwire-bridge, reused):
//   - SIGNALWIRE_SPACE_URL    e.g. producerstack.signalwire.com (no scheme)
//   - SIGNALWIRE_PROJECT_ID   UUID from SignalWire dashboard
//   - SIGNALWIRE_API_TOKEN    Secret API token
//
// Auth: Edge Function platform verifies the caller's JWT (verify_jwt = true).
//
// Request (POST, JSON body):
//   { area_code: "512", limit?: number }    // limit defaults to 20, max 50
//
// Response (200):
//   { ok: true, numbers: Array<{
//       phone_number: string,        // E.164, e.g. "+15125550100"
//       friendly_name: string,
//       locality: string|null,
//       region: string|null,
//       monthly_cost: number,        // hard-coded $1.00 for US Local
//     }>
//   }
// Response (400): { ok:false, error: 'area_code required' | 'area_code must be 3 digits' }
// Response (401): { ok:false, error: 'unauthenticated' }
// Response (502): { ok:false, error: string }   // SignalWire upstream error
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const spaceUrl  = Deno.env.get("SIGNALWIRE_SPACE_URL")  ?? "";
  const projectId = Deno.env.get("SIGNALWIRE_PROJECT_ID") ?? "";
  const apiToken  = Deno.env.get("SIGNALWIRE_API_TOKEN")  ?? "";
  if (!spaceUrl || !projectId || !apiToken) {
    console.error("[signalwire-search-numbers] missing SignalWire secrets");
    return json({ ok: false, error: "SignalWire not configured on server" }, 500);
  }

  // ---- Auth: just verify the JWT, we don't need the user id ----------
  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")      ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user?.id) return json({ ok: false, error: "unauthenticated" }, 401);
  } catch {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }

  // ---- Parse body ----------------------------------------------------
  let body: { area_code?: string; limit?: number };
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }

  const areaCode = (body.area_code || "").trim();
  if (!areaCode) return json({ ok: false, error: "area_code required" }, 400);
  if (!/^\d{3}$/.test(areaCode)) {
    return json({ ok: false, error: "area_code must be 3 digits" }, 400);
  }
  const limit = Math.max(1, Math.min(50, body.limit ?? 20));

  // ---- Call SignalWire LaML AvailablePhoneNumbers --------------------
  const space = spaceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const url =
    `https://${space}/api/laml/2010-04-01/Accounts/${projectId}` +
    `/AvailablePhoneNumbers/US/Local.json` +
    `?AreaCode=${encodeURIComponent(areaCode)}&PageSize=${limit}`;

  const auth = "Basic " + btoa(`${projectId}:${apiToken}`);
  const start = Date.now();
  let swRes: Response;
  try {
    swRes = await fetch(url, { method: "GET", headers: { "Authorization": auth } });
  } catch (e) {
    console.error(`[signalwire-search-numbers] network error:`, (e as Error)?.message);
    return json({ ok: false, error: "signalwire_unreachable" }, 502);
  }
  const ms = Date.now() - start;

  const text = await swRes.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!swRes.ok) {
    console.error(`[signalwire-search-numbers] upstream ${swRes.status} ms=${ms}:`, data);
    return json({
      ok: false,
      error: typeof data?.message === "string"
        ? data.message
        : `SignalWire error ${swRes.status}`,
    }, 502);
  }

  // LaML responds with { available_phone_numbers: [...] }
  const raw = Array.isArray(data?.available_phone_numbers)
    ? data.available_phone_numbers
    : [];

  const numbers = raw.map((n: any) => ({
    phone_number:  String(n?.phone_number || ""),
    friendly_name: String(n?.friendly_name || n?.phone_number || ""),
    locality:      n?.locality ? String(n.locality) : null,
    region:        n?.region   ? String(n.region)   : null,
    monthly_cost:  1.00,   // SignalWire US Local list price; not returned by the search API
  })).filter((n: any) => n.phone_number);

  console.log(`[signalwire-search-numbers] area=${areaCode} returned=${numbers.length} ms=${ms}`);
  return json({ ok: true, numbers });
});
