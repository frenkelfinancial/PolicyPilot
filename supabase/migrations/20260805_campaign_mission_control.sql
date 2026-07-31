-- ============================================================
-- 20260805_campaign_mission_control.sql
-- Campaign mission control: see every lead, watch the AI work, and let the
-- AI's verdict actually reach the lead board.
--
-- Three small things, one of which is load-bearing.
--
-- PART 1 — leads_preserve_ai_status(). THE ONE THAT MATTERS. Without it, every
--          status the AI writes is erased the next time the agent edits any
--          lead, because the browser re-upserts the entire book from memory on
--          every save. See the long note above the function.
--
-- PART 2 — voice_campaign_enrollments.paused_at, so a single lead's enrollment
--          can be held without ending it.
--
-- PART 3 — the index the per-campaign activity feed reads.
--
-- Read docs/campaign-mission-control.md alongside this.
-- Idempotent: safe to run more than once. Wrap in begin/commit when applying.
-- ============================================================

-- ------------------------------------------------------------
-- 0. A safe text -> timestamptz.
--
-- The stamps below live in a jsonb blob a browser writes, so they are strings
-- of unknown quality. A bare `::timestamptz` on a malformed one raises inside
-- a BEFORE trigger and takes the agent's whole save with it — which would turn
-- a display field into an outage.
-- ------------------------------------------------------------
create or replace function public.pp_jsonb_ts(v text)
returns timestamptz
language plpgsql
stable
as $$
begin
  if v is null or btrim(v) = '' then
    return null;
  end if;
  return v::timestamptz;
exception when others then
  return null;
end;
$$;

comment on function public.pp_jsonb_ts(text) is
  'Parse a timestamp out of a jsonb text value, returning NULL instead of raising on anything unparseable. Used by leads_preserve_ai_status(), where a raise inside a BEFORE trigger would fail the agent''s save.';

-- ------------------------------------------------------------
-- 1. leads_preserve_ai_status — what makes a server-side status update STICK.
--
-- THE PROBLEM, stated plainly. public.leads is owner-writable and the lead
-- book is a browser-side app: sbUpsertAllLeads() sends EVERY lead's `data`
-- blob, from memory, on every save. So a status the AI writes at 2:04 PM is
-- silently reverted at 2:05 PM when the agent edits an unrelated lead's notes
-- — not by a conflicting decision, but by a stale copy of the old one. This is
-- the same trap that keeps appointments out of leads.data, and it is exactly
-- why "does the AI update the status?" had no honest yes.
--
-- THE FIX. A status write now carries two companions in the same blob:
--   status_at      — when the decision was taken
--   status_source  — 'ai' or 'human'
-- A DELIBERATE edit stamps a fresh status_at (the browser has ONE status
-- writer, ppSetLeadStatus(), and a test asserts it). A blind whole-book
-- re-upsert carries whatever stale status_at was in memory. That difference is
-- what this trigger reads: newer stamp wins, and an equal-or-older stamp
-- coming in over an AI-set status is not a decision, it is an echo.
--
-- WHY IT IS ALSO THE ORDERING GUARD. The rule runs in both directions. A human
-- who changes the status after the call started stamps a later time and their
-- change goes through untouched — in the database, not merely in the edge
-- function that also checks it (aiStatusVerdict in _shared/ai-lead-effect.ts).
-- Two enforcement points for one rule, on purpose: the function's is what
-- decides not to write, and this is what stops the write being undone.
--
-- SCOPED TO BROWSER WRITES, like leads_protect_consent_columns above it. The
-- service role is trusted here — it is the only thing that ever writes
-- status_source = 'ai', and it always stamps a fresh status_at, so it would
-- pass the test anyway.
--
-- THE DISPOSITION IS PRESERVED SEPARATELY and unconditionally against its own
-- stamp, because it is a record of what happened on a call rather than a claim
-- about where the lead sits. A human moving the lead to "Appointment Set"
-- afterwards does not make "no answer at 2:04" untrue.
-- ------------------------------------------------------------
create or replace function public.leads_preserve_ai_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_at   timestamptz;
  new_at   timestamptz;
  old_disp timestamptz;
  new_disp timestamptz;
begin
  -- Only end-user requests through PostgREST. Service-role edge functions and
  -- direct SQL sessions are trusted, same as the consent guard.
  if auth.role() is distinct from 'authenticated' and auth.role() is distinct from 'anon' then
    return new;
  end if;

  if jsonb_typeof(new.data) is distinct from 'object'
     or jsonb_typeof(old.data) is distinct from 'object' then
    return new;
  end if;

  -- ---- The status -------------------------------------------------------
  -- Only ever guards a status the AI set. A status one human set and another
  -- human is changing is none of this trigger's business.
  if old.data->>'status_source' = 'ai' then
    old_at := pp_jsonb_ts(old.data->>'status_at');
    new_at := pp_jsonb_ts(new.data->>'status_at');
    if old_at is not null and (new_at is null or new_at <= old_at) then
      new.data := (new.data - 'status' - 'status_at' - 'status_source')
        || jsonb_strip_nulls(jsonb_build_object(
             'status',        old.data->'status',
             'status_at',     old.data->'status_at',
             'status_source', old.data->'status_source'));
    end if;
  end if;

  -- ---- The disposition --------------------------------------------------
  old_disp := pp_jsonb_ts(old.data->>'ai_disposition_at');
  new_disp := pp_jsonb_ts(new.data->>'ai_disposition_at');
  if old_disp is not null and (new_disp is null or new_disp < old_disp) then
    new.data := (new.data - 'ai_disposition' - 'ai_disposition_at')
      || jsonb_strip_nulls(jsonb_build_object(
           'ai_disposition',    old.data->'ai_disposition',
           'ai_disposition_at', old.data->'ai_disposition_at'));
  end if;

  return new;
