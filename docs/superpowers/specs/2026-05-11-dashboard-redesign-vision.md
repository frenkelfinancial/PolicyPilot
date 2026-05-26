# Dashboard Redesign Vision — Life Insurance Agent CRM

> **Source:** Pasted by Tanner on 2026-05-11. This is the canonical vision document
> for the multi-phase summary-tab rebuild. Build-ready plans for each phase live in
> `docs/superpowers/plans/2026-05-11-dashboard-redesign-phase-*.md`.

## Guiding Principles

- **Every widget answers "so what do I do?"** No orphan numbers. If a metric can't
  drive an action or a feeling, it doesn't earn space.
- **Stickiness comes from momentum, not data density.** Streaks, progress
  animations, micro-wins, and "next action" prompts beat another KPI tile.
- **Empty states are features.** A new agent or a slow day should feel
  encouraging, not punishing.
- **The dashboard is the agent's morning ritual.** Top-of-page = what to do
  right now. Mid-page = the pipeline. Bottom = trends and reflection.
- **Visually stimulating ≠ cluttered.** Motion, color, and depth should reward
  attention, not compete for it.

---

## Phase 0 — Foundation (do this first)

Before any new widgets, lock in the design system so everything ships consistent.

### 0.1 Design tokens

- Define a semantic color palette: `success`, `warning`, `danger`, `info`,
  `neutral`, plus a **momentum accent** (the "you're on a roll" color — a
  saturated emerald or electric blue).
