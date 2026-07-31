-- ============================================================
-- 20260809_email_verification.sql
--
-- public.email_verifications — a six-digit email check that runs on the FIRST
-- page of sign-up, before the account exists.
--
-- ---- Why this is not phone_verifications -----------------------------------
--
-- `phone_verifications` is keyed `agent_id -> auth.users(id)`, because phone
-- verification happens inside the app: there is always a session, the JWT names
-- the agent, and the JWT is itself the rate limit.
--
-- Email verification happens BEFORE sign-up. There is no account, no
-- auth.uid(), and nothing to key on but the address being claimed. So this
-- table is keyed on the ADDRESS, and the identity link is made later — see
-- `claimed_by` below.
--
-- ---- 🔴 THE WHOLE TABLE IS SERVICE-ROLE ONLY -------------------------------
--
-- RLS is enabled and there is DELIBERATELY NOT ONE POLICY. Not select, not
-- insert. A browser that could read this table could read the code hash and
-- the expiry for any address that has ever been offered one; a browser that
-- could write it could mint itself a verified row for an address it does not
-- own, which is precisely the thing being prevented. Every read and write goes
-- through the `email-verify` edge function under the service role.
--
-- The unauthenticated reachability of that function is why the two hourly
-- ceilings in `_shared/auth-verify.ts` exist. This table is what they are
-- counted against, hence the two indexes at the bottom.
--
-- ---- What is stored --------------------------------------------------------
--
-- A HASH and never the code, salted with the row's own id — identical to
-- phone_verifications and for the identical reason. A plaintext six-digit code
-- sitting beside the address it unlocks is a code that has already been shared.
-- ============================================================

begin;

create table if not exists public.email_verifications (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,            -- ALWAYS normalizeEmail(): trimmed, lower-cased
  code_hash    text not null,            -- sha256(code + ':' + id), hex
  expires_at   timestamptz not null,
  attempts     int  not null default 0,
  max_attempts int  not null default 5,
  consumed_at  timestamptz,              -- a code that was spent, right or wrong
  verified_at  timestamptz,              -- the address proved itself
  claimed_by   uuid references auth.users(id) on delete set null,
  claimed_at   timestamptz,
  request_ip   text,                     -- for the per-IP ceiling only
  created_at   timestamptz not null default now()
);

comment on table public.email_verifications is
  'Six-digit email checks issued during sign-up, BEFORE an account exists. '
  'Keyed on the address, not an agent. Service-role only: RLS is on and there '
  'are no policies, by design. Written solely by the email-verify function.';

comment on column public.email_verifications.verified_at is
  'Set when the correct code was entered. This alone does NOT verify an '
  'account -- it verifies an ADDRESS. The account link is claimed_by/claimed_at.';

comment on column public.email_verifications.claimed_by is
  'The account that later signed up with this address. Set once, by the '
  'email-verify "claim" action, which takes the email from the JWT and never '
  'from the request body. A row may be claimed only once.';

-- Newest-first lookups for one address: the send cooldown, the hourly ceiling,
-- the code check and the claim all start here.
create index if not exists email_verifications_email_idx
  on public.email_verifications (email, created_at desc);

-- The per-IP hourly ceiling. Partial: a null IP is not a bucket, and counting
-- them together would let one unresolvable client spend everybody's quota.
create index if not exists email_verifications_ip_idx
  on public.email_verifications (request_ip, created_at desc)
  where request_ip is not null;

alter table public.email_verifications enable row level security;

-- 🔴 NO POLICIES. See the header. Do not add one.
--
-- Revoke the table grants too: RLS with no policy already denies everything to
-- anon/authenticated, but the grants are what a future "just add a policy"
-- would build on, and their absence makes the intent explicit.
revoke all on public.email_verifications from anon, authenticated;

commit;
