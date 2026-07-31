-- ============================================================
-- 20260804 — SMS consent joins the attestation tool (D2), and
--            "verify to activate" for email + phone (F1–F4).
--
-- TWO INDEPENDENT PIECES, one migration, because they ship together.
--
--   1. lead_consent_events.channel — the consent ledger learns to say
--      WHICH permission an event was about. Voice and text are different
--      permissions; the ledger has to be able to tell them apart forever.
--
--   2. agents.email_verified_at / phone_verified_at / phone_e164, and
--      public.phone_verifications — an in-app 6-digit SMS check, storing a
--      HASH and never the code.
--
-- 🔴 EVERY EXISTING AGENT IS GRANDFATHERED. Section 3 stamps both
-- verification columns for every agent that exists when this runs. Nobody
-- who is using the product today loses access to anything tomorrow — the
-- flow applies to accounts created after this migration. This is the whole
-- reason the columns are nullable timestamps and not a boolean default
-- false: a default would have locked out all nine live agents, including
-- the owner, the moment it applied.
-- ============================================================

-- ------------------------------------------------------------
-- 1. THE CONSENT LEDGER LEARNS ABOUT CHANNELS
--
-- lead_consent_events was built for voice consent only, so it had no way to
-- say what an event was about. Now that the same Record-consent tool can
-- also record TEXT consent — behind its own separate, unticked attestation —
-- a reader has to be able to tell which one an agent put their name to.
--
-- Defaults to 'voice', which is what every existing row is.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.lead_consent_events') is null then
    raise notice '[20260804] lead_consent_events missing — apply 20260803 first; skipping section 1.';
    return;
  end if;

  alter table public.lead_consent_events
    add column if not exists channel text not null default 'voice';

  alter table public.lead_consent_events drop constraint if exists lead_consent_events_channel_check;
  alter table public.lead_consent_events add constraint lead_consent_events_channel_check
    check (channel in ('voice', 'sms'));

  comment on column public.lead_consent_events.channel is
    'Which permission this event was about: ''voice'' (leads.tcpa_consent, read by ai-call-start gate 3) or ''sms'' (consent_records, read by runComplianceGate). Recording one has NEVER widened the other and must not start: the Record-consent modal carries two separate, independently-ticked attestations and writes one event per channel per lead. Existing rows are all ''voice''.';
end $$;

create index if not exists lead_consent_events_channel_idx
  on public.lead_consent_events (agent_id, channel, created_at desc);


-- ------------------------------------------------------------
-- 2. VERIFY TO ACTIVATE — columns + the phone-code table
--
-- email_verified_at is NOT a mirror of auth.users.email_confirmed_at, and
-- must not become one. Supabase's own confirmation is the authority and the
-- browser already reads it straight off the session
-- (`user.email_confirmed_at`). This column is the GRANDFATHER OVERRIDE: it
-- is written by section 3 below and by nothing else, and the gate passes on
-- `email_confirmed_at IS NOT NULL OR email_verified_at IS NOT NULL`. That
-- way turning email confirmation ON in the Supabase dashboard cannot lock
-- out an account that predates the setting.
--
-- phone_verified_at is OURS. Nothing else sets it. The calling and texting
-- features read it.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.agents') is null then
    raise notice '[20260804] public.agents missing — skipping sections 2 and 3.';
    return;
  end if;

  alter table public.agents add column if not exists email_verified_at  timestamptz;
  alter table public.agents add column if not exists phone_verified_at  timestamptz;
  alter table public.agents add column if not exists phone_e164         text;

  comment on column public.agents.email_verified_at is
    'GRANDFATHER OVERRIDE, not a mirror. auth.users.email_confirmed_at is the authority and the browser reads it off the session; this column exists so the nine accounts that predate the email gate keep working if confirmation is switched on later. Set by migration 20260804 and by the service role only — the agents_protect_verification_columns trigger refuses it from a client. The gate passes when EITHER is present.';
  comment on column public.agents.phone_verified_at is
    'When this agent completed the in-app 6-digit SMS check. Set ONLY by the phone-verify edge function under the service role — it is in the agents column denylist, so a browser cannot write it. Calling and texting are locked until it is set. Backfilled for every agent that existed at 20260804.';
  comment on column public.agents.phone_e164 is
    'The mobile number the agent verified, E.164. Distinct from signalwire_caller_id (an owned DID they dial OUT from) — this is the agent''s own handset, and it is what a code was sent to.';
