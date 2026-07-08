-- ============================================================
-- Gmail carrier-email integration — Phase 1 (OAuth connect)
-- Run in the Supabase SQL editor (schema is applied manually per project
-- convention — do NOT `supabase db push`).
--
-- Two tables on purpose:
--   * gmail_accounts        — per-user connected-mailbox METADATA. RLS lets a
--                             user read their own row. No secrets live here.
--   * gmail_account_secrets — the encrypted refresh token, ISOLATED. RLS is on
--                             with ZERO policies, so anon/authenticated can
--                             never read it via PostgREST; only the service_role
--                             (edge functions) touches it. See build plan §7.
--
-- The refresh token is stored as base64url(AES-256-GCM(iv‖ciphertext‖tag)),
-- encrypted in the edge function with the TOKEN_ENC_KEY secret. The key is
-- never in the DB or repo. (Stored as text, not bytea, to keep PostgREST
-- round-trips simple — the ciphertext is opaque either way.)
-- ============================================================

-- ── Connected mailbox metadata ──────────────────────────────────────────────
create table if not exists public.gmail_accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  email_address text not null,
  history_id    text,                                  -- Gmail incremental-sync cursor (Phase 2)
  status        text not null default 'active',        -- active | reauth_required | disabled
  scope         text,                                  -- granted scopes, for audit
  connected_at  timestamptz not null default now(),
  last_synced_at timestamptz,
  updated_at    timestamptz not null default now(),
  unique (user_id, email_address)
);

create index if not exists gmail_accounts_user_idx on public.gmail_accounts (user_id);

-- ── Encrypted refresh token (isolated) ──────────────────────────────────────
create table if not exists public.gmail_account_secrets (
  gmail_account_id  uuid primary key references public.gmail_accounts(id) on delete cascade,
  refresh_token_enc text not null,                     -- base64url(AES-256-GCM(iv‖ct‖tag))
  updated_at        timestamptz not null default now()
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.gmail_accounts        enable row level security;
alter table public.gmail_account_secrets enable row level security;

-- Users may READ their own connection status. All writes go through the edge
-- functions (service_role), which bypass RLS — so no insert/update/delete
-- policy is granted to end users.
drop policy if exists gmail_accounts_select_own on public.gmail_accounts;
create policy gmail_accounts_select_own
  on public.gmail_accounts
  for select
  using (auth.uid() = user_id);

-- gmail_account_secrets: intentionally NO policies -> RLS default-denies every
-- row to anon/authenticated. Belt-and-suspenders: also revoke table grants so
-- the encrypted token is unreachable via PostgREST no matter what.
revoke all on public.gmail_account_secrets from anon, authenticated;
