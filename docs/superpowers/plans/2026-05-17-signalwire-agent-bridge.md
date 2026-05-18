# SignalWire Agent-Bridge Calling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `@signalwire/js` browser SDK calling path with a server-initiated SignalWire LaML REST bridge: agent's personal phone rings first, then SignalWire bridges to the lead.

**Architecture:** Browser POSTs to a new `signalwire-bridge` edge function which places a SignalWire REST call from the agent's `signalwire_caller_id` to the agent's new `agent_phone` column, with inline TwiML that dials the lead on answer. Call lifecycle updates land back via a public `signalwire-call-status` webhook into the existing `public.calls` table; Supabase Realtime pushes the row changes to the dashboard panel. A third `signalwire-hangup` edge function backs the dashboard hangup button.

**Tech Stack:** Supabase Edge Functions (Deno + TypeScript), Supabase Postgres + RLS + Realtime, vanilla JS in a single-file HTML dashboard, SignalWire LaML REST API (Twilio-compatible) with HMAC-SHA1 webhook signature validation.

**Spec:** `docs/superpowers/specs/2026-05-17-signalwire-agent-bridge-design.md`

**Branch:** continue on `feature/signalwire-telephony`

**Testing convention:** This codebase has no automated test framework. We use:
- `curl` smoke tests for edge functions (commands provided per task)
- Manual end-to-end verification for the frontend (browser console + observed behavior)
- Each task ends with a commit; the final task is a real end-to-end call placed through ProducerStack to validate the full chain.

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `data/sql/008_agent_phone.sql` | CREATE | Schema delta: `agents.agent_phone`, `calls.status`, `calls.answered_at`, Realtime publication |
| `supabase/functions/signalwire-bridge/index.ts` | CREATE | Place outbound bridge call via LaML REST |
| `supabase/functions/signalwire-call-status/index.ts` | CREATE | Public webhook receiver; validates SignalWire HMAC; updates `calls` row |
| `supabase/functions/signalwire-hangup/index.ts` | CREATE | Authed hangup-button endpoint; POSTs `Status=completed` to SignalWire |
| `supabase/functions/signalwire-token/index.ts` | EDIT | Add deprecation header comment |
| `index.html` (softphone IIFE, lines ~7756–8194) | EDIT | Rewrite dial path; delete SDK code; add Realtime subscription; new phase labels; wire hangup button |
| `index.html` (Settings → Calling, lines ~9800–9994) | EDIT | Add "My phone" inline-edit row; add Agent Phone column to admin table |
| `index.html` (softphone panel markup, line ~13491) | EDIT (small) | No structural changes; just verify the phase strings the new state machine emits map to existing data-phase CSS rules |

---

## Task 1: Schema migration

**Files:**
- Create: `data/sql/008_agent_phone.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- ============================================================
-- 008_agent_phone.sql
-- Agent-bridge calling (Phase D — supersedes browser SDK in
-- Phases A+B). Adds the agent's personal pickup number plus
-- richer per-call lifecycle tracking populated by the
-- signalwire-call-status webhook.
--
-- Run once in the Supabase SQL Editor (or `supabase db push`).
-- ============================================================

-- 1. agents.agent_phone --------------------------------------
alter table public.agents
  add column if not exists agent_phone text;

comment on column public.agents.agent_phone is
  'E.164 personal phone where this agent picks up bridged outbound calls (e.g. +14155550142). Distinct from signalwire_caller_id, which is what the lead sees. Set in Settings → Calling → My phone.';

-- 2. calls lifecycle columns ---------------------------------
alter table public.calls
  add column if not exists status text default 'initiated'
    check (status in (
      'initiated','ringing','answered',
      'completed','busy','failed','no-answer','canceled'
    )),
  add column if not exists answered_at timestamptz;

comment on column public.calls.status is
  'Latest SignalWire CallStatus received via the signalwire-call-status webhook. Happy path: initiated → ringing → answered → completed.';
comment on column public.calls.answered_at is
  'Timestamp when the lead leg of the bridge was answered. Frontend timer counts up from here.';

-- 3. Realtime publication ------------------------------------
-- The softphone panel subscribes to row updates on this table
-- so webhook arrivals push live status into the dashboard
-- without polling.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table public.calls;
  end if;
end $$;
```

- [ ] **Step 2: Lint-check the file**

Run: `grep -E "TBD|TODO|FIXME|XXX" data/sql/008_agent_phone.sql`
Expected: no output (clean file)

- [ ] **Step 3: Commit**

