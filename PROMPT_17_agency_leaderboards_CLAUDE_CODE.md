# PROMPT 17 — Agency Leaderboards, Records & Achievements

**Mode: fully autonomous.** You are Claude Code working in the ProducerStack repo. You will take this feature from zero to live, deployed, and functional — code, database migrations, cron jobs, frontend, testing, and deployment — without Jace's assistance, with ONE exception: after your discovery phase (Phase 0), you may ask him a single batched set of clarifying questions. After his answers, you build to completion. Do not stop halfway and hand back a plan. "Done" is defined in Section 9 — every item must pass.

## 0. Repo ground rules — these override everything below where they conflict

- **Read first, before any code:** `CLAUDE.md`, `docs/schema-state.md` (the ledger and its rules), `docs/agency-team-screen.md`, `docs/lead-distribution.md`, `PRODUCERSTACK_BUILD_CHECKLIST.md`.
- **Do not touch anything A2P/campaign- or Resend-inbound-related** — both are in documented in-flight states owned by other work.
- **Schema per ledger rules:** idempotent, additive, transaction-wrapped `.sql` files applied via `supabase db query --linked -f`, audit before/after, `docs/schema-state.md` updated in the same commit. No `DROP` of tables/columns/data, nothing in `auth.*`/`storage.*`. Never `db push`.
- **Edge functions (if any):** deploy individually, never a batch; re-verify every function's `verify_jwt` flag with `supabase functions list` after each deploy.
- **Frontend:** all UI in `app.html` following existing modal/toast/naming patterns; **sync `www/` via the prebuild** — stale `www/` shipped a broken deploy this week; do not repeat it. Push to `main` = deploy (GitHub Pages).
- **Full test suite green + `npm run check` clean before every push.** The suite currently has 663+ tests; none may break.
- **Nothing that costs money. Stop and report instead.**
- **All synthetic/test data and throwaway accounts are deleted at the end, with a verified zero-residue sweep** (row counts back to baseline). This is production; the seeded test agency does not stay behind.
- **Single source of truth for numbers:** the Agency tab's team data flows through one engine (`get_team_summary` + one period engine, per `docs/agency-team-screen.md`). Leaderboard math must reuse or extend that engine — never a parallel second computation of AP/dials that can drift from the team screen. The repo has structural tests asserting one call site; respect and extend them.

## 1. Context

ProducerStack is a SaaS CRM for life insurance agents. Static HTML/JS frontend (`app.html`) on GitHub Pages; Supabase backend (Postgres with RLS, Edge Functions, pg_cron). Relevant existing features: policy tracker (with per-policy status-history timeline, ten statuses including Approved Not Paid / Lapsed / Chargeback), Telnyx power dialer (`calls`), lead management (`leads`), unified activity feed, Back Office commission ingestion, and the **Agency tab — which is now the merged leader home screen** (period selector, team table, at-risk flags, roster management, per-agent drill-down profile with Send Leads). Agency membership is modeled by `agency_invites` (leader ↔ downline, accepted status), flat hierarchy, plus an agent-initiated request-to-join flow. **Non-leader agency members currently see only an invitee view on the Agency tab** — this feature adds their first real member-facing surface there.

You are building: competitive-but-classy leaderboards, personal & agency records, and an achievement system. The goal is goal-oriented motivation — beating your own records and climbing a tasteful board — NOT hustle-bro MLM energy. That distinction drives every design decision below.

## 2. Locked product decisions — do not re-ask these

