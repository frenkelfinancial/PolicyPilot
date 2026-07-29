# ProducerStack — Orion Gap Build Checklist

Every feature Orion has that you're **missing** or only **partially** have, as one atomic item per line.
Ordered so each one is shippable on its own without waiting on the next.

Excluded on purpose: leaderboard, production rankings, countdown-timer upsells, "trophy" mechanics.
Team/rollup **reporting** is still in here — an agency owner needs downline production and debt numbers.
That's operational data, not a scoreboard.

Companion doc: `docs/ORION_GAP_ANALYSIS.md` (full detail on each item).

---

## PHASE 1 — Unblock the new agent (biggest value, least code)

- [ ] **1. Shared A2P 10DLC brand + campaign.** Register every agent's number under *your* brand/campaign so SMS works on signup with zero agent action. Keep individual Standard-campaign registration as an opt-in path for high-throughput users only.
- [ ] **2. Per-agent compliance website generator.** Auto-generate a hosted page per agent with privacy policy, terms, and opt-in disclosure. TCR requires a public URL — this removes the blocker for anyone who *does* need their own brand.
- [ ] **3. Business entity capture in Settings → Profile.** "I have a business entity" checkbox → Legal Business Name, EIN, Business Type (LLC / Corp / Partnership / Non-Profit), Legal Business Address. This is the exact TCR payload — collect it once, reuse it for brand registration.
- [ ] **4. A2P registration wizard with stage tracking.** Six stages with status chips: Brand Type → Business Info → Compliance Website → Brand Registration → Campaign Registration → AI Review. Show TCR timing expectations inline ("24–48 hours").
- [ ] **5. AI pre-check before TCR submission.** Run the brand/campaign submission through a model to catch rejection reasons before carriers see it.
- [ ] **6. Default SMS campaign library.** Ship 12 pre-built, pre-active sequences tagged to lead type: Final Expense, Mortgage Protection, IUL, Veteran, Trucker, General Life, No-Show, Sold/Customer Care, Chargeback Recovery, Beneficiary Referral, Emergency Contact, Appointment Reminder. Depth matters — Orion's run 7–26 steps.
- [ ] **7. Default voice campaign library.** Same 12 lead types, 2–9 steps each, pre-active.
- [ ] **8. Per-vendor lead webhook URLs.** One unique ingest URL per campaign type, pre-created at signup. Include: active toggle, auto-applied vendor tag, campaign auto-routing, leads-received counter, and a regenerate button with a leak warning.
- [ ] **9. Webhook field mapping UI.** Let the agent map a vendor's JSON keys to your lead fields without you touching code.
- [ ] **10. Available / Busy toggle in the global header.** Available = AI live-transfers hot leads to the agent. Busy = AI books an appointment instead. One click, visible on every screen.
- [ ] **11. Auto-referral generation.** When a policy is marked sold, capture beneficiary and emergency contact and create them as new leads with the right campaign tag. Free pipeline, and it's what makes items 6/7's referral sequences worth having.

---

## PHASE 2 — The campaign engine

- [ ] **12. Trigger condition rule builder.** Condition groups, `Match ALL` within a group, `OR` between groups, `[field] [NOT] is [value]`, at least one campaign tag required per group. Add/remove conditions and groups.
- [ ] **13. Enrollment and stop conditions.** Auto-enroll new leads · trigger on missed appointment · trigger when sold · stop on appointment booked · stop when sold · stop when lead answers (15s+ conversation) · pause on active conversation · respect DNC list · end campaign on lead response.
- [ ] **14. "Re-evaluate leads now" button.** Re-run trigger matching against the existing book on demand, not just on new-lead arrival.
- [ ] **15. SMS step editor.** Step types SMS Message and Wait. Body with merge variables (`{{firstName}}`, `{{agentName}}`, `{{companyName}}`, `{{carrier}}`, `{{coverageAmount}}`, `{{agentPhone}}`). Wait duration in minutes/hours/days.
- [ ] **16. MMS attachments per step.** Add files to any SMS step.
- [ ] **17. "Send Test" per step.** Enter a phone number, fire that exact step to yourself before going live.
- [ ] **18. Drip-rate throttle per step.** Cap the release rate so 500 enrolled leads don't all fire at 9:00:00am.
- [ ] **19. Voice step editor.** Step type (single dial / double-dial 2 attempts), wait timing, drip-rate throttle.
- [ ] **20. Live slot indicator on voice campaigns.** Visual `0/N active` concurrent call slots.
- [ ] **21. Campaign enrollments tab.** Who is currently enrolled and which step they're on.
- [ ] **22. Per-campaign stats.** Messages sent, enrolled, replies, contact rate, opt-out rate, completed — on the campaign card and in a stats tab.
- [ ] **23. Campaign lifecycle actions.** Pause/resume, duplicate, archive, delete, share. Active / Draft-Paused / Archived filter tabs.

