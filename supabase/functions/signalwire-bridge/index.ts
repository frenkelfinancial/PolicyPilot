// ============================================================
// supabase/functions/signalwire-bridge/index.ts
//
// Places an outbound bridge call:
//   • SignalWire calls the agent's browser softphone first, via
//     a SIP endpoint the browser is registered to (JsSIP/WSS)
//   • When the browser auto-answers, inline TwiML <Dial>s the
//     lead's number and bridges the two legs
//   • Either party hanging up tears the bridge down
//
// SignalWire fires StatusCallback POSTs to the public
// signalwire-call-status function as the call progresses; that
// function writes the duration + final status back to the same
// public.calls row this function inserts.
//
// Required secrets (already set for signalwire-token, reused):
//   - SIGNALWIRE_SPACE_URL    e.g. producerstack.signalwire.com  (no scheme)
//   - SIGNALWIRE_PROJECT_ID   UUID from SignalWire dashboard
//   - SIGNALWIRE_API_TOKEN    Secret API token (NEVER expose to browser)
//
// SUPABASE_URL and SUPABASE_ANON_KEY are injected by the runtime.
//
// Auth: Edge Function platform verifies the caller's JWT (verify_jwt
// = true by default). Anonymous calls return 401 before our code
// executes — we re-decode here only to look up the agent's
// caller-ID + SIP endpoint + minute usage.
//
// Request (POST, JSON body):
//   { lead_id: '<uuid>' }
//
// Response (200):
//   { ok: true, callSid: 'CA...', minutesUsed: 87, minutesCap: 500 }
// Response (400): { ok: false, error: string }            — invalid body / missing lead phone
// Response (401): { ok: false, error: 'unauthenticated' }
// Response (409): { ok: false, error: 'not_assigned' }    — missing SIP endpoint or caller_id
// Response (429): { ok: false, error: 'minute_cap_exceeded', minutesUsed, minutesCap }
// Response (502): { ok: false, error: string }            — SignalWire upstream error
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

