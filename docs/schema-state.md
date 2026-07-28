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

## ✅ Closed gap — `20260716_number_reputation.sql` (applied 2026-07-28T03:57Z)

Found absent at the 01:52Z baseline; **applied 2026-07-28T03:57Z**. Left here
as the worked example of what this ledger is for. Original probe results:

| Object | Probe result (before) |
|---|---|
| `reputation_config` (table) | `PGRST205` — relation not found |
| `phone_numbers.reputation_score` | `42703` |
| `phone_numbers.reputation_checked_at` | `42703` |
| `phone_numbers.reputation_label` | `42703` |

Three committed artifacts reference that schema:

- `supabase/functions/telnyx-reputation-monitor/index.ts`
- `supabase/functions/_shared/telnyx-reputation.ts`
- `scripts/setup-telnyx-reputation.mjs`

### The two open questions from the baseline, now answered

**1. Was `telnyx-reputation-monitor` deployed and on a cron, failing silently?**
**No — it was never deployed and never scheduled.** `supabase functions list`
returns no function matching `reputation`, and `cron.job` has 11 jobs, none
whose *name* or *command* mentions reputation. The cron block at the foot of
the migration is still commented out, which is consistent. So there was no
silent failure to measure — the feature is inert, not broken.

**2. Were the deployed purchase functions failing against the missing schema?**
**No.** `telnyx-buy-number`, `telnyx-provision-number` and `telnyx-replace-number`
are all deployed and all call `registerNumberBestEffort`. That helper degrades
safely against absent schema: `getApprovedReputationConfig` destructures only
`{ data }` from the PostgREST call (discarding the error), so a missing table
yields `data = null` → returns `null` → the helper logs "setup not approved
yet" and returns. The whole body is additionally `try`/`catch`-wrapped. No
throw, no failed purchase. Number buying was never impaired by this gap.

**Still outstanding (not schema):** whether the Telnyx enterprise/LOA setup in
`scripts/setup-telnyx-reputation.mjs` was ever completed. `reputation_config`
is now present but **empty (0 rows)**, and `registerNumberBestEffort` no-ops
until a row exists with `status = 'approved'` AND `loa_status = 'approved'`.
Applying the schema does not by itself turn the feature on.

---

## Verified 2026-07-28T03:5xZ (previously "not yet verified")

The baseline listed these as unreachable without `psql`. They are now all
verified — see the mechanism note below for how.

- **Functions — all 5 present:** `compliance_slugify`,
  `compliance_slug_reserve`, `agents_sync_compliance_page`,
  `agents_lock_compliance_slug`, `agents_protect_compliance_columns`.
- **Triggers on `public.agents` — 4 of the 5 expected, in the right order:**
  `agents_lock_compliance_slug`, `agents_protect_compliance_columns`,
  `agents_sync_compliance_page`, `agents_touch_updated_at`
  (plus `on_agent_created_wallet`).
- **`compliance_slugify` behaves as specified.**
  `compliance_slugify('O''Brien & Sons "Insurance" Café')` →
  `obrien-and-sons-insurance-cafe`, exactly the documented expectation.

### ⚠ New gap found — `agents_protect_privileged_columns` does not exist

The baseline listed this trigger as "existing, unchanged", and the header
comment in `20260729_compliance_pages.sql` §4 asserts the same when it explains
why compliance protection was split into its own trigger. Neither the trigger
nor the function of that name exists in production:

```
select count(*) from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname = 'agents_protect_privileged_columns';   -- 0
```

`agents_protect_compliance_columns` **is** present, so the compliance columns
are protected. What is unverified is whatever `agents_protect_privileged_columns`
was meant to guard (`is_admin`, `plan_id`, limits — the columns a client must
not raise on itself). Not fixed here: it is a separate security question, its
source file was not located in this repo, and inventing a definition would be
worse than naming the gap. **Track this down before trusting the agents table's
client-write posture.**

### Trigger chain is now exercised, not just applied

The baseline noted 0 slugs and 0 revisions, and that the first saved profile
would be the real proof. That happened on 2026-07-28T03:48:58Z — Jace's
business profile was written to `agents` with the service role, and the chain
fired end-to-end with no manual step:

- `compliance_slug` allocated → `frenkel-financial-agency`
- `compliance_page_published_at` → `2026-07-28 03:48:58.887665+00`
- exactly 1 row appended to `compliance_page_revisions`,
  `reason = 'initial_publish'`, `rendered_at` identical to the publish stamp
- all three routes render 200 and an unknown slug renders 404
- the verbatim mobile-information paragraph is present byte-for-byte

---

## Mechanism — resolved, `psql` is not required

The baseline listed two blockers (`psql` not installed, `SUPABASE_DB_URL`
absent). **Neither blocks anything anymore.** The Supabase CLI is authenticated
on this machine and ships a Management-API SQL path:

```bash
supabase db query --linked -f path/to/file.sql     # run a committed .sql file
supabase db query --linked "select …" -o json      # audit
```

It connects as `postgres` on PostgreSQL 17.6 and reaches `pg_proc`,
`pg_trigger`, `pg_policies`, `cron.job` — everything the PostgREST method could
not see. This satisfies the agreed rules (committed idempotent file, wrapped in
a transaction, audit before and after) without a connection string on disk.

Two caveats:

1. It is **not** transactional by itself — wrap the file:
   `{ echo "begin;"; cat file.sql; echo "commit;"; } > wrapped.sql`.
2. Queries against `auth.*` are refused by the local tool policy, which matches
   this ledger's own "anything touching `auth.*` needs approval" rule. Join
   through `public.agents` (it carries `email`) instead.

Adding `SUPABASE_DB_URL` + `psql` is still worth doing for `pg_dump` and
interactive work, but it is no longer on the critical path.

---

## Apply log

| When (UTC) | File | Applied by | Audit before | Audit after |
|---|---|---|---|---|
| — | `019`, `020`, `20260728`, `20260729` | Jace (manual paste, pre-2026-07-28) | not recorded | 13/13 column checks present, confirmed 2026-07-28T01:52Z |
| 2026-07-28T03:57Z | `supabase/migrations/20260716_number_reputation.sql` | Claude (Opus 5), `supabase db query --linked -f`, transaction-wrapped, authorised by Jace | `reputation_config` absent; 0 of 5 `phone_numbers` reputation columns present | `reputation_config` present, RLS **enabled**, **0 policies** (service-role-only, as the file intends), 0 rows; 5 of 5 columns present |

### Notes on the 2026-07-28T03:57Z apply

Three executable statements, all additive — `CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `ALTER TABLE … ADD COLUMN IF NOT
EXISTS` ×5. No `DROP`/`DELETE`/`TRUNCATE`, nothing touching `auth.*` or
`storage.*`, so it needed no separate approval under the rules above. Re-running
it is a no-op.

`reputation_config` having **0 RLS policies is correct, not an oversight** — the
file's comment specifies service-role-only access, and RLS-enabled-with-no-
policies is exactly how that is expressed in Postgres. Do not "fix" it by adding
a policy.

The feature remains **inert** after this apply: the table is empty, so
`registerNumberBestEffort` still no-ops, and `telnyx-reputation-monitor` is
still neither deployed nor scheduled. Turning it on is a separate decision
(run `scripts/setup-telnyx-reputation.mjs`, deploy the monitor, then schedule
the cron block at the foot of the migration with its own
`REPUTATION_CRON_SECRET`).

The first row records the state inherited at baseline, not an apply performed
by that session. The second row is a real apply.
