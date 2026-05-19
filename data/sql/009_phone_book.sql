-- ============================================================
-- 009_phone_book.sql
-- Phone Book tab (Phase E).
--
-- Adds:
--   • public.plans          — tiered subscription plans for outbound minutes
--   • public.agents.plan_id — FK to the agent's current plan
--   • public.phone_numbers  — per-agent inventory of owned SignalWire DIDs
--
-- The softphone keeps reading public.agents.signalwire_caller_id as the
-- agent's outbound caller-ID — when a number is set as primary in the
-- Phone Book UI, we mirror its e164 into agents.signalwire_caller_id so
-- signalwire-bridge needs no changes.
--
-- Run once in the Supabase SQL Editor (per project memory, manual paste
-- only — never `db push`, which silently skips data/sql/ files).
-- ============================================================

-- 1. Plans ---------------------------------------------------------------
create table if not exists public.plans (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  monthly_minutes int  not null,
  monthly_cost    numeric(8,2) not null,
  sort_order      int  not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

comment on table public.plans is
  'Subscription tiers that govern an agent''s monthly outbound minute allowance. Phone Book shows current plan + lets agents upgrade. Billing is not wired up yet — upgrading just bumps plan_id and the denormalized agents.monthly_minute_limit.';

insert into public.plans (slug, name, monthly_minutes, monthly_cost, sort_order) values
  ('starter', 'Starter',  500,  25.00, 1),
  ('pro',     'Pro',     1500,  60.00, 2),
  ('scale',   'Scale',   5000, 150.00, 3)
on conflict (slug) do nothing;

alter table public.agents
  add column if not exists plan_id uuid references public.plans(id);

comment on column public.agents.plan_id is
  'Current subscription plan. monthly_minute_limit is denormalized from plans.monthly_minutes whenever this changes (kept for the existing signalwire-bridge cap lookup).';

-- Backfill plan_id for every existing agent: pick the smallest plan whose
-- monthly_minutes >= the agent's current monthly_minute_limit. Anyone with
-- a cap above the largest plan ends up on the largest one.
update public.agents a
   set plan_id = coalesce(
     (
       select id from public.plans
        where monthly_minutes >= a.monthly_minute_limit
          and active = true
        order by monthly_minutes asc
        limit 1
     ),
     (
       select id from public.plans
        where active = true
        order by monthly_minutes desc
        limit 1
     )
   )
 where a.plan_id is null;

-- 2. Phone numbers inventory ---------------------------------------------
create table if not exists public.phone_numbers (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references auth.users(id) on delete cascade,
  e164          text not null unique,
  friendly_name text,
  locality      text,
  region        text,
  sw_phone_sid  text,
  monthly_cost  numeric(8,2) not null default 1.00,
  is_primary    boolean not null default false,
  status        text not null default 'active' check (status in ('active','pending','released')),
  purchased_at  timestamptz not null default now()
);

comment on table public.phone_numbers is
  'Per-agent inventory of owned SignalWire phone numbers. Each agent has 0..N rows; exactly one is_primary=true at a time, mirrored into public.agents.signalwire_caller_id so the unchanged signalwire-bridge function reads the right "From" number.';
comment on column public.phone_numbers.sw_phone_sid is
  'SignalWire IncomingPhoneNumbers resource SID. Captured at purchase time; needed for release/transfer later.';

-- Exactly one primary per agent. Partial unique index — only enforced on
-- is_primary=true rows, so we can have many is_primary=false rows freely.
create unique index if not exists phone_numbers_one_primary_per_agent
  on public.phone_numbers (agent_id) where is_primary = true;

create index if not exists phone_numbers_agent_idx
  on public.phone_numbers (agent_id);

-- Backfill: every agent whose signalwire_caller_id is set gets a matching
-- phone_numbers row marked as their primary. sw_phone_sid stays null
-- (the original number was assigned manually, pre-API). Idempotent on
-- re-run because we filter out agents that already have any rows.
insert into public.phone_numbers (agent_id, e164, is_primary, sw_phone_sid)
select a.id, a.signalwire_caller_id, true, null
  from public.agents a
 where a.signalwire_caller_id is not null
   and not exists (
     select 1 from public.phone_numbers p where p.agent_id = a.id
   );

-- 3. RLS -----------------------------------------------------------------
alter table public.plans         enable row level security;
alter table public.phone_numbers enable row level security;

-- plans: world-readable inside the app (every agent picks from the same
-- catalog). No insert/update/delete policies — managed via dashboard.
drop policy if exists "plans_select_all" on public.plans;
create policy "plans_select_all"
  on public.plans for select
  using (true);

-- phone_numbers: agents see + manage only their own. Admins see all
-- (reuse the public.is_admin_agent() helper defined in 007_signalwire.sql).
drop policy if exists "phone_numbers_select_own" on public.phone_numbers;
create policy "phone_numbers_select_own"
  on public.phone_numbers for select
  using (auth.uid() = agent_id);

drop policy if exists "phone_numbers_select_admin" on public.phone_numbers;
create policy "phone_numbers_select_admin"
  on public.phone_numbers for select
  using (public.is_admin_agent());

drop policy if exists "phone_numbers_insert_own" on public.phone_numbers;
create policy "phone_numbers_insert_own"
  on public.phone_numbers for insert
  with check (auth.uid() = agent_id);

drop policy if exists "phone_numbers_update_own" on public.phone_numbers;
create policy "phone_numbers_update_own"
  on public.phone_numbers for update
  using (auth.uid() = agent_id);

drop policy if exists "phone_numbers_delete_own" on public.phone_numbers;
create policy "phone_numbers_delete_own"
  on public.phone_numbers for delete
  using (auth.uid() = agent_id);