---

## PHASE 3 — Inbound AI (the part that makes it feel alive)

- [ ] **24. Inbound SMS AI.** AI answers inbound texts, checks calendar availability, books appointments, updates lead status. Agent can take over any conversation manually at any time.
- [ ] **25. Per-campaign-type SMS AI settings.** Not global — separate settings per lead type: AI responses on/off, tone (Professional / Friendly / Casual), response length (Brief 1–2 / Medium 2–3 sentences), emojis on/off.
- [ ] **26. Auto follow-up nudges.** Up to 4 when a lead goes quiet, at 8h / 24h / 48h / 7d, respecting quiet hours.
- [ ] **27. Custom trigger→answer pairs.** Up to 20 per campaign type: when a lead's message contains the trigger, the AI uses the agent's canned answer. Lets agents handle recurring objections without touching prompts.
- [ ] **28. AI appointment defaults per campaign type.** Default duration (15/30/45/60/90 min) and appointment type label shown on the calendar invite.
- [ ] **29. Inbound call answering.** AI picks up inbound calls, qualifies, books or transfers.
- [ ] **30. SMS confirmation after every AI-booked appointment.**
- [ ] **31. Unified Conversations inbox.** Three tabs: Voice AI, SMS Inbox, Email Inbox. Filter by lead.
- [ ] **32. Call history with disposition filters.** All · Appt Set · Transferred · Completed · Voicemail · No Answer · Failed · Busy · DNC · Not Interested. Counters for calls, appts, avg talk time.
- [ ] **33. Call detail pane.** Transcript, AI summary, recording playback, disposition, next steps — surfaced from the `ai_calls` fields you already store.
- [ ] **34. Real-time call monitoring panel.** Active Calls / Total Today / Completed / Failed, auto-refreshing, calls appear as they start.
- [ ] **35. Per-number daily call ceiling.** 300 calls/day per AI number, ceiling scales with number count, shown as a usage bar with a reset time.
- [ ] **36. 7-day new-number ramp-up.** Throttle a fresh number's volume for its first week so carriers don't flag it.

---

## PHASE 4 — AI email

- [ ] **37. Sending domain verification.** DNS-verified sending domain so email leaves from the agent's own domain.
- [ ] **38. Verified sender management.** Multiple senders, one default From.
- [ ] **39. Email signature builder.**
- [ ] **40. Link branding.** Branded tracking/click domain.
- [ ] **41. Email campaign builder.** Drag-and-drop editor, template library, blocks (text / image / button / signature), merge tags, quiet-hours scheduling matched to SMS.
- [ ] **42. Email AI replies.** Reads inbound email, answers questions, offers times, books appointments, one-toggle manual takeover.
- [ ] **43. Setup checklist UI for email.** "0/3 — verify domain, add signature, brand links" so the agent knows why email isn't sending yet.

---

## PHASE 5 — Compliance and trust (hard to fake, hard to copy)

- [ ] **44. Trust Center screen.** One page for A2P status, CNAM, attestation, and number health.
- [ ] **45. CNAM registration UI.** Business name with a 15-character live counter, register button, per-number CNAM status.
- [ ] **46. Number status table.** Phone number | CNAM status | pool (Manual / AI) | state | active | cost | last used.
- [ ] **47. Call attestation / SHAKEN profile.** Show current attestation level and profile review status ("In Review · 1–3 business days"). Work the profile toward A instead of sitting at C.
- [ ] **48. Voice integrity / spam-label removal.** Register numbers with AT&T, T-Mobile, and Verizon analytics to clear spam labels. Auto-create once the business profile is approved.
- [ ] **49. Daily spam-score monitoring per caller ID.** You have `telnyx-reputation-monitor` — surface it: daily score, carrier flag detection, weekly volume per number, health status.
- [ ] **50. Automatic rotation and removal of flagged numbers.**
- [ ] **51. Quiet hours as deferral, not rejection.** Out-of-window sends reschedule to the next legal morning instead of erroring. 9am–8pm in the *lead's* timezone, never Sunday.
- [ ] **52. Consent record per lead.** Source, opt-in language, timestamp, and an uploaded proof file. Lock leads without documented consent out of AI voice outreach.
- [ ] **53. DNC fail-closed.** If the DNC check errors, withhold the send rather than risk it. Log every block and every pass with a timestamp.
- [ ] **54. Full STOP handling.** One STOP closes the conversation, cancels all scheduled drips, adds to DNC, and sends a confirmation from the originating number.
- [ ] **55. Scrubbed imports.** Strip suppressed and DNC numbers on entry, and report how many were removed.
- [ ] **56. Exportable compliance log.** Every add, block, and removal, downloadable.
- [ ] **57. Lead-level compliance state on the record.** The agent can see consent status, DNC status, and quiet-hours eligibility without leaving the lead.
- [ ] **58. Recording disclosure to both parties** before recording starts.
- [ ] **59. Signed, expiring URLs for recording access.**
- [ ] **60. Abandoned-call handling for multi-line.** Require a recorded callback message with press-1 opt-out before a multi-line campaign can launch, and track the abandon rate.

