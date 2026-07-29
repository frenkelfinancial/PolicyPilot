-- ============================================================
-- Back Office, Phase 1 — commission statement ingestion.
--
-- Four tables, all additive and idempotent, all SELECT-only for
-- `authenticated`:
--
--   1. public.commission_statements  — one row per uploaded file; carries the
--                                      pipeline state machine.
--   2. public.statement_files        — the raw bytes, 1:1 with a statement.
--   3. public.statement_extractions  — exactly what the model returned, before
--                                      any normalization of ours touched it.
--   4. public.commission_rows        — the normalized rows everything
--                                      downstream (dashboard, debt,
--                                      persistency, reconciliation) reads.
--
-- NOT here on purpose:
--
--   * Any INSERT/UPDATE/DELETE policy for `authenticated`. Commission data is
--     the most sensitive data in this app; every write goes through a
--     service-role edge function (`statement-upload`, `statement-parse`) that
--     resolves the agent from the caller's JWT. RLS-enabled-with-no-write-
--     policy is how "service-role only" is expressed in Postgres — the same
--     shape as consent_records, lead_transfers and reputation_config.
--   * Any cross-agent read path. A leader seeing downline totals is a
--     deliberately-built SECURITY DEFINER aggregate RPC, and it arrives in
--     Phase 4 with the debt rollup that needs it. Until then no query in this
--     schema can return another agent's row, by construction.
--
-- Why the raw bytes live in Postgres rather than Supabase Storage: the agreed
-- schema rules forbid anything touching `storage.*`, and creating a bucket
-- writes `storage.buckets`. Keeping the bytes in a table we own also means one
-- access-control system instead of two. The column sits in its own table so no
-- ordinary query drags megabytes along; nothing outside the two edge functions
-- reads it, which is also what makes a later move to object storage a
-- three-line change.
-- ============================================================


-- ------------------------------------------------------------
-- 1. commission_statements — one uploaded file, and its pipeline state.
--
-- `status` is the state machine the UI's live counters render:
--   queued -> parsing -> persisting -> matching -> ingested
--   (any state) -> failed
-- `failed` is re-runnable: `attempts` counts tries, `error` holds the last
-- reason, and nothing about a failed statement is deleted.
--
-- `sha256` is of the raw bytes. UNIQUE (agent_id, sha256) is the file-grain
-- idempotency guarantee: re-uploading the identical file returns the existing
-- statement instead of ingesting it twice. It is per-agent on purpose — two
-- agents legitimately receive the same carrier statement.
--
-- A ZIP archive gets its own row, and each member gets a row pointing back at
-- it via parent_statement_id, so "which upload did this come from" survives.
-- ------------------------------------------------------------
create table if not exists public.commission_statements (
  id                  uuid        primary key default gen_random_uuid(),
  agent_id            uuid        not null references auth.users(id) on delete cascade,
  parent_statement_id uuid        references public.commission_statements(id) on delete cascade,

  filename            text        not null,
  mime_type           text,
  size_bytes          bigint      not null default 0,
  sha256              text        not null,
  file_kind           text        not null default 'unknown',  -- pdf|xlsx|xls|csv|zip|unknown
  source              text        not null default 'upload',   -- upload|email|zip_member

  status              text        not null default 'queued',
  status_detail       text,
  error               text,
  attempts            int         not null default 0,

  carrier             text,
  statement_date      date,
  period_start        date,
  period_end          date,

  row_count           int         not null default 0,
  matched_count       int         not null default 0,
  review_count        int         not null default 0,
  total_amount_cents  bigint      not null default 0,

  parse_model         text,
  input_tokens        int         not null default 0,
  output_tokens       int         not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  parsed_at           timestamptz,
  ingested_at         timestamptz
);

comment on table public.commission_statements is
  'One row per uploaded carrier commission statement, carrying the ingestion pipeline state. Service-role write only; agents read their own.';
comment on column public.commission_statements.sha256 is
  'Hex SHA-256 of the raw file bytes. UNIQUE per agent — this is the file-grain idempotency guarantee.';
comment on column public.commission_statements.status is
  'queued | parsing | persisting | matching | ingested | failed. Failed is re-runnable; nothing is deleted.';

create unique index if not exists commission_statements_agent_sha_uidx
  on public.commission_statements (agent_id, sha256);
create index if not exists commission_statements_agent_created_idx
  on public.commission_statements (agent_id, created_at desc);
create index if not exists commission_statements_pending_idx
  on public.commission_statements (status, created_at)
  where status in ('queued', 'parsing', 'persisting', 'matching');
