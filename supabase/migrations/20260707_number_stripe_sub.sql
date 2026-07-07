-- Each phone number now gets its own Stripe subscription so billing is
-- independent per number (start date, cancel date, recurring date).
ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS stripe_sub_id TEXT;