---

## PHASE 6 — CRM depth

- [ ] **61. Smart Lists.** "Save current filters" turns any filter combination into a named, reusable list pinned above the table.
- [ ] **62. Pipeline kanban board.** Drag-and-drop across stages: New Leads · Referrals · Called-No Pickup · Picked Up · Interested · Needs Follow-Up · Live Transfer · Appointment Booked · No Show · Sold · Chargeback · DNC · Not Interested · Bad Number. Filterable by campaign type.
- [ ] **63. Chargeback and DNC as pipeline stages,** not just flags — so recovery campaigns can trigger off stage movement.
- [ ] **64. Automatic source tags.** Aged · CSV Upload · Facebook · Fresh · Google · LinkedIn · Manual · Meta · Referral · TikTok · Vendor · Website · YouTube — system-managed, never agent-entered, so source reporting stays trustworthy.
- [ ] **65. Agency-shared tags.** Tags the owner defines that downline agents can apply but not edit.
- [ ] **66. Custom field definitions UI.** Define fields once to standardize data across leads (you have custom fields — this is the management screen).
- [ ] **67. "Urgent Tasks" work queue** on the contacts page — what needs doing right now, not just a list of everyone.
- [ ] **68. Bulk call from a filtered list.** Filter, then dial the whole set.
- [ ] **69. Contact export** with current filters applied.

---

## PHASE 7 — Dialer packaging

- [ ] **70. Voicemail drop recordings, assignable per campaign type.** Record once, reuse everywhere.
- [ ] **71. Automated callback text after a drop.**
- [ ] **72. Local-presence dialing.** Match the caller ID area code to the lead.
- [ ] **73. SIP softphone option.** Settings → Call Settings → Calling Method: Browser (WebRTC) *or* SIP (Zoiper, Bria). Cheap, and it wins the agents who hate browser calling.
- [ ] **74. Power dialer metrics page.** WTD/MTD/YTD: pickup rate defined as connected 45s+, pickup→close, pickup→appt, opt-out rate, conversion funnel, answer mix, pickups and closes by hour, avg talk time, total dials, abandoned rate.
- [ ] **75. Call recordings library.** Searchable, inbound/outbound filter, total and average duration, inline player.
- [ ] **76. Callback obligations and prospect context on-screen during the call.**
- [ ] **77. Multi-line dialing (2–3 concurrent).** Deferred by your own v1 decision — listed here so it isn't lost. This is where Orion's $129/mo add-on lives.

---

## PHASE 8 — Back office

