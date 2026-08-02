# The Agency team screen — one merged leader home

Built 2026-07-29 ("Phase B"). Merges the two team surfaces — the Agency tab
and the Team table buried at the foot of Summary — into one screen with one
data source.

**Read this before touching anything named `team*`, `tm*`, `_ag*`, or
`get_team_summary`.**

Companion docs: `docs/lead-distribution.md` (the Send Leads flow this screen
hosts), `docs/schema-state.md` (the apply record).

---

## Why it exists

The Agency tab and the Summary Team table were two independent queries
(`get_agency_stats` and `get_team_summary`) with two different status filters
and two different notions of a period. That is not a stylistic problem: it
produced an **8,610× AP overstatement** on the Agency tab, fixed in
`20260736`, which was invisible only because `agency_invites` happened to be
empty at the time. The first accepted invite would have shown it.

So the organising principle of this build is not the layout. It is:

> **One query, one period engine, one renderer. Two views.**

Three invariants enforce it, and `test/team-roster.test.mjs` asserts all three
against `app.html` as source text:

| Invariant | Enforced by |
|---|---|
| exactly ONE `sb.rpc('get_team_summary')` call site | `loadTeamRoster()` |
| exactly ONE period engine | `teamPeriodRange()` |
| exactly ONE table renderer | `teamTableHTML()` |

`get_agency_stats` is **no longer called from anywhere**. It still exists in
the database (nothing was dropped) but the app does not consult it. A test
asserts zero call sites: reintroducing one recreates the bug class.

---

## The screen

Under the existing **Agency** nav item. The name did not change.

```
My Agency · 3 connected agents · agency code SMITH2024      [week|month|quarter|lifetime]
┌ AT RISK — 2 agents slipping ─────────────────────────────────────────────┐
│ Dana Reyes — AP down 47% vs last month, no dials in 9 days               │
└──────────────────────────────────────────────────────────────────────────┘
┌ AP — you vs team avg   Dials — you vs team avg   Call-to-close — you vs team ┐
└──────────────────────────────────────────────────────────────────────────┘
┌ Agent | Plan | Joined | Last activity | AP | % of team | Sales | Dials | Call time | C2C ┐
│ … one row per member, sortable, click a row to open that agent …          │
│ Team total …                                                              │
└──────────────────────────────────────────────────────────────────────────┘
Downline rows show production and calling totals only — no client names…
┌ Contract levels ─────────────┐┌ Manage roster ───────────────────────────┐
│ …the level editor, one row   ││ agency name & code · invite an agent ·   │
│  per downline agent…         ││ pending / declined · ▸ Connected Agents  │
└──────────────────────────────┘└──────────────────────────────────────────┘
```

- **Period selector** — this week / this month / this quarter / lifetime.
  Default **this month**. Persisted in `localStorage.pp_team_period`, shared
  with the Summary mini-card so the two cannot show different windows.
- **Sortable table**, ten columns, with a totals row. Sorting is client-side
  over the already-fetched view, so it never re-queries.
- **Row click** opens that agent's profile (below).
- **Contract levels and Manage roster share one row**, half the width each,
  in `.ag-split` (a two-column grid that collapses to one column under
  1100px). They are the same job — set what an agent is contracted at, and
  see who is on the team — and stacked, the roster started below the fold.
- **Manage roster is always open.** It was a `<details>` panel collapsed
  behind a Show link; everything on it except the agent list is an action the
  owner came here to take, and one of them (the agency code) is the thing a
  new leader is looking for. It carries agency name and code (with Copy and
  the 30%-discount copy), email invites, and pending/declined management with
  Remove-with-Stripe-unlink.
- **Connected Agents is the one thing left that folds** — a `<details>` inside
  the roster card, collapsed by default, because it is a list to read rather
  than an action to take and it is the part that grows without bound. Its open
  state survives the re-render that every roster action triggers
  (`_agConnectedOpen`).
