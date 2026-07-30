-- ============================================================
-- 20260802_ai_call_meter.sql
-- Daily AI-call meter: a recommended pace, a seven-day ramp for a new number,
-- and the agent's OWN cap.
--
-- THE POINT IS THAT IT IS SOFT. Carriers flag numbers that place hundreds of
-- calls a day as "Spam Likely", and a brand-new number is most fragile in its
-- first week — so we meter and we recommend. Passing the recommendation never
-- blocks a call; it records one warning for the day. The only thing that
-- blocks is the number the AGENT typed into their own settings, and clearing
-- it is one click.
--
-- Read supabase/functions/_shared/ai-call-meter.ts alongside this — the math
-- lives there (and is mirrored in the `// <ai-meter-core>` block in app.html).
-- Nothing in this file computes a recommendation.
--
-- Idempotent: safe to run more than once. Wrap in begin/commit when applying.
-- ============================================================

-- ------------------------------------------------------------
-- 1. agents — the agent's own cap, and the zone their day rolls over in.
--
-- ai_daily_call_cap: NULL means NO CAP, and that is a supported state chosen
-- by a toggle, not a missing value. The column default is 300 — the same
-- number as the recommendation — so a new agent starts metered without anyone
-- having decided anything for them. `add column … default 300` backfills every
-- existing row in one pass, which is exactly the intended starting point; on a
-- re-run the column already exists and nothing is touched, so an agent who
-- deliberately cleared their cap does not silently get it back.
--
-- timezone: written by the BROWSER from
-- Intl.DateTimeFormat().resolvedOptions().timeZone. "Today" has to mean the
-- day the agent is actually living in, and the server only knows UTC. NULL
-- falls back to America/Chicago (AI_METER_DEFAULT_TZ). There is deliberately
-- NO area-code inference for an agent's own zone — inferring where a PERSON
-- is from a number they bought online is the kind of almost-right that files a
-- call on the wrong day.
--
-- Both columns are owner-writable under the existing `agents_update_own`
-- policy (row-ownership only) and are deliberately NOT added to
-- agents_protect_privileged_columns (20260703c): that trigger is a DENYLIST of
-- billing/privilege columns, and these are the agent's own settings — same
-- arrangement as ai_voice (20260727), ai_agent_name (20260730),
-- hide_from_leaderboards (20260750) and ai_availability (20260753).
--
-- Raising your own cap costs nobody anything: the wallet gate and every TCPA
-- gate still run, and each call is still billed. The cap is a pacing control.
-- ------------------------------------------------------------
alter table public.agents
  add column if not exists ai_daily_call_cap integer default 300,
  add column if not exists timezone          text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agents'::regclass
       and conname  = 'agents_ai_daily_call_cap_check'
  ) then
    alter table public.agents
      add constraint agents_ai_daily_call_cap_check
      check (ai_daily_call_cap is null or ai_daily_call_cap >= 0);
  end if;
end $$;

comment on column public.agents.ai_daily_call_cap is
  'The agent''s OWN ceiling on outbound AI calls per local day. NULL means no cap — a supported one-click state, not a missing value. Enforced by ai-call-start (error code daily_cap_reached) and by nothing else; the ~300/day RECOMMENDATION is separate, lives in _shared/ai-call-meter.ts, and never blocks. Setting this above the recommendation is allowed on purpose: the agent gets the spam-reputation warning and then gets their calls.';
comment on column public.agents.timezone is
  'IANA zone the agent''s day rolls over in, e.g. America/Chicago. Written by the browser from Intl.DateTimeFormat().resolvedOptions().timeZone so the meter''s "today" is the agent''s today and not UTC''s. NULL falls back to America/Chicago. Not inferred from any phone number.';

