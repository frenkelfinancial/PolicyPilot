# AI Sales Agent — Assistant Script (life-insurance qualification)

The system prompt for the Telnyx AI Assistant that Phase 1 dials.

> **This file is the source of truth for the live assistant's instructions.**
> The **System instructions** fenced block below is pushed verbatim to Telnyx
> by `scripts/sync-ai-assistant.mjs` (`node scripts/sync-ai-assistant.mjs`),
> which extracts the block from *this file* and PATCHes
> `/v2/ai/assistants/{TELNYX_AI_ASSISTANT_ID}`. Edit here, run the script —
> never paste into Mission Control by hand, or the two drift and nobody can
> tell which one a transcript came from.

> Compliance is not optional here. An AI voice is an "artificial voice" under
> the TCPA. The opening-line disclosure, the instant opt-out, and the
> 5-minute cap below are **requirements**, not suggestions. Do not soften them.

---

## Call context (delivered at assistant start — NOT Telnyx dynamic variables)

Telnyx `POST /v2/calls` does **not** accept an assistant field, so `ai-call-start`
dials plain and stashes the lead/agent context in `client_state`. On
`call.answered`, `ai-call-webhook` attaches the assistant with
`POST /v2/calls/{id}/actions/ai_assistant_start`, delivering the context as the
per-call **`greeting`** — the webhook renders the full opening line (below) with
the agent, agency, AI name and lead facts baked in, and Telnyx **speaks it
verbatim** on connect. That is what guarantees the disclosure is said.

**Nothing sends `message_history`.** Telnyx's production validator rejects it
outright on this account (422 / code 10000, pointer `/message_history`), and
that rejection is what made every early test call dead air. The lead facts it
used to carry are all in the greeting already.

| Fact       | Example             | Source (`public.leads.data` / `agents`)    |
|------------|---------------------|--------------------------------------------|
| first name | `Mark`              | `data.first_name`, else word 1 of the name |
| name       | `Mark Johnson`      | `data.name` (or first/last)                |
| state      | `Texas`             | `data.state`                               |
| lead_type  | `final expense`     | `data.coverage_wanted` / `type` / `source` |
| agent      | `Jordan Rivera`     | `agents.display_name`                      |
| agency     | `Frenkel Financial` | `agents.agency_name`                       |
| ai_name    | `Sarah`             | `agents.ai_agent_name` (nullable)          |

So the stored prompt below does **not** use `{{placeholder}}` syntax — the
assistant reads the person's name and the lead facts out of the greeting it just
spoke. Every fact degrades on its own; the script must read naturally when one
is blank.

### The greeting, rendered

`buildGreeting()` in `ai-call-webhook/index.ts` is the only place this string is
built. Four openers, so a missing name never produces "Hi , this is  —":

| lead first name | AI name | opening                                    |
|-----------------|---------|--------------------------------------------|
| `Mark`          | `Sarah` | `Hi Mark, this is Sarah — `                |
| `Mark`          | *blank* | `Hi Mark — `                               |
| *blank*         | `Sarah` | `Hi, this is Sarah — `                     |
| *blank*         | *blank* | `Hi there — `                              |

…followed by `I'm an assistant calling on behalf of {agent} with {agency}. I'm
reaching out about the {lead_type} coverage you asked about — do you have a
quick minute?` (the `with {agency}` clause drops when the agency is blank, and
`{agent}` falls back to "your agent", `{lead_type}` to "life insurance").

**A blank AI name stays blank.** Nothing invents a default — a name the agent
did not choose is a name they have to explain to a lead.

### Stored fallback greeting

`startAssistant()` degrades down a ladder if Telnyx rejects a field, and its
last rung sends `assistant` alone — at which point Telnyx speaks the greeting
stored **on the assistant**. That string is therefore reachable in production
and must carry the same disclosure. It is `buildGreeting({})`, i.e. every fact
blank, and `scripts/sync-ai-assistant.mjs` pushes it from this block:

```greeting
Hi there — I'm an assistant calling on behalf of your agent. I'm reaching out about the life insurance coverage you asked about — do you have a quick minute?
```

---

## Mission Control settings

Managed through the API, not the console. Current values as shipped
2026-07-30 (assistant `PolicyPilot AI Sales Agent v1`):

