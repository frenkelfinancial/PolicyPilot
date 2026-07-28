# Orion AI Solutions — Full Feature Teardown & ProducerStack Gap Analysis

**Walked:** `app.orionaisolutions.ai` (live trial account, every screen in Front Office + Back Office + all 13 Settings tabs), plus the public marketing site.
**Compared against:** the PolicyPilot/ProducerStack repo (`app.html` nav, `supabase/functions/*`, CLAUDE.md, PRODUCT.md).
**Date:** 2026-07-27

Legend on every gap:
- 🔴 **MISSING** — you have nothing like it
- 🟡 **PARTIAL** — you have the plumbing but not the product
- 🟢 **HAVE** — already built (listed so you don't rebuild it)

---

## 0. Orion at a glance

**Two-app structure inside one product.** A top-left toggle flips between **Front Office** (selling) and **Back Office** (money). This is their single biggest structural idea and it's worth stealing outright — it lets one product serve the producer *and* the agency owner without either drowning in the other's screens.

**Front Office nav:** Dashboard · Contacts · Pipeline · Calendar · AI Campaigns (Conversations / SMS Campaigns / Voice Campaigns) · Power Dialer (Dialer / Call Recordings / Metrics) · Meta Ads (Overview / Campaigns / Reporting / Gallery / A-B Tests / Decisions / Agent Performance) · Leaderboard · Settings

**Back Office nav:** Overview · Inbox · Book of Business · Commissions (Dashboard / Progress / Carriers) · Persistency · Team Tree · Reconciliation · Developers

**Settings (13 tabs, grouped):**
- ACCOUNT — Profile · Security · Producer Codes
- BILLING & PLAN — Billing
- PHONE & DIALER — Call Settings · Power Dialer Audio · Personal Numbers · Trust Center
- MESSAGING & AI — SMS AI · Email · Orion AI Bot
- INTEGRATIONS & DATA — Webhooks · Fields & Tags

**Their pricing (for positioning):**
- $149/agent/month, 14-day free trial, $499 one-time setup for independents
- Annual: $1,341/yr (3 months free)
- Power Dialer Pro add-on: $129/mo or $1,320/yr
- Annual bundle (both): $1,997 first year, $2,661/yr after — pushed with a 4-day countdown timer on every single page
- Wallet: $10 welcome credit, auto-recharge $10 when balance < $1, top-ups of $50/$100/$250
- 5 phone numbers included, free A2P registration, done-for-you setup
- Claimed numbers: 2,500 AI calls/day/agent, 28s speed-to-lead, 68% pickup, 22% pickup→close, 31% pickup→appt, $5k avg added monthly production, 500+ agents

**Your price today:** $99 / $149 / $249. You're at parity on price with a product that currently does *far* more per dollar. Either the feature gap closes or the price story has to change.

---

## 1. AI VOICE AGENT — the core of their product

### 1.1 The agent itself ("Ashley")
🟡 **PARTIAL** — you have `ai-call-start` / `ai-call-webhook` (Phase 1, audio not yet working). Orion's is in production.

What Orion's does:
- Answers **inbound** calls in ~2 rings, qualifies, books
- Runs **outbound** campaign calls
- **Live-transfers** qualified leads to the agent, or books an appointment instead
- Handles objections contextually; asks qualifying questions
- Confirms every booked appointment by SMS
- Logs transcript + AI summary + disposition + next steps to the contact record

**Available / Busy toggle in the global header.** One click. "Available" = AI live-transfers hot leads to you. "Busy" = AI books an appointment instead of transferring. This is a tiny feature with huge perceived value — it's the difference between "AI dialer" and "AI that respects that I'm on a call." **Build this.**

**Custom AI agent name.** Settings → Profile → "AI Agent Name": the name the voice & SMS AI introduces itself as (defaults to "Ashley"). Also a "Company / Agency Name" field injected into scripts: *"…with {your company}'s office."*
> Note: they do **not** expose voice selection (male/female) in the UI. You already planned that. **That's a differentiator — ship it.**

### 1.2 Daily call ceiling + ramp-up
🔴 **MISSING** — and this is a compliance/deliverability feature disguised as a usage meter.

> "Daily Voice AI Call Usage — 0 / 300 · **Ramp-up · day 1 of 7** · Resets 11:00 PM CDT
> Your daily ceiling is 300 because each AI number can place up to 300 calls/day and you have 1 active AI number. Add more AI numbers to raise it."

Three things happening at once: (1) per-number daily cap of 300, (2) a **7-day ramp-up** so new numbers don't get flagged as spam, (3) a natural upsell — "add more AI numbers to raise it." Copy all three.

### 1.3 Voice campaign builder
🔴 **MISSING** entirely. This is the biggest single gap.

**Settings tab:**
- Live Slots indicator — `0/3 active` concurrent call slots, shown as three visual slots
- Campaign Name, Description
- **Trigger Conditions** — visual rule builder: groups of conditions, `Match ALL of` within a group, `OR` between groups, each condition is `[field] [NOT] is [value]`, every group must contain at least one Campaign Tag. `+ Add condition` / `+ Add another group (OR)`
- **Enrollment & Stop Conditions** (checkboxes):
  - Auto-enroll new leads
  - Trigger on missed appointment
  - Trigger when lead is sold
  - Stop on appointment booked
  - Stop when lead is sold
  - **Stop when lead answers (15s+ conversation)** ← nice detail, defines "answered" by talk length not connect
- **"Re-evaluate leads now"** button — re-runs trigger matching against the existing book on demand

**Steps tab** (per-step):
- Step type dropdown — e.g. **"Double-Dial (2 attempts)"**
- Call Timing — Wait `N` [minutes/hours/days] before this step
- **Drip rate** checkbox — throttle this step's release rate (so 500 enrolled leads don't all get dialed at 9:00:00am)
- Add/remove/reorder steps

