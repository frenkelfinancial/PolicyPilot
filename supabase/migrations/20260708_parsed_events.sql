-- ============================================================
-- Gmail carrier-email integration — Phase 3 (extraction output)
-- Run in the Supabase SQL editor (manual schema convention).
--
-- parsed_events: the structured output of a Haiku extraction. One email can
-- produce MULTIPLE rows (e.g. an American-Amicable APPLICATION ACTIVITY digest
-- lists several policies). Append-only — Step 4 matches these to policies and
-- Step 5 routes them; nothing here overwrites existing policy data.
-- ============================================================

create table if not exists public.parsed_events (
  id                uuid primary key default gen_random_uuid(),
  ingest_id         uuid not null references public.email_ingest_log(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  carrier           text not null,
  event_type        text not null,       -- submitted | approved | declined | withdrawn | requirement |
                                          -- payment_scheduled | payment_returned | lapse_pending |
                                          -- policy_active | closed | commission_snapshot |
                                          -- commission_change | debt_notice | other
  policy_number_raw text,                 -- exactly as seen (may be masked: 'xxxxx76911')
  client_name       text,
  amounts           jsonb,                -- {premium, face_amount} or {commission_balance, amount, counts:{...}}
  event_date        date,
  details           jsonb,                -- full extraction incl. the plain-language `summary`
  confidence        numeric,             -- model-reported 0..1
  matched_policy_id uuid,                 -- null until Step 4 matching
  applied           boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists parsed_events_user_idx    on public.parsed_events (user_id);
create index if not exists parsed_events_ingest_idx  on public.parsed_events (ingest_id);
create index if not exists parsed_events_unapplied_idx on public.parsed_events (user_id) where applied = false;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.parsed_events enable row level security;

-- Users read their own extractions; writes happen via service_role (edge fn).
drop policy if exists parsed_events_select_own on public.parsed_events;
create policy parsed_events_select_own on public.parsed_events
  for select using (auth.uid() = user_id);
