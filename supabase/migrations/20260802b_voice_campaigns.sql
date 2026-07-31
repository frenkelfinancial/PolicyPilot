-- ============================================================
-- 20260802b_voice_campaigns.sql
-- Voice campaigns: the AI dials the book on its own, by rules.
--
-- Two things ship here.
--
-- PART 0 — inbound answering on EVERY number an agent owns. 20260801 turned it
-- on for exactly one number as a safe default while the flow was unproven. It
-- is proven, and the product answer is that a callback to any number an agent
-- owns should reach that agent. Backfill + a new column default; nothing else
-- about the inbound flow changes.
--
-- PART 1 — the campaign engine's three tables, plus the columns on ai_calls
-- that tie a call back to the enrollment that asked for it.
--
-- Read docs/voice-campaigns.md alongside this. The DECISIONS live there; this
-- file is the shape.
--
-- Idempotent: safe to run more than once. Wrap in begin/commit when applying.
-- ============================================================

-- ============================================================
-- PART 0 — inbound answering, on by default, for every owned number
-- ============================================================
--
-- WHY THE DEFAULT MOVES. 20260801 shipped `default false` with the reasoning
-- that "a number with this flag on will ring a real person's cell whenever
-- anybody dials it". That is still true — and it is now the intended product:
-- the person whose cell rings is the agent who OWNS the number, the call is a
-- callback to a number they chose to publish, and the flow rings them FIRST
-- with the assistant only as backup. An agent who buys five numbers and finds
-- that four of them ring out has a broken product, not a safe one.
--
-- The per-agent kill switch (`agents.ai_dialer_enabled`) and the per-number
-- opt-out (this column, editable from the Phone Book) are both unchanged, so
-- there are still two ways to turn it off and one of them is one click.
--
-- THE POWER-DIALER HOST NUMBER IS EXCLUDED, and stays excluded.
-- TELNYX_DIALER_NUMBER (+12625099123 as of 2026-07-30) is the leg the power
-- dialer's PIN IVR answers on; `telnyx-call-status` checks it BEFORE the AI
-- branch, so an AI flag there could never fire — but a row for it must not
-- exist wearing a flag that says it would. It is not in public.phone_numbers
-- at all today (it is owned at the Telnyx account level, not by an agent);
-- the predicate below is what keeps that true if it is ever added.
alter table public.phone_numbers
  alter column ai_inbound_enabled set default true;

comment on column public.phone_numbers.ai_inbound_enabled is
  'When true, an inbound call to this number is handled by the AI inbound flow (ring the agent''s transfer_number first, AI answers as backup). DEFAULT TRUE since 20260802b: a callback to any number an agent owns should reach that agent, from the minute they buy it. Per-number opt-out from the Phone Book. The power-dialer host number is excluded by e164 and is not in this table at all; agents.ai_dialer_enabled remains the account-level kill switch.';

-- Backfill every existing agent-owned number.
update public.phone_numbers
   set ai_inbound_enabled = true
 where ai_inbound_enabled is distinct from true
   and agent_id is not null
   and e164 <> '+12625099123';

-- Belt and braces: if the host number ever lands in this table, it is off.
update public.phone_numbers
   set ai_inbound_enabled = false
 where e164 = '+12625099123';

-- The three purchase paths — telnyx-buy-number, telnyx-provision-number and
-- telnyx-replace-number — all INSERT into public.phone_numbers with an
-- explicit agent_id and no ai_inbound_enabled, so the column default above is
-- what a newly bought number gets. That is deliberate: one default beats three
-- call sites that have to remember, and a fourth purchase path added later
-- inherits it for free. Verified 2026-07-30: none of the three names the
-- column.

-- ============================================================
-- PART 1 — the campaign engine
-- ============================================================

