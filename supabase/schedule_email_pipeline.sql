-- ============================================================
-- Schedule the carrier-email pipeline — twice daily, 9:00 AM + 5:00 PM
-- US Central. Run ONCE in the Supabase SQL editor (or via `supabase db
-- query --linked`) after deploying the `email-pipeline` edge function.
--
-- Auth: email-pipeline is deployed with verify_jwt = false (see
-- supabase/config.toml) and authenticates the caller internally against the
-- EMAIL_PIPELINE_CRON_SECRET function secret — same pattern as the wallet /
-- messaging cron jobs and their WALLET_CRON_SECRET. Set the secret once with:
--   supabase secrets set EMAIL_PIPELINE_CRON_SECRET=<random-64-hex>
--
-- Before running, replace:
--   <project-ref>                 your Supabase project ref (Settings → General)
--   <EMAIL_PIPELINE_CRON_SECRET>  the same value passed to `supabase secrets set`
-- NEVER commit this file with the real secret substituted in.
--
-- pg_cron runs in UTC. US Central is UTC-5 in summer (CDT) and UTC-6 in
-- winter (CST):
--   CDT (Mar–Nov):  9 AM CT = 14:00 UTC   5 PM CT = 22:00 UTC   ← active below
--   CST (Nov–Mar):  9 AM CT = 15:00 UTC   5 PM CT = 23:00 UTC
-- If exact clock time across DST matters, update the two schedules at the
-- change-over with:  select cron.alter_job(job_id, schedule := '0 15 * * *');
-- (find job_id via: select jobid, jobname, schedule from cron.job;)
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 9:00 AM Central (14:00 UTC during CDT)
select cron.schedule(
  'email-pipeline-morning',
  '0 14 * * *',
  $$select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/email-pipeline',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <EMAIL_PIPELINE_CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );$$
);

-- 5:00 PM Central (22:00 UTC during CDT)
select cron.schedule(
  'email-pipeline-evening',
  '0 22 * * *',
  $$select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/email-pipeline',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <EMAIL_PIPELINE_CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );$$
);

-- Verify:
--   select jobid, jobname, schedule, active from cron.job;
-- Recent runs:
--   select * from cron.job_run_details order by start_time desc limit 10;
-- Undo:
--   select cron.unschedule('email-pipeline-morning');
--   select cron.unschedule('email-pipeline-evening');
