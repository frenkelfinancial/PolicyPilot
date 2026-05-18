# SignalWire Agent-Bridge Calling — Design Spec

**Date:** 2026-05-17
**Branch:** `feature/signalwire-telephony`
**Supersedes:** browser-SDK path (`@signalwire/js` + Call Fabric Subscriber Tokens) from Phases A + B

---

## Background

The original telephony stack (commits `5c221cb`, `732199a`, `ca243ac`, `bcd72db`, `4c6db35`) used the SignalWire Call Fabric browser SDK to place WebRTC calls from inside the dashboard. After ~6 hours of debugging across 4 different fixes (wrong space URL secret, stale deployed function, esm.sh Safari import failure, jsdelivr swap), the failure pattern stabilized: token mint works, SDK loads, `client.dial()` resolves, but no `active`/`ended` event ever fires — Call Fabric accepts the dial without routing it to PSTN. The space requires SWML-script routing for outbound PSTN, which is a non-trivial restructure on the SignalWire side.

Rather than continue fighting Call Fabric, we pivot to SignalWire's REST-based agent-bridge flow. This eliminates the browser SDK, WebRTC, mic permissions, Subscriber resources, and SWML routing entirely.

## Goal

When an agent clicks **Call** on a lead, SignalWire calls the agent's personal phone first; on answer, bridges that call to the lead's phone. No browser audio, no SDK, no Safari edge cases.

## Architecture

```
[Agent clicks Call]
     │
     ▼
softphone.dial(leadId)
     │ POST { lead_id }
     ▼
┌─────────────────────────────────────┐
│ Edge: signalwire-bridge              │
│  • verify Supabase JWT               │
│  • load agent.agent_phone,           │
│        agent.signalwire_caller_id,   │
│        agent.monthly_minute_limit    │
│  • load lead.phone                   │
│  • sum month's call duration; 429    │
│    if cap exceeded                   │
│  • POST https://{space}/api/laml/    │
│    2010-04-01/Accounts/{pid}/        │
│    Calls.json                        │
│      From=caller_id                  │
│      To=agent_phone                  │
│      Twiml=<Response><Dial           │
│        callerId="{caller}"><Number>  │
│        {lead_phone}</Number></Dial>  │
│        </Response>                   │
│      StatusCallback=…/signalwire-    │
│        call-status                   │
│      StatusCallbackEvent=initiated   │
│        ringing answered completed    │
│  • insert calls row (status=         │
│    'initiated', sw_call_sid=sid)     │
└────────────┬────────────────────────┘
             │ { ok, callSid }
             ▼
       [Agent's phone rings]
             │ Agent answers
             ▼
    [SignalWire executes TwiML]
             │ Dials lead's number
             ▼
       [Lead's phone rings]
             │ Lead answers → bridged
             │ Either hangs up
             ▼
┌──────────────────────────────────────┐
│ SignalWire POSTs StatusCallback       │
│   form-urlencoded body:              │
│     CallSid, CallStatus,             │
│     CallDuration (final only),       │
│     X-SignalWire-Signature header    │
└────────────┬─────────────────────────┘
             ▼
┌──────────────────────────────────────┐
│ Edge: signalwire-call-status         │
│  • PUBLIC (verify_jwt = false)       │
│  • validate X-SignalWire-Signature   │
│    via shared secret HMAC            │
│  • update calls row by sw_call_sid:  │
│    status, answered_at, ended_at,    │
│    duration_sec                      │
│  • return 204                        │
└────────────┬─────────────────────────┘
             ▼
[Supabase Realtime fires row update]
             ▼
   [Dashboard panel re-renders new
    phase, timer, outcome picker]
```

## Data model

### Schema migration `data/sql/008_agent_phone.sql`

```sql
-- agents: where this agent answers when calls are bridged in
alter table public.agents
  add column if not exists agent_phone text;

comment on column public.agents.agent_phone is
  'E.164 personal phone where the agent picks up bridged outbound calls. Distinct from signalwire_caller_id (the number the lead sees). Set in Settings → Calling → My phone.';

-- calls: track full lifecycle via SignalWire StatusCallback webhooks
alter table public.calls
  add column if not exists status text default 'initiated'
    check (status in (
      'initiated','ringing','answered',
      'completed','busy','failed','no-answer','canceled'
    )),
  add column if not exists answered_at timestamptz;

comment on column public.calls.status is
  'Latest SignalWire CallStatus received via webhook. Transitions: initiated → ringing → answered → completed (happy path).';
comment on column public.calls.answered_at is
  'Timestamp when the lead leg of the bridge was answered. Frontend timer counts up from here.';

-- enable Realtime so the softphone panel reacts to webhook arrivals
alter publication supabase_realtime add table public.calls;
```