- [ ] **78. Front Office / Back Office split.** A top-level toggle so producers and agency owners each get a coherent app instead of one crowded nav.
- [ ] **79. Per-tenant commission forwarding address.** `<token>@commissions.yourdomain.com` — agents forward carrier statements, you parse them. No OAuth scope problem, works at any carrier.
- [ ] **80. Statement file upload.** Drag-and-drop PDF / XLSX / XLS / CSV / HTML / ZIP, large-file support.
- [ ] **81. Template-free statement parsing.** AI reads any carrier format without per-carrier setup.
- [ ] **82. Ingestion pipeline status.** Live counters: Queued / Parsing / Persisting / Matching / Ingested / Failed, plus a recent-uploads list.
- [ ] **83. Agent identity sheet bulk load.** One row per agent with NPN and per-carrier writing numbers, auto-detected on upload.
- [ ] **84. Producer Codes screen.** NPN plus per-carrier writing codes, with **retroactive attribution** — saving a code back-fills any already-imported policies written under it.
- [x] **85. Book of Business browser.** Master policy list with status pills and BoB-authoritative dates. Shipped 2026-07-29 (Back Office Phase 3) — `docs/back-office-book-of-business.md`.
- [x] **86. "Approved Not Paid" as a first-class status.** Also add Surrendered and Claim to your status set. Shipped 2026-07-29 — ten statuses, ten tabs with counts; Denied and Withdrawn added too.
- [x] **87. Per-policy status-history timeline.** Every state change, when, and from what source. Shipped 2026-07-29 — `policy_status_history` (append-only, provenance-guarded), merged with the older `policy_events`.
- [x] **88. Product filter on the book.** Final expense · Term · IUL · Whole life · Annuity. Shipped 2026-07-29 — data-driven, and the carrier filter with it.
- [x] **89. Commission dashboard with defined metrics.** Total, Gross, Net ("what actually hits the bank"), Personal Sales, Override Income, Outstanding Debt — each with a plain-English definition on the card. Shipped 2026-07-29 (Back Office Phase 4) — `docs/back-office-commissions.md`.
- [x] **90. Outstanding debt tracking, drillable.** Carrier-reported balance at individual and rollup level. Shipped 2026-07-29 — per carrier, drillable to the lines, never range-filtered.
- [x] **91. Commission trend chart** with commission / personal / override above the line and debt below it. Shipped 2026-07-29 — hand-built SVG, empty weeks filled in.
- [x] **92. Personal vs override stacked mix.** Shipped 2026-07-29 — largest-remainder rounding, so the two integers always total 100.
- [x] **93. Reconciliation triage queues.** Policy Match Review, Unlinked Policies, stuck uploads. Priority high/medium/low, status filter, match-% sort, needs-review flag. Shipped 2026-07-29 (Back Office Phase 6) — `docs/back-office-reconciliation.md`. `review_queue` was deliberately left to the carrier-mail pipeline; `commission_rows` already was the queue.
- [x] **94. Persistency at 4 / 9 / 13 / 25-month windows.** Shipped 2026-07-29 (Back Office Phase 5) — `docs/back-office-persistency.md`.
- [x] **95. Flat vs weighted persistency toggle.** Shipped 2026-07-29 — weighted is by annualised premium, which is what carriers measure.
- [x] **96. Policy persistency vs agent persistency views.** Shipped 2026-07-29 — the agent view is a SECURITY DEFINER aggregate so a leader sees rates, never a client list.
- [x] **97. Persistency by lead source.** Shipped 2026-07-29 — joined through `soldLeadId`/`leadSource`; unlinked policies are counted and named, never bucketed.
- [x] **98. Persistency outlier spotlighting** with green ≥85% / yellow 70–84% / red <70% bands. Shipped 2026-07-29 — fires only when materially worse, and never accuses a thin cohort.
- [ ] **99. Team hierarchy (Team Tree).** Personal and rollup production, volume %, MTD. Gates downline reporting.
- [x] **100. Rollup debt by downline.** Shipped 2026-07-29 — `get_downline_commission_rollup`, SECURITY DEFINER with no parameter naming a leader, aggregates only.
- [ ] **101. Comp ladder UI.** Tier progression, progress to the next bump, carrier-specific structures — built on top of your existing 45-carrier `carrier_bonuses.json`, which is better data than Orion's.
- [ ] **102. Bonus progress tracking.** Fast Start, Producer Club, and carrier bonus thresholds with current position.
- [x] **103. Appointed carriers list,** derived from ingested statements. Shipped 2026-07-29 (Back Office Phase 7) — `docs/back-office-close-the-loop.md`. Read-only; a carrier is listed because it paid, not because it was typed in.
- [ ] **104. Natural-language back-office query.** "Who is behind on Carrier A?" against commission and policy data.
- [ ] **105. Public back-office API with per-tenant keys.** Feature-flagged. Longer-term, but it's where they're heading.

---

## PHASE 9 — Account, billing, and setup

