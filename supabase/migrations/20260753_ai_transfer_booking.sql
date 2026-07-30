-- ============================================================
-- 20260753_ai_transfer_booking.sql
-- AI Sales Agent — Phase 2: warm transfer + whisper, agent availability,
-- appointment booking, and the structured qualification object.
--
-- See docs/ai-sales-agent-build-plan.md § Phase 2 and
-- docs/ai-assistant-script-v1.md § "Transfer and booking".
--
-- NUMBERING NOTE: the prompt for this round asked for `20260731_…`, but
-- 20260731_a2p_resumable_registration.sql already owns that number and this
-- directory is applied in filename order. Filed at 20260753 (next free after
-- 20260752_ai_call_events.sql) so it sorts AFTER the ai_calls/ai_call_events
-- tables it alters. Nothing else changed.
--
-- Idempotent: safe to run more than once (add-if-not-exists / create-if-not-
-- exists / drop-policy-if-exists). Wrap in begin/commit when applying.
-- ============================================================

-- ------------------------------------------------------------
-- 1. agents — where a hot call goes, and whether to send one.
--
-- ai_availability DEFAULTS TO 'busy'. That is the whole safety story of this
-- feature: a warm transfer rings a real person's cell mid-conversation, and
-- nobody should be rung because a column defaulted the friendly way. An agent
-- opts in by flipping the header pill, and the tool handler re-reads this
-- column FRESH at transfer time — never a value captured when the call
-- started, because the agent may have stepped away since.
--
-- Both columns are owner-writable under the existing `agents_update_own`
-- policy (row-ownership only) and are deliberately NOT added to
-- agents_protect_privileged_columns (20260703c): that trigger is a DENYLIST of
-- billing/privilege columns, and these two are the agent's own settings — the
-- same arrangement as agents.ai_voice (20260727), agents.ai_agent_name
-- (20260730) and agents.hide_from_leaderboards (20260750). Verified against
-- production: agents_update_own is `auth.uid() = id` for both USING and WITH
-- CHECK, so no policy change is required or wanted here.
-- ------------------------------------------------------------
alter table public.agents
  add column if not exists transfer_number text,
  add column if not exists ai_availability text not null default 'busy';

-- Added separately from the column so a re-run against a table that already
-- has the column still installs the constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agents'::regclass
       and conname  = 'agents_ai_availability_check'
  ) then
    alter table public.agents
      add constraint agents_ai_availability_check
      check (ai_availability in ('available','busy'));
  end if;
end $$;

comment on column public.agents.transfer_number is
  'E.164 cell/desk number a qualified AI call is warm-transferred to. NULL means no transfer is possible — ai-call-tools treats a NULL here exactly like ai_availability=''busy'' and tells the assistant to book an appointment instead, so an agent who flips themselves Available without saving a number is never the reason a lead hears silence.';
comment on column public.agents.ai_availability is
  'Whether the agent is ready to take a live warm transfer right now. DEFAULT ''busy'' on purpose: a transfer rings a real phone, so ringing is opt-in. Read FRESH by ai-call-tools at the moment the assistant asks to transfer — never captured at call start, because the agent can flip it mid-call.';

-- ------------------------------------------------------------
-- 2. ai_calls — the structured qualification object + transfer state.
--
-- `qualification` is the JSON the assistant produces at end of call (age,
-- coverage interest, budget, callback window, notes). It used to be thrown
-- away: Telnyx's post-call insight returned a prose paragraph with no
-- `outcome` key, the webhook's parser found nothing, and every completed call
-- landed outcome='error' with a null summary. See _shared/ai-call-outcome.ts.
-- ------------------------------------------------------------
alter table public.ai_calls
  add column if not exists qualification   jsonb,
  add column if not exists transfer_status text,
  add column if not exists transfer_to     text,
  add column if not exists transfer_call_control_id text,
  add column if not exists appointment_id  uuid;

comment on column public.ai_calls.qualification is
  'The assistant''s structured end-of-call object: {outcome, age, coverage_interest, budget_text, best_callback_text, notes}. Stored verbatim as produced (after schema coercion) so a later change to how we read it can be replayed against what was actually said. The derived headline lives in ai_calls.outcome.';
comment on column public.ai_calls.transfer_status is
  'Where the warm transfer got to: none | offered | ringing_agent | whisper | bridged | agent_declined | agent_no_answer | failed. Distinguishing agent_declined (pressed something other than 1) from agent_no_answer (never answered, or AMD said machine) is what makes "qualified_missed" reviewable.';
comment on column public.ai_calls.transfer_call_control_id is
  'Call Control id of the AGENT leg. The lead leg''s call_control_id stays the wallet_ledger ref_id — the whole call, both legs, bills ONCE at the ai_call rate anchored on lead answer (docs/ai-sales-agent-build-plan.md Phase 2). The agent leg deliberately has no debit of its own.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ai_calls'::regclass
       and conname  = 'ai_calls_transfer_status_check'
  ) then
    alter table public.ai_calls
      add constraint ai_calls_transfer_status_check
      check (transfer_status is null or transfer_status in
        ('none','offered','ringing_agent','whisper','bridged',
         'agent_declined','agent_no_answer','failed'));
  end if;
