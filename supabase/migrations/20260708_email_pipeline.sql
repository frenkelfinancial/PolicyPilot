-- ============================================================
-- Gmail carrier-email integration — Phase 2 (ingestion pipeline tables)
-- Run in the Supabase SQL editor (manual schema convention — no db push).
-- Safe to run more than once (idempotent: IF NOT EXISTS + seed ON CONFLICT).
--
-- Tables:
--   carrier_senders   — the sender-and-type map that drives classification.
--                       Seeded below from docs/carrier_sender_map.json.
--   email_ingest_log  — every carrier email we accepted (audit + idempotency +
--                       cost log). One row per (gmail_account, gmail_message).
--   portal_nudges     — login-required emails (Corebridge secure msg, Americo
--                       portal notices). NOT errors — informational "log in to
--                       view" nudges. Never sent to Claude.
-- ============================================================

-- ── Carrier sender-and-type map ─────────────────────────────────────────────
create table if not exists public.carrier_senders (
  id             serial primary key,
  carrier        text not null,
  from_pattern   text not null,               -- lowercase address or SQL-LIKE ('%@domain')
  subject_pattern text,                        -- case-insensitive regex; required for shared senders
  email_type     text not null,               -- underwriting_status | payment_result | ... | ignore
  content_type   text not null,               -- body | pdf | login_link
  route          text not null,               -- policy_tracker | commission_summary | nudge | ignore
  priority       int  not null default 10,    -- ascending; lower wins when several match an address
  active         boolean not null default true,
  notes          text
);

-- Uniqueness key that treats NULL subject as '' so the seed is idempotent and
-- the aatx/ethos multi-row-per-address cases stay distinct.
create unique index if not exists carrier_senders_uniq
  on public.carrier_senders (carrier, from_pattern, coalesce(subject_pattern, ''));

-- ── Ingest log (audit + idempotency + cost) ─────────────────────────────────
create table if not exists public.email_ingest_log (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  gmail_account_id uuid not null references public.gmail_accounts(id) on delete cascade,
  gmail_message_id text not null,
  carrier          text,
  email_type       text,
  content_type     text,
  route            text,
  from_address     text,
  subject          text,
  received_at      timestamptz,
  parse_status     text not null default 'pending_parse',
      -- pending_parse | parsed | nudged | review | ignored | failed | skipped_cap
  claude_input_tokens  int,
  claude_output_tokens int,
  error            text,
  created_at       timestamptz not null default now(),
  unique (gmail_account_id, gmail_message_id)
);

create index if not exists email_ingest_log_user_idx    on public.email_ingest_log (user_id);
create index if not exists email_ingest_log_status_idx  on public.email_ingest_log (parse_status);

