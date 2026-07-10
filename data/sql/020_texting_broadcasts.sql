-- ============================================================
-- 020_texting_broadcasts.sql
-- Phase 2 re-scope (PROMPT_07): mass SMS/MMS texting ships now;
-- outbound email (messaging-send-email) is deferred but left in place,
-- dormant behind billing_config.email_enabled.
--
-- Depends on 016_wallet_foundation.sql (wallet_hold/settle/void,
-- billing_config, phone_numbers) and 019_messaging_compliance.sql
-- (messages, consent_records, dnc_list, a2p_registrations,
-- runComplianceGate). Paste after 019_messaging_compliance.sql in the
-- Supabase SQL Editor. Idempotent — safe to re-run.
--
-- Adds:
--   1. billing_config — email_enabled kill switch, sms_max_tps pacing cap.
--   2. phone_numbers.a2p_campaign_id — tracks which Telnyx 10DLC campaign
--      a number has been attached to (see a2p-assign-number). A broadcast
--      may only send `from` a number whose a2p_campaign_id matches the
--      agent's approved a2p_registrations.campaign_id.
--   3. public.broadcasts — one row per mass-send job.
--   4. public.broadcast_recipients — one row per (broadcast, recipient),
--      deduped, carrying its own compliance/skip outcome.
--   5. RLS — agent reads own rows; all writes are service_role (edge
--      functions), same pattern as 019.
-- ============================================================

-- ------------------------------------------------------------
-- 1. billing_config
-- ------------------------------------------------------------
alter table public.billing_config
  add column if not exists email_enabled boolean not null default false,
  add column if not exists sms_max_tps   int     not null default 1;

comment on column public.billing_config.email_enabled is
  'Kill switch for outbound email (messaging-send-email). false (default) = email is built but dormant; the function returns 503 email_disabled without attempting a send. Phase 2 re-scope (PROMPT_07): mass texting ships first, email ships in a later phase — flip this only when Resend domain verification + the two webhooks are live again.';
comment on column public.billing_config.sms_max_tps is
  'Max broadcast sends per second for messaging-broadcast-run, per broadcast. Conservative default (1/s) to avoid carrier filtering on a freshly-approved 10DLC campaign — raise only once Telnyx confirms a higher approved throughput for the campaign.';

-- ------------------------------------------------------------
-- 2. phone_numbers — number-to-campaign assignment tracking.
-- ------------------------------------------------------------
alter table public.phone_numbers
  add column if not exists a2p_campaign_id text;

comment on column public.phone_numbers.a2p_campaign_id is
  'Telnyx 10DLC campaign this number is attached to, set by a2p-assign-number once the Telnyx number->campaign assignment call succeeds (see _shared/telnyx-10dlc-adapter.ts TODO — the exact Telnyx endpoint/fields are unconfirmed as of this migration, so this column may need to be set manually via SQL until that lands). messaging-broadcast-create refuses to start a broadcast from a number whose a2p_campaign_id does not match the agent''s approved a2p_registrations.campaign_id.';

-- ------------------------------------------------------------
-- 3. broadcasts — one row per mass-send job.
-- ------------------------------------------------------------
create table if not exists public.broadcasts (
  id               uuid primary key default gen_random_uuid(),
  agent_id         uuid not null references auth.users(id) on delete cascade,
  from_number      text not null,
  channel          text not null check (channel in ('sms','mms')),
  body             text not null,
  media_url        text,
  status           text not null default 'draft'
                     check (status in ('draft','queued','sending','completed','canceled')),
  total_recipients int not null default 0,
  sent_count       int not null default 0,
  skipped_count    int not null default 0,
  failed_count     int not null default 0,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz
);

comment on table public.broadcasts is
  'One row per mass SMS/MMS send job. messaging-broadcast-create inserts draft/queued rows and expands broadcast_recipients; messaging-broadcast-run processes pending recipients in batches, updating status/sent_count/skipped_count/failed_count as it goes. status=canceled stops messaging-broadcast-run from processing any further pending recipients for this broadcast.';

create index if not exists broadcasts_agent_created_idx
  on public.broadcasts (agent_id, created_at desc);
create index if not exists broadcasts_status_idx
  on public.broadcasts (status) where status in ('queued','sending');

-- ------------------------------------------------------------
-- 4. broadcast_recipients — one row per (broadcast, recipient).
-- ------------------------------------------------------------
create table if not exists public.broadcast_recipients (
  id            uuid primary key default gen_random_uuid(),
  broadcast_id  uuid not null references public.broadcasts(id) on delete cascade,
  agent_id      uuid not null references auth.users(id) on delete cascade,
  to_address    text not null,
  lead_id       uuid,
  source        text not null check (source in ('lead','csv')),
  status        text not null default 'pending'
                  check (status in ('pending','sent','delivered','failed','skipped')),
  skip_reason   text check (skip_reason in ('no_consent','on_dnc','quiet_hours','invalid_phone','duplicate')),
  message_id    uuid references public.messages(id),
  created_at    timestamptz not null default now(),
  unique (broadcast_id, to_address)
);

comment on table public.broadcast_recipients is
  'Expanded recipient list for a broadcast, deduped per (broadcast_id, to_address) via the unique constraint. status starts pending; messaging-broadcast-run runs each pending row through runComplianceGate — a hard fail (no_consent/on_dnc/invalid_phone) marks skipped with skip_reason and charges nothing, a quiet_hours fail is left pending (DEFERRED, not skipped) so a later run sends it once the recipient''s local window opens, and a pass calls the shared send core and links message_id. delivered/failed are set later by messaging-delivery-webhook resolving the underlying messages row, mirrored back here — see messaging-broadcast-run.';
comment on column public.broadcast_recipients.lead_id is
  'Source lead row (public.leads.id) when source=lead. Null for source=csv (CSV rows are not backed by a lead).';

create index if not exists broadcast_recipients_broadcast_idx
  on public.broadcast_recipients (broadcast_id);
create index if not exists broadcast_recipients_pending_idx
  on public.broadcast_recipients (broadcast_id, status) where status = 'pending';
create index if not exists broadcast_recipients_message_idx
  on public.broadcast_recipients (message_id) where message_id is not null;

-- ------------------------------------------------------------
-- 5. RLS — agents read only their own rows; all writes service_role.
-- ------------------------------------------------------------
alter table public.broadcasts           enable row level security;
alter table public.broadcast_recipients enable row level security;

drop policy if exists "broadcasts_select_own" on public.broadcasts;
create policy "broadcasts_select_own"
  on public.broadcasts for select
  using (auth.uid() = agent_id);
drop policy if exists "broadcasts_select_admin" on public.broadcasts;
create policy "broadcasts_select_admin"
  on public.broadcasts for select
  using (public.is_admin_agent());

drop policy if exists "broadcast_recipients_select_own" on public.broadcast_recipients;
create policy "broadcast_recipients_select_own"
  on public.broadcast_recipients for select
  using (auth.uid() = agent_id);
drop policy if exists "broadcast_recipients_select_admin" on public.broadcast_recipients;
create policy "broadcast_recipients_select_admin"
  on public.broadcast_recipients for select
  using (public.is_admin_agent());

-- ------------------------------------------------------------
-- Verify after running:
--
--   select column_name from information_schema.columns
--    where table_name = 'billing_config' and column_name in ('email_enabled','sms_max_tps');
--
--   select column_name from information_schema.columns
--    where table_name = 'phone_numbers' and column_name = 'a2p_campaign_id';
--
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name in ('broadcasts','broadcast_recipients');
-- ------------------------------------------------------------
