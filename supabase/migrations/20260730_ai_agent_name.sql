-- ============================================================
-- 20260730_ai_agent_name.sql
-- AI Sales Agent — humanize round 1: a per-agent name for the assistant.
--
-- The greeting used to introduce the caller as "an automated AI assistant"
-- with no name of its own. Owner decision (2026-07-30): it introduces itself
-- as "an assistant" and, when the agent has chosen one, by NAME:
--
--   "Hi Mark, this is Sarah — I'm an assistant calling on behalf of
--    Jordan Rivera with Frenkel Financial."
--
-- NULL is a real state, not a missing value: with no name set the greeting
-- uses the nameless variant ("Hi Mark — I'm an assistant calling on behalf
-- of..."). ai-call-webhook NEVER invents a default name — a name the agent
-- did not choose is a name they have to explain to a lead.
--
-- Same shape and the same write path as agents.ai_voice (20260727): read by
-- ai-call-start on every dial, carried to the webhook in client_state, and
-- saved straight from the browser by the AI Dialer Test rig. The
-- agents_protect_privileged_columns trigger (20260703c) is a DENYLIST of
-- billing/privilege columns, so this column is owner-writable under the
-- existing agents_update_own policy without any policy change.
--
-- Idempotent: safe to run more than once.
-- ============================================================

alter table public.agents
  add column if not exists ai_agent_name text;

comment on column public.agents.ai_agent_name is
  'The name the AI Sales Agent introduces itself by on calls (e.g. ''Sarah''). NULL = no name; the greeting uses its nameless variant and ai-call-webhook does NOT substitute a default. Read by ai-call-start at dial time and carried to ai-call-webhook in client_state.vars.ai_name.';