create index if not exists commission_statements_parent_idx
  on public.commission_statements (parent_statement_id)
  where parent_statement_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'commission_statements_status_check'
  ) then
    alter table public.commission_statements
      add constraint commission_statements_status_check
      check (status in ('queued','parsing','persisting','matching','ingested','failed'));
  end if;
end $$;

alter table public.commission_statements enable row level security;

drop policy if exists commission_statements_select_own on public.commission_statements;
create policy commission_statements_select_own
  on public.commission_statements for select to authenticated
  using (agent_id = auth.uid());

drop trigger if exists commission_statements_touch_updated_at on public.commission_statements;
create trigger commission_statements_touch_updated_at
  before update on public.commission_statements
  for each row execute function public.touch_updated_at();


-- ------------------------------------------------------------
-- 2. statement_files — the raw bytes. Evidence, not a cache.
--
-- Separate table, 1:1 with the statement, so that `select * from
-- commission_statements` never drags a multi-megabyte column along. The agent
-- can read their own bytes back (PostgREST returns bytea as a `\x…` hex
-- string, which the browser decodes for download) — a commission statement is
-- the agent's own document and they must be able to produce the original.
-- ------------------------------------------------------------
create table if not exists public.statement_files (
  statement_id uuid        primary key references public.commission_statements(id) on delete cascade,
  agent_id     uuid        not null references auth.users(id) on delete cascade,
  content      bytea       not null,
  byte_size    bigint      not null default 0,
  created_at   timestamptz not null default now()
);

comment on table public.statement_files is
  'Raw bytes of an uploaded statement, kept so a parse is never the only surviving record of the document. Service-role write only.';

create index if not exists statement_files_agent_idx on public.statement_files (agent_id);

alter table public.statement_files enable row level security;

drop policy if exists statement_files_select_own on public.statement_files;
create policy statement_files_select_own
  on public.statement_files for select to authenticated
  using (agent_id = auth.uid());


-- ------------------------------------------------------------
-- 3. statement_extractions — what the model actually returned.
--
-- Written BEFORE our normalizer touches anything. If the normalizer is wrong,
-- or we change how a transaction type maps six months from now, the original
-- extraction is still here to re-derive from without another API call.
--
-- kind:
--   column_mapping — the per-sheet mapping a tabular file's single AI call
--                    produced (headers -> canonical fields, carrier, type map)
--   pdf_rows       — rows the model read directly out of a PDF
-- ------------------------------------------------------------
create table if not exists public.statement_extractions (
  id             uuid        primary key default gen_random_uuid(),
  statement_id   uuid        not null references public.commission_statements(id) on delete cascade,
  agent_id       uuid        not null references auth.users(id) on delete cascade,
  kind           text        not null,
  sheet_name     text,
  chunk_index    int         not null default 0,
  model          text,
  prompt_excerpt text,
  raw_output     jsonb       not null default '{}'::jsonb,
  input_tokens   int         not null default 0,
  output_tokens  int         not null default 0,
  created_at     timestamptz not null default now()
);

comment on table public.statement_extractions is
  'Verbatim model output per statement, stored before normalization so the evidence outlives our parser. Service-role write only.';

create index if not exists statement_extractions_statement_idx
  on public.statement_extractions (statement_id, chunk_index);
create index if not exists statement_extractions_agent_idx
  on public.statement_extractions (agent_id, created_at desc);

alter table public.statement_extractions enable row level security;

drop policy if exists statement_extractions_select_own on public.statement_extractions;
create policy statement_extractions_select_own
  on public.statement_extractions for select to authenticated
  using (agent_id = auth.uid());