```bash
git add data/sql/008_agent_phone.sql
git commit -m "feat(calls): schema for agent-bridge \\

Adds agent_phone to agents (where this agent picks up bridged
calls — distinct from caller-ID), plus status + answered_at to
calls so the signalwire-call-status webhook can drive live
panel updates via Realtime.

Run-once migration; idempotent (uses if not exists).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: signalwire-bridge edge function

**Files:**
- Create: `supabase/functions/signalwire-bridge/index.ts`

- [ ] **Step 1: Write the function**

```ts
// ============================================================
// supabase/functions/signalwire-bridge/index.ts
//
// Places an outbound bridge call:
//   • SignalWire calls the agent's agent_phone first
//   • When agent answers, inline TwiML <Dial>s the lead's number
//   • Either party hanging up tears the bridge down
//
// SignalWire fires StatusCallback POSTs to the public
// signalwire-call-status function as the call progresses; that
// function writes the duration + final status back to the same
// public.calls row this function inserts.
//
// Required secrets (already set for signalwire-token, reused):
//   - SIGNALWIRE_SPACE_URL
//   - SIGNALWIRE_PROJECT_ID
//   - SIGNALWIRE_API_TOKEN
//
// Request (POST, JSON):
//   { lead_id: '<uuid>' }
//
// Response 200: { ok: true, callSid: 'CA...', minutesUsed, minutesCap }
// Response 401: { ok: false, error: 'unauthenticated' }
// Response 409: { ok: false, error: 'not_assigned' }    — missing agent_phone or caller_id
// Response 429: { ok: false, error: 'minute_cap_exceeded', minutesUsed, minutesCap }
// Response 502: { ok: false, error: string }            — SignalWire upstream error
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

  // ---- Load agent + lead --------------------------------------
  let agentPhone = "";
  let callerId   = "";
  let minutesCap = 500;
  try {
    const { data: agent, error } = await userClient
      .from("agents")
      .select("agent_phone, signalwire_caller_id, monthly_minute_limit")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    agentPhone = (agent?.agent_phone as string)            || "";
    callerId   = (agent?.signalwire_caller_id as string)   || "";
    if (typeof agent?.monthly_minute_limit === "number") {
      minutesCap = agent.monthly_minute_limit;
    }
  } catch (e) {
    console.error(`[signalwire-bridge] agent lookup failed for ${userId}:`, (e as Error)?.message);
    return json({ ok: false, error: "Couldn't load your calling settings. Please retry." }, 503);
  }
  if (!agentPhone || !callerId) {
    return json({ ok: false, error: "not_assigned" }, 409);
  }

  let leadPhone = "";
  try {
    const { data: lead, error } = await userClient
      .from("leads")
      .select("phone")
      .eq("id", leadId)
      .maybeSingle();
    if (error) throw error;
    leadPhone = (lead?.phone as string) || "";
  } catch (e) {
    console.error(`[signalwire-bridge] lead lookup failed for ${leadId}:`, (e as Error)?.message);
    return json({ ok: false, error: "Couldn't load that lead. Please retry." }, 503);
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
    return json({ ok: false, error: "minute_cap_exceeded", minutesUsed, minutesCap }, 429);
  }

  // ---- Place the call via LaML REST ---------------------------
  const space = spaceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const callsEndpoint = `https://${space}/api/laml/2010-04-01/Accounts/${projectId}/Calls.json`;
  const statusCbUrl = `${SUPABASE_URL}/functions/v1/signalwire-call-status`;

  // Inline TwiML: when the agent answers, SignalWire dials the
  // lead with the agent's caller-ID and bridges the two legs.
  const twiml =
    `<Response><Dial callerId="${xmlEscape(callerId)}" timeout="30">` +
    `<Number>${xmlEscape(leadPhone)}</Number>` +
    `</Dial></Response>`;

  const form = new URLSearchParams();
  form.set("From",  callerId);
  form.set("To",    agentPhone);
  form.set("Twiml", twiml);
  form.set("StatusCallback",      statusCbUrl);
  form.set("StatusCallbackMethod","POST");
  // SignalWire emits separate POSTs for each of these events.
  // Without explicitly listing them you only get the final
  // "completed" event, which loses ringing → answered transitions.
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

  // LaML returns the new call's sid as "sid"
  const callSid: string = data?.sid || "";
  if (!callSid) {
    console.error(`[signalwire-bridge] no sid in response:`, data);
    return json({ ok: false, error: "SignalWire returned no call sid" }, 502);
  }

  // ---- Log the call row ---------------------------------------
  try {
    const { error } = await userClient.from("calls").insert({
      agent_id:     userId,
      lead_id:      leadId,
      direction:    "outbound",
      phone_from:   callerId,
      phone_to:     leadPhone,
      started_at:   new Date().toISOString(),
      sw_call_sid:  callSid,
      status:       "initiated",
    });
    if (error) {
      console.error(`[signalwire-bridge] calls insert failed:`, error.message);
      // Don't fail the request — the call is already placed.
      // The webhook will still try to update by sw_call_sid; if
      // the row doesn't exist the webhook 204s harmlessly.
    }
  } catch (e) {
    console.error(`[signalwire-bridge] calls insert threw:`, (e as Error)?.message);
  }

  console.log(`[signalwire-bridge] placed agent=${userId} sid=${callSid} ms=${ms} used=${minutesUsed}/${minutesCap}min`);
  return json({ ok: true, callSid, minutesUsed, minutesCap });
});
```

- [ ] **Step 2: Smoke-test syntax**

Run: `deno check supabase/functions/signalwire-bridge/index.ts 2>&1 | head -20`
Expected: no errors, or only "Download" lines (network fetches for type definitions are fine).
If `deno` not installed locally, skip — Supabase will type-check at deploy time.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/signalwire-bridge/index.ts
git commit -m "feat(signalwire-bridge): edge function for REST agent-bridge calls

Replaces the @signalwire/js browser-SDK path with a server-side
LaML REST call. Inline TwiML <Dial>s the lead's number when the
agent answers their personal phone, bridging the two legs.

Includes the minute-cap check that signalwire-token used to do,
inserts a calls row tagged with the SignalWire CallSid so the
webhook function can correlate status updates back to it, and
declares StatusCallbackEvent for initiated/ringing/answered/
completed so we get the full lifecycle rather than only the
final 'completed' POST.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: signalwire-call-status webhook receiver

**Files:**
- Create: `supabase/functions/signalwire-call-status/index.ts`

- [ ] **Step 1: Write the function**

```ts
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
// LaML/Twilio-compatible signature scheme.
//
// Body: application/x-www-form-urlencoded with at least:
//   CallSid, CallStatus, Direction
//   AnsweredBy?, CallDuration? (final 'completed' only),
//   plus many other fields we ignore.
//
// Response: 204 always (success or signature mismatch silently
// rejected — SignalWire retries on 5xx; we don't want to
// trigger retries for legitimate signature failures).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- HMAC-SHA1 signature validation ------------------------
// Mirror of SignalWire's (Twilio's) algorithm:
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
  // Constant-time-ish compare — small fixed strings, fine.
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

