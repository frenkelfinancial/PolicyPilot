-- ============================================================
-- 013_weekly_digest.sql
-- Adds monthly_goal to agents table so the server-side weekly
-- digest email can read each agent's goal without needing
-- localStorage. Run after 004_agent_digest_prefs.sql.
-- ============================================================

-- 1. Add monthly_goal column (mirrors the $50,000 default in the app) --------
alter table public.agents
  add column if not exists monthly_goal numeric(12,2) default 50000 check (monthly_goal > 0);

-- RLS: existing "agents_update_own" policy already covers this column.

-- 2. pg_cron: fire weekly-digest every Monday at 9 AM UTC -------------------
-- Enable the pg_cron extension first if not already enabled:
--   create extension if not exists pg_cron;
-- Enable the http extension for net.http_post:
--   create extension if not exists http;
--
-- Replace the two placeholders before running:
--   <project-ref>  → your Supabase project reference id
--   <anon-key>     → your Supabase anon/service key
--
-- Run this block manually in the SQL Editor after deploying the function.

/*
select cron.schedule(
  'weekly-digest',
  '0 9 * * 1',   -- every Monday at 09:00 UTC
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/weekly-digest',
    headers := '{"Authorization": "Bearer <anon-key>", "Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);
*/

-- To verify or remove the job later:
--   select * from cron.job;
--   select cron.unschedule('weekly-digest');
