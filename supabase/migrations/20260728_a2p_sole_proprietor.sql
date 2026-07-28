-- ============================================================
-- 20260728_a2p_sole_proprietor.sql
-- A2P 10DLC zero-touch (PROMPT_15) — schema for Sole Proprietor
-- registration + number->campaign assignment tracking.
--
-- HOW TO APPLY (this project applies schema BY MANUAL PASTE, never db push —
-- see docs/gmail-oauth-setup.md: "schema is applied manually in this project
-- — do not db push"):
--   1. Open the Supabase Dashboard → SQL Editor for project
--      cweiaibjigjwspmshcrj (frenkelfinancial's Project).
--   2. Paste this whole file and Run. It is idempotent — safe to re-run.
--   PREREQUISITE: data/sql/019_messaging_compliance.sql (a2p_registrations,
--   billing_config A2P fees) and 020_texting_broadcasts.sql
--   (phone_numbers.a2p_campaign_id) must already be applied — they create the
--   base tables this file ALTERs.
--
-- FRESH-DATABASE SAFE: every change is wrapped in a `to_regclass(...) is not
-- null` guard, because `add column if not exists` / `comment on column` do
-- NOT protect against a MISSING TABLE (they error with "relation does not
-- exist"). On a fresh DB where a base table isn't there yet, that table's
-- block is skipped with a NOTICE instead of failing — so pasting this before
-- 019/020 is a no-op-with-warning, not an error. Re-paste after 019/020.
--
-- Lands ALL columns the PROMPT_15 phases need in one additive migration,
-- even though the code ships phase-by-phase:
--   • Phase 1 (number assignment): phone_numbers.sms_capable /
--     a2p_assignment_status / a2p_assigned_at / sms_setup_error, and
--     a2p_registrations.assignment_status / assignment_failure_reason.
--   • Phase 2 (sole proprietor): a2p_registrations.brand_type / otp_* /
--     website_url / max_numbers / tcr_*, the widened status check
--     (adds 'awaiting_otp'), and billing_config.a2p_sole_prop_monthly_fee_mills.
--
-- RLS: no new policies. a2p_registrations and phone_numbers already enable
-- RLS with select-own + select-admin and service-role-only writes (019 / 009).
-- Table-level policies cover every column, new ones included — matching the
-- pattern in 20260709b_wallet_foundation.sql. Adding columns changes no policy.
-- ============================================================

-- ------------------------------------------------------------
-- 1. a2p_registrations — sole-proprietor brand type, OTP lifecycle,
--    assignment mirror, TCR ids, website, and per-brand number cap.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.a2p_registrations') is null then
    raise notice '[20260728] public.a2p_registrations is missing — apply data/sql/019_messaging_compliance.sql first, then re-run. Skipping a2p_registrations changes.';
  else
    alter table public.a2p_registrations
      add column if not exists brand_type                text not null default 'standard',
      add column if not exists otp_status                text,
      add column if not exists otp_requested_at          timestamptz,
      add column if not exists otp_verified_at           timestamptz,
      add column if not exists assignment_status         text,
      add column if not exists assignment_failure_reason text,
      add column if not exists tcr_brand_id              text,
      add column if not exists tcr_campaign_id           text,
      add column if not exists website_url               text,
      add column if not exists max_numbers               int;

    -- brand_type: standard (EIN entity) vs sole_proprietor (1099 producer).
    alter table public.a2p_registrations drop constraint if exists a2p_registrations_brand_type_check;
    alter table public.a2p_registrations add constraint a2p_registrations_brand_type_check
      check (brand_type in ('standard','sole_proprietor'));

    -- otp_status: sole-prop mobile OTP lifecycle. NULL for standard brands.
    alter table public.a2p_registrations drop constraint if exists a2p_registrations_otp_status_check;
    alter table public.a2p_registrations add constraint a2p_registrations_otp_status_check
      check (otp_status is null or otp_status in ('not_sent','sent','verified','expired','failed'));

    -- Widen the status check to include 'awaiting_otp' (sole prop: brand
    -- submitted, campaign NOT yet submitted, waiting for the mobile OTP).
    -- The original inline check from 019 is named a2p_registrations_status_check.
    alter table public.a2p_registrations drop constraint if exists a2p_registrations_status_check;
    alter table public.a2p_registrations add constraint a2p_registrations_status_check
      check (status in ('not_started','pending','approved','rejected','suspended','expired','awaiting_otp'));

    comment on column public.a2p_registrations.brand_type is
      'standard = EIN-backed entity. sole_proprietor = 1099 producer, no EIN (Telnyx SOLE_PROPRIETOR): one campaign per brand, ONE phone number per campaign, ~1k msgs/day, requires mobile OTP + a website/social URL. Enforced in a2p-register (Phase 2.3).';
    comment on column public.a2p_registrations.otp_status is
      'Sole-prop mobile OTP lifecycle: not_sent -> sent -> verified, or expired (24h window lapsed) / failed. NULL for standard brands. A resend resets sent + otp_requested_at.';
    comment on column public.a2p_registrations.otp_requested_at is
      'When the current OTP was last requested. Drives the 24h expiry countdown + auto-offer-resend. Telnyx invalidates the PIN 24h after delivery.';
    comment on column public.a2p_registrations.assignment_status is
      'Roll-up of the agent''s texting-number assignment for the status wizard (Phase 5): a Telnyx phone_number_campaigns enum value (PENDING_ASSIGNMENT / ASSIGNED / FAILED_ASSIGNMENT). Per-number source of truth is phone_numbers.a2p_assignment_status; sole prop has exactly one number.';
    comment on column public.a2p_registrations.assignment_failure_reason is
      'Telnyx failureReasons from the last FAILED_ASSIGNMENT, surfaced in UI Retry copy. Cleared on a successful assignment.';
    comment on column public.a2p_registrations.tcr_brand_id is
      'The Campaign Registry (TCR) brand id, distinct from the Telnyx brand_id. Recorded for support/audit; not used for routing.';
    comment on column public.a2p_registrations.tcr_campaign_id is
      'The Campaign Registry (TCR) campaign id, distinct from the Telnyx campaign_id.';
    comment on column public.a2p_registrations.website_url is
      'Business website OR social-business URL (Facebook/Instagram/LinkedIn). Required for sole-prop registration (Phase 2.5). TODO(PROMPT_16): replaced by the auto-generated producerstack.com/a/<slug> compliance page.';
    comment on column public.a2p_registrations.max_numbers is
      'Per-brand number cap: 1 for sole_proprietor (Telnyx hard limit), 49 for standard. Enforced when assigning a number.';

    -- Backfill max_numbers for any pre-existing rows.
    update public.a2p_registrations
       set max_numbers = case when brand_type = 'sole_proprietor' then 1 else 49 end
     where max_numbers is null;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. phone_numbers — per-number assignment state. sms_capable is the single
--    gate the SMS composer reads (Phase 2.1): true only once the number is
--    confirmed ASSIGNED to the agent's approved campaign. sms_setup_error
--    records a messaging-profile attach failure so it's visible on the row.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.phone_numbers') is null then
    raise notice '[20260728] public.phone_numbers is missing — apply data/sql/009_phone_book.sql first, then re-run. Skipping phone_numbers changes.';
  else
    alter table public.phone_numbers
      add column if not exists sms_capable           boolean not null default false,
      add column if not exists a2p_assignment_status text,
      add column if not exists a2p_assigned_at       timestamptz,
      add column if not exists sms_setup_error       text;

    comment on column public.phone_numbers.sms_capable is
      'true only when this number is confirmed ASSIGNED to the agent''s approved 10DLC campaign (a2p_campaign_id set + Telnyx assignmentStatus=ASSIGNED). The SMS/MMS composer + broadcast from-number picker gate on this. Buying a number does NOT make it sms_capable — assignment does. For sole prop, at most one number per agent is ever sms_capable.';
    comment on column public.phone_numbers.a2p_assignment_status is
      'Raw Telnyx phone_number_campaigns assignmentStatus: PENDING_ASSIGNMENT / ASSIGNED (sms_capable flips true) / FAILED_ASSIGNMENT. NULL = never submitted. a2p-status-poll flips PENDING_ASSIGNMENT -> ASSIGNED once Telnyx confirms.';
    comment on column public.phone_numbers.a2p_assigned_at is
      'When this number reached ASSIGNED. Carrier propagation takes a further 24-72h before delivery is fully reliable — a failed test send at hour 2 is expected, not broken.';
    comment on column public.phone_numbers.sms_setup_error is
      'Last messaging-profile attach error for this number (from ensureNumberOnMessagingProfile at purchase), or NULL when the number is attached OK. Non-null means SMS setup did not complete and campaign assignment will fail until it is fixed — surfaced instead of being swallowed as a best-effort warning.';

    -- Backfill: any number already attached to a campaign (a2p_campaign_id
    -- set, e.g. via the old manual-SQL interim path) is treated as
    -- ASSIGNED + sms_capable so the Phase 2 composer gate doesn't wrongly
    -- disable an already-working texting number. Idempotent.
    update public.phone_numbers
       set sms_capable           = true,
           a2p_assignment_status = coalesce(a2p_assignment_status, 'ASSIGNED'),
           a2p_assigned_at       = coalesce(a2p_assigned_at, now())
     where a2p_campaign_id is not null
       and sms_capable = false;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. billing_config — sole-prop recurring fee ($2/mo per Telnyx pricing,
--    NOT the $10 default used for standard). See fee-reconciliation note.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.billing_config') is null then
    raise notice '[20260728] public.billing_config is missing — apply data/sql/016_wallet_foundation.sql first, then re-run. Skipping billing_config changes.';
  else
    alter table public.billing_config
      add column if not exists a2p_sole_prop_monthly_fee_mills int not null default 2000;

    comment on column public.billing_config.a2p_sole_prop_monthly_fee_mills is
      'Recurring monthly Telnyx 10DLC campaign fee for SOLE PROPRIETOR brands ($2.00 = 2000 mills, per Telnyx published sole-prop pricing). Distinct from a2p_monthly_fee_mills (standard). NOTE: monthly fee is STORED but not yet charged by any cron — see PROMPT_15 fee reconciliation. a2p_monthly_fee_mills (10000 = $10) is UNVERIFIED against a real Telnyx invoice; confirm before wiring recurring billing.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Verify after running:
--
--   select column_name from information_schema.columns
--    where table_name = 'a2p_registrations'
--      and column_name in ('brand_type','otp_status','assignment_status',
--                          'website_url','max_numbers','tcr_brand_id');
--
--   select column_name from information_schema.columns
--    where table_name = 'phone_numbers'
--      and column_name in ('sms_capable','a2p_assignment_status','a2p_assigned_at','sms_setup_error');
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.a2p_registrations'::regclass and contype = 'c';
-- ------------------------------------------------------------