// Minimal XML-escape for the inline TwiML body. Phone numbers
// shouldn't contain XML-reserved chars, but we paranoid-escape
// anyway in case a malformed E.164 sneaks through.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const spaceUrl  = Deno.env.get("SIGNALWIRE_SPACE_URL")  ?? "";
  const projectId = Deno.env.get("SIGNALWIRE_PROJECT_ID") ?? "";
  const apiToken  = Deno.env.get("SIGNALWIRE_API_TOKEN")  ?? "";
  if (!spaceUrl || !projectId || !apiToken) {
    console.error("[signalwire-bridge] missing SignalWire secrets on server");
    return json({ ok: false, error: "SignalWire not configured on server" }, 500);
  }

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
  let body: { lead_id?: string };
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const leadId = body.lead_id;
  if (!leadId) return json({ ok: false, error: "lead_id required" }, 400);

  // ---- Load agent's calling settings -------------------------
  // sip_endpoint_username is the agent's SignalWire SIP endpoint,
  // provisioned by the signalwire-sip-creds function. The agent
  // leg of the bridge is delivered to whatever browser is
  // registered to that endpoint.
  let sipUsername = "";
  let callerId    = "";
  let minutesCap  = 500;
  try {
    const { data: agent, error } = await userClient
      .from("agents")
      .select("sip_endpoint_username, signalwire_caller_id, monthly_minute_limit")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    sipUsername = (agent?.sip_endpoint_username as string) || "";
    callerId    = (agent?.signalwire_caller_id as string)  || "";
    if (typeof agent?.monthly_minute_limit === "number") {
      minutesCap = agent.monthly_minute_limit;
    }
  } catch (e) {
    console.error(`[signalwire-bridge] agent lookup failed for ${userId}:`, (e as Error)?.message);
    return json({ ok: false, error: "Couldn't load your calling settings. Please retry." }, 503);
  }
  if (!sipUsername || !callerId) {
    return json({ ok: false, error: "not_assigned" }, 409);
  }

  // ---- Load lead's phone -------------------------------------
  // The leads table stores the agent's lead objects as JSONB blobs:
  //   public.leads { id (uuid PK), agent_id, client_id (frontend's
  //   own string id, e.g. 'mp6gp3e0xy314'), data (jsonb), … }
  // The frontend's lead.id is the client_id column, NOT the uuid PK,
  // and per-lead fields (phone, name, state, ...) live inside
  // data — there's no top-level phone column. RLS already constrains
  // SELECTs to (agent_id = auth.uid()) so no explicit agent filter
  // is needed here.
  let leadPhone = "";
  try {
    const { data: lead, error } = await userClient
      .from("leads")
      .select("data")
      .eq("client_id", leadId)
      .maybeSingle();
    if (error) throw error;
    const leadData = (lead?.data as { phone?: string } | null) || null;
    leadPhone = (leadData?.phone as string) || "";
  } catch (e) {
    console.error(`[signalwire-bridge] lead lookup failed for ${leadId}:`, (e as Error)?.message);
    return json({
      ok: false,
      error: `Couldn't load that lead: ${(e as Error)?.message || 'unknown error'}`,
    }, 503);
  }
  if (!leadPhone) return json({ ok: false, error: "Lead has no phone on file" }, 400);

  // ---- Minute cap check --------------------------------------
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  let secondsUsed = 0;
  try {
    const { data: rows, error } = await userClient
      .from("calls")
      .select("duration_sec")
      .eq("agent_id", userId)
      .gte("started_at", monthStart.toISOString());
    if (error) throw error;
    secondsUsed = (rows || []).reduce(
      (s: number, r: { duration_sec: number | null }) => s + (r.duration_sec || 0),
      0,
    );
  } catch (e) {
    console.error(`[signalwire-bridge] minute count failed for ${userId}:`, (e as Error)?.message);
    return json({ ok: false, error: "Couldn't verify your minute allowance. Please retry." }, 503);
  }
  const minutesUsed = Math.floor(secondsUsed / 60);
  if (minutesUsed >= minutesCap) {
    console.log(`[signalwire-bridge] minute_cap_exceeded agent=${userId} used=${minutesUsed} cap=${minutesCap}`);
    return json({ ok: false, error: "minute_cap_exceeded", minutesUsed, minutesCap }, 429);
  }

  // ---- Place the call via SignalWire LaML REST ----------------
  // LaML is SignalWire's Twilio-compatible API. We POST to /Calls.json
  // with From=our caller-ID, To=the agent's SIP endpoint, and Twiml=
  // an inline TwiML response that dials the lead once the agent's
  // browser auto-answers. The <Dial callerId="..."> attribute makes
  // the lead's caller-ID show up as the same number we dialed from
  // (single consistent number visible to both parties — looks like
  // a normal callback).
  const space = spaceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const callsEndpoint = `https://${space}/api/laml/2010-04-01/Accounts/${projectId}/Calls.json`;
  const statusCbUrl   = `${SUPABASE_URL}/functions/v1/signalwire-call-status`;

  // The agent leg targets a SIP endpoint the browser softphone is
  // registered to. The SIP host is the space host with a ".sip."
  // infix: producerstack.signalwire.com → producerstack.sip.signalwire.com
  const sipHost         = space.replace(/^([^.]+)\./, "$1.sip.");
  const agentSipAddress = `sip:${sipUsername}@${sipHost}`;

  const twiml =
    `<Response><Dial callerId="${xmlEscape(callerId)}" timeout="30">` +
    `<Number>${xmlEscape(leadPhone)}</Number>` +
    `</Dial></Response>`;

  const form = new URLSearchParams();
  form.set("From",  callerId);
  form.set("To",    agentSipAddress);
  form.set("Twiml", twiml);
  form.set("StatusCallback",       statusCbUrl);
  form.set("StatusCallbackMethod", "POST");
  // Subscribe to each lifecycle event explicitly. Without these
  // four lines you only get the final "completed" POST and lose
  // the ringing → answered transitions.
  for (const ev of ["initiated", "ringing", "answered", "completed"]) {
    form.append("StatusCallbackEvent", ev);
  }

  const auth = "Basic " + btoa(`${projectId}:${apiToken}`);
  const start = Date.now();
  let swRes: Response;
  try {
    swRes = await fetch(callsEndpoint, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "Content-Type":  "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    console.error(`[signalwire-bridge] network error:`, (e as Error)?.message);
    return json({ ok: false, error: "signalwire_unreachable" }, 502);
  }
  const ms = Date.now() - start;

  const text = await swRes.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!swRes.ok) {
    console.error(`[signalwire-bridge] upstream ${swRes.status} ms=${ms}:`, data);
    return json({
      ok: false,
      error: typeof data?.message === "string"
        ? data.message
        : `SignalWire error ${swRes.status}`,
    }, 502);
  }

  // LaML returns the new call's sid as "sid" on the call resource.
  const callSid: string = data?.sid || "";
  if (!callSid) {
    console.error(`[signalwire-bridge] no sid in response:`, data);
    return json({ ok: false, error: "SignalWire returned no call sid" }, 502);
  }

  // ---- Log the call row ---------------------------------------
  // Insert synchronously so the webhook (which can fire within
  // ~1 second) has a row to update by sw_call_sid. If the insert
  // fails we still return ok — the call was placed, and missing
  // row updates just mean the webhook 204s harmlessly.
  try {
    const { error } = await userClient.from("calls").insert({
      agent_id:    userId,
      lead_id:     leadId,
      direction:   "outbound",
      phone_from:  callerId,
      phone_to:    leadPhone,
      started_at:  new Date().toISOString(),
      sw_call_sid: callSid,
      status:      "initiated",
    });
    if (error) {
      console.error(`[signalwire-bridge] calls insert failed:`, error.message);
    }
  } catch (e) {
    console.error(`[signalwire-bridge] calls insert threw:`, (e as Error)?.message);
  }

  console.log(`[signalwire-bridge] placed agent=${userId} sid=${callSid} ms=${ms} used=${minutesUsed}/${minutesCap}min`);
  return json({ ok: true, callSid, minutesUsed, minutesCap });
});
