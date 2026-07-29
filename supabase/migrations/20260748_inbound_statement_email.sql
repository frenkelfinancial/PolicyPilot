-- ============================================================
-- Back Office, Phase 1b — the per-tenant commission forwarding address.
--
-- Agents forward carrier commission statements to
--   <token>@commissions.producerstackcrm.com
-- and they ingest through the pipeline Phase 1 already built.
--
-- Two things:
--   1. agents.commission_email_token — the per-agent address token.
--   2. inbound_statement_emails      — a VERBATIM capture of every inbound
--                                      event, written before anything is
--                                      parsed out of it.
--
-- WHY THE CAPTURE TABLE EXISTS, AND WHY IT IS WRITTEN FIRST
--
-- The Resend `email.received` payload shape is UNVERIFIED. The existing
-- messaging-email-inbound-webhook says so in its own header: it was written
-- before the inbound MX existed, and its parser is a best-effort adapter that
-- has never seen a real delivery. The MX is live now, so the shape is about to
-- be learned — and the way to learn it without losing anybody's statement is
-- to store the whole event first and parse it second.
--
-- That also makes every inbound re-processable. If the adapter turns out to
-- read the wrong field for attachments, the emails are all still here and can
-- be re-run; nothing has to be forwarded again by the agent. It is the same
-- guarantee `statement_extractions` gives for the model's output and
-- `statement_files` gives for the bytes: NOTHING IS DISCARDED.
--
-- WHY THE TOKEN IS ON `agents` AND NOT A NEW TABLE
--
-- It is one nullable column carrying one identifier per agent, exactly like
-- `compliance_slug`. A table would add a join to every address render for no
-- gain. It is guarded the same way `compliance_slug` is: derived server-side
-- and, once set, not client-writable — see the trigger below.
--
-- THE TOKEN IS A BEARER SECRET. Anyone who knows an agent's address can post
-- a statement into that agent's book. That is inherent to a forwarding
-- address — it is why the token is 32 hex characters from crypto-quality
-- randomness rather than a slug of the agent's name, and why it can be
-- rotated. It grants no read access: it identifies a destination, nothing
-- more.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The per-agent token.
-- ------------------------------------------------------------
alter table public.agents
  add column if not exists commission_email_token text,
  add column if not exists commission_email_enabled boolean not null default true,
  add column if not exists commission_email_rotated_at timestamptz;

comment on column public.agents.commission_email_token is
  'Local part of the agent''s commission forwarding address. A BEARER SECRET: whoever knows it can post a statement into this agent''s book. Server-derived, not client-writable, rotatable.';

create unique index if not exists agents_commission_email_token_uidx
  on public.agents (commission_email_token)
  where commission_email_token is not null;


-- ------------------------------------------------------------
-- 2. The token is server-issued and NOT client-writable.
--
-- Same posture as `compliance_slug` (20260729) and for the same reason: a
-- client that could choose its own token could choose one that collides with,
-- or is guessable from, another agent's. It could also set another agent's
-- token to a value it knows and then post statements into their book.
--
-- `agents_protect_privileged_columns` (20260703c) already reverts privileged
-- columns for non-service callers, but it enumerates its columns by name and
-- these are new, so they need their own guard rather than an assumption.
-- ------------------------------------------------------------
create or replace function public.agents_protect_commission_token()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    -- A client may never set, change or clear the token, and may never
    -- re-enable a disabled address. Both are service-role decisions.
    new.commission_email_token       := old.commission_email_token;
    new.commission_email_rotated_at  := old.commission_email_rotated_at;
    new.commission_email_enabled     := old.commission_email_enabled;
  end if;
  return new;
end
$fn$;

drop trigger if exists agents_protect_commission_token on public.agents;
create trigger agents_protect_commission_token
  before update on public.agents
  for each row execute function public.agents_protect_commission_token();


