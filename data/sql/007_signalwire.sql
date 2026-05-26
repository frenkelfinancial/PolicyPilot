-- ============================================================
-- 007_signalwire.sql
-- SignalWire telephony integration (Phase B).
--
-- Adds per-agent SignalWire assignments (caller-ID number, subscriber
-- identity, monthly minute cap) to public.agents, plus a new
-- public.calls log table. The signalwire-token edge function reads
-- these columns to mint browser JWTs and enforce the minute cap;
-- the frontend writes one row to public.calls per dial.
--
-- Run once in the Supabase SQL Editor.
-- ============================================================

-- 1. Extend public.agents -----------------------------------------------
alter table public.agents
  add column if not exists is_admin                  boolean not null default false,
  add column if not exists signalwire_caller_id     text,
  add column if not exists signalwire_subscriber_id text,
  add column if not exists monthly_minute_limit     int not null default 500;

comment on column public.agents.is_admin is
  'Firm admin flag. Admin agents see the agent-assignments table in Settings → Calling and can edit other agents'' SignalWire fields. Manually toggled per-row.';
comment on column public.agents.signalwire_caller_id is
  'E.164 caller-ID number this agent dials from (e.g. +14155550142). One number per agent; assigned by an admin.';
comment on column public.agents.signalwire_subscriber_id is
  'SignalWire Call Fabric Subscriber/Address that the browser SDK connects as. The signalwire-token edge function mints a JWT scoped to this resource.';
comment on column public.agents.monthly_minute_limit is
  'Max outbound call minutes per calendar month before signalwire-token returns 429. Default 500. Bump per agent as needed.';

-- 2. Seed the firm owner as admin ---------------------------------------
-- One-off: flip the existing agents row for the firm owner. Replace the
-- email below with whoever owns the firm before running this migration.
update public.agents
   set is_admin = true
 where id in (select id from auth.users where email ilike 'tannertrustem@gmail.com')
   and is_admin = false;

-- 3. Call log -----------------------------------------------------------
create table if not exists public.calls (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references auth.users(id) on delete cascade,
  lead_id       uuid       references public.leads(id) on delete set null,
  direction     text not null check (direction in ('outbound','inbound')),
  phone_from    text not null,
  phone_to      text not null,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  duration_sec  int,
  outcome       text,                  -- lead-status slug applied (no_answer, appointment, ...)
  sw_call_sid   text,                  -- SignalWire's call ID for reconciliation with webhooks
  created_at    timestamptz default now()
);

comment on table public.calls is
  'One row per dial. Drives the monthly-minute cap (sum duration_sec where started_at in current month) and per-agent activity history.';

-- Covers both the agent-history list (ORDER BY started_at DESC) and
-- the monthly-sum window (WHERE started_at >= <month_start>). A second
-- functional index on date_trunc('month', started_at) was considered
-- but rejected: date_trunc on timestamptz isn't IMMUTABLE, so Postgres
-- refuses the index, and a simple range scan on this composite index
-- is fast enough for the per-agent month sum.
create index if not exists calls_agent_started_idx
  on public.calls (agent_id, started_at desc);

-- 4. RLS -----------------------------------------------------------------
alter table public.calls enable row level security;

drop policy if exists "calls_select_own" on public.calls;
create policy "calls_select_own"
  on public.calls for select
  using (auth.uid() = agent_id);

-- Admin check helper. SECURITY DEFINER lets this function bypass RLS
-- on its own SELECT, which is what breaks the recursion cycle: a naive
-- `exists (select 1 from agents where ... is_admin)` inside an agents
-- policy re-fires the same policy, producing 42P17 infinite recursion.
create or replace function public.is_admin_agent()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select is_admin from public.agents where id = auth.uid()), false);
$$;

grant execute on function public.is_admin_agent() to authenticated;

drop policy if exists "calls_select_admin" on public.calls;
create policy "calls_select_admin"
  on public.calls for select
  using (public.is_admin_agent());

drop policy if exists "calls_insert_own" on public.calls;
create policy "calls_insert_own"
  on public.calls for insert
  with check (auth.uid() = agent_id);

drop policy if exists "calls_update_own" on public.calls;
create policy "calls_update_own"
  on public.calls for update
  using (auth.uid() = agent_id);
-- No DELETE policy: blocked. Admin can clean up via the Supabase dashboard.

-- 5. Admin update on agents (so admins can assign caller-IDs from UI) ---
-- The existing handle_new_user trigger creates the agents row with
-- auth.uid() as the row id, and the default agents RLS lets each agent
-- update their own row. Add a parallel policy that lets admins update
-- ANY agents row so the Settings → Calling "Agent Assignments" inline
-- editor can persist caller-ID + cap changes for other agents.
drop policy if exists "agents_update_admin" on public.agents;
create policy "agents_update_admin"
  on public.agents for update
  using (public.is_admin_agent());

drop policy if exists "agents_select_admin" on public.agents;
create policy "agents_select_admin"
  on public.agents for select
  using (public.is_admin_agent());
