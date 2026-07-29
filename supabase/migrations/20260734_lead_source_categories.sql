-- ============================================================
-- 20260734_lead_source_categories.sql
--
-- Data migration only. No DDL, no DROP, no schema change.
--
-- public.agents.lead_vendors changed meaning on 2026-07-28: it held named
-- lead COMPANIES ('goatleads', 'builtleads', or a free-text 'other:<name>')
-- and now holds lead SOURCE CATEGORIES, from LEAD_SOURCE_CATEGORIES in
-- supabase/functions/_shared/lead-vendors.ts:
--
--     lead_partners | own_forms | referrals
--
-- WHY THE COLUMN CHANGED MEANING
-- ------------------------------
-- Carrier review item 1 on campaign CD2166Q was that our opt-in evidence
-- identified a third party ("... and its licensed agents") while the campaign
-- sends as Frenkel Financial Agency. Naming any lead company in a document
-- about SMS consent points the reviewer at that company's disclosure, which is
-- the document that got us the rejection. Separately, the two names this repo
-- carried were the wrong companies entirely. So no lead company is named on
-- any carrier-facing surface now, and the privacy policy describes lead
-- sources by type.
--
-- WHY THIS FILE IS NOT URGENT
-- ---------------------------
-- resolveLeadSourceLabels() is a strict whitelist: an unrecognised key is
-- dropped, so a row still holding 'goatleads' already renders the generic
-- fallback sentence rather than a stale company name. Nothing is exposed
-- while this is unapplied. It runs so the stored data means what the column
-- comment says it means, and so the Settings checkboxes reflect reality
-- instead of showing nothing ticked.
--
-- MAPPING
-- -------
-- Every legacy value described buying leads from a third-party company, which
-- is exactly the 'lead_partners' category. 'own_forms' and 'referrals' are NOT
-- inferred: no legacy value carried that claim, and asserting a lead source an
-- agent does not use would put a false sentence on their privacy policy. They
-- tick those themselves in Settings.
--
-- Idempotent: re-running is a no-op, because after the first run no row
-- matches the legacy-value predicate.
-- ============================================================

-- Updating agents fires agents_sync_compliance_page, which appends a row to
-- compliance_page_revisions when the rendered inputs change. That is intended
-- here: the privacy policy's "Where your information comes from" section is
-- one of the rendered inputs and its content genuinely changes.
update public.agents
   set lead_vendors = array['lead_partners']::text[]
 where lead_vendors is not null
   and lead_vendors <> '{}'::text[]
   -- any legacy value: the two retired keys, or the withdrawn free-text path
   and exists (
         select 1
           from unnest(lead_vendors) as v
          where lower(v) in ('goatleads', 'builtleads')
             or lower(v) like 'other:%'
       )
   -- ...and nothing already migrated
   and not exists (
         select 1
           from unnest(lead_vendors) as v
          where lower(v) in ('lead_partners', 'own_forms', 'referrals')
       );

-- Verification. Expect zero rows: no agent may still carry a legacy value.
do $$
declare
  bad int;
begin
  select count(*) into bad
    from public.agents a
   where exists (
           select 1 from unnest(a.lead_vendors) as v
            where lower(v) in ('goatleads', 'builtleads')
               or lower(v) like 'other:%'
         );
  if bad > 0 then
    raise exception 'lead_source_categories: % agent row(s) still hold a legacy lead vendor value', bad;
  end if;
  raise notice 'lead_source_categories: OK, no legacy lead vendor values remain';
end $$;
