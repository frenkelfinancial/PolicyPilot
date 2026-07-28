-- ============================================================
-- 20260731_a2p_resumable_registration.sql
-- PROMPT_15 Phase 2 — make A2P registration RESUMABLE, and make duplicate
-- brands/campaigns/fees impossible at the DATABASE level rather than only
-- in application code.
--
-- WHY THIS EXISTS
-- ---------------
-- a2p-register was pulled from production on 2026-07-28 because it had a
-- money-losing failure mode, not a cosmetic bug:
--
--   submitBrand() POSTs to a REAL endpoint, so Telnyx CREATES A REAL,
--   BILLABLE BRAND. The response parse then read `data.data.brandId`
--   against a bare-object response, got undefined, and the function
--   returned 502 having written NO DATABASE ROW. Result: a paid-for brand
--   at Telnyx that nothing in our system points at. Retrying created a
--   SECOND one.
--
-- The fix is structural, not a better parse: every step persists BEFORE the
-- next one begins, and a re-invocation resumes from the furthest completed
-- step. This file provides the durable state that makes that possible, plus
-- three hard guarantees that hold even if the application code is wrong:
--
--   1. One brand per agent, forever      -> unique index + immutability trigger
--   2. One campaign per brand/agent      -> unique index + immutability trigger
--   3. Each registration fee charged once -> partial unique index on the ledger
--
-- HOW TO APPLY: `supabase db query --linked -f <this file>`, transaction-
-- wrapped, per the rules in docs/schema-state.md. Idempotent — safe to
-- re-run. ADDITIVE ONLY: adds columns, indexes, a function and a trigger.
-- No DROP of any data-bearing object, nothing touching auth.* or storage.*.
-- (`drop trigger if exists` immediately before `create trigger` is the
-- standard idempotency idiom used throughout this repo, not a data change.)
--
-- PREREQUISITE: data/sql/019_messaging_compliance.sql and
-- supabase/migrations/20260728_a2p_sole_proprietor.sql (both confirmed
-- applied — see docs/schema-state.md).
-- ============================================================

-- ------------------------------------------------------------
-- 1. a2p_registrations — durable step markers.
--
-- The registration is a state machine, and each of these columns is the
-- record that ONE step completed. Nothing is inferred: "did we already
-- create the brand?" is answered by brand_id being non-null, never by
-- guessing from status. That is what makes the flow resumable.
--
-- The step order (see a2p-register/index.ts REGISTRATION STEPS):
--   brand submitted -> brand fee charged -> [sole prop: OTP sent -> OTP
--   verified] -> campaign submitted -> campaign fee charged
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.a2p_registrations') is null then
    raise notice '[20260731] public.a2p_registrations is missing — apply data/sql/019_messaging_compliance.sql first. Skipping.';
  else
    alter table public.a2p_registrations
      add column if not exists brand_submitted_at      timestamptz,
      add column if not exists campaign_submitted_at   timestamptz,
      add column if not exists brand_fee_charged_at    timestamptz,
      add column if not exists campaign_fee_charged_at timestamptz,
      add column if not exists otp_sent_to             text,
      add column if not exists otp_attempts            int not null default 0,
      add column if not exists last_error              text,
      add column if not exists last_error_at           timestamptz,
      add column if not exists telnyx_env              text;

    comment on column public.a2p_registrations.brand_submitted_at is
      'When Telnyx ACCEPTED the brand and returned a brand id. Written in the SAME statement as brand_id, before anything else happens — this row existing is what stops a retry creating a second billable brand. Never cleared.';
    comment on column public.a2p_registrations.campaign_submitted_at is
      'When Telnyx accepted the campaign (POST /10dlc/campaignBuilder) and returned a campaign id. Written with campaign_id, before the $15 debit.';
    comment on column public.a2p_registrations.brand_fee_charged_at is
      'When the $4 brand fee was successfully debited from the wallet. NULL = not charged yet; a resumed run charges it, a resumed run with this set does NOT. Split from the campaign fee deliberately: an agent who abandons before entering their OTP pays $4, never $19.';
    comment on column public.a2p_registrations.campaign_fee_charged_at is
      'When the $15 campaign fee was debited. Only ever set after campaign_submitted_at — we do not charge for a campaign Telnyx has not accepted.';
    comment on column public.a2p_registrations.otp_sent_to is
      'E.164 mobile the sole-proprietor brand PIN was sent to. Two jobs: (1) show the agent WHICH number to check, masked; (2) enforce Telnyx''s "max 3 sole-prop brands per mobile number" cap by counting prior registrations on the same number.';
    comment on column public.a2p_registrations.otp_attempts is
      'Count of failed PIN verifications for the CURRENT otp_requested_at window. Reset to 0 on resend. Telnyx does not expose attempts-remaining, so this is ours.';
    comment on column public.a2p_registrations.last_error is
      'Last step failure, human-readable, so a half-finished registration explains itself in the UI instead of looking merely "stuck". Cleared when the step it belonged to finally succeeds.';
    comment on column public.a2p_registrations.telnyx_env is
      'Which Telnyx brand environment this row belongs to: sandbox (TELNYX_SANDBOX_BRAND_ID, mock, no fee) or production (real, billable). a2p-register refuses production unless allow_production:true is explicitly passed — see docs/telnyx-10dlc-brands.md.';

    alter table public.a2p_registrations drop constraint if exists a2p_registrations_telnyx_env_check;
    alter table public.a2p_registrations add constraint a2p_registrations_telnyx_env_check
      check (telnyx_env is null or telnyx_env in ('sandbox','production'));

    -- Backfill the step markers for any row that predates this migration.
    -- A row holding a brand_id got that id from Telnyx accepting a brand, so
    -- brand_submitted_at is true-by-construction; registered_at is the best
    -- timestamp we have for when that happened.
    update public.a2p_registrations
       set brand_submitted_at = coalesce(brand_submitted_at, registered_at, updated_at)
     where brand_id is not null and brand_submitted_at is null;

    update public.a2p_registrations
       set campaign_submitted_at = coalesce(campaign_submitted_at, registered_at, updated_at)
     where campaign_id is not null and campaign_submitted_at is null;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. GUARANTEE 1+2 — one brand and one campaign per agent, and no two