No new tables. Existing `calls` RLS policies cover the new columns automatically.

## Edge functions

| Function | Auth | Lines | Purpose |
|---|---|---|---|
| `signalwire-bridge` | Supabase JWT required (`verify_jwt = true`) | ~120 | Place the bridge call via SignalWire LaML REST. Inserts `calls` row. Returns `callSid`. |
| `signalwire-call-status` | Public (`verify_jwt = false`); validates SignalWire HMAC signature | ~80 | Receives StatusCallback POSTs. Updates `calls` row by `sw_call_sid`. |
| `signalwire-hangup` | Supabase JWT required | ~50 | Hangup-button handler. POSTs `Status=completed` to `/Calls/{sid}`. RLS-protected — only the agent who owns the call can hang it up. |

### Secrets (Supabase Edge Function env)

Existing (already set):
- `SIGNALWIRE_SPACE_URL` (e.g. `producerstack.signalwire.com`)
- `SIGNALWIRE_PROJECT_ID`
- `SIGNALWIRE_API_TOKEN`

New: **none.** We use SignalWire's native `X-SignalWire-Signature` HMAC scheme (see "Open questions" #1), which is signed with the existing `SIGNALWIRE_API_TOKEN`. No additional secret needed.

### Deprecated
- `signalwire-token` — no longer invoked. Leave deployed for two weeks; add deprecation header comment; remove in cleanup PR.

## Frontend changes (`index.html`)

### `softphone` IIFE (lines ~7756–8194)

**Delete:**
- `SDK_URL`, `_loadSDK()`
- `_realDial()`'s mic-permission and SDK-load steps
- `state.client`, `state.call`, all `call.on(...)` event wiring
- `import('https://cdn.jsdelivr.net/...')` dynamic import

**Rewrite `_realDial()` → `_bridgeDial()`:**
```js
async function _bridgeDial(leadId) {
  const r = await sb.functions.invoke('signalwire-bridge', { body: { lead_id: leadId } });
  if (r.error || !r.data?.ok) return { ok: false, reason: r.data?.error || 'invoke', detail: r.error || r.data };
  state.sw_call_sid = r.data.callSid;
  // Realtime subscription will drive subsequent phase transitions.
  return { ok: true };
}
```

**Add Realtime subscription** (mounted once when softphone IIFE initializes, kept alive while signed-in):
```js
sb.channel('softphone-calls')
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'calls',
        filter: `agent_id=eq.${currentAgent.id}` },
      ({ new: row }) => _onCallRowUpdate(row))
  .subscribe();
```

`_onCallRowUpdate` maps `row.status` → `state.phase` and `row.duration_sec` → `state.durationSec`, triggers `_render()`.

**New phase labels:**
- `dialing` → "Calling your phone…"
- `ringing-lead` → "Connecting to lead…" (after agent answers, before lead picks up)
- `connected` → "On Call" (lead answered, bridged)
- `ended` → "Call Ended"

**Hangup button:**
```js
async function hangup() {
  if (state.sw_call_sid) {
    await sb.functions.invoke('signalwire-hangup', { body: { call_sid: state.sw_call_sid } });
  }
  // local cleanup unchanged
}
```

**Keep & reuse:**
- State machine shape
- Panel UI markup (`#softphone-panel`)
- `_formatStubReason()` and diagnostic banner (still surfaces edge-function errors)
- Outcome picker → `setLeadStatusQuick()` → calls row update flow

### Settings UI (Settings → Calling card)

- **My Calling Settings** card: add a third row "**My phone (where you pick up)**" — same inline-edit pattern as caller-ID, with E.164 normalization via `toE164()`
- **Agent Assignments** admin table: add **Agent Phone** column with the same inline-edit handler

## Error handling

