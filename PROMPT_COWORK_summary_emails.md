# PROMPT 1 — Claude Cowork (build & validate against TEST DATA only)

> Purpose: Cowork designs and validates the entire monthly summary-email system
> against TEST DATA. It does NOT touch the live database or send real email. Its
> output becomes the input to the Claude Code deploy prompt (file 02).
>
> Paste everything below into a fresh Cowork session that has this repo folder
> (PolicyPilot) attached.

---

You are helping me build an automated **customer account-summary email system** for PolicyPilot / ProducerStack — my SaaS CRM for life-insurance agents. These are **account statements** to existing paying agents, like a brokerage's monthly summary. They are NOT marketing: no selling, no advertising, no upgrade CTAs.

You have my repo attached. **Read it before designing anything** — I have existing infrastructure you must build on, not reinvent. Do not guess at names; read mine.

## Ground truth about my stack (verify against the repo, don't assume)

- **Frontend is a static single-page HTML app, NOT Next.js.** The agent dashboard is plain HTML/CSS/vanilla JS (see `index.html`, `app.html`, and the `Jace- Life Insurance/` build; the live "Summary" tab lives in one of these — find the real one). It is wrapped with Capacitor for the iOS/Android builds. There is no React and no Next.js. Any UI you mock must be plain HTML/CSS matching my design tokens in `styles.css` / `shared/tokens.css` and `PolicyPilot_Design_System.docx`.
- **Database:** Supabase (Postgres). My schema convention is **manual SQL pasted into the Supabase SQL Editor — never `db push`** (files in `data/sql/` and `supabase/migrations/` are applied by hand). Anything you write as SQL must follow that convention and be idempotent (`if not exists`, `on conflict`).
- **Email:** Resend, already wired. See `supabase/functions/weekly-digest/` and `supabase/functions/daily-digest/`.
- **Scheduling must be entirely server-side on Supabase:** `pg_cron` (schedule) + `net.http_post` via the `http`/`pg_net` extension (HTTP call) + an **Edge Function** (logic). It must send with all my devices off. **Do NOT use Railway or any external scheduler.**

## Reuse what already exists (this is mandatory — study these first)

1. `supabase/functions/weekly-digest/index.ts` (the "gather" side — DB → stats object) and `supabase/functions/weekly-digest/email.ts` (the "render" side — object → HTML). My existing digests **already use the exact two-stage gather/render split you must follow.** Mirror this structure and the shared helpers; do not invent a different architecture.
2. Resend is called with secrets `RESEND_API_KEY`, `DIGEST_FROM`, `DASHBOARD_URL` (see `weekly-digest/index.ts`). Reuse this pattern.
3. **Known bug in the existing weekly digest you must NOT copy:** it is scheduled at a fixed `0 9 * * 1` UTC and does its date math with naive JS `Date` (local = UTC in Deno). That drifts by an hour under DST and is not America/Chicago-correct. Your new system must be genuinely DST-aware (see Timing below).

## The real schema (confirm every one of these against my repo, then list your mapping back to me before building)

