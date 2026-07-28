# Schema state ledger

**What this is:** the record of which SQL files are confirmed applied to
production (`cweiaibjigjwspmshcrj`). It exists because we have twice shipped
edge functions that referenced schema which was never applied, and neither the
migration directory nor `supabase migration list` tells us the truth — this
project applies schema by manual paste, so migration history does not match
what is actually in the database.

**Rules (agreed 2026-07-28):**

- Every statement run against production comes from an idempotent `.sql` file
  committed to this repo. No ad-hoc SQL.
- **Additive only.** `DROP`, `TRUNCATE`, `DELETE`, `ALTER … DROP COLUMN`, and
  anything touching `auth.*` or `storage.*` require explicit approval first,
  every time.
- Run the audit before and after every apply, and diff the results.
- Wrap each file in a transaction so a partial apply rolls back cleanly.
- Update this file in the same commit as the apply.
- Mechanism is `psql` against the pooler connection string, **not** `db push` —
  `db push` will either skip files or try to replay a history that does not
  match production.

---

## Current baseline — 2026-07-28T01:52Z

Audited by: Claude (Opus 5), at commit `66834f0`, on behalf of Jace.

### Method used for this audit

`psql` is **not installed** on this machine and `SUPABASE_DB_URL` is **not in
`.env.local`** (present keys: `VERCEL_OIDC_TOKEN`, `TELNYX_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `TELNYX_SANDBOX_BRAND_ID`). So this baseline was
established read-only over PostgREST with the service-role key: each object is
requested with `select=<column>&limit=0`, where `200` proves the column exists
and `42703` / `PGRST205` proves it does not. No DDL, no writes.

**This method cannot see functions, triggers, RLS policies, constraints, or
indexes** — only tables and columns. See "Not yet verified" below. Closing that
gap needs `psql` + `SUPABASE_DB_URL`.

### Confirmed applied — column-level checks (13/13 present)

| File | Object checked | Result |
|---|---|---|
| `data/sql/019_messaging_compliance.sql` | `a2p_registrations.agent_id` | present |
| `data/sql/019_messaging_compliance.sql` | `consent_records.consent_type` | present |
| `data/sql/020_texting_broadcasts.sql` | `phone_numbers.a2p_campaign_id` | present |
| `supabase/migrations/20260728_a2p_sole_proprietor.sql` | `a2p_registrations.brand_type` | present |
| `supabase/migrations/20260728_a2p_sole_proprietor.sql` | `a2p_registrations.website_url` | present |
| `supabase/migrations/20260728_a2p_sole_proprietor.sql` | `phone_numbers.sms_capable` | present |
| `supabase/migrations/20260728_a2p_sole_proprietor.sql` | `billing_config.a2p_sole_prop_monthly_fee_mills` | present |
| `supabase/migrations/20260729_compliance_pages.sql` | `agents.dba_name` | present |
| `supabase/migrations/20260729_compliance_pages.sql` | `agents.business_street` | present |
| `supabase/migrations/20260729_compliance_pages.sql` | `agents.lead_vendors` | present |
| `supabase/migrations/20260729_compliance_pages.sql` | `agents.compliance_slug` | present |
| `supabase/migrations/20260729_compliance_pages.sql` | `agents.compliance_page_published_at` | present |
| `supabase/migrations/20260729_compliance_pages.sql` | `compliance_page_revisions.inputs` | present |

So **019, 020, 20260728, and 20260729 are confirmed applied** at the column
level.

### Confirmed applied — table-level sweep (34/35 present)

Every `create table public.<name>` across `data/sql/` and
`supabase/migrations/` was checked for existence. All present except one:

| File | Table | Result |
|---|---|---|
| `supabase/migrations/20260716_number_reputation.sql` | `reputation_config` | **MISSING (PGRST205)** |

Files whose tables are all present: `001`, `002`, `005`, `006`, `007`, `009`,
`010`, `012`, `016`, `019`, `020`, `20260616_agency`, `20260708_email_pipeline`,
`20260708_gmail_accounts`, `20260708_parsed_events`, `20260708_review_queue`,
`20260714_support_tickets`, `20260717_policy_events`,
`20260725_ai_dialer_phase1`, `20260729_compliance_pages`.

Table presence proves the file ran at least in part; it does not prove the
whole file ran. Files that only `ALTER` existing tables are not covered by this
sweep at all.

---

## ⚠ Known gap — `20260716_number_reputation.sql` is NOT applied

Found during this audit, not previously known. **Every** object in the file is
absent from production:

| Object | Probe result |
|---|---|
| `reputation_config` (table) | `PGRST205` — relation not found |
| `phone_numbers.reputation_score` | `42703` |
| `phone_numbers.reputation_checked_at` | `42703` |
| `phone_numbers.reputation_label` | `42703` |

This is the exact failure mode this ledger exists to catch. Three committed
artifacts reference that schema:

- `supabase/functions/telnyx-reputation-monitor/index.ts`
- `supabase/functions/_shared/telnyx-reputation.ts`
- `scripts/setup-telnyx-reputation.mjs`

**Not applied by this session** — it is outside the scope of the work that was
authorised (compliance pages), and it belongs to a separate feature whose
rollout state Jace should confirm first. Two things to establish before
applying: whether `telnyx-reputation-monitor` is currently deployed and on a
cron (if so it has been failing), and whether the Telnyx enterprise/LOA setup
in `scripts/setup-telnyx-reputation.mjs` was ever completed.

The file itself is additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD
COLUMN`), so applying it is low-risk once that is confirmed.