**Enrollments tab** — who is currently in the campaign and where.

### 1.4 The 12 pre-built voice campaigns (shipped as defaults, all ACTIVE on day 1)
🔴 **MISSING**

| Campaign | Steps |
|---|---|
| Chargeback Recovery | 9 |
| Emergency Contact | 5 |
| Beneficiary Referral | 5 |
| Customer Care (sold) | 6 |
| No-Show Follow-up | 5 |
| Appointment Reminder | 2 |
| Trucker | 6 |
| IUL | 6 |
| Mortgage Protection | 6 |
| General Life | 6 |
| Final Expense | 6 |
| Veteran Lead | 6 |

**The insight isn't the AI — it's that the account is useful in the first 60 seconds.** A new agent signs in and 24 campaigns (12 voice + 12 SMS) are already live and correctly wired to lead-type tags. Zero blank-state. You have a blank-state problem: your app opens empty and the agent has to build everything.

---

## 2. AI SMS AGENT

🟡 **PARTIAL** — you have `messaging-send-sms/mms`, `messaging-inbound-webhook`, `messaging-broadcast-*`, `messaging-timeout-sweep`. You have the pipes. You do not have an AI that answers.

**Settings → SMS AI** — and critically, **settings are per campaign type**, not global. Tabs across the top: Veteran Lead · Final Expense · General Life · Mortgage Protection · IUL · Trucker · No Show · Sold · Chargeback · Beneficiary Referral · Emergency Contact · Appointment Reminder.

Per campaign type:
- **AI responses** on/off — AI answers inbound texts from leads on this campaign
- **Tone** — Professional (formal) / Friendly (warm) / Casual (relaxed)
- **Response length** — Brief (1–2 sentences) / Medium (2–3 sentences)
- **Emojis** on/off
- **Auto follow-up** — up to 4 nudges when a lead goes quiet at **8h, 24h, 48h, 7d**, respecting TCPA quiet hours
- **Appointments** — default duration (15/30/45/60/90 min) + appointment type label shown on the calendar invite
- **Custom responses** — up to 20 trigger→answer pairs: "when a lead's message contains the trigger, the AI uses your answer." This is a cheap, agent-controllable way to handle recurring objections without prompt engineering. **Steal this.**
- Manual takeover of any conversation at any time

Documented behavior shown in-app: *"Follow-ups respect TCPA quiet hours (9am–8pm Mon–Sat, no Sunday)."*

### 2.1 SMS campaign builder + the 12 default SMS campaigns
🔴 **MISSING**

Step editor:
- Step types: **SMS Message** and **Wait**
- SMS body with merge variables — `{{firstName}}`, `{{agentName}}`, `{{companyName}}`, `{{carrier}}`, `{{coverageAmount}}`, `{{agentPhone}}`
- **Attachments (MMS)** — Add Files per step
- **Send Test** — enter a phone number, fire that exact step to yourself
- **Drip rate** throttle per step
- Wait Duration `N` [minutes/hours/days]