--    agents ever sharing a PRODUCTION brand or campaign.
--
-- agent_id is already the PRIMARY KEY, so there is at most one registration
-- row per agent. These indexes add the other half: a given production Telnyx
-- brand or campaign id can appear on AT MOST ONE row, ever.
--
-- That is also the ISV rule enforced structurally. Telnyx prohibits sharing a
-- brand or campaign across end customers (docs/…/isv-reseller-onboarding),
-- and PROMPT_15 says "do not add any code path that registers multiple agents
-- under one brand". Now no code path CAN — the second write fails.
--
-- SANDBOX IS EXCLUDED, deliberately. TELNYX_SANDBOX_BRAND_ID is ONE shared
-- mock brand that every dev registration points at (docs/telnyx-10dlc-brands
-- .md: "use the SANDBOX brand for all Phase 1 / dev testing"). It is mock,
-- never billed, and carries no real routing, so the one-brand-per-customer
-- rule does not apply to it — and a unique index that included it would make
-- the sandbox usable by exactly one agent, which defeats its purpose.
-- ------------------------------------------------------------
create unique index if not exists a2p_registrations_brand_id_uidx
  on public.a2p_registrations (brand_id)
  where brand_id is not null and telnyx_env is distinct from 'sandbox';

create unique index if not exists a2p_registrations_campaign_id_uidx
  on public.a2p_registrations (campaign_id)
  where campaign_id is not null and telnyx_env is distinct from 'sandbox';

-- Immutability. The unique indexes stop two AGENTS sharing an id; this stops
-- ONE agent's row having its id REPLACED — which is the actual orphan-brand
-- mechanism. Without it, a buggy retry could overwrite brand_id with a second
-- brand's id and the first (paid-for) brand would be lost from the database
-- entirely, which is precisely the 2026-07-28 incident.
--
-- Deliberately applies to the SERVICE ROLE TOO. Every other guard in this
-- schema carves out service_role because the edge functions are trusted to
-- write business data; this one does not, because the thing being prevented
-- IS an edge-function bug. A guard the buggy caller can bypass is not a
-- guarantee.
--
-- ONE BUILT-IN EXCEPTION: sandbox -> production promotion. A row whose
-- telnyx_env is 'sandbox' holds a mock brand/campaign that cost nothing and
-- routes nothing, so replacing those ids with real ones orphans nothing.
-- Verifying in sandbox and then registering for real is the intended
-- workflow, and it must not require a manual DB unlock.
--
-- ESCAPE HATCH for everything else — a brand Telnyx deleted outright, or a
-- rejected campaign resubmitted as a NEW campaign (another $15, a spend
-- decision rather than a retry):
--
--   begin;
--     set local app.a2p_allow_id_change = 'on';
--     update public.a2p_registrations set campaign_id = '…' where agent_id = '…';
--   commit;
--
-- Per-transaction, greppable, impossible to trip accidentally.
create or replace function public.a2p_registrations_guard_ids()
returns trigger
language plpgsql
as $$
declare
  v_allow text := coalesce(nullif(current_setting('app.a2p_allow_id_change', true), ''), 'off');
