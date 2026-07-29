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
