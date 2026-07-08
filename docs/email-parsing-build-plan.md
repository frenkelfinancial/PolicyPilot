# ProducerStack — Carrier Email Parsing: Build Plan

Stack: static frontend on GitHub Pages (`app.html`, Capacitor wrapper for mobile — NO Next.js, NO Vercel deployment; `vercel.json` is leftover, do not delete) · Supabase (Postgres/Auth/Edge Functions — all backend logic lives in Edge Functions like the existing `stripe-*`/`telnyx-*` functions) · Claude API (Haiku, model `claude-haiku-4-5`)
Decisions locked: worker on **Supabase Edge Functions + pg_cron** · **Google test mode + weekly reconnect** for pilot · **90-day backfill** on connect · **auto-apply high-confidence only**.

---

## 1. Architecture in words

**OAuth flow.** Agent clicks "Connect Gmail" in `app.html` settings → browser hits Edge Function `gmail-oauth-start` (authenticated via Supabase JWT), which 302-redirects to Google's consent screen requesting a single scope: `gmail.readonly` (restricted scope), with a signed `state` parameter binding the flow to the user. Google redirects back to Edge Function `gmail-oauth-callback` (redirect URI: `https://<project-ref>.supabase.co/functions/v1/gmail-oauth-callback`), which verifies `state`, exchanges the code for access + refresh tokens, encrypts and stores the refresh token in `gmail_accounts`, then redirects the browser back to `https://producerstackcrm.com/app.html#settings?gmail=connected`. The frontend never sees tokens. Access tokens are short-lived (~1h) and refreshed on demand by the worker. Authorized JavaScript origin: `https://producerstackcrm.com`. No Next.js `/api` routes, no Vercel URLs anywhere in this flow.

**Gmail access method: polling, not Pub/Sub push.** Recommendation: **poll every 5 minutes** via pg_cron → Edge Function.

- Push (users.watch + Cloud Pub/Sub) is "free" but adds a GCP Pub/Sub topic, an HTTPS push endpoint, per-user `watch()` renewal every 7 days, and notification handling that still requires you to call `history.list` anyway — the push only tells you "something changed."
- Polling with `history.list(startHistoryId)` is incremental and cheap: one API call per user per cycle returns only new message IDs since the last sync. At 10 users × 288 polls/day you're at ~3k quota units/day against a default quota of millions. Latency of ≤5 minutes is fine for policy-status emails.
- The sync engine is identical either way (`history.list` → fetch new messages). If you later want near-instant updates, you swap the *trigger* (cron → Pub/Sub webhook) without touching the pipeline. No rework.