Campaign-level toggles:
- **End Campaign on Lead Response** (note: "The Conversation AI will always be activated regardless of this setting")
- **Auto-enroll New Leads**
- Campaign Behavior: Stop on Appointment Booked · Stop on Sold · **Pause on Active Conversation** (pause the drip while an AI or agent conversation is live) · **Respect DNC List**
- Stats tab per campaign

Default SMS campaigns and depth: Chargeback 10 · Emergency Contact 8 · Beneficiary 8 · SOLD Customer Care 12 · No-Show 18 · Appointment Reminder 7 · Trucker 24 · IUL 24 · Mortgage Protection 24 · General Life 24 · Final Expense 24 · Veteran 26 steps.

A 26-step veteran sequence is real content work. That's a moat built out of copywriting, not code — which means you can match it faster than you think.

---

## 3. AI EMAIL AGENT

🔴 **MISSING** as a product (you have `messaging-send-email` + `messaging-email-inbound-webhook` plumbing, and your Gmail *parser* which is a different thing).

**Settings → Email**, gated behind a 0/3 setup checklist: Verify a sending domain → Add your email signature → Brand your links.

Three sub-tabs: **Sending** (verified senders, domain DNS verification, default From) · **Signatures** · **AI Replies**.

From the marketing site: drag-and-drop email builder with template library, blocks (text/images/buttons/signatures), merge tags, sends from verified agency domains, quiet-hours scheduling matched to SMS. AI reads inbound replies, answers questions, offers times, books appointments, one-toggle manual takeover.

---

## 4. UNIFIED CONVERSATIONS INBOX

🔴 **MISSING**

`/conversations` with three tabs: **Voice AI · SMS Inbox · Email Inbox**.

Voice AI tab:
- Call history list with disposition filters: All · Appt Set · Transferred · Completed · Voicemail · No Answer · Failed · Busy · DNC · Not Interested
- Counters: CALLS · APPTS · AVG (talk time) · SCRIPTS
- Click a call → detail pane (transcript, summary, recording)
- **REAL-TIME MONITORING panel**: Active Calls / Total Today / Completed / Failed, auto-refreshing, "Calls will appear here in real-time when they start"

You have transcript + summary fields on `ai_calls` — you're missing the surface that makes them visible and filterable.

---

## 5. POWER DIALER

🟢 **HAVE** the dialer (Telnyx WebRTC, single-line). 🔴 **MISSING** the packaging around it.

Orion's Power Dialer Pro add-on ($129/mo) contents:
- **3 concurrent lines (MLPD)** — agent is dropped in only on a live human answer
- Unlimited calling minutes, unlimited recording minutes
- **Automated voicemail drops & callback texts**
- 10 free manual number slots
- **Local-presence dialing**
- **Settings → Power Dialer Audio**: "Record once, reuse everywhere — assign voicemail drops & callback messages **per campaign type**"
- Callback obligations + prospect context shown on screen during the call
- Abandoned-call handling: multi-line campaigns require a recorded callback message with press-1 opt-out before launch

**Power Dialer Metrics page** (`/dial-campaigns/metrics`), WTD/MTD/YTD:
- Pickup rate — explicitly defined as **connected calls 45s+** (not "connected")
- Pickup → Close · Pickup → Appt · Opt-out rate
- Conversion funnel (% of dials) · Answer mix · **Human pickups & closes by hour** · Avg talk time · Total dials · **Abandoned (callback) rate**

**Call Recordings page** — searchable library, Inbound/Outbound filter, total + avg duration, inline player.

> You already decided single-line only for v1 and 3-line is where their $129/mo add-on lives. Note the shape: they sell the *second line count* as the upsell, not the AI. And "pickup rate = 45s+ connections" is the honest metric — worth adopting because it makes your numbers defensible.

---

## 6. COMPLIANCE & TRUST CENTER — the part you asked about specifically

This is where Orion has done the most unglamorous work, and it's the hardest thing for a competitor to fake.

### 6.1 A2P 10DLC
🟡 **PARTIAL** — you have `a2p-register`, `a2p-status-poll`, `a2p-assign-number` edge functions. Orion has the whole product experience around it.

