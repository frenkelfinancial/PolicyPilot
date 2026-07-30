# AI inbound answering — webhook routing

**Decision date:** 2026-07-30
**Decision:** handle AI-inbound inside the EXISTING Call Control application and
its EXISTING webhook. **No remote Telnyx configuration was changed — none was
needed.**

Read this before touching anything that receives Telnyx call events. The single
biggest risk in this feature was sending the power dialer's events somewhere
new; the whole point of what follows is that nothing moved.

---

## The live configuration, as inspected (not assumed)

Read from the Telnyx API on 2026-07-30 before any code was written.

### Call Control applications — there is exactly one

| id | name | webhook_event_url | failover | active |
|---|---|---|---|---|
| `2983088288312592018` | ProducerStack Dialer | `…/functions/v1/telnyx-call-status` | *(none)* | yes |

### Connections

| id | name | type |
|---|---|---|
| `3012111439746827472` | Default | credential_connection |
| `2983184575246632377` | Producer Stack Browser | credential_connection |
| `2983062206326768808` | Forward Only | credential_connection |

### Numbers → application

| number | connection | in `public.phone_numbers`? | role |
|---|---|---|---|
| `+12029981783` | ProducerStack Dialer | yes (Jace, primary) | **AI dialer outbound caller ID → the AI-inbound number** |
| `+12026143091` | ProducerStack Dialer | yes (Jace) | second number |
| `+12027953507` | ProducerStack Dialer | yes | another agent |
| `+12027437798` | ProducerStack Dialer | yes | another agent |
| `+12027718346` | ProducerStack Dialer | yes | another agent |
| `+12027428855` | ProducerStack Dialer | yes | another agent |
| `+19207094998` | ProducerStack Dialer | yes | another agent |
| `+12625099123` | ProducerStack Dialer | **no** | **power-dialer host** (`TELNYX_DIALER_NUMBER`) |
| `+12029703699` | Producer Stack Browser | **no** | shared browser caller ID |

---

## What already happens to an inbound call

`telnyx-call-status` receives `call.initiated` for **every** inbound call on the
ProducerStack Dialer app, and does exactly one thing with it:

```
isDialerCall = (direction is incoming) && (!dialerNorm || to === TELNYX_DIALER_NUMBER)
   true  -> answer the leg, client_state {role:'dialer_ivr'}  (the PIN IVR)
   false -> return "ok"        <-- the call rings out. Nothing happens.
```

So **inbound to any number other than the power-dialer host is already a no-op**.
That `false` branch is the seam this feature slots into, and it is why no
routing had to move.

> `TELNYX_DIALER_NUMBER` **is set** (confirmed present as a Supabase secret). It
> matters: had it been unset, `!dialerNorm` would be true and *every* inbound
> call would be swallowed by the PIN IVR. The AI-inbound guard is placed AFTER
> the existing dialer check and can never run for the host number.

---

## The decision

**Keep one application, one app-level webhook. Add one guarded branch.**

Rejected alternative: a **second Call Control application** for AI-inbound
numbers. It would have required moving `+12029981783` off the ProducerStack
Dialer app — and that number is the AI dialer's outbound caller ID, dialed with
`connection_id = 2983088288312592018`. Telnyx requires the `from` number to
belong to the connection placing the call, so moving it breaks every outbound AI
call unless the connection id changes too. Trading a working outbound feature
for tidier inbound routing is not a trade worth making.

### After (the only change)

| what | before | after |
|---|---|---|
| Call Control app webhook | `telnyx-call-status` | **unchanged** |
| number → app assignment | as above | **unchanged** |
| power dialer inbound (`+12625099123`) | `telnyx-call-status` → PIN IVR | **unchanged** |
| power dialer outbound legs | per-call `webhook_url` → `telnyx-call-status` | **unchanged** |
| outbound AI legs | per-call `webhook_url` → `ai-call-webhook` | **unchanged** |
| **AI-inbound `call.initiated`** | `telnyx-call-status` → *no-op* | `telnyx-call-status` → **new guard** → `_shared/ai-inbound.ts` |
| **every AI-inbound event after that** | — | **`ai-call-webhook`**, via a per-call `webhook_url` override |

### Why later events leave the shared webhook

`POST /calls/{id}/actions/answer` accepts **`webhook_url`** — *"override the URL
for which Telnyx will send subsequent webhooks to for this call"* (verified in
the published OpenAPI spec). The agent leg we dial takes the same override, the
way outbound already does.

