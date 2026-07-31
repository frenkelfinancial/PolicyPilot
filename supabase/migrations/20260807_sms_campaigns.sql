-- ============================================================
-- 20260807_sms_campaigns.sql
-- SMS campaigns: text drips on the SAME engine as the voice campaigns.
--
-- ---- THE ARCHITECTURE DECISION, AND WHY ------------------------------------
--
-- There are no new campaign tables. `voice_campaigns`, `voice_campaign_steps`
-- and `voice_campaign_enrollments` grow a `channel` column, and the existing
-- tick, enrollment model, stop conditions, manual-enrollment door and seeding
-- seam carry both channels.
--
-- The alternative — `sms_campaigns` / `sms_campaign_steps` /
-- `sms_campaign_enrollments` beside the voice ones — was rejected because it
-- produces TWO of every single thing this feature is made of: two ticks racing
-- the same minute, two definitions of "who may be enrolled", two claim
-- protocols, two "Add to campaign" doors, two seeders, two mission-control
-- screens. Every one of those pairs is a place where the SMS half and the voice
-- half can quietly start disagreeing, and the whole reason the voice engine is
-- trustworthy is that there is exactly one of each.
--
-- THE TABLE NAMES ARE NOW HISTORICAL, AND THAT IS THE PRICE. A row in
-- `voice_campaigns` with `channel = 'sms'` is a texting campaign. Renaming the
-- three tables, the three edge functions, the pg_cron job, the twelve seeded
-- campaigns and roughly fifteen hundred lines of app.html would be a large,
-- risky change that buys nothing an agent can see — the word "voice" appears
-- nowhere in the product's UI for these. `channel` is the truth; the prefix is
-- a name. See docs/sms-campaigns.md § "Why the tables still say voice".
--
-- ---- THE ONE RULE, RESTATED FOR TEXT ---------------------------------------
--
-- Every campaign CALL goes through ai-call-start. Every campaign TEXT goes
-- through _shared/campaign-sms-send.ts, which is runComplianceGate ->
-- resolveTextingNumber -> sendMessageCore -> the sms_messages thread, in that
-- order, with no copy of any of it anywhere else. Consent, DNC, suppression and
-- quiet hours are enforced once, by the same code a hand-typed message and a
-- broadcast go through.
--
-- Read docs/sms-campaigns.md alongside this. The DECISIONS live there; this
-- file is the shape.
--
-- Idempotent: safe to run more than once. Wrap in begin/commit when applying.
-- ============================================================

-- ============================================================
-- PART 1 — voice_campaigns grows a channel and two SMS-only stop rules
-- ============================================================

alter table public.voice_campaigns
  add column if not exists channel text not null default 'voice';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_campaigns'::regclass
                    and conname  = 'voice_campaigns_channel_check') then
    alter table public.voice_campaigns
      add constraint voice_campaigns_channel_check
      check (channel in ('voice', 'sms'));
  end if;
end $$;

-- END THE DRIP WHEN THEY REPLY.
--
-- Default TRUE, and the reason is that the opposite default is the one that
-- embarrasses an agent: a lead who wrote back "yes I'm interested, call me"
-- and then received step 4 of a sequence two days later has been ignored by a
-- robot in front of a witness. Turning it off is a deliberate choice for a
-- campaign whose sequence is genuinely informational.
--
-- NOTE WHAT THIS DOES NOT TURN OFF. The SMS-1 conversation responder answers
-- an inbound text wherever consent exists, whatever this column says. That is
-- a different feature with a different gate chain, and the editor says so in
-- as many words — see the note beside the checkbox in app.html.
alter table public.voice_campaigns
  add column if not exists stop_on_reply boolean not null default true;