-- ------------------------------------------------------------
-- 1. voice_campaigns
--
-- SEEDABLE FROM PLAIN JSON, ON PURPOSE. The next round ships twelve pre-built
-- campaigns (Veteran Lead, Final Expense, Mortgage Protection, …) and must be
-- able to create them with no UI clicks. Everything a campaign is, is columns
-- and one jsonb rule blob; `seed_key` is what makes a re-seed idempotent
-- without duplicating an agent's edits.
--
-- OWNER-WRITABLE, unlike the money tables. A campaign is the agent's own
-- configuration — the same class as producer_codes — so the browser writes it
-- directly and a DB trigger enforces what must not be forged: the trigger-group
-- shape (see voice_campaigns_validate below). The things a browser could abuse
-- if it wrote them — an enrollment, a call — are not in this table.
-- ------------------------------------------------------------
create table if not exists public.voice_campaigns (
  id                            uuid primary key default gen_random_uuid(),
  agent_id                      uuid not null references auth.users(id) on delete cascade,
  name                          text not null,
  description                   text,
  active                        boolean not null default false,

  -- Writes the would-be call and reschedules instead of dialing. This is what
  -- makes the engine provable in production without a phone ringing, and it is
  -- a per-campaign column rather than an env flag so one test campaign can be
  -- dry while everything else on the account runs for real.
  dry_run                       boolean not null default false,

  -- [[{field,op,value}, …], …] — groups OR'd, conditions AND'd inside a group.
  trigger_groups                jsonb not null default '[]'::jsonb,

  -- Enrollment triggers
  auto_enroll_new_leads         boolean not null default false,
  trigger_on_missed_appointment boolean not null default false,
  trigger_on_sold               boolean not null default false,

  -- Stop conditions
  stop_on_appointment_booked    boolean not null default true,
  stop_on_sold                  boolean not null default true,
  stop_on_answered              boolean not null default false,
  -- "Answered" is a TALK LENGTH, not a connect. A lead who picked up, heard
  -- the disclosure and hung up in three seconds has not been spoken to.
  stop_answer_talk_secs         integer not null default 15,

  -- Set by voice-campaign-tick when the gate refuses for an ACCOUNT-level
  -- reason (empty wallet, plan, kill switch). Retry-hammering an empty wallet
  -- every minute fills a log and tells nobody; this puts a sentence on screen.
  paused_at                     timestamptz,
  pause_reason                  text,

  -- Stable identifier for a campaign that came from the shipped defaults, so a
  -- re-seed can upsert rather than duplicate. NULL for anything hand-made.
  seed_key                      text,

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_campaigns'::regclass
                    and conname  = 'voice_campaigns_talk_secs_check') then
    alter table public.voice_campaigns
      add constraint voice_campaigns_talk_secs_check
      check (stop_answer_talk_secs >= 0 and stop_answer_talk_secs <= 3600);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_campaigns'::regclass
                    and conname  = 'voice_campaigns_name_check') then
    alter table public.voice_campaigns
      add constraint voice_campaigns_name_check
      check (length(btrim(name)) between 1 and 120);
  end if;
end $$;

create unique index if not exists voice_campaigns_seed_uidx
  on public.voice_campaigns (agent_id, seed_key)
  where seed_key is not null;
create index if not exists voice_campaigns_agent_idx
  on public.voice_campaigns (agent_id, created_at desc);
-- The tick's outer loop: every campaign anywhere that is running right now.
create index if not exists voice_campaigns_active_idx
  on public.voice_campaigns (active)
  where active = true;

comment on table public.voice_campaigns is
  'One automated AI-calling program. Owner-writable (it is the agent''s own configuration, same class as producer_codes) with a trigger validating trigger_groups; the ENROLLMENTS and the CALLS it produces are not writable from a browser. Every call it places goes through ai-call-start and its full gate chain — consent, DNC, suppression, quiet hours, daily cap, wallet floor. Seedable from plain JSON: see seed_key.';
comment on column public.voice_campaigns.trigger_groups is
  'Array of condition groups, OR''d together; conditions inside a group are AND''d. Each condition is {field, op:"is"|"is_not", value}. EVERY GROUP MUST CARRY A POSITIVE ("is") CONDITION ON A LEAD-TYPE / CAMPAIGN-TAG FIELD — enforced by voice_campaigns_validate() below and by vcValidateTriggerGroups() in the browser and the edge functions. Without that rule a saved campaign is one click from dialing an entire book.';
