-- ============================================================
-- Schedule the voice-campaign scheduler — EVERY MINUTE.
--
-- Run ONCE in the Supabase SQL editor (or via `supabase db query --linked`)
-- after deploying the `voice-campaign-tick` edge function.
--
-- Auth: voice-campaign-tick is deployed with verify_jwt = false (see
-- supabase/config.toml) and authenticates the caller internally against the
-- VOICE_CAMPAIGN_CRON_SECRET function secret — the same pattern as
-- email-pipeline's EMAIL_PIPELINE_CRON_SECRET and the wallet/messaging crons'
-- WALLET_CRON_SECRET. Set the secret once with:
--   supabase secrets set VOICE_CAMPAIGN_CRON_SECRET=<random-64-hex>
--
-- Before running, replace:
--   <project-ref>                  your Supabase project ref (Settings → General)
--   <VOICE_CAMPAIGN_CRON_SECRET>   the same value passed to `supabase secrets set`
-- NEVER commit this file with the real secret substituted in.
--
-- ---- WHY EVERY MINUTE, AND WHY THAT IS CHEAP ----------------------------
--
-- The product promise is "new lead arrives → call within a minute", and a
-- scheduler that runs every five cannot make it. The cost of that frequency is
-- bounded by design: a tick with nothing active is ONE indexed query against
-- `voice_campaigns (active) where active = true` and an immediate return, and
-- a tick with active campaigns but nothing due adds one query against
-- `voice_campaign_enrollments (agent_id, next_action_at) where status =
-- 'active'`. Neither touches the leads table.
--
-- NO DST PAIR. Unlike the twice-daily jobs, this one has no clock time to
-- keep — it runs on the minute, in every zone, all year.
--
-- ---- OVERLAP ------------------------------------------------------------
--
-- pg_net dispatches asynchronously and does not wait, so a tick that runs long
-- WILL overlap the next one. That is expected and safe: every due enrollment
-- is taken with an atomic claim (see _shared/voice-campaign-claim.ts) and the
-- loser of a race gets nothing back. Do not add a lock here.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'voice-campaign-tick',
  '* * * * *',
  $$select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/voice-campaign-tick',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <VOICE_CAMPAIGN_CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );$$
);

-- Verify:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'voice-campaign-tick';
-- Recent runs:
--   select * from cron.job_run_details where jobid = (
--     select jobid from cron.job where jobname = 'voice-campaign-tick'
--   ) order by start_time desc limit 10;
-- What the function actually answered (pg_net keeps the responses):
--   select status_code, content from net._http_response order by created desc limit 5;
-- Undo:
--   select cron.unschedule('voice-campaign-tick');