- The **admin-only discount-code card** is unchanged and still at the top.

### Order of the page

Numbers first, admin last. A leader reads their team's production daily and
edits the roster monthly. This is why the agency-code card moved from the top
of the page into the roster panel.

---

## The AT-RISK flag

**In-app only. Nothing is emailed to anyone.** It is a prompt to phone
somebody, not a scoreboard.

An agent is flagged when **both** halves are true:

```js
const AT_RISK_AP_DROP_PCT     = 0.40;  // AP down >= 40% this month vs last
const AT_RISK_NO_DIAL_DAYS    = 7;     // AND no dial for >= 7 days
const AT_RISK_MIN_PRIOR_AP    = 1;     // you cannot fall from zero
const AT_RISK_MIN_TENURE_DAYS = 30;    // a new joiner has no month to fall from
```

Chosen by Jace on 2026-07-29 from three offered bands (25%/5d, 40%/7d,
50%/10d).

### Why these numbers

- **40%** — a 25% swing is one ordinary policy in a small book, so it fires on
  noise; 50% only catches an agent who has already effectively stopped. 40% is
  the point where a month is meaningfully worse rather than merely quieter.
- **7 days** — a week with no dial at all is not a slow week, it is an absence.
  Five days flags anyone who took a holiday; ten days means you find out in the
  third week of a problem that started in the first.
- **Both halves required** — production alone is a slow month, and silence
  alone is a holiday. Together they are the pattern worth a phone call.
- **The two guards are not decoration.** Without `MIN_PRIOR_AP`, every agent
  who wrote nothing in either month reads as "down 100%". Without
  `MIN_TENURE_DAYS`, every new joiner is flagged in their first weeks, when
  they have no prior month at all — the flag would fire hardest on exactly the
  people it should not.

### What it reads

Always **this calendar month vs last calendar month**, whatever period the
selector is on. That is deliberate: the badge means one fixed thing and does
not blink on and off as a leader clicks between "this week" and "this
quarter". A test asserts the at-risk window is identical across all four
period keys.

### Two consequences to know about

1. **The leader's own row is never badged.** You do not flag yourself on your
   own dashboard.
2. **"Never dialled at all" counts as quiet.** Team dials come from the `calls`
   table only, so an agent who works entirely off-platform reads as quiet here.
   The tenure and prior-AP guards are what stop that from being noisy — such an
   agent is only flagged if their *production* also fell 40%.

### Where it shows

- **Row badge** — `AT RISK` beside the name, `title` carries the reason.
- **Banner** above the table listing every flagged agent and why; click one to
  open them.
- **Drill-down** spells it out in full: the actual month figures, both
  thresholds, and the sentence "Production alone is a slow month; silence alone
  is a holiday."
- **Summary mini-card** shows the count.

An agent inside the 30-day grace period gets an explicit line in their profile
saying so, rather than silently looking healthy.

---

## The drill-down profile

Extended, **not rebuilt**. The **Send Leads** button and `openAgLeadPicker()`
are exactly as `docs/lead-distribution.md` (entry point B) left them, and a
test asserts the button is still wired.

Added: the at-risk explanation, this-period stats with period-over-period
movement, an activity summary (joined / last activity / last dial), and
lifetime totals. All from the same `loadTeamRoster()` cache entry the table
renders, so a row and the profile opened from it cannot disagree.

Clicking a row on the **Summary** mini-card also lands here: `teamOpenAgent()`
sets `_agPendingProfile` and calls `nav('agency')`, which `renderAgencySection()`
picks up. Calling `agOpenAgentProfile()` directly after `nav()` would race —
`nav()` fires `renderAgencySection()` without awaiting it, so the leader view
would finish afterwards and overwrite the profile.

---

## The Summary mini-card

Replaces the full Team section at the foot of Summary.

- **Collapsed** (the default, and the default for a leader who has never
  touched it): one strip — team AP, team dials, at-risk count, agent count.