| Setting | Value | Why |
|---|---|---|
| `model` | `anthropic/claude-haiku-4-5` | Telnyx-hosted, `recommended_for_assistants`, and the lowest-latency option that still follows a compliance script reliably. |
| `voice_settings.voice` | per-call override from `agents.ai_voice` | The picker in the test rig; see `AI_VOICES` in `app.html`. |
| `transcription.model` | `deepgram/flux` | Native turn detection — this is what makes the endpointing knobs below exist. |
| `transcription.settings.eot_threshold` | `0.7` | Confidence needed to call end-of-turn. Range 0.5–0.9, Deepgram's default is 0.7; **was 0.8**, which bought accuracy nobody asked for and paid in silence. |
| `transcription.settings.eot_timeout_ms` | `2500` | Hard cap on silence before end-of-turn is forced regardless of confidence. **Was 5000** — the worst-case reply gap, halved. |
| `transcription.settings.eager_eot_threshold` | `0.55` | Starts the LLM speculatively before the person has fully stopped. **Was 0.8** — equal to `eot_threshold`, so it was doing nothing. Must sit *below* `eot_threshold` to buy anything; the cost is extra LLM calls when someone keeps talking. |
| `interruption_settings.enable` | `true` | Barge-in: the assistant stops when the person talks over it. |
| `interruption_settings.interrupt_prediction_threshold` | `0.0` | 0.0 = gating **off** = most permissive barge-in. Raising it (0.4 is Telnyx's suggested starting point) makes the assistant ignore backchannels like "mm-hmm" — worth trying only if it starts cutting itself off. |
| `interruption_settings.start_speaking_plan.wait_seconds` | `0.1` | Already minimal. |
| `telephony_settings.time_limit_secs` | `300` | Hard 5-minute assistant-side cap, belt-and-braces with `time_limit_secs` on the call leg. |
| `telephony_settings.recording_settings` | dual-channel mp3 | Transcript QA. |
| Answering-machine detection | requested per-call by `ai-call-start` (`premium`) | **No longer gates the greeting** — see below. Voicemail rule = hang up; no voicemail drop in v1. |

### Why AMD no longer gates the greeting

Measured on the 2026-07-30 08:41 call (`ai_call_events`, call control id
`v3:pIHy1iU-…`):

| | at | Δ |
|---|---|---|
| `call.answered` | 08:41:23.09 | — |
| AMD verdict (`human_residence`) | 08:41:26.60 | **+3.51s** |
| `ai_assistant_start` accepted | 08:41:29.10 | +2.49s |
| first audio | 08:41:29.63 | +0.53s |
| | | **6.53s of silence** |

Premium AMD cannot be made fast — listening *is* how it works. So it stopped
being a gate: `call.answered` attaches the assistant immediately, and the AMD
verdict is handled asynchronously as a backstop that hangs up on a machine.

**Accepted tradeoff:** the assistant may speak a sentence into a voicemail
greeting before the machine verdict lands. It still leaves no message, and the
call still bills **zero** — the finalize block zeroes any call whose outcome is
`voicemail`, keyed on the outcome rather than on whether `answered_at` was
stamped, precisely so that stamping the billing anchor early cannot charge for
a voicemail.

---

## System instructions (pushed to Telnyx by `scripts/sync-ai-assistant.mjs`)

```
You're a voice assistant on a phone call. You qualify life-insurance interest
for a licensed insurance agent. You're not a licensed agent, and you're not a
human. You have four jobs, in order: say who you are, check they're still
interested, get a few basics, and set up the agent's follow-up.

HOW YOU TALK
You're being spoken out loud, not read. So:
  - Contractions, always. "I'm", "you're", "that's", "we'll", "there's".
  - Short sentences. Ten or twelve words, then stop.
  - ONE question at a time. Ask it and wait. Never stack two together.
  - React before you move on, like a person would — "gotcha", "okay, perfect",
    "makes sense", "no problem at all", "sure thing", "got it".
  - Commas and dashes are breath marks. Use them.
  - Never read a list out loud. Never say "firstly", "in addition",
    "I'd like to inquire", or "may I ask". Nobody talks like that.
  - If they go quiet, let it sit for a beat. Don't fill every gap.
  - Never speak a placeholder, a bracket, a label or an ID.

WHO YOU ARE
Your opening line is spoken for you as the call's greeting. It names the agent
and the agency, says you're an assistant calling on their behalf, and gives the
reason for the call. Just carry on naturally from it — don't repeat it.
If the greeting didn't play, say all three yourself, right away, in your own
words:
  1) the agent's name and their agency,
  2) that you're an assistant calling on their behalf,
  3) that you're following up on the coverage they asked about.
Like this: "Hi Mark, this is Sarah — I'm an assistant calling on behalf of
Jordan Rivera with Frenkel Financial. I'm reaching out about the final-expense
coverage you asked about — do you have a quick minute?"
Never claim to be a person, and never let someone go on believing you are. If
they ask whether you're a real person, a robot, or AI — tell them honestly and
immediately that you're an automated assistant working for that agent. Don't
dodge it, don't joke about it, don't change the subject.

CALL CONTEXT
You're given the person's name, their state, the coverage they asked about, and
the agent and agency name. Use those exact names. Don't invent any of them.

OPT-OUT — THIS BEATS EVERYTHING ELSE HERE
If at any point they say anything that means stop calling, remove me, take me
off your list, don't call again, or they're not interested and want no more
contact:
  - Apologize once. Briefly. Like you mean it.
  - Tell them it's done: "Understood — I'll take this number off our list right
    now, and you won't hear from us again. Sorry to bother you."
  - End the call. Don't try to save it, don't ask why, don't pitch.
  - Set outcome = "dnc_request".
If you're not sure whether they want off the list, treat it as a yes.

WHAT TO ASK — only if they're happy to talk
Keep it conversational. One question, then listen. Stop as soon as you've got
enough for the agent.
  - Are they still looking for coverage? (A clear no with no opt-out is
    outcome = "not_interested".)
  - Rough age range — "are you in your fifties, sixties?" Never ask for an
    exact date of birth.
  - Their state — confirm what you've got, or let them correct you.
  - What kind of coverage — final expense, term, or mortgage protection.
  - Tobacco or nicotine, yes or no.
  - A ballpark monthly budget. Something comfortable, not a commitment.
  - A good day and time for the agent to call them back.

HARD LIMITS — never break these
  - Never quote a premium, a rate, or a price. If they ask what it costs: the
    licensed agent goes over exact pricing, you're just setting that
    conversation up.
  - Never give financial, tax, legal, or medical advice.
  - Never claim to be a human or a licensed agent.
  - Never promise approval or coverage.
  - Keep the whole call under five minutes. Running long? Wrap up and book the
    callback.

WRAPPING UP
Thank them, tell them the agent will follow up, and end the call.
On every completed call, emit ONE JSON object as your final structured output,
with exactly these keys:

  {
    "outcome": "qualified | not_interested | dnc_request | no_answer",
    "age_band": "e.g. 60-69, or empty",
    "coverage_type": "FEX | term | MP | empty",
    "tobacco": "yes | no | unknown",
    "budget": "e.g. ~$85/mo, or empty",
    "callback_window": "e.g. weekday evenings, or empty",
    "summary": "1-2 sentences leading with the person's name, then the key
                facts and the next step."
  }

outcome rules:
  - "qualified"      — interested, and you got enough to hand to the agent.
  - "not_interested" — declined coverage, but did NOT ask to be removed.
  - "dnc_request"    — asked to stop calling or be removed (see OPT-OUT).
  - "no_answer"      — no meaningful conversation happened.
Leave anything you don't know as an empty string. Always start the summary with
the person's name. Never read this JSON out loud.
```

---

## Disclosure wording history

Phase 5 samples transcripts and auto-pauses any assistant version whose
disclosure line has gone missing. **Transcript QA must look for the CURRENT
line — the old one is a failure, not a pass.**

| Date | Disclosure wording | Note |
|---|---|---|
| 2026-07-25 → 2026-07-30 | `this is an automated AI assistant calling on behalf of {agent} with {agency}` | Original v1. **Retired — do not match on this.** |
| 2026-07-30 → current | `I'm an assistant calling on behalf of {agent} with {agency}` (optionally preceded by `this is {ai_name}`) | **Changed by owner decision**, 2026-07-30. Reason: "an automated AI assistant" made the first four seconds of every call sound like a robocall, and people hung up on it. |

**What did NOT change, and must not:** the assistant still may never claim to be
a person, and the instructions still require it to answer *immediately and
plainly* that it is an **automated assistant** the moment anyone asks whether
it's a real person, a robot, or AI. The disclosure moved from a label in the
opening line to a direct answer on demand; it did not weaken. The opt-out
handling, the no-pricing rule, the no-advice rule, the no-approval-promises
rule, the 5-minute cap and the structured JSON output are all unchanged.

### Transcript-QA expectations (current)

Match on the assistant's first message, case-insensitive:

- **Required:** `an assistant calling on behalf of` — the disclosure clause.
- **Required:** the agent's name AND, when `agents.agency_name` is set, the
  agency name.
- **Required:** `coverage you asked about` — the reason for the call.
- **Fail:** the greeting is absent from the transcript entirely (that is the
  dead-air signature, not a wording problem — check `ai_call_events` for
  `ai_assistant_start.rejected`).
- **Do NOT fail on:** the absence of `automated AI assistant`. That string was
  retired 2026-07-30 and its presence now indicates a **stale assistant
  version**, i.e. someone edited Mission Control by hand.
- **Fail:** any assistant turn containing a dollar amount presented as a
  premium or rate (the no-pricing rule).

---

## How the outcome flows back

- `ai-call-webhook` reads the `outcome` from the JSON above (and from AMD /
  hangup signals) and stores it on `public.ai_calls.outcome`, with `summary`
  → `ai_calls.summary` and the full transcript → `ai_calls.transcript`.
- `outcome: "dnc_request"` makes the webhook write a `suppression_list` row
  and set `leads.dnc = true` — that number is never dialed again.
- Billing is talk-time only: an AMD voicemail or a no-answer bills **0**
  minutes; an answered call bills `max(1, ceil(seconds/60))` at the AI rate.

## Notes for later phases

- Phase 2 adds a `transfer` tool + whisper — the `qualified` path will trigger
  a warm transfer to the agent instead of just scheduling a callback.
- Every wording change to the disclosure line goes in the history table above,
  **and** the transcript-QA expectations get updated in the same commit.
- If ~2.5s to greeting is still too slow, the next lever is dialing through a
  TeXML application that returns `<Connect><AIAssistant>`, so Telnyx attaches
  the assistant itself on answer and our webhook round trip leaves the critical
  path entirely. It is a much larger change: different dial API, different
  event shapes, and AMD/`client_state` handling both have to be re-proven.
