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
| 2026-07-29T02:3xZ | `supabase/migrations/20260734_lead_source_categories.sql` | Claude (Opus 5), `supabase db query --linked -f`, transaction-wrapped. **Data only, no DDL** — one `UPDATE` of the `lead_vendors` array on agent rows still holding a retired vendor key. Additive under the rules (no DROP/DELETE/TRUNCATE, nothing in `auth.*`/`storage.*`) | 1 published agent row, `lead_vendors = {goatleads}`; 1 row in `compliance_page_revisions` | `lead_vendors = {lead_partners}`; verification block passed (0 rows still holding a legacy value); `agents_sync_compliance_page` fired and appended revision #2, as intended — the policy text genuinely changed. Re-run is a no-op |
| 2026-07-29T02:4xZ | `supabase/migrations/20260735_backfill_frenkel_a2p_registration.sql` | Claude (Opus 5), `supabase db query --linked -f`, transaction-wrapped. **Data only, no DDL** — one `INSERT … on conflict do nothing`. **Authorised by Jace** ("create the a2p_registrations row … without calling a2p-register") | `a2p_registrations`: **0 rows**. `wallet_ledger` a2p rows: **0**. Texting blocked at the gate for want of any row at all | 1 row: `status='pending'`, `telnyx_env='production'`, brand `4b20019f-…`/`BBTQ508`, campaign `4b30019f-…`/`CD2166Q`, both `*_fee_charged_at` set. `wallet_ledger` a2p rows still **0** — nothing charged. `a2p-status-poll` then promoted it to `approved` off live Telnyx (`{"approved":1}`) |
| 2026-07-28T05:0xZ | `supabase/migrations/20260731_a2p_resumable_registration.sql` | Claude (Opus 5), `supabase db query --linked -f`, transaction-wrapped. Additive only — no approval needed under the rules above | `a2p_registrations` had no step markers, no uniqueness on `brand_id`/`campaign_id`, no immutability trigger; `wallet_ledger` had no A2P fee-idempotency index. 0 rows in `a2p_registrations`, 0 A2P ledger rows | 9 new columns + `telnyx_env` check constraint; 2 partial unique indexes; function + trigger `a2p_registrations_guard_ids`; `wallet_ledger_a2p_fee_ref_uidx`. **9/9 behavioural checks pass** (see below) |

### Notes on the 2026-07-29T02:4xZ apply — backfilling the A2P registration

**The fee-guard columns are the reason this file is more than an INSERT.**
`advanceRegistration()` decides whether to call `wallet_debit` by checking
`brand_fee_charged_at` / `campaign_fee_charged_at` for NULL (steps 2 and 5 in
`_shared/a2p-registration.ts`). Backfilling a row with those NULL would leave a
loaded gun: the next press of Retry on the status wizard, or any future
`a2p-register` call for this agent, would debit $4 + $14.50 from Jace's wallet
for a brand and campaign he had already paid Telnyx for directly.

They are set to Telnyx's own `createdAt` / `billedDate`, and `business_info`
records in as many words that the money moved on Telnyx's invoice rather than
through the ProducerStack wallet. `wallet_ledger` held 0 rows with `ref_type in
('a2p_brand','a2p_campaign')` before and after, and still does.

**`status` was inserted as `'pending'`, never `'approved'`.** `'approved'` is
the single value `runComplianceGate()` allowlists, so writing it from a SQL
file would be asserting a carrier outcome instead of observing one. `'pending'`
is the state that means "ask Telnyx", and `a2p-status-poll` — which selects
exactly `status in ('pending','approved')` with non-null brand and campaign ids
— read live Telnyx (`identityStatus: VERIFIED`, `campaignStatus:
TCR_ACCEPTED`) and promoted it itself on the next run.

The auto-assign pass in that same run **skipped** (`auto_assign_skipped: 1`),
correctly: it only acts for an agent owning exactly one active number, and this
agent owns two. No number was assigned, so nothing became `sms_capable` and
texting remains gated on that.

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

---

## Apply 2026-07-28 — `20260736_agency_leader_gate_hardening.sql`

Phase A of the Team Leader / downline work. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Three `CREATE OR REPLACE FUNCTION` statements, no DDL on
tables, no data change, nothing touching `auth.*` or `storage.*` — additive
under the rules above, re-running is a no-op.

### Pre-apply audit

| Probe | Result |
|---|---|
| `set_my_agency_code` (the ungated RPC from `20260617_agency_code.sql`) | **absent from production** — never applied, or dropped later |
| `set_my_agency_profile`, `is_agency_leader`, `email_matches_user` | present, `SECURITY DEFINER` → **`20260703b` is applied** |
| `agency_invites` policy `leaders manage their invites` | `WITH CHECK` carries `is_agency_leader(auth.uid())` — applied |
| `agents.agency_code` / `agency_name` | columns present |
| `agents_protect_privileged_columns` live body | byte-identical to committed `20260703c` — no drift |
| agents holding an `agency_code` | **0** |
| rows in `agency_invites` | **0** |

So the specific door I went looking for was already shut, and nothing had been
exploited — but the same hole was open through a different one.

### What was actually wrong

**1. `agents.agency_code` was client-writable.** `20260703b` gated the *RPC*
(`set_my_agency_profile` refuses unless `is_agency_leader`) and gated the invite
*RLS*. It never protected the *column*, and `agents_update_own` is
row-ownership only. So from the browser console, with a session and the
publishable key:

```js
sb.from('agents').update({ agency_code: 'SMITH2024' }).eq('id', myId)
```

…made any account an agency leader with no Team Leader plan. `agency_code` is
`UNIQUE`, so this also allowed squatting the code a real leader was about to
hand out, and collecting that leader's recruits.

**2. `process_agency_code_join` never checked the leader.** It is
`SECURITY DEFINER`, so it runs as the table owner and RLS on `agency_invites`
does not apply — meaning the `is_agency_leader(auth.uid())` `WITH CHECK` that
`20260703b` added was never enforced on the code-join path at all. Downline rows
formed regardless of whether the leader qualified.

Together: read access to a downline's production aggregates
(`get_team_summary`, `get_agency_stats`) for an account that never paid for a
Leader plan. **Revenue was never exposed** — the 30% downline discount
independently re-checks `is_agency_leader(leader_id)` on every checkout
(`stripe-create-checkout` → `agent_has_active_leader_link`).

Same class as `20260703c` / `20260730`: the guard went on the RPC, the column
stayed writable. That is now three times. **When gating a privileged value,
protect the column, not only the function that sets it.**

### Fix — gate, do not freeze

`agency_code`/`agency_name` are **not** frozen like `is_admin`. `auth.role()`
reads the JWT claim, so it is still `'authenticated'` inside a `SECURITY
DEFINER` RPC invoked from the browser — a blanket freeze would also revert the
UPDATE that `set_my_agency_profile` itself performs. The trigger instead gates
on `is_agency_leader(NEW.id)` and mirrors the RPC's format checks, so the
legitimate RPC passes and everything else is reverted, regardless of how the
write arrived.

`process_agency_code_join` now refuses a code whose owner does not currently
qualify, matching the discount rule exactly: the link stops forming at the same
moment the discount evaporates.

### Post-apply verification — behavioural, not just definitional

Run inside a transaction terminated by `RAISE EXCEPTION`, so it could not
persist; `agents_with_code` and `agency_invites` both re-confirmed `0` after.

| Test | Result |
|---|---|
| A. non-leader direct write of `agency_code` (authenticated JWT) | **BLOCKED** — still null |
| B. trusted-context write (no JWT: service_role / SQL editor) | **ALLOWED** — carve-out intact |
| C. join a code owned by a non-leader | **refused**, readable error |
| D. join a code owned by a real leader | **succeeds** — no regression |
| E. `get_agency_stats` AP vs raw truth | **exact match** |

**E is the reason the third statement was in this batch.** `get_agency_stats`
LEFT JOINed `policies`, `calls` and `leads` in one SELECT. `COUNT(DISTINCT …)`
corrected the three counts, but `SUM((po.data->>'ap')::numeric)` had no
`DISTINCT` and no way to get one, so AP was added once per (call × lead) pair.
The downline used in test D has 7 policies, $8,977.80 AP, **35 calls and 246
leads** — the old shape would have reported that agent's premium as
**$77,298,858**, a 8,610× overstatement, on the Agency tab. It now returns
$8,977.80, matching the raw sum.

It was never visible in production only because `agency_invites` has been empty.
The first accepted invite would have shown it.

Both screens now also share one definition of a sale: `'lapsed'` and
`'chargeback'` excluded, the identical predicate `get_team_summary` uses.

### Not verified

There is no non-admin Team Leader account in production, and
`agents_protect_privileged_columns` returns early for admins, so the
*leader-writes-a-valid-code* branch was exercised only through the admin
carve-out. The non-leader block (the security-relevant half) is verified
directly.

---

## Apply 2026-07-28 — `20260737_lead_transfers.sql`

Lead distribution between agency members. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Additive only: one `CREATE TABLE IF NOT EXISTS`, three
`CREATE INDEX IF NOT EXISTS`, one `ALTER TABLE … ENABLE ROW LEVEL SECURITY`,
one policy, one `CREATE OR REPLACE FUNCTION`. No `DROP`, no data change,
nothing in `auth.*` or `storage.*`. Re-running is a no-op.

Feature doc: `docs/lead-distribution.md`.

### Pre-apply audit

| Probe | Result |
|---|---|
| `lead_transfers` table | absent |
| `get_agency_members()` | absent |
| `public.leads` rows | 1,329 |
| `agency_invites` rows | 0 |

### What was added

- **`public.lead_transfers`** — append-only audit of every handoff: lead id,
  sender, recipient, both `client_id`s, and denormalized name/phone snapshots.
  `lead_id` is `ON DELETE SET NULL`, not `CASCADE`: deleting a lead must not
  erase the record that it was handed over.
- **RLS: SELECT-only, both parties** (`sender_id = auth.uid() OR
  recipient_id = auth.uid()`), and **no INSERT/UPDATE/DELETE policy at all** —
  RLS-enabled-with-no-write-policy is how "service-role only" is expressed,
  same as `reputation_config`.
- **`public.get_agency_members()`** — the caller's agency peers (upline /
  downline / sibling) with name, email, plan. No parameter, anchored solely on
  `auth.uid()`, so there is nothing to tamper with. It exists because a
  downline agent *cannot* enumerate their own siblings from the browser:
  `agency_invites` RLS is `leader_id = auth.uid() OR invitee_email =
  auth.email()`, which does not cover "other invitees of my leader".

### Deliberately NOT added

**No RLS policy letting one agent write another agent's leads.** A transfer
sets `leads.agent_id` to somebody else, and the only PostgREST policy that
could permit that from the browser is broad enough to permit every write this
schema defends against. The move runs in the `transfer-leads` edge function
under the service role, which re-derives the agency link from the caller's JWT
and re-asserts ownership in the `WHERE` clause of the update itself.

### Post-apply verification — behavioural

Table, 9 columns, 3 indexes, `relrowsecurity = true`, one `r` (SELECT) policy,
and `get_agency_members()` callable (returns 0 rows — production has no
accepted invites yet).

Then a full transfer was exercised against a **real** lead inside a transaction
terminated by `RAISE EXCEPTION`:

| Check | Result |
|---|---|
| lead moves to the recipient / leaves the sender | pass |
| `consent_records` row still belongs to the SENDER | pass — not re-attributed |
| recipient has **no** consent row for that phone | pass — renders `needs_optin` |
| `tcpa_consent` / `_source` / `_at` reset on the moved lead | pass |
| `dnc_list` rows for that phone | unchanged — the transfer writes none |
| audit row written, provenance stamped | pass |
| re-running the same transfer touches 0 rows | pass — idempotent |

Rollback re-confirmed afterwards: `agency_invites` 0, `lead_transfers` 0,
fixture consent rows 0, `leads` 1,329 with the test lead still owned by its
original agent.

### Edge function

`transfer-leads` deployed **individually** (never a batch — see the header of
`supabase/config.toml`), `verify_jwt = true`, version 1, ACTIVE. Diffed the
whole fleet before and after: 69 → 70 functions, the 16 `verify_jwt = false`
functions are the same 16, none flipped. `config.toml` and live state agree
16/16 in both directions, so there is no function that a future deploy would
silently take dark.

Confirmed live: no `Authorization` header → our `401 unauthorized`; a malformed
bearer → platform `UNAUTHORIZED_INVALID_JWT_FORMAT` before our code runs.

---

## Apply 2026-07-29 — `20260738_team_roster.sql`

