-- ============================================================
-- 20260725_ai_dialer_phase1.sql
-- AI Sales Agent — Phase 0 (compliance schema) + Phase 1 (one AI call).
-- See PROMPT_13_ai_sales_agent_phase1_CLAUDE_CODE.md and
-- docs/ai-sales-agent-build-plan.md.
--
-- Phase 0 is the compliance foundation the homepage already promises
-- (disclosure, instant DNC, quiet hours, kill switch) — it gates every AI
-- call. Phase 1 adds the tables one end-to-end AI qualification call needs.
-- Billing is NOT changed here: AI minutes debit via wallet_debit_ai_minutes
-- (20260723_wallet_ai_minutes.sql), which is already live.
--
-- All money is in mills (1000 mills = $1.00), matching the wallet foundation.
-- Idempotent: safe to run more than once (add-if-not-exists / create-if-not-
-- exists / drop-policy-if-exists). Run in the Supabase SQL Editor.
--
-- KILL SWITCH: ai_dialer_enabled defaults FALSE on both billing_config
-- (global) and agents (per-agent). Nothing dials until BOTH are flipped true.
-- ============================================================

-- ------------------------------------------------------------
-- 1. leads — TCPA consent + DNC + lead-local timezone.
--    An AI voice is an "artificial voice" under the TCPA; marketing calls
--    to cell phones need prior express written consent. These columns are
--    the server-side source of truth the ai-call-start gate reads.
-- ------------------------------------------------------------
alter table public.leads
  add column if not exists tcpa_consent        boolean not null default false,
  add column if not exists tcpa_consent_source text,
  add column if not exists tcpa_consent_at     timestamptz,
  add column if not exists dnc                 boolean not null default false,
  add column if not exists dnc_at              timestamptz,
  add column if not exists lead_timezone       text;

comment on column public.leads.tcpa_consent is
  'Prior express written consent to be contacted by the agent. Un-consented leads are NOT callable by the AI dialer (server-side gate in ai-call-start). Default false — consent is opt-in, never assumed.';
comment on column public.leads.tcpa_consent_source is
  'Where consent came from (import attestation batch, web form, etc.) — the paper trail if a TCPA claim is ever raised.';
comment on column public.leads.dnc is
  'Do-not-call flag for this specific lead. Set true instantly when a call ends with outcome dnc_request. Honored by ai-call-start alongside suppression_list.';
comment on column public.leads.lead_timezone is
  'Optional IANA timezone for lead-local quiet-hours. Nullable: when null, ai-call-start derives the zone from the area code and falls back to the most restrictive interpretation for unmapped/toll-free numbers (see _shared/tcpa.ts).';

-- ------------------------------------------------------------
-- 2. suppression_list — per-agent + global "never call again".
--    agent_id null = a GLOBAL suppression (applies to every agent).
--    Any "stop calling me" writes a row here instantly; every future
--    ai-call-start checks it.
-- ------------------------------------------------------------
create table if not exists public.suppression_list (
  id             uuid primary key default gen_random_uuid(),
  agent_id       uuid references auth.users(id) on delete cascade,  -- null = global
  phone_e164     text not null,
  reason         text,
  source_call_id text,
  created_at     timestamptz not null default now()
);

comment on table public.suppression_list is
  'Do-not-call suppression. agent_id null = global (applies to all agents); non-null = scoped to that agent. Written by the AI call webhook on a dnc_request outcome and by any future manual "remove me" path. Read by ai-call-start before every dial. Writes are service-role only (RLS below).';

-- Uniqueness: NULLs are "distinct" to a normal UNIQUE constraint, so a plain
-- unique(agent_id, phone_e164) would let the SAME global number be inserted
-- many times. Two partial unique indexes enforce it correctly for both the
-- per-agent and the global (agent_id is null) case.
create unique index if not exists suppression_list_agent_phone_uidx
  on public.suppression_list (agent_id, phone_e164)
  where agent_id is not null;

create unique index if not exists suppression_list_global_phone_uidx
  on public.suppression_list (phone_e164)
  where agent_id is null;

-- Hot path: "is this phone suppressed for this agent (or globally)?"
create index if not exists suppression_list_phone_idx
  on public.suppression_list (phone_e164);

alter table public.suppression_list enable row level security;