- **Scope: agency-only.** A leaderboard exists per agency (a Team Leader and their accepted downline). Solo agents with no agency get personal records + achievements only — no board, presented gracefully, not as a missing feature.
- **All tiers** get records + achievements. Leaderboards render for anyone who belongs to an agency, regardless of tier.
- **Peer visibility is new and must be handled deliberately.** Today a downline consents to sharing performance data with their LEADER only. Boards show production to PEERS. Therefore: (a) board data is visible to all accepted members of the agency; (b) every agent gets a "Hide me from public boards" toggle — hidden agents drop off all public boards and record feeds but still see the boards and keep private records/achievements; (c) the first time an agent's data would appear on a board, the UI notes plainly that agency members see each other's standings and where the toggle lives. No dark patterns; the toggle is easy to find.
- **Data source for sales/AP: the policy tracker**, status-aware (submitted vs placed vs lapsed/chargeback), via the single engine per Section 0.
- **Top 10 only, publicly.** The board never renders below rank 10. A viewer outside the top 10 sees their own rank privately, pinned below the board ("You're #14 — $840 AP from the top 10"), visible only to them. Never show a full bottom-to-top ranking.
- **No rookie board.**
- **Tone: classy competitive.** Country-club scoreboard, not boiler room. No fire emojis, no "grind/crush/hustle" copy, no public shaming, no leaderboard emails. See Section 7.

## 3. Phase 0 — Discovery, then ONE batch of questions

Before writing any code:

- Map the Agency tab as it exists after the team-screen merge: the period engine, `get_team_summary`, the drill-down profile, the activity-feed write/render paths, auth/session handling.
- Map the schema from the ledger and live audits: policy tracker table(s) and the ten statuses, AP field, `calls` (duration/timestamp/agent; connected vs ring time if distinguishable), appointments/calendar data (set vs kept signal, if any), `leads` timestamps, `agents`, `agency_invites`.
- Confirm which Section 4 metrics the data actually supports. If a metric's underlying data doesn't exist (e.g., no "appointment kept" signal), do NOT silently build a junk stat — put it in the question batch with a proposed fallback.
- **Timestamp honesty check:** time-of-day and day-of-week badges (Early Bird, Closer, Weekend Warrior) and "policies written in period" depend on when a sale actually happened vs when it was typed into the CRM. Determine which timestamps exist (sale/effective date vs row `created_at`). If only entry-time exists, flag it in the question batch with a recommendation rather than shipping badges that reward late-night data entry.

Then ask Jace one batched set of questions covering only what discovery couldn't resolve — each with a recommended answer so he can reply fast (he can answer "all defaults"). Expected examples: which statuses count as "submitted" vs "placed"; where chargebacks/lapses are recorded for net AP; appointment kept signal; timestamp policy for time-based badges; agency timezone default (America/Chicago). After his answers, build straight through to done with no further questions.

## 4. Feature spec

### 4.1 Core leaderboards (Agency tab)

Timeframe toggle on every board: **This Week / This Month / This Quarter / All-Time.** Weeks run Monday–Sunday in the agency's timezone. Period boundaries DST-aware — reuse the existing period engine; do not write a second one.

Build ALL of these boards:

| # | Board | Definition | Integrity rule |
|---|---|---|---|
| 1 | **Most AP** (default) | Sum of AP on policies written in period | Default = submitted AP; toggle for Placed; subtract chargebacks/lapses where status data exists (net AP) |
| 2 | Most Policies Sold | Count of policies written in period | Same status handling as AP |
| 3 | Most Dials | Outbound dial count from `calls` | — |
| 4 | Most Talk Time | Total connected call duration | Connected time only, not ring time, if distinguishable |
| 5 | Most Appointments Set | Appointments created in period | "Kept" column only if the data supports it |
| 6 | Highest Close Rate | Policies ÷ dials (or ÷ appointments — pick the more reliable denominator from discovery) | Minimum 50 dials in period to qualify |
| 7 | Best Placement Rate | Placed ÷ submitted | Minimum 5 policies in period to qualify |
| 8 | AP per Dial | Net AP ÷ dials | Minimum 50 dials in period to qualify |
| 9 | Most Improved | Largest % AP gain vs the agent's own previous equivalent period | Requires prior-period baseline ≥ $500 so 0→anything can't win; not available on All-Time |

