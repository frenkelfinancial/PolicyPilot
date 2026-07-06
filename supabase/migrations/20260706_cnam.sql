-- Add CNAM (Caller ID Name) to agents.
-- cnam_name: the outbound caller ID name displayed on recipients' phones (max 15 chars, NANPA standard).
-- Stored on agents so one setting applies to all the agent's numbers automatically.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS cnam_name TEXT;
