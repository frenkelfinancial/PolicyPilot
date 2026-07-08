-- ============================================================
-- Gmail carrier-email integration — Phase 4 (matching + review queue)
-- Run in the Supabase SQL editor (manual schema convention).
--
-- review_queue: parsed events that couldn't be auto-attached to a policy —
-- no match, an ambiguous/one-candidate name match (never auto-applied per the
-- build plan), or low confidence. The Step 6 UI resolves these
-- (attach / create policy / discard). matched_policy_id on parsed_events is set
-- only for confident exact matches.
-- ============================================================

create table if not exists public.review_queue (
  id                  uuid primary key default gen_random_uuid(),
  parsed_event_id     uuid not null references public.parsed_events(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  reason              text not null,     -- no_policy_match | ambiguous_match | low_confidence | pdf_unreadable
  candidate_policy_ids uuid[],           -- policies.id[] pre-selected for one-click confirm
  status              text not null default 'open',  -- open | resolved | discarded
  resolved_by         uuid,
  resolved_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique (parsed_event_id)               -- one open item per parsed event
);

create index if not exists review_queue_user_open_idx on public.review_queue (user_id) where status = 'open';

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.review_queue enable row level security;

-- Users read their own queue and may resolve/discard (update status). Inserts
-- come from the matcher (service_role).
drop policy if exists review_queue_select_own on public.review_queue;
create policy review_queue_select_own on public.review_queue
  for select using (auth.uid() = user_id);

drop policy if exists review_queue_update_own on public.review_queue;
create policy review_queue_update_own on public.review_queue
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
