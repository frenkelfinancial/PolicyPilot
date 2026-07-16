-- Telnyx Number Reputation: automated spam-score registration & monitoring.
--
-- When numbers are associated with an approved Telnyx "Enterprise", Telnyx
-- registers them across the carrier call-analytics reputation feed (Hiya et
-- al.) on our behalf — this is the automated replacement for manually filing
-- each number on FreeCallerRegistry.com.
--
-- Flow:
--   1. One-time setup via scripts/setup-telnyx-reputation.mjs (enterprise,
--      LOA, enable). It upserts the row in reputation_config below.
--   2. telnyx-buy-number / telnyx-provision-number / telnyx-replace-number
--      best-effort associate each new number at purchase time.
--   3. telnyx-reputation-monitor (cron) syncs approval gates, backfills any
--      unregistered numbers, and copies spam scores onto phone_numbers.

-- Single-row config written by the setup script and the monitor cron.
-- Service-role only: RLS enabled with no policies.
CREATE TABLE IF NOT EXISTS public.reputation_config (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enterprise_id   text,
  status          text,          -- Telnyx reputation activation gate: pending/approved/...
  loa_status      text,          -- Telnyx LOA review gate: pending/approved/rejected
  check_frequency text,          -- business_daily/daily/weekly/biweekly/monthly/never
  enabled_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.reputation_config ENABLE ROW LEVEL SECURITY;

-- Per-number reputation state, surfaced in the numbers UI.
ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS reputation_registered_at timestamptz, -- when associated with the Telnyx enterprise
  ADD COLUMN IF NOT EXISTS spam_risk               text,         -- low / medium / high (null = unknown)
  ADD COLUMN IF NOT EXISTS spam_category           text,         -- e.g. "Telemarketer" when flagged
  ADD COLUMN IF NOT EXISTS reputation_scores       jsonb,        -- {maturity,connection,engagement,sentiment}
  ADD COLUMN IF NOT EXISTS reputation_checked_at   timestamptz;

-- Backfill/monitor cron — schedule after deploying telnyx-reputation-monitor,
-- same pg_cron + pg_net pattern as wallet-renew-numbers (see
-- 20260709b_wallet_foundation.sql). Uses its own REPUTATION_CRON_SECRET.
--
--   select cron.schedule(
--     'telnyx-reputation-monitor',
--     '30 */6 * * *',  -- every 6 hours
--     $$
--     select net.http_post(
--       url     := 'https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/telnyx-reputation-monitor',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'Authorization', 'Bearer ' || 'REPUTATION_CRON_SECRET_VALUE'
--       ),
--       body    := '{}'::jsonb
--     );
--     $$
--   );
