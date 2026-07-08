-- ============================================================
-- Carrier Mail dashboard actions — mark-done / remove, + summary urgency.
-- Run in the Supabase SQL editor (manual schema convention).
--
-- Soft-delete + done flags on email_ingest_log so the agent can check off or
-- remove a carrier email from the dashboard without touching Gmail. Adds an
-- UPDATE RLS policy so a user can set these on their own rows from the client.
-- ============================================================

alter table public.email_ingest_log add column if not exists done_at    timestamptz;
alter table public.email_ingest_log add column if not exists deleted_at timestamptz;

drop policy if exists email_ingest_log_update_own on public.email_ingest_log;
create policy email_ingest_log_update_own on public.email_ingest_log
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