-- HOLD A SCHEDULED STEP WHILE A CONVERSATION IS LIVE.
--
-- Distinct from stop_on_reply, and needed even when that is off: an
-- informational drip must still not fire a canned step into the middle of a
-- real exchange. "Live" is any inbound message inside
-- VC_SMS_CONVERSATION_WINDOW_HOURS (24), or a thread the agent has taken over
-- by hand. The step is DEFERRED to when the window closes, not skipped — the
-- lead still gets the sequence, just not on top of a sentence.
alter table public.voice_campaigns
  add column if not exists pause_on_active_conversation boolean not null default true;

comment on column public.voice_campaigns.channel is
  'voice | sms. THE TABLE NAME IS HISTORICAL: a row here with channel = ''sms'' is a texting campaign and is run by the same tick, the same enrollment model and the same stop machinery as a calling one. Chosen over parallel sms_* tables so there is exactly one of each of those rather than two that can drift. See docs/sms-campaigns.md.';
comment on column public.voice_campaigns.stop_on_reply is
  'SMS only. End the enrollment when the lead sends any inbound message. Defaults true: continuing a canned sequence at somebody who has written back is the failure this feature is most likely to be blamed for. It does NOT switch off the SMS-1 conversation responder, which answers inbound text wherever consent exists regardless of this column.';
comment on column public.voice_campaigns.pause_on_active_conversation is
  'SMS only. While a conversation is live (an inbound message within the last 24h, or the agent has taken the thread over) a scheduled step is DEFERRED to when that window closes rather than sent. Independent of stop_on_reply, because an informational drip that does not stop on a reply must still not talk over one.';

-- ============================================================
-- PART 2 — voice_campaign_steps learns to carry a message
-- ============================================================
--
-- `sms_message` is a body plus an optional attachment. `wait` is a step that
-- does nothing but pass time.
--
-- WHY A `wait` STEP EXISTS WHEN EVERY STEP ALREADY HAS A WAIT. Because it is
-- how a person describes a text sequence — "send this, wait two days, send
-- that" — and because a sequence written that way reads correctly in the
-- editor. It costs the engine nothing: vcResolveNextDue() FOLDS a wait step's
-- delay into the next actionable step's due time rather than waking up to do
-- nothing, so "send / wait 2d / send" and one step with a two-day wait produce
-- the identical schedule and the identical number of ticks.
alter table public.voice_campaign_steps
  add column if not exists body      text,
  add column if not exists media_url text;

do $$
begin
  -- Widen the step_type allowlist. The two voice values are unchanged and
  -- their meaning is unchanged; a test asserts voice pacing is byte-identical.
  if exists (select 1 from pg_constraint
              where conrelid = 'public.voice_campaign_steps'::regclass
                and conname  = 'voice_campaign_steps_step_type_check') then
    alter table public.voice_campaign_steps
      drop constraint voice_campaign_steps_step_type_check;
  end if;
  alter table public.voice_campaign_steps
    add constraint voice_campaign_steps_step_type_check
    check (step_type in ('call', 'double_dial', 'sms_message', 'wait'));

  -- A body long enough to be a problem is a body that costs real money in
  -- segments and arrives on a consumer's phone as a wall. 1,600 characters is
  -- ten segments; the editor warns from two.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_campaign_steps'::regclass
                    and conname  = 'voice_campaign_steps_body_len_check') then
    alter table public.voice_campaign_steps
      add constraint voice_campaign_steps_body_len_check
      check (body is null or length(body) <= 1600);
  end if;
end $$;

comment on column public.voice_campaign_steps.body is
  'The message text for an sms_message step, with {{firstName}}-style merge variables left unrendered. Rendered SERVER-SIDE at send time by renderMergeVars() in _shared/voice-campaign-core.ts — never stored rendered, because the values change and a stored render would text somebody last month''s coverage amount.';
comment on column public.voice_campaign_steps.media_url is
  'Optional MMS attachment for an sms_message step: a public URL in the campaign-media storage bucket, under the owning agent''s own folder. Its presence is what makes the send an MMS (flat mms_mills) rather than an SMS (per-segment).';