end;
$$;

drop trigger if exists leads_preserve_ai_status on public.leads;
create trigger leads_preserve_ai_status
  before update on public.leads
  for each row execute function public.leads_preserve_ai_status();

comment on function public.leads_preserve_ai_status() is
  'Stops a browser''s whole-book re-upsert from erasing a lead status the AI set. leads.data.status now travels with status_at + status_source; a deliberate edit stamps a fresh status_at and wins, a stale echo does not. Also the database half of the ordering guard in _shared/ai-lead-effect.ts: a human status set AFTER the call started carries a later stamp and is never reverted. Browser writes only — the service role is trusted, and is the only thing that writes status_source = ''ai''.';

-- ------------------------------------------------------------
-- 2. Pausing ONE lead's enrollment.
--
-- `status = 'paused'` was already in the CHECK constraint and already excluded
-- everywhere it matters — the tick's due query and the claim both filter
-- `status = 'active'` — so a paused enrollment is one the engine will not pick
-- up, for free. What was missing is WHEN, so the screen can say "Paused
-- 20 minutes ago" instead of an unexplained grey row.
--
-- NOTE the interaction with voice_campaign_enrollments_one_active_uidx: that
-- partial index covers `status = 'active'` only, so pausing releases the lead
-- to be enrolled elsewhere. Resume therefore has to re-check that nothing else
-- has claimed them in the meantime — voice-campaign-manage does, and returns
-- `conflict` rather than a raw 23505.
-- ------------------------------------------------------------
alter table public.voice_campaign_enrollments
  add column if not exists paused_at timestamptz;

comment on column public.voice_campaign_enrollments.paused_at is
  'When this single lead''s enrollment was paused by hand. status = ''paused'' is what actually holds it (the tick''s due query and the claim both require ''active''); this column is so the screen can say when. Cleared on resume. A PAUSED enrollment does not hold the one-active-campaign slot, so resuming re-checks for a conflict.';

-- ------------------------------------------------------------
-- 2b. WHY a lead is waiting, not just until when.
--
-- vcHandleGateRejection() already knew the answer and threw it away: a
-- `quiet_hours` refusal and a `daily_cap_reached` refusal both came out the
-- other side as nothing but a later next_action_at. On the campaign screen
-- that is the difference between "Tomorrow 9:05 AM" — which reads as broken —
-- and "Quiet hours where they live · next call 9:05 AM", which reads as
-- working. Written by voice-campaign-tick on a reschedule and CLEARED the
-- moment a call goes out, so it can never describe a wait that is over.
-- ------------------------------------------------------------
alter table public.voice_campaign_enrollments
  add column if not exists last_gate_code text;

comment on column public.voice_campaign_enrollments.last_gate_code is
  'The ai-call-start gate code that caused the most recent reschedule (quiet_hours, daily_cap_reached, or a transient one). Display only: the engine branches on vcHandleGateRejection''s plan, never on this. Cleared when a call is placed, so a stale reason cannot outlive its wait.';

-- ------------------------------------------------------------
-- 3. The activity feed's index.
--
-- The feed is "this campaign's last ~50 calls, newest first".
-- ai_calls_campaign_step_created_idx leads on (campaign_id, campaign_step),
-- so it cannot serve an ordering by created_at across all steps without a
-- sort. One more partial index, on the two columns the feed actually uses.
-- ------------------------------------------------------------
create index if not exists ai_calls_campaign_created_idx
  on public.ai_calls (campaign_id, created_at desc)
  where campaign_id is not null;

-- ------------------------------------------------------------
-- 4. RLS: nothing changes, and that is the point.
--
-- The mission-control screen is built entirely from tables the agent may
-- already SELECT (voice_campaigns, voice_campaign_steps,
-- voice_campaign_enrollments, ai_calls, leads). Every WRITE it offers —
-- pause, resume, remove, move — goes through voice-campaign-manage under the
-- service role with the agent taken from the JWT.
--
-- NO INSERT OR UPDATE POLICY IS ADDED TO voice_campaign_enrollments HERE, and
-- none may be. An enrollment is a standing instruction to place phone calls to
-- a consumer; a browser that could write one could enrol a lead with no
-- consent. A "pause" button is not a good enough reason to open that door.
-- ------------------------------------------------------------
