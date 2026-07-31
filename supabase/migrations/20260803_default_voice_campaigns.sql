-- ============================================================
-- 20260803_default_voice_campaigns.sql
-- The twelve pre-built voice campaigns, live on day one — plus the bulk
-- consent tool that is the only thing standing between them and a dial.
--
-- Read docs/voice-campaigns-defaults.md alongside this. The DECISIONS live
-- there; this file is the shape.
--
-- Six parts:
--
--   1. COLUMNS the twelve need that the engine did not have: a deterministic
--      order, an appointment trigger, a per-campaign goal for the assistant,
--      and appointment-anchored steps.
--   2. THE TAG GUARD, widened by exactly four values. A lifecycle campaign
--      ("call the client we just sold") is bounded by its TRIGGER, not by a
--      lead-type tag, and the old rule made those six campaigns unshippable.
--   3. THE TWELVE, as one jsonb literal. One copy, in one place; the tests
--      read it back out of this file.
--   4. THE SEEDER — idempotent, and RESPECTFUL: a tombstone table remembers
--      that an agent was offered a default, so deactivating, editing or
--      deleting one is never undone by a re-seed.
--   5. THE CONSENT LEDGER — lead_consent_events, append-only, plus a column
--      guard that stops a browser writing tcpa_consent behind the attestation.
--   6. BACKFILL — every existing agent gets the twelve, now.
--
-- Idempotent: safe to run more than once. Wrap in begin/commit when applying.
-- ============================================================

-- ============================================================
-- PART 1 — the columns the twelve need
-- ============================================================

-- ------------------------------------------------------------
-- sort_order — deterministic order, and it is load-bearing.
--
-- The seeder writes twelve rows in ONE transaction, so `now()` is identical
-- for all twelve and `created_at` cannot order them. That matters twice:
--
--   * ON SCREEN, twelve cards in a different order on every refresh is a
--     product that looks broken.
--   * IN THE TICK, three of the twelve trigger on the same event (a client
--     was sold) and a lead may be ACTIVE in only one voice campaign at a
--     time. Without an order, WHICH of the three gets a newly-sold client is
--     whatever PostgreSQL happened to return first. With one, the three form
--     a stated queue: Customer Care, then Emergency Contact, then Beneficiary
--     Referral, each starting when the one before it finishes.
-- ------------------------------------------------------------
alter table public.voice_campaigns
  add column if not exists sort_order integer not null default 100;

comment on column public.voice_campaigns.sort_order is
  'Ascending display and evaluation order, ties broken by id. The twelve shipped defaults occupy 10..120. Load-bearing: the seeder writes them in one transaction so created_at is identical across all twelve, and three of them trigger on the same event while a lead may be active in only one campaign — so this column is what decides which of the three enrolls a newly-sold client first.';

-- ------------------------------------------------------------
-- trigger_on_appointment_booked — the Appointment Reminder campaign.
--
-- The fourth enrollment trigger. Unlike the other three it enrolls a lead
-- *because a future event is on the calendar*, which is why the enrollment
-- carries the appointment id and its steps are anchored to the appointment
-- rather than to each other.
-- ------------------------------------------------------------
alter table public.voice_campaigns
  add column if not exists trigger_on_appointment_booked boolean not null default false;

-- ------------------------------------------------------------
-- campaign_goal — what this call is FOR.
--
-- A reminder call, a qualification call, a customer-care check-in and a
-- referral ask cannot open with the same sentence. This value travels to
-- ai-call-start as a dynamic variable, becomes the REASON CLAUSE of the
-- spoken greeting (buildGreeting), and selects a branch of the assistant's
-- instructions.
--
-- CONSTRAINED, not free text. A typo in a free-text column would silently
-- fall back to the qualification greeting — the assistant would ring somebody
-- about "the coverage you asked about" two hours before an appointment they
-- already booked. NULL means the qualification default, which is what every
-- hand-made campaign gets.
-- ------------------------------------------------------------
alter table public.voice_campaigns
  add column if not exists campaign_goal text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_campaigns'::regclass
                    and conname  = 'voice_campaigns_goal_check') then
    alter table public.voice_campaigns
      add constraint voice_campaigns_goal_check
      check (campaign_goal is null or campaign_goal in (
        'qualify', 'remind', 'rebook', 'care',
        'emergency_contact', 'referral', 'chargeback'
      ));
  end if;
end $$;

comment on column public.voice_campaigns.campaign_goal is
  'Why this campaign calls. Selects the reason clause of the spoken greeting and a branch of the assistant''s instructions: qualify (default, and what NULL means) | remind | rebook | care | emergency_contact | referral | chargeback. Constrained rather than free text because an unrecognised value degrades to the qualification greeting, which on a reminder call is a robot phoning somebody about coverage they already bought.';

create index if not exists voice_campaigns_agent_order_idx
  on public.voice_campaigns (agent_id, sort_order, id);

