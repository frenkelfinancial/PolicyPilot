-- ============================================================
-- 002_policies_leads.sql
-- Per-agent policies + leads, RLS-locked. Run after 001.
--
-- Design choices:
--   - `data jsonb` holds the entire row from the front-end (carrier, status,
--     monthly, etc.). Front-end's flexible JS shape stays canonical; we add
--     hot columns later only when queries demand them.
--   - `client_id` preserves the front-end's own id (Date.now() for policies,
--     genLeadId() string for leads) so upserts from the browser are stable.
--     Server-generated `id uuid` is the canonical PK.
--   - RLS: every policy keys to auth.uid() = agent_id. No service-role access
--     from the client; all paths go through the publishable key + RLS.
-- ============================================================

-- 1. Policies ------------------------------------------------------------
create table if not exists public.policies (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references auth.users(id) on delete cascade,
  client_id   bigint not null,
  data        jsonb not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (agent_id, client_id)
);

create index if not exists policies_agent_id_idx on public.policies (agent_id);

alter table public.policies enable row level security;

drop policy if exists "policies_select_own" on public.policies;
create policy "policies_select_own"
  on public.policies for select
  using (auth.uid() = agent_id);

drop policy if exists "policies_insert_own" on public.policies;
create policy "policies_insert_own"
  on public.policies for insert
  with check (auth.uid() = agent_id);

drop policy if exists "policies_update_own" on public.policies;
create policy "policies_update_own"
  on public.policies for update
  using (auth.uid() = agent_id)
  with check (auth.uid() = agent_id);

drop policy if exists "policies_delete_own" on public.policies;
create policy "policies_delete_own"
  on public.policies for delete
  using (auth.uid() = agent_id);

drop trigger if exists policies_touch_updated_at on public.policies;
create trigger policies_touch_updated_at
  before update on public.policies
  for each row execute function public.touch_updated_at();

-- 2. Leads ---------------------------------------------------------------
create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references auth.users(id) on delete cascade,
  client_id   text not null,
  data        jsonb not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (agent_id, client_id)
);

create index if not exists leads_agent_id_idx on public.leads (agent_id);

alter table public.leads enable row level security;

drop policy if exists "leads_select_own" on public.leads;
create policy "leads_select_own"
  on public.leads for select
  using (auth.uid() = agent_id);

drop policy if exists "leads_insert_own" on public.leads;
create policy "leads_insert_own"
  on public.leads for insert
  with check (auth.uid() = agent_id);

drop policy if exists "leads_update_own" on public.leads;
create policy "leads_update_own"
  on public.leads for update
  using (auth.uid() = agent_id)
  with check (auth.uid() = agent_id);

drop policy if exists "leads_delete_own" on public.leads;
create policy "leads_delete_own"
  on public.leads for delete
  using (auth.uid() = agent_id);

drop trigger if exists leads_touch_updated_at on public.leads;
create trigger leads_touch_updated_at
  before update on public.leads
  for each row execute function public.touch_updated_at();