-- ── Login-required nudges (informational, NOT errors) ───────────────────────
create table if not exists public.portal_nudges (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  carrier      text not null,
  subject      text,
  client_hint  text,                           -- e.g. 'Michael Kjenstad' scraped by regex
  received_at  timestamptz,
  ingest_id    uuid references public.email_ingest_log(id) on delete cascade,
  dismissed_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists portal_nudges_user_idx on public.portal_nudges (user_id) where dismissed_at is null;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.carrier_senders   enable row level security;
alter table public.email_ingest_log  enable row level security;
alter table public.portal_nudges     enable row level security;

-- carrier_senders: shared config; any signed-in user may read (Carriers tab).
-- Writes happen via service_role (admin), which bypasses RLS.
drop policy if exists carrier_senders_read on public.carrier_senders;
create policy carrier_senders_read on public.carrier_senders
  for select to authenticated using (true);

-- email_ingest_log: users read their own rows. Writes via service_role only.
drop policy if exists email_ingest_log_select_own on public.email_ingest_log;
create policy email_ingest_log_select_own on public.email_ingest_log
  for select using (auth.uid() = user_id);

-- portal_nudges: users read their own, and may dismiss (update dismissed_at).
drop policy if exists portal_nudges_select_own on public.portal_nudges;
create policy portal_nudges_select_own on public.portal_nudges
  for select using (auth.uid() = user_id);
drop policy if exists portal_nudges_dismiss_own on public.portal_nudges;
create policy portal_nudges_dismiss_own on public.portal_nudges
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- Seed carrier_senders (mirror of supabase/seed_carrier_senders.sql).
-- ON CONFLICT DO NOTHING => re-running this file is safe.
-- ============================================================
insert into public.carrier_senders
  (carrier, from_pattern, subject_pattern, email_type, content_type, route, priority, notes) values
-- MUTUAL OF OMAHA
('mutual_of_omaha','do_not_reply_igo_eapp@mutualofomaha.com',null,'application_activity','body','policy_tracker',10,'New e-app submitted; policy # in subject and body.'),
('mutual_of_omaha','noreply.login@login.mutualofomaha.com',null,'ignore','body','ignore',10,'One-time login codes.'),
('mutual_of_omaha','contractsandappointments@mutualofomaha.com',null,'ignore','pdf','ignore',10,'Contracting forms.'),
('mutual_of_omaha','mutualofomaha@secure.mutualofomaha.com',null,'ignore','body','ignore',10,'Account setup.'),
('mutual_of_omaha','mutualofomaha@e.mutualofomaha.com',null,'ignore','body','ignore',10,'Contracting docs.'),
('mutual_of_omaha','%@mutualofomaha.com','^(App Review|Withdrawn|Phone Interview|Approved|Declined)','underwriting_status','body','policy_tracker',50,'Personal underwriter senders. Body: File Number, Insured, Plan, Face Amount.'),
-- TRANSAMERICA
('transamerica','mocasemanagement@transamerica.com',null,'underwriting_status','body','policy_tracker',10,'Requirements/approvals/closures. POLICY # MASKED xxxxx76911 -> last-5 match. Occasional PDF.'),
('transamerica','newbusinesstlp@transamerica.com',null,'application_activity','body','policy_tracker',10,'Application received.'),
('transamerica','notifications@mylifeinsurance.transamerica.com','Application Results','underwriting_status','body','policy_tracker',10,'FE Express instant decisions (declines, reason in body).'),
('transamerica','notifications@mylifeinsurance.transamerica.com','(Payment Scheduled|Policy Purchase Is Processing|Incomplete Purchase)','payment_result','body','policy_tracker',20,'Payment lifecycle. May be To: client, agent cc''d -> parse client from body.'),
('transamerica','notifications@mylifeinsurance.transamerica.com','(Your Policy Documents Are Ready|Your Application Is Ready to Review)','policy_active','body','policy_tracker',30,'Policy in force / docs ready.'),
('transamerica','tlp-crcontractadmin@transamerica.com',null,'commission_change','body','commission_summary',10,'ZSecure commission-level changes; data in body, schedule PDF attached.'),
('transamerica','transamericacxinsights@transamerica.com',null,'ignore','body','ignore',10,'Surveys.'),
('transamerica','webhelp@transamerica.com',null,'ignore','body','ignore',10,'Login codes.'),
('transamerica','awdemailnotification@transamerica.com',null,'ignore','body','ignore',10,'Auto-replies.'),
-- COREBRIDGE
('corebridge','sigiteam@corebridgefinancial.com',null,'payment_result','body','policy_tracker',10,'SIWL/GIWL new business: returned payments, reissue, beneficiary.'),
('corebridge','svc_ilcc_prod@corebridgefinancial.com',null,'portal_notification','login_link','nudge',10,'Cisco Secure Message: NO data in email. Never fetch the link.'),
('corebridge','donotreply@corebridgefinancial.com',null,'ignore','body','ignore',10,'Activation codes.'),
('corebridge','customerexperience@feedback.corebridgefinancial.com',null,'ignore','body','ignore',10,'Surveys.'),
-- AMERICO
('americo','noreply@americo.com','^Americo Daily Update','commission_summary','body','commission_summary',10,'Daily digest: balances, pending/issued-not-paid/lapse COUNTS. Lapse>0 also flags policy_tracker.'),
('americo','donotreply@americo.com','New Notification Regarding','portal_notification','login_link','nudge',10,'Per-client portal notice. Regex client name + link label; details need portal login.'),
('americo','noreply.collections@americo.com',null,'commission_change','body','commission_summary',10,'Agent debt/chargeback balance.'),
('americo','americo.marketing@americo.com',null,'ignore','body','ignore',10,'Marketing.'),
('americo','lindsay.autry@americo.com',null,'ignore','body','ignore',10,'Marketing (personal).'),
('americo','andrew.kostus@americo.com',null,'ignore','body','ignore',10,'Marketing (personal).'),
('americo','brandon.wilson@americo.com',null,'ignore','body','ignore',10,'Marketing (personal).'),
-- AMERICAN-AMICABLE
('american_amicable','noreply@aatx.com','^APPLICATION ACTIVITY','application_activity','body','policy_tracker',10,'Daily status digest, multiple policies per email -> parser returns array.'),
('american_amicable','noreply@aatx.com','^Returned Payment','payment_result','body','policy_tracker',20,'Payment not honored: policy #, client, amount, reason.'),
('american_amicable','marketingassistants@americanamicable.com',null,'ignore','body','ignore',10,'Welcome/admin.'),
('american_amicable','%@american-amicablegroup.ccsend.com',null,'ignore','body','ignore',10,'Constant Contact marketing.'),
-- ETHOS
('ethos','ethosforagent@mail.ethos-agents.com','(complete their insurance application|application is almost done)','application_activity','body','policy_tracker',10,'Incomplete-application nudges, client name in subject/body.'),
('ethos','ethosforagent@mail.ethos-agents.com','compensation','commission_change','body','commission_summary',20,'Compensation processing/delay notices; no per-policy data.'),
('ethos','ethosforagent@mail.ethos-agents.com',null,'ignore','body','ignore',90,'DEFAULT for this sender: marketing.'),
('ethos','agents@ethoslife.com',null,'ignore','body','ignore',10,'Login codes / device trusted.')
on conflict (carrier, from_pattern, coalesce(subject_pattern, '')) do nothing;