-- ------------------------------------------------------------
-- Appointment-anchored steps — the SMALLEST extension that works.
--
-- Every other step in this engine waits a while after the previous one. An
-- appointment reminder cannot: "the day before" and "two hours before" are
-- measured backwards from a fixed instant that the enrollment already knows.
--
-- So: two optional columns and nothing else. `anchor = 'appointment'` means
-- next_action_at is computed as appointment.starts_at + offset_minutes
-- (negative = before), instead of previous-step-completed + wait.
--
-- THE SKIP RULE IS THE OTHER HALF. A campaign enrolled ninety minutes before
-- the appointment has already missed both its steps. An anchored step whose
-- moment has passed is SKIPPED, never fired late — a "reminder" delivered
-- after the appointment is a robot telling somebody they are about to miss
-- something they already missed. vcResolveNextDue() in
-- _shared/voice-campaign-core.ts walks forward past them.
-- ------------------------------------------------------------
alter table public.voice_campaign_steps
  add column if not exists anchor text not null default 'previous_step',
  add column if not exists offset_minutes integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_campaign_steps'::regclass
                    and conname  = 'voice_campaign_steps_anchor_check') then
    alter table public.voice_campaign_steps
      add constraint voice_campaign_steps_anchor_check
      check (anchor in ('previous_step','appointment'));
  end if;
  -- Anything beyond a week either side of the appointment is a typo, not a
  -- reminder. Bounded so a stray zero cannot schedule a call in 2027.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_campaign_steps'::regclass
                    and conname  = 'voice_campaign_steps_offset_check') then
    alter table public.voice_campaign_steps
      add constraint voice_campaign_steps_offset_check
      check (offset_minutes between -10080 and 10080);
  end if;
end $$;

comment on column public.voice_campaign_steps.anchor is
  'previous_step (default, and every hand-made step) = due wait_value/wait_unit after the previous step completed. appointment = due at the enrollment''s appointment starts_at plus offset_minutes. An anchored step whose moment has already passed is SKIPPED, never fired late.';
comment on column public.voice_campaign_steps.offset_minutes is
  'Only read when anchor = ''appointment''. NEGATIVE is before: -1440 is the day before, -120 is two hours before. Ignored entirely for a previous_step anchor, where wait_value/wait_unit is the delay.';

-- ------------------------------------------------------------
-- The enrollment's appointment.
--
-- Set when trigger_on_appointment_booked enrolled the lead. `on delete set
-- null` rather than cascade: a cancelled appointment should stop the reminder
-- (which the stop sweep does, by name), not silently erase the enrollment and
-- its stats.
-- ------------------------------------------------------------
alter table public.voice_campaign_enrollments
  add column if not exists appointment_id uuid references public.ai_appointments(id) on delete set null;

create index if not exists voice_campaign_enrollments_appointment_idx
  on public.voice_campaign_enrollments (appointment_id)
  where appointment_id is not null;

comment on column public.voice_campaign_enrollments.appointment_id is
  'The ai_appointments row an appointment-anchored campaign is counting down to. NULL for every other campaign. Also what lets the reminder campaign RE-ARM: an enrollment that finished against appointment A is reset — not duplicated, the (campaign_id, lead_id) unique index forbids that — when the same lead books appointment B.';

