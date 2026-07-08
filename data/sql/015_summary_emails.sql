-- ============================================================
-- 015_summary_emails.sql                            [DEPLOY PACKAGE]
--
-- Account-summary emails (1st + 15th, 9:00am America/Chicago).
-- Paste into the Supabase SQL Editor by hand (never `db push`).
-- Idempotent: safe to re-run.
--
-- Replace <service-role-key> before running (same convention as 014).
--
-- Prereqs (enable once under Database → Extensions if not already):
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;   -- provides net.http_post
-- ============================================================

-- 1. Opt-out toggle — SEPARATE from digest_enabled (daily digest, default
--    false). Summaries default ON. ------------------------------------------
alter table public.agents
  add column if not exists summary_emails_enabled boolean not null default true;

comment on column public.agents.summary_emails_enabled is
  'Account-summary emails (1st + 15th monthly statements). Default ON; one-click unsubscribe or the Summary-tab toggle sets false. Distinct from digest_enabled (daily digest, default OFF).';

-- Belt-and-suspenders backfill: modern PG backfills the constant default on
-- ADD COLUMN, but run the UPDATE anyway to cover any NULLs.
update public.agents
   set summary_emails_enabled = true
 where summary_emails_enabled is null;

-- RLS: existing "agents_update_own" policy (001) already lets each agent
-- flip their own toggle from the app. The unsubscribe edge function uses
-- the service role. No new policy required.

-- 2. Scheduling — true 9:00am America/Chicago year-round ----------------------
-- pg_cron runs in UTC and cannot express a DST-aware local time, so we fire
-- the function at BOTH candidate UTC hours on the 1st and 15th:
--   14:00 UTC = 9am CDT (summer)   |   15:00 UTC = 9am CST (winter)
-- The monthly-summary edge function checks Chicago local time and only
-- proceeds when it is exactly 9am — the other slot no-ops. No naive-Date
-- drift (the known weekly-digest bug is NOT copied here).

select cron.unschedule('summary-emails-cdt')
 where exists (select 1 from cron.job where jobname = 'summary-emails-cdt');

select cron.schedule(
  'summary-emails-cdt',
  '0 14 1,15 * *',   -- 9am America/Chicago during CDT; guard no-ops in winter
  $$
  select net.http_post(
    url     := 'https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/monthly-summary',
    headers := '{"Authorization": "Bearer <service-role-key>", "Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

select cron.unschedule('summary-emails-cst')
 where exists (select 1 from cron.job where jobname = 'summary-emails-cst');

select cron.schedule(
  'summary-emails-cst',
  '0 15 1,15 * *',   -- 9am America/Chicago during CST; guard no-ops in summer
  $$
  select net.http_post(
    url     := 'https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/monthly-summary',
    headers := '{"Authorization": "Bearer <service-role-key>", "Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

-- Verify:
--   select jobname, schedule from cron.job where jobname like 'summary-emails%';
-- Remove:
--   select cron.unschedule('summary-emails-cdt');
--   select cron.unschedule('summary-emails-cst');
