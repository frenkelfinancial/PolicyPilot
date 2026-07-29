-- ============================================================
-- 20260729_compliance_pages.sql
-- PROMPT_16 Phase 2 — per-agent public compliance pages.
--
-- HOW TO APPLY (this project applies schema BY MANUAL PASTE, never db push —
-- same as 20260728_a2p_sole_proprietor.sql):
--   1. Supabase Dashboard -> SQL Editor for project cweiaibjigjwspmshcrj.
--   2. Paste this whole file and Run. It is idempotent — safe to re-run.
--   PREREQUISITES: data/sql/001_agents_profile.sql (public.agents,
--   touch_updated_at) and data/sql/019_messaging_compliance.sql
--   (a2p_registrations — needed by the slug lock). Both are guarded below:
--   on a fresh DB the dependent block is skipped with a NOTICE instead of
--   failing, matching the fresh-database-safe pattern in 20260728.
--
-- WHAT THIS IS FOR
-- 10DLC brand + campaign registration requires a publicly reachable privacy
-- policy and terms page belonging to the business that sends the messages.
-- Our agents are producers, not marketers — most have no consumer-facing
-- site, and the lead vendor's policy describes the vendor, not the agency.
-- So we generate the page. This migration is the data half; the renderer is
-- the `compliance-page` edge function.
--
-- ------------------------------------------------------------------
-- SCOPE NOTE — BUSINESS PROFILE COLUMNS ARE NEW HERE, BY NECESSITY
-- ------------------------------------------------------------------
-- PROMPT_16 Phase 2 assumed the agency's name/address/phone already lived
-- somewhere. They did not. Before this migration the ONLY copy of that data
-- was a2p_registrations.business_info (jsonb), written by a2p-register from
-- its REQUEST BODY — and nothing in the app ever populated it.
--
-- The page cannot source its data from a2p_registrations, because A2P
-- registration is now gated on the page already existing (a2p-register
-- returns compliance_page_missing). That is circular. So the business
-- profile lands on public.agents, which is where an agent-owned fact
-- belongs, and a2p-register reads the SAME columns instead of trusting
-- client-supplied JSON. Section 1 below is that addition.
--
-- ------------------------------------------------------------------
-- THREE INVARIANTS THIS FILE ENFORCES IN THE DATABASE, NOT IN APP CODE
-- ------------------------------------------------------------------
--   1. SLUG LOCK (section 6). Once a2p_registrations.status has advanced
--      past 'not_started', the slug is frozen. An approved campaign points
--      at a literal URL; changing it silently breaks the registration and
--      the agent's texting stops working with no error anywhere. Enforced
--      as a RAISE, so a stray UPDATE from any client — app, SQL editor,
--      future edge function — fails loudly instead of succeeding quietly.
--   2. NO UNPUBLISHING (section 5). If required fields are later cleared,
--      the page stays up. A carrier reviewer following an approved
--      campaign's link must never hit a 404 because someone blanked their
--      phone number in Settings.
--   3. CLIENT CANNOT WRITE THE SLUG (section 4). compliance_slug and
--      compliance_page_published_at are derived, not user input. Same
--      threat model as 20260703c_agents_column_protection.sql: they sit on
--      a row the user already owns, so RLS alone does not protect them.
-- ============================================================


-- ------------------------------------------------------------
-- 1. agents — business profile + compliance page state.
--
-- Nullable by design: an agent exists from signup, the profile is filled in
-- afterward, and the page publishes itself the moment it is complete
-- (section 5). No column here is required for any pre-existing feature.
-- ------------------------------------------------------------
alter table public.agents
  add column if not exists dba_name                     text,
  add column if not exists business_legal_name          text,
  add column if not exists business_entity_type         text,
  add column if not exists formation_state              text,
  add column if not exists business_street              text,
  add column if not exists business_city                text,
  add column if not exists business_state               text,
  add column if not exists business_postal_code         text,
  add column if not exists business_phone               text,
  add column if not exists business_email               text,
  add column if not exists lead_vendors                 text[] not null default '{}',
  add column if not exists compliance_slug              text,
  add column if not exists compliance_page_published_at timestamptz;