Phase B of the Team Leader work: one merged leader home screen, and one data
source behind both team surfaces. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/agency-team-screen.md`.

**This file contains a `DROP FUNCTION`, and that was authorised explicitly.**
Jace approved it on 2026-07-29 in answer to question 7 of the build brief
("Replace the existing function in place"). A return-type change cannot be
done with `CREATE OR REPLACE`, so the function is dropped and recreated inside
the same transaction. No table, no column, no row is read, moved or deleted by
it. Everything else in the file is additive: one `ADD COLUMN IF NOT EXISTS`,
one guarded `UPDATE` backfill, one `CREATE OR REPLACE FUNCTION`, one trigger.
Nothing touches `auth.*` or `storage.*`. Re-running is a no-op.

### Pre-apply audit

| Probe | Result |
|---|---|
| `agency_invites.accepted_at` | **absent** |
| triggers on `agency_invites` | **none** |
| `get_team_summary` signature | `(timestamptz, timestamptz)`, 7-column result |
| rows in `agency_invites` | **0** — so the backfill was a guaranteed no-op |
| `policies` / `calls` / `leads` | 23 / 1,282 / 1,329 |
| agents holding an `agency_code` | 1 |

### What changed

- **`agency_invites.accepted_at`** + `agency_invites_stamp_accepted` trigger.
  The table only ever recorded when an invite was *sent*. "Joined" on a roster
  means joined the agency, and the date feeds the 30-day at-risk grace period,
  so a wrong date is not cosmetic. The trigger covers both accept paths (the
  browser's `UPDATE` and `process_agency_code_join`'s `INSERT … ON CONFLICT`)
  and is **write-once for client callers** — a leader cannot backdate a join to
  suppress an at-risk badge. Trusted contexts keep the usual carve-out.
- **`get_team_summary` replaced**: 8 optional time-bound parameters (NULL =
  unbounded, which is how "Lifetime" is expressed) and 22 result columns —
  adding plan, email, joined/last-activity/last-dial timestamps, the previous
  comparable period, the fixed calendar-month pair the at-risk rule reads, and
  lifetime totals. Authorization is **unchanged**: still `SECURITY DEFINER`,
  still anchored on `ai.leader_id = auth.uid()`, and still with **no parameter
  naming a leader** — there is nothing to point at someone else's downline.
- **AP is now regex-guarded before the numeric cast.** Previously one policy
  with a non-numeric `ap` would throw and take down the team rollup for *every*
  agent on the screen. Unparseable AP now counts as 0.

### Post-apply audit

| Probe | Result |
|---|---|
| `accepted_at` | present, `timestamptz`, nullable |
| `get_team_summary` | exactly **one** signature (the 2-arg version is gone), 8 params, `prosecdef = true` |
| grants | `postgres/anon/authenticated/service_role = X` — identical to before the drop |
| trigger | `agency_invites_stamp_accepted` present and enabled |
| `get_agency_stats` | still present (nothing dropped), now uncalled by the app |
| row counts | 23 / 1,282 / 1,329 / 0 invites — unchanged |

### Behavioural verification — 13/13

Run inside a transaction that **rolled back**; row counts re-confirmed
identical afterwards, and the one fixture policy left nothing behind.

| # | Check | Result |
|---|---|---|
| 1 | a leader sees self + downline | PASS (2 rows) |
| 2 | **a downline calling it cannot see the leader or siblings** | PASS (team of one) |
| 3 | an unrelated third party sees only themselves | PASS |
| 4 | `anon` (no `auth.uid()`) resolves to nobody | PASS (0 identified agents) |
| 5 | `accepted_at` auto-stamped on an accepted insert | PASS |
| 6 | `accepted_at` is write-once for a client caller | PASS (backdate refused) |
| 7 | lifetime AP == raw sum (no cartesian inflation) | PASS ($5,472) |
| 8 | lifetime dials == raw call count | PASS (335) |
| 9 | a bounded window scopes AP+dials while lifetime stays whole | PASS |
| 10 | `month_ap` uses the **client-passed** calendar month | PASS (Jul $3,254.04, Jun $2,641.20) |
| 11 | `joined_at` set for the downline, null for the leader's own row | PASS |
| 12 | `last_activity_at` present and >= `last_dial_at` | PASS |
| 13 | an unparseable AP no longer errors the whole rollup | PASS |

Checks 2–4 are the leader-only guarantee, exercised rather than asserted.

### No edge function changed

Nothing was deployed. The whole feature is one RPC plus `app.html`, so
`supabase functions list` was not disturbed and no `verify_jwt` flag moved.

### End-to-end, against production

Two throwaway accounts driven through the real invite → accept flow with
synthetic at-risk data: **59/59 assertions passed**, including the
cross-screen check that the Agency tab and the Summary mini-card report the
same team AP. Both accounts and all their rows were deleted; `agency_invites`
0, `lead_transfers` 0, QA leads/policies/calls 0, and no throwaway auth user
remains. Full step-by-step in `docs/agency-team-screen.md`.

One observation, not from this run: `sectest+1785212287@frenkelfinancial.com`
is still present in `auth.users`. It appears to be a leftover from the
2026-07-28 privilege-escalation testing, which this ledger records as having
deleted its throwaway account. Left alone — deleting an account is destructive
and it is not this build's to remove. **Resolved 2026-07-29, see below.**

---

## Cleanup 2026-07-29 — the leftover `sectest` security-test account

**No DDL. One `auth.users` DELETE, authorised by Jace** after the verification
below. Recorded here because the ledger's own rule is that nothing touching
`auth.*` happens without an explicit decision, and because the 2026-07-28 entry
claimed a throwaway account had been deleted when one had not.

### Identification — it is the 07-28 security-test throwaway

| Evidence | Value |
|---|---|
| Email | `sectest+1785212287@frenkelfinancial.com` |
| The embedded epoch `1785212287` decodes to | **2026-07-28T04:18:07Z** |
| `agents` row created | 2026-07-28T04:18:08.240736Z — **1 second later** |
| `auth.users` created | 2026-07-28T04:18:08.242278Z |
| `last_sign_in_at` | **never** — the account was never used interactively |

A plus-addressed local part carrying a unix timestamp minted one second before
the row exists is a script generating a unique address at run time. 04:18 sits
inside the `04:1xZ` window this ledger records for the
`20260730_phone_numbers_column_protection` apply, so it is that test's account
rather than the `20260703c` one (04:0xZ) that was genuinely deleted.

### Verification that it held no real data

A generated sweep, not a hand-written list: every `BASE TABLE` in `public`
carrying `agent_id`, `leader_id`, `invitee_id`, `sender_id`, `recipient_id`,
`user_id` or `owner_id`, plus `agents.id`. **34 checks across 32 tables.**

| Result | |
|---|---|
| Total rows referencing the account | **2** |
| …which were | its own `agents` row, and the `wallet_accounts` row auto-created by `on_agent_created_wallet` |
| Rows in the other 30 tables | **0** — policies, leads, calls, phone_numbers, a2p_registrations, messages, inbound_messages, consent_records, dnc_list, agency_invites, lead_transfers, compliance_page_revisions, broadcasts, ai_calls, gmail_accounts, support_tickets, review_queue, suppression_list, quote_usage, policy_events, portal_nudges, parsed_events, email_ingest_log, lead_vendors, dialer_sessions, ai_dialer_sessions, agent_dashboards, wallet_ledger, wallet_topups, broadcast_recipients |

Money and privilege, checked individually because those are the ones that
would make a deletion consequential:

| Field | Value |
|---|---|
| `wallet_accounts.balance_mills` | **0** |
| `auto_recharge_enabled` | false (no threshold, no amount) |
| `wallet_ledger` / `wallet_topups` rows | **0 / 0** |
| `stripe_customer_id` / `stripe_subscription_id` | **null / null** |
| `plan_id` | **null** — never subscribed |
| `is_admin` | false |
| `agency_code` / `agency_name` | null / null |
| `compliance_slug` / published page | null / null |
| `phone_numbers` owned | 0 |

Nothing billable, nothing carrier-facing, no PII beyond the synthetic address.

### The delete

`DELETE /auth/v1/admin/users/ecce418f-…` → `200`; a follow-up lookup returns
`404`. Both foreign keys are `ON DELETE CASCADE` (`agents_id_fkey`,
`wallet_accounts_agent_id_fkey`), so the two dependent rows went with it.

### Post-delete audit

The same 34-check sweep re-run:

| Probe | Result |
|---|---|
| Rows still referencing the account | **0** |
| `agents` with a `sectest` email | **0** |
| `auth.users` total | 8 → **7** |
| `agents` total | 8 → **7** |
| `wallet_accounts` total | 8 → **7**, **0 orphans** |
| `policies` / `leads` / `calls` | 23 / 1,330 / 1,282 — **unchanged** |

The leads count is 1,330 rather than the 1,329 that appears earlier in this
file: a genuine webhook-ingested lead (`client_id` prefix `wh_`) arrived on
Jace's own account at 2026-07-29T05:34Z, during the team-screen test window.
It is real production data and was correctly left alone.

---

## Apply 2026-07-29 — `20260739_back_office_ingestion.sql`

Phase 1 of the Back Office mission: commission statement ingestion. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/back-office-ingestion.md`. Progress ledger:
`docs/back-office-progress.md`.

**Additive only, no approval needed under the rules above.** Four
`create table if not exists`, 18 `create index if not exists`, four
`alter table … enable row level security`, four `create policy` (all `SELECT`),
two check constraints added behind an `if not exists` guard, two triggers on
`public.touch_updated_at()`, one `create or replace function`. No `DROP` of a
table, column or row; nothing in `auth.*` or `storage.*` (the `references
auth.users(id)` foreign keys are how every table in this schema keys a tenant —
that is reading auth, not writing it). Re-running the whole file was confirmed
a clean no-op.

### Pre-apply audit

| Probe | Result |
|---|---|
| `commission_statements` / `statement_files` / `statement_extractions` / `commission_rows` | **all absent** |
| `public.touch_updated_at()` | present (the trigger function both new tables reuse) |
| `get_ingestion_summary` | absent |
| `policies` / `leads` / `agents` | 23 / 1,331 / 7 |

### Post-apply audit

| Probe | Result |
|---|---|
| Tables | 4/4 present |
| RLS enabled | 4/4 `relrowsecurity = true` |
| Policies | exactly **4, all `SELECT`** — no INSERT/UPDATE/DELETE policy on any commission table |
| Indexes | 18 |
| Check constraints | `commission_statements_status_check`, `commission_rows_review_status_check` |
| Triggers | `commission_statements_touch_updated_at`, `commission_rows_touch_updated_at` |
| `get_ingestion_summary` | present, **`prosecdef = false`** (SECURITY INVOKER — see below) |
| `policies` / `leads` / `agents` | 23 / 1,331 / 7 — **unchanged** |
| Re-run of the file | clean no-op (row counts and index count identical) |

### Why the four tables have no write policy

Commission data is the most sensitive data in this app. All four tables are
**SELECT-only for `authenticated`**; every write goes through the
`statement-upload` / `statement-parse` edge functions under the service role,
and both take the agent **from the JWT** — there is no agent id anywhere in
either request body. RLS-enabled-with-no-write-policy is how "service-role
only" is expressed in Postgres, the same shape as `consent_records`,
`lead_transfers` and `reputation_config`. Do not "fix" this by adding an INSERT
policy: a policy broad enough to let the browser record a commission row is
broad enough to let it record one against another agent's book.

### Why `get_ingestion_summary()` is SECURITY INVOKER

It is the one function here a browser calls, and it reads only through the
caller's own RLS — so it cannot return another agent's figures even by
accident. That is deliberate and is the opposite choice from
`get_team_summary`: a leader seeing downline aggregates *requires* SECURITY
DEFINER and a hand-built authorization anchor, and that arrives in Phase 4 with
the debt rollup that needs it. Until then no query in this schema can return
another agent's row, by construction rather than by restraint.

### Behavioural verification — 14/14

Run inside a transaction that **rolled back**; `commission_statements`,
`commission_rows` and `statement_files` re-confirmed at 0 afterwards, and
`policies` unchanged at 23.

| # | Check | Result |
|---|---|---|
| 0 | two distinct agents available to test cross-tenant reads | PASS |
| 1 | a statement inserts | PASS |
| 2 | **file-grain idempotency** — same agent + same sha256 rejected | PASS |
| 3 | the same file for a **different** agent is allowed | PASS |
| 4 | `status` check constraint refuses an invented state | PASS |
| 5 | **row-grain idempotency** — same `dedupe_key` rejected | PASS |
| 6 | a genuinely identical second statement line survives via its occurrence ordinal | PASS |
| 7 | `review_status` check constraint refuses an invented state | PASS |
| 8 | raw bytes round-trip through `bytea` | PASS |
| 9 | the owner sees their own commission rows | PASS |
| 10 | **another agent sees none of them** | PASS |
| 11 | the owner can read their own stored bytes | PASS |
| 12 | the owner sees their own statements only | PASS |
| 13 | `get_ingestion_summary()` is scoped to the caller | PASS |

Checks 10 and 13 are the tenant guarantee, exercised rather than asserted.

### Edge functions

`statement-upload` and `statement-parse` deployed **individually** (never a
batch — see the header of `supabase/config.toml`), both **`verify_jwt = true`**
and therefore deliberately **absent from `config.toml`**: the browser is the
caller and always has a session, and the service role (for a future unattended
sweep) presents a valid Supabase JWT of its own. A test asserts neither slug
appears in that file.

Fleet diffed before and after: **70 → 72 functions**, and the **16**
`verify_jwt = false` functions are the same 16 — none flipped.

Confirmed live: no `Authorization` header → `401`; a malformed bearer →
platform `UNAUTHORIZED_INVALID_JWT_FORMAT` before our code runs.

### End-to-end, against production

Two throwaway accounts, synthetic statements (CSV + XLSX + a ZIP of both),
driven through the **real** deployed functions: **36/36 assertions passed**,
including that another agent sees zero rows/statements/bytes and that even the
owner gets `403` attempting a direct `POST /commission_rows`. A separate
headless-browser click-through against the real UI passed **22/22**. Both runs
deleted every account and row they created; the residue sweep returned **0**,
and production row counts were unchanged afterwards (`policies` 23, `leads`
1,331, `agents` 7).

---

## Apply 2026-07-29 — `20260740_producer_codes.sql`

Phase 2 of the Back Office mission: producer codes and retroactive
attribution. Applied via `supabase db query --linked -f <wrapped>` with
`begin;`/`commit;` around the committed file. Feature doc:
`docs/back-office-producer-codes.md`.

**Additive only, no approval needed under the rules above.** One
`create table if not exists`, one `add column if not exists` (a generated
column), four `create index if not exists`, four `create policy`, three
triggers, five `create or replace function`, two check constraints behind an
`if not exists` guard. No `DROP` of a table, column or row; nothing in
`auth.*` or `storage.*`. Re-running the file was confirmed a clean no-op
(row counts and index list identical).

### Pre-apply audit

| Probe | Result |
|---|---|
| `producer_codes` | **absent** |
| `pc_normalize_code` / `apply_producer_codes` / `get_producer_code_coverage` / `producer_codes_guard_subject` | **all absent** |
| `commission_rows` with an attribution | **0** |

### Post-apply audit

| Probe | Result |
|---|---|
| `producer_codes` | present, RLS enabled |
| Policies | 4 — `SELECT`, `INSERT`, `UPDATE`, `DELETE`, every one `agent_id = auth.uid()` |
| Triggers | `producer_codes_derive_key`, `producer_codes_guard_subject`, `producer_codes_touch_updated_at` |
| Indexes | 5 (pkey, two unique, two lookup) |
| Check constraints | `producer_codes_kind_check`, `producer_codes_code_not_blank` |
| Functions | `apply_producer_codes` **SECURITY DEFINER**, `producer_codes_guard_subject` **SECURITY DEFINER**, `pc_normalize_code` / `get_producer_code_coverage` / `producer_codes_derive_key` SECURITY INVOKER |
| `pc_normalize_code('qa-777 a')` | `QA777A` |
| `policies` | 23 — **unchanged** |

### Why this table IS owner-writable, unlike the Phase 1 four

`producer_codes` holds the agent's own identifiers, not money — the same
posture as `policies` and `leads`. The privileged column is
`subject_agent_id`, and it has **its own trigger** rather than relying on the
write path being polite: `producer_codes_guard_subject` refuses any subject
that is not the caller or an agent connected by an **accepted**
`agency_invites` row. Protect the column, not only the function that sets it —
the lesson `20260703c`, `20260730` and `20260736` each cost this schema once.