---

## Not yet verified

The PostgREST method cannot reach these. They need `psql` + `SUPABASE_DB_URL`:

- **Functions:** `compliance_slugify`, `compliance_slug_reserve`,
  `agents_sync_compliance_page`, `agents_lock_compliance_slug`,
  `agents_protect_compliance_columns`, `is_admin_agent`, the `wallet_*` RPCs.
- **Triggers on `public.agents`** and their firing order, which the compliance
  page feature depends on — expected order is
  `agents_lock_compliance_slug`, `agents_protect_compliance_columns`,
  `agents_protect_privileged_columns`, `agents_sync_compliance_page`,
  `agents_touch_updated_at`.
- **RLS policies** on `compliance_page_revisions`.
- The unique index `agents_compliance_slug_key` and the
  `agents_business_entity_type_check` constraint.

Behavioural evidence available so far: **0 agents have a `compliance_slug` and
there are 0 rows in `compliance_page_revisions`** — consistent with the business
profile columns being brand new and no agent having saved the Settings form
yet. The first saved profile is what will prove the trigger chain actually
fires; until then the trigger is applied-but-unexercised.

Verification query to run once `psql` is available:

```sql
select tgname from pg_trigger
 where tgrelid = 'public.agents'::regclass and not tgisinternal
 order by tgname;

select proname from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('compliance_slugify','compliance_slug_reserve',
                   'agents_sync_compliance_page','agents_lock_compliance_slug',
                   'agents_protect_compliance_columns');

select public.compliance_slugify('O''Brien & Sons "Insurance" Café');
-- expect: obrien-and-sons-insurance-cafe
```

---

## Blockers for the agreed mechanism

Both are needed before any future apply can follow the rules above:

1. **`psql` is not installed** on this machine (not on `PATH`). Needed to run
   `.sql` files transactionally against the pooler.
2. **`SUPABASE_DB_URL` is not in `.env.local`.** Jace to add it; it must not be
   printed or committed (`.env*` is already gitignored).

Until both exist, schema can only be applied by manual paste in the Dashboard
SQL Editor, and audits are limited to the table/column level shown above.

---

## Apply log

| When (UTC) | File | Applied by | Audit before | Audit after |
|---|---|---|---|---|
| — | `019`, `020`, `20260728`, `20260729` | Jace (manual paste, pre-2026-07-28) | not recorded | 13/13 column checks present, confirmed 2026-07-28T01:52Z |

No schema was applied by this session. The row above records the state
inherited at baseline, not an apply performed here.