-- ------------------------------------------------------------
-- 2. phone_numbers — when this number first carried an AI call.
--
-- The basis for the seven-day ramp: a number's first day of AI use is day 1
-- and it is recommended at 30 calls, reaching the full 300 on day 7. Stamped
-- once, by ai-call-start, on the caller ID it actually dialed from, and never
-- again.
--
-- NULL means "has never carried an AI call", which the ramp reads as day 1 —
-- the moment it carries one, it IS day 1.
-- ------------------------------------------------------------
alter table public.phone_numbers
  add column if not exists ai_first_used_at timestamptz;

comment on column public.phone_numbers.ai_first_used_at is
  'First time this number was used as the caller ID for an outbound AI call. Basis for the seven-day ramp in _shared/ai-call-meter.ts (day 1 = 30 recommended calls … day 7+ = 300). Set once by ai-call-start under the service role and never updated after; NULL means never used, which the ramp treats as day 1. Client-immutable — see phone_numbers_protect_privileged_columns.';

-- Backfill from what already happened. ai_calls.from_e164 is the caller ID the
-- dialer used, so an account that has been running the AI dialer for a week
-- does not get told all of its numbers are brand new.
update public.phone_numbers pn
   set ai_first_used_at = f.first_at
  from (
    select agent_id, from_e164, min(coalesce(started_at, created_at)) as first_at
      from public.ai_calls
     where direction = 'outbound'
       and from_e164 is not null
     group by agent_id, from_e164
  ) f
 where pn.agent_id = f.agent_id
   and pn.e164     = f.from_e164
   and pn.ai_first_used_at is null;

-- ------------------------------------------------------------
-- 3. phone_numbers column protection — ai_first_used_at is ours, not the
--    client's.
--
-- Same denylist trigger as 20260730, replaced with one more line. A browser
-- that could backdate this column could hand itself a matured number and a
-- 300-call recommendation on the day it was bought — which is precisely the
-- reputation risk the ramp exists to avoid. Everything else about the function
-- is unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phone_numbers_protect_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only end-user requests through PostgREST as 'authenticated'/'anon'.
  -- service_role edge functions and direct SQL sessions are trusted.
  IF auth.role() IS DISTINCT FROM 'authenticated' AND auth.role() IS DISTINCT FROM 'anon' THEN
    RETURN NEW;
  END IF;

  -- Admins may still adjust another agent's number (Settings -> Calling).
  IF public.is_admin_agent() THEN
    RETURN NEW;
  END IF;

  -- Identity / ownership — never client-mutable.
  NEW.agent_id                 := OLD.agent_id;
  NEW.e164                     := OLD.e164;
  NEW.sw_phone_sid             := OLD.sw_phone_sid;
  NEW.number_type              := OLD.number_type;
  NEW.purchased_at             := OLD.purchased_at;

  -- Billing / lifecycle — set only by purchase + wallet-renew-numbers.
  NEW.monthly_cost             := OLD.monthly_cost;
  NEW.status                   := OLD.status;
  NEW.stripe_sub_id            := OLD.stripe_sub_id;
  NEW.next_renewal_at          := OLD.next_renewal_at;
  NEW.renew_from_wallet        := OLD.renew_from_wallet;
  NEW.past_due_since           := OLD.past_due_since;

  -- A2P / compliance assignment — set by the a2p functions only.
  NEW.a2p_campaign_id          := OLD.a2p_campaign_id;
  NEW.a2p_assignment_status    := OLD.a2p_assignment_status;
  NEW.a2p_assigned_at          := OLD.a2p_assigned_at;
  NEW.sms_capable              := OLD.sms_capable;
  NEW.sms_setup_error          := OLD.sms_setup_error;

  -- Reputation — set by the reputation monitor only.
  NEW.reputation_registered_at := OLD.reputation_registered_at;
  NEW.spam_risk                := OLD.spam_risk;
  NEW.spam_category            := OLD.spam_category;
  NEW.reputation_scores        := OLD.reputation_scores;
  NEW.reputation_checked_at    := OLD.reputation_checked_at;

  -- AI meter — stamped once by ai-call-start. Backdating it would buy a fresh
  -- number a matured number's recommendation.
  NEW.ai_first_used_at         := OLD.ai_first_used_at;

  -- Left client-writable on purpose: is_primary (Set as primary),
  -- friendly_name / locality / region (display labels), ai_inbound_enabled
  -- (the per-number inbound opt-in, 20260801).
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS phone_numbers_protect_privileged_columns ON public.phone_numbers;
CREATE TRIGGER phone_numbers_protect_privileged_columns
  BEFORE UPDATE ON public.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION public.phone_numbers_protect_privileged_columns();