`code_key` is likewise **derived by a trigger**, never accepted from the
client: a client-supplied key could file `QA-777` under `SOMETHINGELSE` and
make the reconcile match the wrong rows.

### Why `apply_producer_codes()` is SECURITY DEFINER with no parameters

`commission_rows` is deliberately SELECT-only for `authenticated` (Phase 1), so
the browser cannot update it and must not be able to. The reconcile is
therefore a definer function — and it takes **no parameter naming an agent**,
anchored solely on `auth.uid()`, so there is nothing to point at somebody
else's book. Same shape and reasoning as `get_team_summary`.

### Behavioural verification — 16/16

Run inside a transaction that **rolled back**; `producer_codes`,
`commission_rows` and `commission_statements` re-confirmed at 0 afterwards,
`policies` unchanged at 23.

| # | Check | Result |
|---|---|---|
| 1 | `pc_normalize_code` folds case and separators | PASS |
| 2 | `code_key` is derived, never trusted from the client | PASS |
| 3 | a duplicate code for the same carrier is refused | PASS |
| 4 | a blank code is refused | PASS |
| 5 | **RETROACTIVE — rows ingested before the code existed are attributed** | PASS (3 attributed) |
| 6 | a row whose code was never recorded stays unattributed | PASS |
| 7 | a row with no producer code at all stays unattributed | PASS |
| 8 | re-running the reconcile changes nothing | PASS |
| 9 | a carrier-specific code beats the carrier-agnostic one | PASS |
| 10 | deleting a mistyped code UNDOES its attribution | PASS |
| 11 | a manual attribution is never clobbered by the reconcile | PASS |
| 12 | an authenticated agent may record their own code | PASS |
| 13 | a code cannot be claimed for an agent outside your agency | PASS |
| 14 | an agent sees their own codes | PASS |
| 15 | another agent sees none of them | PASS |
| 16 | coverage separates recorded codes from ones only seen on statements | PASS |

Checks 5, 10 and 13 are the ones that matter: the retroactivity is the feature,
the reversibility is what makes a typo survivable, and the guard is what makes
`subject_agent_id` trustworthy for Phase 4's rollups.

### `carrier_key` — a generated column, added for a real reason

The uniqueness rule is "one code per (tenant, carrier)", where a NULL carrier
means *all carriers*. Expressed as an expression index
(`coalesce(carrier,'')`) it is correct but **unusable as a PostgREST
`on_conflict` target**, which can only name columns — so the agency bulk load
failed the moment a sheet contained one code already recorded, which is the
normal case for a re-upload. `carrier_key text generated always as
(coalesce(carrier,'')) stored` plus `producer_codes_key_uidx` over
`(agent_id, carrier_key, code_key)` makes the same rule expressible as columns.

The original expression index is left in place — removing it is a schema DROP
this build has no need to take. If a later migration tidies it up,
**`producer_codes_key_uidx` is the one that must survive.**

### No edge function changed

The whole feature is one migration plus `app.html`, so `supabase functions
list` was not disturbed and no `verify_jwt` flag moved (still 72 functions, 16
`verify_jwt = false`).

### End-to-end, against production

Three throwaway accounts (a leader, an accepted downline, and an unconnected
stranger), a real statement ingested through the Phase 1 pipeline so the
producer code arrived the way it actually arrives: **22/22 assertions passed**,
including that a leader may record a code for their downline, that the same
attempt for a stranger is refused with the trigger's own message, that an agent
cannot write into another agent's book at all, and that a reconcile run by
another agent leaves the leader's attributions untouched. A separate
headless-browser click-through passed **23/23**. Both runs deleted every
account, invite and row they created; the residue sweep returned **0**.

---

## Apply 2026-07-29 — `20260741_book_of_business.sql`

Phase 3 of the Back Office mission: the Book of Business. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/back-office-book-of-business.md`. Progress
ledger: `docs/back-office-progress.md`.

**Additive, no approval needed under the rules above.** One `create table if
not exists`, four `create index if not exists`, two check constraints behind an
`if not exists` guard, one `create or replace function` + trigger, two `create
policy`, one guarded `INSERT` backfill, one tightly-scoped `UPDATE` of rows
this same file created (see below), and one `CREATE OR REPLACE FUNCTION` on
`get_team_summary`. **No `DROP` of a table, column, function or row; nothing in
`auth.*` or `storage.*`.** Re-running the whole file was confirmed a clean
no-op.

### Pre-apply audit

| Probe | Result |
|---|---|
| `policy_status_history` | **absent** |
| `policy_status_history_guard` | **absent** |
| `get_team_summary` signatures | 1 |
| `policies` / `policy_events` / `agents` | 23 / 2 / 7 |
| `commission_rows` / `commission_statements` | 0 / 0 |
| distinct `policies.data->>'status'` values | `paid` 12, `approved` 6, `chargeback` 2, `pending` 2, `lapsed` 1 — all 23 recognised, all 23 dated |

That last row is why the backfill was predictable: 23 policies in, 23 genesis
entries out, none skipped by the status filter.

### Post-apply audit

| Probe | Result |
|---|---|
| Table | present, RLS **enabled** |
| Policies | exactly **2 — `SELECT` and `INSERT`**, no UPDATE, no DELETE |
| Indexes | 5 |
| Check constraints | `policy_status_history_source_check`, `policy_status_history_status_check` |
| Triggers | `policy_status_history_guard` (BEFORE INSERT, `prosecdef = true`) |
| Backfilled rows | **23**, one per policy, every `old_status` null |
| `get_team_summary` | still exactly **one** signature, `prosecdef = true`, grants untouched |
| `policies` / `agents` | 23 / 7 — **unchanged** |
| Re-run of the file | clean no-op |

### Why this table is owner-APPENDABLE when the Phase 1 four are SELECT-only

The policy write path is the browser. `public.policies` is written directly
from the client under an owner RLS policy and there is no edge function
anywhere in that path, so a history table the browser could not write would
record nothing at all for the source that produces most of the entries.

The trade that makes it safe is that there is **no UPDATE policy and no DELETE
policy** — the trail is append-only — and that a client cannot forge
PROVENANCE. `policy_status_history_guard` forces `agent_id` to `auth.uid()` and
**rejects any `source` other than `manual` or `system`** from an
`authenticated`/`anon` caller. `service_role` keeps the usual carve-out, which
is how `statement-parse` records `source='statement'`.

A row claiming `source='statement'` asserts that a carrier's own document said
something, and Phase 6's triage screen will treat it that way. Protect the
column, not only the function that sets it — the lesson `20260703c`,
`20260730`, `20260736` and `20260740` each cost this schema once.

### Why `get_team_summary` was replaced

Phase 3 introduces four statuses, two of which (`denied`, `withdrawn`) mean the
policy never issued. The sale predicate excluded only `lapsed`/`chargeback`, so
either would have counted as team production the moment an agent used one.

The replacement is **byte-identical to 20260738's definition apart from that
one list** (extracted from the committed file programmatically and substituted,
rather than retyped). Same signature, same 22-column `RETURNS TABLE`, so
`CREATE OR REPLACE` sufficed — nothing dropped, grants unchanged, authorization
unchanged (`SECURITY DEFINER`, anchored solely on `ai.leader_id = auth.uid()`,
still with no parameter naming a leader).

`surrendered` and `claim` are deliberately **not** excluded: both describe
business that WAS written and later ended, and the predicate is about whether a
sale ever happened, not whether it is still in force.

`test/book-of-business.test.mjs` now resolves the predicate from whichever
migration most recently defines the function, so the assertion cannot go stale
by pointing at 20260738 forever.

### The corrective `UPDATE`, and why it is in an additive migration

The first apply stamped each genesis entry at **midnight UTC**, cast straight
from the `dateSubmitted` calendar date. `changed_at` is a `timestamptz` and the
browser renders it in the reader's **local** zone, so all 23 entries displayed
as the **previous day** for every agent west of UTC. Found by the headless
click-through; no unit test would have caught it, because the bug is in how an
instant renders rather than in any stored value.

The expression now adds 12 hours — correct from UTC-11 to UTC+11, and what
`bobRecordPolicyCreated()` in `app.html` already did. That alone would only
help a database that had not yet applied the file, so the migration also
carries an `UPDATE` scoped to rows **it wrote itself**: `source = 'migration'`,
`changed_at` exactly `date_trunc('day', changed_at)`, and the policy's own date
confirming which day was meant. The corrected expression cannot produce a
midnight instant, so there is nothing else it can hit, and re-running it is a
no-op.

Verified after the re-apply: **23 of 23 at 12:00:00 UTC, 0 still at midnight,
and every entry's rendered date equal to the `dateSubmitted` the agent typed**
(the one policy with an empty `dateSubmitted` correctly fell through to
`draft`).

### Behavioural verification — 22/22

Run inside a transaction that **rolled back**; row counts re-confirmed
afterwards (`policies` 23, `policy_status_history` 23, no QA fixtures). The RLS
checks genuinely `SET LOCAL ROLE authenticated` — running them as `postgres`
would bypass RLS entirely and prove nothing.

| # | Check | Result |
|---|---|---|
| 1 | a client may append a manual entry | PASS |
| 2 | **a client CANNOT forge `source='statement'`** | PASS (42501) |
| 3 | **a client CANNOT forge `source='carrier_email'`** | PASS (42501) |
| 4 | a client-supplied `agent_id` is overwritten with `auth.uid()` | PASS |
| 5 | **a client cannot UPDATE history** (append-only) | PASS |
| 6 | **a client cannot DELETE history** (append-only) | PASS |
| 7 | the owner reads their own entries | PASS |
| 8 | **another agent sees NONE of them** | PASS |
| 9 | another agent sees none of the 23 backfilled entries either | PASS |
| 10 | a trusted context MAY record `source='statement'` | PASS |
| 11 | an invented status is refused | PASS |
| 12 | an invented source is refused | PASS |
| 13 | every genesis entry is dated from the policy, not from the apply | PASS (23/23) |
| 14 | exactly one genesis entry per policy, with no prior status | PASS (23/23) |
| 15 | re-running the backfill writes nothing | PASS |
| 16 | a null `changed_at` is stamped by the guard | PASS |
| 17 | **a DENIED policy is not counted as team production** | PASS |
| 18 | **a WITHDRAWN policy is not counted as team production** | PASS |
| 19 | a SURRENDERED policy still counts (it was a sale) | PASS |
| 20 | a CLAIM still counts (it was a sale) | PASS |
| 21 | `lapsed` is still excluded (no regression) | PASS |
| 22 | `get_team_summary` still returns the caller's own row | PASS |

Checks 2, 3, 5, 6 and 8 are the guarantees that make this table's write policy
defensible, exercised rather than asserted.

### Edge function

`statement-parse` redeployed **individually** (never a batch), version 2 → 3,
ACTIVE. It now writes back the two things a commission statement is
authoritative about — `paid` and `chargeback` — always through
`policy_status_history` with `source='statement'` and `source_ref_id` naming
the statement. A lapse is deliberately never inferred.

Fleet diffed before and after: **72 → 72 functions**, and the **16**
`verify_jwt = false` functions are the same 16 — none flipped.
`statement-parse` remains `verify_jwt = true` and therefore deliberately absent
from `config.toml`.

### End-to-end, against production

Two throwaway accounts, a real CSV statement pushed through the **real**
deployed `statement-upload` / `statement-parse` (real Haiku call):
**31/31 assertions passed**, including that a browser session is refused a
forged `statement` provenance, that another agent sees none of the trail, that
a chargeback line moves a policy and a later payment does **not** resurrect it,
that a re-parse appends no duplicate history, and that deleting a policy nulls
the FK rather than cascading the trail away. A separate headless-browser
click-through passed **40/40**.

Both runs deleted every account and row they created; the residue sweep
returned **0**. Production afterwards: `agents` 7, `auth.users` 7, `policies`
23, `policy_status_history` 23. `leads` moved 1,333 → 1,335 during the window —
both genuine webhook-ingested production leads (`wh_` prefix, source `VRC`) on
Jace's own account, correctly left alone.

---

## Apply 2026-07-29 — `20260742_commissions_dashboard.sql`

Phase 4 of the Back Office mission: the commissions dashboard. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/back-office-commissions.md`.

**Three `CREATE OR REPLACE FUNCTION` statements and three `GRANT EXECUTE`.
That is the whole file.** No table, no column, no index, no policy, no data
change — everything the dashboard reads already exists on
`public.commission_rows`. Nothing in `auth.*` or `storage.*`. Re-running it is
a no-op by construction.

### Pre-apply audit

| Probe | Result |
|---|---|
| `get_commission_buckets` / `get_commission_debt` / `get_downline_commission_rollup` | **all absent** |
| `commission_rows` RLS policies | 1, `SELECT` only (unchanged by this file) |

### Post-apply audit

| Function | `prosecdef` | `authenticated` may execute |
|---|---|---|
| `get_commission_buckets` | **false** (SECURITY INVOKER) | yes |
| `get_commission_debt` | **false** (SECURITY INVOKER) | yes |
| `get_downline_commission_rollup` | **true** (SECURITY DEFINER) | yes |

`commission_rows` policies unchanged: still exactly one, still `SELECT`, still
`agent_id = auth.uid()`.

### Why two are INVOKER and one is DEFINER

The two that return the **caller's own** figures read through
`commission_rows_select_own`, so they cannot return another agent's numbers
even by accident — and there is no parameter that could be added to make them,
because RLS would refuse the rows regardless.

`get_downline_commission_rollup` is the **first deliberate cross-agent read of
commission data in this schema**, deferred here on purpose by Phase 1's ledger
entry (§ "Why `get_ingestion_summary()` is SECURITY INVOKER"). It closes
checklist #100. Three things make it safe, all asserted behaviourally below:

1. **No parameter names a leader.** Both are time bounds; the downline is
   scoped solely by `ai.leader_id = auth.uid()`. Verified live over PostgREST:
   passing an invented `p_leader_id` returns HTTP 4xx rather than being
   ignored.
2. **It returns aggregates, never rows** — money totals and a row count. No
   client name, no insured name, no policy number, no carrier, no statement id.
   Enforced by the `RETURNS TABLE`, not by the UI's restraint.
3. **The scan is bounded by the UPLOADER** (`cr.agent_id in (team)`). Without
   it, a row a **complete stranger** attributed to this leader's downline would
   enter the rollup. `producer_codes.subject_agent_id` is guarded to
   self-or-downline, but that guard governs who may *claim* a code, not whose
   rollup the result may appear in.

### The defect the behavioural check found

The rollup originally *also* required the effective agent to be on the team.
Check 22 — a **stranger's** own figures, the assertion that looked like
paranoia — came back `0` instead of their own row: a line whose attribution
points outside the caller's team was being **excluded entirely**.

