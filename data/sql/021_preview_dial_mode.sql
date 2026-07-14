-- 021_preview_dial_mode.sql
-- Preview (pause-and-preview) dial mode support.
--
-- dialer_sessions.dial_mode tells the BACKEND which mode the session runs in:
--   'power'   — every advance immediately dials the next lead (existing behavior)
--   'preview' — advances move to the next lead WITHOUT placing a call; the
--               agent reviews the lead in the UI and explicitly clicks Dial,
--               which issues a 'redial' of the current lead.
--
-- Before this column, preview mode existed only in the frontend: the backend
-- auto-dialed every next lead and the UI merely "paused" itself while the
-- lead's phone was already ringing — indistinguishable from power mode.

alter table public.dialer_sessions
  add column if not exists dial_mode text not null default 'power';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'dialer_sessions_dial_mode_check'
  ) then
    alter table public.dialer_sessions
      add constraint dialer_sessions_dial_mode_check
      check (dial_mode in ('power', 'preview'));
  end if;
end $$;

comment on column public.dialer_sessions.dial_mode is
  'power = auto-dial each next lead; preview = advance without dialing, agent clicks Dial manually.';