comment on column public.voice_campaigns.dry_run is
  'When true the tick claims, gates and schedules exactly as normal but does NOT dial: it records the would-be call in the trace and advances the enrollment. The way this engine is proved against production data without a phone ringing.';
comment on column public.voice_campaigns.pause_reason is
  'Plain-English sentence shown on the campaign card when the tick paused it. Set only for ACCOUNT-level gate refusals (insufficient_balance, ai_disabled, upgrade_required, no_caller_id) — a per-lead refusal stops that enrollment instead, and a timed refusal (daily cap, quiet hours) just reschedules.';
comment on column public.voice_campaigns.seed_key is
  'Stable key for a campaign created from the shipped defaults (e.g. veteran_lead). UNIQUE per agent so re-running the seed upserts instead of duplicating. NULL for hand-made campaigns, which is why the index is PARTIAL — and a partial index cannot be inferred from a bare column list, so a seeding upsert must spell the predicate out: `on conflict (agent_id, seed_key) where seed_key is not null`. PostgREST cannot express that, so THE SEED RUNS AS SQL OR IN AN EDGE FUNCTION, never as a browser upsert. Making the index total instead would collide every hand-made campaign against every other.';

-- ------------------------------------------------------------
-- 2. voice_campaign_steps
--
-- `wait_value`/`wait_unit` is the delay AFTER THE PREVIOUS STEP COMPLETED —
-- including, for the first step, after enrollment. That is what lets "new lead
-- arrives -> call within a minute" be step 1 with a 1-minute wait.
--
-- agent_id is denormalised so RLS is one predicate rather than a join on every
-- read, and it is DERIVED BY A TRIGGER from the campaign, never accepted from
-- the client — the same reasoning as producer_codes.code_key. A client-supplied
-- agent_id could file a step under someone else's campaign.
-- ------------------------------------------------------------
create table if not exists public.voice_campaign_steps (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.voice_campaigns(id) on delete cascade,
  agent_id     uuid not null references auth.users(id) on delete cascade,
  position     integer not null,
  step_type    text not null default 'call'
    check (step_type in ('call','double_dial')),
  wait_value   integer not null default 0,
  wait_unit    text not null default 'minutes'
    check (wait_unit in ('minutes','hours','days')),
  -- {"per_minutes": 60, "max_calls": 20} — throttle so 500 enrollees do not
  -- all fire at 9:00:00. NULL means no throttle.
  drip_rate    jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint voice_campaign_steps_position_check check (position >= 1),
  constraint voice_campaign_steps_wait_check     check (wait_value >= 0),
  constraint voice_campaign_steps_campaign_position_uidx unique (campaign_id, position)
);

create index if not exists voice_campaign_steps_campaign_idx
  on public.voice_campaign_steps (campaign_id, position);

comment on table public.voice_campaign_steps is
  'Ordered steps of a voice campaign. wait_value/wait_unit is the delay after the PREVIOUS step completed (after enrollment, for the first step). step_type double_dial makes a second attempt ~1 minute after a no-answer, twice at most, then the campaign moves on — see VC_DOUBLE_DIAL_ATTEMPTS in _shared/voice-campaign-core.ts.';
comment on column public.voice_campaign_steps.agent_id is
  'Denormalised from the campaign so RLS needs no join. DERIVED BY A TRIGGER, never accepted from the client — a client-supplied value could file a step under another agent''s campaign.';
comment on column public.voice_campaign_steps.drip_rate is
  '{"per_minutes":N,"max_calls":M} or NULL. A throttle, not a limit: an enrollment held back by the drip stays due and the next tick tries again, so a 20-per-hour step drains across the hour on its own.';

