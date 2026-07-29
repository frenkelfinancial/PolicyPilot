-- ============================================================
-- Back Office, Phase 6 — reconciliation.
--
-- Three additive columns on `commission_rows` and one summary function.
-- No new table. No RLS change. Nothing in `auth.*` or `storage.*`.
--
-- THE DECISION THE BRIEF ASKED FOR: build on `public.review_queue`, or replace
-- it? NEITHER. It is left exactly as it is, and Phase 6 does not use it.
--
-- `review_queue` (20260708) belongs to the carrier-mail pipeline. It is
-- `references public.parsed_events(id)` NOT NULL with `unique
-- (parsed_event_id)` on top, and its `reason` vocabulary is that pipeline's
-- (`pdf_unreadable`, `ambiguous_match`, …). A commission row has no
-- parsed_event, so putting one in that table means either inventing a fake
-- parent row or dropping the constraint that makes the table correct for its
-- real owner.
--
-- Replacing it is worse: it is the only queue behind `match-events`, which is
-- deployed and running twice a day on a cron. Rewriting a live pipeline's
-- queue to serve a screen it does not feed is a change with no upside.
--
-- And it is not needed, because **`commission_rows` IS already the queue.**
-- Phase 1 gave it `review_status` ('auto' | 'needs_review' | 'approved' |
-- 'rejected', check-constrained), `review_reason` in plain English,
-- `match_method` and `match_confidence`. A second table pointing at those rows
-- would be a second place to keep in sync, and the first thing that drifts.
--
-- So this migration adds only what was genuinely missing: WHO resolved a row,
-- WHEN, and WHY. Without those, an approved row is indistinguishable from one
-- the parser matched by itself, and the audit question — "who decided this
-- $4,000 chargeback was mine?" — has no answer.
--
-- THE WRITE PATH IS UNCHANGED AND MUST STAY SO. `commission_rows` is
-- SELECT-only for `authenticated`. Approve / correct / reject go through the
-- `statement-review` edge function under the service role, which takes the
-- agent from the JWT and re-checks that both the row and the target policy
-- belong to that agent. An UPDATE policy wide enough to let the browser set
-- `review_status` is wide enough to let it set `matched_policy_id`, and
-- pointing a commission row at another agent's policy is exactly the thing
-- this schema is built to prevent.
-- ============================================================

alter table public.commission_rows
  add column if not exists reviewed_at  timestamptz,
  add column if not exists reviewed_by  uuid references auth.users(id) on delete set null,
  add column if not exists review_note  text;

comment on column public.commission_rows.reviewed_at is
  'When a human resolved this row. Null means nobody has — the parser''s own match is not a review.';
comment on column public.commission_rows.reviewed_by is
  'Who resolved it. ON DELETE SET NULL: removing an account must not erase the record that a decision was made.';
comment on column public.commission_rows.review_note is
  'Free text the reviewer left, e.g. why a line was rejected.';

-- The queue read: needs_review first, newest first. Partial, because resolved
-- rows are the overwhelming majority on any healthy book.
create index if not exists commission_rows_review_open_idx
  on public.commission_rows (agent_id, created_at desc)
  where review_status = 'needs_review';

create index if not exists commission_rows_reviewed_idx
  on public.commission_rows (agent_id, reviewed_at desc)
  where reviewed_at is not null;


-- ------------------------------------------------------------
-- get_reconciliation_summary() — the three queue counts, one round trip.
--
-- SECURITY INVOKER (the default): it reads only through the caller's own RLS
-- on `commission_rows`, `commission_statements` and `policies`, so it cannot
-- count anybody else's work even by accident. There is no cross-agent
-- reconciliation view and there should not be one — resolving a match means
-- seeing a client name.
--
-- `unlinked_policies` is the third queue: a policy that has been in force long
-- enough to have been paid, with no commission line pointing at it. That is
-- either a match that failed or a carrier that has not paid — and both are
-- worth an agent's attention, which is the whole point of the screen.
-- ------------------------------------------------------------
create or replace function public.get_reconciliation_summary(
  p_unpaid_days int default 45
)
returns table (
  match_review      bigint,
  unlinked_policies bigint,
  stuck_uploads     bigint,
  resolved_7d       bigint,
  review_amount_cents bigint
)
language sql
stable
set search_path = public
as $fn$
  select
    (select count(*) from public.commission_rows cr
       where cr.review_status = 'needs_review')::bigint,
    (select count(*) from public.policies po
       where coalesce(po.data->>'status','') in ('issued','paid','placed')
         and case when coalesce(po.data->>'draft','') ~ '^\d{4}-\d{2}-\d{2}'
                  then (left(po.data->>'draft', 10))::date
                  else null end <= (current_date - make_interval(days => p_unpaid_days))
         and not exists (
           select 1 from public.commission_rows cr
            where cr.matched_policy_id = po.id
              and cr.review_status <> 'rejected'))::bigint,
    (select count(*) from public.commission_statements cs
       where cs.status = 'failed')::bigint,
    (select count(*) from public.commission_rows cr
       where cr.reviewed_at is not null
         and cr.reviewed_at >= now() - interval '7 days')::bigint,
    (select coalesce(sum(abs(cr.amount_cents)), 0) from public.commission_rows cr
       where cr.review_status = 'needs_review')::bigint;
$fn$;

comment on function public.get_reconciliation_summary(int) is
  'The three reconciliation queue counts for the caller. SECURITY INVOKER — scoped by RLS, never cross-agent.';

grant execute on function public.get_reconciliation_summary(int) to authenticated;