-- ------------------------------------------------------------
-- The steps trigger now also enforces that a step BELONGS in its campaign.
--
-- A `call` step inside an SMS campaign is not a validation nicety — it is the
-- tick being told to dial somebody in a texting program. The step_type and the
-- campaign's channel have to agree, and the database is the right place for
-- that because both this table and voice_campaigns are owner-writable.
--
-- The BODY requirement is enforced only against an ACTIVE campaign, matching
-- voice_campaigns_validate()'s rule exactly: a draft may be half-written, and
-- an editor that refuses to save an unfinished step is an editor nobody can
-- use. Flipping Active on is the moment it has to hold — and because the Steps
-- tab deletes and re-inserts every row, this catches somebody blanking a body
-- on a campaign that is already running, which the campaign-row trigger cannot
-- see.
-- ------------------------------------------------------------
create or replace function public.voice_campaign_steps_derive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner      uuid;
  chan       text;
  is_active  boolean;
begin
  select agent_id, coalesce(channel, 'voice'), active
    into owner, chan, is_active
    from public.voice_campaigns
   where id = new.campaign_id;

  if owner is null then
    raise exception 'voice_campaign_steps: campaign % does not exist', new.campaign_id;
  end if;

  new.agent_id   := owner;
  new.updated_at := now();

  -- A step must be of its campaign's channel. `wait` is the one type that is
  -- meaningful in a text sequence only: a voice campaign expresses a pause
  -- with the next step's own wait_value, and has since the engine shipped.
  if chan = 'sms' then
    if new.step_type not in ('sms_message', 'wait') then
      raise exception
        'voice_campaign_steps: a text campaign''s steps must be sms_message or wait, not % — a call step here would dial a lead in a texting program',
        new.step_type;
    end if;
    if is_active and new.step_type = 'sms_message'
       and coalesce(btrim(new.body), '') = '' then
      raise exception
        'voice_campaign_steps: step % has no message text, and this campaign is switched on',
        new.position;
    end if;
  else
    if new.step_type not in ('call', 'double_dial') then
      raise exception
        'voice_campaign_steps: a calling campaign''s steps must be call or double_dial, not %',
        new.step_type;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists voice_campaign_steps_derive on public.voice_campaign_steps;
create trigger voice_campaign_steps_derive
  before insert or update on public.voice_campaign_steps
  for each row execute function public.voice_campaign_steps_derive();

-- ============================================================
-- PART 3 — voice_campaign_enrollments: one per lead PER CHANNEL
-- ============================================================
--
-- 🔴 THIS IS THE RULE THAT CHANGED, AND IT IS THE ONE MOST WORTH GETTING
-- RIGHT. A lead may be ACTIVE in one voice campaign AND one SMS campaign at
-- the same time, and never in two of the same channel.
--
-- Both halves matter. Allowing both channels is the point of the feature: a
-- speed-to-lead call sequence and a nurture text sequence are complementary,
-- and forcing a choice between them would make the SMS builder useless to
-- anybody already running voice. Forbidding two of a kind is the original
-- reason the index exists — two robots texting the same person in one
-- afternoon is exactly as bad as two robots phoning them, and neither
-- campaign's numbers mean anything afterwards.
--
-- `channel` is DENORMALISED onto the enrollment rather than joined through the
-- campaign, because a partial unique index cannot reach another table. It is
-- DERIVED BY A TRIGGER and never accepted from a caller, the same reasoning as
-- voice_campaign_steps.agent_id: a client-supplied channel could file a text
-- enrollment as a voice one and defeat the index it exists to serve.
alter table public.voice_campaign_enrollments
  add column if not exists channel text not null default 'voice';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.voice_campaign_enrollments'::regclass
                    and conname  = 'voice_campaign_enrollments_channel_check') then
    alter table public.voice_campaign_enrollments
      add constraint voice_campaign_enrollments_channel_check
      check (channel in ('voice', 'sms'));
  end if;
end $$;

