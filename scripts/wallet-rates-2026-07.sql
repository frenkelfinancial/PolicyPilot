-- ProducerStack wallet repricing — July 2026
-- Run against Supabase AFTER deploying the updated app.html.
-- billing_config mills are the source of truth for what wallet_debit charges
-- (see pbRenderBillingCard in app.html). 1 mill = $0.001.

-- Dialer minutes: $0.01/min -> $0.012/min  (10 -> 12 mills)
-- Phone numbers:  $3.00/mo  -> $2.00/mo    (3000 -> 2000 mills), UNLIMITED quantity
UPDATE billing_config
SET call_minute_mills  = 12,
    number_local_mills = 2000;

-- AI Sales Agent voice minutes — NEW usage type (needs columns + debit logic):
--   base rate:   $0.075/min  (75 mills)
--   volume rate: $0.065/min  (65 mills) once a wallet has used > 2,000 AI minutes
--                in the current calendar month (rate applies to minutes beyond 2,000)
-- Suggested schema (adjust to taste, then wire into wallet_debit):
-- ALTER TABLE billing_config
--   ADD COLUMN IF NOT EXISTS ai_minute_mills          int NOT NULL DEFAULT 75,
--   ADD COLUMN IF NOT EXISTS ai_minute_volume_mills   int NOT NULL DEFAULT 65,
--   ADD COLUMN IF NOT EXISTS ai_minute_volume_threshold int NOT NULL DEFAULT 2000;

-- If any per-number purchase cap exists (e.g. max_numbers_per_user), remove it:
-- unlimited numbers for rotation is the published claim.
