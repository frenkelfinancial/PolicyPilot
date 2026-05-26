// ============================================================
// supabase/functions/signalwire-call-status/index.ts
//
// Public webhook receiver. SignalWire POSTs here for every
// status transition on calls placed by signalwire-bridge.
//
// Auth: PUBLIC (verify_jwt = false in config.toml). We validate
// the X-SignalWire-Signature header instead — HMAC-SHA1 of
// (full URL + sorted key+value form params concatenated)
// keyed by SIGNALWIRE_API_TOKEN. This is the standard
// LaML/Twilio-compatible signature scheme that SignalWire's
// servers use natively, so no extra dashboard configuration
// is required.
//
// Body: application/x-www-form-urlencoded with at least:
//   CallSid, CallStatus, Direction
//   AnsweredBy?, CallDuration? (only on final 'completed'),
//   plus many other fields we ignore.
//
// Response: 204 always (success or signature mismatch silently
// rejected). We don't 5xx on bad signatures because SignalWire
// would then retry indefinitely; 204 + log is the right
// posture for "ignored, please don't try again".
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- HMAC-SHA1 signature validation ------------------------
// Mirror of SignalWire's (Twilio-compatible) algorithm:
//   1. Take the full request URL (scheme + host + path + query)
//   2. Sort the form-body keys alphabetically
//   3. For each [k, v], append k + v (no separator)
//   4. HMAC-SHA1(api_token, urlString + concatenated kv string)
//   5. base64-encode the digest
//   6. Compare against the X-SignalWire-Signature header
async function isValidSignature(
  url: string,
  body: URLSearchParams,
  signatureHeader: string,
  apiToken: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const sortedKeys = [...new Set(body.keys())].sort();
  let payload = url;
  for (const k of sortedKeys) {
    const vals = body.getAll(k);
    for (const v of vals) payload += k + v;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  // Constant-time-ish compare. Both strings are fixed-size base64
  // digests so length mismatch returns immediately.
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

// CallStatus values we map directly into calls.status. The column
// has a CHECK constraint matching these exact strings — anything
// else gets ignored to avoid blowing up the constraint.
const STATUS_WHITELIST = new Set([
  "initiated", "ringing", "answered",
  "completed", "busy", "failed", "no-answer", "canceled",
]);

// Statuses that mean the call is finished — we set ended_at and
// duration_sec when one of these arrives.
const TERMINAL_STATUSES = new Set([
  "completed", "busy", "failed", "no-answer", "canceled",
]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const apiToken = Deno.env.get("SIGNALWIRE_API_TOKEN") ?? "";
  if (!apiToken) {
    console.error("[signalwire-call-status] SIGNALWIRE_API_TOKEN not set");
    return new Response("", { status: 204 });
  }

  // ---- Parse form body --------------------------------------
  const raw = await req.text();
  const form = new URLSearchParams(raw);

  // ---- Validate signature ----------------------------------
  // SignalWire signs the full URL it actually POSTed to.
  // req.url at the edge gives us that URL (Supabase edge runtime
  // exposes the original URL, not the internal proxy URL).
  const sigHeader = req.headers.get("x-signalwire-signature")
                 || req.headers.get("X-SignalWire-Signature")
                 || "";
  const ok = await isValidSignature(req.url, form, sigHeader, apiToken);
  if (!ok) {
    console.warn(`[signalwire-call-status] bad signature for sid=${form.get("CallSid")}`);
    return new Response("", { status: 204 });
  }

  const callSid      = form.get("CallSid") || "";
  const callStatus   = form.get("CallStatus") || "";
  const callDuration = form.get("CallDuration"); // string; present only on terminal events
  if (!callSid) return new Response("", { status: 204 });

  // Skip status values we don't recognize.
  if (!STATUS_WHITELIST.has(callStatus)) {
    console.log(`[signalwire-call-status] sid=${callSid} ignored status=${callStatus}`);
    return new Response("", { status: 204 });
  }

  // ---- Update the calls row --------------------------------
  // Service-role client because the row's owner (agent_id) is
  // not the caller here — SignalWire is, no JWT to scope RLS by.
  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const patch: Record<string, unknown> = { status: callStatus };
  if (callStatus === "answered") {
    patch.answered_at = new Date().toISOString();
  }
  if (TERMINAL_STATUSES.has(callStatus)) {
    patch.ended_at = new Date().toISOString();
    const dur = callDuration ? parseInt(callDuration, 10) : NaN;
    if (Number.isFinite(dur) && dur >= 0) patch.duration_sec = dur;
  }

  try {
    const { error } = await sb
      .from("calls")
      .update(patch)
      .eq("sw_call_sid", callSid);
    if (error) {
      console.error(`[signalwire-call-status] update failed sid=${callSid}:`, error.message);
    } else {
      const durStr = (typeof patch.duration_sec === "number") ? ` dur=${patch.duration_sec}s` : "";
      console.log(`[signalwire-call-status] sid=${callSid} ${callStatus}${durStr}`);
    }
  } catch (e) {
    console.error(`[signalwire-call-status] update threw sid=${callSid}:`, (e as Error)?.message);
  }

  return new Response("", { status: 204 });
});
