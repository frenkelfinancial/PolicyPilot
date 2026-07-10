-- Surface leads that dialNextLead silently skipped without ever dialing
-- them (missing phone on file, missing leads-table row, no caller ID
-- available) instead of them vanishing from the queue with no trace.
-- Written by _shared/dialer-next-lead.ts, cleared back to null on the next
-- successful dial, and surfaced by power-dialer.html as a toast/banner.

ALTER TABLE public.dialer_sessions
  ADD COLUMN IF NOT EXISTS last_skip_reason TEXT;
