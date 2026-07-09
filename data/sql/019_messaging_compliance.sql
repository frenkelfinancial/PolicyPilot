-- ============================================================
-- 019_messaging_compliance.sql
-- Phase 2: SMS/MMS/email usage rails + compliance moat.
--
-- NOTE ON NUMBERING: the build brief that generated this file assumed
-- 014 was the next free number in data/sql/. By the time this was
-- written, 014-018 were already taken (promo email cron, summary emails,
-- wallet foundation/spend-gate/rpc-lockdown) — so this is 019, following
-- the same precedent set in 016_wallet_foundation.sql. No renumbering of
-- those files.
--
-- Depends on 016_wallet_foundation.sql (wallet_accounts, wallet_ledger,
-- wallet_hold/settle/void, billing_config) and 001_agents_profile.sql
-- (agents, touch_updated_at, is_admin_agent from 007_signalwire.sql).
-- Paste after 018_wallet_rpc_lockdown.sql. Idempotent — safe to re-run.
--
-- Adds:
--   1. billing_config columns — A2P fees, message DLR timeout window, and
--      the SMS/MMS written-consent strictness flag.
--   2. agents columns — per-agent outbound email identity (from/signature).
--      No settings UI ships in this phase; set via SQL/admin until a
--      Phase 3 screen exists (flagged in the Cowork hand-off).
--   3. public.consent_records — TCPA consent proof.
--   4. public.dnc_list — per-agent + global do-not-contact.
--   5. public.a2p_registrations — one row per agent's 10DLC brand/campaign.
--   6. public.messages — one row per outbound SMS/MMS/email.
--   7. public.inbound_messages — inbound SMS/MMS (opt-outs) + inbound email
--      replies, logged back against the outbound message they answer.
--   8. RLS — agents read only their own rows; all writes are service_role
--      (edge functions) or the existing wallet_* SECURITY DEFINER RPCs.
--
-- PHONE FORMAT: every contact_phone / to_address / from_number /
-- from_address column below is expected to hold canonical E.164
-- ("+15551234567"), never a raw/punctuated input. Every write and every
-- read (compliance gate, DNC/consent lookups, inbound STOP matching) goes
-- through _shared/phone.ts:toE164() — see messaging-shared.ts and
-- messaging-inbound-webhook. A value stored in any other format will
-- silently fail to match and is a bug, not a supported variant.
-- ============================================================

-- ------------------------------------------------------------
-- 1. billing_config — A2P pass-through fee defaults (real amounts are
--    read from the Telnyx API response at registration time; these are
--    the fallback/display defaults) and the undelivered-hold timeout.
-- ------------------------------------------------------------
alter table public.billing_config
  add column if not exists a2p_brand_fee_mills      bigint not null default 4000,
  add column if not exists a2p_campaign_fee_mills    bigint not null default 15000,
  add column if not exists a2p_monthly_fee_mills     bigint not null default 10000,
  add column if not exists message_dlr_timeout_hours int    not null default 24,
  add column if not exists sms_require_written_consent boolean not null default true;

comment on column public.billing_config.a2p_brand_fee_mills is
  'Fallback/display default for the one-time Telnyx 10DLC brand registration fee ($4.00 = 4000 mills). The real pass-through debit uses the amount on the Telnyx API response when present — see a2p-register.';
comment on column public.billing_config.a2p_campaign_fee_mills is
  'Fallback/display default for the one-time Telnyx 10DLC campaign registration fee ($15.00 = 15000 mills).';
comment on column public.billing_config.a2p_monthly_fee_mills is
  'Fallback/display default for the recurring monthly Telnyx 10DLC campaign fee ($10.00 = 10000 mills).';
comment on column public.billing_config.message_dlr_timeout_hours is
  'How long messaging-timeout-sweep waits for a final delivery receipt before voiding a stale hold (never-charge-undelivered safety net for carrier DLRs that never arrive).';
comment on column public.billing_config.sms_require_written_consent is
  'TCPA requires EXPRESS WRITTEN consent (consent_type=''express_written'') for marketing SMS/MMS specifically — oral/implied (''express'') is not enough. true (default, strict/compliant) means the compliance gate only accepts express_written for sms/mms. Flipping this to false to also accept plain ''express'' consent is a compliance decision the OPERATOR owns (e.g. transactional-only sending under a different legal basis) — do not flip it without understanding why the default is true.';

-- ------------------------------------------------------------
-- 2. agents — per-agent outbound email identity. Nullable; messaging-
--    send-email refuses to send (400 sender_not_configured) until these
--    are set. Config/secret-driven from here — never hardcoded in code.
-- ------------------------------------------------------------
alter table public.agents
  add column if not exists outbound_email_from      text,
  add column if not exists outbound_email_signature text;

comment on column public.agents.outbound_email_from is
  'Verified "Name <local@theiragencydomain.com>" sender address for per-agent outbound email. Domain must be verified in Resend (SPF/DKIM/DMARC) before use — see Cowork hand-off.';