-- ------------------------------------------------------------
-- 3. voice_campaign_enrollments
--
-- SERVICE-ROLE-WRITE-ONLY, and this is the boundary that matters in this
-- migration. An enrollment is a standing instruction to place phone calls to a
-- consumer. A browser that could write one could enroll a lead that has no
-- consent, or one belonging to somebody else, and the whole compliance story
-- of this feature would rest on the UI being polite. Every write goes through
-- voice-campaign-tick or voice-campaign-manage under the service role, and
-- both take the agent FROM THE JWT (or, for the cron, sweep all agents).
-- Do not add an INSERT or UPDATE policy.
-- ------------------------------------------------------------
create table if not exists public.voice_campaign_enrollments (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid not null references public.voice_campaigns(id) on delete cascade,
  agent_id              uuid not null references auth.users(id) on delete cascade,
  lead_id               uuid not null references public.leads(id) on delete cascade,
  status                text not null default 'active'
    check (status in ('active','completed','stopped','paused')),
  -- The position of the step that runs NEXT. Set to the campaign's first step
  -- on enrollment.
  current_step_position integer not null default 1,
  -- Attempts made on the CURRENT step. Only a double_dial step ever exceeds 1.
  step_attempts         integer not null default 0,
  next_action_at        timestamptz,
  -- The atomic claim. A tick sets it before dialing and clears it after; a
  -- tick that died mid-run leaves it set, and the lease (VC_CLAIM_LEASE_SECS)
  -- is what lets the next one take the row back instead of stranding the lead.
  claimed_at            timestamptz,
  enrolled_by           text not null default 'auto'
    check (enrolled_by in ('auto','reevaluate','missed_appointment','sold','manual')),
  last_ai_call_id       uuid references public.ai_calls(id) on delete set null,
  last_call_at          timestamptz,
  calls_placed          integer not null default 0,
  answers               integer not null default 0,
  appointments          integer not null default 0,
  stop_reason           text,
  enrolled_at           timestamptz not null default now(),
  completed_at          timestamptz,
  updated_at            timestamptz not null default now(),
  constraint voice_campaign_enrollments_campaign_lead_uidx unique (campaign_id, lead_id)
);

-- ONE ACTIVE VOICE CAMPAIGN PER LEAD, enforced by the database rather than by
-- the sweep remembering. Orion's behaviour, and the reason is not tidiness: a
-- lead in two campaigns gets two robots in one afternoon and neither
-- campaign's numbers mean anything afterwards.
create unique index if not exists voice_campaign_enrollments_one_active_uidx
  on public.voice_campaign_enrollments (lead_id)
  where status = 'active';

-- The tick's hot path: what is due, oldest first.
create index if not exists voice_campaign_enrollments_due_idx
  on public.voice_campaign_enrollments (agent_id, next_action_at)
  where status = 'active';
create index if not exists voice_campaign_enrollments_campaign_idx
  on public.voice_campaign_enrollments (campaign_id, status);
create index if not exists voice_campaign_enrollments_lead_idx
  on public.voice_campaign_enrollments (lead_id);

comment on table public.voice_campaign_enrollments is
  'Which leads are in which campaign, and where. SELECT-only for authenticated: an enrollment is a standing instruction to phone a consumer, so every write goes through voice-campaign-tick / voice-campaign-manage under the service role. A lead may be ACTIVE in only one voice campaign at a time (partial unique index on lead_id).';
comment on column public.voice_campaign_enrollments.claimed_at is
  'Set atomically by the tick before it dials, cleared when the enrollment is rescheduled. A tick that dies mid-run leaves a claim behind; VC_CLAIM_LEASE_SECS (10 minutes) is when another tick may take it. This column is the whole answer to "a tick re-fires a minute later and must not double-call anyone".';
comment on column public.voice_campaign_enrollments.current_step_position is
  'Position of the step that runs NEXT, not the one that last ran. Set to the campaign''s first step position on enrollment, so wait_value on step 1 means "after enrollment".';

-- ------------------------------------------------------------
-- 4. ai_calls — which enrollment asked for this call.
--
-- campaign_id and campaign_step sit beside enrollment_id rather than being
-- derived through it, for two reasons: the drip throttle counts calls per
-- (campaign, step) in a rolling window and that must be one indexed query, and
-- a campaign's stats must survive an enrollment being deleted with its lead.
-- ------------------------------------------------------------
alter table public.ai_calls
  add column if not exists enrollment_id uuid references public.voice_campaign_enrollments(id) on delete set null,
  add column if not exists campaign_id   uuid references public.voice_campaigns(id) on delete set null,
  add column if not exists campaign_step integer;