So `telnyx-call-status` sees an AI-inbound call **exactly twice**: the initial
`call.initiated`, and a pre-answer `call.hangup` if the caller gives up while
the agent's phone is ringing. Everything after the answer — `call.answered`,
the assistant's conversation events, insights, `call.hangup`, finalize and the
wallet debit — lands on `ai-call-webhook`, which already knows how to do all of
it. **No billing, finalize or outcome logic is duplicated.**

That is also what makes the answer itself the whole AI path: answering with
`client_state = {role:'ai_call', ai_call_id, vars}` and the webhook override
makes an inbound call indistinguishable from an answered outbound one from that
instant on, so `startAssistant()`, the greeting ladder, the insight parser and
the single-debit finalize all apply unchanged.

---

## The guard, precisely

In `telnyx-call-status`, placed **after** the existing dialer-IVR block so it can
never intercept it:

1. event is `call.initiated`, and
2. `direction` is incoming, and
3. the called number is **not** `TELNYX_DIALER_NUMBER`, and
4. the called number resolves to a `public.phone_numbers` row with
   `ai_inbound_enabled = true` and `status = 'active'`.

Anything failing any of those four falls through to the existing code path,
byte-for-byte as before. A number is opted in one row at a time; the migration
defaults it TRUE for exactly one number — `+12029981783`, Jace's primary and the
AI dialer's caller ID — and FALSE everywhere else, including for every other
agent on the platform.

## Known gap, deliberately not closed

`telnyx-call-status` does **not** verify the Telnyx Ed25519 signature — it never
has, and it is `verify_jwt = false`, so it is an unauthenticated endpoint. The
AI-inbound branch inherits that posture. Adding verification there is a change
to the power dialer's own auth path and is out of scope for this round; the
branch's blast radius is bounded by the four conditions above (a forged
`call.initiated` could at most cause one agent-leg dial to a number the agent
themselves configured). Worth closing separately, for the whole function at
once. `ai-call-webhook`, which receives everything after the answer, **does**
verify the signature.

---

## Pre-live verification (2026-07-30)

The live phone tests were deferred to a single batch session, so everything
provable without a ringing phone was proved first. What follows is what was
actually run, not what was intended.

### Against production, with real side effects checked

| Check | Result |
|---|---|
| Synthetic `call.initiated` → **non-enabled** number (`+12026143091`) | ignored — no `ai_calls` row, no lead, no trace row |
| Synthetic `call.initiated` → **power-dialer host** (`+12625099123`) | ignored by the AI branch |
| Synthetic `call.initiated` → **enabled** number, agent **Busy** | full chain ran: guard passed → agent resolved → unknown caller written to the book (`inbound-5550004444`, `tcpa_consent=false`, blank name) → `ai_calls` row `direction=inbound`, `transfer_status='none'` → answer attempted |
| …and the answer | rejected by Telnyx `90015 Invalid Call Control ID` — the *only* possible failure for a synthetic id, and handled cleanly: `answered_by='none'`, `status='error'`, `error_detail` recorded |
| **No agent phone was dialed on the Busy branch** | `transfer_status='none'`, no dial in the trace |
| Post-deploy JWT gates | `telnyx-call-status` 200 `ok`; `ai-call-webhook` `{"error":"invalid_signature"}`; `ai-call-tools` `{"error":"invalid_secret"}` — each function's OWN check answering, so the platform gate is still off on all three |
| Post-deploy Telnyx config | ONE app, webhook still `telnyx-call-status`, 8 numbers on ProducerStack Dialer + 1 on Browser — **identical to the before map above** |

All synthetic rows were deleted afterwards and availability restored.

So in production the routing, the guard, the schema, the secrets, agent
resolution, lead creation and branch selection are all confirmed. What a
synthetic `call_control_id` can never exercise is Telnyx's own behaviour from
the answer onwards — see PENDING LIVE VERIFICATION in the round report.

### Against the code, in tests

`ai-inbound-flow.test.ts` drives `startInboundIfEnabled()` with a fake Supabase
client and a fake `fetch`, asserting the exact Telnyx requests each branch
would issue: Busy answers and never dials; Available dials with AMD + 15s and
**does not answer the caller**; a rejected `from_display_name` retries without
it; a failed dial falls back to the AI; the guard refuses the dialer host, a
non-opted-in number, a disabled agent and any outbound leg.
`ai-inbound-webhook.test.ts` guards the parts that live inside `serve()` and
cannot be imported — the direction-scoped rate split, the idempotent human
settlement, answering before bridging, the two atomic `answered_by` claims, and
the inbound transfer refusal.
