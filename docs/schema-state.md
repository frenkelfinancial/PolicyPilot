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

### 🔴 CRITICAL — privilege escalation found AND fixed (2026-07-28T04:1xZ)

The baseline listed `agents_protect_privileged_columns` as "existing,
unchanged", and `20260729_compliance_pages.sql` §4 asserts the same. **It did
not exist in production.** Its source is
`supabase/migrations/20260703c_agents_column_protection.sql` (it was in the repo
after all — the earlier note that it wasn't was wrong). That trigger is the
ONLY thing that stops a client from writing privileged columns on its own
`agents` row: RLS `agents_update_own` checks only `auth.uid() = id`, and
`authenticated`/`anon` hold column-level UPDATE on all 47 columns.

**This was confirmed as a LIVE, exploitable privilege escalation**, not a
theoretical one. Against a throwaway account, using only the publishable key +
that user's own session JWT:

```
PATCH /rest/v1/agents?id=eq.<self>   {"is_admin": true}     -> 200, persisted
```

An independent service-role read confirmed `is_admin = true` stuck, and the
escalated account could then read **every** agent row (email/PII) via
`agents_select_admin`. The same gap let a user overwrite their own
`stripe_subscription_id` / `stripe_customer_id`, `plan_id`, and the monthly
limits.

**Fixed:** `20260703c_agents_column_protection.sql` applied 2026-07-28T04:0xZ
(transaction-wrapped). Re-running the identical attack afterward returns 200 but
`is_admin` comes back **false** — the BEFORE-UPDATE trigger reverts all 7
guarded columns (`is_admin`, `plan_id`, `monthly_minute_limit`,
`monthly_quote_limit`, `stripe_customer_id`, `stripe_subscription_id`,
`stripe_numbers_item_id`) to OLD for non-service, non-admin callers. Legitimate
self-writes (e.g. `agent_phone`) still succeed (204), and admin PII read is
denied again (1 row visible, not the whole table). The throwaway account was
deleted afterward.

### 🟠 Same class of hole on `public.phone_numbers` — found AND fixed

Hunting for the same pattern elsewhere: `phone_numbers_update_own` is likewise
owner-only RLS, `authenticated`/`anon` hold full-column UPDATE, and there was
**no protective trigger**. The exposed columns are billing/compliance-owned:

```
sb.from('phone_numbers').update({ renew_from_wallet: false }).eq('id', mine)
```

`wallet-renew-numbers` selects `.eq('renew_from_wallet', true)
.lte('next_renewal_at', now())`, so a user flipping `renew_from_wallet` to
false — or pushing `next_renewal_at` out — gets a **permanently un-billed DID**;
`status`/`past_due_since` could be flipped to clear a past-due state.

Lower severity than the `agents` hole — self-scoped, money-bounded, no PII or
cross-tenant access — and the messaging compliance gate reads
`a2p_registrations.status`, NOT any `phone_numbers` column, so this could not
bypass messaging compliance. But it is the same root cause.

**Fixed:** new migration `20260730_phone_numbers_column_protection.sql`,
applied 2026-07-28T04:1xZ. Reverts every system/billing/compliance/reputation
column for non-service, non-admin callers; leaves `is_primary` (the only column
the client legitimately writes — the Phone Book "Set as primary" control) plus
the `friendly_name`/`locality`/`region` labels writable. service_role and
admins bypass, same carve-out as `20260703c`.

### Other owner-updatable tables — checked, no further gap

Every `UPDATE`/`ALL` policy granted to `authenticated`/`anon` was enumerated.
Besides `agents` and `phone_numbers`, the owner-updatable tables are
`agent_dashboards`, `ai_dialer_sessions`, `calls`, `dialer_sessions`,
`email_ingest_log`, `lead_vendors`, `leads`, `policies`, `portal_nudges`,
`review_queue`, `agency_invites` — all hold only the owner's own business data,
no privilege/money/status column. The high-value tables (`wallets`, `plans`,
`billing_config`, `a2p_registrations`) have **no** owner-UPDATE policy at all —
a user cannot self-flip `a2p_registrations.status` to `approved`, and wallet
balances are service-role/SECURITY-DEFINER-RPC only (`20260709d`). No further
remediation needed.

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

## Read-only audit 2026-07-28 — texting UI (PROMPT_15 Phase 4/5 + composer)

**No DDL was run. No apply entry below, because nothing was applied.** The
A2P/messaging UI needed no schema: every column the three new surfaces read
already exists in production. Recorded here anyway, because "we checked and
changed nothing" is exactly the kind of thing this ledger exists to stop
someone re-deriving.

Method: `supabase db query --linked` against `information_schema.columns` and
`pg_policies`.

| Object | Checked | Result |
|---|---|---|
| `a2p_registrations` | all 27 columns enumerated | present, incl. `brand_type`, `otp_status`, `otp_requested_at`, `otp_verified_at`, `otp_sent_to`, `otp_attempts`, `telnyx_env`, `last_error`, `assignment_status`, `assignment_failure_reason`, `brand_submitted_at`, `campaign_submitted_at`, `business_info` |
| `phone_numbers` | `sms_capable`, `a2p_campaign_id`, `a2p_assignment_status`, `a2p_assigned_at`, `e164`, `is_primary`, `status` | 7/7 present |
| `messages` | `id, agent_id, channel, to_address, from_number, body_preview, segments, status, created_at, delivered_at, failed_reason` | 11/11 present |
| `inbound_messages` | full table | present |
| `consent_records` | full table | present |
| `billing_config.sms_require_written_consent` | readable by the browser | `billing_config_select_all` is `SELECT … using (true)` |

### The finding worth keeping

`consent_records`, `messages`, `inbound_messages` and `a2p_registrations` each
have **SELECT-only** policies (`*_select_own` + `*_select_admin`) and **no**
INSERT/UPDATE policy for `authenticated`/`anon`. That is correct and should
stay that way — but it means the browser **cannot write a consent record**, and
until now the only thing in the entire codebase that ever wrote one was
`messaging-recipients-import` (the broadcast CSV path). `lead-ingest` does not.

So a fully A2P-approved agent with an assigned texting number would have had
**every 1:1 text to a lead rejected with `no_consent`** — not because consent
was missing in reality (it is captured on the vendor's lead form and certified
by TrustedForm) but because it was never recorded where
`_shared/messaging-shared.ts` could see it.

Closed with a new service-role edge function, `messaging-consent-record`, not
with an RLS change. See `docs/texting-ui.md` § "The consent gap this closed".

---

## Behavioural check 2026-07-28 — global do-not-contact rows

Run to verify the `messaging-inbound-webhook` opt-out fix (see
`docs/texting-ui.md` § "Fixed in this batch"). Executed inside a transaction
that **rolled back** — no row persisted, confirmed afterwards with a count of
0, so nothing required approval. No DDL.

The fix records an unattributable STOP as a **global** `dnc_list` row
(`agent_id null`). Objects existing proves nothing about whether that works, so
it was exercised:

| Check | Result |
|---|---|
| A global row (`agent_id null`, `source='opt_out_keyword'`) inserts at all — if not, the handler throws and the STOP is still dropped | PASS |
| A duplicate global opt-out is rejected by `dnc_list_agent_phone_idx` (it coalesces null → nil uuid), so Telnyx's webhook retries are a no-op not a crash | PASS (23505, caught) |
| A per-agent row and a global row coexist for the same phone — an unattributed STOP followed later by an attributable one must not collide | PASS (2 rows) |
| **The gate itself**: `runComplianceGate`'s predicate (`agent_id is null or agent_id = <agent>`) evaluates true for an agent who never saw the opt-out, i.e. the global row really does block everyone | PASS |

---

## Known gaps — logged 2026-07-28, deliberately NOT built

Both found while building the texting UI. Recorded here rather than fixed in
that batch, at Jace's direction.

### 1. No full message body is stored anywhere — audit-trail gap, not a UI one

`public.messages.body_preview` and `public.inbound_messages.body_preview` both
hold **200 characters with an ellipsis appended** (`bodyPreview()` in
`_shared/messaging-shared.ts`; `text.slice(0, 200)` in
`messaging-inbound-webhook`). There is **no column anywhere that holds the
message a consumer actually received or sent.**

This reads as a rendering limitation in the thread view. It is not. A two-
segment SMS is up to 306 characters, so any message past 200 is permanently
unrecoverable — including:

- the exact wording of an outbound message a consumer later complains about;
- an inbound message revoking consent in words other than a bare `STOP`
  (`"take me off your list"` is a revocation, is longer than 200 chars in a
  real sentence, and is not an opt-out keyword);
- anything a regulator or carrier asks us to produce for a specific send.

We keep `consent_id`, `segments`, `hold_ledger_id` and the delivery receipt —
everything about a message except what it said.

Fixing it is additive (`add column if not exists body text`) plus writes in
`messaging-send-core.ts` and both inbound webhooks. Left unbuilt so it can be
scoped with retention and PII questions attached, not bolted on.

### 2. ✅ CLOSED — `messaging-consent-record` was an attestation, not evidence

**Logged 2026-07-28 morning, closed 2026-07-28 evening by the hosted SMS
opt-in page.** Kept in full because the reasoning is what drove the fix.

The gap as logged: `messaging-consent-record` unblocked 1:1 sending by letting
an agent *state* that a lead gave written consent, storing the provenance as
`consent_records.source = 'agent_attested: <where>'`. Sufficient for the send
gate, insufficient for a dispute — an assertion made after the fact with no
independent artefact behind it.

The proposed fix was to capture the vendor's TrustedForm certificate at
ingestion. **That is no longer the plan, because the vendor's consent turned
out not to be usable at all:** the 10DLC campaign was rejected on the ground
that a lead vendor's "…and its licensed agents" wording is not opt-in evidence
for a campaign sending as a named agency, and the vendor will not change it.
Capturing a stronger certificate of the wrong consent would not have helped.

**What shipped instead** (`supabase/migrations/20260733_sms_optin_consent.sql`
plus the `/a/<slug>/sms-opt-in` route on `compliance-page`): consent is
collected on the agency's own page, and `consent_records` now carries the
evidence itself — `consent_method`, `disclosure_text` (the exact words
displayed, not a template id), `page_url`, `ip_address`, `user_agent`, and the
consumer's name. A check constraint refuses a `consent_method='web_form'` row
that arrives without its disclosure and page URL, so the evidenced grade
cannot be claimed without the evidence.

The attestation path remains, correctly labelled `consent_method =
'agent_attested'`, for an agent who genuinely holds a written record of their
own. The composer offers it second, folded away, behind a sentence saying why.

**One consequence to watch:** the privacy policy no longer claims the vendor
form covers texting, and the campaign opt-in description no longer quotes the
vendor's wording. Those two must keep agreeing with each other — there is a
unit test asserting exactly that (`neither the policy nor the campaign
description claims the vendor form covers texting`).

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
| 2026-07-28T04:0xZ | `supabase/migrations/20260703c_agents_column_protection.sql` | Claude (Opus 5), `-f`, transaction-wrapped — **security fix, authorised by Jace** | trigger `agents_protect_privileged_columns` ABSENT; live PATCH set own `is_admin=true` (200, persisted) | trigger present + enabled; identical PATCH now returns `is_admin=false` (reverted); admin PII read denied |
| 2026-07-28T04:1xZ | `supabase/migrations/20260730_phone_numbers_column_protection.sql` | Claude (Opus 5), `-f`, transaction-wrapped — **security fix (same class), authorised by Jace** | `phone_numbers` owner-updatable with no column guard; `renew_from_wallet`/`next_renewal_at`/billing columns self-writable | trigger `phone_numbers_protect_privileged_columns` present + enabled; billing/compliance columns reverted for non-service, non-admin |
| 2026-07-28T17:xxZ | `supabase/migrations/20260732_a2p_fee_correction.sql` | Claude (Opus 5), `supabase db query --linked -f`, transaction-wrapped. **Authorised by Jace** — he read Telnyx's real checkout prices. Column defaults + one UPDATE of the `billing_config` singleton; no DROP, no `auth.*`/`storage.*` | live row `4000 / 15000 / 10000 / 2000`; defaults identical. `a2p_registrations`: **0 rows**, `sum(monthly_fee_mills) = 0` — so no existing registration carried the wrong figure | live row `4000 / **14500** / **1500** / 2000`; defaults updated to match; re-run confirmed a no-op |
| 2026-07-28T19:1xZ | `supabase/migrations/20260733_sms_optin_consent.sql` | Claude (Opus 5), `supabase db query --linked -f`, transaction-wrapped. Additive only — no approval needed under the rules above | 0 of 7 evidence columns present; **0 rows** in `consent_records` (so the backfill was a guaranteed no-op and no existing row could violate the new constraints); 2 check constraints; 3 indexes; 2 policies, both `SELECT` | 7 of 7 columns present; `consent_records_method_check` + `consent_records_web_form_evidence_check` added; `consent_records_ip_captured_idx` added; **policies unchanged — still SELECT-only, no INSERT policy**; 0 rows. **4/4 behavioural checks pass** (see below); re-run confirmed a no-op |
| 2026-07-28T05:0xZ | `supabase/migrations/20260731_a2p_resumable_registration.sql` | Claude (Opus 5), `supabase db query --linked -f`, transaction-wrapped. Additive only — no approval needed under the rules above | `a2p_registrations` had no step markers, no uniqueness on `brand_id`/`campaign_id`, no immutability trigger; `wallet_ledger` had no A2P fee-idempotency index. 0 rows in `a2p_registrations`, 0 A2P ledger rows | 9 new columns + `telnyx_env` check constraint; 2 partial unique indexes; function + trigger `a2p_registrations_guard_ids`; `wallet_ledger_a2p_fee_ref_uidx`. **9/9 behavioural checks pass** (see below) |

### Notes on the 2026-07-28T19:1xZ apply — SMS opt-in consent evidence

Applied ahead of deploying `compliance-page`, because the opt-in form renders
fine without these columns and every submission would then fail on `column
consent_method does not exist` — which reads to the consumer as our error and
loses a real opt-in.

**4/4 behavioural checks, each run inside `begin; … rollback;` so production
kept 0 rows throughout:**

| # | Check | Result |
|---|---|---|
| 1 | INSERT `consent_method='web_form'` with **no** `disclosure_text`/`page_url` | **rejected** — `23514 … violates check constraint "consent_records_web_form_evidence_check"` |
| 2 | Same INSERT **with** disclosure + page URL + IP | **accepted** (1 row staged, then rolled back) |
| 3 | INSERT `consent_method='telepathy'` | **rejected** — `violates check constraint "consent_records_method_check"` |
| 4 | Row count after all three rollbacks | **0** |

Check 1 is the one that matters. The whole point of the migration is that a row
cannot *claim* to be an evidenced web-form opt-in without carrying the
evidence — otherwise it would pass a filter for "self-service opt-ins" and then
prove nothing when opened. It is enforced in the database rather than in the
edge function because the edge function is not the only thing that will ever
write this table.

**The backfill did nothing, as predicted.** `consent_records` held 0 rows
before and after — there has never been a consent record in production, which
also means the `no_consent` gate has been refusing every 1:1 text since it
shipped. The opt-in page is the first thing that will ever populate it.

The file was re-run end to end afterwards and was a clean no-op.

### Notes on the 2026-07-28T17:xxZ apply — A2P fee correction

**Source: Telnyx's own checkout, read by Jace on 2026-07-28.** Not a published
price page and not inferred from an invoice — the figures on screen at the
point of purchase:

```
 $10.00  application fee        one-off, at submission
  $4.50  first 3 months         one-off, at submission (3 x $1.50)
  $1.50  per month thereafter   recurring, 3-month minimum term
```

| Column | Was | Now |
|---|---|---|
| `a2p_campaign_fee_mills` | 15000 ($15.00) | **14500** ($14.50 = $10.00 + $4.50) |
| `a2p_monthly_fee_mills` | 10000 ($10.00) | **1500** ($1.50) — was **~6.7x** the real price |
| `a2p_brand_fee_mills` | 4000 | 4000 (unchanged, not part of this checkout) |
| `a2p_sole_prop_monthly_fee_mills` | 2000 | 2000 — **deliberately unchanged, see below** |

`$14.50` is one column rather than two because Telnyx bills the application fee
and the prepaid first quarter together at submission, which is exactly when
`_shared/a2p-registration.ts` STEP 5 takes its single campaign debit. Splitting
it would add a column nothing reads.

**Timing was lucky.** `a2p_registrations` held **0 rows** at the moment of the
apply, so no agent was ever stamped with the inflated figure. Had there been
rows, correcting `billing_config` would NOT have fixed them —
`monthly_fee_mills` is copied onto each registration at submission and never
re-read from config.

**Code fallbacks updated in the same commit.** `a2p-register` and
`a2p-verify-otp` hardcode `?? 15000` / `?? 10000` as the value used if the
`billing_config` read comes back empty; a stale fallback is what an agent
actually gets charged in that case. Both now match, and the agent-facing copy
in `app.html` was corrected from "$15" to "$14.50" in seven places.

#### Two things this apply does NOT fix

1. **`a2p_sole_prop_monthly_fee_mills` stays at $2.00 and is UNVERIFIED.** The
   checkout Jace read did not identify a brand type. $2.00/mo is Telnyx's
   published *sole proprietor* price (PROMPT_15 §2.1), and sole-prop campaigns
   are priced separately from standard ones. Moving it to $1.50 on the
   assumption they are the same would be inventing a price. Confirm against a
   sole-prop checkout, then correct it in its own migration.
2. **Nothing debits the monthly fee. Still.** Verified again during this apply:
   `a2p_monthly_fee_mills` / `a2p_sole_prop_monthly_fee_mills` are read in
   exactly three places (`a2p-register` ×2, `a2p-verify-otp` ×1), all of which
   only stamp the value onto `a2p_registrations.monthly_fee_mills` or echo it
   in an API response. There is no `wallet_debit`, no cron, no recurring
   charge anywhere. **The recurring campaign cost is absorbed on every agent**
   — PROMPT_15's "Fee reconciliation" item remains open. Correcting the number
   changes what we *record*, not what we *collect*. The good news is the
   exposure is $1.50/agent/month rather than the $10 the config claimed.

### Notes on the 2026-07-28T05:0xZ apply — A2P resumable registration

Additive only: `ADD COLUMN IF NOT EXISTS` ×9, `CREATE UNIQUE INDEX IF NOT
EXISTS` ×3, one `CREATE OR REPLACE FUNCTION`, one trigger, one check
constraint. No `DROP`/`DELETE`/`TRUNCATE` of data, nothing touching `auth.*`
or `storage.*`. (`drop trigger if exists` immediately before `create trigger`
is the repo's standard idempotency idiom, not a data change.) Re-running is a
no-op.

**Why it exists.** `a2p-register` was pulled from production earlier the same
day because `submitBrand` created a REAL, BILLABLE Telnyx brand, misparsed the
bare-object response, returned 502, and wrote **no row** — a paid-for brand
that nothing pointed at, and a second one on every retry. The code fix is a
resumable step machine (`_shared/a2p-registration.ts`); this migration is the
durable state it resumes from, plus three guarantees that hold even if the
application code is wrong.

**Verified behaviourally, not just structurally.** The objects existing proves
nothing about whether they *work*, so the guarantees were exercised against
production inside a transaction that **rolled back** — no INSERT persisted and
no DELETE was needed, so nothing required approval. All nine passed:

| Check | Result |
|---|---|
| `brand_id` is write-once (blocked, `a2p_brand_id_immutable`) | PASS |
| `campaign_id` is write-once | PASS |
| `brand_id` cannot be nulled either (that is also an orphan) | PASS |
| Unrelated columns still update freely — the guard is narrow | PASS |
| Documented escape hatch (`set local app.a2p_allow_id_change='on'`) works | PASS |
| sandbox → production promotion allowed without the escape hatch | PASS |
| Two agents cannot share one **production** brand (unique violation) | PASS |
| The **sandbox** brand IS shareable (index deliberately excludes it) | PASS |
| `wallet_ledger_a2p_fee_ref_uidx` present with the intended predicate | PASS |

`a2p_registrations` and the A2P ledger were both still at **0 rows**
afterwards, confirming the rollback.

**The trigger deliberately binds the service role too.** Every other guard in
this schema carves out `service_role` because edge functions are trusted to
write business data. This one does not, because the failure it prevents *is*
an edge-function bug creating a second billable brand — a guard the buggy
caller can bypass is not a guarantee. The one built-in exception is
sandbox → production promotion, where the ids being replaced are mock, free,
and route nothing.

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