-- ============================================================
-- PART 2 — the tag guard, widened by exactly four values
-- ============================================================
--
-- WHAT THE GUARD IS FOR, restated, because this change has to respect it:
-- a campaign whose rule matches the whole book is the one mistake in this
-- feature that cannot be taken back once the calls have gone out. So every
-- trigger group must carry a POSITIVE condition that NARROWS the audience.
--
-- Six of the twelve shipped campaigns are LIFECYCLE campaigns — call the
-- client we just sold, remind the person whose appointment is tomorrow, chase
-- the one who did not show. Their audience is bounded by the trigger and by a
-- terminal lead status, not by a lead-type tag, and under the old rule they
-- could not be expressed at all.
--
-- So `status` now counts as a narrowing condition — for FOUR VALUES ONLY.
-- `status is sold`, `is appointment`, `is chargeback` and `is lapsed` each
-- describe a handful of people who have already been through something.
-- `status is new` still does not count, and that exclusion is the whole
-- reason `status` was left out in the first place: it describes every fresh
-- row in the book. Neither do `called`, `no_answer` or `not_interested`.
--
-- Same rule, same four values, in all three enforcement points:
--   * vcValidateTriggerGroups() in `// <vcamp-core>` (the editor)
--   * vcValidateTriggerGroups() in _shared/voice-campaign-core.ts (the server)
--   * voice_campaigns_validate() here (the database)
-- test/voice-campaigns.test.mjs compares all three.
-- ============================================================
create or replace function public.voice_campaigns_validate()
returns trigger
language plpgsql
as $$
declare
  grp          jsonb;
  cond         jsonb;
  conds        jsonb;
  n_groups     int := 0;
  has_tag      boolean;
  n_conds      int;
  c_field      text;
  c_op         text;
  c_value      text;
  tag_fields   text[] := array['campaign_tag','tags','lead_type','coverage_wanted','source'];
  -- Terminal / lifecycle statuses. Each describes people who have already been
  -- through something, never the whole book.
  life_status  text[] := array['sold','appointment','chargeback','lapsed'];
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
      c_field := coalesce(btrim(cond->>'field'), '');
      c_op    := coalesce(cond->>'op', 'is');
      c_value := coalesce(btrim(cond->>'value'), '');

      if c_field = '' then
        raise exception 'voice_campaigns.trigger_groups: group % has a condition with no field', n_groups;
      end if;
      if c_op not in ('is','is_not') then
        raise exception 'voice_campaigns.trigger_groups: group % has an op other than is / is_not', n_groups;
      end if;
      if c_value = '' then
        raise exception 'voice_campaigns.trigger_groups: group % has a condition with no value', n_groups;
      end if;

      -- Only a POSITIVE condition counts. "lead type is not trucker" excludes
      -- a sliver and admits everyone else — precisely the campaign nobody
      -- meant to build.
      if c_op = 'is' and c_field = any (tag_fields) then
        has_tag := true;
      end if;
      -- A lifecycle status is a narrowing condition too. Four values only.
      if c_op = 'is' and c_field = 'status' and lower(c_value) = any (life_status) then
        has_tag := true;
      end if;
    end loop;

    if not has_tag then
      raise exception
        'voice_campaigns.trigger_groups: group % must narrow the audience with an "is" condition — either a lead type or campaign tag (one of %), or a lifecycle status (status is one of %). Otherwise this campaign could call the whole book',
        n_groups, array_to_string(tag_fields, ', '), array_to_string(life_status, ', ');
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

