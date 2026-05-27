-- ============================================================
-- PolicyPilot — Lead Vendor Integration Setup
-- Run this ONCE in the Supabase SQL editor.
-- Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- 1. Create the lead_vendors table
--    One row per vendor integration per agent.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lead_vendors (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id   UUID        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,          -- e.g. "Goat Leads"
  token      TEXT        NOT NULL UNIQUE,   -- secret token given to the vendor
  field_map  JSONB       NOT NULL DEFAULT '{}',
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Row-Level Security: agents can only see their own vendors
-- ============================================================
ALTER TABLE public.lead_vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_own_vendors" ON public.lead_vendors;
CREATE POLICY "agent_own_vendors" ON public.lead_vendors
  FOR ALL
  USING (agent_id = auth.uid());

-- 3. Enable Realtime on the leads table
--    This makes new webhook leads appear instantly in the dashboard
--    without needing a page refresh.
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.leads;

-- ============================================================
-- 4. Find Jace's agent UUID
--    Run this SELECT first, copy the id, then use it in step 5.
-- ============================================================
SELECT id, email FROM public.agents;

-- ============================================================
-- 5. Insert the Goat Leads vendor entry
--
--    REPLACE <PASTE_AGENT_UUID_HERE> with the UUID from step 4.
--
--    The token below is pre-generated and unique.
--    Give this exact URL to Goat Leads as the webhook delivery URL:
--
--    https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/lead-ingest?token=gl_live_pk7m3x9qw2r8nj4e5t6yua1cvb0szfh
--
--    In Goat Leads portal: Settings → Webhook / Lead Delivery URL → paste URL above
-- ============================================================
INSERT INTO public.lead_vendors (agent_id, name, token, field_map)
VALUES (
  '<PASTE_AGENT_UUID_HERE>',
  'Goat Leads',
  'gl_live_pk7m3x9qw2r8nj4e5t6yua1cvb0szfh',
  '{
    "Date/Time":                        "received_at",
    "First Name":                       "first_name",
    "Last Name":                        "last_name",
    "Email":                            "email",
    "Phone":                            "phone",
    "DOB":                              "dob",
    "Age":                              "age",
    "Gender":                           "gender",
    "State":                            "state",
    "Ad":                               "ad_name",
    "Platform":                         "platform",
    "Marital Status":                   "marital_status",
    "Military Status":                  "military_status",
    "How Much Coverage Do You Need?":   "coverage_wanted",
    "Best Time of Day to Contact You?": "best_contact_time",
    "Military Branch":                  "military_branch",
    "Trusted Form Certificate":         "trusted_form_url",
    "IP Address":                       "skip",
    "OTP Code":                         "skip",
    "Status":                           "skip"
  }'::jsonb
);

-- ============================================================
-- HOW TO ADD MORE VENDORS IN THE FUTURE:
--
-- 1. Generate a new token (use a password manager or run:
--    SELECT encode(gen_random_bytes(24), 'hex') AS new_token;
--
-- 2. Insert a new row:
--    INSERT INTO public.lead_vendors (agent_id, name, token, field_map)
--    VALUES (
--      '<AGENT_UUID>',
--      'Vendor Name Here',
--      'your_generated_token_here',
--      '{ "VendorField1": "our_field1", "VendorField2": "our_field2" }'::jsonb
--    );
--
-- 3. Webhook URL to give the vendor:
--    https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/lead-ingest?token=your_generated_token_here
--
-- Standard our_field names (right side of field_map):
--   first_name, last_name, name, email, phone, dob, age, gender,
--   state, military_status, military_branch, coverage_wanted,
--   marital_status, best_contact_time, platform, ad_name,
--   trusted_form_url, received_at
--   (use "skip" for fields you want to ignore)
-- ============================================================
