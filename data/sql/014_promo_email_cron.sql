-- ============================================================
-- 014_promo_email_cron.sql
--
-- 1. Moves weekly-digest to 10am ET (14:00 UTC, correct for EDT).
-- 2. Schedules weekly promo emails every Thursday at 10am ET
--    targeting agents with no active subscription.
--
-- Replace <project-ref> and <service-role-key> before running.
-- ============================================================

-- 1. Move weekly-digest from 9am UTC → 10am ET (14:00 UTC) -----------------
select cron.unschedule('weekly-digest');

select cron.schedule(
  'weekly-digest',
  '0 14 * * 1',   -- every Monday 10am ET (EDT = UTC-4)
  $$
  select net.http_post(
    url     := 'https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/weekly-digest',
    headers := '{"Authorization": "Bearer <service-role-key>", "Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

-- 2. Promo emails every Thursday at 10am ET ---------------------------------
select cron.schedule(
  'promo-email',
  '0 14 * * 4',   -- every Thursday 10am ET
  $$
  select net.http_post(
    url     := 'https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/promo-email',
    headers := '{"Authorization": "Bearer <service-role-key>", "Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

-- Verify both jobs:
-- select jobname, schedule from cron.job;
