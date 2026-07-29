-- ============================================================
-- Back Office, Phase 2 — producer codes and retroactive attribution.
--
-- A carrier statement identifies the writing agent by a code, not by a name:
-- an NPN, or a per-carrier writing number. Phase 1 already captures whatever
-- code a statement line carries (`commission_rows.producer_code`) and leaves
-- `attributed_agent_id` null. This migration is the other half — the table
-- that says which code belongs to whom, and the reconcile that stamps it onto
-- rows that were ingested BEFORE the code was ever recorded.
--
-- The retroactivity is the point. An agent uploads six months of statements,
-- then types in their writing number, and the six months attribute themselves.
-- A version of this feature that only works going forward is not worth having.
--
-- Three objects:
--   1. public.producer_codes          — the codes, owner-writable
--   2. public.pc_normalize_code()     — the one definition of "same code"
--   3. public.apply_producer_codes()  — the reconcile, anchored on auth.uid()
--   + public.get_producer_code_coverage() — what the screen needs to be honest
--
-- NOT here on purpose: any way to attribute a row to an agent the caller is
-- not connected to. `subject_agent_id` is guarded by a trigger to self or an
-- ACCEPTED downline, because "protect the column, not only the function that
-- sets it" is a lesson this schema has now learned three times
-- (20260703c, 20260730, 20260736).
-- ============================================================


-- ------------------------------------------------------------
-- 1. pc_normalize_code — the single definition of "the same code".
--
-- Carriers print the same writing number as `QA-777`, `QA 777` and `qa777`.
-- Everything (the unique index, the reconcile, the coverage count, and the
-- browser) compares on this and only this.
-- ------------------------------------------------------------
create or replace function public.pc_normalize_code(p text)
returns text
language sql
immutable
parallel safe
as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

comment on function public.pc_normalize_code(text) is
  'Uppercase alphanumerics only. The one definition of code equality — mirrored by pcNormalizeCode() in app.html.';