That is money disappearing from a total with nothing on screen to say so. In
production it fires the moment an agent leaves an agency: their invite flips to
`declined`, and every line the leader's own statements had attributed to them
silently drops out of the leader's figures. "Nothing is discarded" is the rule
the whole Back Office is built on.

Fixed by applying the attribution only when it lands inside the team and
otherwise falling back to the uploader. **The security bound is unchanged** —
`cr.agent_id in (team)` was always the thing doing the security, and the
excluded-row predicate was never load-bearing for it. A test pins the old
predicate out.

### Behavioural verification — 28/28

Run inside a transaction that **rolled back**; `agency_invites`,
`commission_rows` and `commission_statements` re-confirmed at 0 afterwards.
The RLS checks genuinely `SET LOCAL ROLE authenticated`.

Fixture: a leader with six lines (advance, renewal, chargeback, override,
adjustment, plus one attributed to their downline), an accepted downline with
two of their own, and an unconnected stranger whose single line is attributed —
impossibly, via the service role — to the leader's downline.

| # | Check | Result |
|---|---|---|
| 1–4 | buckets return; net / gross / chargebacks are the three distinct sums | PASS |
| 5 | a line **attributed to a downline agent is not the leader's own** | PASS |
| 6 | personal sales = own advance+renewal net of chargebacks | PASS |
| 7 | override income is separable | PASS |
| 8–9 | rows bucket into distinct ISO weeks, every bucket a Monday | PASS |
| 10 | a bounded window excludes rows outside it | PASS |
| 11 | debt = chargeback + adjustment only | PASS |
| 12 | debt is broken out per carrier | PASS |
| 13 | **an advance is never counted as carrier debt** | PASS |
| 14 | a carrier that owes you nothing is not listed | PASS |
| 15 | a leader sees themselves and their downline | PASS |
| 16 | a downline agent's rollup combines both sources | PASS |
| 17 | **rollup debt across the downline is visible to the leader** | PASS |
| 18 | **a stranger's row attributed to my downline never enters my rollup** | PASS |
| 19 | every line is counted exactly once — no double counting | PASS |
| 20 | the leader's own personal excludes what they wrote for a downline | PASS |
| 21 | an unconnected stranger gets a team of ONE | PASS |
| 22 | **…and their own money is still there, not excluded** | PASS (after the fix) |
| 23 | a stranger's own buckets contain only their own rows | PASS |
| 24 | a **downline** agent calling the rollup sees only themselves | PASS |
| 25 | …and cannot see up the tree at their leader's book | PASS |
| 26 | **KNOWN GAP** pinned: a downline agent cannot see rows their LEADER uploaded for them | PASS |
| 27 | `anon` resolves to nobody | PASS |
| 28 | `anon` gets no commission buckets | PASS |

Checks 18, 21, 24, 25 and 27 are the boundary, exercised rather than asserted.
Check 26 pins a **known gap** so that changing it has to be deliberate:
`commission_rows` RLS is keyed on the uploader, so a downline agent whose
leader ingests the consolidated statement sees none of it in their own
dashboard. Closing that means a second reader on the most sensitive table in
the app and deserves its own decision.

### No edge function changed

The whole feature is one migration plus `app.html`, so `supabase functions
list` was not disturbed and no `verify_jwt` flag moved (still 72 functions, 16
`verify_jwt = false`).

### End-to-end, against production

Three throwaway accounts (leader, accepted downline, unconnected stranger), a
**real** CSV statement pushed through the deployed `statement-upload` /
`statement-parse`, and a producer code recorded so one line attributes to the
downline agent the way it actually does: **29/29 assertions passed**, every
figure read back over the same PostgREST RPC path the browser uses.

Includes: the rollup carries no client name or policy number; a downline agent
cannot see up the tree; a stranger's buckets are empty (RLS, not the function,
doing it); an invented `p_leader_id` is refused; and `commission_rows` is still
SELECT-only for the browser.

A separate headless click-through passed **35/35**, reading the rendered SVG
geometry back to confirm debt is drawn below the zero line and commission
above it.

Both runs deleted every account, invite and row they created; the residue sweep
returned **0**.

---

## Apply 2026-07-29 — `20260743_persistency.sql`

Phase 5 of the Back Office mission: persistency. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/back-office-persistency.md`.

**One `CREATE OR REPLACE FUNCTION` and one `GRANT EXECUTE`.** No table, no
column, no index, no policy, no data change. Nothing in `auth.*` or
`storage.*`. Re-running it is a no-op by construction.

### Pre-apply audit

| Probe | Result |
|---|---|
| `get_downline_persistency` | **absent** |
| `policies` with an `issueDate` | **8 of 23** |
| `policies` with a `draft` date | **23 of 23** |
| `policies` linked to a lead (`soldLeadId`) | 5 of 23 |

That second row is the reason this phase exists in the shape it does — see
below.

### Post-apply audit

| Probe | Result |
|---|---|
| `get_downline_persistency` | present, `prosecdef = true`, `authenticated` may execute |
| `policies` | 23 — unchanged |

### Why it is SECURITY DEFINER when the commissions equivalents are not

The **policy** view of persistency (by carrier, by lead source) is computed in
the browser from the agent's own `policies` array — no RPC is needed or wanted.

The **agent** view is the one that needs the server: for a solo agent it is one
row, and for an agency owner it is the entire point. "Which of my agents writes
business that sticks" cannot be answered from the browser because `policies`
RLS is owner-only.

Same three guarantees as `get_team_summary`, `apply_producer_codes` and
`get_downline_commission_rollup`, all exercised below:

1. **No parameter names a leader** — the only argument is a date. The downline
   is scoped solely by `ai.leader_id = auth.uid()`.
2. **It returns four counts per (agent, window)** — cohort and kept, by policy
   count and by premium, so Flat vs Weighted costs one round trip. No client
   name, no policy number, no carrier, no lead source, not even a status.
3. **A stranger sees a team of one; a downline agent cannot see up the tree.**

### The bug this migration's date logic fixes

`_polsIssuedMonthsAgo()` in `app.html` keyed the persistency cohort on
`issueDate` **alone**. `issueDate` is an OPTIONAL field on the Add Policy form,
and in production only **8 of 23 policies carry one** while **all 23 carry a
draft date**.

Every policy without one was invisible to persistency — not counted as lapsed,
simply absent — so the Summary's persistency rings were reporting a rate over
roughly a third of the book and presenting it as the book's persistency. A
figure computed from a third of the policies is worse than no figure, because
it looks like a figure.

Both this function and the browser core now use
`issueDate -> draft -> dateSubmitted`, each regex-guarded before the cast (the
lesson `get_team_summary` learned on AP). `persistency13mo()` and
`persistency25mo()` were rewritten to delegate to the shared core, so the app
has one definition instead of two.

### The two definitions, which the browser must match

```
COHORT  status NOT IN ('pending','approved','denied','withdrawn')
KEPT    status IN ('issued','paid','placed','claim')
```

A policy that never issued was never at risk of lapsing, and counting a
declined application as a lapse punishes an agent for underwriting. **A death
claim is not a lapse** — the policy stayed in force until the insured died,
which on a final-expense book is common enough to matter.

`PERSIST_COHORT_EXCLUDED` and `PERSIST_KEPT` in the `// <persist-core>` block
are the same two lists, and a test parses this file to assert it. A figure an
agent computes for themselves and a figure their leader sees, computed
differently, is the worst kind of disagreement this app could ship.

### Behavioural verification — 16/16

Run inside a transaction that **rolled back**; `agency_invites` and `policies`
re-confirmed at 0 / 23 afterwards. The RLS checks genuinely
`SET LOCAL ROLE authenticated`.

Fixture: a leader with 7 policies (paid, issued, **claim**, lapsed, **denied**,
one with **only a draft date**, one **too young**), an accepted downline with
1 kept and 3 lapsed, and an unconnected stranger with a large book.

| # | Check | Result |
|---|---|---|
| 1 | four windows per agent, for the caller and their downline | PASS (8 rows) |
| 2 | **THE FIX: a policy with only a draft date is still in the cohort** | PASS (5, not 4) |
| 3 | a DENIED policy is not in the cohort — it was never at risk | PASS |
| 4 | **A DEATH CLAIM IS NOT A LAPSE** | PASS (kept = 4) |
| 5 | a policy younger than the window is not in it | PASS |
| 6 | the window bound is applied per window | PASS |
| 7 | premium is returned so Flat vs Weighted costs one round trip | PASS |
| 8 | the denied policy's AP is not in the cohort premium either | PASS |
| 9 | a leader sees their downline's cohort | PASS |
| 10 | …and their kept count | PASS |
| 11 | **a stranger never appears in the leader's rollup** | PASS |
| 12 | an unconnected stranger gets a team of ONE | PASS |
| 13 | …and sees only their own book | PASS |
| 14 | a **downline** agent cannot see up the tree | PASS |
| 15 | …and sees only their own policies | PASS |
| 16 | `anon` gets no cohort at all | PASS |

### No edge function changed

The whole feature is one migration plus `app.html`; the fleet was not disturbed
(still 72 functions, 16 `verify_jwt = false`).

### Headless click-through — 31/31

Real browser, real rendered DOM, an 11-policy book built to trip every rule at
once (a claim, a denied policy, a draft-date-only policy, a one-policy carrier,
two lead sources, a surrender).

The assertion worth naming: **the Agent view (computed by this function on the
server) and the window cards (computed by the browser core) both report 50%**
on the same book. That is the browser/SQL agreement checked end to end rather
than by reading both definitions.

Two assertions in the harness were wrong rather than the code — a 0% carrier
with one policy legitimately outranks a 25% carrier with four in a "worst
first" sort; being a thin cohort excludes it from the **outlier**, not from the
table, and the very next assertion confirmed it was not accused.

The run deleted every account, policy and lead it created; the residue sweep
returned **0**.

---

## Apply 2026-07-29 — `20260744_reconciliation.sql`

Phase 6 of the Back Office mission: reconciliation. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/back-office-reconciliation.md`.

**Additive only.** Three `add column if not exists` on `commission_rows`, two
`create index if not exists`, one `create or replace function`, one
`grant execute`. No table, no policy, no data change. Nothing in `auth.*` or
`storage.*`. Re-running it is a no-op.

### Pre-apply audit

| Probe | Result |
|---|---|
| `commission_rows.reviewed_at` / `reviewed_by` / `review_note` | **0 of 3 present** |
| `get_reconciliation_summary` | **absent** |
| `public.review_queue` rows | **30** — live, and written by `match-events` on a cron |

### Post-apply audit

| Probe | Result |
|---|---|
| New columns | **3 of 3 present** |
| `commission_rows` policies | **1, `SELECT`** — unchanged |
| Indexes on `commission_rows` | 8 → **10** |
| `get_reconciliation_summary` | present, **`prosecdef = false`** (SECURITY INVOKER) |

### The decision the brief asked for — `review_queue`

**Neither built on nor replaced. Left exactly as it is, and not used.**

It is `parsed_event_id uuid NOT NULL references public.parsed_events(id)` with
`unique (parsed_event_id)` on top, and its `reason` vocabulary
(`pdf_unreadable`, `ambiguous_match`, …) is the carrier-mail pipeline's. A
commission row has no parsed event, so filing one there means inventing a fake
parent row or dropping the constraint that makes the table correct for its real
owner.

The 30-row count above is what settled it: this is not a dormant table. It is
live and `match-events` writes it twice a day. Rewriting a running pipeline's
queue to serve a screen it does not feed is a change with no upside.

And it was not needed — **`commission_rows` already IS the queue**. Phase 1 gave
it `review_status` (check-constrained to `auto | needs_review | approved |
rejected`), a plain-English `review_reason`, `match_method` and
`match_confidence`. A second table pointing at those rows would be a second
place to keep in sync.

So this migration adds only what was genuinely missing: **who** resolved a row,
**when**, and **why**. Without them an approved row is indistinguishable from
one the parser matched by itself, and "who decided this $4,000 chargeback was
mine?" has no answer. `reviewed_by` is `ON DELETE SET NULL` — removing an
account must not erase the record that a decision was made.

### The write path is unchanged, and that is the point

`commission_rows` stays **SELECT-only for `authenticated`**. A test asserts
this migration adds no policy at all.

An UPDATE policy wide enough to let the browser set `review_status` is wide
enough to let it set `matched_policy_id`, and pointing a commission row at
another agent's policy is exactly what this schema is built to prevent. Every
resolution goes through the new `statement-review` edge function under the
service role, with the agent taken **from the JWT** — there is no agent id in
the request body.

`get_reconciliation_summary()` is SECURITY INVOKER: it reads only through the
caller's own RLS on `commission_rows`, `commission_statements` and `policies`,
so it cannot count anybody else's work even by accident. There is deliberately
**no cross-agent reconciliation view** — resolving a match means seeing a
client name, which is the line `docs/agency-team-screen.md` draws.

### Edge function

`statement-review` deployed **individually** (never a batch), version 1,
ACTIVE, **`verify_jwt = true`** and therefore deliberately **absent from
`config.toml`** — a test asserts that absence, because listing it there would
take it to `verify_jwt = false`.

Fleet diffed before and after: **72 → 73 functions**, and the **16**
`verify_jwt = false` functions are the same 16 — none flipped.

### End-to-end, against production — 29/29

Two throwaway accounts and a real statement carrying one matchable line and two
unmatchable ones, every resolution driven through the **real deployed**
function.

The assertions that matter:

| Check | Result |
|---|---|
| the unmatchable lines are queued, not dropped | PASS |
| **REJECT NEVER DELETES** — row, amount, statement all still there | PASS |
| …and it records who decided, when, and the note they left | PASS |
| approving a line that was never matched is **refused with a reason** | PASS |
| a manual match is recorded as `manual` at confidence 1 | PASS |
| **an agent CANNOT link a line to another agent's policy** (404, row unchanged) | PASS |
| **a stranger CANNOT resolve my rows** (updated 0, skipped 1) | PASS |
| a body-supplied `agent_id` changes nothing | PASS |
| an unmatch returns the line to `needs_review` with a reason | PASS |
| the statement's review counter stays honest | PASS |
| no `Authorization` header → 401; unknown action → 400; empty batch → 400 | PASS |
| a bulk resolution empties the queue and counts as work done | PASS |
| **`commission_rows` is STILL SELECT-only for the browser** | PASS |

A separate headless click-through passed **31/31**, driving the real edge
function from a real browser. Both runs deleted everything they created; the
residue sweep returned **0**.

### Two things the run found

**An existing invariant caught a real duplication in this phase's code.**
`test/back-office.test.mjs` asserts *exactly one `statement-parse` call site* —
"two ways to parse is two places for the auth header and the reporting to drift
apart". The stuck-upload **Try again** button had added a second. Fixed by
calling `boParseNow()`, which already owns all three, rather than
re-implementing it. The test was right; the code changed.

**The click-through could not reach the edge function at first.** The CORS
allowlist covers the production origins plus `http://localhost:8080` behind the
`ALLOW_DEV_ORIGINS` secret, and the harness serves from a random `127.0.0.1`
port. Rather than flip a production secret for a test, web security was relaxed
**inside the throwaway Chrome profile only** — the same choice this ledger
records for the `transfer-leads` run. Nothing server-side was altered, and the
end-to-end run exercises the same calls with real CORS.