**The single best idea in their entire app:**
> "**A2P registration is handled for you.** Orion automatically registers your number under **our shared A2P 10DLC brand and campaign** — you do not need to submit your own registration to start sending SMS. The steps below are only required if you specifically need a Standard campaign (higher throughput, dedicated brand). Most agencies should ignore this tab and proceed straight to messaging."

They eat the A2P onboarding pain by putting agents on a **shared brand/campaign** by default and only pushing individual registration for high-throughput users. That turns a 2-week blocker into zero clicks. **If you do one thing from this document, do this one.**

Monetization detail: *"A2P 10DLC registration isn't included during your free trial. Provision it now for a one-time **$20** charge to start carrier review immediately — or it's submitted automatically for free once your subscription's first payment goes through."* Impatience is a product.

**Registration wizard (6 stages with status chips):**
1. **Brand Type** — select registration type
2. **Business Information** — legal business details
3. **Compliance Website** — *"Create your compliance website with required legal pages"* ← 🔴 **they generate a hosted compliance site (privacy policy, terms, opt-in disclosure) for the agent, because TCR requires a public URL.** Huge friction remover. You have privacy-policy.html and terms-of-service.html for *yourself* — they generate one *per agent*.
4. **Brand Registration** — submits to The Campaign Registry (TCR); in-app copy explains 24–48h verification
5. **Campaign Registration** — register the SMS campaign
6. **AI Review** — 🔴 **an AI pre-check of the submission before it goes to TCR**, to catch rejections before carriers do

Business Information also collects, in Settings → Profile: "I have a business entity" checkbox → Legal Business Name, **EIN**, Business Type (LLC / Corporation / Partnership / Non-Profit), Legal Business Address. This is exactly the TCR payload, collected once.

### 6.2 Caller ID & Attestation (Trust Center, lower half)
🟡 **PARTIAL** — you have `telnyx-set-cnam`, `telnyx-update-all-cnam`, `telnyx-reputation-monitor`. Not surfaced as a trust product.

- **CNAM Registration** — Business Name (Caller ID), 15-char limit with live counter, "Register CNAM" button
- **Number Status table** — Phone Number | CNAM Status | Pool (Manual / AI). Per-number.
- **Call Attestation** — *"Anti-spoofing attestation — signs your outbound calls so carriers trust the caller ID."* Shows Business Name + Profile Status (`In Review`, "Reviews take 1–3 business days"). This is **SHAKEN/STIR attestation level** surfaced to the agent. Your Personal Numbers equivalent shows `SHAKEN C` — Orion is actively working the profile to get to A.
- **Voice Integrity** — *"Spam-label removal — registers your numbers with carrier analytics (**AT&T, T-Mobile, Verizon**) to clear spam labels and improve answer rates."* Auto-created once the business profile is approved.
- "Refresh status" button

### 6.3 Runtime compliance gates
🟡 **PARTIAL** — you have `dnc` and `tcpa_consent` columns on leads and a quiet-hours check in the AI call-start path. You do not have the enforcement layer, the audit trail, or the agent-facing proof.

Their stated model — "**enforced in code, not remembered**":
- **Quiet hours in the lead's own timezone** — 9am–8pm, never Sunday. Out-of-window sends are **deferred to the next legal morning, not dropped.** (Your check rejects; theirs reschedules. Better UX, same compliance.)
- **Consent record per lead** — source, opt-in language, timestamp, **proof file**. Leads without documented consent are **locked out of AI voice outreach.**
- **AI disclosure** — spoken before anything else on every AI call. In your app this exists as Settings → Call Settings → "Enable Voice AI Disclaimer — speak your disclaimer verbatim before the greeting on every AI call." 🟢 you have the equivalent concept if you built that; verify it's wired.
- **Recording disclosure** to both parties before recording starts
- **DNC fail-closed** — if the DNC check errors, the send is **withheld**, not risked. Every block and pass logged with a timestamp.
- **STOP handling** — a single STOP closes the conversation, cancels scheduled drips, adds to DNC, and sends a confirmation **from the originating number**
- **Scrubbed imports** — suppressed numbers removed on entry
- **Attestation checkpoint** before enabling AI voice on a batch (you already planned per-batch consent attestation 🟢)
- **Exportable compliance logs** — every add, block, removal
- Signed, expiring URLs for recording access
- Lead-level compliance state visible to the agent on the record

---

## 7. CONTACTS / CRM

