# PROMPT 13 — AI Sales Agent, Phase 1: one compliant AI call, end to end

Read `docs/ai-sales-agent-build-plan.md` first (platform decision + phase map).
This prompt = Phase 0 (compliance schema) + Phase 1 (single AI qualification
call). No warm transfer yet — that's PROMPT 14. Follow existing repo patterns
exactly: edge functions look like `telnyx-dialer-create-session/index.ts`
(auth → gates → Telnyx API → DB row), wallet debits look like
`telnyx-report-call-minutes` but call **`wallet_debit_ai_minutes`**
(already live in `supabase/migrations/20260723_wallet_ai_minutes.sql`;
tier split mirrors `_shared/ai-minute-billing.ts splitAiMinutes()`).

## 1. Migration `2026xxxx_ai_dialer_phase1.sql` (idempotent, like 20260723)

- `leads`: add `tcpa_consent boolean not null default false`,
  `tcpa_consent_source text`, `tcpa_consent_at timestamptz`,
  `dnc boolean not null default false`, `dnc_at timestamptz`,
  `lead_timezone text` (IANA; backfill later from area code — nullable is fine).
- `suppression_list(id, agent_id uuid null /* null = global */, phone_e164 text,
  reason text, source_call_id text, created_at)` + unique (agent_id, phone_e164).
  RLS: agents read their own rows; writes via service role only.
- `ai_dialer_sessions` — mirror `dialer_sessions` columns/shape: `id, agent_id,
  lead_ids uuid[], status (pending|running|paused|completed|cancelled|error),
  caller_id_mode, caller_id_fixed, caller_id_numbers, assistant_id text,
  started_at, ended_at, created_at`.
- `ai_calls(id, session_id, agent_id, lead_id, phone_e164, call_control_id text,
  telnyx_call_leg_id text, status text, outcome text check in
  ('voicemail','no_answer','busy','not_interested','qualified','dnc_request',
   'error','in_progress'), transcript jsonb, summary text, duration_secs int,
  billed_minutes int, started_at, ended_at, created_at)`
  + unique index on `call_control_id` (webhook idempotency + debit ref).
- `billing_config`: add `ai_dialer_enabled boolean not null default false`,
  `ai_quiet_start smallint not null default 8`, `ai_quiet_end smallint not null
  default 21` (lead-local hours). `agents`: add `ai_dialer_enabled boolean not
  null default false` (per-agent kill switch, default OFF).
- RLS on both new tables following the `dialer_sessions` precedent.

## 2. Edge function `ai-call-start`

Auth exactly like `telnyx-dialer-create-session`. Then gates, in order, each
with its own error code:
1. `billing_config.ai_dialer_enabled` AND `agents.ai_dialer_enabled` → `ai_disabled`
2. plan tier is pro or leader → `upgrade_required`
3. lead: `tcpa_consent = true`, `dnc = false`, phone not in `suppression_list`
   (agent's or global) → `not_callable` (+ reason)
4. quiet hours in lead-local time (fallback: area-code state → timezone; if
   unknown, use the MOST restrictive interpretation) → `quiet_hours`
5. wallet: balance ≥ `min_call_start_mills` equivalent for AI (add
   `min_ai_call_start_mills`, default 150 = 2 min buffer) → `insufficient_balance`

Then: POST Telnyx call with `answering_machine_detection: premium`, the AI
Assistant id from secret `TELNYX_AI_ASSISTANT_ID`, dynamic variables
(`lead_name, lead_state, lead_type, agent_name, agency_name`), webhook URL →
`ai-call-webhook`. Insert `ai_calls` row (`in_progress`). Return call id.

Secrets to document in the function's config error (like TELNYX_API_KEY
pattern): `TELNYX_AI_ASSISTANT_ID`.

## 3. Edge function `ai-call-webhook`

Telnyx webhook receiver (validate signature like existing telnyx webhooks).
- AMD result = machine → hang up, outcome `voicemail`.
- `call.hangup` / assistant-ended events: `duration_secs` from event;
  `billed_minutes = max(1, ceil(duration_secs/60))`;
  call `wallet_debit_ai_minutes(agent, minutes, 'ai_call', call_control_id,
  'AI Sales Agent call — {lead name}')` via service role. **Idempotent**: skip
  debit if a `wallet_ledger` row with category `ai_call` and that `ref_id`
  exists.
- Store transcript + assistant outcome tag; map to `ai_calls.outcome`.
- `dnc_request` outcome → insert into `suppression_list`, set `leads.dnc = true`.
- Write the same lead activity/disposition rows the power dialer writes, so the
  lead timeline shows AI calls alongside human calls.

## 4. Assistant script (deliver as `docs/ai-assistant-script-v1.md`)

Write the full system prompt for a life-insurance qualification assistant:
- Opening line MUST contain: agent + agency name, "this is an automated AI
  assistant calling on behalf of…", and the reason for the call. Non-negotiable.
- Qualify: interest confirmation, age band, state, coverage type
  (FEX/term/MP), tobacco, rough budget, best callback window.
- "Stop calling" / "remove me" → apologize once, confirm removal, END CALL,
  outcome `dnc_request`.
- Never quote premiums, never give financial/medical advice, never claim to be
  human, max call length 5 minutes (assistant-side timeout).
- End every completed qualification with outcome JSON the webhook can parse:
  `{outcome, age_band, coverage_type, tobacco, budget, callback_window, summary}`.

## 5. Tests + verification

- Unit-test the tier math against `splitAiMinutes()` fixtures (0, 1999, 2000,
  2001 mtd-minute boundaries — 2,000th minute is base rate, 2,001st is volume).
- Webhook replay test: same hangup event twice → exactly one ledger debit.
- Deploy functions, run migration, then STOP and print the manual checklist:
  create assistant in Mission Control, set `TELNYX_AI_ASSISTANT_ID`, place a
  test call to the owner's cell, verify: disclosure heard, transcript stored,
  ledger shows `ai_call` debit at $0.075/min, DNC test ("remove me") writes
  suppression row.

Do NOT touch the marketing pages, Stripe code, or the human power dialer paths.