---

## Apply 2026-07-29 — `20260745_carriers.sql`

Phase 7 of the Back Office mission, and the last schema change in it. Applied
via `supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/back-office-close-the-loop.md`.

**One `CREATE OR REPLACE FUNCTION` and one `GRANT EXECUTE`.** No table, no
column, no index, no policy, no data change. Nothing in `auth.*` or
`storage.*`. Re-running it is a no-op by construction.

### Pre / post apply

| Probe | Before | After |
|---|---|---|
| `get_carrier_summary` | absent | present, **`prosecdef = false`** (SECURITY INVOKER), `authenticated` may execute |

### Why it is derived and SECURITY INVOKER

Checklist #103 asks for "appointed carriers, derived from ingested statements",
and *derived* is the point: a carrier appears because it has **paid** the agent,
which the statements already record. A `carriers` table would be a second list
to maintain and the first thing an agent forgets to update after taking an
appointment.

`data/carrier_bonuses.json` (45 carriers) and `TRACKER_CARRIER_LIST` (24) are
deliberately not joined in — they answer what programmes exist and what the Add
Policy dropdown offers, and folding them in would show an agent carriers they
have never written a line with.

INVOKER because a carrier list is per-agent by nature. There is no cross-agent
carrier view, and the aggregate paths that do exist
(`get_downline_commission_rollup`, `get_downline_persistency`) return money and
rates rather than anything naming a carrier.

Two definitions are shared rather than restated: **debt is
`chargeback + adjustment`, positive balance only** — byte-identical to
`get_commission_debt`, because two screens disagreeing about what an agent owes
a carrier is worse than either being absent — and **rejected lines are
excluded** while unmatched ones are counted and named, since an unmatched line
is still money that moved.

### No edge function changed

The rest of Phase 7 (auto-referral generation, the chargeback at-risk signal)
is entirely `app.html`. Referral leads are written through the existing
`saveLeads()` / `sbUpsertAllLeads()` path, which is owner-RLS and unchanged.
The fleet was not disturbed: **73 functions, 16 `verify_jwt = false`.**

### The compliance property this phase turns on

An auto-generated referral lead is created **without consent, deliberately**.
It carries no `tcpa_consent`, no `consent_records` row and no opt-in of any
kind, so `leadTextingState()` renders it `needs_optin` and `runComplianceGate()`
refuses the send. A beneficiary named on an application has not asked to hear
from anyone.

This is verified in three places, not one: a unit test enumerating every
consent-shaped key on the generated object; a headless click-through reading
the keys off the real lead **in the browser**; and the same check against the
row that **synced to the server**. `consent_records` is service-role-write-only
and nothing in this phase writes it, which is what makes the property hold by
construction rather than by care.

### Verification

| Layer | Result |
|---|---|
| Unit tests (`npm run test:referrals`) | **33** |
| Full suite | **661 tests + `npm run check` clean** |
| Headless click-through | **26/26** |
| Residue | **zero** |

---

## Apply 2026-07-29 — `20260747_agency_join_requests.sql` (applied by Jace, recorded after the fact)

**Recorded retrospectively.** This migration was written and applied from Jace's
MacBook alongside commit `55102b7` and pushed without a ledger entry. The
ledger's rule is that it is updated in the SAME commit as the apply; this entry
closes that gap rather than pretending it was followed. The apply itself is
sound — audited below — and **nothing was re-run**: this is a record, not an
apply.

Numbering note: it took `20260747`, skipping `20260746`. The Back Office
mission used `20260741`–`20260745`, so there is no collision, and `20260746`
is simply unused.

### Audit — 2026-07-29, after merging `origin/main`

| Probe | Result |
|---|---|
| `agency_invites.initiated_by` | **present**, `text NOT NULL DEFAULT 'leader'` |
| CHECK constraints on `agency_invites` | 2 (including `initiated_by IN ('leader','agent')`) |
| `request_agency_join(text)` | present, **`prosecdef = true`** |
| `get_agency_join_requests()` | present, **`prosecdef = true`** |
| `agency_invites` rows | **2**, of which **1** is `initiated_by = 'agent'` |

That last row matters: the flow is not merely applied, it has been **exercised
in production** — there is a real agent-initiated join request on file.

### What it does, and why it needed no new table

It reuses `public.agency_invites` rather than adding a table, which is the
right call: a join request and an invite are the same relationship approached
from opposite ends, and the existing `UNIQUE (leader_id, invitee_email)` is
exactly the constraint that should stop a leader invite and an agent request
coexisting as two contradictory rows for one pair.

`initiated_by` defaults to `'leader'`, so the browser's existing
`agSendInvite()` insert — which does not name the column — keeps writing a
leader invite exactly as before. Only `request_agency_join()` ever writes
`'agent'`.

### The security shape is the one this schema already uses