| Condition | HTTP | User-facing |
|---|---|---|
| Agent row missing `agent_phone` or `signalwire_caller_id` | 409 `not_assigned` | Toast: "Set your phone number in Settings → Calling" |
| Monthly minute cap exceeded | 429 `minute_cap_exceeded` | Toast: "Out of minutes this month (X/Y)" |
| Lead has no valid phone | (frontend short-circuit) | Toast: "No valid phone number for this lead" |
| SignalWire REST 4xx/5xx | 502 with `error` | Yellow diagnostic banner with reason |
| `signalwire-call-status` invalid signature | 401 (silent) | None — SignalWire retries per its policy |
| `signalwire-call-status` unknown `sw_call_sid` | 204 | None — ignore (don't break SignalWire's retry loop) |
| `signalwire-hangup` for call where `agent_id != auth.uid()` | 403 | Toast: "Can't hang up that call" |

## Testing strategy

- **Edge functions:** `curl` smoke tests with fixture bodies + one end-to-end manual call placed through the real ProducerStack space.
- **Webhook signature validation:** unit test against a known-good `X-SignalWire-Signature` example from SignalWire's docs.
- **Frontend:** click Call, verify your phone rings ≤ 3s, verify lead's phone rings on answer, verify panel `status` transitions land ≤ 1s after each SignalWire event, verify outcome picker appears on calls ≥ 15s.
- **Minute cap:** set `agents.monthly_minute_limit = 1`, attempt second dial, confirm 429.
- **Hangup:** start a call, click Hangup in dashboard, verify both phones drop within ~2s.

## Out of scope

- **Inbound calls** — the existing `ringing-in` stub stays in the IIFE, non-functional. Inbound is Phase C, separate project.
- **Phone Book tab (Project #2)** — read-only directory of firm-owned numbers + per-agent usage. Separate brainstorm.
- **Buy phone numbers in-CRM (Project #3)** — SignalWire inventory search + Stripe reseller checkout. Separate brainstorm + multi-week project.
- **Buy minute packs in-CRM (Project #4)** — Stripe-billed minute reselling. Separate brainstorm + multi-week project.
- **Call recording / transcription** — not requested, not built.
- **Multi-line, transfer, conference** — single-line only.

## Open questions (resolved before implementation)

1. **Webhook signature mechanism.** SignalWire's REST API supports both their own LaML-compatible signature header (HMAC-SHA1 of full URL + sorted body params, with the SignalWire account auth token as key) and arbitrary custom params. We use SignalWire's native signature scheme since it's already what their servers send — no extra config needed in their dashboard. Validation pseudo-code:
   ```ts
   const expected = hmacSha1Base64(
     SIGNALWIRE_API_TOKEN,
     fullUrl + sortedFormParams.map(([k,v]) => k+v).join('')
   );
   if (expected !== req.headers.get('x-signalwire-signature')) return 401;
   ```

2. **Bridge mechanism.** Inline TwiML in the `Twiml` body parameter (no hosted SWML resource needed). Keeps the entire flow self-contained in our edge function; no SignalWire-dashboard configuration changes.

3. **Caller-ID format mismatch.** Some SignalWire spaces reject `<Dial callerId="...">` if the caller-ID is not a verified number on the account. We rely on the `signalwire_caller_id` column always being a number the firm owns on the same SignalWire project — this is already enforced by the admin "Agent Assignments" UI which prompts for E.164 numbers from the project. No additional check needed at runtime.

## Files touched

| Path | Change |
|---|---|
| `data/sql/008_agent_phone.sql` | NEW — schema migration |
| `supabase/functions/signalwire-bridge/index.ts` | NEW — place bridge call |
| `supabase/functions/signalwire-call-status/index.ts` | NEW — webhook receiver |
| `supabase/functions/signalwire-hangup/index.ts` | NEW — hangup button handler |
| `supabase/functions/signalwire-token/index.ts` | EDIT — deprecation header comment |
| `index.html` | EDIT — rewrite softphone IIFE, Settings → Calling additions |

## Estimated effort

- Schema migration: 15 min
- 3 edge functions: ~3 hours total
- Frontend rewrite: ~3 hours (rewrite is mostly deletion; Realtime wiring is new)
- Settings UI: ~30 min
- Local testing + deploy + end-to-end smoke test with real call: ~1 hour
- **Total: ~8 hours of focused work.** Realistically across one focused session today.

## User-side prerequisites (one-time)

After this code lands and is deployed, the user must:
1. Run `008_agent_phone.sql` in Supabase SQL Editor (or `supabase db push`)
2. `supabase functions deploy signalwire-bridge signalwire-call-status signalwire-hangup`
3. In Settings → Calling, fill in their `agent_phone` (their actual cell number)
