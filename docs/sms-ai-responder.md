# The AI texting agent — answers every inbound text

**Added 2026-07-31.** Prompt SMS-1. Schema: `20260806_sms_ai_responder.sql`.
Decisions: `supabase/functions/_shared/sms-ai-core.ts`, mirrored in the
`// <smsai-core>` block of `app.html`.
Write path: `_shared/sms-thread.ts`.
Functions: `sms-ai-respond`, `sms-ai-nudge-sweep`, `sms-ai-manage`; extensions
to `messaging-inbound-webhook` and `messaging-send-sms`.
Model client: `_shared/anthropic-chat.ts`.
Tests: `npm run test:ai` (`sms-ai-core.test.ts`, 50) and `npm run test:smsai`
(40).

Read `docs/texting-ui.md` first — this extends that surface, it does not
replace it.

## What it does

A lead with recorded SMS consent texts back. Within seconds the assistant
answers, using the agent's own wording where they have written some, booking
appointments into the same table the voice AI books into, and pulling the agent
in the moment the lead asks for a person. The agent can take over any
conversation at any time; the assistant steps back the moment they type.

## 🔴 The rule the whole thing is built around

**It never initiates.** Every path into `sms-ai-respond` starts with an inbound
message from somebody whose SMS consent is already recorded. The follow-up
nudges continue a conversation the lead started, and stop the instant they say
anything at all — including "stop".

## The gate, in order

`smsAiGate()` in `_shared/sms-ai-core.ts`. Reading down, the two refusals that
protect a CONSUMER sit above every refusal that protects the business — an
agent whose plan lapsed must not thereby have a STOP ignored.

| # | Refusal | When |
|---|---|---|
| 1 | `stop_keyword` | the body is an opt-out keyword |
| 2 | `opted_out` | a `dnc_list` row exists (agent-scoped or global) |
| 3 | `no_consent` | **hard gate** — no acceptable `consent_records` row |
| 4 | `empty_message` | nothing to answer |
| 5 | `account_disabled` | `agents.sms_ai_enabled` is false |
| 6 | `upgrade_required` | not Pro / Team Leader / admin |
| 7 | `conversation_closed` | the thread was closed by an opt-out |
| 8 | `ai_muted` | the agent took over, or switched it off |
| 9 | `type_disabled` | this campaign type's settings say no |
| 10 | `no_lead` | we could not match a lead |

A test breaks each one *and everything below it* and asserts the higher answer
still wins.

**The gate is not the send gate.** `runComplianceGate()` still runs on the send
itself, exactly as it does for a broadcast or a hand-typed message. The consent
check above is an earlier and stricter refusal — do not read it as a
replacement and do not remove the later one.

## Custom answers beat the model

Up to 20 `{trigger, answer}` pairs per campaign type. A **case-insensitive
substring pre-match runs first**, and on an unambiguous hit the answer is sent
**verbatim with no model call at all**. An agent who wrote "our waiting period
is two years" wants those words, not a friendly approximation.

- **The longest trigger wins** — "price list" is more specific than "price".
- **A genuine tie is ambiguous** and falls through to the model with both as
  ground truth. Picking one arbitrarily would make the same question get
  different answers depending on the order the rows were typed.
- **A blank trigger is dropped.** Every string contains the empty string, so
  one blank row would answer every message. That is the bug, not tidying, and
  the editor drops them exactly as the server does — a parity test compares.

Whatever does not pre-match goes to the model with all the pairs supplied as
authoritative ground truth.

## Identity and compliance

One persona, two channels. `agents.ai_agent_name` + the agency name, introduced
as **"an assistant"** — the established wording. A blank `ai_agent_name` stays
blank; nothing invents a name the agent did not choose.

**The compliance paragraph in `buildSystemPrompt()` is not style and must not
be edited for tone.** It carries the same rule the voice assistant carries: if
anyone asks whether this is a real person, answer *immediately and plainly*
that it is an **automated assistant**. Plus: never argue with an opt-out, never
guarantee coverage or a rate, never state a premium as fact unless it appears
verbatim in the agent's own answers. A test asserts all four survive every
combination of tone and emoji settings.

## Booking by text

The **same machinery** voice uses, not a copy of it: `parseAppointmentTime()`
decides the instant from the lead's own words, `ai_appointments` is the row,
`buildConfirmSms()` writes the confirmation. `source = 'ai_text'`,
`ai_call_id` null, `sms_conversation_id` set.

The model passes the lead's **words**, never a parsed timestamp — the model is
a bad clock and `parseAppointmentTime()` is a tested one. `sms_confirm_status`
is never null on success or failure, the same rule the voice path keeps. A
booked conversation cancels its nudges and mutes the AI (`booked`).

## Hot handoff

Two ways in, deliberately: the model's `flag_for_agent` tool, and a
**deterministic phrase match** so a plain "can someone call me" is never missed
because the model was terse. Asking for the agent by first name counts.

