-- ============================================================
-- 010_sip_softphone.sql
-- In-browser softphone. Replaces the agent's personal-cell
-- pickup leg (008_agent_phone.sql) with a SignalWire SIP
-- endpoint the browser registers to via JsSIP over WSS.
--
-- signalwire-bridge now dials To = sip:<username>@<space>.sip…
-- instead of To = agents.agent_phone. SignalWire delivers that
-- leg inbound to the browser; the browser auto-answers and the
-- existing inline TwiML still <Dial>s the PSTN lead leg.
--
-- agents.agent_phone is intentionally LEFT IN PLACE (dormant)
-- so this change is non-destructive and rollback-safe.
--
-- Run once in the Supabase SQL Editor (manual paste — this
-- project does NOT use `supabase db push`).
-- ============================================================

-- SIP endpoint columns on agents -----------------------------
-- Provisioned lazily by the signalwire-sip-creds edge function
-- on the agent's first softphone registration.
alter table public.agents
  add column if not exists sip_endpoint_username text,
  add column if not exists sip_endpoint_password text,
  add column if not exists sip_endpoint_sid      text;

comment on column public.agents.sip_endpoint_username is
  'SignalWire SIP endpoint username the browser registers as via JsSIP over WSS. Form: agent-<first 8 hex of the agent uuid>. Provisioned lazily by the signalwire-sip-creds edge function.';
comment on column public.agents.sip_endpoint_password is
  'SignalWire SIP endpoint password. Returned to the browser by signalwire-sip-creds for JsSIP registration — the browser needs it in cleartext to register, so it cannot be hashed. Reads are scoped to the owning agent by the agents_select_own RLS policy (same trust model as signalwire_caller_id).';
comment on column public.agents.sip_endpoint_sid is
  'SignalWire SIP endpoint resource id (the "id" from the create-SIP-endpoint REST response). Kept for future rotate/delete.';

-- No new RLS policies: agents_select_own / agents_update_own
-- (001_agents_profile.sql) already scope by auth.uid() = id, so
-- an agent can read its own SIP creds. The signalwire-sip-creds
-- edge function WRITES these columns with the service-role key,
-- which bypasses RLS — no policy change needed.