- [ ] **106. Seat management with "billed to."** Let a team leader pay for a downline agent's seat. Table: seat / status / per-seat price / billed to / next bill / actions. Your current model makes downline agents buy their own — absorbing the cost closes bigger deals.
- [ ] **107. Wallet auto-recharge rule.** "Recharge $X when balance drops below $Y," agent-configurable.
- [ ] **108. Quick top-up buttons.** $50 / $100 / $250.
- [ ] **109. Welcome credit on signup,** visible as a line item in transaction history.
- [ ] **110. Usage summary tab.** What the wallet was actually spent on, by category.
- [ ] **111. Add-on SKU model.** Sell the multi-line dialer (or another module) as a separate subscription, surfaced at the moment of need rather than only on the pricing page.
- [ ] **112. Two-factor authentication** via emailed code, required for admin actions.
- [ ] **113. Verified email change.** Code to the current address before the change takes effect.
- [ ] **114. Verified password change.** Same pattern.
- [ ] **115. Agent SMS notifications.** Live transfer incoming · appointment reminder 30 min prior · verification codes · payment alerts. With a Test SMS button and STOP-to-unsubscribe copy.
- [ ] **116. Agency default theme.** Owner sets the org-wide default; agents can override to dark / light / system.
- [ ] **117. Custom AI agent name.** The name the voice and SMS AI introduces itself as, per agent.
- [ ] **118. Company/agency name merge field** used in AI scripts — "…with {company}'s office."
- [ ] **119. Working hours per day of week,** 30-minute increments, with "Unavailable" for any day.
- [ ] **120. Timezone selector including Arizona (MST, no DST).**
- [ ] **121. Multi-calendar conflict checking.** Connect several calendars; the AI checks all of them before offering a time.
- [ ] **122. Calendar KPI strip.** Today / This Month / Completed / No Show.
- [ ] **123. Activation checklist for new accounts.** Five steps, persistent on the dashboard, resumable and restartable: configure call readiness → complete Trust Center → add first lead → activate a campaign → start first outreach.
- [ ] **124. Contextual video guides per screen.** A "Watch video" link on each page pointing at a short clip for that exact feature.
- [ ] **125. In-app AI assistant widget.** Floating, on every page, that can *take actions* — send an SMS, send a bulk SMS, analyze the pipeline, answer a support question — not just chat.
- [ ] **126. Morning briefing.** You already send daily/weekly/monthly digest emails; add the in-app version so it's waiting when the agent opens the app.

---

## Requested during build — not from the Orion gap analysis

- [ ] **129. Choose the texting number at purchase time.** When an agent buys a number, let them decide *then* whether it becomes their texting (10DLC campaign) number, instead of only afterward. Requested by Jace 2026-07-29.

  **What exists today.** `telnyx-buy-number` already auto-assigns a number bought *after* the campaign is approved, and `a2p-status-poll` auto-assigns after approval when the agent owns **exactly one** active number. Beyond that, the Settings → Texting wizard has a picker for the multi-number case, and it covers it correctly — this is an ergonomics change, not a gap in capability. Nothing is broken without it.

  **Why it's worth doing.** The picker is a second, later, separate screen. An agent buying their second number has already formed the intent ("this one is for texting") at the moment of purchase, and today has to go find another screen to express it. It also removes the only case where the system deliberately refuses to choose: with two numbers and no stated preference, auto-assign correctly declines rather than picking someone's public texting identity for them. A purchase-time answer means that ambiguity never arises.

  **Shape.** A checkbox or radio in the buy-number flow ("Use this as my texting number"), stored with the purchase and consumed by the existing `assignAgentNumberToCampaign` path — no new assignment logic. Default it OFF when the agent already has an assigned texting number; default ON when they have none.

  **Constraints that already exist and must be respected.** Assignment cannot happen until the campaign is genuinely assignable (see item 130) — so at purchase time this records an *intent*, and the existing poller acts on it later. A sole proprietor gets exactly one texting number ever (Telnyx hard limit), so for them the control is a swap, not an add, and needs to say so.

- [ ] **130. Don't strand a number on a transient assignment refusal.** Partially fixed 2026-07-29 (`isTransientAssignmentError` in `_shared/a2p-assign.ts`); the rest is UI. Telnyx refuses assignment with `400 code 10036` while a campaign is `TCR_ACCEPTED` but not yet carrier-registered, which is a *wait*, not a failure. The wizard should say "waiting on carrier registration" with no Retry button, rather than presenting a failure the agent cannot act on. See `docs/a2p-campaign-draft.md` § "TCR_ACCEPTED is not assignable".

---

## Optional / decide later

- [ ] **127. Affiliate or referral program.** Normal SaaS growth lever, but it sits closest to the energy you said you don't want. Your call.
- [ ] **128. AI-run Meta ad campaigns.** Orion's is in private beta: campaign management, creative gallery, A/B tests, an AI decision log, and per-agent performance. Ad spend → lead → AI dialer → booked appointment, closed loop. Not urgent, but it's where the category is going.

---

## Already yours — don't rebuild, and don't lose them

Live multi-carrier rate quoting · AI Underwriter · 45-carrier bonus database · Gmail carrier-email parser (underwriting status, not just commissions) · FFL comp math · native iOS/Android apps · AI voice gender selection · transparent at-cost usage pricing.

Orion has none of these.