-- Agents may READ their own suppression rows. Writes happen ONLY through the
-- service-role edge functions (the webhook), never from the browser — so
-- there is no insert/update/delete policy (RLS defaults to deny, service_role
-- bypasses RLS). Global rows (agent_id null) are enforced server-side.
drop policy if exists "suppression_list_select_own" on public.suppression_list;
create policy "suppression_list_select_own"
  on public.suppression_list for select
  using (auth.uid() = agent_id);

-- ------------------------------------------------------------
-- 3. ai_dialer_sessions — one row per AI dial batch. Mirrors the
--    public.dialer_sessions shape (status / lead_ids / caller-id config)
--    so the Phase 3 batch runner and Phase 4 UI reuse the same mental
--    model as the human power dialer. Phase 1 does not require a session
--    row (ai-call-start places a single call and writes ai_calls directly);
--    this table exists so the schema is complete for later phases.
-- ------------------------------------------------------------
create table if not exists public.ai_dialer_sessions (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references auth.users(id) on delete cascade,
  lead_ids          uuid[] not null default '{}',
  status            text not null default 'pending'
    check (status in ('pending','running','paused','completed','cancelled','error')),
  caller_id_mode    text,          -- 'fixed' | 'smart_local' (mirrors dialer_sessions)
  caller_id_fixed   text,
  caller_id_numbers text[],
  assistant_id      text,          -- Telnyx AI Assistant id used for this batch
  started_at        timestamptz,
  ended_at          timestamptz,
  created_at        timestamptz not null default now()
);

comment on table public.ai_dialer_sessions is
  'One row per AI dial batch (Phase 3+). Mirrors public.dialer_sessions. lead_ids holds public.leads.id (uuid) values, unlike the human dialer which stores client_id text — the AI tables reference leads by their canonical uuid throughout.';

create index if not exists ai_dialer_sessions_agent_status_idx
  on public.ai_dialer_sessions (agent_id, status);

alter table public.ai_dialer_sessions enable row level security;

drop policy if exists "ai_dialer_sessions_select_own" on public.ai_dialer_sessions;
create policy "ai_dialer_sessions_select_own"
  on public.ai_dialer_sessions for select
  using (auth.uid() = agent_id);

drop policy if exists "ai_dialer_sessions_insert_own" on public.ai_dialer_sessions;
create policy "ai_dialer_sessions_insert_own"
  on public.ai_dialer_sessions for insert
  with check (auth.uid() = agent_id);

drop policy if exists "ai_dialer_sessions_update_own" on public.ai_dialer_sessions;
create policy "ai_dialer_sessions_update_own"
  on public.ai_dialer_sessions for update
  using (auth.uid() = agent_id);

-- ------------------------------------------------------------
-- 4. ai_calls — one row per AI call. The audit + transcript record, and
--    the debit reference (call_control_id = wallet_ledger ref_id).
-- ------------------------------------------------------------
create table if not exists public.ai_calls (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid references public.ai_dialer_sessions(id) on delete set null,
  agent_id          uuid not null references auth.users(id) on delete cascade,
  lead_id           uuid references public.leads(id) on delete set null,
  phone_e164        text not null,
  from_e164         text,          -- caller ID the AI call was placed from
  call_control_id   text,
  telnyx_call_leg_id text,
  status            text not null default 'in_progress',
  outcome           text
    check (outcome in ('voicemail','no_answer','busy','not_interested',
                       'qualified','dnc_request','error','in_progress')),
  transcript        jsonb,
  summary           text,
  duration_secs     int,
  billed_minutes    int,
  started_at        timestamptz,   -- dial time (set by ai-call-start)
  answered_at       timestamptz,   -- when the lead answered (set by the webhook); talk-time billing anchors here
  ended_at          timestamptz,
  created_at        timestamptz not null default now()
);

comment on table public.ai_calls is
  'One row per AI Sales Agent call. THIS is the AI call''s activity/disposition record (outcome, summary, transcript, duration) — deliberately NOT written into public.calls, because that table feeds the human dialer''s monthly minute cap (telnyx-bridge/signalwire-bridge) and the Summary dial/contact analytics (both sum calls.duration_sec unfiltered), and AI minutes must not pollute either. The Phase 4 lead-timeline UI unions ai_calls (by lead_id) with calls for display. call_control_id doubles as the wallet_ledger ref_id for the ai_call debit — the unique index below plus the partial unique index on wallet_ledger make a replayed webhook unable to double-charge.';