🟡 **PARTIAL** — you have leads, CSV import, duplicate removal, custom fields.

What they have that you don't:
- 🔴 **Smart Lists** — "Save Current Filters" turns any filter combination into a named, reusable list pinned above the table
- 🔴 **Urgent Tasks** widget on the contacts page ("All complete" / "All sold forms complete!") — a work queue, not just a list
- 🟡 Toolbar: Search · All Statuses · All Campaigns · **More** (advanced filters) · Video guides · **Call** (dial the filtered set) · **Export** · **CSV** import · Add
- 🔴 **Settings → Fields & Tags**:
  - Custom Field Definitions — "standardize data across your leads"
  - **Lead Tags with a Type column**: agency-shared tags (applied but not editable by the agent) and **auto-managed Source tags**: Aged, CSV Upload, Facebook, Fresh, Google, LinkedIn, Manual, Meta, Referral, TikTok, Vendor, Website, YouTube. Source attribution is automatic and never agent-entered — which is what makes their cost-per-acquisition reporting trustworthy.

### 7.1 Lead-vendor webhooks
🔴 **MISSING** (you have `lead-ingest`; they have a per-vendor product around it)

**Settings → Webhooks** — one unique ingest URL **per campaign type**, pre-created on signup:
```
https://api.orionaisolutions.ai/api/v1/webhooks/leads/<32-char-token>
```
Six live out of the box: Veteran Lead, Final Expense, General Life Insurance, Mortgage Protection, IUL Lead, Trucker.