- **Expanded in place**: period chips, the you-vs-team strip, and the *same*
  `teamTableHTML()` the Agency tab renders, plus a link across to Agency for
  roster management.
- The choice persists in `localStorage.pp_team_card_open` (`'1'` open). An
  absent key reads as closed, which is what makes collapsed the default.

The period chips here write the **same** `pp_team_period` the Agency screen
uses. The Summary's own Daily/Weekly/Monthly chips still govern the
**personal** stats above and are unrelated — one is your book, the other is
your team.

---

## Privacy

Unchanged and now enforced by the query rather than by the UI's restraint:
`get_team_summary` selects aggregates only. A test asserts the `RETURNS TABLE`
carries no column matching `client`, `policy_number`, `commission`, `comp_`,
`phone`, or `premium_detail`.

Leader views show **production and calling totals only** — no client names, no
policy-level detail, no commission figures from downline books. The note is
rendered under the table on both surfaces.

---

## The downline / invitee view

**Untouched, and must stay reachable.** `_agRenderAgentView` is the only place
an invitee can accept an invite or revoke a leader's access. A tier gate on
`nav('agency')` made every emailed invite unacceptable once already (fixed in
`4a216aa`); a test now asserts that gate has not returned, and the end-to-end
run exercises accept and revoke through the real UI.

Revoking sets the invite to `declined` rather than deleting it — the row is
the record that access was once granted. `get_team_summary` counts only
`accepted`, so the leader loses visibility immediately. Verified live.

---

## Schema

`supabase/migrations/20260738_team_roster.sql`, applied 2026-07-29. See
`docs/schema-state.md` for the audit and the 13/13 behavioural checks.

### `agency_invites.accepted_at`

New, additive, plus a stamping trigger. "Joined" on a roster means joined the
*agency*; the table only recorded when the invite was **sent**. For a code
join those coincide, for an emailed invite accepted three weeks later they do
not — and the date feeds the 30-day at-risk grace period, so it is not
cosmetic.

