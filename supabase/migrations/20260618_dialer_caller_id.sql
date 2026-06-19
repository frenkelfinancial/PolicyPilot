-- Add caller-ID configuration columns to dialer_sessions.
-- caller_id_mode:    'fixed' | 'smart_local'
-- caller_id_fixed:   E.164 number for fixed mode
-- caller_id_numbers: JSONB array of E.164 strings for smart-local rotation
-- current_caller_id: the number that was actually used for the current call (updated per lead)

ALTER TABLE public.dialer_sessions
  ADD COLUMN IF NOT EXISTS caller_id_mode    TEXT    DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS caller_id_fixed   TEXT,
  ADD COLUMN IF NOT EXISTS caller_id_numbers JSONB   DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_caller_id TEXT;