`request_agency_join()` is `SECURITY DEFINER` because the row it writes has
`leader_id = SOMEONE ELSE`, which the "leaders manage their invites" RLS policy
refuses from the browser. It carries the same guards as
`process_agency_code_join` (the code must resolve, it cannot be your own
agency, and the code's owner must **currently** qualify as a Team Leader) with
one deliberate difference: **it writes `status='pending'`, never
`'accepted'`.** The leader approves in-app, and this path grants no discount —
which is what keeps it from becoming a way around the `is_agency_leader` gate
that `20260736` was written to close.

### Not verified by this entry

This is a retrospective record, so it carries **no before/after diff and no
behavioural checks** — the two things this ledger normally insists on. The
objects exist and one real request has flowed through, but nobody has
exercised, for example, whether a pending LEADER invite is correctly converted
rather than duplicated when the agent then types the code. `test/team-roster.test.mjs`
covers the four new cache invalidations and nothing further.

**If the join-request flow is going to carry real recruiting traffic, it wants
the same behavioural pass every other function in this ledger got.**

---

## Apply 2026-07-29 — `20260748_inbound_statement_email.sql`

Back Office Phase 1b: the per-tenant commission forwarding address. Applied via
`supabase db query --linked -f <wrapped>`, transaction-wrapped.

**Additive only.** Three `add column if not exists` on `agents`, one
`create table if not exists`, four indexes, one check constraint, one policy
(SELECT), three functions, one trigger. No `DROP` of a table, column or row;
nothing in `auth.*` or `storage.*`. Re-running is a no-op.

### Pre / post apply

| Probe | Before | After |
|---|---|---|
| `agents.commission_email_*` columns | 0 | **3** |
| `inbound_statement_emails` | absent | present, RLS on, **1 policy, SELECT only** |
| `issue_commission_email_token` / `resolve_commission_email_token` / `agents_protect_commission_token` | 0 | **3** |
| triggers on `agents` | 6 | **7** |

### A bug the apply itself caught

`issue_commission_email_token()` originally used `gen_random_bytes(16)`. That
is **pgcrypto**, which lives in the `extensions` schema on Supabase, and every
SECURITY DEFINER function here pins `search_path = public` so it cannot be
aimed at a hostile schema. The first real call threw `42883: function
gen_random_bytes(integer) does not exist`.

It now builds the token from `gen_random_uuid()`, which is **core PostgreSQL** —
same 128 bits, no extension dependency, no search_path exposure. Found by
minting a token for a live account rather than by reading the code.

### The token is a bearer secret, and is treated as one

Anyone who knows an agent's address can post a statement into that agent's
book. That is inherent to any forwarding address; what follows from it:

- 32 hex characters of randomness, not a slug of the agent's name.
- **Server-issued and not client-writable.** `agents_protect_commission_token`
  reverts `commission_email_token`, `commission_email_enabled` and
  `commission_email_rotated_at` for any `authenticated`/`anon` write. The
  existing `agents_protect_privileged_columns` (20260703c) enumerates its
  columns by name and these are new, so they needed their own guard rather
  than an assumption — the same lesson this ledger has recorded four times.
- **Rotatable.** `issue_commission_email_token(p_rotate => true)` mints a new
  one; `commission_email_enabled` can disable an address without deleting it.
- It grants **no read access**. It names a destination, nothing else.
- `resolve_commission_email_token()` is `service_role` only (explicitly
  REVOKEd from `public`/`anon`/`authenticated`) and returns **only an agent
  id** — never an email, a name, or anything else about the account.

### `inbound_statement_emails` — capture first, parse second

`agent_id` is **nullable on purpose**: an email sent to a rotated or mistyped
token is still stored, because a statement that arrived at the wrong address
must be findable rather than silently dropped. Those rows belong to nobody and
are invisible to every agent.

The whole Resend event is stored **verbatim before anything is parsed out of
it**, because the `email.received` payload shape has never been observed by
this codebase — `messaging-email-inbound-webhook` says so in its own header.
That makes every inbound re-processable: if the attachment adapter reads the
wrong key, no statement is lost and nobody has to forward anything again. Same
guarantee `statement_extractions` gives for model output and `statement_files`
gives for bytes.

`UNIQUE (provider, provider_event_id)` is the replay guard — Resend retries
anything it does not get a 2xx for.

### ⚠️ THE INBOUND PATH IS BUILT AND DEPLOYED BUT **NOT PROVEN**

The end-to-end test could not be completed. **See
`docs/back-office-progress.md` § "Phase 1b — blocked on Resend delivery" for
the full evidence and the decision required.** In short: two real emails were
accepted by Resend (HTTP 200 + message id) and **neither was delivered** —
including a plain Gmail control, which rules out the commissions subdomain as
the cause. The stored `RESEND_API_KEY` is send-only restricted, so no
configuration or delivery state can be read from here.

Nothing in this migration depends on that resolution; the schema is correct and
inert until mail actually arrives.

---

## Apply 2026-07-29 — `20260749_commission_token_issue_fix.sql`

Phase 1b fix. Two `CREATE OR REPLACE FUNCTION`, one `GRANT`. No table, no
column, no data, no policy. Re-running is a no-op.

### The bug, found by the first real inbound email

`issue_commission_email_token()` is SECURITY DEFINER and so is allowed to write
`agents.commission_email_token`. But `auth.role()` reads the JWT **claim**,
which is still `authenticated` inside a definer function invoked from a
browser — so `agents_protect_commission_token` reverted the definer's own
UPDATE.

The function then returned the token it had just generated, so the caller saw a
plausible address. **Nothing was persisted.** The first real email to that
address resolved to nobody and was filed `unresolved`.

`20260736` records this exact trap, in this exact schema, about
`set_my_agency_profile`: *"auth.role() reads the JWT claim, so it is still
'authenticated' inside a SECURITY DEFINER RPC invoked from the browser — a
blanket freeze would also revert the UPDATE that set_my_agency_profile itself
performs."*

### The fix — gate, do not freeze

The guard now passes when a transaction-local `app.commission_token_issue`
flag is on, which the issuing function opens immediately before its UPDATE and
closes immediately after. Same idiom as `20260731`'s
`app.a2p_allow_id_change`. It cannot be set from PostgREST (no SQL there) and
is `is_local`, so it cannot outlive the statement.

`issue_commission_email_token` also now **reads the value back** and returns
what is actually stored rather than what it meant to write. That is the
assertion that would have caught this the first time: a reverted write returns
null instead of a confident, non-existent address.

### Verified live

| Check | Result |
|---|---|
| minting persists the token | PASS (`select` confirms the same value the RPC returned) |
| re-minting is idempotent | PASS |
| rotation issues a different token and stamps `rotated_at` | PASS |
| the OLD token stops resolving after a rotation | PASS |
| a client PATCH of `commission_email_token` is reverted | PASS |
| an agent who never opens Integrations has no token minted | PASS |

17/17 in a real browser against production; every account and row deleted
afterwards.

---

## Apply 2026-07-30 — `20260750_agency_leaderboards.sql`

Agency leaderboards, records and achievements (PROMPT_17). Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/agency-leaderboards.md`.

**Additive.** Six `create table if not exists`, one `add column if not exists`
on `public.agents`, 6 indexes, 2 check constraints behind an `if not exists`
guard, 3 policies (**all SELECT**), an 18-row seed with `on conflict do
update`, and 20 functions. No `DROP` of a table, column or row; no `DELETE`, no
`TRUNCATE`; nothing in `auth.*` or `storage.*`. Re-running the whole file was
confirmed a clean no-op.

**One `DROP CONSTRAINT`, and it needs naming.** See "The defect the behavioural
pass caught" below. It drops a UNIQUE constraint that *this same file* created
ninety minutes earlier, on a table holding **0 rows**, and replaces it with the
correct one. It is guarded on the auto-generated constraint name, so it is a
no-op on any database that never took the first version. No data existed to
lose and none was lost — but this ledger's rule is that a DROP is named out
loud, so it is.

### Pre-apply audit

| Probe | Result |
|---|---|
| the six new tables | **0 of 6 present** |
| `agents.hide_from_leaderboards` | **absent** |
| `lb_*` functions | **0** |
| `get_agency_leaderboards` / `get_agency_records` / `get_agency_milestones` / `get_agency_hall_of_fame` / `get_my_achievements` | **0 of 5** |
| `policies` / `calls` / `leads` / `agents` | 24 / 1,298 / 1,345 / 8 |
| `agency_invites` | 2, both `accepted` — production has a **real** 3-person agency now |
| policies on `agents` / triggers on `agents` | 5 / 7 |

That `agency_invites` row count is why this shipped straight to a live agency
rather than to an empty table, unlike `20260738`.

### Post-apply audit

| Probe | Result |
|---|---|
| Tables | 6/6 present |
| RLS enabled | 6/6 |
| Policies | **3, all `SELECT`** — 0 INSERT/UPDATE/DELETE on any of the six |
| `achievement_definitions` rows | 18 |
| `agents.hide_from_leaderboards` | present; triggers on `agents` still **7** (unchanged) |
| Browser-callable RPCs | 7, all executable by `authenticated` |
| Internal `lb_*(uuid…)` helpers | 11, **`authenticated` may execute: false** |
| `get_my_achievements` | **`prosecdef = false`** (SECURITY INVOKER) |
| `policies` / `calls` / `agents` | 24 / 1,298 / 8 — **unchanged** |
| Re-run of the file | clean no-op |

### Why the new column is NOT in the column-protection trigger

`agents.hide_from_leaderboards` is deliberately absent from
`agents_protect_privileged_columns` (`20260703c`). Every other column that
guard covers is one the client must not write; this is the one column on that
table the agent is *supposed* to own, and `agents_update_own` is row-ownership
only, which is exactly right here. The trigger count on `agents` is unchanged
at 7 for the same reason — nothing was added.

### The defect the behavioural pass caught

`leaderboard_snapshots` was originally `UNIQUE (leader_id, period_kind,
period_start, board_key, **rank**)`. That makes the rollover idempotent and
also makes it **lossy**: ties share a rank by design, so a board with two
agents at rank 6 offered the same key twice and `ON CONFLICT DO NOTHING`
silently swallowed the second. Check 53 expected ten frozen ranks and got
**nine** — the missing row was somebody's tied placement, dropped from the Hall
of Fame permanently.

Re-keyed on `agent_id`: still exactly as idempotent (one row per agent per
board per period), and a tie survives. A test pins the old grain out.

### Behavioural verification — 70/70

Run inside a transaction that **rolled back**, with `session_replication_role =
replica` set `LOCAL` so FK triggers were off for that transaction only. The
fixture therefore needed **no `auth.users` rows and `auth.*` was never
written**. Every assertion reads June 2019, a window in which production holds
0 policies and 0 calls, so the figures are exact rather than "production plus
fixture". Row counts re-confirmed identical afterwards.

Fixture: a leader with 11 accepted downline (AP $1,100 down to $100, two tied
at $700, dial counts of 60/55/52/**49**), plus a completely separate agency
whose two members wrote $9,999 and $8,888 in the same window.

| # | Check | Result |
|---|---|---|
| 1–4 | membership resolves; a solo agent is NULL, not an error | PASS |
| 5 | **NET AP counts paid + approved and EXCLUDES a lapsed $5,000** | PASS |
| 6 | PLACED AP counts only issued/paid/placed/claim | PASS |
| 7–9 | the lapsed policy is not a sale; the window bounds dials | PASS |
| 10 | the AP board sends exactly the top 10 to a top-10 viewer | PASS |
| 11 | rank 1 is the leader at $1,200 net | PASS |
| 12 | **ties share a rank** — two agents at $700 are both rank 6 | PASS |
| 13 | …and the rank after a two-way tie **skips to 8** | PASS |
| 14–15 | 12 entrants known, 10 sent; `top_value` is rank 10's value | PASS |
| 16 | **NO ROW FROM ANOTHER AGENCY APPEARS ON THIS BOARD** | PASS |
| 17 | …checked by value as well as by id | PASS |
| 18 | and the reverse: the stranger's board contains none of ours | PASS |
| 19 | a stranger sees none of our agency records | PASS |
| 20 | a 12th-place viewer gets the top 10 **plus one private row** | PASS |
| 21 | …carrying their real rank | PASS |
| 22 | **NOBODY ELSE'S BELOW-10 ROW IS EVER SENT** | PASS |
| 23–24 | 49 dials is **absent** from the rate boards, not ranked last | PASS |
| 25 | AP per dial is net AP over dials | PASS |
| 26–29 | Most Improved: the $500 baseline holds, 0→$300 is excluded | PASS |
| 30 | Most Improved is **unavailable on All-Time** | PASS |
| 31 | **A HIDDEN AGENT APPEARS ON NO BOARD AT ALL** | PASS |
| 32 | …the entrant count drops, so it is not a display filter | PASS |
| 33 | a hidden agent **still sees** the boards | PASS |
| 34 | …but is not ranked, even privately to themselves | PASS |
| 35 | the state RPC tells the UI it is hiding them | PASS |
| 36–40 | records and achievements written; **backfilled unlocks carry their historical date** | PASS |
| 41 | **a silent evaluation writes no feed events at all** | PASS |
| 42 | **RE-RUNNING THE EVALUATOR IS A NO-OP** — no double award | PASS |
| 43 | …and announces nothing, because nothing was broken | PASS |
| 44–45 | agency best-day is the team **combined** total; best-day-by-one-agent is separate | PASS |
| 46–48 | a genuine break writes exactly one feed event | PASS |
| 49 | the event reads as English, not as a column name | PASS |
| 50 | announcing the same record twice is impossible | PASS |
| 51 | **A HIDDEN AGENT'S $9,000 DAY DOES NOT BECOME THE AGENCY RECORD** | PASS |
| 52–54 | a closed month freezes 10 ranks; the frozen winner matches the live board | PASS |
| 55 | **RE-SNAPSHOTTING A CLOSED PERIOD WRITES NOTHING** | PASS |
| 56 | the season close announces the Top Producer exactly once | PASS |
| 57 | every member reads the Hall of Fame, not just the leader | PASS |
| 58–59 | the cron rollover is idempotent; a mid-month night does nothing | PASS |
| 60 | **AN AGENT CANNOT AWARD THEMSELVES A BADGE** | PASS |
| 61 | an agent cannot write an agency record | PASS |
| 62 | an agent cannot inflate a stored record | PASS |
| 63 | **an agent cannot run the evaluator against ANOTHER agent** | PASS |
| 64 | an agent cannot read arbitrary agents' metrics directly | PASS |
| 65 | an agent cannot enumerate another agency's members | PASS |
| 66 | `anon` resolves to nobody and gets no board | PASS |
| 67–70 | the business-day streak rule; lower-is-better for lead-to-sale | PASS |

Checks 16–19, 22, 31, 51 and 60–66 are the boundary, exercised rather than
asserted.

### Retroactive backfill — run against real production data

`select public.lb_evaluate_all(true)` → `{"agents": 8, "agencies": 1,
"silent": true}`.

| Wrote | Count |
|---|---|
| `agent_records` | 21 |
| `agent_achievements` | 12 |
| `agency_records` | 7 |
| **`agency_milestones`** | **0 — zero feed flood, as designed** |

Spot-checked against raw truth for all three agents who hold policies:
`best_day_ap` and `biggest_policy_ap` match a hand-written aggregate exactly
($3,876 / $1,896 · $2,719.32 / $2,600.40 · $2,236.68 / $2,236.68).

**Idempotency proven, not asserted.** Re-running with `p_silent => false`
afterwards left the row counts identical, the md5 of every record value and of
every achievement date **identical**, and still wrote **0** feed events.

### The two cron jobs

`supabase/schedule_leaderboards.sql`, applied the same day. `cron.job` went
**11 → 13**.

| Job | Schedule (UTC) | Command |
|---|---|---|
| `leaderboard-nightly` | `5 6 * * *` | `select public.lb_evaluate_all(false);` |
| `leaderboard-rollover` | `20 6 * * *` | `select public.lb_rollover();` |

**Unlike every other cron job in this project these call SQL directly** rather
than `net.http_post`-ing an edge function: the whole feature is one migration
plus `app.html`, so there is no function to call, no `CRON_SECRET` to store and
no `verify_jwt` flag to get wrong. `lb_rollover()` derives "today" from
`America/Chicago` itself, which is why there is no CDT/CST job pair here.

### No edge function changed

Nothing was deployed, so the fleet was not disturbed and no `verify_jwt` flag
could move.

### End-to-end, against production — 62/62

**13 throwaway accounts**: a Leader-plan agency owner, 11 downline, and a
completely separate agency of two. Seeded for the current month, then driven
through the **real `app.html`** in headless Chrome over the DevTools Protocol
(zero new dependencies — Node 24's built-in `WebSocket`).

Includes, over real user JWTs: an invented `p_leader_id` is refused (404, not
ignored); a direct `POST /agent_achievements` is **403**; a direct
`POST /agency_records` is **403**; a 12th-place agent's response carries ten
public rows plus exactly one private row and no other agent's tail; the hidden
toggle removes the agent from the leader's board entirely while their own
records survive; closing the month snapshots 38 rows and re-closing writes 0;
the Hall of Fame then names the Top Producer; no uncaught-error banner appears;
and at 390 px the page does not scroll horizontally.

**Residue: zero.** All 14 accounts deleted (13 plus one from an earlier aborted
run), and a generated sweep over every `public` base table carrying an
agent-shaped foreign key returned 0. Production afterwards: `agents` 8,
`wallet_accounts` 8 with **0 orphans**, `policies` 24, `calls` 1,298,
`agency_invites` 2 — all identical to the pre-apply audit. The leaderboard
tables hold only the real backfill (21 / 12 / 7 / 0 / 0).

### One thing the run found that is NOT this feature's

`fmt$()` in `app.html` guards with `isFinite(n)` — and global `isFinite('1200')`
is `true`, so a numeric **string** slips past the guard and `.toFixed` throws.
It surfaced only because the QA fixture seeded `data.ap` as a string. **All 24
production policies store `ap` as a JSON number** and `addPolicy()` writes
`+(monthly*12).toFixed(2)`, so nothing is broken today. Left alone — it is a
40-call-site formatter and out of this build's scope — but recorded because any
future writer that puts a string into `data.ap` will break the dashboard. The
SQL side is already immune: every AP read is regex-guarded on the text
projection.

---

## Apply 2026-07-30 — `20260751_display_names.sql`

Display names everywhere; email addresses nowhere peer-facing. Applied via
`supabase db query --linked -f <wrapped>` with `begin;`/`commit;` around the
committed file. Feature doc: `docs/agency-leaderboards.md` § "Who an agent is
called".

**Additive.** Five `create or replace function`, three guarded `UPDATE`s, one
comment, three grants. No table, no column, no index, no policy. No `DROP`, no
`DELETE`, no `TRUNCATE`. Nothing in `auth.*` is written — it is read, for the
name a consumer's own identity provider already gave us. Re-running is a no-op.

**The file is GENERATED, not hand-written.** `get_team_summary` and
`get_agency_members` are lifted verbatim from the migrations that most recently
define them (`20260741` and `20260737`) with exactly one expression substituted
in each, and the generator throws if either expression has moved. Retyping a
100-line function to change one line is how a status filter or a window bound
silently drifts — the same technique, for the same reason, that `20260741` used
on `get_team_summary`.

### What was wrong

Every name-resolving expression in this schema ended `..., au.email)`, and
**`agents.display_name` was NULL for all 8 production agents**. The fallback was
not a fallback. It was the answer, for everybody.

| Surface | What it showed for Jace |
|---|---|
| Team table "Agent" column | `jacef8778099@gmail.com` |
| All seven leaderboards | `jacef8778099@gmail.com` |
| Records (personal + agency) | `jacef8778099@gmail.com` |
| Hall of Fame, milestone feed | would have, on the next write |
| Roster, invitee view, transfer picker | ditto |
| **`agency_records.holder_name`** | **STORED as the address, 4 rows** |

Those four stored rows were live on the Records screen for two downline agents.

**The near-miss that hid it:** the old chain probed
`raw_user_meta_data->>'display_name'`, and Google OAuth writes the person's name
to `full_name` and `name`. One key away from correct — which is why nobody
noticed the fallback was load-bearing.

### The chain, and the one deliberate departure from the brief

```
1. agents.display_name                     what the agent typed in Settings
2. raw_user_meta_data->>'display_name'     preserved: the old chain's key
3. raw_user_meta_data->>'full_name'        Google/Apple give us a PERSON
4. raw_user_meta_data->>'name'             same, other providers
5. dba_name / business_legal_name / agency_name    the business profile
6. the email's LOCAL PART, prettified      never the address itself
7. 'Agent'                                 rather than a blank cell
```

The brief said "display name → business-profile name → email's front part".
**Steps 3–4 were inserted above the business profile deliberately.** A
leaderboard row names a PERSON; Jace's business profile says "Frenkel Financial
LLC" and his Google account says "Jace Frenkel", and ranking a company against
ten people reads as a bug. "Confirm my own account renders as Jace Frenkel" was
the stated acceptance test and only step 3 satisfies it. The business profile is
still in the chain, one rung lower, for an agent who has one and no OAuth name.

Step 6 keeps the promise rather than compromising on it: `owenclark.2831`
becomes "Owenclark 2831" — not a `mailto:`, not harvestable, still recognisable
to their own team.

### Pre-apply audit

| Probe | Result |
|---|---|
| `pp_display_name` | **absent** |
| `agents` with a blank `display_name` | **8 of 8** |
| `agency_records.holder_name` containing `@` | **4** |
| `get_team_summary` / `get_agency_members` signatures | 1 / 1 |
| `agency_milestones` / `leaderboard_snapshots` | 0 / 0 rows |
| `policies` / `agents` | 24 / 8 |

### Post-apply audit

| Probe | Result |
|---|---|
| `pp_display_name` | present, `prosecdef = true`, **`authenticated` may execute: false** |
| `agents` still blank | 6 — and each resolves at READ time (e.g. "Owenclark 2831") |
| Jace's `display_name` | **`Jace Frenkel`** |
| `agency_records.holder_name` containing `@` | **0** — all now `Jace Frenkel` |
| `get_team_summary` / `get_agency_members` | still exactly 1 signature each |
| `policies` / `agents` | 24 / 8 — **unchanged** |
| Re-run of the file | clean no-op |

The backfill filled 2 of 8 (the two agents with an OAuth name). The other 6 are
left NULL on purpose: `pp_display_name()` resolves the same value at read time,
and writing a derived name into the column would make it look like something
the agent had chosen.

### Behavioural verification — 14/14

Run inside a transaction that **rolled back**, with `session_replication_role =
replica` set `LOCAL`. **This one inserted four rows into `auth.users`** to
exercise the identity-provider branches, which the ledger's rules say must be
named out loud: the transaction rolled back and `agents` was re-confirmed at 8
with 0 fixture rows afterwards, so nothing persisted.

| # | Check | Result |
|---|---|---|
| 1 | a typed display name wins over everything | PASS |
| 2 | **the identity provider's person name beats the business profile** | PASS |
| 3 | the business profile is used when there is no person name | PASS |
| 4 | with nothing at all, the email LOCAL PART is prettified | PASS |
| 5 | …and it carries no `@` and no domain | PASS |
| 6 | an unknown agent is "Agent", never null or blank | PASS |
| 7 | a whitespace-only display name is not a name | PASS |
| 8 | `lb_agent_name` returns exactly what the resolver returns | PASS |
| 9 | **NO AGENT IN THIS DATABASE RESOLVES TO AN EMAIL ADDRESS** | PASS |
| 10 | `get_team_summary` names nobody by address | PASS |
| 11 | **JACE RENDERS AS "Jace Frenkel" ON THE TEAM TABLE** | PASS |
| 12 | the lead-transfer picker names nobody by address | PASS |
| 13 | no agency record is held by an address | PASS |
| 14 | …and the record Jace holds says his name | PASS |

### The one place an email is still shown, on purpose

A **pending** or **declined** invite card. There is no account yet, so the
address the leader typed is the only identifier the row has. A **connected**
agent is a person and is named as one — the address beside their name is gone.
Two tests pin both halves.

Search is also unchanged: typing an email into the lead-transfer recipient
search still finds the person. The rule is about what is *rendered*, not what is
*matched*, and the sweep test is scoped accordingly.

### No edge function changed

Nothing was deployed; the fleet was not disturbed and no `verify_jwt` flag could
move.

---

## No schema change — Summary and Agency period controls (2026-07-30)

Recorded here because "we checked and changed nothing" is exactly what this
ledger exists to stop someone re-deriving. **Lifetime, the month picker and the
custom date-range selector needed no migration**: every window is expressed in
the bounds the existing RPCs already accept (`get_team_summary` has taken eight
optional `timestamptz` bounds since `20260738`, `NULL` meaning unbounded, and
`get_agency_leaderboards` takes four).

The whole feature is one shared key grammar in `app.html`:

```
'month:2026-04'                a past calendar month
'custom:2026-04-01:2026-04-17' an inclusive range
```

parsed by **one** parser (`ppParsePeriodKey` / `ppDynamicRange`) that **both**
period engines call — `summaryPeriodRange` and `teamPeriodRange`. A test asserts
each helper is defined exactly once and that neither engine grew its own.

**Most Improved compares against the preceding range of EQUAL LENGTH** (and, for
a picked month, the month before). That is why the board stays available on a
custom range instead of being hidden: `ppDynamicRange` emits `prevStart`/
`prevEnd`, which is what `lb_board_rows` already reads, so **`20260750` needed no
change at all**. The screen states the comparison in a line under the board.

Two live bugs the headless run caught, both fixed before shipping:

1. **The drill-down profile still printed the agent's email** under their name.
   Missed by the source sweep because it read a local called `email` rather than
   an `agent_email` field.
2. **A picked month or custom range silently reverted to the default on the next
   page load.** Both `ledgerPeriod` and `_teamPeriod` are initialised from
   `localStorage` at load, and only the *setters* had been taught the new
   grammar. A control that forgets what you chose is worse than not offering it.

---

## Applied — `20260753_ai_transfer_booking.sql` (2026-07-30)

AI Sales Agent Phase 2: warm transfer + whisper, agent availability, appointment
booking, and the structured qualification object.

Applied with `npx supabase db query --linked -f <file>`, wrapped in
`begin; … commit;`. `psql` is still not installed on this machine and
`SUPABASE_DB_URL` is still not in `.env.local`; the CLI's `db query --linked`
goes through the Management API and runs the file as one transaction, which
satisfies the "wrap each file so a partial apply rolls back" rule.

**Filename note.** The prompt asked for `20260731_…`. That number was already
taken by `20260731_a2p_resumable_registration.sql`, and this directory is
applied in filename order, so it was filed at **20260753** — the next free
number after `20260752_ai_call_events.sql`, and after the `ai_calls` /
`ai_call_events` tables it alters. Nothing else about it changed.

### Verified present after the apply

| Object | Result |
|---|---|
| `agents.transfer_number`, `agents.ai_availability` | 2/2 present |
| `ai_calls.qualification`, `.transfer_status`, `.transfer_to`, `.transfer_call_control_id`, `.appointment_id` | 5/5 present |
| `public.ai_appointments` | present |
| `ai_calls_outcome_check` (replaced, now 12 tags) | present |
| `ai_appointments` RLS policies | 1 (SELECT-own only, as intended) |

### Decisions worth not re-deriving

- **`ai_availability` defaults to `'busy'`.** A transfer rings a real person's
  cell mid-conversation. Ringing is opt-in.
- **No RLS change was needed, and none was made.** `agents_update_own` was
  confirmed against production as row-ownership only (`auth.uid() = id` for both
  USING and WITH CHECK), and `agents_protect_privileged_columns` (20260703c) is
  a DENYLIST of billing/privilege columns. So both new columns are owner-
  writable exactly like `ai_voice` (20260727), `ai_agent_name` (20260730) and
  `hide_from_leaderboards` (20260750). They were deliberately NOT added to the
  denylist: they are the agent's own settings.
- **`ai_appointments` is SELECT-only for `authenticated`.** Every write goes
  through `ai-call-tools` under the service role, which takes the agent from
  the CALL, never from a request body. Do not add an INSERT policy: one broad
  enough to let a browser record an appointment is broad enough to let it record
  one against another agent's book — and this table is what a confirmation SMS
  is sent from.
- **A new table rather than the existing calendar.** The Calendar tab is
  READ-ONLY Google Calendar, fetched in the BROWSER with a GIS token under the
  `calendar.readonly` scope; there is no server-side refresh token and no write
  scope, so an edge function cannot put anything into it. The Calendar tab now
  merges `ai_appointments` alongside the Google events.
- **The lead's `data.status` is deliberately NOT the record of a booking.**
  `leads.data` is a jsonb blob the browser owns — `sbUpsertAllLeads()` re-upserts
  every lead on every save, so a server-side write to `data.status` is silently
  overwritten the next time the agent edits anything. An appointment the AI
  booked must not disappear because someone renamed a lead.

---

## Applied — `20260801_ai_inbound.sql` (2026-07-30)

AI inbound answering: ring the agent first, AI picks up as backup.

Applied with `npx supabase db query --linked -f <file>`, wrapped in
`begin; … commit;` (same mechanism and reasoning as 20260753).

### Verified present after the apply

| Object | Result |
|---|---|
| `ai_calls.direction`, `ai_calls.answered_by` | 2/2 present |
| `phone_numbers.ai_inbound_enabled` | present |
| numbers with `ai_inbound_enabled = true` | **1** (`+12029981783` only) |

### Decisions worth not re-deriving

- **`ai_inbound_enabled` defaults FALSE and is per-number.** Six other agents
  own numbers on the same Telnyx application. A flag on means strangers can
  make somebody's personal cell ring; nobody gets that by default. The one
  number opted in is the AI dialer's own outbound caller ID — the number a lead
  would call back after seeing it on their phone.
- **`answered_by` decides the RATE, and is scoped to inbound.** An inbound call
  the agent answered themselves never had an assistant on it, so it bills at
  the platform's standard human per-minute rate through `public.calls` and
  takes zero `ai_call` minutes. An OUTBOUND warm transfer is also answered by
  the agent and still bills entirely at the `ai_call` rate (Round C decision) —
  which is why the finalize guard tests `direction = 'inbound' AND answered_by
  = 'agent'` and not `answered_by` alone.
- **`public.calls` needed no migration.** `calls.direction` already carried
  `check (direction in ('outbound','inbound'))` and all 1,403 existing rows are
  `'outbound'`. A bridged inbound call writes a normal `'inbound'` row there,
  which is correct: it IS a human call, and that table is what the human
  dialer's minute cap and the Summary dial/contact analytics read.
- **A lead created from an inbound call gets `tcpa_consent = false`.** The
  consumer called US, which is what makes ANSWERING lawful; it is not consent
  to be dialed by an artificial voice tomorrow. `ai-call-start`'s gate must
  keep refusing them until real consent is captured. Do not default it true
  for inbound.
- **No `leads` migration.** The table already had everything; recorded here so
  the next reader does not go looking.

---

## Applied — `20260802_ai_call_meter.sql` (2026-07-30)

Daily AI-call meter: a recommended pace, a seven-day ramp for a new number,
and the agent's own cap.

Applied with `npx supabase db query --linked -f <file>`, wrapped in
`begin; … commit;` (same mechanism and reasoning as 20260753 / 20260801).

### Verified present after the apply

| Object | Before | After |
|---|---|---|
| `agents.ai_daily_call_cap` | absent | present, `default 300` |
| `agents.timezone` | absent | present |
| `phone_numbers.ai_first_used_at` | absent | present |
| `public.ai_pace_events` | absent | present, RLS on, **1 policy (SELECT)** |
| `agents_ai_daily_call_cap_check` | absent | present |
| agents with `ai_daily_call_cap = 300` | — | **9 of 9** |
| agents with a NULL cap | — | 0 |
| `phone_numbers` backfilled from `ai_calls` | — | **1 of 7 active** (`+12029981783`, first used 2026-07-27) |
| `phone_numbers_protect_privileged_columns` guards `ai_first_used_at` | no | **yes** |

Row counts unchanged: 9 agents, 7 active numbers, 14 `ai_calls`.

### Decisions worth not re-deriving

- **NULL `ai_daily_call_cap` means NO CAP, and it is a supported one-click
  state.** The column default is 300 — the same number as the recommendation —
  so `add column … default 300` gave all nine existing rows a cap in one pass.
  There is deliberately **no `update … set ai_daily_call_cap`** anywhere in the
  file: a blanket backfill would hand the cap back to an agent who had cleared
  it on purpose the next time anyone re-ran the migration. A test asserts that
  statement is absent.
- **The recommendation is not in the database.** No column, no function, no
  check constraint computes 300 or the ramp. It lives once in
  `_shared/ai-call-meter.ts` (mirrored in `// <ai-meter-core>` in `app.html`,
  with a parity test), because it is advice that changes, not a constraint.