The trigger covers both accept paths (the browser's direct `UPDATE` and
`process_agency_code_join`'s `INSERT … ON CONFLICT`) and is **write-once for
client callers**, so a leader cannot backdate a join to suppress a badge.
Trusted contexts (service_role, SQL editor) keep the usual carve-out.

### `get_team_summary` — replaced

Authorised by Jace. A return-type change cannot be done with `CREATE OR
REPLACE`, so the file drops and recreates the function inside one
transaction. **No table, column, or row is touched.**

Authorization is unchanged and is still the only thing between a caller and
someone else's aggregates:

```sql
ai.leader_id = auth.uid()
```

There is deliberately **no parameter naming a leader**. `get_agency_stats`
takes `p_leader_id` and then has to re-check it against `auth.uid()`; this
function cannot be pointed at another leader's downline because there is
nothing to point. All eight parameters are time bounds, all optional, `NULL`
meaning unbounded — which is how "Lifetime" is expressed.

**Month bounds are passed in from the browser**, not derived from `now()`,
because the browser knows the agent's local calendar and the server only knows
UTC. Near a month boundary those disagree by hours and the at-risk badge would
flip depending on who did the arithmetic. Server-side defaults exist so a
caller that omits them still gets a sane answer.

One behavioural change worth knowing: **AP is now regex-guarded before the
numeric cast.** Previously a single policy with a non-numeric `ap` would throw
and take down the team rollup for *every* agent on the screen. Unparseable AP
now counts as 0.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260738_team_roster.sql` | `accepted_at` + trigger; `get_team_summary` replaced |
| `app.html` — `// <team-core>` block | pure logic: periods, at-risk, shares, sorting, formatters |
| `app.html` — `loadTeamRoster` | the one RPC call site |
| `app.html` — `teamTableHTML` / `teamVsHTML` / `teamPeriodChipsHTML` | the one renderer set |
| `app.html` — `_agRenderLeaderView` | the merged Agency screen |
| `app.html` — `agOpenAgentProfile` | the drill-down |
| `app.html` — `<style id="team-roster-styles">` | `.tm-*`, palette-indirected via `--tm-*` |
| `test/team-roster.test.mjs` | 57 tests — `npm run test:team` |

### Why the tests extract from `app.html`

`app.html` has no build step and no module system. A mirrored copy of the
logic in a `.ts` file would be a second definition that drifts from the one
that ships. So the test pulls the text between the `// <team-core>` sentinels
out of `app.html` and executes it. **The tests run the exact code that ships.**
Keep that block pure — no DOM, network, storage or app globals; a test asserts
that too.

---

## Decisions taken without asking

Everything below was decided during the build and is recorded here because
nobody was asked about it.

1. **`get_agency_stats` is left in the database but no longer called.** The
   rules forbid dropping things; leaving a dead function is cheaper than a
   `DROP` conversation, and a test stops the app calling it again.
2. **"Last activity" is built from `created_at`, never `updated_at`.**
   `sbUpsertAllLeads()` re-upserts the entire local book on every save, so
   `leads.updated_at` tracks app usage rather than work and would report every
   idle agent as active today. Activity = last dial, policy added, or lead
   added.
3. **Team dials count `calls` rows only** — the dialer. The Summary's personal
   dial count also unions manually-logged activities from `localStorage`, which
   the server cannot see. Stated under the table.
4. **Volume share uses largest-remainder rounding** so the displayed integers
   total exactly 100, never 99 or 101. All zeroes when the team wrote nothing:
   0/0 is not 100%.
5. **Call-to-close of "no sales yet" sorts as the largest value**, so it never
   wins the ascending "best ratio" sort. It is the absence of a ratio, not a
   good one.
6. **The roster list inside Manage roster takes names and plans from the
   roster view**, not from a second query, so it cannot disagree with the table
   above it.
7. **Remove appears in two places** — the roster panel and the agent profile —
   both calling the existing `agRemoveConnection` with its Stripe unlink. It is
   no longer on the row itself, where it sat next to a now-clickable surface.
8. **Cache TTL is 45s**, and every roster mutation (invite, cancel, remove,
   accept, decline, revoke) calls `teamInvalidate()` so a removed agent
   disappears immediately rather than lingering for the TTL.
9. **The mini-card and the Agency screen share one period value.** Two
   independent selectors would be a second way for the screens to disagree.

---

## Hand-test script

You need two accounts connected through an agency. Production has **zero**
`agency_invites` rows, so step 1 is real setup.

1. **Connect two accounts.** As a Team Leader account: Agency → **Manage
   roster** → enter the second account's email → **Send Invite**. From the
   second account: Agency → **Accept**. (Or set an agency code and sign the
   second account up with it.)
2. **Look at the team table.** Agency tab. Expect one row per member plus your
   own row marked **You**, a **Team total** row, and `% of team` adding to
   100%.
3. **Switch periods.** Click through this week / this month / this quarter /
   lifetime. AP and dials should change; the **AT RISK** badge should not move.
   Reload — the period you left it on is still selected.
4. **Sort.** Click **AP** — it flips between descending and ascending (▾/▴).
   Click **Agent** — alphabetical. Click **Call-to-close** ascending — anyone
   with no sales sorts to the bottom, not the top.
5. **Drill down.** Click any row. Expect the profile with this-period stats,
   "vs prior period" movement, joined / last activity / last dial, and
   lifetime totals. **Back to Agency** returns you.
6. **Send Leads still works.** From that profile, **Send Leads** → filter →
   tick → **Send N Leads**. Confirm. Expect a toast, and the leads to leave
   your list immediately. (Full flow in `docs/lead-distribution.md`.)
7. **The mini-card.** Summary tab, scroll to the bottom. Collapsed strip shows
   team AP, team dials, at-risk count. Click **Expand** — the full table
   appears in place with the same numbers as the Agency tab. **Reload** — still
   expanded. **Minimize**, reload — still collapsed.
8. **Cross-check.** Team total AP on the Agency tab must equal team AP on the
   Summary strip for the same period. If they ever differ, something has grown
   a second query — start at `loadTeamRoster`.
9. **The invitee side.** From the second (non-leader) account: Agency is
   visible in the nav, shows **Sharing Your Data With**, and **Revoke Access**
   works. After revoking, the leader's table no longer lists them.
10. **At-risk, if you want to see it fire.** It needs an agent with ≥30 days'
    tenure, last month's AP at least 1.67× this month's, and no dial for 7+
    days. Easiest on a real team is to wait for it; to force it, seed policies
    dated last month and leave the dialer alone.

---

## End-to-end run against production — 2026-07-29

Two throwaway accounts (a Leader-plan "QA Team Leader" and a Basic "QA
Downline Dana") were created, connected through the **real** invite → accept
flow, seeded with synthetic production that trips the at-risk rule, and driven
through headless Chrome against the **local** `app.html` (this code had not
shipped yet) talking to the real Supabase backend. Test leads used the reserved
fictional `+1 555 555 01xx` range — no real consumer was involved.

**59 of 59 assertions passed.** Both accounts and every row they touched were
deleted afterwards; `agency_invites`, `lead_transfers`, QA leads, QA policies
and QA calls all returned to 0, and no throwaway auth user remains.

| Step | Result |
|---|---|
| invite sent from the Manage roster panel | shows as pending |
| downline accepts through the invitee view | accepted; `accepted_at` stamped by the trigger |
| merged screen, this month | team AP $10,000; leader $8,000/80%, downline $2,000/20%; shares total 100 |
| AT RISK | badge on the downline row only; banner reads *"AP down 83% vs last month, no dials in 12 days"* |
| you-vs-team strip | $8,000 vs team avg $5,000; 10 dials vs avg 7; 10:1 vs team-wide 7:1 |
| period switching | Lifetime → $22,000 and the ranking flips (downline is the bigger book at $14,000); This week → $10,000; badge does not move |
| sorting | AP desc → asc; Agent alphabetical |
| drill-down | at-risk reason, trend, activity, lifetime, privacy line, Send Leads all present |
| **Send Leads** | `1 sent to QA Downline Dana`; lead moved, provenance stamped, audit row written |
| Summary mini-card | collapsed by default; strip $10,000 / 13 dials / 1 at risk |
| **cross-screen check** | expanded table reports the same $10,000 the Agency tab does |
| persistence | expanded survives reload; collapsed survives reload; key is `pp_team_card_open` |
| leader-only RPC | a non-leader gets a team of one — their own row, never the leader's |
| tampering | no argument a downline can pass widens the result |
| revoke | works from the invitee view; afterwards the leader cannot see them at all |

### One caveat on how it was run

The edge-function CORS allowlist (`_shared/cors.ts`) covers the production
origins plus `http://localhost:8080` behind an env flag, so a locally served
`app.html` cannot call `transfer-leads`. This build changed no edge function
and no CORS config, so rather than toggle a production secret for a test, web
security was relaxed **inside the throwaway Chrome profile only**. Nothing
server-side was altered. The Send Leads assertions above are otherwise real:
the lead genuinely moved between two real accounts and the audit row was
genuinely written.

### What the run found

Nothing in the app — every failure during development was in the harness
itself (probing `window.currentAgent` for a `let`-declared global; reading the
table during the "Loading…" frame that `renderAgencySection()` paints on every
re-render). Both were fixed by polling inside the page rather than sampling
once. That second one is worth remembering if you write another driver against
this app: **the Agency section blanks itself on every re-render**, so any
single-shot DOM read can catch an empty frame.

Two assertions were wrong rather than the code: revoke sets an invite to
`declined` rather than deleting it (correct — the row is the record), and the
collapsed strip's adjacent spans read as `1at risk` with no space.