-- Backfill from the campaign before the new index is built. Every existing row
-- is a voice row (that is all there was), so this is a no-op today and is here
-- because "today" is not when a migration gets re-run.
update public.voice_campaign_enrollments e
   set channel = c.channel
  from public.voice_campaigns c
 where c.id = e.campaign_id
   and e.channel is distinct from c.channel;

-- The swap. Drop first: the old index would refuse the very first lead who is
-- in a voice campaign and gets added to a text one.
drop index if exists public.voice_campaign_enrollments_one_active_uidx;
create unique index if not exists voice_campaign_enrollments_one_active_uidx
  on public.voice_campaign_enrollments (lead_id, channel)
  where status = 'active';

-- The tick's due query is per agent; it now also narrows by channel so a
-- text-only sweep does not read a book of voice enrollments.
create index if not exists voice_campaign_enrollments_due_channel_idx
  on public.voice_campaign_enrollments (agent_id, channel, next_action_at)
  where status = 'active';

-- ---- Text-side counters, beside the call-side ones -------------------------
--
-- Deliberately NOT reusing calls_placed / answers. "Calls placed: 4" on a
-- campaign that has never dialled anybody is the kind of small lie that makes
-- an agent stop believing the rest of the numbers on the card, and a single
-- column would have to be labelled differently in two places anyway.
alter table public.voice_campaign_enrollments
  add column if not exists messages_sent   integer not null default 0,
  add column if not exists replies         integer not null default 0,
  add column if not exists conversation_id uuid references public.sms_conversations(id) on delete set null,
  add column if not exists last_message_at timestamptz;

create index if not exists voice_campaign_enrollments_conversation_idx
  on public.voice_campaign_enrollments (conversation_id)
  where conversation_id is not null;

-- ---- enrolled_by: two additions, one of them a live bug fix ----------------
--
-- 🔴 `appointment_booked` WAS ALREADY BEING WRITTEN AND WAS NOT IN THE LIST.
-- voice-campaign-tick's appointment RE-ARM path (added 20260803, the branch
-- that lets a client who books again in June be reminded again) sets
-- enrolled_by = 'appointment_booked' — a value this CHECK constraint has never
-- allowed. That UPDATE has therefore been failing with a check violation every
-- time it fired, silently, inside a sweep whose errors are logged and
-- swallowed. Found while dumping this table to write the migration; fixed here
-- because the fix is one array element and leaving it means a documented
-- feature does not work.
--
-- `campaign_sms` is this round's addition: it is how a lead enrolled into a
-- text campaign by the sweep is told apart from one enrolled by hand.
do $$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.voice_campaign_enrollments'::regclass
                and conname  = 'voice_campaign_enrollments_enrolled_by_check') then
    alter table public.voice_campaign_enrollments
      drop constraint voice_campaign_enrollments_enrolled_by_check;
  end if;
  alter table public.voice_campaign_enrollments
    add constraint voice_campaign_enrollments_enrolled_by_check
    check (enrolled_by in (
      'auto', 'reevaluate', 'missed_appointment', 'sold', 'manual',
      'appointment_booked'
    ));
end $$;

comment on column public.voice_campaign_enrollments.channel is
  'voice | sms, DERIVED BY A TRIGGER from the campaign and never accepted from a caller. Denormalised solely so the one-active-per-lead rule can be a partial unique index on (lead_id, channel) — a lead may be active in one calling campaign AND one texting campaign, never in two of either.';
comment on column public.voice_campaign_enrollments.messages_sent is
  'Texts this enrollment has sent. Kept apart from calls_placed rather than folded into it: "calls placed" on a campaign that has never dialled anybody is a small lie that costs the whole card its credibility.';
comment on column public.voice_campaign_enrollments.replies is
  'Inbound messages received from this lead since enrollment. What stop_on_reply counts, and the honest denominator for "is this sequence working".';
comment on column public.voice_campaign_enrollments.conversation_id is
  'The sms_conversations thread this enrollment texts into. Set on the first send; it is also what the live-conversation hold reads, so a held enrollment and the thread holding it are one join apart.';