comment on column public.agents.dba_name is
  'Public-facing agency name — the HEADLINE of the generated compliance pages and the name a consumer sees in a text. May differ from the registered legal entity name (business_legal_name), and is the only name a sole proprietor has.';
comment on column public.agents.business_legal_name is
  'Registered legal entity name as filed with the state, e.g. "Frenkel Financial LLC". NULL for a sole proprietor with no entity — do not backfill it with the agent''s personal name, because the renderer uses its presence to decide whether to print entity language.';
comment on column public.agents.business_entity_type is
  'Legal form, used ONLY to render entity language ("a Wisconsin limited liability company") on the terms page. Distinct from the Telnyx 10DLC entityType enum, which a2p-register derives from this — see _shared/a2p-business-profile.ts.';
comment on column public.agents.formation_state is
  'Two-letter state where the entity was formed. Drives entity language. Governing law uses business_state (where the agent actually operates), falling back to this.';
comment on column public.agents.business_phone is
  'Public business phone in E.164, printed in the contact block of both pages. This is the number a consumer calls to reach a human — NOT necessarily the agent''s texting DID.';
comment on column public.agents.business_email is
  'Public business email, printed in the contact block. Must be a real monitored mailbox: carrier reviewers and consumers both use it.';
comment on column public.agents.lead_vendors is
  'Lead SOURCE CATEGORY keys from LEAD_SOURCE_CATEGORIES in _shared/lead-vendors.ts: {lead_partners,own_forms,referrals}. Drives the privacy policy''s "Where your information comes from" section, which describes sources by TYPE and names no company. Unknown keys are dropped by resolveLeadSourceLabels(), so legacy values (the old vendor names, and the withdrawn "other:<name>" free-text path) render the generic sentence rather than a stale company name. The campaign opt-in description reads this column not at all — naming a lead company in a carrier-facing document is what produced review item 1 on campaign CD2166Q. Column name kept for compatibility; it no longer holds vendors.';
comment on column public.agents.compliance_slug is
  'URL segment for the agent''s public pages: /a/<slug>, /a/<slug>/privacy-policy, /a/<slug>/terms. Derived, never user-entered (see agents_protect_compliance_columns) and FROZEN once A2P registration starts (see agents_lock_compliance_slug).';
comment on column public.agents.compliance_page_published_at is
  'When the page first went live. NULL = not published, and a2p-register refuses to submit (error compliance_page_missing). Never cleared once set — see agents_sync_compliance_page.';

-- Slug uniqueness. Partial index: many agents legitimately have NULL until
-- their profile is complete, and NULLs must not collide with each other.
create unique index if not exists agents_compliance_slug_key
  on public.agents (compliance_slug)
  where compliance_slug is not null;

-- Entity type is a closed set — the renderer switches on it.
do $$
begin
  alter table public.agents drop constraint if exists agents_business_entity_type_check;
  alter table public.agents add constraint agents_business_entity_type_check
    check (business_entity_type is null or business_entity_type in
      ('llc','corporation','s_corporation','partnership','sole_proprietor'));
end $$;


-- ------------------------------------------------------------
-- 2. compliance_page_revisions — append-only audit trail.
--
-- WHY: an approved campaign points at a URL. If the agent later edits their
-- address, the page changes underneath an approved registration. We do not
-- block that (a real address change must be reflected), but we keep a
-- record of exactly what the page said and when, so a carrier dispute can
-- be answered with evidence instead of a guess.
--
-- agent_id references auth.users, not agents: agents_sync_compliance_page
-- is a BEFORE INSERT trigger on agents, so the agents row does not exist yet
-- when the first revision is written. auth.users always does. This matches
-- consent_records / dnc_list in 019_messaging_compliance.sql.
-- ------------------------------------------------------------
create table if not exists public.compliance_page_revisions (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references auth.users(id) on delete cascade,
  rendered_at timestamptz not null default now(),
  inputs      jsonb not null,
  reason      text
);