Display rules: rank, name, avatar/initials, metric value. Ranks 1–3 get subtle gold/silver/bronze accents (thin border or small medal glyph — not giant trophies). Tabular numerals. Ties share a rank. Below-top-10 viewers get the private pinned own-rank row. Hidden agents (opt-out toggle) appear on no public board.

### 4.2 Records

**Personal records** (every user, all tiers): best single day (AP and policy count); best week; best month; biggest single policy; longest sales streak (consecutive business days with ≥1 sale — weekend sales extend a streak, weekend gaps don't break it); fastest lead-to-sale (lead created → policy written).

**Agency records** (per agency): best single-day agency AP (team combined); best single-day AP by one agent; best week / best month agency AP; biggest policy ever written; most policies in one day by a single agent; fastest lead-to-sale in agency history.

Each record row shows holder + date set ("Set Jul 2026 — Marcus T."). Personal records show progress nudges where natural ("3 policies from your best month").

**Record-broken moments are the emotional core — build them well:** on a personal or agency record break, write an event to the existing activity feed ("New agency record — Marcus wrote $4,200 AP in one day"); show a dismissible one-line banner on the Agency tab for agency records (brand palette, auto-expires 48h); the record row gets a quiet "NEW" marker for 7 days. Hidden agents generate no public record events (their personal records still update privately).

### 4.3 Achievements — build ALL of these

One-time unlocks with timestamps. Gallery on the Agency tab (and/or profile, per existing UI conventions): earned badges in color, unearned greyed with visible criteria so they function as goals. Unlock = subtle toast + activity feed entry.

| Badge | Criteria |
|---|---|
| First Sale | First policy ever written |
| First $1k AP Day | ≥ $1,000 AP in one day |
| Hat Trick | 3 policies in one day |
| Producer's Club — 10/25/50/100/250 | Lifetime policy count (5 tiers) |
| $50k / $100k / $250k Club | Lifetime AP (3 tiers) |
| 5-Day Streak | Sale on 5 consecutive business days |
| 30-Day Consistency | Dials every business day for 30 days |
| Early Bird | Policy before 10:00 AM local (subject to the Phase-0 timestamp decision) |
| Closer | Policy after 7:00 PM local (same caveat) |
| Weekend Warrior | Policy on a Saturday or Sunday (same caveat) |
| Comeback | Policy after a 10+ day gap (requires ≥1 prior sale) |
| Iron Dialer | 500 dials in one week |
| Marathon | 5+ hours talk time in one day |
| Placed & Paid | 10 consecutive policies reaching placed with no fall-off |

**Retroactive backfill** on launch from historical data so existing users don't start at zero — backfilled unlocks carry historical dates and are feed-silent (suppress feed events during backfill).

### 4.4 Seasons & Hall of Fame

At each month and quarter close, snapshot final standings and archive the #1 finisher per board. A simple per-agency Hall of Fame lists past winners (period, board, name, value).

### 4.5 Explicitly OUT of scope (Phase 2 — do not build)

Team goal progress bar; head-to-head challenges; platform-wide/cross-agency boards; any email or push notifications. Leave short `// PHASE 2` comments at natural extension points. Do not scaffold.

## 5. Architecture guidance

Adapt to what discovery finds, but the intended shape:

- Live periods computed on read via SECURITY DEFINER RPCs that verify agency membership — extending the existing team-summary engine, not duplicating it. No stale caches for the live board.
- Closed periods snapshotted by a pg_cron job at week/month/quarter rollover into `leaderboard_snapshots` — powering Hall of Fame and the Most Improved baseline, and freezing history against later edits. Follow the repo's existing pg_cron + secret conventions.
- Suggested tables: `achievement_definitions` (seeded), `agent_achievements`, `agent_records`, `agency_records`, `leaderboard_snapshots`, plus the board-visibility toggle on the appropriate existing table. Follow existing naming.
- Record/achievement evaluation on policy/call insert-or-update (trigger or scheduled function, whichever fits the repo) — **idempotent; re-running never double-awards.** Status changes (lapse/chargeback) recompute affected open periods; closed snapshots stay frozen.
- **RLS on every new table.** Members read only their own agency's boards/records; solo agents only their own rows; hidden agents excluded from peer-visible reads at the RPC level (not just the UI). Zero cross-agency leakage — hard security requirement, tested explicitly.
- All period math timezone- and DST-aware via the existing engine.
- Frontend: existing static HTML/JS + Supabase client patterns exactly. No frameworks, no build-step additions. Match the Agency tab's visual language.

## 6. Anti-gaming & integrity rules

- Net AP subtracts chargebacks/lapses on status change; recompute open periods only.
- Rate boards always enforce minimum-volume thresholds; below-threshold agents don't appear, with a one-line explainer ("Qualify with 50+ dials this period").
- Manually entered policies count (trust the agent), but store an entry-source field for a future audit view — `// PHASE 2` hook.
- Most Improved requires the prior-period baseline. No divide-by-near-zero winners.

## 7. Design & tone guide — "classy competitive"

Existing brand palette, generous whitespace, clean tables, tabular numerals, subtle 150–200ms transitions. Gold/silver/bronze as thin accents on ranks 1–3 only. Copy understated and factual — good: "New agency record," "Personal best," "Top Producer — July"; bad: "🔥 CRUSHING IT," "Beast mode," "Don't get left behind," anything with 🚀💪🔥. Celebrate up, never punish down: records, unlocks, and top-10 placements are surfaced; nobody's low rank is ever shown to anyone else. In-app only — no emails, no push. Empty states matter: a brand-new agency sees "Records are waiting to be set" with the greyed achievement gallery as the goal map, never a blank page.

## 8. Build order

1. Phase 0 discovery → one batched question round → answers.
2. Migrations (tables, RPCs, RLS, seed data) — applied per ledger rules, ledger updated.
3. Backfill script (feed-silent), run and spot-checked.
4. pg_cron rollover/snapshot jobs.
5. Frontend: boards → records → achievements gallery → Hall of Fame → banners/toasts/feed events → visibility toggle + first-appearance notice. `www/` synced.
6. Testing (Section 9), then push to `main` and verify live.

Commit in logical increments. Do not break existing features — policy tracker, dialer, activity feed, and the entire merged Agency screen (team table, at-risk, roster, drill-down, Send Leads) get touched or read; regression-check each.

## 9. Definition of Done — every item must pass before reporting completion

- [ ] Throwaway test agency (11+ synthetic agents with policies/dials/appointments) seeded; math hand-verified on all 9 boards against fixtures — thresholds, ties, net-AP subtraction, Most Improved baseline.
- [ ] RLS verified with two throwaway users in different agencies: cross-agency reads return nothing. Hidden-agent toggle verified: agent absent from every public board and feed event, still sees boards, personal records intact.
- [ ] Period rollover simulated: snapshot created, Hall of Fame populated, Most Improved baseline correct next period.
- [ ] Retroactive backfill run against real production data and spot-checked; zero activity-feed flood; backfill re-run is a no-op (idempotency proven).
- [ ] Record-broken flow end to end: test insert breaks a record → feed event + banner + NEW marker.
- [ ] Achievement unlock flow end to end: toast + feed + gallery.
- [ ] Top-10 cutoff and private own-rank row verified with the 11+-agent test agency, through a headless browser against the real UI.
- [ ] Desktop + mobile widths; no console errors.
- [ ] Regression: policy tracker, dialer, activity feed, and every pre-existing Agency screen function.
- [ ] Full test suite green, `npm run check` clean, `www/` synced, migrations in the ledger, pushed to `main`, feature confirmed live on the production site via a throwaway account.
- [ ] **All throwaway accounts and synthetic data deleted; residue sweep verified zero; production counts back to baseline.**
- [ ] Final summary to Jace: what shipped, schema added, cron jobs created, Phase-0 decisions and question answers applied, anything deferred to Phase 2, and any data-quality caveats found during discovery.