**Pipeline (per new message).**
1. **Filter** — match `From` header (and for shared senders, subject regex) against the `carrier_senders` map. No match → ignore, log nothing beyond a counter. This keeps 95%+ of inbox volume away from Claude entirely.
2. **Classify** — the matched map row gives carrier, email_type, content_type, and route. Deterministic, zero LLM tokens.
3. **Branch by content type**:
   - **body** → strip HTML to plain text, trim boilerplate/disclaimers, send to Haiku with a per-email-type extraction schema (tool use / structured output). Target ≤1,500 input tokens.
   - **PDF** → download attachment via Gmail API, extract text (unpdf/pdf-parse in the Edge Function). If text extraction succeeds → same Haiku text path. If the PDF is image-only → send to review queue with the PDF stored (don't burn vision tokens in v1).
   - **login-link** → **no parsing, no fetching the link.** Insert a `portal_nudge` row: carrier, received_at, subject, and any free metadata already in the body (e.g., Americo includes the client name and a link label like "Adverse Decision" — capture via regex, not LLM). Dashboard renders: "You received an email from Americo (re: Michael Kjenstad) that needs your login to view details." Informational tone, dismissible, never styled as an error.
4. **Match & route** — link the parsed event to a policy (see §6), then route: policy/underwriting/payment/lapse events → policy tracker; commission events → commission summary; unmatched or low-confidence → review queue.
5. **Apply** — high-confidence + exact policy match auto-applies; the tracker stores *events*, and current status is derived (see §7 on overwrite protection).

**Supabase schema additions** — see §4.

---

## 2. Phased task breakdown (each task ≈ one coding-tool session)

**Phase 0 — Foundation (no OAuth needed; test against exported .eml samples)**
1. Migration: create all tables in §4.
2. Seed `carrier_senders` from the Job A map (seed SQL included in §5).
3. Pure function `classifyMessage(from, subject) → map row | null` + unit tests using real subjects from Job A (incl. the aatx.com case-insensitivity trap and Ethos subject filtering).
4. HTML→text cleaner (strip tags, quoted replies, disclaimers) + tests on saved carrier bodies.

**Phase 1 — Gmail connect**
5. Google Cloud project: OAuth client (web), consent screen in Testing mode, add pilot users as test users, scope `gmail.readonly`. JS origin `https://producerstackcrm.com`; redirect URI `https://<project-ref>.supabase.co/functions/v1/gmail-oauth-callback`.
6. Edge Functions `gmail-oauth-start` (auth'd redirect to Google with signed state) and `gmail-oauth-callback` (state check → code exchange → encrypt & store refresh token in `gmail_accounts` → redirect back to app.html). All secrets in Supabase Edge Function secrets — never Vercel, never the static frontend.
7. Token helper in Edge Function: decrypt refresh token → mint access token → handle `invalid_grant` by marking account `reauth_required`.
8. UI: connection status card + "Reconnect Gmail" banner when `reauth_required` (this is the weekly test-mode re-auth path — make it one click).

**Phase 2 — Sync engine**
9. Edge Function `gmail-sync`: for each active account, `history.list` since stored `history_id` (fallback: `messages.list` with `newer_than`), fetch new message metadata, run classifier, insert matched messages into `email_ingest_log` with status `pending_parse`. Idempotent on `(gmail_account_id, gmail_message_id)`.
10. pg_cron job every 5 min → invoke `gmail-sync` (via `pg_net` HTTP call).
11. Login-link branch: classifier route `nudge` → insert `portal_nudges` directly (no LLM). Dashboard notification list + dismiss.

**Phase 3 — Parsing**
12. Edge Function `parse-email`: pull `pending_parse` rows, build per-email-type Haiku prompt (structured output schema), store result + confidence in `parsed_events`, tokens/cost in the log row.
13. PDF path: attachment download, text extraction, same parse call; image-PDF → review queue.
14. Cost guards: per-account daily parse cap, global daily token budget, skip-and-queue on cap.

**Phase 4 — Matching & routing**
15. Policy matcher (see §6): normalization, exact match, TA last-5 masked match, name+carrier fallback with trigram similarity.
16. Router: apply auto-apply policy (§7 of AskUser decisions): exact match + confidence ≥ threshold → write `policy_events` / `commission_events`; else review queue.
17. Policy tracker page: render derived status from `policy_events` timeline; commission page: render `commission_events` (Americo daily balance snapshots to start).

**Phase 5 — Review queue UI**
18. Review queue page: show parsed fields vs. candidate policies, one-click "attach to policy / create policy / discard"; resolution writes the event and (optionally) a `carrier_senders` or alias correction.
19. Client-name alias memory: approving a fuzzy match stores the alias so the same client auto-matches next time.

**Phase 6 — Backfill + pilot hardening**
20. Backfill job on connect: `messages.list` per mapped sender, `newer_than:90d`, feed through the same pipeline (batched, rate-limited, capped).
21. Observability: sync/parse failure counters, last-sync timestamp per account, simple admin page.
22. Pilot onboarding: seed 4–10 test users in Google console, connect flow walkthrough, verify each carrier's mail flows end-to-end for a week.

---

## 3. Google OAuth reality (so nothing needs rework later)

- **`gmail.readonly` is a *restricted* scope.** Full verification requires Google's app review **plus an annual CASA (Cloud Application Security Assessment) by an approved lab**. Cheapest labs run roughly **$500–$4,500/yr** (quotes far higher exist; shop TAC Security / DEKRA-tier labs), and the process takes weeks to months. Revalidation is annual.
- **Testing mode (what you're doing for the pilot):** hard cap of **100 test users**, each must be explicitly listed in the consent screen config; users see an "unverified app / test access" warning at consent; **refresh tokens expire every 7 days**, so every pilot user must reconnect weekly. Free.
- **Design consequences baked into this plan:** token-expiry detection + one-click reconnect banner (Phase 1, task 8); all Gmail access behind one token helper so verification later changes *nothing* in code; scope kept to exactly `gmail.readonly` (never add scopes casually — each restricted scope re-triggers review); privacy policy + homepage URLs on your domain now (required at verification).
- **When you go public:** publish the consent screen → Google review (branding + scope justification: "reads carrier emails to update the agent's own CRM" is a legitimate, approvable use) → CASA letter of assessment → annual renewal. Budget it as a cost of going GA, not of piloting.
- **Free now:** GCP project, OAuth, Gmail API quota, Pub/Sub (if ever needed) — all $0 at this scale. The only OAuth-related money is CASA at verification time.

---

## 4. Supabase schema additions

```sql
-- Connected Gmail accounts
create table gmail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  email_address text not null,
  refresh_token_enc bytea not null,        -- encrypted, see note
  history_id text,                          -- gmail incremental sync cursor
  status text not null default 'active',    -- active | reauth_required | disabled
  connected_at timestamptz default now(),
  last_synced_at timestamptz,
  unique (user_id, email_address)
);

-- Carrier sender-and-type map (seeded from Job A, editable in admin)
create table carrier_senders (
  id serial primary key,
  carrier text not null,                    -- 'mutual_of_omaha' | 'transamerica' | ...
  from_pattern text not null,               -- lowercase address or regex, e.g. '%@mutualofomaha.com'
  subject_pattern text,                     -- regex; required when one address sends multiple types (aatx, ethos)
  email_type text not null,                 -- 'underwriting_status' | 'payment_result' | 'commission_summary' |
                                            -- 'application_activity' | 'lapse_notice' | 'portal_notification' | 'ignore'
  content_type text not null,               -- 'body' | 'pdf' | 'login_link'
  route text not null,                      -- 'policy_tracker' | 'commission_summary' | 'nudge' | 'ignore'
  active boolean default true
);

-- Every carrier email we accepted for processing (audit + idempotency + cost log)
create table email_ingest_log (
  id uuid primary key default gen_random_uuid(),
  gmail_account_id uuid not null references gmail_accounts,
  gmail_message_id text not null,
  carrier text, email_type text, content_type text,
  from_address text, subject text, received_at timestamptz,
  parse_status text not null default 'pending_parse',
      -- pending_parse | parsed | nudged | review | failed | skipped_cap
  claude_input_tokens int, claude_output_tokens int,
  error text,
  created_at timestamptz default now(),
  unique (gmail_account_id, gmail_message_id)
);

-- Structured output of a parse
create table parsed_events (
  id uuid primary key default gen_random_uuid(),
  ingest_id uuid not null references email_ingest_log,
  user_id uuid not null,
  carrier text not null,
  event_type text not null,       -- submitted | approved | declined | withdrawn | requirement |
                                  -- payment_scheduled | payment_returned | lapse_pending | closed |
                                  -- commission_snapshot | commission_change
  policy_number_raw text,         -- exactly as seen (may be masked: 'xxxxx76911')
  client_name text,
  amounts jsonb,                  -- {premium, face_amount, commission_balance, ...}
  event_date date,
  details jsonb,                  -- full structured extraction
  confidence numeric,             -- model-reported 0..1
  matched_policy_id uuid,         -- null until matched
  applied boolean default false
);

-- Review queue
create table review_queue (
  id uuid primary key default gen_random_uuid(),
  parsed_event_id uuid not null references parsed_events,
  user_id uuid not null,
  reason text not null,           -- low_confidence | no_policy_match | ambiguous_match | pdf_unreadable
  candidate_policy_ids uuid[],
  status text not null default 'open',   -- open | resolved | discarded
  resolved_by uuid, resolved_at timestamptz
);

-- Login-required nudges (NOT errors)
create table portal_nudges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  carrier text not null,
  subject text, client_hint text,          -- e.g. 'Michael Kjenstad' scraped by regex
  received_at timestamptz,
  ingest_id uuid references email_ingest_log,
  dismissed_at timestamptz
);

-- Append-only policy history; tracker status is DERIVED from these
create table policy_events (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references policies,
  parsed_event_id uuid references parsed_events,
  event_type text not null, event_date date, details jsonb,
  source text not null default 'email',
  created_at timestamptz default now()
);
```

RLS on every table keyed by `user_id`. **Token encryption:** simplest solid option is app-level AES-256-GCM with the key held only in Edge Function secrets (`Deno.env`); Supabase Vault is the alternative (decision D1 in §8). Either way the refresh token is never readable via PostgREST.

---

## 5. How the carrier map drives filtering and routing

The `carrier_senders` table **is** the routing logic — code stays generic; carrier knowledge lives in data you can edit without deploys.

Matching order per message: lowercase the From address → find rows where `from_pattern` matches → if multiple rows or the row has a `subject_pattern`, apply subject regex to pick one → no row = not a carrier email, ignore.

Seed rows (from your actual inbox):

| carrier | from_pattern | subject_pattern | email_type | content_type | route |
|---|---|---|---|---|---|
| mutual_of_omaha | `%@mutualofomaha.com` (person addresses) | `^(App Review|Withdrawn|Phone Interview|Approved|Declined)` | underwriting_status | body | policy_tracker |
| mutual_of_omaha | `do_not_reply_igo_eapp@mutualofomaha.com` | — | application_activity | body | policy_tracker |
| mutual_of_omaha | `noreply.login@login.mutualofomaha.com` | — | ignore | — | ignore |
| transamerica | `mocasemanagement@transamerica.com` | — | underwriting_status | body | policy_tracker |
| transamerica | `newbusinesstlp@transamerica.com` | — | application_activity | body | policy_tracker |
| transamerica | `notifications@mylifeinsurance.transamerica.com` | `Payment|Purchase` → payment_result; `Application Results` → underwriting_status; `Documents Are Ready` → policy_active | (per subject) | body | policy_tracker |
| transamerica | `tlp-crcontractadmin@transamerica.com` | — | commission_change | body+pdf | commission_summary |
| transamerica | `transamericacxinsights@…`, `webhelp@…`, `awdemailnotification@…` | — | ignore | — | ignore |
| corebridge | `sigiteam@corebridgefinancial.com` | — | payment_result / underwriting_status | body | policy_tracker |
| corebridge | `svc_ilcc_prod@corebridgefinancial.com` | — | portal_notification | login_link | nudge |
| americo | `noreply@americo.com` | `Americo Daily Update` | commission_summary | body | commission_summary (+ lapse counts → policy_tracker) |
| americo | `donotreply@americo.com` | `New Notification Regarding` | portal_notification | login_link | nudge |
| americo | `noreply.collections@americo.com` | — | commission_change (debt) | body | commission_summary |
| americo | `lindsay.autry@`, `andrew.kostus@`, `americo.marketing@`, `brandon.wilson@americo.com` | — | ignore | — | ignore |
| american_amicable | `noreply@aatx.com` | `APPLICATION ACTIVITY` → application_activity; `Returned Payment` → payment_result | (per subject) | body | policy_tracker |
| american_amicable | `%@american-amicablegroup.ccsend.com`, `marketingassistants@americanamicable.com` | — | ignore | — | ignore |
| ethos | `ethosforagent@mail.ethos-agents.com` | `complete.*application|application is almost done` → application_activity; `compensation` → commission_change; else ignore | (per subject) | body | policy_tracker / nudge |
| ethos | `agents@ethoslife.com` | — | ignore | — | ignore |

Multi-address carriers are handled naturally: Transamerica has four active senders each with its own route; Americo's three senders split across commission, nudge, and ignore. The two traps found in Job A are encoded: **aatx.com uses one address for two message types** (subject regex splits them) and **Ethos mixes marketing and transactional on one sender** (subject allowlist, default ignore). MoO underwriter emails come from *personal* addresses that change per case — the domain-wide pattern + subject regex catches them; the review queue catches novel formats and you add rows as you see them.

**Unknown-but-carrier-domain emails** (matches domain, no type row): log as `email_type='unclassified'`, send to review queue at low priority. This is how the map grows to cover commission-statement emails when carriers start sending them.

---

## 6. Policy matching

Order of attempts:
1. **Exact policy number.** Normalize both sides: uppercase, strip spaces/dashes/leading zeros. (Americo/AmAm pad with zeros; MoO uses `BU`-prefixed.)
2. **Masked match (Transamerica).** `xxxxx76911` → match on last 5+ digits against that user's Transamerica policies. Unique suffix hit = treat as exact. Multiple hits = ambiguous → review.
3. **Client name + carrier fallback.** Normalized name (case, punctuation, `Jr/Sr` stripped) with trigram similarity (`pg_trgm`) against the user's clients for that carrier. Single candidate ≥0.85 similarity → **match but never auto-apply** (queue as `ambiguous_match` with the candidate pre-selected — one-click confirm). Multiple or weak candidates → review with candidates listed.
4. **No match** → review queue with a "create new policy from this email" action (common case: the email *is* the first notice of a new application — AmAm "SUBMITTED" rows and TA "Application Received" should create tracker entries).

Review-queue resolutions teach the system: confirming a fuzzy name match stores an alias; creating a policy from an email backlinks the parsed event. Per your decision, **only rule 1/2 exact matches with parse confidence ≥ threshold (start 0.9) auto-apply**; everything else queues.

---

## 7. Prioritized risks & mitigations

1. **Client PII stewardship (highest).** You'll hold client names, policy numbers, health-adjacent decline reasons — nonpublic personal information under GLBA/state insurance privacy rules, and your agents owe carriers/clients confidentiality. Mitigations: store only extracted fields + a trimmed excerpt, **not** full raw emails; RLS on every table; delete-on-disconnect (purge a user's ingest log and tokens when they disconnect Gmail); document retention in your privacy policy; Anthropic API does not train on API data by default, but note the subprocessor in your policy.
2. **Token security.** A leaked refresh token = read access to an agent's entire mailbox. Mitigations: AES-GCM/Vault encryption at rest with key only in Edge Function secrets; tokens never returned through PostgREST or to the browser; narrowest scope (`gmail.readonly`); revoke via Google on disconnect; log token use anomalies.
3. **Parse errors overwriting good data.** Mitigations (structural, not just thresholds): `policy_events` is **append-only** and tracker status is *derived* — a bad parse adds a wrong event, never destroys history; UI "undo/remove event" beats DB restore; status-transition sanity check (e.g., `declined → approved` without human review is suspicious → queue); confidence threshold + exact-match requirement for auto-apply; everything traceable back to `email_ingest_log`.
4. **Claude API cost control.** At your volumes this is small — ~20–40 carrier emails/day across 10 users, ≤1.5k input + ~300 output tokens each on Haiku ($1/$5 per MTok) ≈ **well under $10/mo total** — but guard anyway: deterministic sender/subject pre-filter so marketing never reaches the API; dedupe on message id; per-user daily cap + global budget kill-switch (`skipped_cap` status, processed next day); token counts logged per email so you can see cost per carrier; backfill batched with a hard cap per user.
5. **Silent sync breakage.** Weekly test-mode token expiry *will* fire constantly during pilot. Mitigations: `reauth_required` status + prominent reconnect banner + (optional) email nudge; admin view of last-sync per account; `history.list` 404 (stale historyId) fallback to date-based listing.
6. **Carrier format drift / new senders.** Formats change without notice. Mitigations: map-driven design (add a row, no deploy); `unclassified` catch-bucket surfaces new senders from known domains; parse failures land in review, never lost.

---

## 8. Decisions — RESOLVED 2026-07-08 (build to these)

- **D1 — Token encryption: app-level AES-256-GCM.** Encryption key lives ONLY in Edge Function secrets (`Deno.env.get('TOKEN_ENC_KEY')`), never in the database. Store ciphertext + IV in `gmail_accounts.refresh_token_enc`. A DB dump alone must not be able to decrypt tokens.
- **D2 — Commission page v1: email-derived data only.** Americo Daily Update snapshots, Americo debt notices, Transamerica rank/commission-level changes. No manual statement upload in v1 (structure the parser so a statement-upload intake can be added later).
- **D3 — Ethos: thin allowlist in v1.** Parse the two mapped subject patterns (incomplete-application, compensation notices); everything else from Ethos senders is ignored by default.
- **D4 — Unmatched new-application emails: auto-create draft policy.** Tracker entry flagged `status='draft', source='email'`, pre-filled with policy #, client name, carrier; visually distinct in UI with one-click confirm. Applies to backfill too.
- **D5 — Nudge delivery: in-app + daily digest email.** Dashboard notifications always; one digest email per day per user summarizing new portal nudges + open review-queue items, sent only when there's something new. (Adds an email provider dependency — use Resend free tier or Supabase SMTP.)

### Test fixtures
Real carrier emails captured 2026-07-08 live in `test/fixtures/*.json` (21 fixtures incl. 3 negative/ignore cases), each with ground-truth `expected` classification matching `docs/carrier_sender_map.json`. Contains real client PII — keep out of public repos. Phase 0 unit tests run against these.

## Costs flagged (pre-revenue lens)

| Item | Pilot cost | Later |
|---|---|---|
| Google Cloud / Gmail API / OAuth (test mode) | $0 | $0 |
| CASA assessment (only at public verification) | $0 now | ~$500–$4,500/yr |
| Supabase (Edge Functions, pg_cron, DB) | $0 on free tier likely; $25/mo Pro if you outgrow it | $25/mo |
| Claude API (Haiku) | < $10/mo at 10 users; backfill ≈ a few $ one-time | scales linearly |
| GitHub Pages (static frontend; worker is on Supabase) | $0 | $0 |

Cheapest viable pilot path: everything above ≈ **$0–35/month total**.