comment on table public.compliance_page_revisions is
  'Append-only snapshot of every field used to render an agent''s compliance pages, one row per material change. Never updated, never deleted. The newest row''s rendered_at is the "Last updated" date shown on the live page.';
comment on column public.compliance_page_revisions.inputs is
  'Full snapshot of the rendering inputs at this revision (names, address, phone, email, entity, vendors, slug). Compared against the incoming values to decide whether a change is material — an UPDATE that touches unrelated agent columns writes no revision.';
comment on column public.compliance_page_revisions.reason is
  'initial_publish | profile_updated | manual — why this revision exists.';

create index if not exists compliance_page_revisions_agent_idx
  on public.compliance_page_revisions (agent_id, rendered_at desc);

alter table public.compliance_page_revisions enable row level security;

-- Agents read their own history; nobody but the service role (and the
-- SECURITY DEFINER trigger below) writes. Same shape as wallet_ledger in
-- 20260709b_wallet_foundation.sql: select-own + select-admin, no client
-- insert/update/delete policy at all.
drop policy if exists "compliance_page_revisions_select_own" on public.compliance_page_revisions;
create policy "compliance_page_revisions_select_own"
  on public.compliance_page_revisions for select
  using (auth.uid() = agent_id);

do $$
begin
  if to_regprocedure('public.is_admin_agent()') is not null then
    drop policy if exists "compliance_page_revisions_select_admin" on public.compliance_page_revisions;
    create policy "compliance_page_revisions_select_admin"
      on public.compliance_page_revisions for select
      using (public.is_admin_agent());
  else
    raise notice '[20260729] public.is_admin_agent() missing (apply data/sql/007_signalwire.sql) — skipping the admin select policy.';
  end if;
end $$;


-- ------------------------------------------------------------
-- 3. Slug derivation.
--
-- MUST STAY IN LOCKSTEP with slugifyAgencyName() in
-- supabase/functions/_shared/compliance-page.ts. The TS version is what the
-- Settings UI previews; this one is what actually gets stored. If they
-- disagree, an agent sees one URL and registers another.
--
-- Accent folding is done with translate() rather than the unaccent
-- extension on purpose: unaccent needs CREATE EXTENSION (and lives in the
-- extensions schema on Supabase), which would make this migration fail on a
-- database where it is unavailable. translate() covers the Latin-1 range
-- that real agency names actually contain and needs nothing installed.
-- ------------------------------------------------------------
create or replace function public.compliance_slugify(p_name text)
returns text
language plpgsql
immutable
as $$
declare
  s text;
begin
  s := lower(coalesce(p_name, ''));

  -- Fold accented Latin letters to their base form (mirrors the TS
  -- normalize("NFD") + strip-combining-marks step).
  s := translate(
    s,
    'àáâãäåèéêëìíîïòóôõöùúûüýÿñçšž',
    'aaaaaaeeeeiiiiooooouuuuyyncsz'
  );

  -- Letters NFD does NOT decompose, so the TS side handles them explicitly
  -- too. Multi-character expansions cannot go through translate().
  s := replace(s, 'ø', 'o');
  s := replace(s, 'đ', 'd');
  s := replace(s, 'ð', 'd');
  s := replace(s, 'ł', 'l');
  s := replace(s, 'æ', 'ae');
  s := replace(s, 'œ', 'oe');
  s := replace(s, 'ß', 'ss');
  s := replace(s, 'þ', 'th');

  s := replace(s, '&', ' and ');                    -- "Smith & Sons" -> "smith and sons"
  s := translate(s, chr(39) || chr(8217), '');      -- O'Brien / O’Brien -> obrien, not o-brien
  s := regexp_replace(s, '[^a-z0-9]+', '-', 'g');
  s := regexp_replace(s, '-+', '-', 'g');
  s := regexp_replace(s, '^-|-$', '', 'g');
  s := left(s, 60);
  s := regexp_replace(s, '-+$', '');          -- re-trim after the length cut

  return s;
