# AI Sales Agent — Build Plan (July 2026)

The feature the new homepage sells: import leads → AI dials one at a time, screens
voicemails and not-interesteds, qualifies real prospects → warm-transfers the live
call to the agent's phone with a whisper summary. This doc is the roadmap; each
phase ends in something shippable and has its own Claude Code prompt.

---

## Platform decision (made): Telnyx AI Assistants

We already run every call on Telnyx (numbers, Call Control, WebRTC, webhooks,
wallet holds). Telnyx now has a native **Voice AI Agents** product at
**$0.05/min all-in for STT + TTS** (LLM tokens and telephony legs billed
separately), with the exact primitives this feature needs already built:

- **Voicemail/silence detection + voicemail rules** — "screens out the voicemails"
- **AI-to-human handoff / transfer tool, with AMD on transfer** — the warm transfer
- **Dynamic variables + webhooks** — lead context in, transcript/outcome out

Alternatives rejected for v1: Retell/Vapi/Bland (all-in $0.09–$0.31/min — most
setups land $0.13+/min, i.e. **underwater against our $0.075 retail price**, plus a
second vendor to plumb); DIY pipeline (LiveKit/Pipecat + Deepgram + realtime LLM,
~$0.02–0.06/min — best margin, most work; revisit as a **Phase 6 cost
optimization** once volume justifies it).

### Margin reality check (watch this)
Retail $0.075/min vs. estimated cost: $0.05 (Telnyx AI) + ~$0.005–0.02 LLM tokens
+ ~$0.007–0.014 telephony legs ≈ **$0.06–0.08/min** — roughly breakeven at list,
worse during a transfer (two live legs). The margin is in seats and in volume
discounts (Telnyx does contract pricing), not in AI minutes. Options if it pinches:
pick the cheapest adequate LLM (Telnyx-hosted Qwen tier), negotiate committed-use
pricing early, or revisit the $0.075 number before this feature is on by default.

---

## Phase 0 — Compliance foundation (build FIRST, it gates everything)

TCPA exposure is $500–$1,500 **per call**, uncapped. An AI voice is legally an
"artificial voice": marketing calls to cell phones require **prior express written
consent**. The homepage already promises disclosure, instant DNC, zero abandonment
— make those true in the schema before the first call.

- `leads` additions: `tcpa_consent` (bool), `tcpa_consent_source`, `tcpa_consent_at`,
  `dnc` (bool), `dnc_at`, `timezone` (derived from area code + zip).
- `suppression_list` table (per-agent + global): any "stop calling me" → instant
  insert, honored by every future session.
