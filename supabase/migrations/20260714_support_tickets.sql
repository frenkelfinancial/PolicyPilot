-- ============================================================
-- 20260714_support_tickets.sql
-- Support / feedback widget — ticket storage.
--
-- APPLY MANUALLY: paste this whole file into the Supabase SQL
-- Editor (house rule — never `supabase db push`). Idempotent:
-- safe to run twice.
--
-- Tickets are INSERTED by the `support-ticket` edge function using
-- the service-role key (after verifying the caller's JWT), so RLS
-- only needs to let users read their own tickets. No client-side
-- insert/update/delete.
-- ============================================================

create table if not exists public.support_tickets (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete set null,
  email       text,                -- caller's login email (denormalized so tickets survive account deletion)
  name        text,                -- display name at submit time
  type        text not null check (type in ('bug','feature','feedback','question')),
  subject     text not null check (char_length(subject) between 1 and 200),
  message     text not null check (char_length(message) between 1 and 5000),
  context     jsonb not null default '{}'::jsonb,  -- { view, url, user_agent, viewport, app_version }
  status      text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  admin_notes text
);

create index if not exists support_tickets_user_id_idx    on public.support_tickets (user_id);
create index if not exists support_tickets_status_idx     on public.support_tickets (status);
create index if not exists support_tickets_created_at_idx on public.support_tickets (created_at desc);

alter table public.support_tickets enable row level security;

-- Users may read their own tickets (future "my tickets" UI). All writes
-- go through the edge function with the service-role key, which bypasses
-- RLS — so no insert/update/delete policies for authenticated users.
drop policy if exists "support_tickets_select_own" on public.support_tickets;
create policy "support_tickets_select_own"
  on public.support_tickets for select
  to authenticated
  using (user_id = auth.uid());