- Typography scale with a display weight for hero numbers (the $1,200 style
  already in use — keep this, it's the strongest thing on the page).
- Spacing scale, radius scale, elevation scale (3 levels: flat card, hover, modal).
- Motion tokens: `duration-fast` (150ms), `duration-base` (250ms),
  `duration-slow` (400ms), `ease-out-expo` for entrances.

### 0.2 Component primitives

- **`<StatCard>`** — variant prop for `default | trend | sparkline | progress | alert`
- **`<ProgressRing>`** — the donut already in use, reusable with size/thickness/color variants
- **`<Sparkline>`** — already on AP Written; extract and reuse
- **`<TrendBadge>`** — replaces "▲ new", "− flat", "FORWARD" with consistent semantic styling
- **`<ActionItem>`** — list row with icon, title, meta, CTA
- **`<EmptyState>`** — illustration + headline + CTA, never a bare zero

### 0.3 Data layer

Establish these as canonical sources so every widget pulls from one place:

- **`policies`** — status, stage, AP, carrier, product, dates, client
- **`activities`** — calls, contacts, appointments, quotes (agent inputs)
- **`goals`** — multi-dimensional: AP, apps, lives, persistency
- **`chargebacks`** — advanced commission, earn-down schedule
- **`events`** — free-look expirations, anniversaries, UW deadlines, birthdays

**Acceptance:** A new widget can be built in <1 day because primitives and data are ready.

---

## Phase 1 — The Hero Section (top-of-page rebuild)

Replace the current "Monthly AP Goal + Today/Week/Month tiles" block with a two-column hero.

### 1.1 Left: Smart Goal Hub

Keep the donut ring but evolve it:

- **Multi-ring:** outer ring = AP goal, inner ring = apps goal, center = a single
  **Pulse Score** (0–100, composite of pace, activity, pipeline health). The
  score is the feeling, the rings are the proof.
- **Adaptive pacing:** replace `$2,323/day` with "Write $X this week to get back
  on pace" — weekday-weighted, removes weekend guilt.
- **Stretch + committed:** show two targets ("Committed $50K · Stretch $65K")
  with the ring filling toward committed first.
- **Hover/tap reveals breakdown** (current pace, projected end, gap, what would
  change projection by 20%).

### 1.2 Right: Action Hub (the new centerpiece)

A prioritized, scrollable list — **the single most important addition**. Sections:

- 🔴 **Urgent** (free-look expires today, UW requirement overdue)
- 🟡 **Today** (callbacks scheduled, exams to confirm, apps to submit)
- 🟢 **Opportunities** (cold leads to revive, anniversaries this week, cross-sell prompts)

Each row: icon, client name, action, time/deadline, one-tap CTA. Tapping logs
the action and the row collapses with a micro-celebration (subtle confetti or a
checkmark sweep). **This is the stickiness engine — agents open the dashboard for this list.**

**Acceptance:** Agent can identify their top 3 actions for the day in <5 seconds without scrolling.

---

## Phase 2 — The Pipeline Funnel (mid-page centerpiece)

Full-width widget replacing the current Today/Week/Month tile row.

### 2.1 Visual funnel

Horizontal funnel: `Submitted → In UW → Approved → Issued → Placed → Paid`. Each
segment shows count + AP. Width tapers to show drop-off.

### 2.2 Aging overlay

Each segment color-tinted by average days-in-stage vs. benchmark:

- 🟢 Green: faster than benchmark
- 🟡 Yellow: at benchmark
- 🔴 Red: stalled

### 2.3 Drill-down

Click any segment → slide-out panel listing the policies in that stage with
last-action date and a "Nudge carrier" / "Contact client" CTA.

### 2.4 Placement ratio

Top-right of the widget: `Placement: 73% · Target 80%` with a small trend arrow.

**Acceptance:** Agent can see exactly where money is stuck and act on it in two clicks.

---

## Phase 3 — Income Reality Row

Three-card row replacing the bottom KPI strip. **Theme:** show the full income
picture, not just gross writing.

### 3.1 Net Commission Forecast

- Big number: projected net commission this month (advanced − chargeback exposure)
- Below: stacked bar showing earned vs. exposed
- Trend vs. last month

### 3.2 Chargeback Exposure

- Rolling 9–12 month advanced-not-yet-earned
- Earn-down timeline (mini area chart): when does this exposure roll off?
- At-risk policies count with CTA to view

### 3.3 Renewal/As-Earned Forecast

- Trailing income from in-force book
- 12-month forward projection if persistency holds
- The "you're building something" widget — visualizes the long tail

**Acceptance:** Agent understands their true financial position, not just gross AP.

---

## Phase 4 — Persistency & Book Health

Two-card row.

### 4.1 Persistency Dashboard

- 13-month and 25-month persistency rates with industry benchmark line
- Free-look watch list (policies in window, days remaining, countdown badges)
- NSF / missed-draft alerts

### 4.2 Book Composition

- Donut: product mix (Term/IUL/WL/FE/Annuity)
- Side metrics: avg face, avg AP per app, avg commission per app, top carrier concentration %
- Concentration warning if any carrier > 50%

**Acceptance:** Agent can spot persistency risk before it becomes a chargeback.

---

## Phase 5 — Activity & Momentum

Two-card row — **this is where stickiness lives**.

### 5.1 Activity Pulse

- Daily/weekly toggle
- `Dials → Contacts → Appointments → Apps → Issued` as a conversion funnel
- Each ratio with a target line ("Your dial→contact is 18%, target 25%")
- Heatmap calendar of activity (GitHub-style) — agents love streak visuals

### 5.2 Streaks & Records

- Current submission streak (days)
- Longest streak (personal best)
- This month vs. best month
- Achievements/badges row: "10-app month", "100% persistency Q1", "5 carriers active"
- Subtle gamification — opt-in, never childish

**Acceptance:** Agent feels rewarded for showing up, even on slow weeks.

---

## Phase 6 — Bonus Tier Intelligence (expand existing widget)

Replace the current Projected Bonus card with a richer version:

- Per-carrier bonus structure visualized as a ladder
- Current position on the ladder
- Gap-to-next-tier with translation: "Write $2,400 more in VP AP this month →
  unlocks Gold tier → +$1,800 bonus"
- "Best bang for your buck" prompt: which carrier's next tier is closest and worth pursuing?

**Acceptance:** Agent knows exactly which carrier to push this month to maximize bonus.

---

## Phase 7 — Polish, Motion, and Stickiness Layer

This phase is what makes it feel inspiring rather than just informative.

### 7.1 Motion design

- Numbers count up on load (not from 0 — from last known value, so it feels like progress)
- Ring fills animate on data refresh
- Action items collapse with a satisfying micro-animation when completed
- Sparklines draw left-to-right on first paint

### 7.2 Personalization

- Greeting that adapts: "Good morning, [Name] — you're 2 apps from your weekly streak record"
- Configurable widget order (drag to reorder)
- Light/dark theme already exists — make sure new components support both

### 7.3 Notifications & nudges

- Browser/push notifications for: free-look expiring tomorrow, UW requirement
  overdue, hit a streak milestone
- Daily 8am summary: "3 actions today, 2 urgent"
- End-of-week recap: wins, misses, focus for next week

### 7.4 The "moment" moments

- When an app gets submitted: brief celebration overlay
- When a policy places: bigger celebration + streak update
- When a goal hits: full-screen takeover (skippable, but memorable)
- When a streak breaks: empathetic, not punishing ("3 days off — let's start a new one")

**Acceptance:** Agents describe the dashboard as "fun to open."

---

## Suggested Build Order

1. **Phase 0 (foundation)** — 2–3 days, unblocks everything
2. **Phase 1.2 Action Hub** — ship standalone first, biggest stickiness win
3. **Phase 2 Pipeline Funnel** — highest-leverage business value
4. **Phase 1.1 Smart Goal Hub** — replaces existing widget
5. **Phase 3 Income Reality** — financial clarity
6. **Phase 5 Activity & Streaks** — stickiness reinforcement
7. **Phase 4 Persistency** — risk prevention
8. **Phase 6 Bonus Intelligence** — optimization layer
9. **Phase 7 Polish** — ongoing, but concentrated push at the end

---

## Cross-Cutting Build Rules

- Build each widget as a self-contained component with its own data hook so
  they can be reordered/toggled.
- Every widget must have a designed empty state, loading state, and error state.
- Mobile responsive from day one — agents check this on phones between appointments.
- All numbers animate on change, never just snap.
- Use semantic color tokens, never hardcoded hex.
- Accessibility: keyboard nav, ARIA labels, color contrast AA minimum.