-- ============================================================
-- PART 3 — the twelve
-- ============================================================
--
-- ONE COPY, HERE. The seeder reads this function; test/voice-campaigns.test.mjs
-- extracts the same literal out of this file's text and runs every rule
-- through the real matcher against synthetic leads of each type. There is no
-- second copy in TypeScript to drift from.
--
-- ---- How the triggers map onto leads THAT ACTUALLY EXIST -------------------
--
-- Audited against production 2026-07-30, 1,363 leads across 8 agents:
--
--   data.lead_type      0 leads      data.type          0 leads
--   data.tags           0 leads      data.campaign_tag  0 leads
--   data.coverage_wanted 94 non-empty — and they are DOLLAR AMOUNTS
--                       ("$25k - $50k", "less than $250,000"), not lead types
--   data.source         1,363 — all of them lead-VENDOR names
--   data.status         new 757 · no_answer 539 · not_interested 41 ·
--                       appointment 12 · sold 10 · called 4
--
-- Two consequences drove every rule below.
--
-- FIRST, `lead_type` IS VIRTUAL and resolves coverage_wanted → lead_type →
-- type → source. In this book coverage_wanted is a dollar amount, so the
-- virtual field answers "$25k - $50k" for a tenth of the book and falls
-- through to a vendor name for the rest. A rule keyed on it alone would match
-- almost nobody, and the leads it did match would be matched by accident.
--
-- SECOND, the only field that could carry a lead type is `campaign_tag`, and
-- nothing has ever written it. So `campaign_tag` is the CANONICAL field and
-- the six canonical values below are created here. They are settable from the
-- Add Lead modal, from the CSV importer, and from the lead-ingest webhook.
--
-- Each lead-type campaign therefore carries the canonical tag as its first
-- group and the natural words a vendor might already have written as further
-- OR groups — so a book that already says "veteran" works with no tagging at
-- all, and a book that says nothing works the moment one column is mapped.
--
-- ---- The exact mapping ----------------------------------------------------
--
--  Campaign              Trigger                    Matches on
--  --------------------  -------------------------  --------------------------
--  Appointment Reminder  appointment booked         status is appointment
--  No-Show Follow-up     appointment marked no_show status is appointment
--  Customer Care         lead marked sold           status is sold
--  Emergency Contact     lead marked sold           status is sold
--  Beneficiary Referral  lead marked sold           status is sold
--  Chargeback Recovery   tag applied                campaign_tag is chargeback
--  Veteran Lead          new lead                   campaign_tag is veteran
--                                                   | lead_type veteran/veterans/va
--  Final Expense         new lead                   campaign_tag is final_expense
--                                                   | lead_type "final expense"/fex/burial
--  Mortgage Protection   new lead                   campaign_tag is mortgage_protection
--                                                   | lead_type "mortgage protection"/mortgage
--  IUL                   new lead                   campaign_tag is iul
--                                                   | lead_type iul/"indexed universal life"
--  General Life          new lead                   campaign_tag is general_life
--                                                   | lead_type "general life"/life/"term life"
--  Trucker               new lead                   campaign_tag is trucker
--                                                   | lead_type trucker/"truck driver"/cdl
--
-- ---- Two honest gaps, stated rather than hidden ---------------------------
--
--   * NOTHING MARKS AN APPOINTMENT no_show YET. `ai_appointments.status` only
--     ever holds 'scheduled' today, so No-Show Follow-up is wired, active and
--     waiting — it will fire the day the calendar round writes that status.
--     It is shipped active rather than held back because a campaign that
--     exists and is empty is honest; one that is missing looks like a feature
--     nobody built.
--   * CHARGEBACK IS A POLICY STATUS, NOT A LEAD ONE. The policy tracker knows
--     about chargebacks; `leads.data.status` does not, and inventing a
--     lead↔policy write path was out of scope for this round. So Chargeback
--     Recovery enrolls on an applied `campaign_tag`, and the rule also
--     accepts `status is chargeback` so it starts working for free if that
--     status is ever written.
--
-- ---- The three sold-triggered campaigns queue, they do not chorus ---------
--
-- A lead may be ACTIVE in only one voice campaign (a partial unique index
-- says so). Customer Care, Emergency Contact and Beneficiary Referral all
-- trigger on the same sale, and sort_order is what makes the outcome
-- deterministic rather than "whichever row came back first": Customer Care
-- takes the client, and when it completes Emergency Contact takes them, and
-- then Beneficiary Referral. A newly-sold client is never phoned by three
-- robots in one week, and that is the feature, not a limitation.
-- ============================================================
create or replace function public.vc_default_campaigns()
returns jsonb
language sql
immutable
as $fn$
select $json$
[
  {
    "seed_key": "appointment_reminder_v1",
    "sort_order": 10,
    "name": "Appointment Reminder",
    "description": "Two reminders anchored to the appointment itself — the day before, then two hours before. A reminder that arrives late is worse than none, so a step whose moment has passed is skipped.",
    "campaign_goal": "remind",
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "appointment" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": true,
    "stop_on_appointment_booked": false,
    "stop_on_sold": true,
    "stop_on_answered": false,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call", "anchor": "appointment", "offset_minutes": -1440 },
      { "position": 2, "step_type": "call", "anchor": "appointment", "offset_minutes": -120 }
    ]
  },
  {
    "seed_key": "no_show_followup_v1",
    "sort_order": 20,
    "name": "No-Show Follow-up",
    "description": "They booked and did not answer the door. One quick call while it is still today, then a spreading cadence over the week.",
    "campaign_goal": "rebook",
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "appointment" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": true,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 15, "wait_unit": "minutes" },
      { "position": 2, "step_type": "double_dial", "wait_value": 3,  "wait_unit": "hours" },
      { "position": 3, "step_type": "call",        "wait_value": 1,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 3,  "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "customer_care_sold_v1",
    "sort_order": 30,
    "name": "Customer Care",
    "description": "A welcome call the day after the sale, then check-ins that spread out over the first six months. Only a do-not-call request stops it — this one is not trying to sell anything.",
    "campaign_goal": "care",
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "sold" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": true,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": false,
    "stop_on_sold": false,
    "stop_on_answered": false,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call", "wait_value": 1,   "wait_unit": "days" },
      { "position": 2, "step_type": "call", "wait_value": 6,   "wait_unit": "days" },
      { "position": 3, "step_type": "call", "wait_value": 23,  "wait_unit": "days" },
      { "position": 4, "step_type": "call", "wait_value": 60,  "wait_unit": "days" },
      { "position": 5, "step_type": "call", "wait_value": 90,  "wait_unit": "days" },
      { "position": 6, "step_type": "call", "wait_value": 180, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "emergency_contact_v1",
    "sort_order": 40,
    "name": "Emergency Contact",
    "description": "Calls a new client to collect an emergency contact for the file. Stops the moment somebody actually talks to it.",
    "campaign_goal": "emergency_contact",
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "sold" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": true,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": false,
    "stop_on_sold": false,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 2,  "wait_unit": "days" },
      { "position": 2, "step_type": "call",        "wait_value": 3,  "wait_unit": "days" },
      { "position": 3, "step_type": "double_dial", "wait_value": 5,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 10, "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 21, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "beneficiary_referral_v1",
    "sort_order": 50,
    "name": "Beneficiary Referral",
    "description": "Asks a settled client whether the people they named would want the same conversation. Stops the moment somebody actually talks to it.",
    "campaign_goal": "referral",
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "sold" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": true,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": false,
    "stop_on_sold": false,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" },
      { "position": 2, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" },
      { "position": 3, "step_type": "double_dial", "wait_value": 14, "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 21, "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 30, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "chargeback_recovery_v1",
    "sort_order": 60,
    "name": "Chargeback Recovery",
    "description": "Nine attempts over a month to reach a client whose policy fell off the books. Tag a lead \"chargeback\" to enrol them.",
    "campaign_goal": "chargeback",
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "chargeback" }] },
      { "conditions": [{ "field": "status", "op": "is", "value": "chargeback" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 1,  "wait_unit": "minutes" },
      { "position": 2, "step_type": "double_dial", "wait_value": 4,  "wait_unit": "hours",
        "drip_rate": { "per_minutes": 60, "max_calls": 40 } },
      { "position": 3, "step_type": "call",        "wait_value": 1,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 2,  "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 4,  "wait_unit": "days" },
      { "position": 6, "step_type": "double_dial", "wait_value": 7,  "wait_unit": "days" },
      { "position": 7, "step_type": "call",        "wait_value": 14, "wait_unit": "days" },
      { "position": 8, "step_type": "call",        "wait_value": 21, "wait_unit": "days" },
      { "position": 9, "step_type": "call",        "wait_value": 30, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "veteran_lead_v1",
    "sort_order": 70,
    "name": "Veteran Lead",
    "description": "Speed-to-lead on veteran leads: a call within a minute, a double-dial two hours later, then a decaying cadence over a fortnight.",
    "campaign_goal": "qualify",
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "veteran" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "veteran" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "veterans" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "va" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 1,  "wait_unit": "minutes" },
      { "position": 2, "step_type": "double_dial", "wait_value": 2,  "wait_unit": "hours",
        "drip_rate": { "per_minutes": 60, "max_calls": 40 } },
      { "position": 3, "step_type": "call",        "wait_value": 1,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 3,  "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" },
      { "position": 6, "step_type": "call",        "wait_value": 14, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "final_expense_v1",
    "sort_order": 80,
    "name": "Final Expense",
    "description": "Speed-to-lead on final-expense leads: a call within a minute, a double-dial two hours later, then a decaying cadence over a fortnight.",
    "campaign_goal": "qualify",
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "final_expense" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "final expense" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "final_expense" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "fex" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "burial" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 1,  "wait_unit": "minutes" },
      { "position": 2, "step_type": "double_dial", "wait_value": 2,  "wait_unit": "hours",
        "drip_rate": { "per_minutes": 60, "max_calls": 40 } },
      { "position": 3, "step_type": "call",        "wait_value": 1,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 3,  "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" },
      { "position": 6, "step_type": "call",        "wait_value": 14, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "mortgage_protection_v1",
    "sort_order": 90,
    "name": "Mortgage Protection",
    "description": "Speed-to-lead on mortgage-protection leads: a call within a minute, a double-dial two hours later, then a decaying cadence over a fortnight.",
    "campaign_goal": "qualify",
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "mortgage_protection" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "mortgage protection" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "mortgage_protection" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "mortgage" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 1,  "wait_unit": "minutes" },
      { "position": 2, "step_type": "double_dial", "wait_value": 2,  "wait_unit": "hours",
        "drip_rate": { "per_minutes": 60, "max_calls": 40 } },
      { "position": 3, "step_type": "call",        "wait_value": 1,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 3,  "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" },
      { "position": 6, "step_type": "call",        "wait_value": 14, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "iul_v1",
    "sort_order": 100,
    "name": "IUL",
    "description": "Speed-to-lead on indexed-universal-life leads: a call within a minute, a double-dial two hours later, then a decaying cadence over a fortnight.",
    "campaign_goal": "qualify",
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "iul" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "iul" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "indexed universal life" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 1,  "wait_unit": "minutes" },
      { "position": 2, "step_type": "double_dial", "wait_value": 2,  "wait_unit": "hours",
        "drip_rate": { "per_minutes": 60, "max_calls": 40 } },
      { "position": 3, "step_type": "call",        "wait_value": 1,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 3,  "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" },
      { "position": 6, "step_type": "call",        "wait_value": 14, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "general_life_v1",
    "sort_order": 110,
    "name": "General Life",
    "description": "Speed-to-lead on general life leads: a call within a minute, a double-dial two hours later, then a decaying cadence over a fortnight.",
    "campaign_goal": "qualify",
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "general_life" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "general life" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "life" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "term life" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "whole life" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 1,  "wait_unit": "minutes" },
      { "position": 2, "step_type": "double_dial", "wait_value": 2,  "wait_unit": "hours",
        "drip_rate": { "per_minutes": 60, "max_calls": 40 } },
      { "position": 3, "step_type": "call",        "wait_value": 1,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 3,  "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" },
      { "position": 6, "step_type": "call",        "wait_value": 14, "wait_unit": "days" }
    ]
  },
  {
    "seed_key": "trucker_v1",
    "sort_order": 120,
    "name": "Trucker",
    "description": "Speed-to-lead on trucker leads: a call within a minute, a double-dial two hours later, then a decaying cadence over a fortnight.",
    "campaign_goal": "qualify",
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "trucker" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "trucker" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "truck driver" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "cdl" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_answered": true,
    "stop_answer_talk_secs": 15,
    "steps": [
      { "position": 1, "step_type": "call",        "wait_value": 1,  "wait_unit": "minutes" },
      { "position": 2, "step_type": "double_dial", "wait_value": 2,  "wait_unit": "hours",
        "drip_rate": { "per_minutes": 60, "max_calls": 40 } },
      { "position": 3, "step_type": "call",        "wait_value": 1,  "wait_unit": "days" },
      { "position": 4, "step_type": "call",        "wait_value": 3,  "wait_unit": "days" },
      { "position": 5, "step_type": "call",        "wait_value": 7,  "wait_unit": "days" },
      { "position": 6, "step_type": "call",        "wait_value": 14, "wait_unit": "days" }
    ]
  }
]
$json$::jsonb;
$fn$;

comment on function public.vc_default_campaigns() is
  'The twelve pre-built voice campaigns, as one jsonb literal. THE ONLY COPY: the seeder reads this and test/voice-campaigns.test.mjs extracts the same literal out of the migration text and runs every rule through the real matcher. Do not mirror it into TypeScript.';

-- ============================================================
-- PART 4 — the seeder
-- ============================================================

-- ------------------------------------------------------------
-- The tombstone. This table is the whole reason a re-seed is respectful.
--
-- "Has this agent already been given the Veteran Lead default?" cannot be
-- answered by looking for the campaign, because an agent who DELETED it looks
-- exactly like an agent who never had it — and re-creating a campaign somebody
-- deliberately deleted is the worst thing a seeder can do. It would resurrect
-- a program that phones consumers.
--
-- So presence is recorded here, once, and never removed by anything automatic.
-- The insert is `on conflict do nothing` and its ROW COUNT is what decides
-- whether the campaign gets built — which makes the whole seeder idempotent
-- through one primary key rather than through the caller remembering.
-- ------------------------------------------------------------
create table if not exists public.voice_campaign_seed_state (
  agent_id   uuid not null references auth.users(id) on delete cascade,
  seed_key   text not null,
  seeded_at  timestamptz not null default now(),
  primary key (agent_id, seed_key)
);

alter table public.voice_campaign_seed_state enable row level security;

drop policy if exists "voice_campaign_seed_state_select_own" on public.voice_campaign_seed_state;
create policy "voice_campaign_seed_state_select_own"
  on public.voice_campaign_seed_state for select using (auth.uid() = agent_id);

comment on table public.voice_campaign_seed_state is
  'One row per (agent, shipped default) recording that the default was OFFERED. Never removed automatically. It is what lets a re-seed add nothing for an agent who deactivated, edited or DELETED a seeded campaign — without it, a deleted campaign is indistinguishable from one that was never seeded, and a re-seed would resurrect a program that phones consumers. SELECT-only for authenticated; written by vc_seed_default_campaigns_for() under SECURITY DEFINER. Deleting a row here is the deliberate act that re-offers that default.';

-- ------------------------------------------------------------
-- vc_seed_default_campaigns_for(agent) — the worker.
--
-- SECURITY DEFINER because the agent-creation trigger runs it for a user who
-- has no session, and REVOKEd from anon/authenticated because it names an
-- agent. The browser-callable form below takes no parameter and anchors on
-- auth.uid() — the same shape as apply_producer_codes() and get_team_summary().
--
-- ALL TWELVE SHIP ACTIVE. Every one of them still passes ai-call-start's full
-- gate chain on every single call, and gate 3 refuses any lead without
-- recorded TCPA consent — so a live seeded campaign enrols nobody until the
-- agent has consented leads. Shipping them active is defensible. Shipping
-- them active WITHOUT SAYING SO ON SCREEN is not, which is what the banner in
-- the Campaigns page and the AI dialer is for.
-- ------------------------------------------------------------
-- The OUT columns are named campaign_seed_key / was_created rather than the
-- obvious seed_key / created because plpgsql substitutes its own variables
-- into SQL, and a variable called `seed_key` would shadow the COLUMN of that
-- name in `on conflict (agent_id, seed_key)` — the one statement the whole
-- idempotency rests on.
create or replace function public.vc_seed_default_campaigns_for(p_agent uuid)
returns table (campaign_seed_key text, was_created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  def       jsonb;
  step      jsonb;
  new_id    uuid;
  claimed   boolean;
begin
  if p_agent is null then
    return;
  end if;

  for def in select * from jsonb_array_elements(public.vc_default_campaigns())
  loop
    -- The claim. One insert, one primary key, one answer to "has this agent
    -- already been offered this default". FOUND is false when ON CONFLICT
    -- swallowed it, which is exactly "already offered".
    claimed := false;
    insert into public.voice_campaign_seed_state (agent_id, seed_key)
    values (p_agent, def->>'seed_key')
    on conflict (agent_id, seed_key) do nothing;
    if found then claimed := true; end if;

    if not claimed then
      return query select (def->>'seed_key')::text, false;
      continue;
    end if;

    -- Belt and braces: a campaign already wearing this seed_key (an older
    -- seeding run, before the tombstone table existed) is left exactly as it
    -- is. Never updated, never reactivated.
    if exists (
      select 1 from public.voice_campaigns c
       where c.agent_id = p_agent and c.seed_key = def->>'seed_key'
    ) then
      return query select (def->>'seed_key')::text, false;
      continue;
    end if;

    insert into public.voice_campaigns (
      agent_id, name, description, active, dry_run, sort_order, campaign_goal,
      trigger_groups,
      auto_enroll_new_leads, trigger_on_missed_appointment, trigger_on_sold,
      trigger_on_appointment_booked,
      stop_on_appointment_booked, stop_on_sold, stop_on_answered,
      stop_answer_talk_secs, seed_key
    ) values (
      p_agent,
      def->>'name',
      def->>'description',
      true,
      false,
      coalesce((def->>'sort_order')::int, 100),
      def->>'campaign_goal',
      coalesce(def->'trigger_groups', '[]'::jsonb),
      coalesce((def->>'auto_enroll_new_leads')::boolean, false),
      coalesce((def->>'trigger_on_missed_appointment')::boolean, false),
      coalesce((def->>'trigger_on_sold')::boolean, false),
      coalesce((def->>'trigger_on_appointment_booked')::boolean, false),
      coalesce((def->>'stop_on_appointment_booked')::boolean, true),
      coalesce((def->>'stop_on_sold')::boolean, true),
      coalesce((def->>'stop_on_answered')::boolean, false),
      coalesce((def->>'stop_answer_talk_secs')::int, 15),
      def->>'seed_key'
    )
    returning id into new_id;

    -- Steps in the SAME transaction as the campaign. A campaign with no steps
    -- enrols nobody (vcFirstStep returns null and the sweep returns early), so
    -- a half-seeded campaign would be a live, permanently empty card.
    for step in select * from jsonb_array_elements(coalesce(def->'steps', '[]'::jsonb))
    loop
      insert into public.voice_campaign_steps (
        campaign_id, agent_id, position, step_type,
        wait_value, wait_unit, anchor, offset_minutes, drip_rate
      ) values (
        new_id,
        p_agent, -- overwritten by voice_campaign_steps_derive; sent for clarity
        (step->>'position')::int,
        coalesce(step->>'step_type', 'call'),
        coalesce((step->>'wait_value')::int, 0),
        coalesce(step->>'wait_unit', 'minutes'),
        coalesce(step->>'anchor', 'previous_step'),
        coalesce((step->>'offset_minutes')::int, 0),
        step->'drip_rate'
      );
    end loop;

    return query select (def->>'seed_key')::text, true;
  end loop;
end;
$$;

revoke all on function public.vc_seed_default_campaigns_for(uuid) from public, anon, authenticated;

comment on function public.vc_seed_default_campaigns_for(uuid) is
  'Seeds the twelve shipped voice campaigns for one agent. Idempotent AND respectful: presence is keyed on voice_campaign_seed_state, so re-running adds nothing and an agent who deactivated, edited or deleted a seeded campaign never has it reactivated, overwritten or resurrected. SECURITY DEFINER and REVOKEd from anon/authenticated because it names an agent — the browser-callable form is vc_seed_default_campaigns(), which takes no parameter and anchors on auth.uid().';

-- The browser-callable form. No parameter names an agent; same shape and
-- reasoning as apply_producer_codes().
create or replace function public.vc_seed_default_campaigns()
returns table (campaign_seed_key text, was_created boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'vc_seed_default_campaigns: no authenticated agent';
  end if;
  return query select * from public.vc_seed_default_campaigns_for(auth.uid());
end;
$$;

grant execute on function public.vc_seed_default_campaigns() to authenticated;

-- ------------------------------------------------------------
-- The agent-creation hook.
--
-- On public.agents rather than inside auth.handle_new_user(): every path that
-- creates an agent row goes through this table, and an AFTER INSERT trigger
-- here cannot break sign-up by editing a function the auth schema owns.
--
-- EXCEPTION-SWALLOWING IS DELIBERATE. A sign-up must never fail because a
-- default campaign did not insert. The cost of swallowing is an agent with no
-- campaigns, which is fully recoverable — vc_seed_default_campaigns() is
-- idempotent and the app calls it on load. The cost of not swallowing is an
-- account that cannot be created.
-- ------------------------------------------------------------
create or replace function public.agents_seed_voice_campaigns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.vc_seed_default_campaigns_for(new.id);
  exception when others then
    raise warning 'agents_seed_voice_campaigns: seeding failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists agents_seed_voice_campaigns on public.agents;
create trigger agents_seed_voice_campaigns
  after insert on public.agents
  for each row execute function public.agents_seed_voice_campaigns();

-- ============================================================
-- PART 5 — consent: the ledger and the guard
-- ============================================================

-- ------------------------------------------------------------
-- lead_consent_events — what was attested, by whom, and when.
--
-- `leads.tcpa_consent` is the CURRENT STATE, one boolean. This is the HISTORY,
-- and it is the part a regulator reads: the exact attestation sentence the
-- agent ticked, the source they named, the phone number as it stood at the
-- time, and the instant. Append-only — there is no update or delete policy and
-- there never should be, because the whole value of the row is that it cannot
-- be tidied up afterwards.
--
-- Deliberately separate from `consent_records`. That table is the TEXTING
-- gate's evidence and its rows are read by runComplianceGate on every SMS;
-- putting a voice attestation in it would silently widen what may be texted.
-- Voice consent and text consent are different permissions and this round does
-- not conflate them.
-- ------------------------------------------------------------
create table if not exists public.lead_consent_events (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references auth.users(id) on delete cascade,
  lead_id           uuid not null references public.leads(id) on delete cascade,
  client_id         text,
  action            text not null check (action in ('granted','revoked')),
  consent_source    text,
  attestation_text  text,
  contact_phone     text,
  lead_name         text,
  created_at        timestamptz not null default now()
);

create index if not exists lead_consent_events_agent_idx
  on public.lead_consent_events (agent_id, created_at desc);
create index if not exists lead_consent_events_lead_idx
  on public.lead_consent_events (lead_id, created_at desc);

alter table public.lead_consent_events enable row level security;

drop policy if exists "lead_consent_events_select_own" on public.lead_consent_events;
create policy "lead_consent_events_select_own"
  on public.lead_consent_events for select using (auth.uid() = agent_id);

comment on table public.lead_consent_events is
  'Append-only audit of every voice-consent decision an agent made about a lead: the attestation sentence they ticked verbatim, the source they named, the phone as it stood, the instant. SELECT-only for authenticated — every write goes through the leads-consent edge function under the service role, with the agent taken FROM THE JWT. Do not add an INSERT/UPDATE/DELETE policy: a consent trail that can be rewritten is not a trail. Separate from consent_records on purpose — that table is the TEXTING gate''s evidence and voice consent must not silently widen what may be texted.';

-- ------------------------------------------------------------
-- The column guard.
--
-- public.leads is fully owner-writable — it has to be, the whole lead book is
-- a browser-side app that re-upserts every row on every save. That means that
-- until this trigger, a browser could set tcpa_consent = true on a lead by
-- itself, and gate 3 of ai-call-start would then let the AI phone that person.
-- The attestation, the source, the audit row and the deliberate friction of an
-- unticked checkbox would all be optional.
--
-- So the three consent columns are now settable only by the service role, i.e.
-- only by the leads-consent function, which requires the attestation and
-- writes the ledger row in the same request.
--
-- NO ADMIN EXEMPTION, unlike the phone_numbers and agents guards. Those
-- protect ownership and billing fields an admin legitimately administers.
-- This one protects a statement about what a CONSUMER agreed to, and there is
-- no version of "an administrator may assert consent on someone's behalf" that
-- is worth writing down.
-- ------------------------------------------------------------
create or replace function public.leads_protect_consent_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only end-user requests through PostgREST as 'authenticated'/'anon'.
  -- service_role edge functions and direct SQL sessions are trusted.
  if auth.role() is distinct from 'authenticated' and auth.role() is distinct from 'anon' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A brand-new lead has no consent. Anything else arriving on an insert is
    -- a claim the client is not entitled to make.
    new.tcpa_consent        := false;
    new.tcpa_consent_source := null;
    new.tcpa_consent_at     := null;
    return new;
  end if;

  new.tcpa_consent        := old.tcpa_consent;
  new.tcpa_consent_source := old.tcpa_consent_source;
  new.tcpa_consent_at     := old.tcpa_consent_at;
  return new;
end;
$$;

drop trigger if exists leads_protect_consent_columns on public.leads;
create trigger leads_protect_consent_columns
  before insert or update on public.leads
  for each row execute function public.leads_protect_consent_columns();

comment on function public.leads_protect_consent_columns() is
  'Makes leads.tcpa_consent / _source / _at unwritable from the browser. public.leads is owner-writable (the lead book re-upserts every row on every save), so without this a client could assert its own consent and ai-call-start gate 3 would honour it — bypassing the attestation, the named source and the audit row. NO ADMIN EXEMPTION, unlike the phone_numbers and agents guards: this column records what a consumer agreed to, not something an administrator administers.';

-- ============================================================
-- PART 6 — backfill: every existing agent gets the twelve, now
-- ============================================================
--
-- Idempotent through the tombstone: re-running this file seeds nothing a
-- second time, and touches nothing an agent has since changed.
do $$
declare
  a record;
begin
  for a in select id from public.agents loop
    perform public.vc_seed_default_campaigns_for(a.id);
  end loop;
end $$;
