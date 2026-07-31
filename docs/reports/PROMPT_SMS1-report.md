# PROMPT SMS-1 — The AI texting agent

**Completed 2026-07-31.** Prompt: `prompts/PROMPT_SMS1_ai_text_responder_CLAUDE_CODE.md`.
Schema: `20260806_sms_ai_responder.sql` (applied + verified).
Docs: `docs/sms-ai-responder.md`. Suite: **1527 passing, 0 failing** (+90).

## The two assumptions the prompt made, and what was actually there

Both were flagged before starting and both turned out as expected. The prompt
anticipated them ("verify it does all four, fix what's missing"), so I built
the missing halves rather than stopping.

**1. `messaging-timeout-sweep` is not a nudge sweeper.** It is a wallet safety
net: it finds `messages` rows whose hold never got a delivery receipt inside
`billing_config.message_dlr_timeout_hours` and calls `wallet_void` on them. It
reads no conversation, sends nothing, and is authenticated with
`WALLET_CRON_SECRET` because it moves money.

*Decision:* **new worker.** Bolting "text this consumer" onto it would put
outbound messaging inside a billing reconciler running hourly against
`wallet_void`, where a bug in the nudge path can strand a wallet hold. A test
asserts `messaging-timeout-sweep` never mentions `sms_nudges` and the new
sweeper never mentions `wallet_void`.

**2. The STOP path did two of the four required things.** It suppressed
(`dnc_list`, including the global fallback for a destination number we cannot
attribute to an agent) and it confirmed from the originating number. It closed
no conversation and cancelled no scheduled sends — **because before this round
there were no conversations and nothing was ever scheduled.**

*Decision:* **built the missing two.** `closeConversationForOptOut()` closes the
thread and cancels pending nudges. It runs **after** the `dnc_list` write, never
before: if it throws, the half that legally matters has already happened. A
test asserts that ordering.

## Part 1 — Conversation storage

`public.messages` and `public.inbound_messages` are **not replaced and not
migrated**. They stay the BILLING and PROVIDER records: `messages.hold_ledger_id`
is what `wallet_settle`/`wallet_void` resolve against, and
`inbound_messages.provider_event_id` carries the unique index that makes Telnyx
retries idempotent. Four new tables sit beside them:

| Table | What it is | RLS |
|---|---|---|
| `sms_conversations` | one thread per (agent, contact phone) | SELECT only |
| `sms_messages` | the thread, with `sent_by` (`ai`/`agent`/`system`/`lead`) | SELECT only |
| `sms_nudges` | scheduled follow-ups, one live per thread | SELECT only |
| `sms_ai_settings` | per-type wording preferences | **owner-writable** |

Keyed on the **phone, not the lead** — a text can arrive from somebody not in
the book yet, and the thread has to exist before the lead does.

`sms_ai_settings` is owner-writable because it holds wording, and nothing in it
can cause a message to be sent. `agent_id` is derived by trigger from
`auth.uid()`, never accepted from the client, and the 20-pair cap is a CHECK
constraint as well as an editor rule.

Verified in-database at apply time: 4 tables, **0 non-SELECT policies** on the
three, 4 policies on settings, kill switch true for all 9 agents, both key
unique indexes present.

## Part 2 — The responder

`sms-ai-respond`, called fire-and-forget by `messaging-inbound-webhook` with the
service role key as bearer — the same arrangement `voice-campaign-tick` uses for
`ai-call-start`, which is why it stays `verify_jwt = true` and is unreachable
from a browser. A second function rather than a branch because Telnyx needs a
fast 200 and a model call is not fast.

**The gate, in order** (`smsAiGate()`):

`stop_keyword` → `opted_out` → `no_consent` → `empty_message` →
`account_disabled` → `upgrade_required` → `conversation_closed` → `ai_muted` →
`type_disabled` → `no_lead`

The two that protect a **consumer** sit above every gate that protects the
business, deliberately: an agent whose plan lapsed must not thereby have a STOP
ignored. A test breaks each gate *and everything below it* and asserts the
higher answer still wins.

**The AI gate is not the send gate.** `runComplianceGate()` still runs on the
send. A test asserts the responder never touches the wallet — `sendMessageCore`
does that, so billing is byte-identical to a hand-typed message.

**Custom answers beat the model.** An unambiguous substring hit is sent
**verbatim with no model call**. Longest trigger wins; a genuine tie is
ambiguous and falls to the model with both as ground truth; **a blank trigger is
dropped, because every string contains the empty string** and one such row
would answer every message.