-- ------------------------------------------------------------
-- 4. commission_rows — the normalized rows everything downstream reads.
--
-- `agent_id` is the UPLOADER (the tenant boundary, and what RLS keys on).
-- `attributed_agent_id` is who actually wrote the business, resolved from a
-- producer code in Phase 2. They are the same for a solo agent and differ on
-- an agency owner's consolidated statement — which is exactly why they are
-- two columns.
--
-- `raw` holds the source row verbatim (the sheet row as an object, or the
-- model's row object for a PDF), so a normalization question is always
-- answerable from the row itself.
--
-- `dedupe_key` is the row-grain idempotency guarantee. It hashes
-- carrier + policy number + date + amount + insured + transaction type, PLUS
-- an occurrence ordinal. The ordinal is the point: a statement legitimately
-- containing two identical adjustment lines keeps both, while re-parsing the
-- same file regenerates identical keys and writes nothing new.
--
-- `review_status` is how "unmatched rows are never silently dropped" is
-- enforced in data rather than in a code path: a row that could not be matched
-- is stored with needs_review + a reason, and counted.
-- ------------------------------------------------------------
create table if not exists public.commission_rows (
  id                  uuid        primary key default gen_random_uuid(),
  agent_id            uuid        not null references auth.users(id) on delete cascade,
  statement_id        uuid        not null references public.commission_statements(id) on delete cascade,
  row_index           int         not null default 0,

  carrier             text,
  producer_code       text,
  policy_number       text,
  insured_name        text,
  product             text,
  transaction_type    text        not null default 'unknown',

  amount_cents        bigint      not null default 0,
  premium_cents       bigint,
  commission_rate     numeric,

  transaction_date    date,
  effective_date      date,
  paid_date           date,
  period_start        date,
  period_end          date,

  raw                 jsonb       not null default '{}'::jsonb,
  dedupe_key          text        not null,

  matched_policy_id   uuid        references public.policies(id) on delete set null,
  match_method        text,
  match_confidence    numeric,

  attributed_agent_id uuid        references auth.users(id) on delete set null,
  attribution_method  text,

  review_status       text        not null default 'auto',
  review_reason       text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.commission_rows is
  'Normalized commission statement lines. agent_id is the uploading tenant (the RLS boundary); attributed_agent_id is who wrote the business. Service-role write only.';
comment on column public.commission_rows.dedupe_key is
  'Stable hash of carrier+policy+date+amount+insured+type plus an occurrence ordinal. UNIQUE per agent — re-parsing a statement writes nothing new.';
comment on column public.commission_rows.review_status is
  'auto | needs_review | approved | rejected. A row that could not be matched is stored as needs_review, never dropped.';

create unique index if not exists commission_rows_dedupe_uidx
  on public.commission_rows (agent_id, dedupe_key);
create index if not exists commission_rows_statement_idx
  on public.commission_rows (statement_id, row_index);
create index if not exists commission_rows_agent_date_idx
  on public.commission_rows (agent_id, transaction_date desc);
create index if not exists commission_rows_policy_idx
  on public.commission_rows (matched_policy_id)
  where matched_policy_id is not null;
create index if not exists commission_rows_review_idx
  on public.commission_rows (agent_id, review_status)
  where review_status = 'needs_review';
create index if not exists commission_rows_producer_code_idx
  on public.commission_rows (agent_id, producer_code)
  where producer_code is not null;
create index if not exists commission_rows_attributed_idx
  on public.commission_rows (attributed_agent_id, transaction_date desc)
  where attributed_agent_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'commission_rows_review_status_check'
  ) then
    alter table public.commission_rows
      add constraint commission_rows_review_status_check
      check (review_status in ('auto','needs_review','approved','rejected'));
  end if;
end $$;

alter table public.commission_rows enable row level security;

drop policy if exists commission_rows_select_own on public.commission_rows;
create policy commission_rows_select_own
  on public.commission_rows for select to authenticated
  using (agent_id = auth.uid());

drop trigger if exists commission_rows_touch_updated_at on public.commission_rows;
create trigger commission_rows_touch_updated_at
  before update on public.commission_rows
  for each row execute function public.touch_updated_at();


-- ------------------------------------------------------------
-- 5. get_ingestion_summary() — the numbers the pipeline strip renders.
--
-- One round trip instead of five counting queries from the browser, and it
-- keeps the definition of "pending review" in one place. SECURITY INVOKER
-- (the default) — it reads only through the caller's own RLS, so it cannot
-- return anyone else's figures even by accident.
-- ------------------------------------------------------------
create or replace function public.get_ingestion_summary()
returns table (
  queued          bigint,
  parsing         bigint,
  persisting      bigint,
  matching        bigint,
  ingested        bigint,
  failed          bigint,
  ingested_7d     bigint,
  rows_7d         bigint,
  pending_review  bigint
)
language sql
stable
set search_path = public
as $$
  select
    count(*) filter (where s.status = 'queued'),
    count(*) filter (where s.status = 'parsing'),
    count(*) filter (where s.status = 'persisting'),
    count(*) filter (where s.status = 'matching'),
    count(*) filter (where s.status = 'ingested'),
    count(*) filter (where s.status = 'failed'),
    count(*) filter (where s.status = 'ingested' and s.ingested_at >= now() - interval '7 days'),
    coalesce(sum(s.row_count) filter (where s.status = 'ingested' and s.ingested_at >= now() - interval '7 days'), 0)::bigint,
    (select count(*) from public.commission_rows r where r.review_status = 'needs_review')
  from public.commission_statements s;
$$;

revoke all on function public.get_ingestion_summary() from public;
grant execute on function public.get_ingestion_summary() to authenticated, service_role;