- **`public.agents`** — `id` (uuid = `auth.users.id`), `email`, `display_name`, `contract_level` (65–145, default 100), `monthly_goal` (numeric, default 50000), `plan_id` (uuid → `public.plans`), `digest_enabled` (bool, default **false** — this belongs to the *daily* digest; do NOT reuse it), `digest_email`, `stripe_customer_id`, `stripe_subscription_id`.
- **`public.plans`** — real tiers are **`basic` / `pro` / `max`** (names "Basic" / "Pro" / "Max"; $29 / $79 / $199). The planning notes said "Basic/Pro/Leader" — **that was wrong; the real top tier is Max.** Map tier logic to `basic` / `pro` / `max`.
- **`public.policies`** — the policy record lives in a **JSONB `data` column**, not flat columns. AP, carrier, client, policy status, and payment/draft dates are keys inside `data` (see how `weekly-digest` reads `ap`, `draft`, `carrier`, `status`, `client`). There is **no stored commission column** — estimated commission is *derived* (comp table × `contract_level`). Read the real key names from my code/JSON before using them.
- **`public.calls`** — one row per dial. `agent_id`, `direction`, `started_at`, `ended_at`, `duration_sec` (talk time), **`answered_at`** (a connected call = non-null `answered_at` — this column is real, confirmed), `outcome` (text; an **appointment set = `outcome = 'appointment'`**). Total dials = row count in the period; talk time = sum of `duration_sec`.
- **Subscription-active / "has access" signal (IMPORTANT — do not get this wrong):** the signal is **whether the agent has been granted plan access**, i.e. **`agents.plan_id` is set** — NOT whether a Stripe payment was detected. My Stripe webhook auto-correlates a paid subscription to a plan and grants access, but when I give someone a **100% discount they pay $0, no payment is detected, and I grant their access manually** — those agents still have full access and MUST receive these emails. So gate on granted access (`plan_id` present / access flag), never on "a payment exists" or a non-null `stripe_subscription_id`. Verify the exact column my access grant sets (read `supabase/functions/stripe-webhook/`) and flag it back to me to confirm.

## Architecture (mandatory two-stage, mirroring my existing digests)

- **A "gather" module** — for one agent and one date window, returns a single structured object with every metric. It queries the database only; it formats no HTML.
- **A "render" module** — takes that object and produces the email HTML. It reads **only from the object, never the database.** Every optional section is conditional: **if a field is absent or empty, that section does not render at all** (no blank boxes).

All date math is in **`America/Chicago`** using `AT TIME ZONE 'America/Chicago'` in SQL, or an explicit Chicago-zoned computation in the Edge Function — never naive UTC.

### Metrics the gather module must compute (scoped to the tracked period)

- Total AP sold
- Policies sold/written
- **Estimated commission** (derived from comp × `contract_level`, the way the app already does it)
- Total dials for the period (row count in `calls`)
- Talk time in hours (sum of `duration_sec`)
- **Pickup ratio** = connected calls ÷ total dials, where "connected" = non-null `answered_at`
- **Close ratio** = policies written ÷ total dials × 100
- **Appointments set** = count of `calls` where `outcome = 'appointment'` (derived from the `calls` table — there is NO standalone appointments feature)
- Upcoming drafts in the next 7 days (count + total premium), read from the policies' JSONB draft/payment dates
- Goal progress vs. `agents.monthly_goal`
- A **`prior_period`** sub-object with the same metrics for the equivalent previous period, so the email can show streak/pace comparisons

### Future-proofing (do this, but DO NOT create any columns for it)

I will later add an AI carrier-email-parsing feature (tables `carrier_senders`, `email_ingest_log`, `portal_nudges` already exist from that build). It will eventually produce **confirmed commissions**. To absorb that with zero rewrite:

- Design the render module so it **conditionally displays an optional `actual_commission` value if present in the object** (null now → not rendered). When it appears later, it should read as "estimated $X → confirmed $Y." Keep estimated and actual conceptually separate — never overwrite one with the other.
- Because policies are JSONB, the future parser just adds keys to `data`; **no schema/column scaffolding is needed now.**
- **Do NOT add a `requires_action` field, a per-policy `status` scaffold, or any "action-required" section.** My database does not store those and I don't want them built. Leave the render module generically able to show optional future fields only if they appear — build nothing for them now.

## Two email types (both sent 9:00am Central, true 9am year-round, DST-aware)

- **1st of each month** — retrospective "report card" for the **entire previous calendar month.** Use `date_trunc('month', ...)` so month length is automatic (Feb = 28/29, April = 30) — never hardcode a day count. Grades last month vs. goal, shows full-month metrics, states the new monthly goal.
- **15th of each month** — mid-month pace check for the **1st through the 14th of the current month.** Forward-looking: percent of monthly goal reached, dollars/day needed to finish the month, and comparison to the same point last month. Emphasize the streak/pace framing here ("you're $X ahead of your own pace").