// CallStatus values we map directly into calls.status (column
// has a CHECK constraint matching these exact strings).
const STATUS_WHITELIST = new Set([
  "initiated","ringing","answered",
  "completed","busy","failed","no-answer","canceled",
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
  // Reconstruct it from the request — Supabase edge functions
  // sit behind a proxy, so req.url is the original URL.
  const sigHeader = req.headers.get("x-signalwire-signature")
                 || req.headers.get("X-SignalWire-Signature")
                 || "";
  const ok = await isValidSignature(req.url, form, sigHeader, apiToken);
  if (!ok) {
    console.warn(`[signalwire-call-status] bad signature for sid=${form.get("CallSid")}`);
    return new Response("", { status: 204 });
  }

  const callSid     = form.get("CallSid") || "";
  const callStatus  = form.get("CallStatus") || "";
  const callDuration = form.get("CallDuration"); // string, only on final
  if (!callSid) {
    return new Response("", { status: 204 });
  }

  // Skip status values we don't recognize (SignalWire sometimes
  // sends intermediate ones not in our whitelist; safer to no-op
  // than to violate the CHECK constraint).
  if (!STATUS_WHITELIST.has(callStatus)) {
    console.log(`[signalwire-call-status] sid=${callSid} ignored status=${callStatus}`);
    return new Response("", { status: 204 });
  }

  // ---- Update the calls row --------------------------------
  // Service-role client because the row's owner (agent_id) is
  // not the caller — SignalWire is the caller, no JWT.
  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const patch: Record<string, unknown> = { status: callStatus };
  if (callStatus === "answered") {
    patch.answered_at = new Date().toISOString();
  }
  if (callStatus === "completed" || callStatus === "busy" ||
      callStatus === "failed"    || callStatus === "no-answer" ||
      callStatus === "canceled") {
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
      console.log(`[signalwire-call-status] sid=${callSid} ${callStatus}${patch.duration_sec ? " dur=" + patch.duration_sec + "s" : ""}`);
    }
  } catch (e) {
    console.error(`[signalwire-call-status] update threw sid=${callSid}:`, (e as Error)?.message);
  }

  return new Response("", { status: 204 });
});
```

- [ ] **Step 2: Configure the function to skip JWT verification**

Create file: `supabase/functions/signalwire-call-status/config.toml`

```toml
[functions.signalwire-call-status]
verify_jwt = false
```

This tells Supabase NOT to require a Supabase JWT for this function (SignalWire's servers don't have one). The function's own HMAC check is the real auth.

- [ ] **Step 3: Smoke-test syntax**

Run: `deno check supabase/functions/signalwire-call-status/index.ts 2>&1 | head -20`
Expected: no errors. (Skip if no local Deno install.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/signalwire-call-status/
git commit -m "feat(signalwire-call-status): public webhook for call lifecycle

Receives SignalWire StatusCallback POSTs for every status
transition (initiated/ringing/answered/completed/busy/failed/
no-answer/canceled) on calls placed by signalwire-bridge.

Validates SignalWire's HMAC-SHA1 signature (LaML/Twilio
scheme: sort form keys alphabetically, concat k+v, prepend
full URL, sign with API token) before touching the database.
verify_jwt = false because SignalWire doesn't carry a Supabase
JWT; the signature check is the real auth.

Writes status, answered_at, ended_at, duration_sec into
public.calls via service-role client (RLS would block updates
on a row the webhook caller doesn't own). Always returns 204
to keep SignalWire's retry loop calm.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: signalwire-hangup edge function

**Files:**
- Create: `supabase/functions/signalwire-hangup/index.ts`

- [ ] **Step 1: Write the function**

```ts
// ============================================================
// supabase/functions/signalwire-hangup/index.ts
//
// Backs the dashboard's Hangup button. POSTs Status=completed
// to SignalWire's /Calls/{sid} endpoint, which tears down both
// legs of the bridge. Only the agent who owns the call can
// hang it up (enforced by checking agent_id against auth.uid()
// before forwarding to SignalWire).
//
// Required secrets: SIGNALWIRE_SPACE_URL, SIGNALWIRE_PROJECT_ID,
//                   SIGNALWIRE_API_TOKEN (same as bridge fn).
//
// Request (POST, JSON):
//   { call_sid: 'CA...' }
//
// Response 200: { ok: true }
// Response 401: { ok: false, error: 'unauthenticated' }
// Response 403: { ok: false, error: 'not_your_call' }
// Response 404: { ok: false, error: 'call_not_found' }
// Response 502: { ok: false, error: string }
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

  let userId: string;
  try {
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user?.id) return json({ ok: false, error: "unauthenticated" }, 401);
    userId = data.user.id;
  } catch {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }

  let body: { call_sid?: string };
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const sid = body.call_sid;
  if (!sid) return json({ ok: false, error: "call_sid required" }, 400);

  // ---- Verify the caller owns this call ----------------------
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
```

- [ ] **Step 2: Smoke-test syntax**

Run: `deno check supabase/functions/signalwire-hangup/index.ts 2>&1 | head -20`
Expected: no errors. (Skip if no local Deno.)

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/signalwire-hangup/index.ts
git commit -m "feat(signalwire-hangup): authed hangup endpoint for dashboard button

POSTs Status=completed to SignalWire's /Calls/{sid} REST
endpoint to tear down the bridge. RLS-style ownership check
(agent_id == auth.uid()) before forwarding to SignalWire so
agents can't drop each other's calls.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Deprecate signalwire-token

**Files:**
- Modify: `supabase/functions/signalwire-token/index.ts:1-36`

- [ ] **Step 1: Add deprecation banner to the file header**

Edit the file to replace the existing header block with the same content prefixed by a DEPRECATED notice. The exact replacement:

Find:
```ts
// ============================================================
// supabase/functions/signalwire-token/index.ts
//
// Mints a short-lived (1 hour) SignalWire browser JWT for the
```

Replace with:
```ts
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
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/signalwire-token/index.ts
git commit -m "chore(signalwire-token): mark deprecated, superseded by bridge