- **`agents.timezone` is written by the BROWSER**, from
  `Intl.DateTimeFormat().resolvedOptions().timeZone`, and only when it changed.
  "Today" has to mean the agent's today; the server only knows UTC. All nine
  rows are NULL right now, so every account currently meters on the
  `America/Chicago` fallback. **No area-code inference** — guessing where a
  PERSON is from a number they bought online files calls on the wrong day.
- **`ai_first_used_at` is client-immutable**, added to the 20260730 denylist
  trigger. A browser that could backdate it would buy a fresh number a matured
  number's 300-call recommendation on the day it was purchased — the exact
  reputation risk the ramp exists to prevent.
- **`ai_pace_events` is keyed `unique (agent_id, local_day)` and has ONE
  policy, SELECT.** The unique key is what makes "one warning per agent per
  day" true — `ai-call-start` offers a row on every call past the
  recommendation and the key discards all but the first, so the count stored is
  the one at the FIRST warning, not the day's total. Do not add an INSERT
  policy: a browser that can write here can forge, or suppress, the record that
  it was warned.
- **`ai_call_events` was deliberately not reused for this.** It is keyed on a
  Telnyx `call_control_id`, carries raw Telnyx payloads, has no `agent_id` to
  scope an owner policy by, and is service-role-only. A pace warning belongs to
  an agent and a day, and the agent is allowed to see it.

---

## Applied — `20260802b_voice_campaigns.sql` (2026-07-30)

Voice campaigns: the AI dials the book on its own, by rules. Plus Part 0 —
inbound answering turned on for every number an agent owns.

Applied with `npx supabase db query --linked -f <file>`, wrapped in
`begin; … commit;` (same mechanism and reasoning as 20260753 / 20260801 /
20260802). Filed at `20260802b` because `20260802_ai_call_meter.sql` was applied
earlier the same day and this file alters `ai_calls` and `phone_numbers` after
it.

### Verified present after the apply

| Object | Result |
|---|---|
| `voice_campaigns`, `voice_campaign_steps`, `voice_campaign_enrollments` | 3/3 present |
| `ai_calls.enrollment_id`, `.campaign_id`, `.campaign_step` | 3/3 present |
| `phone_numbers.ai_inbound_enabled` default | `true` |
| numbers with inbound on | **7 of 7** (the power-dialer host is not in this table) |
| `voice_campaign_enrollments` policies | **1** — SELECT-own only, as intended |
| `voice_campaigns` policies | SELECT, INSERT, UPDATE, DELETE (owner-writable config) |
| `voice_campaigns_validate`, `voice_campaign_steps_derive` triggers | 2/2 present |

### Decisions worth not re-deriving

- **`ai_inbound_enabled` went from `default false` to `default true`, and that
  is a product decision, not a loosening.** 20260801 shipped it false while the
  inbound flow was unproven; the flow is proven, and an agent who buys five
  numbers and finds four of them ring out has a broken product, not a safe one.
  The person whose cell rings is the number's OWNER, the call is a callback to
  a number they chose to publish, and the flow rings them first with the
  assistant only as backup. The per-agent kill switch and the per-number
  opt-out (now surfaced in the Phone Book) both still exist.
- **The power-dialer host is excluded by e164 and forced FALSE.** It is not in
  `public.phone_numbers` at all today — it is owned at the Telnyx account level,
  not by an agent — and `telnyx-call-status` checks it before the AI branch
  anyway, so a flag there could never fire. The predicate is what keeps that
  true if the row is ever added.
- **No purchase path was edited.** `telnyx-buy-number`,
  `telnyx-provision-number` and `telnyx-replace-number` all INSERT without
  naming the column, so the default is what a newly bought number gets — one
  default beats three call sites that have to remember, and a fourth path added
  later inherits it. Verified none of the three names the column.
- **`voice_campaign_enrollments` is SELECT-only for `authenticated`, and this
  is the boundary that matters in this migration.** An enrollment is a standing
  instruction to place phone calls to a consumer; a browser that could write one
  could enroll a lead with no consent, and the whole compliance story would rest
  on the UI being polite. Campaigns and steps ARE owner-writable — they are
  configuration, the same class as `producer_codes`.
- **The trigger-group tag rule is enforced in the database as well as in the
  browser and the edge function**, because `voice_campaigns` is owner-writable
  and the browser is not the only thing that can PATCH it. It fires **only for
  `active = true`**: a draft may be half-written, and an editor that refuses to
  save an unfinished rule is an editor nobody can use.
- **`voice_campaign_steps.agent_id` is derived by a trigger**, never accepted
  from the client — same reasoning as `producer_codes.code_key`. The INSERT
  policy therefore checks the CAMPAIGN's owner, not the row's `agent_id`, which
  does not exist yet when `WITH CHECK` runs.
- **The one-active-campaign rule is a partial unique index on `lead_id`**, not
  application logic. A lead in two voice campaigns gets two robots in one
  afternoon and neither campaign's numbers mean anything afterwards.
