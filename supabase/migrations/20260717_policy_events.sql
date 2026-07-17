-- ============================================================
-- Gmail carrier-email integration — Phase 4/5 (apply step)
-- Run in the Supabase SQL editor (manual schema convention).
--
-- policy_events: append-only audit trail of everything the email pipeline
-- wrote back onto a policy. One row per applied parsed_event. new_status is
-- null for informational events (requirement, payment_returned, ...) that
-- attached + logged without changing the tracker status. This is what lets
-- the agent see — and manually undo via Edit Policy — anything the parser did.
-- ============================================================

create table if not exists public.policy_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  policy_id       uuid not null references public.policies(id) on delete cascade,
  parsed_event_id uuid references public.parsed_events(id) on delete set null,
  carrier         text,
  event_type      text not null,
  client_name     text,
  old_status      text,
  new_status      text,              -- null = informational, no status change
  summary         text,
  event_date      date,
  created_at      timestamptz not null default now()
);

create index if not exists policy_events_user_idx   on public.policy_events (user_id, created_at desc);
create index if not exists policy_events_policy_idx on public.policy_events (policy_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.policy_events enable row level security;

-- Users read their own history; writes happen via service_role (edge fn).
drop policy if exists policy_events_select_own on public.policy_events;
create policy policy_events_select_own on public.policy_events
  for select using (auth.uid() = user_id);
