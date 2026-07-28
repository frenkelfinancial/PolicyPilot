-- ============================================================
-- 20260733_sms_optin_consent.sql
-- Evidence-grade consent capture for the hosted SMS opt-in page.
--
-- HOW TO APPLY (this project applies schema BY MANUAL PASTE, never db push —
-- same as 20260729_compliance_pages.sql):
--   1. Supabase Dashboard -> SQL Editor for project cweiaibjigjwspmshcrj.
--   2. Paste this whole file and Run. It is idempotent — safe to re-run.
--   PREREQUISITE: data/sql/019_messaging_compliance.sql (consent_records).
--   Guarded below: on a database where 019 has not been pasted, this file
--   raises a NOTICE and does nothing rather than failing.
--
-- ------------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------------
-- The 10DLC campaign was REJECTED because carrier review would not accept a
-- lead vendor's "…and its licensed agents" language as opt-in evidence for a
-- campaign sending as a different business. The vendor will not change their
-- form. So we stop relying on someone else's consent and collect our own, on
-- a page we host, branded to the agency that will actually be sending.
--
-- That only works if what we store is the kind of record a carrier or a
-- regulator accepts on its face. Until now consent_records held four facts:
-- who, what type, a free-text `source`, and when. For an agent attestation
-- that is honest — it says "the agent asserts this". For a consumer who
-- ticked a box on our own page, it throws away every piece of evidence that
-- makes the record self-proving.
--
-- These columns are that evidence:
--
--   disclosure_text  the EXACT words displayed above the checkbox, captured
--                    at submit time. Not a reference to a template that may
--                    have been edited since — the literal string. This is
--                    the single most important column here: "what were they
--                    agreeing to?" is the whole question, and a template id
--                    cannot answer it a year later.
--   page_url         where it happened, which for a per-agent page also
--                    identifies WHICH agency's page they consented on.
--   ip_address       who submitted it, to the extent the web can say.
--   user_agent       corroborates the IP; a mismatch between the two across
--                    a burst of submissions is what an abuse pattern looks
--                    like.
--   consent_method   how it was captured, as a closed set. `source` stays
--                    free text (it is the human sentence an auditor reads);
--                    this is the machine-readable sibling so code can ask
--                    "is this a self-service opt-in or an agent assertion?"
--                    without regexing prose.
--   contact_first_name / contact_last_name
--                    the name they typed. A phone number alone does not
--                    identify a person; the name is what lets a complaint
--                    ("I never signed up") be answered.
--
-- captured_at already exists and is the timestamp — no new column for it.
--
-- ------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ------------------------------------------------------------------
-- It adds NO insert policy. consent_records stays service-role-write-only
-- (019 §8). The public opt-in page writes through the `compliance-page` edge
-- function with the service key, exactly like every other write to this
-- table. An INSERT policy for `anon` would let anyone POST consent for any
-- number directly at PostgREST, bypassing every check the function makes.
-- ============================================================


do $$
begin
  if to_regclass('public.consent_records') is null then
    raise notice '[20260733] public.consent_records missing (apply data/sql/019_messaging_compliance.sql first) — skipping this migration entirely.';
    return;
  end if;

  -- ------------------------------------------------------------
  -- 1. Evidence columns.
  --
  -- ip_address is TEXT, not INET, on purpose. The value arrives in
  -- X-Forwarded-For through two proxies (Vercel -> Supabase) and is not
  -- guaranteed to be a single well-formed address. An INET column would
  -- reject the malformed case and take the whole consent write down with
  -- it — losing the consent to preserve the tidiness of the audit field is
  -- exactly backwards. The edge function stores the first hop verbatim.
  -- ------------------------------------------------------------
  alter table public.consent_records
    add column if not exists consent_method     text,
    add column if not exists disclosure_text    text,
    add column if not exists page_url           text,
    add column if not exists ip_address         text,
    add column if not exists user_agent         text,
    add column if not exists contact_first_name text,
    add column if not exists contact_last_name  text;
end $$;