- **`voice_campaigns_seed_uidx` is PARTIAL** (`where seed_key is not null`),
  because hand-made campaigns have a NULL key and a total index would collide
  every one of them against every other. A partial index cannot be inferred from
  a bare column list, so the next round's seeder must write
  `on conflict (agent_id, seed_key) where seed_key is not null` — a form
  PostgREST cannot express. **The seed runs as SQL or in an edge function.**
  This was found by hitting `42P10` during the dry-run setup, not by reading.
- **`campaign_id` and `campaign_step` sit on `ai_calls` beside
  `enrollment_id`**, denormalised on purpose: the drip throttle counts calls per
  (campaign, step) over a rolling window and that must be one indexed query, and
  a campaign's stats must survive an enrollment being deleted with its lead.

---

## Applied — `20260803_default_voice_campaigns.sql` (2026-07-31T04:3xZ)

Applied by: Claude (Opus 5), `supabase db query --linked -f <wrapped>` with
`begin;`/`commit;` around the whole file. **Additive only** — new columns, two
new tables, four new functions, two new triggers, one `CREATE OR REPLACE` of
`voice_campaigns_validate()`, and a backfill that only INSERTs. No `DROP`, no
`TRUNCATE`, no `DELETE`, nothing in `auth.*` / `storage.*`. No approval needed
under the rules at the top of this file.

Read `docs/voice-campaigns-defaults.md` for the decisions.

### Audit before → after

| Object | Before | After |
|---|---|---|
| `voice_campaigns.sort_order` | absent | present, `not null default 100` |
| `voice_campaigns.campaign_goal` | absent | present + `voice_campaigns_goal_check` (7 values or NULL) |
| `voice_campaigns.trigger_on_appointment_booked` | absent | present, `not null default false` |
| `voice_campaign_steps.anchor` / `offset_minutes` | absent | present, `previous_step` / `0`, both CHECK-constrained |
| `voice_campaign_enrollments.appointment_id` | absent | present, FK → `ai_appointments` `on delete set null` |
| `public.voice_campaign_seed_state` | absent | present, RLS on, **1 policy, SELECT only** |
| `public.lead_consent_events` | absent | present, RLS on, **1 policy, SELECT only** |
| `vc_default_campaigns()` | absent | present |
| `vc_seed_default_campaigns()` / `_for(uuid)` | absent | both present; `_for` REVOKEd from `public`/`anon`/`authenticated` |
| trigger `agents_seed_voice_campaigns` | absent | present, AFTER INSERT on `public.agents` |
| trigger `leads_protect_consent_columns` | absent | present, BEFORE INSERT OR UPDATE on `public.leads` |
| `voice_campaigns` rows | 0 | **108** (9 agents × 12) |
| `voice_campaign_steps` rows | 0 | **612** (9 × 68) |
| `voice_campaign_enrollments` rows | 0 | 0 |
| `leads` with `tcpa_consent` | 0 | 0 |
| `voice_campaign_enrollments` policies | SELECT only | **SELECT only, unchanged** |

### Behavioural checks — 11/11 pass

Run inside a transaction and **rolled back**, against Jace's real agent id.

| # | Check | Result |
|---|---|---|
| 1a | re-running the seeder creates nothing | `was_created` count **0** |
| 1b | …and the campaign count is unchanged | **12** |
| 2a | after deactivating + renaming one, a re-seed creates nothing | **0** |
| 2b | …and the edit survives | `active=false name="MY EDITED NAME"` |
| 3a | after **deleting** one, a re-seed creates nothing | **0** |
| 3b | …and the deleted campaign **does not come back** | **0 rows** |
| 3c | …total stays at 11, not 12 | **11** |
| 4a | `status is new` refused by the DB trigger | refused |
| 4b | `status is sold` accepted | accepted |
| 4c | `status is_not sold` refused | refused |
| 4d | `state is TX` alone refused | refused |

Plus the shape that landed: Appointment Reminder steps
`1:appointment@-1440, 2:appointment@-120`; `sort_order` 10…120 with the twelve
names in the intended order; goals present = `care, chargeback,
emergency_contact, qualify, rebook, referral, remind`.

### The consent column guard — 3/3 pass

`auth.role()` is **JWT-derived**, not the Postgres role, which is what makes the
guard fire for a PostgREST request and not for a service-role edge function.
Tested by setting `request.jwt.claims` inside a rolled-back transaction:

| Claims | Statement | Result |
|---|---|---|
| `{"role":"authenticated","sub":<jace>}` | `set tcpa_consent=true, source, at` | **silently reverted** — `consent=false source=(null)` |
| `{"role":"service_role"}` | the same statement | **applied** — `consent=true` |
| `{"role":"authenticated","sub":<jace>}` | `set data=…, tcpa_consent=false` | data edit applied, **consent survived** |

Jace's own account **is** an admin, and this guard deliberately has no admin
exemption — so that first row is also the proof that an admin cannot assert
consent either.

### Live end-to-end, no phone rang

All twelve of Jace's campaigns were set `dry_run = true` for the duration and
**restored to `false` afterwards**. A synthetic consented lead
(`+18085550147`, Hawaii — inside the lead-local window at 04:35 UTC so gate 4
was genuinely exercised) was consented through the **real `leads-consent`
endpoint with a real user JWT**, enrolled by the **live pg_cron tick** into
exactly one campaign (Final Expense, via `lead_type is final expense`), and
dry-run dialed through the full six-gate chain with
`campaign_goal: "qualify"` in the assistant vars and the caller ID rotated to
the mature number (recommended 150, used 11, headroom 139).

**Cleaned up:** enrollment stopped, lead deleted (its `lead_consent_events`
cascaded), `dry_run` restored. Final state verified: 12 active · 0 dry-run ·
0 paused · **0 active enrollments anywhere** · **0 queued** · 0 leads with
consent in the whole database · **0 campaign calls ever placed**. A clean tick
afterwards swept 9 agents and 108 campaigns and did nothing.

### Notes worth keeping

- **The tombstone table is the whole idempotency story.** Presence is keyed on
  `voice_campaign_seed_state (agent_id, seed_key)`, not on the campaign,
  because a DELETED campaign is indistinguishable from one never seeded — and
  resurrecting one restarts a program that phones consumers. Nothing automatic
  removes a tombstone row; deleting one by hand is how a default is re-offered.
- **The seeder's OUT columns are `campaign_seed_key` / `was_created`, not
  `seed_key` / `created`.** plpgsql substitutes its own variables into SQL, and
  a variable named `seed_key` would shadow the COLUMN of that name in
  `on conflict (agent_id, seed_key)` — the one statement the idempotency rests
  on.
- **The agent-creation hook is on `public.agents`, not inside
  `auth.handle_new_user()`**, and it swallows its own exceptions. Every path
  that creates an agent goes through that table, and a sign-up must never fail
  because a default campaign did not insert.
- **`voice_campaigns_validate()` was replaced, not extended.** The only change
  is that a positive `status is <sold|appointment|chargeback|lapsed>` now counts
  as a narrowing condition. `status is new` still does not, and that exclusion
  is why `status` is absent from `tag_fields` in the first place.

---

## 20260805_campaign_mission_control.sql — APPLIED 2026-07-31

Prompt J. Verified in-database at apply time: 2 new columns, 1 trigger, 2
functions, 1 index, **0 write policies** on `voice_campaign_enrollments`.

- `voice_campaign_enrollments.paused_at` and `.last_gate_code` — both display
  only. `status = 'paused'` is what actually holds a lead (the tick's due query
  and `vcClaimEnrollment` already required `'active'`); `last_gate_code` is
  cleared the moment a call goes out, in both places that place one.
- `leads_preserve_ai_status()` + `pp_jsonb_ts()` — the database half of the AI
  ordering guard, and the thing that makes a server-side status write STICK
  against `sbUpsertAllLeads()`'s whole-book re-upsert. Browser writes only
  (`auth.role()`), guards only a status whose `status_source = 'ai'`. Probed
  live against a real row in a rolled-back transaction: stale echo refused,
  echo with no stamp refused, fresh human edit wins, unparseable stamp does not
  raise.
- `ai_calls_campaign_created_idx` for the activity feed.

## 20260806_sms_ai_responder.sql — APPLIED 2026-07-31

Prompt SMS-1. Verified in-database at apply time: 4 tables, **0 non-SELECT
policies** on `sms_conversations` / `sms_messages` / `sms_nudges`, 4 policies on
`sms_ai_settings` (owner-writable by design), `agents.sms_ai_enabled` present
and true for all 9 agents, `ai_appointments.sms_conversation_id` present, both
key unique indexes present.

- `public.messages` and `public.inbound_messages` are NOT replaced and NOT
  migrated. They stay the BILLING and PROVIDER records — `messages.hold_ledger_id`
  is what `wallet_settle`/`wallet_void` resolve against, and
  `inbound_messages.provider_event_id` carries the unique index that makes
  Telnyx retries idempotent. `sms_messages` is the CONVERSATION record and
  points at both.
- `sms_ai_settings` is the only owner-writable table here — it holds wording
  preferences, and nothing in it can cause a message to be sent. `agent_id` is
  DERIVED by `sms_ai_settings_set_agent()` from `auth.uid()`, never accepted
  from the client. The 20-pair cap is a CHECK constraint as well as an editor
  rule, because the table is owner-writable.
- `sms_nudges_one_scheduled_uidx` is partial on `status = 'scheduled'` — one
  live follow-up per conversation, and it is also what stops two sweeps sending
  the same nudge.
- A text booking lands in the SAME `ai_appointments` table as a call, with
  `source = 'ai_text'` and `ai_call_id` left null. There is no second
  appointments table.

## 20260807_sms_campaigns.sql — APPLIED (confirmed 2026-07-31, backfilled entry)

Prompt SMS-2. The apply itself happened in the SMS-2 round; this entry was
written in the SMS-3 round, which re-verified every object it depends on
in-database before building on it.

```
voice_campaigns.channel / stop_on_reply / pause_on_active_conversation   3/3 present
voice_campaign_steps.body / media_url                                    2/2 present
voice_campaign_enrollments_one_active_uidx  ->  (lead_id, channel) WHERE status='active'
voice_campaign_enrollments non-SELECT policies                           0
```

- **There are NO new campaign tables.** `voice_campaigns` grew a `channel`; a
  row with `channel = 'sms'` IS a texting campaign. The `voice_` prefix is
  historical — see `docs/sms-campaigns.md`.
- **`voice_campaign_enrollments` stays SELECT-only** and the channel column
  makes an INSERT policy strictly worse than before: a browser that could write
  an enrollment could now also choose which of a lead's two channel slots to
  occupy. Do not add one.
- The `enrolled_by` CHECK was widened to include `appointment_booked` — a value
  `voice-campaign-tick`'s appointment re-arm path had been writing since
  `20260803` against a constraint that never allowed it, failing silently inside
  a sweep that swallows its errors.

## 20260808_default_sms_campaigns.sql — APPLIED 2026-07-31

Prompt SMS-3. Dry-run applied inside `begin; … ; rollback;` first, then for
real. Verified in-database at apply time:

```
before   9 agents · 108 campaigns (108 voice, 97 active) · 108 seed rows · 0 enrollments
after    216 campaigns (108 voice UNCHANGED + 108 sms, 0 sms active)
         1,881 sms_message steps · 216 seed rows · 0 enrollments
         vc_default_sms_campaigns / vc_seed_default_sms_campaigns_for /
         vc_seed_default_sms_campaigns                     all present
         trigger agents_seed_sms_campaigns on public.agents present, enabled
```

- **🔴 ALL 108 SEEDED TEXT CAMPAIGNS ARE `active = false`** and an unscoped tick
  afterwards reported `campaigns: 97` — the voice twelve across nine agents and
  nothing else. An off campaign is not read, not swept and enrols nobody.
- **No new table.** It adds three functions, one trigger and rows. The tombstone
  is the EXISTING `voice_campaign_seed_state`; the twelve SMS seed keys are the
  bare `SMS_AI_TYPES` names and cannot collide with the voice twelve's `*_v1`.
- **Idempotency and the three promises proved against the real data** in a
  rolled-back transaction: a seeded campaign switched on, renamed and rewritten
  kept all three across three further re-seeds; a deleted one was not
  resurrected (107 rows, not 108); no new tombstones.
- No `DROP`, no `TRUNCATE`, no `DELETE`, nothing touching `auth.*` or
  `storage.*`. The only `UPDATE` in the seeder is the activate step, keyed on
  the id it just created, and it does not fire for any of the twelve.

## 20260810_contract_levels.sql — APPLIED 2026-08-01

Prompt OV1 (Round 1 of 2, backend only). Dry-run applied inside
`begin; … ; rollback;` first — verified the table and both functions were
absent again afterwards — then for real. Verified in-database at apply time:

```
contract_level_changes   present, 6 columns, RLS ON, 1 policy, cmd = SELECT
agents_log_contract_level  trigger present on public.agents (AFTER UPDATE OF contract_level)
set_downline_contract_level / get_downline_product_ap    both present
get_agency_members       re-created with 8 columns (was 5), grant restated
```

- **One new table, one index, one SELECT policy, one AFTER trigger, two new
  functions, one function widened.** No `DROP` of a table, column or row; no
  `DELETE`, no `TRUNCATE`; nothing in `auth.*` or `storage.*` written. The file
  is one transaction, because widening `get_agency_members`'s `RETURNS TABLE`
  needs `DROP` + `CREATE`.
- **🔴 The logger is an AFTER trigger and that is load-bearing.**
  `agents_log_contract_level` sorts alphabetically **ahead of all seven**
  existing `BEFORE UPDATE` triggers on `public.agents`, and those guards work by
  silently reverting `NEW.col := OLD.col`. A BEFORE logger would record changes
  a later guard undid. `20260703c` is a **denylist** that names `contract_level`
  nowhere, so a self-update passes through it and is logged.
- **`contract_level_changes` is SELECT-only for `authenticated`** and the
  migration adds no write policy. Proven live: a browser-role `INSERT` answered
  `42501: permission denied for table contract_level_changes`.
- **Guards proved live in rolled-back transactions**, impersonating real agents
  via `set local role authenticated` + `request.jwt.claims`: a non-downline
  target refused (`42501`), an invented third argument refused (`42883`), levels
  200 and 65 refused (`22023`), 103 stored as 105 with exactly one audit row
  carrying the leader as `changed_by`, an agent self-update logged with
  `changed_by = agent_id`, and a stranger reading the log getting 0 rows.
- **`get_downline_product_ap`'s AP equals `get_team_summary`'s `lifetime_ap` to
  the cent** ($15,440.04 and $8,977.80 across the two agents with a book) — the
  behavioural half of the byte-identical sale predicate.
- **No production contract level was changed.** Every write in the verification
  ran inside a transaction that was rolled back; `contract_level_changes` holds
  0 rows.