The alert is an SMS to `agents.transfer_number` through the platform path — a
notification to our customer, not marketing to a consumer, so it does not go
through the compliance gate and is not billed to their wallet, the same
treatment as the opt-out confirmation. **Throttled to one per conversation per
4 hours**, and `hot_alerted_at` is stamped **only on an actual send**, so a
failed alert does not consume the window.

The assistant then keeps the conversation warm — "Let me get {agent} for you" —
rather than going silent.

## Quiet-lead nudges

8h / 24h / 48h / 7d after **the lead's last message**, each step independently
switchable. Measuring from the previous nudge instead would turn "8h then 24h"
into a message at 8h and another at 32h.

**A step that is off is SKIPPED, not a stop.** Turning off 8h must not silently
disable 24h behind it.

**Deferred, never dropped.** AI-initiated messages obey 9am–8pm in the lead's
zone, never Sunday — stricter than the legal gate in `_shared/tcpa.ts` (8am–9pm)
on purpose, and not a replacement for it: `runComplianceGate` still runs
underneath. Outside the window the nudge's `due_at` moves forward; even the
legal gate's own `quiet_hours` refusal is treated as a deferral here.

Cancelled by any lead reply, STOP, DNC, booking, mute, closed conversation or
switched-off settings — and **every one of those is re-checked again at send
time**, because the cost of a missed cancellation is a text to somebody who
told us to stop.

### 🔴 Why this is a new worker

The brief said to reuse `messaging-timeout-sweep` "if that is what it exists
for". **It is not.** That function is a wallet safety net: it finds `messages`
rows whose hold never got a delivery receipt and calls `wallet_void` on them.
It reads no conversation, sends nothing, and is authenticated with
`WALLET_CRON_SECRET` because it moves money. Bolting outbound messaging onto it
would put "text this consumer" inside a billing reconciler running hourly
against `wallet_void`, where a bug in one path can strand a hold in the other.
A test asserts `messaging-timeout-sweep` never mentions `sms_nudges` and the
nudge sweeper never mentions `wallet_void`.

`sms-ai-nudge-sweep` runs every 10 minutes (pg_cron jobid 23) with
`SMS_AI_CRON_SECRET`, and is `verify_jwt = false` in `config.toml` so its own
check is the one that answers.

## STOP — the two obligations that were missing

The brief asked to verify the STOP path did four things. **It did two.** It
suppressed (`dnc_list`, including the global fallback for a number we cannot
attribute) and it confirmed from the originating number. It closed no
conversation and cancelled no scheduled sends **because neither existed**.

Both now exist, so both are discharged, in `closeConversationForOptOut()`. Note
the ordering: it runs **after** the `dnc_list` write, never before. If the close
throws, the half that legally matters has already happened. A test asserts that
ordering.

## Takeover

`messaging-send-sms` is only ever reached by a person typing — the AI sends
through `sms-ai-respond` and the sweeper. So a send there means the agent has
stepped in: the AI mutes itself (`agent_takeover`) and pending nudges are
cancelled. **`system` sends are not a takeover** — muting on our own booking
confirmations would silence the AI every time it succeeded.

The per-conversation toggle goes through `sms-ai-manage` (agent from the JWT).
`sms_conversations` is SELECT-only for the browser; an AI that answers a
consumer on the agent's behalf is not something a page reconfigures with a
PATCH. **Turning it back on cannot reopen a conversation an opt-out closed** —
that would be an agent clicking a toggle and thereby un-hearing a STOP — and it
re-arms the follow-up schedule that muting cancelled.

## What the screen shows

The existing per-lead thread (`#smsThreadModal`), extended — not a second
inbox. An **AI** chip on assistant messages, **Auto** on system ones, and
nothing on a legacy outbound row: those predate `sent_by` and were by
definition typed by a person, so labelling them "agent" would be a claim the
data does not support. A bar saying whether the AI is on and *why* it is off, a
hot banner, and a 10-second poll that stops when the modal closes or the tab is
hidden.

Settings → **SMS AI**: an account switch, then per-campaign-type tabs (the same
twelve, plus Default for conversations that belong to no campaign) with tone,
length, emojis, the four nudge steps, appointment length and label, and the
pairs editor. Defaults are chosen so an agent who never opens the screen has a
working responder on day one.

## Deliberately left

- **`inbound_messages.is_opt_out` is still read by nothing.** `dnc_list`
  remains the single enforcement point. Unchanged on purpose.
- **No MMS handling in the responder.** Inbound media is threaded but the model
  is given the text only.
- **The nudge sweeper's model call carries no tools** — an unsolicited
  follow-up must not be able to book anything or raise an alert.
- **No per-conversation "AI is typing" state.** The reply lands in seconds and a
  typing indicator on SMS is a fiction.
