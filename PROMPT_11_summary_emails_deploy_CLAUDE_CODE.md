# PROMPT 11 — Deploy the summary-email system (Claude Code)

> Purpose: run inside the PolicyPilot repo. The summary-email system is ALREADY
> BUILT and committed — this prompt only deploys it, adds the missing toggle UI,
> and test-sends to me. There is no Cowork step and nothing to paste.

---

You are deploying my already-built customer account-summary email system (1st + 15th monthly statements) into my live PolicyPilot / ProducerStack system. **Do not redesign, rebuild, restyle, or simplify anything — the build is done, validated, and committed in this repo.** Your job is deployment, the settings-toggle UI, and a safe test send.

## What already exists (source of truth — read these first)

- `supabase/functions/monthly-summary/` — `gather.ts` (DB → SummaryData object), `email.ts` (object → HTML, built from my design ref), `index.ts` (cron wrapper, Resend send, DST guard, dry-run/test modes)
- `supabase/functions/summary-unsubscribe/` — token-based RFC 8058 one-click unsubscribe (HMAC-signed, no login)
- `data/sql/015_summary_emails.sql` — adds `agents.summary_emails_enabled` (default true) + backfill UPDATE + both pg_cron jobs
- `docs/summary-emails/design-refs/email-summary-ref.html` — visual source of truth already baked into `email.ts`
- Preserve the personalized/motivational copy and the design in `email.ts` exactly as written.

## Facts already encoded in the build — do NOT "fix" these

1. **Tiers:** real plan slugs are `basic` / `pro` / `max` via `agents.plan_id → plans.slug`. "Team Leader" is only the marketing display name for `max` on pricing.html. Team rollup (via `agency_invites` where `status='accepted'`) is `max`-only. Fallback tier is `basic`.
2. **Access gate:** recipients = `summary_emails_enabled = true` AND `plan_id IS NOT NULL`. Granted access, NOT a detected payment — my $0/100%-discount agents have `plan_id` set manually and MUST receive emails. Never gate on `stripe_subscription_id` or subscription status.
3. **DST scheduling is intentionally dual-slot:** pg_cron is UTC-only, so 015 schedules 14:00 AND 15:00 UTC on the 1st/15th, and `index.ts` only proceeds when Chicago local time is exactly 9am (the other slot no-ops). This is correct — do not replace it with a single "DST-aware" cron, which pg_cron cannot do.
4. **Data sources:** first-party only. `policies` stores the record in a JSONB `data` column (keys: `ap`, `draft`, `advComm`, `commPct`, `client`, `status`, …). Estimated commission = stored `advComm`, else `ap × commPct / 100 × 0.75` (same rule as app.html). `calls` uses `started_at`, `duration_sec`, `answered_at` (connected = non-null), `outcome='appointment'`. **No dependency on the carrier-email parser** — `actualCommission` stays null; confirm no code path reads parser tables.
5. **Sender:** lives ONLY in the `DIGEST_FROM` secret — never hardcoded. The Resend account is LIVE: `wallet-low-balance-notify` already sends real customer email with the existing `RESEND_API_KEY` + `DIGEST_FROM` secrets. Reuse them. Verify `DIGEST_FROM` is a real verified sender (not the `onboarding@resend.dev` fallback, which only delivers to my own address) via a test send. A `reports.` subdomain is optional/later — not required for go-live.
6. **`digest_enabled` belongs to the daily digest (default false) — do not touch it.** The summary toggle is the separate `summary_emails_enabled` (default true).
7. **Schema changes are manual SQL pasted into the Supabase SQL Editor — never `supabase db push`.** Give me idempotent blocks to paste, in order.

## Work in this exact order, confirming each step

1. **Verify, don't rebuild.** Diff the committed build against the live schema/codebase: `agents` columns (`display_name`, `digest_email`, `monthly_goal`, `plan_id`, `contract_level`), `plans.slug` values, `policies.data` JSONB keys, `calls` columns, `agency_invites` shape. If anything drifted since the build, adapt minimally and tell me exactly what changed. Confirm the frontend is static HTML/JS on GitHub Pages (Capacitor-wrapped for mobile) — no React/Next anywhere.

2. **Extensions:** show me SQL to enable `pg_cron` and `pg_net` if not already on (weekly-digest may already use them — check `data/sql/013_weekly_digest.sql`).

3. **Deploy the functions:**
   - `supabase functions deploy monthly-summary`
   - `supabase functions deploy summary-unsubscribe --no-verify-jwt` (recipients aren't logged in)
   - `RESEND_API_KEY` and `DIGEST_FROM` already exist and are working (wallet emails) — reuse, don't rotate. New secrets to set: `SUMMARY_UNSUB_SECRET` (generate a random 32+ char value for me), `SUMMARY_UNSUB_URL` (the deployed unsubscribe function URL), and `DASHBOARD_URL` if not already set. Give me exact `supabase secrets set` commands. Never hardcode any of these.
   - Deploying must be send-safe: sending only happens via cron or my manual trigger, and the function errors cleanly if `RESEND_API_KEY`/`DIGEST_FROM` are unset.

4. **Cron:** walk me through pasting `data/sql/015_summary_emails.sql` (with the `<service-role-key>` placeholder filled) into the SQL Editor. Confirm the dual-slot + 9am-Chicago-guard math is right in both CST and CDT, and show me the `select jobname, schedule from cron.job` verification query.

5. **Toggle (both parts):**
   - **DB:** the column + backfill are in 015 (default true AND explicit `UPDATE … SET summary_emails_enabled = true` — both, since a default alone doesn't cover pre-existing NULLs). Confirm both ran.
   - **UI (this does NOT exist yet — build it):** add a toggle at the TOP of the Summary tab in `app.html`. Plain HTML + vanilla JS using the existing client `sb` (`window.supabase.createClient`, ~line 5931). Reuse my existing toggle pattern (`.toggle-track` / `.toggle-thumb` / `.toggle-label`, ~line 258) and design tokens — same radius, spacing, typography; no new framework, no foreign styles. Label it "Scheduled Summary Emails" with On/Off state. Read the agent's current `summary_emails_enabled` on load, write back optimistically on click with a brief saved confirmation, revert on error. RLS: the existing `agents_update_own` policy already permits this.

6. **Test safely — no real customer email during setup.** Use the modes already built into `index.ts`: POST to the function with `{"force":true,"kind":"monthly","dry_run":true}` to render without sending, then `{"force":true,"kind":"monthly","to_override":"jacef8778099@gmail.com"}` and the same for `"kind":"midmonth"` so ALL mail routes only to me. Also have me click the unsubscribe link in a test email and verify `summary_emails_enabled` flips to false, then flip it back.

7. **Final manual checklist** — the only steps left to me, with exact values/commands filled in. No new Resend account or DNS work is needed (the domain is already verified and sending wallet emails); the checklist is just: set the new secrets from step 3 and approve go-live after my test sends look right. Mark clearly which items block go-live.

## Do NOT build

- No `requires_action` column, per-policy status scaffold, or "action-required" sections — my DB doesn't store those.
- No marketing/upgrade CTAs — these are account statements; keep the deliverability category clean.
- No changes to weekly-digest/daily-digest, no schema changes beyond 015.

Prioritize: zero disruption to anything running, faithful preservation of the committed design and copy, correct tier gating (`basic`/`pro`/`max`), the granted-access rule (plan_id, not payment), no hardcoded secrets, and no parser dependency. Ask before anything destructive.