end $$;

-- The code table. A HASH and never the code: this table is readable by
-- support tooling and by anyone with a database backup, and a plaintext
-- 6-digit code sitting next to the phone number it unlocks is a code that
-- has already been shared.
create table if not exists public.phone_verifications (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references auth.users(id) on delete cascade,
  phone_e164   text not null,
  code_hash    text not null,            -- sha256(code + ':' + id), hex
  expires_at   timestamptz not null,
  attempts     int  not null default 0,
  max_attempts int  not null default 5,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.phone_verifications is
  'One row per 6-digit SMS code issued to an agent. Stores sha256(code + '':'' + row id) — NEVER the code. Expires in ~10 minutes and dies after 5 wrong guesses; both bounds are enforced in the phone-verify edge function, which is the only writer (service role, agent taken FROM THE JWT). SELECT-only for authenticated, and the select policy deliberately does not matter much because the hash is useless without the code. Do not add an INSERT/UPDATE policy: a browser that can bump `attempts` or move `expires_at` can brute-force a six-digit number at leisure.';

create index if not exists phone_verifications_agent_idx
  on public.phone_verifications (agent_id, created_at desc);

alter table public.phone_verifications enable row level security;

drop policy if exists "phone_verifications_select_own" on public.phone_verifications;
create policy "phone_verifications_select_own"
  on public.phone_verifications for select using (auth.uid() = agent_id);


-- ------------------------------------------------------------
-- 3. 🔴 GRANDFATHER EVERY EXISTING ACCOUNT
--
-- Runs once, at apply time, and marks every agent row that exists RIGHT NOW
-- as both email- and phone-verified. New signups get the real flow because
-- they are inserted after this statement has already run.
--
-- The timestamp is the migration's own clock, not the account's created_at:
-- these accounts were never actually verified, and dating the row as if they
-- had been would be a false record. "Grandfathered at 20260804" is the true
-- statement, and it is what these timestamps say.
--
-- coalesce, not a blanket overwrite — if a column somehow already holds a
-- real verification it is left alone.
-- ------------------------------------------------------------
do $$
declare
  n int;
begin
  if to_regclass('public.agents') is null then return; end if;

  update public.agents
     set email_verified_at = coalesce(email_verified_at, now()),
         phone_verified_at = coalesce(phone_verified_at, now())
   where email_verified_at is null or phone_verified_at is null;

  get diagnostics n = row_count;
  raise notice '[20260804] grandfathered % existing agent(s) as email- and phone-verified', n;
end $$;


-- ------------------------------------------------------------
-- 4. THE COLUMN GUARD
--
-- public.agents is owner-writable for profile fields, so without this an
-- agent could mark their own phone verified and unlock calling — which is
-- the entire thing the check exists to prevent. Same shape as the existing
-- agents denylist trigger; these three columns are appended to it.
--
-- Written as an independent BEFORE trigger rather than an edit of the
-- existing function so that re-applying either one cannot clobber the other.
-- ------------------------------------------------------------
create or replace function public.agents_protect_verification_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The service role is the verification endpoint; it is allowed through.
  -- Deliberately NO admin exemption: "an administrator marked this phone
  -- verified" is not a verification, and the whole point of the check is
  -- that a human did something a database row cannot fake.
  if coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
     or auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.email_verified_at := null;
    new.phone_verified_at := null;
    return new;
  end if;

  new.email_verified_at := old.email_verified_at;
  new.phone_verified_at := old.phone_verified_at;
  return new;
end $$;

drop trigger if exists agents_protect_verification_columns on public.agents;
create trigger agents_protect_verification_columns
  before insert or update on public.agents
  for each row execute function public.agents_protect_verification_columns();
