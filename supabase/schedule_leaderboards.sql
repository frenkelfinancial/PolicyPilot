-- ============================================================
-- Schedule the leaderboard maintenance jobs. Run ONCE (or re-run — both
-- statements are idempotent through cron.unschedule + cron.schedule).
--
-- UNLIKE every other cron job in this project, these call a SQL function
-- DIRECTLY rather than net.http_post-ing an edge function. There is no edge
-- function to call: the whole feature is one migration plus app.html. That
-- means no CRON_SECRET to store, no verify_jwt flag to get wrong, and no
-- HTTP timeout to tune — pg_cron runs as `postgres`, and both functions are
-- SECURITY DEFINER owned by postgres, so they simply run.
--
-- Neither job takes a parameter naming an agent or a leader. lb_evaluate_all
-- sweeps every agent; lb_rollover sweeps every agency. There is nothing here
-- that could be pointed at one person.
--
-- pg_cron runs in UTC. 06:05 / 06:20 UTC is 01:05 / 01:20 Central during CDT
-- and 00:05 / 00:20 during CST — the quiet end of the night either way, and
-- crucially still the SAME Chicago calendar day the jobs reason about.
-- lb_rollover() derives "today" from America/Chicago itself rather than from
-- the server clock, so a DST shift changes when it runs, never what it does.
-- That is why there is no CDT/CST pair here, unlike schedule_email_pipeline.
--
-- Verify:      select jobid, jobname, schedule, active from cron.job;
-- Recent runs: select * from cron.job_run_details order by start_time desc limit 10;
-- Undo:        select cron.unschedule('leaderboard-nightly');
--              select cron.unschedule('leaderboard-rollover');
-- ============================================================

create extension if not exists pg_cron;

-- ------------------------------------------------------------
-- 1. Nightly evaluation, 06:05 UTC.
--
-- Records, achievements and the milestone feed are also refreshed from the
-- browser (lb_refresh_me) whenever an agent opens the Agency tab, which is
-- what makes a record break feel immediate. This job is the safety net for
-- everything that happens while nobody is looking: a lapse recorded by the
-- carrier-mail pipeline changing net AP, a statement moving a policy to
-- chargeback, or an agent who simply has not opened the app.
--
-- p_silent => false, so a record genuinely broken since the last run is
-- announced. It cannot double-announce: the milestone dedupe_key encodes the
-- event, so a night on which nothing changed writes nothing at all.
-- ------------------------------------------------------------
select cron.unschedule('leaderboard-nightly')
 where exists (select 1 from cron.job where jobname = 'leaderboard-nightly');

select cron.schedule(
  'leaderboard-nightly',
  '5 6 * * *',
  $$select public.lb_evaluate_all(false);$$
);

-- ------------------------------------------------------------
-- 2. Period rollover, 06:20 UTC.
--
-- Fifteen minutes after the sweep, so a period closes against figures that
-- have just been refreshed rather than yesterday's.
--
-- The job runs every night and decides for itself whether anything closed:
-- Monday closes a week, the 1st closes a month, and the 1st of Jan/Apr/Jul/
-- Oct also closes a quarter. Running it on an ordinary Tuesday is a no-op.
--
-- It is safe to miss a night. Every branch is idempotent through
-- leaderboard_snapshots' unique key, so re-running writes the period once —
-- but a missed night IS a missed period, because the next run asks about the
-- next day. To backfill one by hand:
--     select public.lb_rollover(date '2026-08-01');
-- ------------------------------------------------------------
select cron.unschedule('leaderboard-rollover')
 where exists (select 1 from cron.job where jobname = 'leaderboard-rollover');

select cron.schedule(
  'leaderboard-rollover',
  '20 6 * * *',
  $$select public.lb_rollover();$$
);
