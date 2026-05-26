-- ============================================================
-- 003_policies_book_intel.sql
-- Book Intelligence Phase 1 — Term Conversion Radar.
--
-- No column changes. Phase 1 keeps the policy schema in `data jsonb`
-- per the rationale in 002 (front-end's flexible JS shape stays
-- canonical). This migration only adds an index to keep the
-- scoring scan fast as the book grows.
--
-- The jsonb extensions Phase 1 introduces (productType, issueDate,
-- termLengthYears, clientDob, conversionDeadline, opportunity{...})
-- live inside `data` and are documented in docs/architecture.md.
-- ============================================================

-- Index on the cached conversion deadline so we can range-scan
-- "what expires in the next 90 days" without parsing the whole jsonb
-- for every row.
--
-- NB: We index the raw text (YYYY-MM-DD) rather than ::date because the
-- text→date cast is STABLE (depends on the DateStyle GUC), and Postgres
-- requires IMMUTABLE expressions inside index definitions. ISO-8601 sorts
-- identically as text and as date, so range queries still work fine —
-- e.g. `where data->>'conversionDeadline' < '2026-08-08'` uses this index.
create index if not exists policies_conversion_deadline_idx
  on public.policies ((data->>'conversionDeadline'))
  where (data->>'conversionDeadline') is not null;

-- Partial index on opportunity status. Used by the dashboard to
-- quickly filter OPEN / SNOOZED cards without a sequential scan.
create index if not exists policies_opportunity_status_idx
  on public.policies ((data->'opportunity'->>'status'))
  where (data->'opportunity'->>'status') is not null;