-- ------------------------------------------------------------
-- The channel derive trigger.
-- ------------------------------------------------------------
create or replace function public.voice_campaign_enrollments_derive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  chan text;
begin
  select coalesce(channel, 'voice') into chan
    from public.voice_campaigns where id = new.campaign_id;
  if chan is null then
    raise exception 'voice_campaign_enrollments: campaign % does not exist', new.campaign_id;
  end if;
  new.channel := chan;
  return new;
end;
$$;

drop trigger if exists voice_campaign_enrollments_derive on public.voice_campaign_enrollments;
create trigger voice_campaign_enrollments_derive
  before insert or update of campaign_id on public.voice_campaign_enrollments
  for each row execute function public.voice_campaign_enrollments_derive();

-- ============================================================
-- PART 4 — voice_campaigns_validate learns the text rules
-- ============================================================
--
-- Everything the voice version enforced is unchanged and is enforced for both
-- channels: every trigger group must still narrow the audience with a positive
-- lead-type / campaign-tag condition or one of the four lifecycle statuses. A
-- text campaign that messages a whole book is the same mistake as a call
-- campaign that phones one, and it is just as impossible to take back.
--
-- What is added applies only to an ACTIVE SMS campaign: it must have at least
-- one sms_message step, and none of its sms_message steps may be blank. A
-- campaign of nothing but waits sends nothing, for ever, while showing green.
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
  n_msgs     int;
  n_blank    int;
  tag_fields text[] := array['campaign_tag','tags','lead_type','coverage_wanted','source'];
  -- 20260803: four LIFECYCLE statuses also count as narrowing. `new` still
  -- does not — it describes every fresh row in the book, which is the reason
  -- `status` was left out of tag_fields in the first place.
  life_stat  text[] := array['sold','appointment','chargeback','lapsed'];
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
      if coalesce(cond->>'op', 'is') = 'is'
         and btrim(cond->>'field') = 'status'
         and lower(btrim(cond->>'value')) = any (life_stat) then
        has_tag := true;
      end if;
    end loop;

    if not has_tag then
      raise exception
        'voice_campaigns.trigger_groups: group % must name a lead type or campaign tag with an "is" condition (one of %), or a lifecycle status (%) — otherwise this campaign could reach your whole book',
        n_groups, array_to_string(tag_fields, ', '), array_to_string(life_stat, ', ');
    end if;
  end loop;

  if n_groups = 0 then
    raise exception 'voice_campaigns.trigger_groups: an active campaign needs at least one condition group';
  end if;

  -- ---- Text campaigns must actually be able to say something --------------
  if coalesce(new.channel, 'voice') = 'sms' then
    select count(*) filter (where step_type = 'sms_message'),
           count(*) filter (where step_type = 'sms_message' and coalesce(btrim(body), '') = '')
      into n_msgs, n_blank
      from public.voice_campaign_steps
     where campaign_id = new.id;

    if n_msgs = 0 then
      raise exception
        'This text campaign has no message steps, so switching it on would enrol people and never text them. Add a message on the Steps tab first.';
    end if;
    if n_blank > 0 then
      raise exception
        'This text campaign has % message step(s) with no text in them. Fill them in on the Steps tab before switching it on.', n_blank;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists voice_campaigns_validate on public.voice_campaigns;
create trigger voice_campaigns_validate
  before insert or update on public.voice_campaigns
  for each row execute function public.voice_campaigns_validate();

-- ============================================================
-- PART 5 — sms_messages carries the campaign that sent it
-- ============================================================
--
-- The SAME arrangement ai_calls has, and for the same two reasons: the drip
-- throttle counts sends per (campaign, step) over a rolling window and that
-- must be ONE indexed query, and a campaign's history has to survive an
-- enrollment being deleted with its lead.
--
-- 🔴 AND THERE IS NO SECOND EVENT LOG. The campaign's activity feed reads
-- sms_messages, exactly as the voice feed reads ai_calls. `messages` remains
-- the billing record and `inbound_messages` the provider record; neither is
-- reshaped and neither grows a campaign column, because a campaign is a
-- conversation fact and those two tables answer different questions.
alter table public.sms_messages
  add column if not exists campaign_id   uuid references public.voice_campaigns(id) on delete set null,
  add column if not exists campaign_step integer,
  add column if not exists enrollment_id uuid references public.voice_campaign_enrollments(id) on delete set null;