create index if not exists ai_calls_enrollment_idx
  on public.ai_calls (enrollment_id)
  where enrollment_id is not null;
-- The drip window query.
create index if not exists ai_calls_campaign_step_created_idx
  on public.ai_calls (campaign_id, campaign_step, created_at desc)
  where campaign_id is not null;

comment on column public.ai_calls.enrollment_id is
  'The voice_campaign_enrollments row this call was placed for, or NULL for a manual / test-rig call. Set by ai-call-start when voice-campaign-tick asks for the call.';
comment on column public.ai_calls.campaign_id is
  'Denormalised from the enrollment so the drip-rate window and the campaign stats are one indexed query each, and so a campaign''s history survives an enrollment being removed with its lead.';

-- ------------------------------------------------------------
-- 5. voice_campaigns_validate — the tag rule, in the database.
--
-- The same rule lives in vcValidateTriggerGroups() (browser + edge functions).
-- It is HERE as well because voice_campaigns is owner-writable: the browser is
-- not the only thing that can PATCH this row, and a campaign whose rule matches
-- the whole book is the one mistake in this feature that cannot be taken back
-- once the calls have gone out.
--
-- ACTIVE CAMPAIGNS ONLY. A draft is allowed to be half-written — an editor that
-- refuses to save an unfinished rule is an editor nobody can use. Flipping
-- `active` on is the moment the rule has to hold.
-- ------------------------------------------------------------
create or replace function public.voice_campaigns_validate()
returns trigger
language plpgsql
as $$
declare
  grp        jsonb;
  cond       jsonb;
  conds      jsonb;
  n_groups   int := 0;
  has_tag    boolean;
  n_conds    int;
  tag_fields text[] := array['campaign_tag','tags','lead_type','coverage_wanted','source'];
begin
  new.updated_at := now();

  if new.active is not true then
    return new;
  end if;

  if jsonb_typeof(new.trigger_groups) is distinct from 'array' then
    raise exception 'voice_campaigns.trigger_groups must be a JSON array of condition groups';
  end if;

  for grp in select * from jsonb_array_elements(coalesce(new.trigger_groups, '[]'::jsonb))
  loop
    n_groups := n_groups + 1;

    -- A group is either a bare array of conditions or {"conditions":[…]}.
    if jsonb_typeof(grp) = 'array' then
      conds := grp;
    elsif jsonb_typeof(grp) = 'object' and jsonb_typeof(grp->'conditions') = 'array' then
      conds := grp->'conditions';
    else
      raise exception 'voice_campaigns.trigger_groups: group % is neither an array of conditions nor {"conditions":[…]}', n_groups;
    end if;

    select count(*) into n_conds from jsonb_array_elements(conds);
    if n_conds = 0 then
      raise exception 'voice_campaigns.trigger_groups: group % has no conditions', n_groups;
    end if;

    has_tag := false;
    for cond in select * from jsonb_array_elements(conds)
    loop
      if coalesce(btrim(cond->>'field'), '') = '' then
        raise exception 'voice_campaigns.trigger_groups: group % has a condition with no field', n_groups;
      end if;
      if coalesce(cond->>'op', 'is') not in ('is','is_not') then
        raise exception 'voice_campaigns.trigger_groups: group % has an op other than is / is_not', n_groups;
      end if;
      if coalesce(btrim(cond->>'value'), '') = '' then
        raise exception 'voice_campaigns.trigger_groups: group % has a condition with no value', n_groups;
      end if;
      -- Only a POSITIVE condition counts. "lead type is not trucker" excludes a
      -- sliver and admits everyone else — which is precisely the campaign
      -- nobody meant to build.
      if coalesce(cond->>'op', 'is') = 'is'
         and btrim(cond->>'field') = any (tag_fields) then
        has_tag := true;
      end if;
    end loop;

    if not has_tag then
      raise exception
        'voice_campaigns.trigger_groups: group % must name a lead type or campaign tag with an "is" condition (one of %) — otherwise this campaign could call the whole book',
        n_groups, array_to_string(tag_fields, ', ');
    end if;
  end loop;

  if n_groups = 0 then
    raise exception 'voice_campaigns.trigger_groups: an active campaign needs at least one condition group';
  end if;

  return new;
