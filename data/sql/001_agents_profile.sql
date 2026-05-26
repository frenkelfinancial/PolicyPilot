-- ============================================================
-- 001_agents_profile.sql
-- Per-agent profile table linked 1:1 to auth.users.
-- Run once in the Supabase SQL Editor.
-- ============================================================

-- 1. Profile table -------------------------------------------------------
create table if not exists public.agents (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text,
  display_name    text,
  contract_level  int  default 100 check (contract_level between 65 and 145),
  npn             text,
  phone           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

comment on table public.agents is
  'Per-agent profile, FK 1:1 to auth.users. RLS: agents see/edit only their own row.';

-- 2. RLS -----------------------------------------------------------------
alter table public.agents enable row level security;

drop policy if exists "agents_select_own" on public.agents;
create policy "agents_select_own"
  on public.agents for select
  using (auth.uid() = id);

drop policy if exists "agents_update_own" on public.agents;
create policy "agents_update_own"
  on public.agents for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "agents_insert_own" on public.agents;
create policy "agents_insert_own"
  on public.agents for insert
  with check (auth.uid() = id);

-- No delete policy: deletion happens via cascade from auth.users.

-- 3. Auto-create a profile row when a new auth user signs up -------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.agents (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Maintain updated_at on every UPDATE ---------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists agents_touch_updated_at on public.agents;
create trigger agents_touch_updated_at
  before update on public.agents
  for each row execute function public.touch_updated_at();

-- 5. Backfill any existing auth.users that signed up before this ran -----
insert into public.agents (id, email)
select id, email from auth.users
on conflict (id) do nothing;