end;
$$;

comment on function public.compliance_slugify(text) is
  'Agency name -> URL slug. Mirrors slugifyAgencyName() in _shared/compliance-page.ts — change both together. Returns '''' when the name has no usable characters; callers must fall back.';

-- Allocate a slug that is unique across agents, appending -2, -3, ... on
-- collision. Two agents named "Smith Insurance" both get a working URL.
create or replace function public.compliance_slug_reserve(p_agent uuid, p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_slug text;
  v_sfx  text;
  n      int := 1;
begin
  v_base := public.compliance_slugify(p_name);

  -- A name of pure punctuation or non-Latin script slugifies to ''. Fall
  -- back to something stable and valid rather than failing the agent's save.
  if coalesce(v_base, '') = '' then
    v_base := 'agent-' || left(replace(p_agent::text, '-', ''), 8);
  end if;

  v_slug := v_base;

  while exists (
    select 1 from public.agents a
     where a.compliance_slug = v_slug
       and a.id is distinct from p_agent
  ) loop
    n := n + 1;
    if n > 500 then
      raise exception 'compliance_slug_reserve: could not allocate a unique slug from % after % attempts', p_name, n
        using errcode = '55000';
    end if;
    v_sfx  := '-' || n::text;
    -- Keep the total within the 60-char budget, then re-trim so a cut on a
    -- word boundary cannot produce "...agency--2".
    v_slug := regexp_replace(left(v_base, 60 - length(v_sfx)), '-+$', '') || v_sfx;
  end loop;

  return v_slug;
end;
$$;

comment on function public.compliance_slug_reserve(uuid, text) is
  'Allocate a collision-free compliance slug for one agent (-2, -3, ... on collision). Concurrent first-time publishes for identically-named agencies can still race; the unique index agents_compliance_slug_key is the backstop and the loser''s transaction errors rather than silently sharing a URL.';


-- ------------------------------------------------------------
-- 4. Client cannot write derived compliance columns.
--
-- Same threat model as 20260703c_agents_column_protection.sql: these live
-- on a row the user already owns, so agents_update_own permits writing them
-- and RLS offers no protection. A user who could set their own slug could
-- take a slug that another agent has already registered with a carrier.
--
-- This is a SEPARATE trigger rather than an edit to
-- agents_protect_privileged_columns(), so that re-pasting 20260703c (which
-- recreates that function from its own definition) cannot silently drop
-- this protection.
--
-- Trigger firing order is alphabetical for same-timing triggers, which is
-- also the order these need to run in:
--   agents_lock_compliance_slug     (reject an illegal slug change)
--   agents_protect_compliance_columns (revert client writes to derived cols)
--   agents_protect_privileged_columns (existing, unchanged)
--   agents_sync_compliance_page     (derive + publish)
--   agents_touch_updated_at         (existing, unchanged)
-- ------------------------------------------------------------
create or replace function public.agents_protect_compliance_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only end-user requests arriving through PostgREST. service_role edge
  -- functions, SQL Editor sessions, and migrations are trusted — identical
  -- carve-out to agents_protect_privileged_columns().
  if auth.role() is distinct from 'authenticated' and auth.role() is distinct from 'anon' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- agents_insert_own permits a client INSERT (auth.uid() = id). Normally
    -- handle_new_user() has already created the row so such an insert just
    -- conflicts — but "normally" is not a security boundary. Blank the
    -- derived columns; agents_sync_compliance_page assigns them afterward.
    new.compliance_slug              := null;
    new.compliance_page_published_at := null;
  else
    new.compliance_slug              := old.compliance_slug;
    new.compliance_page_published_at := old.compliance_page_published_at;
  end if;

  return new;
end;
$$;

drop trigger if exists agents_protect_compliance_columns on public.agents;
create trigger agents_protect_compliance_columns
  before insert or update on public.agents
  for each row execute function public.agents_protect_compliance_columns();


-- ------------------------------------------------------------
-- 5. Auto-generate / regenerate the page.
--
-- Generation is a database trigger, not an edge-function call, so it cannot
-- be skipped: it fires no matter which path writes the agent row (Settings
-- form, an edge function, a support fix applied by hand in the SQL editor).
-- PROMPT_16's requirement is that the agent never has to request the page —
-- a trigger is the only place that is actually true.
--
-- Note "generation" here means allocating the slug, marking the page
-- published, and snapshotting the inputs. The HTML itself is rendered live
-- from the agents row on every request by the compliance-page function, so
-- there is nothing stale to regenerate and no per-agent file to deploy.
-- ------------------------------------------------------------
create or replace function public.agents_sync_compliance_page()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text;
  v_missing boolean;
  v_inputs  jsonb;
  v_prev    jsonb;
  v_reason  text;
begin
  -- Public-facing name: DBA first, legal name as fallback. A sole
  -- proprietor has only the former.
  v_name := coalesce(nullif(btrim(new.dba_name), ''), nullif(btrim(new.business_legal_name), ''));

  v_missing := v_name is null
    or nullif(btrim(new.business_street), '')      is null
    or nullif(btrim(new.business_city), '')        is null
    or nullif(btrim(new.business_state), '')       is null
    or nullif(btrim(new.business_postal_code), '') is null
    or nullif(btrim(new.business_phone), '')       is null
    or nullif(btrim(new.business_email), '')       is null;

  if v_missing then
    -- Not enough to publish. Crucially this does NOT unpublish: an already
    -- live page stays live even if a field is later blanked, because an
    -- approved campaign's compliance link must never start 404ing. The
    -- Settings panel surfaces exactly which field is missing.
    return new;
  end if;

  if new.compliance_slug is null then
    new.compliance_slug := public.compliance_slug_reserve(new.id, v_name);
  end if;

  -- Everything the renderer reads. Compared against the last revision so an
  -- unrelated UPDATE (monthly_goal, dialer_pin, ...) writes no revision row.
  v_inputs := jsonb_build_object(
    'dba_name',             new.dba_name,
    'business_legal_name',  new.business_legal_name,
    'business_entity_type', new.business_entity_type,
    'formation_state',      new.formation_state,
    'business_street',      new.business_street,
    'business_city',        new.business_city,
    'business_state',       new.business_state,
    'business_postal_code', new.business_postal_code,
    'business_phone',       new.business_phone,
    'business_email',       new.business_email,
    'lead_vendors',         to_jsonb(coalesce(new.lead_vendors, '{}'::text[])),
    'compliance_slug',      new.compliance_slug
  );

  select r.inputs into v_prev
    from public.compliance_page_revisions r
   where r.agent_id = new.id
   order by r.rendered_at desc, r.id desc
   limit 1;

  if v_prev is null or v_prev is distinct from v_inputs then
    if new.compliance_page_published_at is null then
      new.compliance_page_published_at := now();
      v_reason := 'initial_publish';
    else
      v_reason := 'profile_updated';
    end if;

    insert into public.compliance_page_revisions (agent_id, inputs, reason)
    values (new.id, v_inputs, v_reason);
  end if;

  return new;
end;
$$;

drop trigger if exists agents_sync_compliance_page on public.agents;
create trigger agents_sync_compliance_page
  before insert or update on public.agents
  for each row execute function public.agents_sync_compliance_page();


-- ------------------------------------------------------------
-- 6. Slug lock — the invariant that protects live registrations.
--
-- Once A2P registration has started, the slug is the URL a carrier has on
-- file. Changing it does not error anywhere else in the stack: the old URL
-- 404s, the campaign's compliance link dangles, and the failure surfaces
-- weeks later as unexplained message blocking. So it fails here, loudly.
--
-- The a2p_registrations dependency is guarded INSIDE the function with a
-- runtime to_regclass() check rather than by wrapping the CREATE in a DO
-- block. plpgsql plans each statement lazily on first execution, so the
-- early return means the query against a2p_registrations is never planned
-- on a database where 019 has not been pasted yet — the function installs
-- and behaves correctly either way.
-- ------------------------------------------------------------
create or replace function public.agents_lock_compliance_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  -- Only an actual change to an already-assigned slug is interesting.
  if old.compliance_slug is null
     or new.compliance_slug is not distinct from old.compliance_slug then
    return new;
  end if;

  -- Fresh database without 019 applied: nothing to lock against yet.
  if to_regclass('public.a2p_registrations') is null then
    return new;
  end if;

  select r.status into v_status
    from public.a2p_registrations r
   where r.agent_id = old.id
   limit 1;

  if v_status is not null and v_status <> 'not_started' then
    raise exception
      'compliance_slug is locked for agent % (A2P registration status: %). The registered compliance URL /a/% cannot change without breaking the approved campaign.',
      old.id, v_status, old.compliance_slug
      using errcode = '23514',
            hint    = 'Slugs are immutable once A2P registration starts. If the agency genuinely renamed, that needs a new brand/campaign registration, not a slug edit.',
            detail  = 'Attempted new slug: ' || coalesce(new.compliance_slug, '<null>');
  end if;

  return new;
end;
$$;

drop trigger if exists agents_lock_compliance_slug on public.agents;
create trigger agents_lock_compliance_slug
  before update on public.agents
  for each row execute function public.agents_lock_compliance_slug();


-- ------------------------------------------------------------
-- 7. Backfill — publish a page for every agent whose profile is already
--    complete. A no-op today (these columns are new, so every value is
--    NULL), but it makes the file correct to re-run after a data import.
--    The no-op UPDATE fires agents_sync_compliance_page, which does the work.
-- ------------------------------------------------------------
update public.agents
   set updated_at = updated_at
 where compliance_page_published_at is null
   and coalesce(nullif(btrim(dba_name), ''), nullif(btrim(business_legal_name), '')) is not null
   and nullif(btrim(business_street), '')      is not null
   and nullif(btrim(business_city), '')        is not null
   and nullif(btrim(business_state), '')       is not null
   and nullif(btrim(business_postal_code), '') is not null
   and nullif(btrim(business_phone), '')       is not null
   and nullif(btrim(business_email), '')       is not null;


-- ------------------------------------------------------------
-- Verify after running:
--
--   -- columns landed
--   select column_name from information_schema.columns
--    where table_name = 'agents'
--      and column_name in ('dba_name','business_legal_name','business_street',
--                          'lead_vendors','compliance_slug','compliance_page_published_at');
--
--   -- slug derivation matches the TS renderer
--   select public.compliance_slugify('O''Brien & Sons "Insurance" Café');
--   --> obrien-and-sons-insurance-cafe
--
--   -- triggers present, in firing order
--   select tgname from pg_trigger
--    where tgrelid = 'public.agents'::regclass and not tgisinternal
--    order by tgname;
--   --> agents_lock_compliance_slug, agents_protect_compliance_columns,
--       agents_protect_privileged_columns, agents_sync_compliance_page,
--       agents_touch_updated_at
--
--   -- end-to-end: fill a profile, confirm the page publishes itself
--   update public.agents set
--     dba_name='Test Agency', business_street='1 Main St', business_city='Milwaukee',
--     business_state='WI', business_postal_code='53202',
--     business_phone='+14145551234', business_email='test@example.com'
--   where id = '<agent-uuid>';
--
--   select compliance_slug, compliance_page_published_at from public.agents where id = '<agent-uuid>';
--   select reason, rendered_at from public.compliance_page_revisions
--    where agent_id = '<agent-uuid>' order by rendered_at desc;
-- ------------------------------------------------------------
