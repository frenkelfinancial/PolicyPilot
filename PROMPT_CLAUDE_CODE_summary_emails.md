# PROMPT 2 — Claude Code (deploy to the live system)

> Purpose: run inside the PolicyPilot repo AFTER the Cowork session is done.
> Paste the Cowork deliverables where indicated. Installs the monthly
> summary-email system on the live system with minimal work from me.
> Test-send to myself only before go-live.

---

You are deploying an automated **customer account-summary email system** into my live PolicyPilot / ProducerStack codebase. The design, gather/render modules, both email templates, the `pg_cron` schedules, the unsubscribe function, and the Edge Function wrapper were already built and validated in a Claude Cowork session — I'll paste those here: **[PASTE THE COWORK DELIVERABLES]**. Your job is to install it into my real system with minimal work from me and zero disruption to anything already running.

## Critical facts about my repo (verify, don't assume)

- **Frontend is a static single-page HTML app — NOT Next.js/React.** The Summary tab lives in the live app HTML (`index.html` / `app.html` / the `Jace- Life Insurance/` build — find the one that's actually served; the weekly-digest `DASHBOARD_URL` points at `index-3.html`). UI changes are plain HTML/CSS/vanilla JS using my design tokens (`styles.css`, `shared/tokens.css`, `PolicyPilot_Design_System.docx`). Do not introduce a framework.
- **Design reference:** the Cowork session saved my design-reference screenshots to **`docs/summary-emails/design-refs/`** (e.g. `email-1st-ref.png`, `email-15th-ref.png`, `toggle-ref.png`). Open those and treat them as the visual source of truth for the email templates and the Summary-tab toggle — match their layout, colors, and feel while staying within my design tokens. If the folder is missing or empty, ask me for the screenshots before building the UI/templates.
- **Supabase schema is applied by MANUAL SQL paste in the SQL Editor — never `db push`** (it silently skips `data/sql/`). Give me idempotent SQL blocks I run myself, numbered and in order, following the style of `data/sql/*.sql`.
- **Existing digests to match (code pattern only):** `supabase/functions/weekly-digest/` and `daily-digest/` already use the gather (`index.ts`) + render (`email.ts`) split and call Resend with secrets `RESEND_API_KEY`, `DIGEST_FROM`, `DASHBOARD_URL`. Match this code structure.
- **Resend is being set up FRESH — do not trust the old account or secrets.** My previous Resend account is disabled and unused (~1 month). The Cowork session produced a fresh-Resend-setup package (new account, a **custom sender email**, new API key, new DNS records). Wire the function to **new** `RESEND_API_KEY` and `DIGEST_FROM` values that I will set — do not assume the existing secret values are valid, and don't reuse the old sender. **Never hardcode the from-address anywhere in the code — it must live ONLY in the single `DIGEST_FROM` secret so I can choose and change my sender email myself, any time, without a code change.** The domain won't be verified until I complete the manual DNS step, so gate the real go-live on that.
- **The AI email parser is NOT ready — do not depend on it.** I just built the carrier-email parser (`carrier_senders`, `email_ingest_log`, `portal_nudges`) but it isn't fully working and I'm waiting on it. This email system must ship and run with **zero parsed data**: do not read those tables, do not require any parsed commission/action data, and leave `actual_commission` as an optional render-only field that stays absent for now.
- **Do not copy the weekly-digest scheduling bug:** it uses a fixed `0 9 * * 1` UTC cron with naive `Date` math. The new jobs must be DST-aware (America/Chicago), not fixed UTC.

## Work in this exact order and confirm each step before moving on

1. **Read my actual codebase and Supabase schema first.** Verify the real table/column names against my database and the Cowork spec, and reconcile any differences. Confirm specifically: the `policies.data` JSONB key names (AP, carrier, status, draft/payment dates), the `calls` columns (`answered_at`, `duration_sec`, `outcome='appointment'`), the real plan slugs (`basic`/`pro`/`max`), the agency/downline linkage for the Max tier, and the real **granted-access signal**. On access: my Stripe webhook auto-grants a plan on paid subscription, but **100%-discount ($0) agents get no detected payment and I grant their access manually** — they still have full access and MUST receive these emails. So gate on **granted plan access (`agents.plan_id` present / the access flag my grant sets — read `supabase/functions/stripe-webhook/` to find the real column), NOT on a detected payment or a non-null `stripe_subscription_id`.** If anything differs from the Cowork spec, adapt the code to my real schema and tell me exactly what you changed.

2. **Enable required Supabase extensions** if not already on: `pg_cron` and `pg_net` (and `http` if my existing cron pattern uses `net.http_post` — check `data/sql/013_weekly_digest.sql`). Show me the SQL.

3. **Install the Edge Function(s)** containing the gather + render modules and the Resend send logic, plus the **token-based unsubscribe function**. Wire secrets via `supabase secrets set` — the **new** `RESEND_API_KEY` and the **new** custom-sender `DIGEST_FROM` from the fresh Resend account, the service-role key (auto-injected — don't hardcode), and a signing secret for the unsubscribe token. Never hardcode keys. Give me the exact `supabase secrets set` commands with placeholders for the values I'll paste once the new Resend account exists. Because the domain won't be verified until I finish the DNS step, make the function safe to deploy before then (it should not blast real mail on deploy — sending is driven only by cron + my manual test trigger).

4. **Create the `pg_cron` jobs** for the **1st** and the **15th at 9:00am Central, DST-aware** — compute the send-gate/date windows against `America/Chicago`, NOT a fixed UTC hour. Use `date_trunc('month', ...)` for the previous-month window (never a hardcoded 30). Show me the SQL and confirm it fires at true 9am Central in both standard and daylight time. (Match the `select cron.schedule(name, cron, $$ select net.http_post(...) $$)` shape already in my repo.)

5. **Add the opt-out toggle — do BOTH parts:**
   - **Database:** add a **new** boolean column `agents.summary_emails_enabled` **default `true`** (separate from `digest_enabled`, which is the daily digest and defaults false — do not touch it). Then run a one-time backfill `UPDATE public.agents SET summary_emails_enabled = true;` so every existing agent is ON. Confirm both — a default alone is not enough to reason about for pre-existing NULLs. The Edge Function wrapper must **skip any agent where `summary_emails_enabled` is false OR the agent lacks granted plan access** (use the granted-access signal from step 1 — `plan_id` present, NOT a detected payment, so $0/100%-discount agents are correctly included).
   - **UI:** add a toggle at the **top of the Summary tab** in the live HTML app. It must match my existing design system exactly (read my current components/CSS tokens — same radius, spacing, typography, colors; no foreign style). Clean and premium, clearly labeled (e.g. "Scheduled Summary Emails" with an On/Off state), reflects the agent's current setting on load, and writes back to `summary_emails_enabled` optimistically with a saved-state confirmation. All agents see it ON by default.

6. **One-click unsubscribe:** deploy the token-based unsubscribe Edge Function so the email footer link flips `summary_emails_enabled = false` for that agent **without login**, and confirm the send includes `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. Verify the token is signed/opaque (not a guessable agent id).

7. **Do not send any real emails during setup.** Give me a safe way to trigger a single **test send to my own address only** so I can verify end-to-end (both the 1st and 15th templates, and an unsubscribe click) before it goes live to customers.

8. When done, give me a short checklist of the only manual steps left for me — using the fresh-Resend-setup package from the Cowork session: **create the new Resend account, add the `reports.frenkelfinancial.com` sending subdomain, add the SPF/DKIM/DMARC/return-path DNS records, wait for the domain to show verified/green, then set the new secrets** — with the exact values/commands filled in wherever you can, and clearly marking which steps block go-live.

## Do NOT build

- No `requires_action` column, no per-policy `status` scaffold, and no "action-required" section anywhere — my database does not store those and I don't want them.
- No marketing/upgrade CTAs — these are account statements; keep the deliverability category clean.

Prioritize: zero disruption to anything currently running, matching my existing UI exactly, DST-correct scheduling, and no hardcoded secrets. Ask before doing anything destructive.
