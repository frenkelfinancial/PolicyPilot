-- ============================================================
-- 005_quote_usage.sql
-- ITK quote usage cap (500 / rolling 30 days, configurable per agent).
--
-- Two changes:
--   1. agents.monthly_quote_limit — per-agent cap, default 500. Subscription
--      plan flow will bump this when paid plans ship; until then every
--      agent is locked at 500.
--   2. quote_usage — one row per Run Quote click (success or failure). The
--      itk-quote edge function counts rows in the trailing 30-day window
--      to enforce the cap and returns 429 when used >= limit.
--
-- Run once in the Supabase SQL Editor.
-- ============================================================

-- 1. Per-agent limit column ---------------------------------------------
alter table public.agents
  add column if not exists monthly_quote_limit int not null default 500;

comment on column public.agents.monthly_quote_limit is
  'Max ITK quotes the agent can run in a rolling 30-day window. Default 500. Plan flow updates this when subscriptions land.';

-- 2. Per-quote usage log -------------------------------------------------
create table if not exists public.quote_usage (
  id          bigserial primary key,
  agent_id    uuid not null references auth.users(id) on delete cascade,
  product     text,                 -- 'FEX' | 'TERM' | 'IUL' — for future analytics
  ok          boolean not null,     -- did ITK return ok? Logged on success AND failure.
  created_at  timestamptz not null default now()
);

comment on table public.quote_usage is
  'One row per ITK Run Quote invocation. Edge function counts trailing-30-day rows to enforce cap.';

-- Trailing-30-day count query: WHERE agent_id = ? AND created_at >= now() - interval '30 days'
create index if not exists quote_usage_agent_ts_idx
  on public.quote_usage (agent_id, created_at desc);

-- 3. RLS -----------------------------------------------------------------
alter table public.quote_usage enable row level security;

drop policy if exists "quote_usage_select_own" on public.quote_usage;
create policy "quote_usage_select_own"
  on public.quote_usage for select
  using (auth.uid() = agent_id);

drop policy if exists "quote_usage_insert_own" on public.quote_usage;
create policy "quote_usage_insert_own"
  on public.quote_usage for insert
  with check (auth.uid() = agent_id);

-- No UPDATE or DELETE policies: those operations are blocked. Audit
-- integrity preserved; admin can clean up via the Supabase dashboard.