comment on column public.agents.outbound_email_signature is
  'Plain-text or simple-HTML signature appended to every outbound email this agent sends via messaging-send-email.';

-- ------------------------------------------------------------
-- 3. consent_records — TCPA proof of consent per contact.
-- ------------------------------------------------------------
create table if not exists public.consent_records (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references auth.users(id) on delete cascade,
  contact_phone text,
  contact_email text,
  consent_type  text not null check (consent_type in ('express_written','express','none')),
  source        text not null,
  captured_at   timestamptz not null default now(),
  revoked_at    timestamptz,
  constraint consent_records_contact_present check (contact_phone is not null or contact_email is not null)
);

comment on table public.consent_records is
  'TCPA consent proof, one row per consent grant/re-grant (never overwritten — a revoke followed by a fresh opt-in is a new row). The messaging-send-* compliance gate requires the most recent non-revoked row for the recipient to have consent_type <> ''none''.';
comment on column public.consent_records.source is
  'Where consent was captured, e.g. "lead_form", "manual_entry", "verbal_recorded" — human-readable provenance for compliance audits.';

create index if not exists consent_records_agent_phone_idx
  on public.consent_records (agent_id, contact_phone) where contact_phone is not null;
create index if not exists consent_records_agent_email_idx
  on public.consent_records (agent_id, contact_email) where contact_email is not null;

-- ------------------------------------------------------------
-- 4. dnc_list — per-agent (agent_id set) + global (agent_id null,
--    e.g. federal DNC import) do-not-contact entries. Opt-out keywords
--    (STOP/UNSUBSCRIBE/...) auto-insert a per-agent row on inbound.
-- ------------------------------------------------------------
create table if not exists public.dnc_list (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid references auth.users(id) on delete cascade,
  contact_phone text,
  contact_email text,
  reason        text,
  source        text not null default 'manual' check (source in ('manual','opt_out_keyword','import','global')),
  created_at    timestamptz not null default now(),
  constraint dnc_list_contact_present check (contact_phone is not null or contact_email is not null)
);

comment on table public.dnc_list is
  'Do-not-contact list. agent_id null = global entry (applies to every agent, e.g. a federal DNC import); agent_id set = that agent''s own list (most commonly populated by an inbound STOP/UNSUBSCRIBE keyword). The compliance gate blocks a send if EITHER a global row or a row for the sending agent matches the recipient.';

-- Partial unique indexes that also dedupe global rows (agent_id null) by
-- coalescing to the nil uuid, since Postgres treats NULL as distinct in a
-- plain unique index.
create unique index if not exists dnc_list_agent_phone_idx
  on public.dnc_list (coalesce(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), contact_phone)
  where contact_phone is not null;
create unique index if not exists dnc_list_agent_email_idx
  on public.dnc_list (coalesce(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), contact_email)
  where contact_email is not null;

-- ------------------------------------------------------------
-- 5. a2p_registrations — one row per agent's Telnyx 10DLC brand +
--    campaign. SMS/MMS sends are blocked (compliance gate: status <>
--    'approved' blocks) until status = 'approved' — this correctly covers
--    suspended/expired too since the gate only special-cases 'approved',
--    not the other states individually; a campaign that Telnyx suspends
--    or lets expire after initial approval falls straight back to
--    blocked without any gate changes needed.
-- ------------------------------------------------------------
create table if not exists public.a2p_registrations (
  agent_id           uuid primary key references auth.users(id) on delete cascade,
  brand_id           text,
  campaign_id        text,
  status             text not null default 'not_started'
                        check (status in ('not_started','pending','approved','rejected','suspended','expired')),
  brand_fee_mills    bigint,
  campaign_fee_mills bigint,
  monthly_fee_mills  bigint,
  business_info      jsonb,
  rejection_reason   text,
  registered_at      timestamptz,
  updated_at         timestamptz not null default now()
);

comment on table public.a2p_registrations is
  'One row per agent''s Telnyx 10DLC brand+campaign registration. status drives the compliance gate in messaging-send-sms/mms (blocked unless approved) and the in-app status indicator. Fee columns record the TRUE amount debited as a pass-through (from the Telnyx API response), not the billing_config default.';

drop trigger if exists a2p_registrations_touch_updated_at on public.a2p_registrations;
create trigger a2p_registrations_touch_updated_at
  before update on public.a2p_registrations
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 6. messages — one row per outbound SMS/MMS/email attempt.
-- ------------------------------------------------------------
create table if not exists public.messages (
  id                  uuid primary key default gen_random_uuid(),
  agent_id            uuid not null references auth.users(id) on delete cascade,
  channel             text not null check (channel in ('sms','mms','email')),
  to_address          text not null,
  from_number         text,
  from_email          text,
  subject             text,
  body_preview        text,
  segments            int,
  provider_message_id text,
  status              text not null default 'queued'
                        check (status in ('queued','sent','delivered','failed','undelivered')),
  hold_ledger_id      uuid references public.wallet_ledger(id),
  consent_id          uuid references public.consent_records(id),
  message_id_header   text,
  created_at          timestamptz not null default now(),
  delivered_at        timestamptz,
  failed_reason       text
);

