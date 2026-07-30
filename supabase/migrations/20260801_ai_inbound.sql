-- ============================================================
-- 20260801_ai_inbound.sql
-- AI Sales Agent — inbound answering: ring the agent first, AI as backup.
--
-- See docs/ai-inbound-routing.md for the webhook-routing decision (short
-- version: nothing in Telnyx moved; inbound to a non-dialer number was already
-- a no-op on the shared webhook, and that no-op is the seam).
--
-- Idempotent: safe to run more than once. Wrap in begin/commit when applying.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ai_calls — which way the call went, and who ended up on it.
-- ------------------------------------------------------------
alter table public.ai_calls
  add column if not exists direction   text not null default 'outbound',
  add column if not exists answered_by text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ai_calls'::regclass
       and conname  = 'ai_calls_direction_check'
  ) then
    alter table public.ai_calls
      add constraint ai_calls_direction_check
      check (direction in ('outbound','inbound'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ai_calls'::regclass
       and conname  = 'ai_calls_answered_by_check'
  ) then
    alter table public.ai_calls
      add constraint ai_calls_answered_by_check
      check (answered_by is null or answered_by in ('agent','ai','none'));
  end if;
end $$;

comment on column public.ai_calls.direction is
  'outbound = the AI dialer placed this call. inbound = a person called one of the agent''s ai_inbound_enabled numbers. Defaults to outbound so every pre-existing row stays correct without a backfill.';
comment on column public.ai_calls.answered_by is
  'Who the caller actually ended up talking to: agent (the ring-first leg was answered and pressed 1 — bridged, AI never attached), ai (the agent did not take it, so the assistant answered), none (nobody did). THIS COLUMN DECIDES THE RATE: answered_by=''agent'' bills at the human per-minute call rate through public.calls, anything the AI was on bills at the ai_call rate. Never both.';

-- An inbound call is looked up by its own call_control_id before it has been
-- answered, on the ring path. Same shape as the outbound unique index.
create index if not exists ai_calls_direction_created_idx
  on public.ai_calls (direction, created_at desc);

-- ------------------------------------------------------------
-- 2. phone_numbers — the per-number opt-in.
--
-- This is where the agent's own numbers live (e164, status, is_primary,
-- sms_capable, a2p_campaign_id). Owner-readable; writes go through the
-- provisioning edge functions.
--
-- DEFAULT FALSE, and that is the entire safety story. A number with this flag
-- on will ring a real person's cell whenever anybody dials it. Six other
-- agents own numbers on the same Telnyx application and none of them asked
-- for this; they all stay false until they do.
-- ------------------------------------------------------------
alter table public.phone_numbers
  add column if not exists ai_inbound_enabled boolean not null default false;

comment on column public.phone_numbers.ai_inbound_enabled is
  'When true, an inbound call to this number is handled by the AI inbound flow (ring the agent''s transfer_number first, AI answers as backup). Default FALSE — opting a number in means strangers can make the agent''s cell ring, so it is per-number and deliberate. The power-dialer host number is not in this table at all and can never be flagged.';

-- Turn it on for exactly the number that is already the AI dialer's outbound
-- caller ID — the one a lead would call back after seeing it on their phone.
-- Scoped by e164 so re-running cannot widen it, and written as an UPDATE (not
-- a default change) so no other agent is opted in by accident.
update public.phone_numbers
   set ai_inbound_enabled = true
 where e164 = '+12029981783'
   and status = 'active';

-- ------------------------------------------------------------
-- 3. leads — an inbound caller we have never seen becomes a lead.
--
-- No schema change is needed: `leads` already carries agent_id, client_id,
-- data (jsonb) and the Phase 0 TCPA columns. Recorded here so the next reader
-- does not go looking for one.
--
-- A lead created this way gets tcpa_consent = FALSE and stays that way. The
-- consumer called US, which is what makes answering lawful; it is NOT consent
-- to be dialed by an artificial voice later, and ai-call-start's gate must
-- keep refusing them until real consent is captured. Do not "fix" this by
-- defaulting it true for inbound.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 4. calls — no change required.
--
-- public.calls.direction already carries check (direction in
-- ('outbound','inbound')) and all 1,403 existing rows are 'outbound'. The
-- bridged inbound call writes a normal 'inbound' row here, which is correct:
-- it IS a human call, and this table is what the human dialer's minute cap and
-- the Summary dial/contact analytics read.
-- ------------------------------------------------------------