-- ------------------------------------------------------------
-- 2. producer_codes
--
-- `agent_id` is the TENANT — whose book this record lives in, and what RLS
-- keys on. `subject_agent_id` is who the code identifies. For a solo agent
-- they are the same id; on an agency owner's consolidated statement they
-- differ, which is exactly why they are two columns.
--
-- `carrier` NULL means "applies to every carrier" — an NPN, or a single
-- agency-wide code. A carrier-specific row always wins over a NULL one during
-- the reconcile.
--
-- Unlike the Phase 1 commission tables, this one IS owner-writable. It holds
-- the agent's own identifiers, not money — the same posture as `policies` and
-- `leads`. The privileged column here is `subject_agent_id`, and it has its
-- own trigger below rather than relying on the write path being polite.
-- ------------------------------------------------------------
create table if not exists public.producer_codes (
  id               uuid        primary key default gen_random_uuid(),
  agent_id         uuid        not null references auth.users(id) on delete cascade,
  subject_agent_id uuid        not null references auth.users(id) on delete cascade,
  carrier          text,
  code             text        not null,
  code_key         text        not null,
  kind             text        not null default 'writing_number',
  label            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.producer_codes is
  'NPNs and per-carrier writing numbers. agent_id is the tenant; subject_agent_id is the agent the code identifies (guarded to self or an accepted downline).';
comment on column public.producer_codes.carrier is
  'NULL means the code applies to every carrier (an NPN, or one agency-wide code). A carrier-specific row wins over a NULL one.';
comment on column public.producer_codes.code_key is
  'pc_normalize_code(code). Everything compares on this, never on the printed form.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'producer_codes_kind_check') then
    alter table public.producer_codes
      add constraint producer_codes_kind_check check (kind in ('npn', 'writing_number'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'producer_codes_code_not_blank') then
    alter table public.producer_codes
      add constraint producer_codes_code_not_blank check (code_key <> '');
  end if;
end $$;

-- `carrier_key` exists so the uniqueness rule can be expressed over plain
-- COLUMNS. `coalesce(carrier,'')` is what the rule actually means — NULL never
-- equals NULL in a unique index, so without it the same NPN could be recorded
-- unlimited times — but PostgREST's `on_conflict` can only name columns, not
-- an expression, and the agency bulk load needs to re-apply a sheet with one
-- new agent on it without the whole batch failing on the rows already there.
-- A generated column gets both.
alter table public.producer_codes
  add column if not exists carrier_key text generated always as (coalesce(carrier, '')) stored;

create unique index if not exists producer_codes_key_uidx
  on public.producer_codes (agent_id, carrier_key, code_key);

-- The original expression form of the same rule. Redundant with the index
-- above and kept only because removing it is a schema DROP that this build has
-- no need to take. If a later migration tidies it up, `producer_codes_key_uidx`
-- is the one that must survive: the bulk-load upsert names its columns.
create unique index if not exists producer_codes_uidx
  on public.producer_codes (agent_id, coalesce(carrier, ''), code_key);
create index if not exists producer_codes_lookup_idx
  on public.producer_codes (agent_id, code_key);
create index if not exists producer_codes_subject_idx
  on public.producer_codes (subject_agent_id);

alter table public.producer_codes enable row level security;

drop policy if exists producer_codes_select_own on public.producer_codes;
create policy producer_codes_select_own on public.producer_codes
  for select to authenticated using (agent_id = auth.uid());

drop policy if exists producer_codes_insert_own on public.producer_codes;
create policy producer_codes_insert_own on public.producer_codes
  for insert to authenticated with check (agent_id = auth.uid());

drop policy if exists producer_codes_update_own on public.producer_codes;
create policy producer_codes_update_own on public.producer_codes
  for update to authenticated using (agent_id = auth.uid()) with check (agent_id = auth.uid());

drop policy if exists producer_codes_delete_own on public.producer_codes;
create policy producer_codes_delete_own on public.producer_codes
  for delete to authenticated using (agent_id = auth.uid());

-- ---- code_key is derived, never supplied -------------------------------
-- A client that sends its own code_key could store `QA-777` under the key
-- `SOMETHINGELSE` and make the reconcile match the wrong rows. Derive it.
create or replace function public.producer_codes_derive_key()
returns trigger
language plpgsql
as $$
begin
  new.code := btrim(coalesce(new.code, ''));
  new.code_key := public.pc_normalize_code(new.code);
  new.carrier := nullif(btrim(coalesce(new.carrier, '')), '');
  return new;
end $$;

drop trigger if exists producer_codes_derive_key on public.producer_codes;
create trigger producer_codes_derive_key
  before insert or update on public.producer_codes
  for each row execute function public.producer_codes_derive_key();

-- ---- subject_agent_id is guarded, not trusted ---------------------------
-- Without this, a client could record a code claiming to belong to any user id
-- in the system. It would only ever re-label the caller's OWN commission rows
-- — nothing leaks to the named agent — but "it only corrupts your own numbers"
-- is not a guarantee worth shipping, and Phase 4's leader rollups will read
-- this column.
--
-- Trusted contexts (service_role, the SQL editor) keep the usual carve-out so
-- an admin backfill is still possible.
create or replace function public.producer_codes_guard_subject()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  connected boolean;
begin
  if auth.role() is distinct from 'authenticated' then
    return new;  -- service_role / SQL editor
  end if;

  if new.subject_agent_id = new.agent_id then
    return new;  -- your own code
  end if;

  select exists (
    select 1 from public.agency_invites ai
    where ai.status = 'accepted'
      and ((ai.leader_id = new.agent_id and ai.invitee_id = new.subject_agent_id)
        or (ai.invitee_id = new.agent_id and ai.leader_id = new.subject_agent_id))
  ) into connected;

  if not connected then
    raise exception 'producer code must belong to you or to an agent in your agency'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists producer_codes_guard_subject on public.producer_codes;
create trigger producer_codes_guard_subject
  before insert or update on public.producer_codes
  for each row execute function public.producer_codes_guard_subject();

drop trigger if exists producer_codes_touch_updated_at on public.producer_codes;
create trigger producer_codes_touch_updated_at
  before update on public.producer_codes
  for each row execute function public.touch_updated_at();


-- ------------------------------------------------------------
-- 3. apply_producer_codes() — the reconcile, and the retroactivity.
--
-- Runs over ALL of the caller's commission rows, not just new ones, so saving
-- a code attributes every statement already ingested under it. It is a full
-- reconcile rather than a one-way stamp: a row whose code no longer resolves
-- has its attribution CLEARED, so deleting a mistyped code undoes its effect
-- instead of leaving the wrong agent's name on six months of commission.
--
-- Attributions made any other way are never touched — only rows whose
-- `attribution_method` is 'producer_code' are cleared, so a future manual
-- correction (Phase 6) survives a re-run.
--
-- SECURITY DEFINER because `commission_rows` is deliberately SELECT-only for
-- `authenticated` (Phase 1) — the browser cannot update it, and it must not be
-- able to. There is deliberately NO PARAMETER naming an agent: the function is
-- anchored solely on auth.uid(), so there is nothing to point at somebody
-- else's book. Same shape, and the same reasoning, as get_team_summary.
-- ------------------------------------------------------------
create or replace function public.apply_producer_codes()
returns table (attributed bigint, cleared bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  n_attributed bigint := 0;
  n_cleared bigint := 0;
begin
  if me is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  -- Best match per row: a carrier-specific code beats a carrier-agnostic one.
  with resolved as (
    select distinct on (r.id)
      r.id            as row_id,
      pc.subject_agent_id
    from public.commission_rows r
    join public.producer_codes pc
      on pc.agent_id = me
     and pc.code_key = public.pc_normalize_code(r.producer_code)
     and (pc.carrier is null
          or public.pc_normalize_code(pc.carrier) = public.pc_normalize_code(r.carrier))
    where r.agent_id = me
      and coalesce(btrim(r.producer_code), '') <> ''
    order by r.id, (pc.carrier is null), pc.created_at desc
  ),
  applied as (
    update public.commission_rows r
       set attributed_agent_id = res.subject_agent_id,
           attribution_method  = 'producer_code'
      from resolved res
     where r.id = res.row_id
       and r.agent_id = me
       and (r.attributed_agent_id is distinct from res.subject_agent_id
            or r.attribution_method is distinct from 'producer_code')
       and coalesce(r.attribution_method, 'producer_code') = 'producer_code'
    returning 1
  )
  select count(*) into n_attributed from applied;

  -- Clear attributions this function made that no longer resolve.
  with stale as (
    update public.commission_rows r
       set attributed_agent_id = null,
           attribution_method  = null
     where r.agent_id = me
       and r.attribution_method = 'producer_code'
       and not exists (
         select 1 from public.producer_codes pc
         where pc.agent_id = me
           and pc.code_key = public.pc_normalize_code(r.producer_code)
           and (pc.carrier is null
                or public.pc_normalize_code(pc.carrier) = public.pc_normalize_code(r.carrier))
       )
    returning 1
  )
  select count(*) into n_cleared from stale;

  return query select n_attributed, n_cleared;
end $$;

revoke all on function public.apply_producer_codes() from public;
grant execute on function public.apply_producer_codes() to authenticated, service_role;


-- ------------------------------------------------------------
-- 4. get_producer_code_coverage() — what the screen needs to be honest.
--
-- "142 commission lines carry a writing number you have not recorded" is a
-- number an agent can act on. A screen that only lists the codes you already
-- typed in cannot tell you the one you are missing.
--
-- SECURITY INVOKER: it reads only through the caller's own RLS.
-- ------------------------------------------------------------
create or replace function public.get_producer_code_coverage()
returns table (
  producer_code text,
  code_key      text,
  carriers      text,
  row_count     bigint,
  total_cents   bigint,
  known         boolean
)
language sql
stable
set search_path = public
as $$
  -- Grouped first, then joined to the codes table. The `known` flag cannot be
  -- a correlated subquery inside the aggregate: it would reference an
  -- ungrouped column (42803), and the honest key to test against is the
  -- NORMALIZED code, which is what we grouped by.
  with seen as (
    select
      r.agent_id,
      public.pc_normalize_code(r.producer_code)           as code_key,
      min(r.producer_code)                                as producer_code,
      string_agg(distinct coalesce(r.carrier, '—'), ', ') as carriers,
      count(*)                                            as row_count,
      coalesce(sum(r.amount_cents), 0)::bigint            as total_cents
    from public.commission_rows r
    where coalesce(btrim(r.producer_code), '') <> ''
    group by r.agent_id, public.pc_normalize_code(r.producer_code)
  )
  select
    s.producer_code,
    s.code_key,
    s.carriers,
    s.row_count,
    s.total_cents,
    exists (
      select 1 from public.producer_codes pc
      where pc.agent_id = s.agent_id and pc.code_key = s.code_key
    ) as known
  from seen s
  order by 6 asc, 4 desc;
$$;

revoke all on function public.get_producer_code_coverage() from public;
grant execute on function public.get_producer_code_coverage() to authenticated, service_role;