-- ------------------------------------------------------------
-- 4. ai_pace_events — "you went past the recommendation today", once.
--
-- WHY A ROW AND NOT A LOG LINE. Going past the recommended pace is not an
-- error and it does not stop anything, so the only trace it would otherwise
-- leave is an edge-function console line that expires. This is the record that
-- an agent was told, on a specific day, before their number's reputation moved
-- — and it is what lets the app say "you've been over pace three days running"
-- without re-deriving history from ai_calls.
--
-- ONE PER AGENT PER LOCAL DAY, enforced by the unique key rather than by the
-- caller remembering: ai-call-start inserts with ON CONFLICT DO NOTHING on
-- every call past the recommendation, so call 301 writes the row and calls
-- 302..500 write nothing. The counts stored are the ones AT THE MOMENT OF THE
-- FIRST WARNING, deliberately — that is the fact being recorded.
--
-- ai_call_events was NOT reused. It is keyed on a Telnyx call_control_id, has
-- no agent_id to scope an owner policy by, and is service-role-only by design
-- (it holds raw Telnyx payloads). This row belongs to an AGENT and a DAY, and
-- the agent is allowed to see it.
-- ------------------------------------------------------------
create table if not exists public.ai_pace_events (
  id            bigint generated always as identity primary key,
  agent_id      uuid not null references auth.users(id) on delete cascade,
  local_day     date not null,
  timezone      text not null,
  calls_today   integer not null,
  recommended   integer not null,
  cap           integer,
  number_count  integer not null default 0,
  created_at    timestamptz not null default now(),
  constraint ai_pace_events_agent_day_uidx unique (agent_id, local_day)
);

comment on table public.ai_pace_events is
  'One row per agent per local day, the first time that day a call went past the RECOMMENDED AI pace. Never blocks anything — the call it records was placed. Written by ai-call-start under the service role with ON CONFLICT DO NOTHING; SELECT-only for authenticated, same posture as ai_calls and ai_appointments.';
comment on column public.ai_pace_events.local_day is
  'The agent-local calendar date (agents.timezone, falling back to America/Chicago), not a UTC date. The whole meter counts in the agent''s day, so the record of it has to as well.';
comment on column public.ai_pace_events.calls_today is
  'Outbound AI calls already placed that day when the warning fired — i.e. the count as it stood at the FIRST call past the recommendation, not the day''s final total. Later calls the same day deliberately write nothing.';
comment on column public.ai_pace_events.cap is
  'The agent''s ai_daily_call_cap at that moment, or NULL if they had no cap. Recorded so "they were warned and kept going" can be read without guessing what their settings were that day.';

create index if not exists ai_pace_events_agent_day_idx
  on public.ai_pace_events (agent_id, local_day desc);

alter table public.ai_pace_events enable row level security;

-- SELECT-only for authenticated. The single writer is ai-call-start under the
-- service role, which takes the agent FROM THE JWT — there is no agent id in
-- its request body. Do not add an INSERT policy: a browser that can write here
-- can forge (or suppress) the record that it was warned.
drop policy if exists "ai_pace_events_select_own" on public.ai_pace_events;
create policy "ai_pace_events_select_own"
  on public.ai_pace_events for select
  using (auth.uid() = agent_id);
