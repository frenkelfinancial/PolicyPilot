-- ============================================================
-- 004_agent_digest_prefs.sql
-- Book Intelligence #3 — daily digest preferences on agents table.
--
-- Adds opt-in flag and optional override email address. No new tables,
-- no schedule storage (v1 fires for everyone at the same global cron
-- time; per-agent scheduling is deferred).
-- ============================================================

alter table public.agents
  add column if not exists digest_enabled  boolean default false,
  add column if not exists digest_email    text;

-- RLS is already enabled on public.agents (per 001). The existing
-- "agents_update_own" policy lets the agent toggle their own digest_enabled.
-- No new policy required.

-- Index isn't worth it — the daily-digest function does a single
-- `where digest_enabled = true` scan once per day across a small table.
