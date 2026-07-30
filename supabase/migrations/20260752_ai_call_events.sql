-- ============================================================
-- 20260752_ai_call_events.sql
-- AI Sales Agent — a complete, permanent trace of every Telnyx event.
--
-- WHY THIS EXISTS
--
-- Phase 1's "the phone connects but the AI never speaks" bug took three
-- rounds of live test calls to diagnose, because the only evidence a call
-- left behind was the ai_calls row itself: a status, an outcome and (after
-- 20260727) at most ONE error string. Everything about how the call actually
-- unfolded — did call.answered arrive? did premium AMD ever return a verdict?
-- was the verdict human or machine? did ai_assistant_start get a 2xx? — lived
-- only in ephemeral edge-function console logs.
--
-- ai_call_events records every webhook event Telnyx delivers, verbatim, plus
-- the outcome of every action this webhook takes. A silent call is now read
-- off a table instead of guessed at.
--
-- ACCESS MODEL — deliberately service-role-only.
--
-- RLS is ENABLED with NO policies at all, matching the pipeline-table pattern
-- used elsewhere in this schema: the service role bypasses RLS and does every
-- write, and `authenticated` gets nothing. Two reasons this table is not even
-- SELECT-able by owners the way ai_calls is:
--   * payload is the raw Telnyx event. It is a diagnostic artifact whose shape
--     is Telnyx's to change, and it can carry call metadata (SIP headers,
--     leg ids) that has no business being in a browser.
--   * there is no agent_id on the row to scope an owner policy by, and adding
--     one would mean resolving the agent inside the hot path of a webhook
--     whose whole job is to never fail.
-- Diagnosis reads it through the service role (SQL editor / supabase db query).
--
-- Idempotent: safe to run more than once.
-- ============================================================

create table if not exists public.ai_call_events (
  id              bigint generated always as identity primary key,
  call_control_id text,
  event_type      text,
  payload         jsonb,
  created_at      timestamptz not null default now()
);

comment on table public.ai_call_events is
  'Append-only diagnostic trace for AI Sales Agent calls. Written by ai-call-webhook under the service role: every Telnyx webhook event received (event_type verbatim) plus this function''s own action outcomes (event_type prefixed "ai_assistant_start.", "assistant_start.", "amd."). Service-role only — RLS is on with no policies. Read it when a call is silent.';

comment on column public.ai_call_events.call_control_id is
  'Telnyx call_control_id the event belongs to. Not a foreign key: events can arrive before ai-call-start has backfilled the id onto ai_calls, and a trace row must never be lost to an ordering race.';
comment on column public.ai_call_events.event_type is
  'Telnyx data.event_type for a received event (e.g. call.answered, call.machine.premium.detection.ended, call.hangup), or a synthetic namespaced type for an action this webhook performed.';
comment on column public.ai_call_events.payload is
  'For a received event: data.payload exactly as Telnyx sent it. For a synthetic event: the request/response detail of the action taken.';

-- The two access patterns: "everything for this call, in order" (diagnosis)
-- and "what happened recently" (is the pipeline alive at all?).
create index if not exists ai_call_events_call_idx
  on public.ai_call_events (call_control_id, created_at);
create index if not exists ai_call_events_created_idx
  on public.ai_call_events (created_at desc);

alter table public.ai_call_events enable row level security;

-- NO POLICIES, ON PURPOSE. See the access-model note above. Do not add an
-- INSERT policy to let the browser write here: the writer is a webhook running
-- under the service role, and a policy broad enough for a browser to append a
-- trace row is broad enough to forge one.