comment on column public.ai_calls.answered_at is
  'Set from the call.answered event. billed_minutes is computed from answered_at -> ended_at (talk time), so a never-answered call or an AMD-detected voicemail bills 0 — mirrors the human dialer''s answered_at-anchored rounding.';

-- Webhook idempotency + debit reference: at most one ai_calls row per Telnyx
-- call, and the webhook looks the row up by this id.
create unique index if not exists ai_calls_call_control_id_uidx
  on public.ai_calls (call_control_id)
  where call_control_id is not null;

create index if not exists ai_calls_agent_created_idx
  on public.ai_calls (agent_id, created_at desc);
create index if not exists ai_calls_lead_idx
  on public.ai_calls (lead_id);

alter table public.ai_calls enable row level security;

-- Agents READ their own AI calls (history/transcript in the Phase 4 UI).
-- Writes are service-role only (ai-call-start / ai-call-webhook) — no
-- insert/update policy for authenticated, so RLS denies client writes.
drop policy if exists "ai_calls_select_own" on public.ai_calls;
create policy "ai_calls_select_own"
  on public.ai_calls for select
  using (auth.uid() = agent_id);

-- ------------------------------------------------------------
-- 5. billing_config — kill switch, quiet-hours window, AI call-start floor.
--    billing_config is the singleton id = 1 row.
-- ------------------------------------------------------------
alter table public.billing_config
  add column if not exists ai_dialer_enabled       boolean  not null default false,
  add column if not exists ai_quiet_start          smallint not null default 8,   -- 8am lead-local
  add column if not exists ai_quiet_end            smallint not null default 21,  -- 9pm lead-local
  add column if not exists min_ai_call_start_mills bigint   not null default 150; -- ~2 min buffer @ 75 mills

comment on column public.billing_config.ai_dialer_enabled is
  'GLOBAL kill switch for the AI Sales Agent dialer. Default FALSE — no AI call can start until this is true AND the per-agent agents.ai_dialer_enabled is true.';
comment on column public.billing_config.ai_quiet_start is
  'Earliest lead-local hour (0-23) the AI dialer may call. Default 8 (8am). Paired with ai_quiet_end for the [start, end) window.';
comment on column public.billing_config.ai_quiet_end is
  'Latest lead-local hour (0-23, exclusive) the AI dialer may call. Default 21 (9pm).';
comment on column public.billing_config.min_ai_call_start_mills is
  'Minimum wallet balance (mills) required to START an AI call — a ~2-minute buffer at the base AI rate (75 mills/min). Mirrors min_call_start_mills for the human dialer.';

update public.billing_config
   set ai_dialer_enabled       = coalesce(ai_dialer_enabled, false),
       ai_quiet_start          = coalesce(ai_quiet_start, 8),
       ai_quiet_end            = coalesce(ai_quiet_end, 21),
       min_ai_call_start_mills = coalesce(min_ai_call_start_mills, 150)
 where id = 1;

-- ------------------------------------------------------------
-- 6. agents — per-agent kill switch (default OFF).
-- ------------------------------------------------------------
alter table public.agents
  add column if not exists ai_dialer_enabled boolean not null default false;

comment on column public.agents.ai_dialer_enabled is
  'Per-agent AI dialer kill switch. Default FALSE. Both this and billing_config.ai_dialer_enabled must be true for ai-call-start to place a call.';

-- ------------------------------------------------------------
-- 7. wallet_ledger — DB-level idempotency backstop for AI-call debits.
--    The webhook pre-checks for an existing ai_call debit by ref_id, but a
--    concurrent double-fire could still slip two debits between the check
--    and the insert. This partial unique index makes the SECOND debit fail
--    with 23505, which the webhook swallows as an idempotent no-op — so a
--    replayed/duplicated Telnyx webhook can NEVER double-charge a wallet.
--    (No existing ai_call rows yet, so adding the index is safe.)
-- ------------------------------------------------------------
create unique index if not exists wallet_ledger_ai_call_ref_uidx
  on public.wallet_ledger (ref_id)
  where category = 'ai_call' and entry_type = 'debit';

-- ------------------------------------------------------------
-- 8. Realtime — the Phase 4 UI subscribes to these like the Power Dialer
--    modal subscribes to dialer_sessions, so webhook-driven status/outcome
--    changes push live without polling.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'ai_dialer_sessions'
  ) then
    alter publication supabase_realtime add table public.ai_dialer_sessions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'ai_calls'
  ) then
    alter publication supabase_realtime add table public.ai_calls;
  end if;
end $$;