end;
$$;

drop trigger if exists voice_campaigns_validate on public.voice_campaigns;
create trigger voice_campaigns_validate
  before insert or update on public.voice_campaigns
  for each row execute function public.voice_campaigns_validate();

-- ------------------------------------------------------------
-- 6. voice_campaign_steps_derive — agent_id comes from the campaign.
-- ------------------------------------------------------------
create or replace function public.voice_campaign_steps_derive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select agent_id into owner from public.voice_campaigns where id = new.campaign_id;
  if owner is null then
    raise exception 'voice_campaign_steps: campaign % does not exist', new.campaign_id;
  end if;
  new.agent_id   := owner;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists voice_campaign_steps_derive on public.voice_campaign_steps;
create trigger voice_campaign_steps_derive
  before insert or update on public.voice_campaign_steps
  for each row execute function public.voice_campaign_steps_derive();

-- ------------------------------------------------------------
-- 7. RLS
--
-- campaigns + steps: owner-writable (the agent's own configuration).
-- enrollments:       SELECT-only. See the table comment.
-- ------------------------------------------------------------
alter table public.voice_campaigns            enable row level security;
alter table public.voice_campaign_steps       enable row level security;
alter table public.voice_campaign_enrollments enable row level security;

drop policy if exists "voice_campaigns_select_own" on public.voice_campaigns;
create policy "voice_campaigns_select_own"
  on public.voice_campaigns for select using (auth.uid() = agent_id);
drop policy if exists "voice_campaigns_insert_own" on public.voice_campaigns;
create policy "voice_campaigns_insert_own"
  on public.voice_campaigns for insert with check (auth.uid() = agent_id);
drop policy if exists "voice_campaigns_update_own" on public.voice_campaigns;
create policy "voice_campaigns_update_own"
  on public.voice_campaigns for update using (auth.uid() = agent_id) with check (auth.uid() = agent_id);
drop policy if exists "voice_campaigns_delete_own" on public.voice_campaigns;
create policy "voice_campaigns_delete_own"
  on public.voice_campaigns for delete using (auth.uid() = agent_id);

drop policy if exists "voice_campaign_steps_select_own" on public.voice_campaign_steps;
create policy "voice_campaign_steps_select_own"
  on public.voice_campaign_steps for select using (auth.uid() = agent_id);
-- INSERT is checked against the CAMPAIGN's owner, not against the row's
-- agent_id: the trigger derives agent_id and triggers run after the WITH CHECK
-- on insert would be evaluated against a client-supplied value.
drop policy if exists "voice_campaign_steps_insert_own" on public.voice_campaign_steps;
create policy "voice_campaign_steps_insert_own"
  on public.voice_campaign_steps for insert
  with check (exists (
    select 1 from public.voice_campaigns c
     where c.id = campaign_id and c.agent_id = auth.uid()
  ));
drop policy if exists "voice_campaign_steps_update_own" on public.voice_campaign_steps;
create policy "voice_campaign_steps_update_own"
  on public.voice_campaign_steps for update
  using (auth.uid() = agent_id)
  with check (exists (
    select 1 from public.voice_campaigns c
     where c.id = campaign_id and c.agent_id = auth.uid()
  ));
drop policy if exists "voice_campaign_steps_delete_own" on public.voice_campaign_steps;
create policy "voice_campaign_steps_delete_own"
  on public.voice_campaign_steps for delete using (auth.uid() = agent_id);

-- SELECT and nothing else. Every write is an edge function under the service
-- role. Do NOT add an INSERT/UPDATE policy here.
drop policy if exists "voice_campaign_enrollments_select_own" on public.voice_campaign_enrollments;
create policy "voice_campaign_enrollments_select_own"
  on public.voice_campaign_enrollments for select using (auth.uid() = agent_id);

-- ------------------------------------------------------------
-- 8. updated_at on the two owner-writable tables.
--    voice_campaigns handles it inside its validate trigger; steps in theirs.
--    Enrollments are only ever written by an edge function, which sets it.
-- ------------------------------------------------------------
