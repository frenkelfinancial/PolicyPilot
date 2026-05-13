# Daily Digest — Deployment Guide

The Edge Function in this directory powers Book Intelligence automation **#3**:
a morning email digest of each agent's top 3 conversion opportunities. It's
fully written; what's left is deployment, which is on you (Supabase CLI + an
email account).

## Prerequisites

1. **Supabase CLI** — `brew install supabase/tap/supabase` (or via `npx`).
2. **Resend account** — sign up at https://resend.com, verify a sending domain.
   The free tier covers ~100 emails/day, plenty for one agent's daily brief.
3. **Local project linked to Supabase** — `supabase link --project-ref <ref>`
   from this repo's root.

## One-time setup

```bash
# 1. Apply the migration that adds digest_enabled / digest_email to agents.
psql "$DATABASE_URL" -f data/sql/004_agent_digest_prefs.sql
# (or run it from the Supabase SQL editor UI.)

# 2. Set the secrets the function needs.
supabase secrets set RESEND_API_KEY="re_xxxxxxxx"
supabase secrets set DIGEST_FROM="PolicyPilot <digest@yourdomain.com>"
supabase secrets set DASHBOARD_URL="https://your-host/index-3.html"

# 3. Deploy the function.
supabase functions deploy daily-digest

# 4. Trigger it manually once to verify everything works.
curl -i -X POST "https://<project-ref>.supabase.co/functions/v1/daily-digest" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
```

The response is a JSON summary listing how many agents got an email and any
per-agent errors. Check your inbox.

## Scheduling

Pick one — `pg_cron` is the simplest if you already have it enabled.

### Option A — `pg_cron` + `pg_net` (recommended)

```sql
-- Enable extensions once.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Fire daily at 7:00 AM UTC (~3 AM ET / midnight PT).
-- The body / Authorization header come from Supabase project settings.
select cron.schedule(
  'book-intel-daily-digest',
  '0 7 * * *',
  $$select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/daily-digest',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_OR_ANON_KEY>"}'::jsonb,
    body := '{}'::jsonb
  );$$
);
```

### Option B — External cron (zero infra)

Use cron-job.org, GitHub Actions, or any uptime monitor that supports
scheduled HTTP requests. Have it POST the function URL once a day with an
`Authorization: Bearer <anon-key>` header.

## What's in the bundle

- `index.ts` — Edge Function entry point. Iterates opted-in agents, scores
  each book server-side, sends a Resend email.
- `email.ts` — HTML + plain-text email template. No images, single-column,
  inline styles only (most email clients still don't honor `<style>` blocks).
- `../_shared/scoring.ts` — minimal TypeScript port of the front-end's
  `bookIntel.computeDeadline` + scoring formula. Coarser commission
  estimate (face × 0.1% × 70% × 75%) — sufficient for ranking and "top 3"
  selection; the dashboard remains authoritative for the dollar figure
  agents act on.

## What this function does NOT do (yet)

- **Per-agent timezone scheduling.** v1 fires once globally; everyone gets
  the same UTC delivery time. Add a `digest_time time` + `digest_timezone text`
  column and shard the cron when you have enough agents to care.
- **Granular preferences.** No "weekdays only," no "skip if zero opportunities"
  — the function does skip when there's truly nothing to say (zero open + zero
  in the book), but always sends if there's anything to mention.
- **Click tracking, unsubscribe links.** Add when needed; the email already
  mentions the in-dashboard toggle for opt-out.

## Sync points to remember

The scoring kernel in `_shared/scoring.ts` is a **port** of the browser logic
in `index-3.html` (`window.bookIntel.*`) and the carrier rules in
`shared/data.js` (`CARRIER_CONVERSION_RULES`). When you edit either, edit both.
The JSON mirror at `data/conversion-rules.json` is the easiest cross-check.