Browser-SDK path could not be made to dial PSTN out of our
ProducerStack space (Call Fabric requires SWML routing for
PSTN; we don't have that configured). Pivoted to REST agent-
bridge in signalwire-bridge. This file stays deployed for
two weeks of soak then gets removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Settings UI — agent_phone field

**Files:**
- Modify: `index.html` (renderCallingSettings function, around line 9800–9870)
- Modify: `index.html` (_renderAdminAssignments function, around line 9875–9994)
- Modify: `index.html` (Settings → Calling markup — the My Calling Settings card; search for `stg-cl-my-number` to find it)

- [ ] **Step 1: Find the My Calling Settings card markup**

Run: `grep -n "stg-cl-my-number\|stg-cl-my-subscriber" index.html`

Note the line numbers — you'll be adding a new row labeled "My phone" right after `stg-cl-my-subscriber` in the markup, and a corresponding `setVal('stg-cl-my-phone', ...)` call in `renderCallingSettings()`.

- [ ] **Step 2: Add the My phone row to the card markup**

In the card markup (HTML, near where `stg-cl-my-subscriber` is rendered), add a third row matching the existing pattern. Example structure (adjust to actual neighboring markup):

```html
<div class="stg-cl-row">
  <div class="stg-cl-lbl">My phone (where you pick up)</div>
  <div class="stg-cl-val mono">
    <a href="#" id="stg-cl-my-phone" class="stg-cl-edit-self" data-field="agent_phone"
       data-prompt="Your personal phone in E.164 (e.g. +14155550142). SignalWire will call this number first, then bridge you to the lead.">
      — not set —
    </a>
  </div>
</div>
```

(Match the exact wrapper classes used by the neighboring `stg-cl-my-subscriber` row — read 5–10 lines around it first.)

- [ ] **Step 3: Update renderCallingSettings to populate it**

Find this block in `renderCallingSettings()`:
```js
const callerId     = me.signalwire_caller_id     || '— not assigned —';
const subscriberId = me.signalwire_subscriber_id || '— not assigned —';
```

Replace with:
```js
const callerId     = me.signalwire_caller_id     || '— not assigned —';
const subscriberId = me.signalwire_subscriber_id || '— not assigned —';
const agentPhone   = me.agent_phone              || '— not set —';
```

And the existing `select` call:
```js
.select('signalwire_caller_id, signalwire_subscriber_id, monthly_minute_limit, is_admin')
```
becomes:
```js
.select('signalwire_caller_id, signalwire_subscriber_id, agent_phone, monthly_minute_limit, is_admin')
```

And add after the existing `setVal` calls:
```js
setVal('stg-cl-my-phone', agentPhone);
```

- [ ] **Step 4: Add an inline-edit handler for `stg-cl-edit-self` (self-edit on the My Calling Settings card)**

Locate the existing inline-edit handlers in `renderCallingSettings()` or _renderAdminAssignments — there's already a `tbody.querySelectorAll('.stg-cl-edit').forEach(...)` pattern. Mirror it for the new self-edit link. Pseudocode:

```js
document.querySelectorAll('.stg-cl-edit-self').forEach(a => {
  a.addEventListener('click', async (e) => {
    e.preventDefault();
    const field = e.currentTarget.dataset.field;
    const promptStr = e.currentTarget.dataset.prompt || 'New value';
    const current = e.currentTarget.textContent.replace(/^—.*—$/, '').trim();
    const raw = await _promptModal(promptStr, current);
    if (raw == null) return;
    const trimmed = raw.trim();
    let value = trimmed === '' ? null : trimmed;
    // E.164 normalize for the phone field
    if (field === 'agent_phone' && value) {
      const norm = toE164(value);
      if (!norm) { showToast('Must be a valid US phone number', '#dc2626'); return; }
      value = norm;
    }
    try {
      const { error } = await sb.from('agents').update({ [field]: value }).eq('id', currentAgent.id);
      if (error) throw error;
      showToast('Saved', '#10b981');
      await renderCallingSettings();
    } catch (err) {
      showToast(`Save failed: ${err.message || err}`, '#dc2626');
    }
  });
});
```

Place this block where the existing post-render handler-binding lives (search for where `.stg-cl-edit` event listener is bound).

- [ ] **Step 5: Add Agent Phone column to admin Agent Assignments table**

In `_renderAdminAssignments()`, locate:
```js
const { data, error } = await sb
  .from('agents')
  .select('id, display_name, email, signalwire_caller_id, signalwire_subscriber_id, monthly_minute_limit, is_admin');
```
Replace with:
```js
const { data, error } = await sb
  .from('agents')
  .select('id, display_name, email, signalwire_caller_id, signalwire_subscriber_id, agent_phone, monthly_minute_limit, is_admin');
```

In the `tbody.innerHTML = agents.map(a => {` template, add a new `<td>` for agent_phone after the subscriber-id column:

```html
<td class="mono">
  <a href="#" class="stg-cl-edit" data-field="agent_phone" data-prompt="Agent's personal phone in E.164 (e.g. +14155550142). SignalWire will call this number first to start the bridge.">${escapeHTML(a.agent_phone || '— assign —')}</a>
</td>
```

Also add the matching `<th>` to the table header (search for the existing `<th>` row in the admin table markup — likely just outside the IIFE in the static HTML).

In the inline-edit handler that processes admin-table edits (the existing `.stg-cl-edit` listener — already supports caller-ID normalization), add a parallel E.164 normalization branch for `agent_phone`:

Find:
```js
if (field === 'signalwire_caller_id' && value) {
  const normalized = toE164(value);
  if (!normalized) {
    showToast('Caller-ID must be a valid US phone number', '#dc2626');
    return;
  }
  value = normalized;
}
```

Add right after:
```js
if (field === 'agent_phone' && value) {
  const normalized = toE164(value);
  if (!normalized) {
    showToast('Agent phone must be a valid US phone number', '#dc2626');
    return;
  }
  value = normalized;
}
```

- [ ] **Step 6: Manual smoke test (after migration is applied — see Task 9)**

After 008_agent_phone.sql is run and the page is reloaded:
1. Open Settings → Calling
2. Verify "My phone (where you pick up)" row shows "— not set —"
3. Click the link, enter a US number like `262-310-9999`, confirm
4. Toast: "Saved"; row updates to `+12623109999`
5. As admin, verify the Agent Assignments table now has an "Agent Phone" column with the new value visible

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(calling-settings): add agent_phone field to Settings UI

My Calling Settings card now has a 'My phone' row where each
agent sets the number SignalWire will ring first when bridging
outbound calls (distinct from caller-ID, which is the lead-
facing number). Admin Agent Assignments table gets a parallel
'Agent Phone' column.

Both edits use the existing inline-prompt-modal pattern and
auto-normalize through toE164() before persistence. Backed by
agents.agent_phone (added in 008_agent_phone.sql).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Softphone IIFE — rewrite dial path, delete SDK code, add Realtime

**Files:**
- Modify: `index.html` lines ~7756–8194 (the softphone IIFE)

- [ ] **Step 1: Delete the SDK-loading machinery**

Find this block (around lines 7778–7793):
```js
  const NO_ANSWER_THRESHOLD_SEC = 15;      // ≤ this → auto-tag no_answer, no prompt
  // jsdelivr's +esm endpoint returns a single self-contained ES-module
  // bundle (deps inlined). We were previously using esm.sh, which
  // serves the SDK as a graph of separately-fetched submodules; Safari
  // is strict about CORS + MIME on every link in that chain and a
  // single bad hop kills the whole import with the cryptic
  // "Importing a module script failed." That bug is reproducible on
  // current Safari with esm.sh + @signalwire/js. jsdelivr +esm sidesteps
  // it entirely.
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@signalwire/js@3/+esm';

  // SDK lazy-loader. Bundle is ~200KB; we only fetch it on first real dial.
  let _sdkPromise = null;
  async function _loadSDK() {
    if (_sdkPromise) return _sdkPromise;
    _sdkPromise = (async () => {
      const mod = await import(SDK_URL);
      // @signalwire/js exports the factory under multiple names across
      // versions — normalize so the call site doesn't care.
      const SW = mod.SignalWire || mod.default || mod;
      if (typeof SW !== 'function') throw new Error('SignalWire export not callable');
      return SW;
    })();
    return _sdkPromise;
  }
```

Replace with:
```js
  const NO_ANSWER_THRESHOLD_SEC = 15;      // ≤ this → auto-tag no_answer, no prompt
  // SDK_URL + _loadSDK removed 2026-05-17: pivoted from the
  // @signalwire/js browser SDK to a REST agent-bridge flow.
  // See docs/superpowers/specs/2026-05-17-signalwire-agent-bridge-design.md
```

- [ ] **Step 2: Remove SDK state fields**

Find in the `state` object (around lines 7772–7775):
```js
    client: null,           // @signalwire/js Call Fabric client
    call: null,             // active call object
    callRowId: null,        // id of the public.calls row inserted on hangup
```
Replace with:
```js
    sw_call_sid: '',        // SignalWire CallSid returned by signalwire-bridge — used for hangup + webhook correlation
    callRowId: null,        // id of the public.calls row (now inserted by edge function, frontend reads back via Realtime)
```

- [ ] **Step 3: Replace `_realDial` with `_bridgeDial`**

Find the entire `async function _realDial(phoneE164) { … }` block (around lines 7867–7959).

Replace the whole function with:
```js
  // ── Real-dial path — REST agent-bridge ─────────────────────
  // POSTs to signalwire-bridge, which calls our agent_phone first
  // and bridges to the lead on answer. Subsequent state changes
  // (ringing → answered → completed) arrive via the Realtime
  // subscription wired in _initRealtime(); this function returns
  // immediately after the bridge call is placed.
  async function _bridgeDial(leadId) {
    let r;
    try {
      r = await sb.functions.invoke('signalwire-bridge', { body: { lead_id: leadId } });
    } catch (e) {
      return { ok: false, reason: 'network', detail: (e && e.message) || String(e) };
    }
    if (r.error)            return { ok: false, reason: 'invoke', detail: r.error.message || 'invoke failed' };
    if (!r.data)            return { ok: false, reason: 'empty',  detail: 'empty response' };
    if (!r.data.ok)         return { ok: false, reason: r.data.error || 'unknown', detail: r.data };
    if (!r.data.callSid)    return { ok: false, reason: 'no_sid', detail: 'response missing callSid' };
    state.sw_call_sid = r.data.callSid;
    return { ok: true };
  }
```

- [ ] **Step 4: Update `dial()` to call `_bridgeDial` instead of `_realDial`**

Find in `dial()` (around line 7990):
```js
    // Try the real path.
    const result = await _realDial(phoneE164);
    if (result.ok) return;
```
Replace with:
```js
    // Try the real path.
    const result = await _bridgeDial(leadId);
    if (result.ok) return;
```

Note: `_bridgeDial` takes `leadId` directly (the edge function looks up the lead's phone server-side), so the local `phoneE164` is now only used for the optimistic state display.

Also remove the `mic_permission` branch in `dial()`'s error handling (no longer relevant — no WebRTC):

Find:
```js
    if (result.reason === 'mic_permission') {
      showToast(String(result.detail || 'Microphone access required to make calls.'), '#dc2626');
      close();
      return;
    }
```
Delete those 5 lines entirely.

- [ ] **Step 5: Reset `sw_call_sid` on dial init and close()**

In `dial()`, find:
```js
    state.callRowId   = null;
    state.stubMode    = false;
    state.stubReason  = '';
```
Replace with:
```js
    state.callRowId   = null;
    state.sw_call_sid = '';
    state.stubMode    = false;
    state.stubReason  = '';
```

In `close()`, find:
```js
    if (state.call)   { try { state.call.hangup    && state.call.hangup();    } catch {} state.call   = null; }
    if (state.client) { try { state.client.disconnect && state.client.disconnect(); } catch {} state.client = null; }
    state.phase      = 'idle';
    state.leadId     = null;
    state.callRowId  = null;
```
Replace with:
```js
    state.phase       = 'idle';
    state.leadId      = null;
    state.callRowId   = null;
    state.sw_call_sid = '';
```

(The SDK client/call references are gone; just removing them.)

- [ ] **Step 6: Rewrite `hangup()` to call signalwire-hangup edge function**

Find the entire `function hangup() { … }` (around lines 8027–8052) — replace the SDK-hangup block with edge-function-hangup:

Find:
```js
    // End the live SDK call. In real mode the SDK's 'ended' event fires
    // onEnded for us; we also do local cleanup synchronously so stuck
    // connections don't leave the UI hanging on "On Call" forever.
    if (state.call) {
      try { state.call.hangup && state.call.hangup(); } catch (e) { console.warn('[softphone] hangup threw', e); }
    }
```
Replace with:
```js
    // Tell SignalWire to drop both legs of the bridge. Failure
    // here is non-fatal — agents can also just hang up on their
    // phone, and the webhook will catch the 'completed' event
    // either way. We still do local UI cleanup synchronously.
    if (state.sw_call_sid && !state.stubMode) {
      sb.functions.invoke('signalwire-hangup', { body: { call_sid: state.sw_call_sid } })
        .catch(e => console.warn('[softphone] hangup invoke threw', e));
    }
```

- [ ] **Step 7: Remove `toggleMute()`'s SDK forwarding**

Find:
```js
  function toggleMute() {
    state.muted = !state.muted;
    _render();
    // Forward to the SDK if a live call is running.
    if (state.call) {
      try {
        if (state.muted) (state.call.audioMute   || (()=>{})).call(state.call);
        else             (state.call.audioUnmute || (()=>{})).call(state.call);
      } catch (e) { console.warn('[softphone] mute SDK call failed', e); }
    }
  }
```
Replace with:
```js
  function toggleMute() {
    // Bridge mode: muting in-dashboard is purely cosmetic — the
    // audio path is on the agent's own phone. Use the phone's
    // mute. We toggle local state so the UI reflects the click,
    // but it doesn't affect the call.
    state.muted = !state.muted;
    _render();
  }
```

- [ ] **Step 8: Update `_logCall()` — frontend no longer inserts the row**

The bridge edge function now inserts the calls row on dial. The webhook fills in duration. Frontend `_logCall()` shouldn't insert anything in bridge mode — keep it only for the stub-mode fallback path that still needs a synthetic row.

Find:
```js
  async function _logCall() {
    if (state.stubMode) return;                           // no rows for simulated calls
    if (!state.targetE164) return;
    if (!currentAgent || !currentAgent.id) return;
    try {
      const { data, error } = await sb.from('calls').insert({
        agent_id:     currentAgent.id,
        lead_id:      state.leadId || null,
        direction:    state.direction,
        phone_from:   state.callerId || '',
        phone_to:     state.targetE164,
        started_at:   new Date(state.startedAt || Date.now()).toISOString(),
        ended_at:     new Date().toISOString(),
        duration_sec: state.durationSec || 0,
      }).select('id').maybeSingle();
      if (error) { console.warn('[softphone] log call failed', error.message); return; }
      state.callRowId = (data && data.id) || null;
    } catch (e) {
      console.warn('[softphone] log call threw', e);
    }
  }
```

Replace with:
```js
  // In bridge mode, the row is inserted server-side by signalwire-
  // bridge (so we have the CallSid before the webhook can fire),
  // and duration is filled in by the signalwire-call-status
  // webhook. _logCall() is a no-op in bridge mode — kept as a
  // placeholder for the outcome wiring below which still expects
  // it to exist.
  async function _logCall() {
    // No-op in bridge mode. See signalwire-bridge edge function.
    return;
  }
```

- [ ] **Step 9: Look up callRowId for `_applyOutcome`'s update**

`_applyOutcome` writes `outcome` onto the calls row by `state.callRowId`. Since we no longer insert client-side, fetch the id by `sw_call_sid` before the update.

Find:
```js
      // Persist the outcome on the calls row so admin reports can slice by
      // it. Best-effort — failure here doesn't block the UI flow.
      if (state.callRowId) {
        sb.from('calls').update({ outcome: status }).eq('id', state.callRowId).then(({ error }) => {
          if (error) console.warn('[softphone] outcome update failed', error.message);
        });
      }
```
Replace with:
```js
      // Persist the outcome on the calls row so admin reports can slice
      // by it. Update by sw_call_sid (set when the bridge call was
      // placed). Best-effort — failure here doesn't block the UI flow.
      if (state.sw_call_sid) {
        sb.from('calls').update({ outcome: status }).eq('sw_call_sid', state.sw_call_sid).then(({ error }) => {
          if (error) console.warn('[softphone] outcome update failed', error.message);
        });
      }
```

- [ ] **Step 10: Add Realtime subscription**

Add a new function inside the IIFE — paste it right before the `// ── Wire up DOM listeners` block (around line 8153):

```js
  // ── Realtime: react to webhook-driven calls-row updates ────
  // The signalwire-call-status edge function writes status,
  // answered_at, ended_at, duration_sec into the calls row
  // identified by sw_call_sid. Subscribing here lets the panel
  // flip phases without polling. Subscription is scoped to
  // this agent's own rows.
  let _realtimeChannel = null;
  function _initRealtime() {
    if (_realtimeChannel) return;
    if (!currentAgent || !currentAgent.id) return;
    _realtimeChannel = sb.channel('softphone-calls-' + currentAgent.id)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls',
          filter: `agent_id=eq.${currentAgent.id}` },
        ({ new: row }) => _onCallRowUpdate(row))
      .subscribe();
  }

  function _onCallRowUpdate(row) {
    // Only react to our active call.
    if (!row || !state.sw_call_sid || row.sw_call_sid !== state.sw_call_sid) return;
    const s = row.status;
    if (s === 'ringing') {
      if (state.phase === 'ringing-out') {
        // Optional sub-phase: "Connecting to lead…"; we keep
        // the same 'ringing-out' phase for visual continuity.
      }
    } else if (s === 'answered') {
      if (state.phase !== 'connected') {
        state.phase = 'connected';
        // Use server-supplied answered_at if present, else now.
        const ts = row.answered_at ? Date.parse(row.answered_at) : Date.now();
        state.startedAt = Number.isFinite(ts) ? ts : Date.now();
        state.durationSec = 0;
        if (state.timerHandle) clearInterval(state.timerHandle);
        state.timerHandle = setInterval(() => {
          state.durationSec = Math.floor((Date.now() - state.startedAt) / 1000);
          const tEl = _el('sp-timer');
          if (tEl) tEl.textContent = _fmtTimer(state.durationSec);
        }, 1000);
        _render();
      }
    } else if (s === 'completed' || s === 'busy' || s === 'failed'
            || s === 'no-answer' || s === 'canceled') {
      if (state.phase === 'idle' || state.phase === 'ended') return;
      _stopTimer();
      const wasConnected = (state.phase === 'connected');
      // Prefer server duration if available.
      if (typeof row.duration_sec === 'number') state.durationSec = row.duration_sec;
      state.phase = 'ended';
      _render();
      if (!wasConnected || state.durationSec < NO_ANSWER_THRESHOLD_SEC) {
        _applyOutcome('no_answer', { auto: true });
        setTimeout(close, 1200);
      }
    }
  }
```

- [ ] **Step 11: Initialize Realtime when softphone binds**

In the existing `_bindOnce()` function (around line 8156), add a call to `_initRealtime()` at the end:

Find:
```js
    document.querySelectorAll('#sp-outcome .sp-out-btn').forEach(btn => {
      btn.addEventListener('click', () => setOutcome(btn.dataset.outcome));
    });
  }
```
Replace with:
```js
    document.querySelectorAll('#sp-outcome .sp-out-btn').forEach(btn => {
      btn.addEventListener('click', () => setOutcome(btn.dataset.outcome));
    });
    // Wire up Realtime as soon as we have an authenticated agent.
    // currentAgent may not be set yet on first load; in that case
    // _initRealtime() short-circuits and the caller below re-tries
    // after login.
    _initRealtime();
  }
```

Also re-trigger `_initRealtime()` after login. Search for where `currentAgent` is assigned post-login (look for `currentAgent =` or a `loadAgent()` style function); after that assignment, call `softphone.initRealtime && softphone.initRealtime()`.

Expose it on the public surface:
Find:
```js
  return {
    dial, hangup, toggleMute, setOutcome, close, isAdmin,
    loadAdminFlag: _loadAdminFlag,
```
Replace with:
```js
  return {
    dial, hangup, toggleMute, setOutcome, close, isAdmin,
    loadAdminFlag: _loadAdminFlag,
    initRealtime:  _initRealtime,
```

- [ ] **Step 12: Manual smoke test (after Tasks 8 + 9 deploy work)**

Hard-reload the dashboard, then in the Console:
1. `softphone.dial('<some-lead-id>')` (or click Call on a real lead)
2. Expected: your `agent_phone` rings within a few seconds
3. Pick up — within ~1s the lead's phone should start ringing
4. Lead answers — panel flips to "On Call", timer starts ticking
5. Hang up from either side — panel flips to "Ended", a `calls` row exists with non-null `duration_sec`

If anything fails, the yellow stub banner should show the reason (the `_formatStubReason` helper added in `21aa32a` still works).

- [ ] **Step 13: Commit**

```bash
git add index.html
git commit -m "feat(softphone): rewrite dial path to use REST agent-bridge

Replaces the @signalwire/js browser-SDK calling path with a
Supabase edge function call to signalwire-bridge. Removes:
  - SDK_URL constant + _loadSDK()
  - _realDial() WebRTC path
  - Mic-permission flow (no browser audio now)
  - SDK client + call references on state
  - Mute SDK forwarding (mute happens on the agent's phone)
  - Client-side calls-row insert (edge function does it)

Adds:
  - _bridgeDial(leadId) — POSTs to signalwire-bridge
  - state.sw_call_sid — tracks the SignalWire CallSid for
    hangup + webhook correlation
  - _initRealtime() — subscribes to UPDATEs on public.calls
    filtered to agent_id=auth.uid(); reacts to the webhook
    writing status, answered_at, duration_sec
  - _onCallRowUpdate() — phase transition state machine
  - signalwire-hangup invocation from the Hangup button
  - Outcome update now keyed by sw_call_sid instead of row id

Diagnostic stub-banner from 21aa32a is preserved unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Push branch + deploy instructions for the user

This task produces deployment commands and a checklist — no code changes. The user runs these from their terminal.

- [ ] **Step 1: Push the branch**

```bash
git push origin feature/signalwire-telephony
```

- [ ] **Step 2: Output a single block the user can copy-run**

Print this exact block to the user, with the SIGNALWIRE_WEBHOOK_URL placeholder substituted with their actual Supabase project URL (find it in their `.env` or `supabase status` output):

```bash
# 1. Apply the schema migration (paste contents of data/sql/008_agent_phone.sql
#    into Supabase SQL Editor, OR run via CLI if linked):
supabase db push   # only if the project is linked locally

# 2. Deploy the three new edge functions + the deprecation header
#    on signalwire-token:
cd "/Users/tanner/Jace- Life Insurance"
supabase functions deploy signalwire-bridge
supabase functions deploy signalwire-call-status
supabase functions deploy signalwire-hangup
supabase functions deploy signalwire-token

# 3. In the dashboard:
#    Settings → Calling → My phone → enter your cell in E.164
#    (e.g. +1262XXXXXXX)
```

- [ ] **Step 3: Manual end-to-end verification**

The user clicks Call on a lead. Expected sequence:

| Time | What happens | Where to verify |
|---|---|---|
| t=0 | Click Call. Panel opens, header "Calling your phone…" | Dashboard |
| t≈2s | Your phone rings (caller-ID = your `signalwire_caller_id`) | Your phone |
| t≈X (you answer) | Panel header updates to "On Call" or stays "Calling…" briefly | Dashboard |
| t≈X+1s | Lead's phone rings (caller-ID = your `signalwire_caller_id`) | Lead's phone |
| t≈X+Y (lead answers) | Bridged conversation; timer ticks; panel says "On Call" | Both phones + dashboard |
| Hang up | Both phones drop within 1–2s; panel flips to "Ended"; outcome picker appears if duration ≥ 15s | Dashboard |
| t≈+1s after hangup | New row in `public.calls` with status=`completed`, duration_sec set | Supabase Table Editor |
| Same | SignalWire Voice Logs shows the call | producerstack.signalwire.com → Logs → Voice |

If anything in the chain fails, the yellow stub banner should show the failure reason verbatim.

---

## Self-review checklist (run after writing the plan)

**Spec coverage:**
- [x] Schema migration → Task 1
- [x] signalwire-bridge function → Task 2
- [x] signalwire-call-status function → Task 3
- [x] signalwire-hangup function → Task 4
- [x] signalwire-token deprecation → Task 5
- [x] Settings UI (agent_phone) → Task 6
- [x] Softphone IIFE rewrite (delete SDK, add Realtime, hangup wiring, outcome by sw_call_sid) → Task 7
- [x] Deploy instructions + manual end-to-end test → Task 8

**Placeholder scan:** No TBD/TODO/FIXME. All code blocks complete.

**Type consistency:** `sw_call_sid` (snake_case in DB, same snake_case in JS state) consistent across Tasks 2, 3, 4, 7. Edge function field names match column names: `agent_phone`, `status`, `answered_at`, `duration_sec`, `sw_call_sid`. The bridge function returns `callSid` (camelCase JSON convention) which the frontend stores into `state.sw_call_sid`.

**Out-of-scope reaffirmed:** No Phone Book tab, no Stripe, no number purchasing, no inbound calls, no recording. These are separate projects per the spec.
