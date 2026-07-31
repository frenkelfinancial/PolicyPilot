-- ============================================================
-- 20260806_sms_ai_responder.sql
-- The AI texting agent: conversations, the responder's settings, and the
-- scheduled follow-ups a STOP has to be able to cancel.
--
-- WHAT EXISTED BEFORE THIS, precisely: `public.messages` (one row per OUTBOUND
-- send attempt) and `public.inbound_messages` (inbound, written mainly so an
-- opt-out keyword had somewhere to land). There was no thread, no ordering
-- across the two, and no way to say who wrote a message. You could not ask
-- "what did this person and this agent say to each other", let alone "and
-- which of those did the AI write".
--
-- Those two tables are NOT replaced and NOT migrated. They are the BILLING and
-- PROVIDER record — `messages.hold_ledger_id` is what wallet_settle/wallet_void
-- resolve against, and `inbound_messages.provider_event_id` carries the unique
-- index that makes Telnyx retries idempotent. `sms_messages` is the CONVERSATION
-- record and points at both. One row per message either way; two tables because
-- they answer different questions and only one of them may ever be reshaped.
--
-- Read docs/sms-ai-responder.md alongside this.
-- Idempotent: safe to run more than once. Wrap in begin/commit when applying.
-- ============================================================

-- ------------------------------------------------------------
-- 1. sms_conversations — one thread per (agent, contact).
--
-- Keyed on the PHONE, not the lead: a text can arrive from somebody who is not
-- in the book yet, and the thread has to exist before the lead does. lead_id is
-- filled in when we know it and is allowed to stay null.
--
-- `ai_muted` is the takeover switch and it is deliberately a plain boolean with
-- a reason beside it rather than three flags: the AI is either answering this
-- thread or it is not, and every way of turning it off has to look the same to
-- the responder or one of them will get missed.
-- ------------------------------------------------------------
create table if not exists public.sms_conversations (
  id                 uuid primary key default gen_random_uuid(),
  agent_id           uuid not null references auth.users(id) on delete cascade,
  lead_id            uuid references public.leads(id) on delete set null,
  -- Canonical E.164, always. Everything that compares a phone number in this
  -- schema goes through toE164() first, for the same reason dnc_list does.
  contact_phone      text not null,
  -- The number of OURS this thread runs on. A lead who has texted two of the
  -- agent's numbers is still one conversation; this records the most recent.
  agent_number       text,
  status             text not null default 'open'
                       check (status in ('open', 'closed')),
  closed_reason      text,
  closed_at          timestamptz,

  -- The AI half.
  ai_muted           boolean not null default false,
  ai_muted_reason    text check (ai_muted_reason is null or ai_muted_reason in
                       ('agent_takeover', 'agent_toggle', 'opted_out', 'booked')),
  ai_muted_at        timestamptz,

  -- Hot handoff (Part 3).
  hot                boolean not null default false,
  hot_reason         text,
  hot_at             timestamptz,
  -- When the agent was last SMS-alerted about this thread. The throttle reads
  -- this and nothing else, so an alert that failed to send does not silently
  -- consume the window.
  hot_alerted_at     timestamptz,

  -- Which settings row the responder uses. Null means the `default` row.
  campaign_type      text,

  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  -- Cleared by any lead reply, a booking, a STOP, a DNC or a mute. Non-null
  -- means a nudge is scheduled and sms_nudges has the row.
  nudge_step         int not null default 0,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One thread per contact per agent. This is what makes "find or create" a
-- single upsert rather than a read-then-write race between two inbound
-- webhooks arriving together.
create unique index if not exists sms_conversations_agent_contact_uidx
  on public.sms_conversations (agent_id, contact_phone);
create index if not exists sms_conversations_agent_recent_idx
  on public.sms_conversations (agent_id, last_inbound_at desc nulls last);
create index if not exists sms_conversations_lead_idx
  on public.sms_conversations (lead_id) where lead_id is not null;
create index if not exists sms_conversations_hot_idx
  on public.sms_conversations (agent_id) where hot;

comment on table public.sms_conversations is
  'One SMS thread per (agent, contact phone). Keyed on the phone rather than the lead because a text can arrive from somebody who is not in the book yet. ai_muted is the single switch the responder reads — every way of turning the AI off for a thread sets it, so none can be missed. Written only by service-role edge functions; SELECT-only for authenticated.';
comment on column public.sms_conversations.ai_muted_reason is
  'agent_takeover (the agent sent a message by hand), agent_toggle (they used the switch), opted_out (STOP), booked. Display only — the responder branches on ai_muted alone.';
comment on column public.sms_conversations.hot_alerted_at is
  'When the agent was last SMS-alerted about this thread. The 4-hour throttle reads this and only this, so an alert whose send failed does not consume the window.';

-- ------------------------------------------------------------
-- 2. sms_messages — the thread itself.
--
-- `sent_by` is the column this whole feature turns on. 'ai' vs 'agent' is what
-- the AI chip renders, what auto-mute keys off, and what makes "did a person
-- write this?" answerable after the fact — which is the question that gets
-- asked when a consumer complains.
-- ------------------------------------------------------------
create table if not exists public.sms_messages (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references public.sms_conversations(id) on delete cascade,
  agent_id           uuid not null references auth.users(id) on delete cascade,
  direction          text not null check (direction in ('inbound', 'outbound')),
  -- lead   — they texted us
  -- ai     — the responder wrote it
  -- agent  — a person typed it
  -- system — opt-out confirmations, appointment confirmations: ours, but
  --          nobody chose the words at the time.
  sent_by            text not null check (sent_by in ('ai', 'agent', 'system', 'lead')),
  body               text not null default '',
  media_urls         text[],

  -- The billing/provider rows this corresponds to. Exactly one is set.
  message_id         uuid references public.messages(id) on delete set null,
  inbound_message_id uuid references public.inbound_messages(id) on delete set null,
  provider_message_id text,
  status             text,
  delivered_at       timestamptz,
  failed_reason      text,

  created_at         timestamptz not null default now()
);

create index if not exists sms_messages_conversation_idx
  on public.sms_messages (conversation_id, created_at desc);
create index if not exists sms_messages_agent_created_idx
  on public.sms_messages (agent_id, created_at desc);
-- The dedupe path for inbound: one thread row per provider event.
create unique index if not exists sms_messages_inbound_uidx
  on public.sms_messages (inbound_message_id) where inbound_message_id is not null;

comment on table public.sms_messages is
  'The conversation record: one row per message in either direction, ordered, with sent_by. public.messages and public.inbound_messages remain the BILLING and PROVIDER records and are pointed at from here, never replaced — messages.hold_ledger_id is what wallet_settle/wallet_void resolve against.';
comment on column public.sms_messages.sent_by is
  'ai | agent | system | lead. What the AI chip renders, what auto-mute keys off, and how "did a person write this?" stays answerable after the fact.';

-- ------------------------------------------------------------
-- 3. sms_ai_settings — per agent, per campaign type.
--
-- OWNER-WRITABLE, unlike everything else here. These are the agent's own
-- preferences about wording — the same class as producer_codes and
-- voice_campaigns, not the same class as a standing instruction to message a
-- consumer. Nothing in this table can cause a message to be sent to anybody:
-- the responder only ever runs on an inbound text that already passed consent.
--
-- Defaults are chosen so an agent who never opens this screen still gets a
-- working responder on day one. `enabled` defaults TRUE for that reason, and
-- the account-level switch (agents.sms_ai_enabled, below) is what actually
-- decides whether any of it runs.
-- ------------------------------------------------------------
create table if not exists public.sms_ai_settings (
  id                 uuid primary key default gen_random_uuid(),
  agent_id           uuid not null references auth.users(id) on delete cascade,
  -- One of the twelve campaign types, or 'default' for a thread that belongs
  -- to no campaign. Free text on purpose: a thirteenth campaign must not need
  -- a migration before its settings row can exist.
  campaign_type      text not null default 'default',

  enabled            boolean not null default true,
  tone               text not null default 'friendly'
                       check (tone in ('professional', 'friendly', 'casual')),
  reply_length       text not null default 'brief'
                       check (reply_length in ('brief', 'medium')),
  emojis             boolean not null default false,

  -- Nudge schedule. Each step is independently switchable, and a step that is
  -- off is SKIPPED rather than ending the schedule — turning off 8h must not
  -- silently disable 24h behind it. See nudgeStepsFor() in
  -- _shared/sms-ai-core.ts, where a test pins exactly that.
  nudge_8h           boolean not null default true,
  nudge_24h          boolean not null default true,
  nudge_48h          boolean not null default false,
  nudge_7d           boolean not null default false,

  appointment_minutes int not null default 30 check (appointment_minutes between 5 and 240),
  appointment_label  text not null default 'Consultation',

  -- Up to 20 {trigger, answer} pairs. Stored as jsonb rather than a child
  -- table because they are edited as one list, saved as one list, and never
  -- queried individually.
  custom_pairs       jsonb not null default '[]'::jsonb,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint sms_ai_settings_pairs_is_array
    check (jsonb_typeof(custom_pairs) = 'array'),
  -- The cap is enforced here as well as in the editor, because the editor is a
  -- browser and this table is owner-writable.
  constraint sms_ai_settings_pairs_max_20
    check (jsonb_array_length(custom_pairs) <= 20)
);

create unique index if not exists sms_ai_settings_agent_type_uidx
  on public.sms_ai_settings (agent_id, campaign_type);

comment on table public.sms_ai_settings is
  'Per-agent, per-campaign-type wording preferences for the AI texting agent. Owner-writable — the same class as producer_codes: nothing in this table can cause a message to be sent, because the responder only ever runs on an inbound text that already passed the consent gate. Defaults are chosen so an agent who never opens the screen still has a working responder.';
comment on column public.sms_ai_settings.custom_pairs is
  'Up to 20 {trigger, answer} objects. A deterministic substring match runs BEFORE the model; an unambiguous hit is used verbatim, and the whole list is also given to the model as ground truth. Capped in the database as well as the editor because this table is owner-writable.';

-- ------------------------------------------------------------
-- 4. sms_nudges — the scheduled follow-ups.
--
-- This table is the reason the STOP path had a hole worth fixing. The prompt
-- asked to verify that a STOP "closes the conversation and cancels scheduled
-- sends"; it did neither, because there was no conversation and nothing was
-- ever scheduled. There is now, so both are real obligations.
--
-- SELECT-only for authenticated. A row here is a promise to text a consumer at
-- a future time, which is exactly the class of thing a browser must not be
-- able to write — same reasoning as voice_campaign_enrollments.
-- ------------------------------------------------------------
create table if not exists public.sms_nudges (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references public.sms_conversations(id) on delete cascade,
  agent_id           uuid not null references auth.users(id) on delete cascade,
  step               int not null check (step between 1 and 4),
  -- The schedule's own instant. Quiet hours are applied when it FIRES, not
  -- when it is scheduled, because the lead's timezone can be learned in
  -- between and a deferral must not become a drop.
  due_at             timestamptz not null,
  status             text not null default 'scheduled'
                       check (status in ('scheduled', 'sent', 'cancelled', 'failed')),
  cancel_reason      text,
  sent_at            timestamptz,
  sms_message_id     uuid references public.sms_messages(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- At most one live nudge per conversation. The sweeper claims by flipping
-- status, so this index is also what stops two sweeps sending the same nudge.
create unique index if not exists sms_nudges_one_scheduled_uidx
  on public.sms_nudges (conversation_id) where status = 'scheduled';
create index if not exists sms_nudges_due_idx
  on public.sms_nudges (due_at) where status = 'scheduled';

comment on table public.sms_nudges is
  'Scheduled AI-initiated follow-ups for a quiet conversation. One live row per conversation (partial unique index), which is also what stops two sweeps sending the same nudge. Cancelled by any lead reply, STOP, DNC, booking or mute. SELECT-only for authenticated: a row here is a promise to text a consumer at a future time.';
comment on column public.sms_nudges.due_at is
  'Quiet hours are applied when this FIRES, not when it is scheduled — the lead''s timezone can be learned in between, and a deferral must never become a drop.';

-- ------------------------------------------------------------
-- 5. The account-level switch, beside the voice one.
--
-- agents.ai_dialer_enabled is the voice kill switch. This is its sibling, and
-- it DEFAULTS TRUE for the same reason ai_inbound_enabled does: the feature is
-- worthless if every agent has to find a toggle first, and the real gates
-- (consent, plan, per-conversation mute) are all still in front of it.
-- ------------------------------------------------------------
alter table public.agents
  add column if not exists sms_ai_enabled boolean not null default true;

comment on column public.agents.sms_ai_enabled is
  'Account-level kill switch for the AI texting agent, the sibling of ai_dialer_enabled. Defaults true — consent, the plan gate and the per-conversation mute are all still in front of it, and a feature nobody can find a toggle for is a feature nobody uses.';

-- ------------------------------------------------------------
-- 6. Appointments booked over text.
--
-- The SAME table voice books into, deliberately. One appointment model, one
-- Calendar tab, one confirmation path. `ai_call_id` was already nullable, so a
-- text booking simply leaves it null and names its conversation instead.
-- ------------------------------------------------------------
alter table public.ai_appointments
  add column if not exists sms_conversation_id uuid
    references public.sms_conversations(id) on delete set null;

create index if not exists ai_appointments_sms_conversation_idx
  on public.ai_appointments (sms_conversation_id) where sms_conversation_id is not null;

comment on column public.ai_appointments.sms_conversation_id is
  'Set when the AI booked this over text instead of on a call. Exactly one of ai_call_id / sms_conversation_id is set. source is ''ai_text'' for these.';

-- ------------------------------------------------------------
-- 7. RLS.
--
-- Three SELECT policies and one owner-writable table. NOTHING here gets an
-- INSERT or UPDATE policy for conversations, messages or nudges: every write
-- goes through a service-role edge function with the agent taken from the JWT.
-- A browser that could insert an sms_messages row could put words in the AI's
-- mouth on a consumer's record; one that could insert an sms_nudges row could
-- schedule a text to anybody.
-- ------------------------------------------------------------
alter table public.sms_conversations enable row level security;
alter table public.sms_messages      enable row level security;
alter table public.sms_nudges        enable row level security;
alter table public.sms_ai_settings   enable row level security;

drop policy if exists "sms_conversations_select_own" on public.sms_conversations;
create policy "sms_conversations_select_own"
  on public.sms_conversations for select
  using (auth.uid() = agent_id);

drop policy if exists "sms_messages_select_own" on public.sms_messages;
create policy "sms_messages_select_own"
  on public.sms_messages for select
  using (auth.uid() = agent_id);

drop policy if exists "sms_nudges_select_own" on public.sms_nudges;
create policy "sms_nudges_select_own"
  on public.sms_nudges for select
  using (auth.uid() = agent_id);

-- The settings table IS owner-writable — see the note on the table.
drop policy if exists "sms_ai_settings_select_own" on public.sms_ai_settings;
create policy "sms_ai_settings_select_own"
  on public.sms_ai_settings for select
  using (auth.uid() = agent_id);
drop policy if exists "sms_ai_settings_insert_own" on public.sms_ai_settings;
create policy "sms_ai_settings_insert_own"
  on public.sms_ai_settings for insert
  with check (auth.uid() = agent_id);
drop policy if exists "sms_ai_settings_update_own" on public.sms_ai_settings;
create policy "sms_ai_settings_update_own"
  on public.sms_ai_settings for update
  using (auth.uid() = agent_id)
  with check (auth.uid() = agent_id);
drop policy if exists "sms_ai_settings_delete_own" on public.sms_ai_settings;
create policy "sms_ai_settings_delete_own"
  on public.sms_ai_settings for delete
  using (auth.uid() = agent_id);

-- ------------------------------------------------------------
-- 8. updated_at, using the trigger function this schema already has.
-- ------------------------------------------------------------
drop trigger if exists sms_conversations_touch_updated_at on public.sms_conversations;
create trigger sms_conversations_touch_updated_at
  before update on public.sms_conversations
  for each row execute function public.touch_updated_at();

drop trigger if exists sms_ai_settings_touch_updated_at on public.sms_ai_settings;
create trigger sms_ai_settings_touch_updated_at
  before update on public.sms_ai_settings
  for each row execute function public.touch_updated_at();

drop trigger if exists sms_nudges_touch_updated_at on public.sms_nudges;
create trigger sms_nudges_touch_updated_at
  before update on public.sms_nudges
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 9. agent_id is DERIVED on sms_ai_settings, never accepted from the client.
--
-- The table is owner-writable and the RLS policy already pins agent_id to
-- auth.uid(), but a WITH CHECK only refuses the row — this fills it in, so the
-- editor never has to send an agent id at all. Same reasoning as
-- voice_campaign_steps deriving its agent_id from the campaign.
-- ------------------------------------------------------------
create or replace function public.sms_ai_settings_set_agent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.agent_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists sms_ai_settings_set_agent on public.sms_ai_settings;
create trigger sms_ai_settings_set_agent
  before insert on public.sms_ai_settings
  for each row execute function public.sms_ai_settings_set_agent();

comment on function public.sms_ai_settings_set_agent() is
  'Derives sms_ai_settings.agent_id from auth.uid() on insert so the editor never sends one. A service-role write (auth.uid() null) keeps whatever it supplied.';
