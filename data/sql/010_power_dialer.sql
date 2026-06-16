-- ============================================================
-- 010_power_dialer.sql
-- Power Dialer (Phase F).
--
-- Adds:
--   • public.agents.dialer_pin       — 4-digit PIN the agent enters when
--                                       calling into the dialer host number
--   • public.dialer_sessions          — one row per power-dial batch
--
-- The agent selects leads in the app, which creates a 'pending'
-- dialer_sessions row via telnyx-dialer-create-session. The agent then
-- calls the shared TELNYX_DIALER_NUMBER from their phone and enters their
-- dialer_pin; the extended telnyx-call-status webhook validates the PIN,
-- starts a Telnyx conference from that call leg, and dials leads from
-- lead_ids[] one at a time, joining/removing each from the conference.
--
-- Run once in the Supabase SQL Editor (manual paste only — never
-- `supabase db push`, which silently skips data/sql/ files, per project
-- convention established in 009_phone_book.sql).
-- ============================================================

-- 1. Agent PIN -------------------------------------------------------------
alter table public.agents
  add column if not exists dialer_pin text;

comment on column public.agents.dialer_pin is
  '4-digit PIN the agent enters (followed by #) when calling into TELNYX_DIALER_NUMBER to start their power dialer session. Auto-generated on first use by telnyx-dialer-create-session.';

create unique index if not exists agents_dialer_pin_idx
  on public.agents (dialer_pin) where dialer_pin is not null;

-- 2. Dialer sessions ---------------------------------------------------------
create table if not exists public.dialer_sessions (
  id                       uuid primary key default gen_random_uuid(),
  agent_id                 uuid not null references auth.users(id) on delete cascade,
  pin                      text not null,
  lead_ids                 text[] not null,
  current_index            int not null default -1,
  status                   text not null default 'pending'
    check (status in ('pending','dialing','connected','completed','cancelled')),
  conference_id            text,
  agent_call_control_id    text,
  current_call_control_id  text,
  current_call_row_id      uuid references public.calls(id) on delete set null,
  host_number              text,
  created_at               timestamptz not null default now(),
  started_at               timestamptz,
  ended_at                 timestamptz
);

comment on table public.dialer_sessions is
  'One row per power-dial batch. lead_ids holds public.leads.client_id values (text), in dial order, matching the ids already used by the frontend selectedLeadIds / dial(leadId).';
comment on column public.dialer_sessions.current_index is
  'Index into lead_ids of the lead currently being dialed/connected. -1 = none dialed yet.';
comment on column public.dialer_sessions.conference_id is
  'Telnyx conference id created from the agent''s inbound call leg once they enter their PIN.';
comment on column public.dialer_sessions.agent_call_control_id is
  'Telnyx call_control_id of the agent''s inbound IVR call leg (the conference''s first participant).';
comment on column public.dialer_sessions.current_call_control_id is
  'Telnyx call_control_id of the lead currently being dialed/connected, if any.';

create index if not exists dialer_sessions_agent_status_idx
  on public.dialer_sessions (agent_id, status);

-- 3. RLS ---------------------------------------------------------------------
alter table public.dialer_sessions enable row level security;

drop policy if exists "dialer_sessions_select_own" on public.dialer_sessions;
create policy "dialer_sessions_select_own"
  on public.dialer_sessions for select
  using (auth.uid() = agent_id);

drop policy if exists "dialer_sessions_insert_own" on public.dialer_sessions;
create policy "dialer_sessions_insert_own"
  on public.dialer_sessions for insert
  with check (auth.uid() = agent_id);

drop policy if exists "dialer_sessions_update_own" on public.dialer_sessions;
create policy "dialer_sessions_update_own"
  on public.dialer_sessions for update
  using (auth.uid() = agent_id);

-- No delete policy: sessions are kept for history. Edge functions use the
-- service-role key, which bypasses RLS for the webhook-driven updates.

-- 4. Realtime ------------------------------------------------------------------
-- The Power Dialer modal subscribes to row updates on this table so webhook
-- arrivals (PIN entered, lead answered, lead hung up, session complete)
-- push live status into the dashboard without polling.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and tablename = 'dialer_sessions'
  ) then
    alter publication supabase_realtime add table public.dialer_sessions;
  end if;
end $$;