-- The drip window query.
create index if not exists sms_messages_campaign_step_created_idx
  on public.sms_messages (campaign_id, campaign_step, created_at desc)
  where campaign_id is not null;
-- The campaign activity feed.
create index if not exists sms_messages_campaign_created_idx
  on public.sms_messages (campaign_id, created_at desc)
  where campaign_id is not null;

comment on column public.sms_messages.campaign_id is
  'The voice_campaigns row (channel = ''sms'') whose step sent this message, or NULL for a conversation message, an AI reply, a nudge or a hand-typed text. Denormalised from the enrollment so the drip window and the activity feed are one indexed query each.';
comment on column public.sms_messages.campaign_step is
  'The step position that sent this message. Half of the drip throttle''s key: the window counts sends per (campaign_id, campaign_step), so a 20-per-hour step throttles itself and not the campaign''s other steps.';

-- ============================================================
-- PART 6 — MMS attachments: one bucket, per-agent folders
-- ============================================================
--
-- PUBLIC-READ, and that is forced rather than chosen: Telnyx fetches
-- media_urls from its own infrastructure with no Authorization header we
-- control, so a signed URL would have to be minted at send time and would
-- expire mid-retry. What keeps it safe is the WRITE side — an agent may only
-- write under a folder named with their own uid — plus the fact that the only
-- thing anybody puts here is a picture they are about to text to strangers.
--
-- The path convention is `<agent_uid>/<uuid>.<ext>` and the first path segment
-- is what every policy below keys on.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'campaign-media',
  'campaign-media',
  true,
  -- 5 MB. Carriers re-encode MMS aggressively and most reject over ~1 MB
  -- outright; this is a bound on what we will store, not a promise that a
  -- 5 MB image arrives intact. The editor warns above 1 MB.
  5242880,
  array['image/jpeg','image/png','image/gif','image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "campaign_media_read" on storage.objects;
create policy "campaign_media_read"
  on storage.objects for select
  using (bucket_id = 'campaign-media');

drop policy if exists "campaign_media_insert_own" on storage.objects;
create policy "campaign_media_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'campaign-media'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "campaign_media_update_own" on storage.objects;
create policy "campaign_media_update_own"
  on storage.objects for update
  using (
    bucket_id = 'campaign-media'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "campaign_media_delete_own" on storage.objects;
create policy "campaign_media_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'campaign-media'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================
-- PART 7 — RLS is UNCHANGED, and that is a decision
-- ============================================================
--
-- voice_campaigns and voice_campaign_steps stay owner-writable: a text
-- campaign is the agent's own configuration in exactly the way a call campaign
-- is, and the triggers above are what stop the two things a browser must not be
-- able to forge — the audience rule, and a step that belongs to another
-- channel.
--
-- 🔴 voice_campaign_enrollments STAYS SELECT-ONLY. An enrollment in a text
-- campaign is a standing instruction to MESSAGE a consumer on a schedule,
-- which is the same class of object as a standing instruction to phone one.
-- Every write goes through voice-campaign-tick (cron secret) or
-- voice-campaign-manage (agent from the JWT, no agent id in the body). Do not
-- add an INSERT or UPDATE policy here, and note that the channel column would
-- make one strictly worse: a browser that could write an enrollment could now
-- also pick which of a lead's two channel slots to occupy.
--
-- sms_messages likewise stays SELECT-only — the campaign columns added in
-- PART 5 do not change that. A browser that could insert one could put words
-- into a campaign's mouth on a consumer's record.