end $$;

-- The agent leg's events arrive on ai-call-webhook carrying only the agent
-- leg's own call_control_id; this index is how that leg finds its parent row.
create index if not exists ai_calls_transfer_ccid_idx
  on public.ai_calls (transfer_call_control_id)
  where transfer_call_control_id is not null;

-- Two new outcomes. `outcome` carries a CHECK listing every tag the webhook
-- may write, so the check has to be replaced rather than added to.
do $$
declare
  conname_found text;
begin
  select conname into conname_found
    from pg_constraint
   where conrelid = 'public.ai_calls'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%outcome%in%';
  if conname_found is not null then
    execute format('alter table public.ai_calls drop constraint %I', conname_found);
  end if;
  alter table public.ai_calls
    add constraint ai_calls_outcome_check
    check (outcome in ('voicemail','no_answer','busy','not_interested',
                       'qualified','dnc_request','error','in_progress',
                       'callback_requested','appointment_booked','transferred',
                       'completed'));
end $$;

-- ------------------------------------------------------------
-- 3. ai_appointments — the booking record.
--
-- WHY A NEW TABLE, given the app already has a Calendar tab.
--
-- That tab is READ-ONLY Google Calendar, fetched in the BROWSER with a Google
-- Identity Services access token held in localStorage under the
-- `calendar.readonly` scope (gcalFetchEvents in app.html). There is no
-- server-side refresh token and no write scope, so an edge function cannot
-- put anything into it. The Calendar tab now renders these rows alongside the
-- Google events, which is the surface the agent actually looks at.
--
-- The obvious alternative — set the lead's status to 'appointment' so it lands
-- in the existing "Appointment Set" tab — was deliberately NOT done as the
-- system of record. `leads.data` is a jsonb blob the BROWSER owns:
-- sbUpsertAllLeads() re-upserts every lead on every save, so a server-side
-- write to data.status is silently overwritten the next time the agent edits
-- anything. An appointment the AI booked must not be able to disappear
-- because someone renamed a lead.
-- ------------------------------------------------------------
create table if not exists public.ai_appointments (
  id                 uuid primary key default gen_random_uuid(),
  agent_id           uuid not null references auth.users(id) on delete cascade,
  lead_id            uuid references public.leads(id) on delete set null,
  ai_call_id         uuid references public.ai_calls(id) on delete set null,
  starts_at          timestamptz not null,
  lead_timezone      text,
  spoken_time_text   text,
  lead_name          text,
  lead_phone_e164    text,
  notes              text,
  source             text not null default 'ai_call',
  status             text not null default 'scheduled'
    check (status in ('scheduled','cancelled','completed','no_show')),
  sms_confirm_status text,
  sms_message_id     uuid,
  created_at         timestamptz not null default now()
);

comment on table public.ai_appointments is
  'Appointments the AI Sales Agent booked on a call. Written ONLY by the ai-call-tools edge function under the service role; SELECT-only for authenticated, same posture as ai_calls and the Phase 1 commission tables. The Calendar tab merges these with the browser-side Google Calendar events.';
comment on column public.ai_appointments.starts_at is
  'Absolute instant of the appointment. Parsed from what the lead said, in the LEAD''s timezone (ai_appointments.lead_timezone), then stored as timestamptz — so it renders correctly for an agent in a different zone.';
comment on column public.ai_appointments.spoken_time_text is
  'Exactly what the lead agreed to, in words ("Tuesday at 2"). Kept next to the parsed instant because a parse that landed on the wrong week is only diagnosable against the original phrase.';
comment on column public.ai_appointments.sms_confirm_status is
  'sent | skipped_no_consent | skipped_<gate reason> | failed:<reason>. NEVER null-on-success: a booking whose confirmation silently did not go out is indistinguishable from one that did. The send is fire-and-forget — an SMS failure must never fail or delay the booking.';

create index if not exists ai_appointments_agent_starts_idx
  on public.ai_appointments (agent_id, starts_at);
create index if not exists ai_appointments_lead_idx
  on public.ai_appointments (lead_id);

alter table public.ai_appointments enable row level security;

-- SELECT-only for authenticated. Writes go through ai-call-tools under the
-- service role, which takes the agent from the CALL, not from a request body.
-- Do not add an INSERT policy: one broad enough to let a browser record an
-- appointment is broad enough to let it record one against another agent's
-- book, and this table is what the confirmation SMS is sent from.
drop policy if exists "ai_appointments_select_own" on public.ai_appointments;
create policy "ai_appointments_select_own"
  on public.ai_appointments for select
  using (auth.uid() = agent_id);

-- The fk from ai_calls, added now that the table exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ai_calls'::regclass
       and conname  = 'ai_calls_appointment_id_fkey'
  ) then
    alter table public.ai_calls
      add constraint ai_calls_appointment_id_fkey
      foreign key (appointment_id) references public.ai_appointments(id)
      on delete set null;
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. Realtime — the test rig and the Phase 4 UI both watch a live call.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'ai_appointments'
  ) then
    alter publication supabase_realtime add table public.ai_appointments;
  end if;
end $$;
