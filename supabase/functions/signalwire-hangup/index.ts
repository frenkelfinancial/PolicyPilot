// ============================================================
// supabase/functions/signalwire-hangup/index.ts
//
// Backs the dashboard's Hangup button. POSTs Status=completed
// to SignalWire's /Calls/{sid} endpoint, which tears down both
// legs of the bridge. Only the agent who owns the call can
// hang it up (enforced by checking agent_id against auth.uid()
// before forwarding to SignalWire).
//
// Required secrets (same set as signalwire-bridge):
//   - SIGNALWIRE_SPACE_URL
//   - SIGNALWIRE_PROJECT_ID
//   - SIGNALWIRE_API_TOKEN
//
// Request (POST, JSON body):
//   { call_sid: 'CA...' }
//
// Response (200): { ok: true }
// Response (400): { ok: false, error: string }            — bad body
// Response (401): { ok: false, error: 'unauthenticated' }
// Response (403): { ok: false, error: 'not_your_call' }
// Response (404): { ok: false, error: 'call_not_found' }
// Response (502): { ok: false, error: string }            — SignalWire error
// Response (503): { ok: false, error: string }            — transient DB error
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

  // ---- Auth ---------------------------------------------------
  let userId: string;
  try {
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user?.id) return json({ ok: false, error: "unauthenticated" }, 401);
    userId = data.user.id;
  } catch {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }

  // ---- Parse body --------------------------------------------
  let body: { call_sid?: string };
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const sid = body.call_sid;
  if (!sid) return json({ ok: false, error: "call_sid required" }, 400);

  // ---- Verify the caller owns this call ----------------------
  // Defense-in-depth: RLS already constrains the SELECT to the
  // caller's own rows (calls_select_own policy), but checking the
  // returned row explicitly makes the 403 vs 404 distinction
  // clear in logs and prevents an admin (who can SELECT any
  // calls row via calls_select_admin) from accidentally hanging
  // up someone else's bridge through this endpoint.
  try {
    const { data: row, error } = await userClient
      .from("calls")
      .select("agent_id")
      .eq("sw_call_sid", sid)
      .maybeSingle();
    if (error) throw error;
    if (!row) return json({ ok: false, error: "call_not_found" }, 404);
    if (row.agent_id !== userId) return json({ ok: false, error: "not_your_call" }, 403);
  } catch (e) {
    console.error(`[signalwire-hangup] ownership check failed sid=${sid}:`, (e as Error)?.message);
    return json({ ok: false, error: "Couldn't verify call ownership." }, 503);
  }

  // ---- Tell SignalWire to hang up ----------------------------
  const space = spaceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const endpoint = `https://${space}/api/laml/2010-04-01/Accounts/${projectId}/Calls/${sid}.json`;
  const auth = "Basic " + btoa(`${projectId}:${apiToken}`);
  const form = new URLSearchParams();
  form.set("Status", "completed");

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error(`[signalwire-hangup] upstream ${r.status} sid=${sid}: ${txt}`);
      return json({ ok: false, error: `SignalWire error ${r.status}` }, 502);
    }
  } catch (e) {
    console.error(`[signalwire-hangup] network error sid=${sid}:`, (e as Error)?.message);
    return json({ ok: false, error: "signalwire_unreachable" }, 502);
  }

  console.log(`[signalwire-hangup] hung up sid=${sid} by agent=${userId}`);
  return json({ ok: true });
});
