# PolicyPilot / ProducerStack — notes for Claude Code

## Carrier bonus tracker
- **Source of truth for bonus programs:** `data/carrier_bonuses.json` — carrier-official agent bonus/incentive programs (45 carriers, researched 07/2026). CARRIER-ONLY by design: never add IMO/agency-level bonuses (e.g. FFL VP bonus) to this file.
- **Mirror rule:** the `CARRIER_BONUSES` const in `app.html` mirrors this JSON (same pattern as `COMP` ↔ `data/compensation-table.json`). Any change to one must be applied to both.
- **Never invent tier numbers.** Entries with `bonus_type: portal_only` or empty `tiers` get no numeric projections in the UI. All displayed payouts are estimates ("est." prefix) subject to carrier persistency/quality metrics.
- Payout shapes differ per carrier — don't generalize: Am-Am Bonus Bucks = highest band only, not cumulative; MoO 4 Quarters Club = cliff (10% of TOTAL quarter ANBP once ≥$25k); Corebridge = cumulative policy-count ladder, SimpliNow Legacy SIWL only (GIWL excluded), tiers change every quarter; Americo UFirst = fixed window (last one ended 2026-05-29).
- **Data decays on a schedule:** Corebridge tiers flip quarterly (~Oct 1 next), Americo announces new UFirst windows after each one ends, MoO/Aetna publish new flyers each cycle. When refreshing, update `as_of` and per-entry `status`/`source_date`, and regenerate `data/carrier_bonuses_*.xlsx` if present.
- Build spec: `docs/bonus-tracker-build-prompt.md` (payout math, period engine, carrier-ID mapping, fixture tests).

## Carrier email parsing feature
- **Source of truth for email classification:** `docs/carrier_sender_map.json` — maps every carrier sender address to email type, content type (body / pdf / login_link), and routing destination (policy_tracker / commission_summary / nudge / ignore). Built from real inbox samples; do not invent sender addresses or types not listed there.
- **Build plan:** `docs/email-parsing-build-plan.md` — architecture, phased tasks, schema, matching rules, risks. Follow the phase order.
- **DB seed:** `supabase/seed_carrier_senders.sql` — inserts for the `carrier_senders` table (requires a `priority int default 10` column; see file header for matching semantics).

Autonomy layer (added 07/2026):
- **Pipeline runs unattended twice daily** (9 AM + 5 PM Central) via `supabase/functions/email-pipeline` (orchestrator: gmail-sync → parse-email looped → match-events), scheduled by `supabase/schedule_email_pipeline.sql` (pg_cron, UTC — has a DST note). The in-app "Sync & parse" button remains the on-demand path.
- **Auto-apply:** `match-events` now writes back to the tracker. Auto-attach requires parse confidence ≥ 0.9 AND (exact policy number | TA masked last-5 | UNIQUE strong name+carrier match). Status mapping lives in `match-events/index.ts` `STATUS_MAP` — forward-only (pending→approved→issued), `lapsed` from declined/withdrawn/closed; NEVER sets `paid`/`chargeback` and never downgrades. No match → review_queue, no tracker change. Every applied event is appended to `policy_events` (audit table, `supabase/migrations/20260717_policy_events.sql`).
- **Policies now carry an optional `policyNumber`** (Add/Edit Policy modals, `p-policyNum`/`ep-policyNum`); match-events backfills it from unmasked email matches. This is the primary path to high match accuracy — name+carrier is the fallback.
- **Summaries must lead with the client's name** (1–3 sentences, amounts/dates/next steps) — enforced in the `SYSTEM` prompt in `_shared/anthropic.ts`. Don't shorten it back to one nameless sentence.

## Texting / A2P 10DLC UI
- **Read `docs/texting-ui.md` before touching anything named `a2p*` or `sms*` in `app.html`.** Three surfaces: the registration modal (`#a2pRegModal`), the status wizard (Settings → Texting, `#stg-texting`), and the per-lead SMS thread (`#smsThreadModal`, opened by the **Text** button on a lead row).
- **`const A2P_ALLOW_PRODUCTION = false`** in `app.html` is the money switch. Off = every registration attaches to the shared mock sandbox brand (free, and can never be carrier-approved; the sole-prop OTP step is skipped entirely). On = $4 + $14.50 of real, non-refundable carrier fees **per agent**, then $1.50/month. Flip it only as a deliberate spend decision.
- **Never surface a raw API error in the composer.** Every reason `runComplianceGate()` returns already carries a plain-English `detail`; the UI's job is to add the link that clears it. The gate order in `smsEvaluateGate()` mirrors the server's on purpose — the composer must never look ready for a send the server would refuse.
- **Quiet hours are deliberately NOT computed in the browser.** The timezone inference lives in `_shared/tcpa.ts`; let the server refuse (it costs nothing) and render its sentence.
- **`consent_records` is service-role-write-only and nothing but `messaging-recipients-import` and the new `messaging-consent-record` writes it.** `lead-ingest` does not, so a lead has no consent row until an agent attests to one. Do not "fix" this by adding an INSERT policy.
- **`a2p-status-poll` has two callers**: pg_cron with `WALLET_CRON_SECRET` (full sweep) and the browser with a user JWT (refresh scoped to that agent, resolved from the token, never the body). It must stay `verify_jwt = false`.
- **An opt-out must NEVER be conditional on resolving the agent.** `dnc_list` is the single enforcement point — `runComplianceGate()` reads it for every send; nothing reads `inbound_messages.is_opt_out`. `messaging-inbound-webhook` resolves the agent in four passes (exact `e164` → last-10 `e164` → the prior outbound message on the same pair → legacy caller ID) and, if all four miss, writes a **global** `dnc_list` row and still sends the confirmation. Restoring an `&& agentId` guard there silently drops consumer STOPs — it did exactly that until 2026-07-28.
- **The Telnyx fleet is larger than `phone_numbers`.** As of 2026-07-28: 8 DIDs live, 6 rows. `+12029703699` (shared caller ID) and `+12625099123` (dialer host) are in neither `phone_numbers` nor `agents.signalwire_caller_id`. Assume inbound can arrive on a number the DB does not know.

## Carrier email parsing feature — key gotchas

Key gotchas encoded in the map (read its `key_findings`):
- Transamerica masks policy numbers (`xxxxx76911`) — match on last 5 digits.
- `noreply@aatx.com` sends two different email types — split on subject regex, match addresses case-insensitively.
- Ethos mixes marketing and transactional on one sender — subject allowlist, ignore by default.
- Mutual of Omaha underwriting mail comes from personal underwriter addresses — match domain + subject pattern.
- Never fetch links from login-link emails (Corebridge secure messages, Americo portal notifications) — they become dashboard nudges only.