Model: `claude-haiku-4-5` via `_shared/anthropic-chat.ts` — the sibling of the
Gmail parser's `anthropic.ts` (same secret, same provider, extended with tools
and history rather than re-invented).

**Timing:** a reply goes out at any hour, because they texted us. Only
AI-initiated nudges obey quiet hours.

## Part 3 — Hot handoff

Two ways in: the model's `flag_for_agent` tool, and a **deterministic phrase
match** so a plain "can someone call me" is never missed because the model was
terse that day. Asking for the agent by first name counts.

SMS to `agents.transfer_number` through the platform path — a notification to
our customer, not marketing to a consumer, so it bypasses the compliance gate
and the wallet, the same treatment as the opt-out confirmation. **One per
conversation per 4 hours**, and `hot_alerted_at` is stamped **only on an actual
send**, so a failed alert does not consume the window.

In-app: a banner on the conversation and a badge count. The assistant keeps
talking — "Let me get {agent} for you" — rather than going silent.

## Part 4 — Nudges

8h / 24h / 48h / 7d **from the lead's last message** (not from the previous
nudge, which would turn "8h then 24h" into 8h and 32h). Each step independently
switchable, and **a step that is off is skipped, not a stop** — turning off 8h
must not silently disable 24h.

**Deferred, never dropped.** 9am–8pm lead-local, never Sunday — stricter than
`tcpa.ts` (8am–9pm) and not a replacement for it. Even the legal gate's own
`quiet_hours` refusal is treated as a deferral here.

Cancelled by lead reply, STOP, DNC, booking, mute, closed conversation or
disabled settings — and **every one is re-checked again at send time**, because
the cost of a missed cancellation is a text to somebody who told us to stop.

`sms-ai-nudge-sweep`, pg_cron **jobid 23**, every 10 minutes,
`SMS_AI_CRON_SECRET`, `verify_jwt = false`. Its model call carries **no tools** —
an unsolicited follow-up must not be able to book anything or raise an alert.

## Part 5 — Takeover and the conversation UI

The existing `#smsThreadModal`, extended. An **AI** chip on assistant messages,
**Auto** on system ones, and **nothing on a legacy outbound row**: those predate
`sent_by` and were by definition typed by a person, so labelling them "agent"
would be a claim the data does not support.

The thread reads `sms_messages` **and** the two legacy tables, de-duplicated by
the ids `sms_messages` points at — otherwise a conversation that predates this
round would appear to begin the day the feature shipped.

**Auto-mute:** `messaging-send-sms` is only ever reached by a person typing, so
a send there mutes the AI (`agent_takeover`) and cancels pending nudges.
`system` sends do not mute — that would silence the AI every time it
successfully booked somebody.

The per-conversation toggle goes through `sms-ai-manage`. **Turning it back on
cannot reopen a conversation an opt-out closed** — that would be an agent
clicking a toggle and thereby un-hearing a STOP — and it re-arms the follow-up
schedule that muting cancelled. 10-second poll, stopping when the modal closes
or the tab is hidden.

## Part 6 — Settings → SMS AI

Account switch, then thirteen tabs: the twelve campaign types plus **Default**
for conversations belonging to no campaign. Per tab: on/off, tone, length,
emojis, the four nudge steps, appointment length + label, and the pairs editor
with a plain-English explainer.

Defaults give a working responder with zero setup. A calm banner appears when
nobody in the book has text consent yet, so an agent cannot switch it on and
watch nothing happen.

## Verification

| Claim | Proof |
|---|---|
| Gate order incl. consent-refusal and STOP-before-AI | 50 unit tests, including one that breaks each gate and everything below it |
| Custom-pair matching | longest-wins, tie-is-ambiguous, blank-trigger-dropped, 20-cap |
| Nudge scheduling / cancellation math | offsets, skip-not-stop, defer-not-drop, Sunday, per-zone |
| Alert throttle | boundary cases at exactly 4h |
| Auto-mute | agent yes; ai/system/lead no |
| Browser ↔ server parity | `// <smsai-core>` vs `sms-ai-core.ts` over a shared table |
| Schema + RLS | applied and queried in-database |
| Auth posture | live probes (below) |
| Booking-tool payload → appointment row | structural: the shared parse/confirm path, `source='ai_text'`, never-null confirm status |

**Live probes after deploy:**

```
sms-ai-respond             {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}   verify_jwt on
sms-ai-manage              {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}   verify_jwt on
sms-ai-nudge-sweep         {"error":"unauthorized"}                 own check answering
messaging-inbound-webhook  {"error":"invalid_signature"}            own check, gate still off
```

