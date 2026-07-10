# PROMPT 7 — Claude Code — Re-scope Phase 2: mass TEXTING now, email deferred

> Build in the working tree only. Do NOT deploy, set secrets, submit A2P, or send
> anything live. Money stays in mills. Reuse the existing wallet + compliance rails —
> do not fork their logic. Stop at a SQL/deploy gate and report a diff summary, same
> convention as before.

## Goal
Ship **mass SMS/MMS texting** — an agent sends one message to many recipients from
**one of the numbers they own**, with every recipient run through the existing
compliance gate and billed per message. **Defer email entirely** (leave it built but
dormant — see §5). Recipients come from **CRM leads AND uploaded CSV lists**.

## Ground truth in this repo (use these, don't invent)
- Numbers are Telnyx now. `agents.signalwire_caller_id` (legacy name) holds the agent's
  Telnyx number; `public.phone_numbers` (id, agent_id, e164, is_primary, status) is the
  per-agent inventory. SMS sends via Telnyx (`api.telnyx.com/v2/messages`) in
  `messaging-send-sms`.
- Single-send billing/never-charge flow lives in `messaging-send-sms/index.ts`:
  messages row → `wallet_hold` → provider send → void on failure, settle on delivered
  webhook. **Factor this core into a shared helper and have BOTH single-send and the new
  broadcast runner call it** so billing/never-charge behavior is identical and tested once.
- Compliance gate: `_shared/messaging-shared.ts` `runComplianceGate(sb, agentId,
  channel, toAddress)` — A2P approved → `express_written` consent → DNC → quiet hours.
  Every recipient MUST pass through it. No bypass path.
- Leads: `public.leads(id, agent_id, client_id, data jsonb)` — phone/name are inside
  `data` jsonb. Determine the actual phone key from real rows; don't hardcode a guess.
- Consent/DNC: `public.consent_records`, `public.dnc_list` (per-agent + global).
- A2P: `public.a2p_registrations` (per agent). SMS blocked unless `status='approved'`.

## §1 — Schema (new migration `data/sql/020_texting_broadcasts.sql`, idempotent)
- `public.broadcasts`: id, agent_id, from_number (e164), channel check('sms','mms'),
  body text, media_url text null, status check('draft','queued','sending','completed',
  'canceled') default 'draft', total_recipients int, sent_count int default 0,
  skipped_count int default 0, failed_count int default 0, created_at, started_at,
  completed_at.
- `public.broadcast_recipients`: id, broadcast_id fk, agent_id, to_address (canonical
  E.164), lead_id uuid null, source check('lead','csv'), status check('pending','sent',
  'delivered','failed','skipped') default 'pending', skip_reason text null
  (no_consent/on_dnc/quiet_hours/invalid_phone/duplicate), message_id uuid null
  references public.messages(id), created_at. Unique (broadcast_id, to_address) to dedupe.
- RLS: agent reads own rows; all writes service_role (same pattern as 019).

## §2 — From-number validation + A2P campaign assignment (the easy-to-miss part)
- Broadcast create must verify the chosen `from_number`:
  1. belongs to the agent (`phone_numbers.e164` where agent_id = user, status='active'), and
  2. is assigned to the agent's **approved** Telnyx 10DLC campaign.
- `a2p-register` does NOT currently assign numbers to the campaign. Add that: either extend
  `a2p-register` or add `a2p-assign-number` to attach the agent's number(s) to their
  approved campaign via the Telnyx 10DLC API (guard behind the existing
  `telnyx-10dlc-adapter.ts` "verify exact field names" comment — leave a TODO rather than
  guessing endpoint/field names you can't confirm).
- If the number isn't campaign-assigned, broadcast create returns a clear error and does
  NOT let the blast start. (A2P is still the hard gate — same as single send.)

## §3 — Recipient sources
- **CRM leads:** `messaging-broadcast-create` accepts a lead filter (e.g. status/tag/all)
  and expands to recipients from `leads.data` phone field, normalized to E.164 via
  `_shared/phone.ts` `toE164`. Drop unparseable numbers with skip_reason='invalid_phone'.
- **CSV upload:** `messaging-recipients-import` — parse CSV, normalize phones, and require
  a per-row or whole-file **consent basis** (source + captured_at). Write matching
  `consent_records` with `source='csv_import'` and the provided provenance. **Do NOT
  auto-write `express_written` unless the agent supplies an explicit written-consent
  basis.** Numbers without a qualifying consent record will (correctly) be skipped by the
  gate at send time — this is the legal guardrail, keep it.

## §4 — Broadcast runner (`messaging-broadcast-run`)
- Processes `pending` recipients for a `sending` broadcast in batches.
- For each recipient: call `runComplianceGate`. On fail → mark `skipped` + `skip_reason`,
  **charge nothing**. Special case quiet_hours → leave `pending` and DEFER to a later run
  (do not skip/drop) so it sends once the recipient's local window opens.
- On pass → call the shared single-send core (hold → Telnyx send → settle/void via the
  existing delivery webhook), write the `messages` row + link `message_id`, mark `sent`.
- **Pace** to the campaign's per-second/day throughput to avoid carrier filtering
  (configurable; add `billing_config.sms_max_tps` default conservative, e.g. 1/s).
- Cancel support: if broadcast.status flips to `canceled`, stop processing remaining
  pending recipients.
- Invocation: same secured pattern as the existing crons (bearer = `WALLET_CRON_SECRET`);
  or invoked by broadcast-create for small lists. Keep it idempotent and resumable.

## §5 — Defer email (do NOT delete, just deactivate)
- Add `billing_config.email_enabled boolean not null default false`. `messaging-send-email`
  checks it first and returns `{error:'email_disabled'}` (503) when false. Leave the
  function, webhooks, and inbound code in place for a later phase.
- Do not set any `agents.outbound_email_from`. (Cowork will disable the two Resend
  webhooks in the dashboard separately — no action needed from you.)
- Update `docs/email-parsing-build-plan.md` / any Phase-2 notes to mark email as deferred.

## §6 — Tests (`npm run test:messaging` stays green, extend it)
- Recipient expansion from a mock leads set (phone key discovery, E.164 normalization,
  dedupe, invalid-number skip).
- CSV import: consent provenance recorded; a number with no written-consent basis is
  skipped by the gate (assert zero holds for skipped recipients).
- Billing parity: the shared single-send core produces identical holds/voids whether
  called from `messaging-send-sms` or the broadcast runner (never-charge-undelivered holds).
- Pacing math and the quiet-hours DEFER (not skip) behavior.
- Confirm existing `messaging-send-sms` behavior is unchanged after the refactor.

## Stop / report
No deploy, no secrets, no A2P submission, no live sends. Report: new `020` diff, the
shared-core refactor, files added, the number→campaign-assignment approach (or TODO if
Telnyx fields unconfirmed), and the updated test count.
