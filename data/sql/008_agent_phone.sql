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