comment on table public.messages is
  'One row per outbound SMS/MMS/email send attempt. status starts queued, moves to sent once the provider accepts it, then delivered/failed/undelivered once messaging-delivery-webhook (or messaging-timeout-sweep) resolves the hold_ledger_id. Never charged until delivered — see wallet_hold/wallet_settle/wallet_void in 016_wallet_foundation.sql.';
comment on column public.messages.message_id_header is
  'RFC 5322 Message-ID generated for outbound email (channel=email), used so a later inbound reply can be matched back to this row.';

create index if not exists messages_provider_message_id_idx
  on public.messages (provider_message_id) where provider_message_id is not null;
create index if not exists messages_agent_created_idx
  on public.messages (agent_id, created_at desc);

-- ------------------------------------------------------------
-- 7. inbound_messages — inbound SMS/MMS (opt-outs) + inbound email
--    replies. is_opt_out=true rows are also mirrored into dnc_list.
-- ------------------------------------------------------------
create table if not exists public.inbound_messages (
  id                     uuid primary key default gen_random_uuid(),
  agent_id               uuid references auth.users(id) on delete cascade,
  channel                text not null check (channel in ('sms','mms','email')),
  from_address            text not null,
  to_address              text,
  body_preview            text,
  in_reply_to_message_id  uuid references public.messages(id),
  is_opt_out              boolean not null default false,
  provider_event_id       text,
  created_at              timestamptz not null default now()
);

comment on table public.inbound_messages is
  'Inbound side of messaging: SMS/MMS opt-out keywords (STOP/UNSUBSCRIBE/...) logged by messaging-inbound-webhook, and email replies logged by messaging-email-inbound-webhook. in_reply_to_message_id links a reply back to the outbound messages row it answers, when a match is found.';

create unique index if not exists inbound_messages_provider_event_idx
  on public.inbound_messages (provider_event_id) where provider_event_id is not null;
create index if not exists inbound_messages_agent_created_idx
  on public.inbound_messages (agent_id, created_at desc);

-- ------------------------------------------------------------
-- 8. RLS — agents read only their own rows (+ global dnc rows);
--    no insert/update/delete policies for authenticated/anon — every
--    write goes through service_role edge functions.
-- ------------------------------------------------------------
alter table public.consent_records  enable row level security;
alter table public.dnc_list         enable row level security;
alter table public.a2p_registrations enable row level security;
alter table public.messages         enable row level security;
alter table public.inbound_messages enable row level security;

drop policy if exists "consent_records_select_own" on public.consent_records;
create policy "consent_records_select_own"
  on public.consent_records for select
  using (auth.uid() = agent_id);
drop policy if exists "consent_records_select_admin" on public.consent_records;
create policy "consent_records_select_admin"
  on public.consent_records for select
  using (public.is_admin_agent());

drop policy if exists "dnc_list_select_own_or_global" on public.dnc_list;
create policy "dnc_list_select_own_or_global"
  on public.dnc_list for select
  using (agent_id is null or auth.uid() = agent_id);
drop policy if exists "dnc_list_select_admin" on public.dnc_list;
create policy "dnc_list_select_admin"
  on public.dnc_list for select
  using (public.is_admin_agent());

drop policy if exists "a2p_registrations_select_own" on public.a2p_registrations;
create policy "a2p_registrations_select_own"
  on public.a2p_registrations for select
  using (auth.uid() = agent_id);
drop policy if exists "a2p_registrations_select_admin" on public.a2p_registrations;
create policy "a2p_registrations_select_admin"
  on public.a2p_registrations for select
  using (public.is_admin_agent());

drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own"
  on public.messages for select
  using (auth.uid() = agent_id);
drop policy if exists "messages_select_admin" on public.messages;
create policy "messages_select_admin"
  on public.messages for select
  using (public.is_admin_agent());

drop policy if exists "inbound_messages_select_own" on public.inbound_messages;
create policy "inbound_messages_select_own"
  on public.inbound_messages for select
  using (auth.uid() = agent_id);
drop policy if exists "inbound_messages_select_admin" on public.inbound_messages;
create policy "inbound_messages_select_admin"
  on public.inbound_messages for select
  using (public.is_admin_agent());

-- ------------------------------------------------------------
-- Verify after running:
--
--   select table_name from information_schema.tables
--    where table_schema = 'public'
--      and table_name in ('consent_records','dnc_list','a2p_registrations','messages','inbound_messages');
--
--   select column_name from information_schema.columns
--    where table_name = 'billing_config' and column_name like 'a2p_%';
-- ------------------------------------------------------------