Per webhook: Active toggle · **Voice AI** badge · **Auto-Route** badge · campaign assignment · auto-applied Vendor tag (editable) · leads-received counter · created date · **Field Mapping → Configure** (map the vendor's JSON keys to your fields) · **regenerate URL** (with a security notice that a leaked URL should be rotated).

The flow they sell: *agent gives the URL to their lead vendor → leads arrive tagged, routed to the right campaign, and the AI starts calling within 28 seconds.* That's the whole "speed to lead" claim, and it's built entirely out of this one screen.

---

## 8. PIPELINE (Kanban)

🔴 **MISSING** — you have a leads list and a policy tracker; you don't have a drag-and-drop deal board.

14 stages, filterable by campaign type:
`New Leads → Referrals → Called - No Pickup → Picked Up → Interested → Needs Follow-Up → Live Transfer → Appointment Booked → No Show → Sold → Chargeback → DNC → Not Interested → Bad Number`

Note that Chargeback and DNC are *stages*, not just flags — which is what lets the Chargeback Recovery and win-back campaigns trigger off pipeline movement.

---

## 9. CALENDAR & APPOINTMENTS

🟡 **PARTIAL** — you have Google Calendar integration.

- Month / Week / Day views, KPI strip: Today · This Month · Completed · **No Show**
- New Appointment, Events pane, Upcoming pane
- **Settings → Call Settings → Calendar Integration**: "Add Calendar", multiple calendars, *"the AI agent will check all your calendars for conflicts before suggesting appointment times"* — conflict checking is what makes AI booking safe
- **Working Hours** — per-day start/end in 30-min increments, Saturday/Sunday can be "Unavailable"
- **Timezone** selector including "Arizona (MST - no DST)" — someone got burned by DST
- Appointment duration + type label configurable per campaign type (see §2)

---

## 10. BACK OFFICE

This is the half of Orion you're closest to matching — your commission/policy/persistency work is real. Gaps are mostly in ingestion and hierarchy.

### 10.1 Commission Inbox / statement ingestion
🔴 **MISSING** the ingestion product (you have the Gmail *carrier email* parser, which is adjacent but different)

`/back/ingest`:
- **A dedicated per-tenant email address**: `22GQE6EP@commissions.orionaisolutions.ai` — forward carrier commission statements there and they parse automatically
- Or drag-and-drop upload, **up to 500 MB**, formats: PDF, XLSX, XLS, CSV, HTML, **ZIP**
- AI parses **any carrier format with no template setup**
- **Agent identity sheet bulk load** — "one row per agent, with NPN and per-carrier writing numbers. It will be detected and bulk-loaded automatically."
- Live pipeline status counters: Queued / Parsing / Persisting / Matching / Ingested / Failed
- "0 ingested 7d · 0 pending review"

Your equivalent uses Gmail OAuth + Haiku on *carrier notification* emails. Their unique-inbox-per-tenant pattern is simpler, has no OAuth scope problem, and works for any agent at any carrier. **Consider adding a forwarding address alongside your Gmail integration.**

### 10.2 Book of Business
🟡 **PARTIAL** — you have a policy tracker.

`/back/policies` — "Master policy browser. Status pills, BoB-authoritative dates, and a **status-history timeline per record**."
- Status tabs with counts: All · Pending · **Approved Not Paid** · Issued Paid · Denied · Withdrawn · Lapsed · **Surrendered** · **Claim** · Chargeback
- Product filter: Final expense · Term life · IUL · Whole life · **Annuity**
- Agent filter
- Carriers shown are only those with at least one policy from an ingested BoB report

Two things to steal: **"Approved Not Paid"** as a first-class status (that's the agent's real anxiety), and the **per-policy status-history timeline** (audit trail of every state change).

### 10.3 Commissions dashboard
🟡 **PARTIAL**

Tabs: Trends · Bonuses · Payouts · **Debt**. Ranges MTD/YTD/All Time. Six headline cards, each with a plain-English definition underneath:
- Total Commission — "every commission row ingested for this period, net of chargebacks"
- Gross Commission — "all positive commission earned, before chargebacks"
- **Net Commission — "what actually hits the bank — gross minus chargebacks"**
- Personal Sales — "your producing sales — advanced + renewal on policies you wrote"
- **Override Income** — "override commission from agents in your hierarchy"
- **Outstanding Debt** — "carrier-reported balance"

Charts: weekly trend with commission + personal + override above the line and **debt below the line**; Personal vs Override stacked mix.

🔴 **Debt / rollup debt** as a tracked, drillable number is missing from your app entirely. For an agency owner, "how much does my downline owe the carriers" is the number that keeps them up at night.

### 10.4 Persistency
🟡 **PARTIAL** — you have a persistency health widget.

`/back/persistency`:
- **4 / 9 / 13 / 25-month windows** (you're tracking 13-month)
- **Flat vs Weighted** toggle
- Policy Persistency vs **Agent Persistency** views
- Color bands: Green ≥85% · Yellow 70–84% · Red <70%
- Ranked by carrier, and 🔴 **by lead type** ("link policies to leads to populate") — *persistency segmented by where the lead came from* is a genuinely valuable, sellable insight. Your lead-source data + policy tracker could produce this today.
- Outlier spotlighting

### 10.5 Team Tree, Comp Ladder, Reconciliation, Carriers
🔴 **MISSING** (you have Agency invite/downline, but not the hierarchy engine)

- **Team Tree** — hierarchy with personal + rollup production, volume %, MTD. Gates other features: "Team hierarchy not set up yet — your agency owner can organize the team hierarchy in the Team Tree to unlock team leaderboards, downline, and footprint."
- **Comp Ladder / Progress** — tier progression with automatic updates, carrier-specific comp structures, "progress to the next bump," Fast Start / Producer Club bonus thresholds, override computation from statements. Configured by the agency owner under Back Office → Comp Plans.
  > You already have `data/carrier_bonuses.json` with 45 carriers researched. **That's better raw data than what Orion shows.** You're missing the ladder/progress UI on top of it.
- **Reconciliation** — triage queues for the ingestion pipeline: Policy Match Review · Unlinked Policies · stuck uploads. Priority (High/Medium/Low), status filter, match-% sort, "needs review" flag. This is the human-in-the-loop layer for AI parsing — 🟡 you have a `review_queue` concept in `match-events`; they made it a first-class screen.
- **Carriers** — read-only list of carriers you have commission rows for, sourced from ingested statements
- **Flight Risk Detection** (marketing site, owner-only) — at-risk agents flagged on production decline MoM + chargebacks + activity signals (dial counts). 🔴 Nothing like this in your app; it's a strong agency-owner retention feature.
- **Auto-Referral Generation** — beneficiary and emergency contact captured at sale automatically become new leads. 🔴 This closes the loop between Back Office and Front Office and is why they have Beneficiary/Emergency Contact campaigns at all. **This is free pipeline and you should build it.**

### 10.6 Producer Codes
🔴 **MISSING** — Settings → Producer Codes: NPN + per-carrier writing codes. *"As soon as you save a code, we link it to your account — and if any policies were already imported under that code, they **retroactively attribute** to you."* Retroactive attribution is the detail that makes it work.

### 10.7 Developers / public API
🔴 **MISSING** — `/back/developers`: API keys against a public `/v1/back-office/*` surface. Currently private pilot, feature-flagged per tenant. Worth noting they're building toward being a platform.

---

## 11. BILLING & MONETIZATION MECHANICS

🟡 **PARTIAL** — you have Stripe checkout, wallet, number billing.

Things they do that you don't:
- 🔴 **Seat Management** — "$0.00/mo · 0 active seats", Invite a seat, table of Seat / Status / Per Seat / **Billed To** / Next Bill / Actions. "Billed To" means a team leader can pay for a downline agent's seat. Your Team Leader tier is *seat for the leader only, downline buys their own at 30% off* — theirs lets the leader absorb the cost, which closes bigger deals.
- 🟡 **Wallet with auto-recharge** — "$10.00 available · Auto-recharge Active · Recharge $10 when balance drops below $1" + $50/$100/$250 quick-adds. You have a wallet; check you have the auto-recharge rule and the quick-add buttons.
- 🔴 **Promotional credit as an onboarding event** — "Welcome credits — New unassigned agent signup +$10.00" appears in the transaction history the moment you sign up.
- 🟡 Transaction History with type/description/amount/date, rows-per-page up to 1000; Recent Charges and **Usage Summary** tabs
- 🔴 **The countdown-timer bundle offer** on every page — 4-day timer, "Save 40% against your personalized comparison," "See my savings." Aggressive, but it's clearly load-bearing for them.
- 🔴 **Affiliate program** — "Become an Affiliate" button in the global header of the app itself
- 🔴 **Add-on subscription model** — Power Dialer Pro as a separate SKU with its own feature list and monthly/annual toggle, sold *inside* the product at the moment of need ("Recording and assigning per-campaign voicemail-drop audio is part of Power Dialer Pro. Subscribe from the dial campaigns page to unlock it.")

---

## 12. ONBOARDING, ACTIVATION & IN-APP HELP

Cheap to build, disproportionate effect on trial conversion. You have almost none of this.

- 🔴 **"Activation flight path"** — a persistent 5-step banner on the dashboard: Configure call readiness → Complete the Trust Center action → Add the first lead → Activate a campaign → Start the first outreach. Shows "2 of 5 verified actions complete," completed steps struck through, with **Resume tour** and **Restart** buttons. Re-openable anytime from Settings → Profile → Product Tour ("Paused · 2 of 5 · Current chapter: Get Ready").
- 🔴 **"Watch video" / "Video guides" buttons on literally every screen**, linking to `docs.orionaisolutions.ai/videos/<topic>` — power-dialer, ai-assistant, backoffice, etc. Contextual, per-page, not a help center you have to go find.
- 🔴 **Floating AI assistant widget** (bottom-right, every page) with canned prompts: "I have a support question" · "Send an SMS" · "Send a bulk SMS" · "Analyze my pipeline" · "How can you help make me money today?" — plus a free-text box. It's an *agentic* assistant that can take actions, not a chatbot.
- 🔴 **Settings → Orion AI Bot → AI daily report** — "A morning briefing delivered to your AI assistant at 8:00 AM your time, Monday through Saturday."
  > 🟢 You have `daily-digest`, `weekly-digest`, `monthly-summary` edge functions — you're sending email digests. Theirs lands *inside the assistant*. Yours is arguably better for an agent in a car; consider both.
- 🔴 **Leaderboard** — Today/WTD/MTD/YTD/Custom, ranked by production with Leads Sold and Close Rate. Unlocks off the Team Tree.
  > Careful here: your PRODUCT.md explicitly lists "hustle-bro / MLM energy… leaderboard-worship" as an anti-reference. Orion leans into it. Your call — but for FFL downlines, a leaderboard is table stakes, and you can execute it without the trophies.
- 🟡 **Theme** — Agency Default (Dark) / Dark / Light / System Preference. You have a theme toggle; the "Agency Default" concept (owner sets the org-wide default) is the missing piece.
- 🔴 **2FA** — emailed verification code; required for admin actions
- 🔴 **Verified email/password changes** — both send a code to the current address before allowing the change
- 🟡 **SMS notifications to the agent**: Live Transfers (call incoming) · Appointment Reminders (30 min before) · Verification Codes · Payment Alerts, with a "Test SMS" button and STOP-to-unsubscribe copy
- 🔴 **SIP Softphone option** — Settings → Call Settings → Calling Method: Browser (WebRTC) **or SIP Softphone (Zoiper, Bria, etc.)**. Cheap to add, and it wins the agents who hate browser calling.

---

## 13. META ADS (not yet live — but the roadmap is visible)

Private beta, gated: *"We're rolling Meta Ads out gradually as we complete Meta's review process."* The nav reveals the full planned surface:

`/meta-ads` overview · `/campaigns` · `/reporting` · `/gallery` (creative library) · `/ab-tests` · `/decisions` · `/agent-performance`

The one page that renders is **AI Decision Log**: *"Browse every creative, copy, and budget decision the AI has made for your ad account — grouped into bundles, labeled with measured outcome."*

They're building an AI that runs Facebook ad campaigns for insurance agents, buys the leads, and feeds them straight into the AI dialer — closing the loop from ad spend to booked appointment. **That's the direction the category is going.** You don't need to match it now, but know it's coming.

---

## 14. WHAT YOU HAVE THAT ORION DOESN'T

Don't lose these while chasing their list. These are your actual wedge:

1. **Live multi-carrier rate quoting** (`api-quoter`, ITK integration) — Orion has **nothing** like this. An agent still has to leave Orion to quote.
2. **AI Underwriter** (`uw-chat`, DeepSeek) — no equivalent in Orion.
3. **Carrier bonus tracker** — 45 carriers of researched, carrier-official bonus programs with payout math and quarterly decay handling. Orion shows "Fast Start / Producer Club" generically. Your data is deeper.
4. **Gmail carrier-email parser** — pulling underwriting status out of carrier notification emails and auto-advancing the policy tracker. Orion parses *commission statements*; you parse the *underwriting conversation*. Different, and arguably more day-to-day useful.
5. **FFL-specific comp math** (`COMP` table, FFL VP/non-VP calculator) — Orion is carrier-generic.
6. **Native iOS/Android apps** (Capacitor) — Orion is web-only.
7. **AI voice selection (male/female)** — you planned it; they don't offer it.
8. **Transparent, at-cost usage pricing** — $0.01/min at your stated cost, $3/mo numbers. Orion buries usage in a wallet.

---

## 15. SUGGESTED BUILD ORDER

**Tier 1 — do these first (highest value / effort ratio):**
1. **Shared A2P 10DLC brand + campaign** so agents can text on day one with zero registration. Add the per-agent compliance-website generator.
2. **Default campaign library** — ship 12 SMS + 12 voice sequences pre-built and active, tagged by lead type. Kills your blank-state problem in one release.
3. **Per-vendor lead webhook URLs** with auto-tagging, auto-routing, and field mapping. This is the speed-to-lead story.
4. **Available / Busy toggle** in the header (live-transfer vs. book-instead).
5. **Auto-referral generation** — beneficiary + emergency contact from every sold policy become leads.

**Tier 2 — the AI campaign engine:**
6. Trigger-condition rule builder + enrollment/stop conditions + drip-rate throttling
7. Inbound SMS AI with per-campaign-type tone/length/emoji/follow-up settings and the 20 custom trigger→answer pairs
8. Unified Conversations inbox (Voice / SMS / Email) with disposition filters and real-time call monitoring
9. Per-number daily call ceiling + 7-day ramp-up

**Tier 3 — trust and back office:**
10. Trust Center screen: CNAM per number, attestation status, spam-label removal, number health
11. DNC fail-closed + consent records with proof file + exportable compliance log + quiet-hours *deferral* instead of rejection
12. Commission statement ingestion via a per-tenant forwarding address
13. Team Tree → unlocks rollup production, leaderboard, override/debt reporting
14. Comp ladder UI on top of your existing carrier bonus data
15. Persistency by lead source (you can build this from data you already have)

**Tier 4 — packaging:**
16. Seat management with "billed to" (leader pays for downline)
17. Add-on SKU model (sell the multi-line dialer separately)
18. Activation flight path + per-screen video guides
19. Affiliate program

---

*Everything above was observed directly in the Orion trial account on 2026-07-27 unless attributed to their public marketing pages (§1 metrics, §3 email builder details, §6.3 compliance model, §10.5 flight risk / auto-referral). Marketing claims are their claims, not verified.*