-- ------------------------------------------------------------
-- 3. issue_commission_email_token() — mint or rotate, for the caller only.
--
-- SECURITY DEFINER because the column is not client-writable by design.
-- No parameter names an agent: it is anchored solely on auth.uid(), the same
-- shape as apply_producer_codes and get_team_summary, so there is nothing to
-- point at somebody else's account.
--
-- Idempotent: calling it when a token already exists returns the existing one
-- unless p_rotate is true. An agent who reloads the Settings page must not get
-- a new address every time — they may have already given the old one to a
-- carrier.
-- ------------------------------------------------------------
create or replace function public.issue_commission_email_token(
  p_rotate boolean default false
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  uid uuid := auth.uid();
  existing text;
  candidate text;
  tries int := 0;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select commission_email_token into existing from public.agents where id = uid;
  if existing is not null and not p_rotate then
    return existing;
  end if;

  -- 32 hex chars = 128 bits. Built from gen_random_uuid(), which is CORE
  -- PostgreSQL, rather than pgcrypto's gen_random_bytes(): pgcrypto lives in
  -- the `extensions` schema on Supabase, and this function pins
  -- `search_path = public` (as every SECURITY DEFINER here does, so it cannot
  -- be pointed at a hostile schema). Reaching for gen_random_bytes threw
  -- 42883 on the first real call — caught by minting a token for a live
  -- account rather than by reading the code.
  --
  -- Guessing a token is not a realistic attack; the loop is for collisions.
  loop
    tries := tries + 1;
    candidate := replace(gen_random_uuid()::text, '-', '');
    exit when not exists (
      select 1 from public.agents where commission_email_token = candidate
    );
    if tries > 5 then
      raise exception 'could not allocate a commission email token';
    end if;
  end loop;

  update public.agents
     set commission_email_token = candidate,
         commission_email_rotated_at = case when existing is null then null else now() end,
         commission_email_enabled = true
   where id = uid;

  return candidate;
end
$fn$;

comment on function public.issue_commission_email_token(boolean) is
  'Mint (or rotate) the caller''s commission forwarding token. SECURITY DEFINER, anchored on auth.uid(); no parameter names an agent. Idempotent unless p_rotate.';

grant execute on function public.issue_commission_email_token(boolean) to authenticated;


-- ------------------------------------------------------------
-- 4. inbound_statement_emails — the verbatim capture.
--
-- `agent_id` is NULLABLE on purpose. An email addressed to a token that does
-- not resolve is still stored: it is evidence that somebody forwarded
-- something to us, and a statement that arrived at a rotated or mistyped
-- address must be findable rather than silently dropped. Those rows simply
-- belong to nobody and are invisible to every agent.
--
-- SELECT-only for `authenticated`, like every other table in this schema that
-- holds commission data. The webhook writes under the service role.
-- ------------------------------------------------------------
create table if not exists public.inbound_statement_emails (
  id               uuid        primary key default gen_random_uuid(),
  agent_id         uuid        references auth.users(id) on delete cascade,

  provider         text        not null default 'resend',
  provider_event_id text,
  token            text,
  to_address       text,
  from_address     text,
  subject          text,

  payload          jsonb       not null default '{}'::jsonb,
  attachment_count int         not null default 0,

  status           text        not null default 'received',
  error            text,
  statement_ids    uuid[]      not null default '{}',

  created_at       timestamptz not null default now(),
  processed_at     timestamptz
);

comment on table public.inbound_statement_emails is
  'Verbatim capture of every inbound commission email, written BEFORE parsing so an unverified payload shape can never lose a statement. Service-role write only.';
comment on column public.inbound_statement_emails.agent_id is
  'Null when the address token did not resolve. The row is still kept — a statement sent to a wrong address must be findable, not dropped.';

create index if not exists inbound_statement_emails_agent_idx
  on public.inbound_statement_emails (agent_id, created_at desc);
create index if not exists inbound_statement_emails_status_idx
  on public.inbound_statement_emails (status, created_at desc);
create index if not exists inbound_statement_emails_unresolved_idx
  on public.inbound_statement_emails (created_at desc)
  where agent_id is null;

-- Provider event id is the replay guard: Resend retries a webhook it did not
-- get a 2xx for, and a retry must not ingest the same statement twice. The
-- file-grain sha256 dedupe in statement-upload would catch it anyway, but
-- catching it here means the retry costs nothing at all.
create unique index if not exists inbound_statement_emails_event_uidx
  on public.inbound_statement_emails (provider, provider_event_id)
  where provider_event_id is not null;

do $guard$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'inbound_statement_emails_status_check'
  ) then
    alter table public.inbound_statement_emails
      add constraint inbound_statement_emails_status_check
      check (status in ('received','ingested','no_attachment','unresolved','failed'));
  end if;
end
$guard$;

alter table public.inbound_statement_emails enable row level security;

drop policy if exists inbound_statement_emails_select_own on public.inbound_statement_emails;
create policy inbound_statement_emails_select_own
  on public.inbound_statement_emails for select to authenticated
  using (agent_id = auth.uid());

-- No INSERT/UPDATE/DELETE policy. Service-role only, the same shape as
-- commission_rows, consent_records and lead_transfers.


-- ------------------------------------------------------------
-- 5. resolve_commission_email_token() — the webhook's lookup.
--
-- SECURITY DEFINER so the webhook can resolve a token without `agents` being
-- readable, and it returns ONLY the agent id — never an email, a name or
-- anything else about the account. A token that does not resolve, or that
-- belongs to a disabled address, returns null.
-- ------------------------------------------------------------
create or replace function public.resolve_commission_email_token(p_token text)
returns uuid
language sql
security definer
set search_path = public
stable
as $fn$
  select id from public.agents
   where commission_email_token = lower(btrim(p_token))
     and commission_email_enabled
   limit 1;
$fn$;

comment on function public.resolve_commission_email_token(text) is
  'Token -> agent id, for the inbound webhook. Returns the id and nothing else; a disabled or unknown token returns null.';

revoke all on function public.resolve_commission_email_token(text) from public, anon, authenticated;
grant execute on function public.resolve_commission_email_token(text) to service_role;
