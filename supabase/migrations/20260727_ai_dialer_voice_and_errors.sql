-- ============================================================
-- 20260727_ai_dialer_voice_and_errors.sql
-- AI Sales Agent — Phase 1 follow-up: voice selection + error visibility.
--
-- Two problems this solves, both found during the first live test calls:
--
--   1. SILENT FAILURES. When the webhook's ai_assistant_start action fails
--      (bad assistant id, rejected voice, Telnyx 4xx), the only trace was a
--      console.error in the Supabase function logs — the call itself was
--      just dead air, and the test rig showed nothing. ai_calls.error_detail
--      stores the failure so the UI can display exactly what went wrong.
--
--   2. VOICE CHOICE. Agents want to pick the AI's voice (male/female,
--      different styles). agents.ai_voice stores a Telnyx TTS voice id
--      (e.g. 'AWS.Polly.Joanna-Neural'); ai-call-start passes it through
--      client_state and the webhook sends it as the top-level `voice`
--      override on ai_assistant_start. NULL/'' = use the voice configured
--      on the assistant in Mission Control. ai_calls.voice records what a
--      given call actually used (audit trail).
--
-- Idempotent: safe to run more than once. Run in the Supabase SQL Editor.
-- ============================================================

alter table public.ai_calls
  add column if not exists error_detail text,
  add column if not exists voice        text;

comment on column public.ai_calls.error_detail is
  'Populated by ai-call-webhook when a call-path action fails (most importantly ai_assistant_start — the "answered but silent" case). Shown in the Phase 1 test rig so failures are visible without digging through function logs.';
comment on column public.ai_calls.voice is
  'The Telnyx TTS voice id actually requested for this call (from agents.ai_voice at dial time), or null when the assistant''s Mission Control default was used.';

alter table public.agents
  add column if not exists ai_voice text;

comment on column public.agents.ai_voice is
  'Agent-chosen Telnyx TTS voice for the AI Sales Agent (e.g. ''AWS.Polly.Joanna-Neural'', ''Azure.en-US-AndrewNeural''). NULL = use the assistant''s Mission Control default voice. Read by ai-call-start on every dial; sent by ai-call-webhook as the `voice` override on ai_assistant_start.';