do $$
begin
  if to_regclass('public.consent_records') is null then return; end if;

  execute $c$
    comment on column public.consent_records.consent_method is
      'HOW consent was captured, machine-readable closed set. web_form = the consumer ticked the box on their agent''s hosted /a/<slug>/sms-opt-in page (evidence-grade: disclosure_text + page_url + ip_address are all populated). agent_attested = an agent asserted it in the app. csv_import = messaging-recipients-import. inbound_keyword = the consumer texted START. NULL on rows written before 20260733.'
  $c$;
  execute $c$
    comment on column public.consent_records.disclosure_text is
      'The EXACT disclosure displayed above the consent checkbox at the moment of submission, stored verbatim. Never a template id or a reference — the literal string, because "what were they agreeing to?" is the question a carrier or regulator actually asks, and the template will have changed by the time they ask it.'
  $c$;
  execute $c$
    comment on column public.consent_records.page_url is
      'Canonical URL of the page the consent was given on, e.g. https://trust.producerstackcrm.com/a/<slug>/sms-opt-in. Also identifies WHICH agency''s page it was, independently of agent_id.'
  $c$;
  execute $c$
    comment on column public.consent_records.ip_address is
      'Submitter IP, first hop of X-Forwarded-For. TEXT rather than INET deliberately — see the header. Also the key the opt-in page rate-limits on.'
  $c$;
  execute $c$
    comment on column public.consent_records.user_agent is
      'Submitting browser''s User-Agent, truncated. Corroborates ip_address; a burst of submissions sharing one UA and one IP is what abuse looks like.'
  $c$;
  execute $c$
    comment on column public.consent_records.contact_first_name is
      'First name as the consumer typed it on the opt-in form. A phone number does not identify a person — this is what lets "I never signed up" be answered.'
  $c$;
end $$;


-- ------------------------------------------------------------
-- 2. Closed set for consent_method, and the evidence invariant.
--
-- The invariant is the point of the whole file: a row claiming to be a
-- web_form opt-in MUST carry the disclosure it showed and the URL it showed
-- it on. Without that it is an unevidenced assertion wearing the label of an
-- evidenced one, which is worse than an honest attestation — it would pass a
-- filter for "self-service opt-ins" and then prove nothing when opened.
--
-- Enforced in the database rather than in the edge function because the edge
-- function is not the only thing that will ever write this table.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.consent_records') is null then return; end if;

  alter table public.consent_records drop constraint if exists consent_records_method_check;
  alter table public.consent_records add constraint consent_records_method_check
    check (consent_method is null or consent_method in
      ('web_form','agent_attested','csv_import','inbound_keyword'));

  alter table public.consent_records drop constraint if exists consent_records_web_form_evidence_check;
  alter table public.consent_records add constraint consent_records_web_form_evidence_check
    check (
      consent_method is distinct from 'web_form'
      or (nullif(btrim(disclosure_text), '') is not null
          and nullif(btrim(page_url), '')     is not null)
    );
end $$;


-- ------------------------------------------------------------
-- 3. Rate-limit index.
--
-- A publicly reachable form that writes consent for an arbitrary phone
-- number is an abuse surface: nothing stops someone typing a stranger's
-- number, and the resulting row would make that stranger textable. The page
-- refuses more than a handful of submissions per IP per hour, and this is
-- the index that makes the check cheap enough to run inline on every POST.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.consent_records') is null then return; end if;

  create index if not exists consent_records_ip_captured_idx
    on public.consent_records (ip_address, captured_at desc)
    where ip_address is not null;
end $$;


-- ------------------------------------------------------------
-- 4. Backfill consent_method for rows written before this file.
--
-- Only where the existing free-text `source` states it unambiguously.
-- Everything else stays NULL — guessing at the provenance of a compliance
-- record to make a column look tidy is the one thing this table must never
-- do. NULL reads as "written before we recorded the method", which is true.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.consent_records') is null then return; end if;

  update public.consent_records
     set consent_method = 'agent_attested'
   where consent_method is null
     and source like 'agent_attested:%';

  update public.consent_records
     set consent_method = 'csv_import'
   where consent_method is null
     and source like 'csv_import%';
end $$;


-- ------------------------------------------------------------
-- Verify after running:
--
--   -- columns landed
--   select column_name, data_type from information_schema.columns
--    where table_name = 'consent_records'
--      and column_name in ('consent_method','disclosure_text','page_url',
--                          'ip_address','user_agent','contact_first_name',
--                          'contact_last_name');
--
--   -- the evidence invariant actually bites (expect: ERROR)
--   insert into public.consent_records
--     (agent_id, contact_phone, consent_type, source, consent_method)
--   values
--     ('<agent-uuid>', '+15555550123', 'express_written', 'test', 'web_form');
--   --> new row for relation "consent_records" violates check constraint
--       "consent_records_web_form_evidence_check"
--
--   -- and the same row WITH evidence succeeds
--   insert into public.consent_records
--     (agent_id, contact_phone, consent_type, source, consent_method,
--      disclosure_text, page_url)
--   values
--     ('<agent-uuid>', '+15555550123', 'express_written', 'test', 'web_form',
--      'the exact words shown', 'https://trust.producerstackcrm.com/a/x/sms-opt-in');
--
--   -- still service-role-write-only: no insert policy exists
--   select policyname, cmd from pg_policies
--    where tablename = 'consent_records';
--   --> select-only policies, nothing for insert/update/delete
-- ------------------------------------------------------------