- Import flow: consent attestation checkbox ("these leads opted in to be contacted
  by me") + per-batch consent-source field. Un-consented leads are **not selectable**
  for AI sessions (UI + server-side gate).
- Quiet hours: only dial 8am–9pm **lead-local time** (stricter in some states —
  make the window per-state configurable, default conservative).
- National DNC scrub hook (per-batch, every 31 days) — v1 can be a manual
  attestation + internal suppression; wire an API scrub in Phase 5.
- Assistant script REQUIREMENTS (non-negotiable, in the system prompt):
  identifies the agent + agency by name, **discloses AI on the opening line**,
  offers opt-out, on "stop/remove me" → apologize, hang up, write suppression row.
- Kill switch: `billing_config.ai_dialer_enabled` global flag + per-agent flag.

## Phase 1 — One AI call, end to end (MVP, no transfer yet)

New tables + one edge function + wallet wiring. See
`PROMPT_13_ai_sales_agent_phase1_CLAUDE_CODE.md`.

- Telnyx AI Assistant configured (Mission Control first, IaC later): FEX/term
  qualification script, dynamic variables (`lead_name`, `agent_name`, `state`,
  `lead_type`), voicemail rules = hang up on machine, disclosure opening.
- `ai_dialer_sessions` + `ai_calls` tables (mirror `dialer_sessions` shape:
  status, lead_ids, caller_id fields, call_control_ids, outcome, transcript).
- `ai-call-start` edge function: auth → consent + suppression + quiet-hours gate →
  wallet spend gate (reuse `min_call_start_mills` pattern) → place Telnyx call with
  assistant + AMD → row in `ai_calls`.
- `ai-call-webhook` edge function: assistant/call events → update status; on
  `call.hangup` compute whole minutes (ceil, min 1) → **`wallet_debit_ai_minutes`**
  (RPC is live; tier split mirrors `_shared/ai-minute-billing.ts splitAiMinutes()`)
  → store transcript, outcome tag (`voicemail | no_answer | not_interested |
  qualified | dnc | error`), write lead disposition + activity log.
- Exit criteria: call your own cell, hear the disclosure + script, see the ledger
  debit itemized as `ai_call`, transcript on the lead.

## Phase 2 — Warm transfer + whisper

The moment that justifies the whole feature.

- Assistant `transfer` tool fires when qualification criteria met → webhook
  dials the agent leg (their verified cell or WebRTC softphone — reuse the
  host-number/agent-leg bridge pattern from `telnyx-bridge`).
- **Whisper**: before bridging, play TTS summary to the agent leg only ("Mark
  Johnson, 58, FEX for him and his wife, no majors, ~$85/mo budget") — assistant
  generates the summary as a tool argument; agent presses 1 to accept.
- AMD on transfer (Telnyx supports this) — never bridge a prospect into the
  agent's voicemail.
- No-answer/decline handling: AI apologizes, books a callback time, tags lead
  `qualified_missed` (these are gold — surface them loudly in the UI).
- Both legs' minutes debit correctly (AI leg = ai_call rate; transfer leg =
  dialer rate — decide and document; recommend: whole call stays ai_call rate,
  simpler and matches the marketing).

## Phase 3 — Batch runner ("pick a batch, hit run")

- `ai-dialer-run` orchestration: strictly **one active call per agent session**
  (zero abandonment claim), next lead dials only after previous call reaches a
  terminal state + cooldown (5–10s).
- Session controls: pause / resume / stop; auto-stop on wallet floor, on
  qualified-transfer-in-progress, on quiet-hours boundary, on daily cap.
- Retry policy v1: no same-day redial; voicemail = one retry next day, max 2
  attempts per lead per week. No AI voicemail drops in v1 (separate compliance
  analysis before ever enabling).
- Caller ID rotation across the agent's numbers (the unlimited-numbers pitch) —
  reuse `caller_id_numbers` pool logic from `telnyx-dialer-create-session`.

## Phase 4 — UI in app.html

- "AI Dialer" tab mirroring the Power Dialer screen: lead picker (consented only,
  with count of excluded + why), script/assistant picker, run/pause/stop, live
  session feed (calling → outcome rows, exactly like the homepage hero mock).
- Transfer toast + whisper text on screen when the agent's phone rings.
- Post-session review: transcripts, dispositions, cost summary ("41 calls,
  63 AI minutes, $4.73, 3 transfers, 2 callbacks booked").
- Wallet UI: AI minutes line already exists in Billing Rates; add month-to-date
  AI minutes + distance to the 2,000-min volume tier.
- Gate by plan: Pro + Team Leader only (reuse `showUpgradeGate`, which already
  carries the new prices).

## Phase 5 — Hardening before wide release

- Per-session + per-day spend caps (user-set, default $10/day).
- Automated DNC scrub integration; suppression export.
- Number reputation: rotate away from numbers flagged spam (extend
  `telnyx-reputation-monitor`), pace per-number daily dial counts.
- Script A/B: two assistant variants per lead type, track transfer rate.
- Transcript QA sampling: flag calls where disclosure line is missing from the
  transcript → auto-pause the assistant version.
- Load test the webhook path; idempotency on debit (ref_id = call_control_id,
  unique index so a replayed webhook can't double-charge).

## Phase 6 (later) — Margin optimization

Swap Telnyx AI Assistant for a self-hosted pipeline (LiveKit/Pipecat ~$0.01/min
orchestration + Deepgram STT + budget realtime LLM + cheap TTS) if AI-minute
volume makes the ~$0.03–0.04/min spread worth the ops burden. The schema,
wallet, and UI don't change — only the call engine.

---

## Sequencing for Claude Code

1. `PROMPT_13_...phase1` (includes Phase 0 schema) — ~1 session
2. Manual step (you, 30 min): create the Telnyx AI Assistant in Mission Control,
   paste its ID into Supabase secrets; make 3 test calls to your own phone.
3. `PROMPT_14` transfer + whisper — ~1 session, test with your cell as agent leg
4. `PROMPT_15` batch runner, `PROMPT_16` UI, `PROMPT_17` hardening
5. Only after Phase 5: flip `ai_dialer_enabled` for real users; announce.
