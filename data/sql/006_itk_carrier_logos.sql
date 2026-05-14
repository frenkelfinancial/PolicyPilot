-- ============================================================
-- 006_itk_carrier_logos.sql
--
-- Shared carrier-logo cache for the Settings → Carriers table.
-- Populated by the `itk-quote` edge function (which sees `q.logo`
-- on every quote response) and read by the `itk-companies` edge
-- function so all agents inherit logos without each having to run
-- quotes on their own device first.
--
-- Logos are universal per carrier name — same carrier, same logo
-- regardless of which agent saw it — so this is a single shared
-- table, not per-agent.
-- ============================================================

create table if not exists public.itk_carrier_logos (
  company_name text primary key,
  logo_url     text not null,
  updated_at   timestamptz not null default now()
);

alter table public.itk_carrier_logos enable row level security;

-- Any authenticated agent can read. Writes happen only via the
-- edge function's service-role client; no INSERT/UPDATE policy
-- needed for the anon/auth roles.
drop policy if exists "auth_read_logos" on public.itk_carrier_logos;
create policy "auth_read_logos" on public.itk_carrier_logos
  for select to authenticated using (true);