## Plan-tier differentiation (real tiers: basic / pro / max)

- **Basic:** AP, policies, estimated commission, total dials, close ratio, goal progress, upcoming drafts.
- **Pro:** all of Basic + talk time, pickup ratio, appointments set, streak/pace comparison.
- **Max:** all of Pro + a downline/team rollup — team combined AP, top producer of the period, and any downline agents with zero dials in the last 7 days. (My agency/downline structure lives in the agency tables — see `supabase/migrations/20260616_agency.sql`; read it and map to the real relationships. Flag back to me if the downline linkage is ambiguous.)

## Empty-period handling

When metrics are near zero, render encouraging, honest, forward-looking copy — **never a stark "$0 · 0 · $0."** Frame as a slow start with momentum and state how much of the goal remains.

## Tone & subject lines

Premium, clean, personal, professional — an account statement, not an ad. Subject lines lead with the customer's own numbers, e.g. "Your October Report — 41 policies, $52K AP" and "Halfway through November — you're ahead of pace."

## Toggle (opt-out) — spec it precisely

- A **new** boolean column, e.g. `agents.summary_emails_enabled`, **default `true`**, **separate from `digest_enabled`** (which is the daily digest and defaults false — do not conflate them).
- Spec the one-time backfill `UPDATE public.agents SET summary_emails_enabled = true;` for existing rows. (Note: modern Postgres also backfills a constant default on `ADD COLUMN`, but include the explicit UPDATE anyway as belt-and-suspenders and to cover any NULLs.)
- The Edge Function wrapper **must skip any agent whose `summary_emails_enabled` is false OR who does not have granted plan access** (use the granted-access signal above — `plan_id` present, NOT a detected Stripe payment, so my $0/100%-discount agents are correctly included). State this skip logic explicitly in the wrapper you build.
- Spec exactly which table/column so Claude Code can wire the Summary-tab UI to it.

## One-click unsubscribe (CAN-SPAM compliance) — include this

Even though these are transactional-ish, they must carry a compliant one-click opt-out:

- Every email footer includes a **one-click unsubscribe link** that sets `summary_emails_enabled = false` for that agent **without requiring login** — via a small token-based unsubscribe Edge Function (signed/opaque per-agent token, not a guessable id).
- Include proper **`List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`** headers in the Resend send so Gmail/Apple render a native one-click unsubscribe.
- Keep the footer minimal and statement-like so it doesn't read as marketing.

## Deliverability

Sender is **producerstack@frenkelfinancial.com** via Resend (reuse the `DIGEST_FROM` secret pattern). In your output, note that I must verify the sending domain's DKIM in Resend before go-live, and **recommend whether to send from a `reports.frenkelfinancial.com` subdomain** to isolate report reputation from any outreach reputation (display name can still show producerstack@).

## Your deliverables from this session

1. The confirmed schema mapping (every table/column you'll use), plus the list of items you need me to confirm (real JSONB key names, the active-subscriber signal, the downline linkage).
2. The **gather module** and **render module** as separate, clean files, mirroring my `weekly-digest` structure.
3. Both email HTML templates (1st and 15th), fully rendered with realistic **TEST DATA** for all three tiers — so I can preview all six variations — plus one empty-period example. (No `requires_action`/status/action-required section anywhere.)
4. The exact `pg_cron` schedule definitions (DST-aware, America/Chicago) and the Edge Function wrapper — including the skip-if-off-or-inactive gating — written but **NOT deployed**, clearly labeled as "the deploy package."
5. The token-based unsubscribe Edge Function + the `List-Unsubscribe` header additions.
6. A precise spec for the `summary_emails_enabled` column + backfill, and exactly how the Summary-tab toggle UI should bind to it (so Claude Code can wire the real HTML app).
7. A plain-English list of everything Claude Code must do to install this live, and every manual step I must do myself (Resend DKIM verification, DNS, enabling `pg_cron`/`pg_net`/`http`, setting secrets).

Validate everything against test data and show me the previews before we call it done. Ask me any clarifying question rather than guessing.