begin
  if lower(v_allow) in ('on','true','1') then
    return new;
  end if;

  -- Promoting a verified-in-sandbox registration to a real one. Nothing to
  -- orphan: mock brands and mock campaigns are never billed (billedDate is
  -- null) and carry no carrier routing.
  if old.telnyx_env = 'sandbox' and new.telnyx_env = 'production' then
    return new;
  end if;

  if old.brand_id is not null and new.brand_id is distinct from old.brand_id then
    raise exception
      'a2p_brand_id_immutable: agent % is already registered to Telnyx brand %. Refusing to change it to % — that would orphan a real, billable brand. Resume the existing registration instead. (Deliberate replacement: set local app.a2p_allow_id_change = ''on''.)',
      old.agent_id, old.brand_id, coalesce(new.brand_id, 'NULL')
      using errcode = '23514';
  end if;

  if old.campaign_id is not null and new.campaign_id is distinct from old.campaign_id then
    raise exception
      'a2p_campaign_id_immutable: agent % is already registered to Telnyx campaign %. Refusing to change it to % — each campaign submission costs $15. (Deliberate replacement: set local app.a2p_allow_id_change = ''on''.)',
      old.agent_id, old.campaign_id, coalesce(new.campaign_id, 'NULL')
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.a2p_registrations_guard_ids() is
  'Makes a2p_registrations.brand_id / campaign_id write-once. Applies to service_role as well, because the failure it guards against is an edge-function bug creating a second billable Telnyx brand. Bypass for a deliberate replacement with: set local app.a2p_allow_id_change = ''on''.';

drop trigger if exists a2p_registrations_guard_ids on public.a2p_registrations;
create trigger a2p_registrations_guard_ids
  before update on public.a2p_registrations
  for each row execute function public.a2p_registrations_guard_ids();

-- ------------------------------------------------------------
-- 3. GUARANTEE 3 — each registration fee is charged at most once.
--
-- Same shape as the existing wallet_ledger_ai_call_ref_uidx precedent.
-- a2p-register writes the brand fee as ref_type='a2p_brand'/ref_id=<brand
-- id> and the campaign fee as ref_type='a2p_campaign'/ref_id=<campaign id>,
-- so a double debit for the same brand or campaign is a unique violation
-- rather than a real second charge against the agent's wallet.
--
-- Belt and braces with brand_fee_charged_at / campaign_fee_charged_at above:
-- the timestamps make the code skip an already-charged step, and this index
-- makes a slip impossible rather than merely unlikely.
--
-- Safe to add: verified 0 existing rows with category='a2p_registration' at
-- 2026-07-28, so there is nothing to conflict with.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.wallet_ledger') is null then
    raise notice '[20260731] public.wallet_ledger is missing — apply data/sql/016_wallet_foundation.sql first. Skipping.';
  else
    create unique index if not exists wallet_ledger_a2p_fee_ref_uidx
      on public.wallet_ledger (ref_type, ref_id)
      where category = 'a2p_registration' and entry_type = 'debit';
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. RLS — unchanged, deliberately.
--
-- a2p_registrations already has select-own + select-admin and NO owner
-- UPDATE policy, so an agent cannot write any of these columns (confirmed in
-- docs/schema-state.md's owner-updatable sweep). Adding columns to a table
-- whose policies are table-level changes nothing about who can read them.
-- Same reasoning as 20260728_a2p_sole_proprietor.sql §RLS.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- Verify after running:
--
--   select column_name from information_schema.columns
--    where table_name='a2p_registrations'
--      and column_name in ('brand_submitted_at','campaign_submitted_at',
--                          'brand_fee_charged_at','campaign_fee_charged_at',
--                          'otp_sent_to','otp_attempts','telnyx_env');
--
--   select indexname from pg_indexes where tablename='a2p_registrations';
--   select tgname from pg_trigger where tgrelid='public.a2p_registrations'::regclass and not tgisinternal;
--   select indexname from pg_indexes where indexname='wallet_ledger_a2p_fee_ref_uidx';
--
-- Behavioural check (the guarantee, not just the object):
--   insert into public.a2p_registrations (agent_id, brand_id) values (<uuid>, 'B1');
--   update public.a2p_registrations set brand_id='B2' where agent_id=<uuid>;
--     -> ERROR a2p_brand_id_immutable
-- ------------------------------------------------------------