**Synthetic end-to-end in production.** Created a synthetic lead (reserved test
number `+15550000001`), an `express_written` consent row, a conversation, an
inbound message and a custom-pair settings row; scheduled a nudge due
immediately; ran the sweeper live:

```
{"ok":true,"due":1,"sent":0,"deferred":0,"cancelled":0,"skipped":1,"failed":0}
```

`skipped` is `resolveTextingNumber` returning not-ok — which means **everything
before it passed**: the due query, all five cancellation re-checks, the quiet-
hours window, settings resolution, composition, and `runComplianceGate` (consent
found, not on DNC, inside TCPA hours). It stopped exactly where the prompt
predicted it might: *"if the texting number is not yet carrier-live, the send
may fail at the provider."* The agent has no number attached to the 10DLC
campaign yet — the open item carried over from the A2P round. **All synthetic
rows deleted and verified at zero.**

**What could not be proven live:** an actual model round-trip through
`sms-ai-respond`. Its auth compares the bearer against the deployed
`SUPABASE_SERVICE_ROLE_KEY`, which is set as a project secret whose value I
cannot read; the copy in `.env.local` is stale (a known trap) and the JWT from
`supabase projects api-keys` is not it either. Its real caller uses
`Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` — the same value — so webhook →
responder matches by construction, but I could not impersonate it from outside,
and I did not add a test-only bypass to make that possible.

**Untouched:** voice paths (`ai-call-start`, `ai-call-tools`, `ai-call-webhook`,
`voice-campaign-*`) have zero diff this round. `messaging-inbound-webhook` still
answers `invalid_signature`; the only `config.toml` change is the new
`[functions.sms-ai-nudge-sweep] verify_jwt = false` entry, with the reasoning
written above it.

---

# PENDING LIVE VERIFICATION

Nothing below can be proven without a real phone, and all of it is blocked on
the same one thing.

1. **🔴 Attach an SMS-capable number to the 10DLC campaign.** Until then every
   outbound AI text fails at `resolveTextingNumber` and nothing is sent. This is
   the same open item from the A2P round: `+12029981783` is the only number on a
   messaging profile and it has no campaign.
2. **The first real two-way text conversation** — a consented lead texts in, the
   assistant answers within seconds, the AI chip renders.
3. **The first real booking by text** — the assistant books, `ai_appointments`
   gets a `source='ai_text'` row, and the confirmation SMS arrives.
4. **The first real hot handoff** — a lead asks for a call and the alert lands on
   the agent's own cell.
5. **The first nudge actually going out**, and being cancelled by a reply.
6. **A real STOP mid-conversation** closing the thread and cancelling the nudge.

---

# 2-MINUTE EYEBALL CHECKLIST

| # | Do this | Expect |
|---|---|---|
| 1 | Hard-refresh. Settings → **SMS AI** | The panel loads. "Answer inbound texts automatically" is **on** |
| 2 | Look below the switch | If nobody has text consent yet, a calm banner says exactly that |
| 3 | Look at the type row | **13 chips** — Default plus the twelve campaign types. Green dot = answering |
| 4 | Click **Final Expense**, set tone Casual, length Medium, tick 48 hours | The sentence under the checkboxes updates to name the steps you picked |
| 5 | Untick **8 hours**, leave 24 hours on | It still says it follows up after 24 hours — turning one off does not kill the rest |
| 6 | **+ Add answer**, type `waiting period` → `Two years.`, press **Save** | "Saved" appears |
| 7 | Reload, come back to Final Expense | Your tone, steps and answer are still there |
| 8 | Add a blank row and Save | It disappears — a blank trigger would match every message |
| 9 | Add rows until it refuses | Stops at 20 with a toast |
| 10 | Leads → any lead with a mobile → **Text** | The thread opens. If there's no conversation yet, no AI bar — correct, there's nothing to say |
| 11 | Send one message by hand | It appears with no chip. Reopen → the bar reads **"AI replies are paused because you replied"** |
| 12 | Press **Turn AI back on** | Toast, and the bar flips to "AI replies are on for this conversation." |
| 13 | Leave the thread open ~15s | It refreshes by itself, nothing flickers |

No phone calls, no texts sent, nothing billed by any step above.

## Deliberately left

- **`inbound_messages.is_opt_out` is still read by nothing.** `dnc_list` remains
  the single enforcement point. Unchanged on purpose.
- **No MMS in the responder** — inbound media is threaded, the model gets text.
- **No shared "AI is typing" state** — the reply lands in seconds and a typing
  indicator on SMS is a fiction.
- **The nudge sweeper's model call carries no tools**, by design.
- **`sms-ai-respond` has no test-only auth bypass**, which is why the live model
  round-trip is on the pending list rather than proven.
