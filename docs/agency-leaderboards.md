# Agency leaderboards, records & achievements

Built 2026-07-30 (PROMPT_17). Adds competitive-but-classy boards, personal and
agency records, and an achievement system to the Agency tab.

**Read this before touching anything named `lb*` in `app.html`, or
`supabase/migrations/20260750_agency_leaderboards.sql`.**

Companion docs: `docs/agency-team-screen.md` (the team surface this sits beside
and borrows its period engine from), `docs/schema-state.md` (the apply record).

---

## The organising principle

The team table and the boards are **on the same tab, one click apart**. If they
computed AP differently, an agent would see their own production stated two
ways on one screen. That is the bug that produced the 8,610× overstatement
fixed in `20260736`, with a shorter fuse.

So:

> **One period engine, one definition of a sale, one AP guard — shared with the
> team screen, not copied from it.**

`lb_agent_metrics()` carries the sale predicate, the sale-date chain and the AP
regex guard **byte-identical** to `get_team_summary`'s `pol` CTE as `20260741`
left it. `test/leaderboards.test.mjs` extracts both from the migration text and
compares them character for character. If either moves, the test fails rather
than the screens quietly disagreeing.

The browser has no period engine either: `lbLoadBoards()` calls
`teamPeriodRange()`, and a test asserts the leaderboard block contains no
week-start or quarter arithmetic of its own.

| Invariant | Enforced by |
|---|---|
| exactly ONE `sb.rpc('get_agency_leaderboards')` call site | `lbLoadBoards()` |
| the period engine is `teamPeriodRange()` | test, plus `lbRpcArgs()` minting no dates |
| the top-10 cutoff is applied by the SERVER | test asserts `lbSplitRows` never reads `LB_TOP_N` |
| one stored period value for the whole tab | `pp_team_period`, shared with the team table |

---

## The screen

Five areas under the existing **Agency** nav item, resolved from `LB_AREAS`
by key and never by index:

```
Team | Leaderboards | Records | Achievements | Hall of Fame
```

**Team is the default and is unchanged** — it renders `_agRenderLeaderView`
for a leader and `_agRenderAgentView` for everyone else. That second one is the
**only** place an invitee can accept an invite or revoke a leader's access; a
tier gate on `nav('agency')` made every emailed invite unacceptable once
already (`4a216aa`), and a test asserts both that the gate has not returned and
that the agent view is still wired.

### Leaderboards

Seven boards, a period selector shared with the team table, and an AP basis
toggle:

| Board | Metric | Bar to qualify |
|---|---|---|
| Most AP *(default)* | net AP written in the period | — |
| Most Policies Sold | count of sales | — |
| Most Dials | `calls` rows | — |
| Most Talk Time | `duration_sec` | — |
| Highest Close Rate | policies per 100 dials | 50+ dials |
| AP per Dial | net AP ÷ dials | 50+ dials |
| Most Improved | % AP gain vs your own prior period | $500+ prior baseline, not on Lifetime |

- **Ranks 1–3 get a thin accent** — a 2px inset rule and a tinted monogram, in
  gold/silver/bronze. No trophies, no fire.
- **Ties share a rank and the next rank skips.** `rank()`, never `dense_rank()`.
- **Below-threshold agents are ABSENT, not ranked last**, and the bar is stated
  under the board ("Qualify with 50+ dials this period").
- **Zero and negative values are excluded from every board.** A leaderboard of
  agents who wrote nothing is not a leaderboard, and a visible tail of $0 rows
  is exactly the bottom-to-top ranking the brief forbids.

### The two boards that were cut, and why

Both were put to Jace with the evidence on 2026-07-30 and cut. They are in the
brief; their absence is a decision, not an omission.

- **Most Appointments Set** — `calls.outcome = 'appointment'` has **exactly one
  row in all of production**, and there is no "kept" signal anywhere (the
  Google Calendar integration is display-only and stores nothing). The board
  would have been a ranking of noise.
- **Best Placement Rate** — no agent has ever recorded a `denied` or
  `withdrawn` policy, so under the industry definition every agent scores 100%
  and the board says nothing.

`// PHASE 2` in `LB_BOARDS` marks where both become buildable: an
appointment-set timestamp, and routine use of the two statuses.

### The private own-rank row

A viewer outside the top ten gets **one** extra row, pinned below the board:

```
#12  QA Down 11  You                                    $100
     You’re #12 — $200 from the top 10. Only you can see this row.
```

**This is enforced by the query, not the UI.** `get_agency_leaderboards`
returns `rank <= 10 OR agent_id = auth.uid()` — the tail is never sent, so a
peer cannot read it out of the network tab. `top_value` (the value standing at
rank 10) is returned so the gap sentence can be written without handing over
the tenth-placed agent's identity.

`lbSplitRows()` partitions on the server's `in_top` flag and a test asserts it
never mentions `LB_TOP_N`: if the browser ever had to filter, that would mean
the tail was being sent and merely hidden.

---

## Who an agent is called

**One resolver, `pp_display_name()`, and every peer-visible surface reads it** —
directly, or through `lb_agent_name` / `get_team_summary` / `get_agency_members`.
`20260751`.

An email address is not a name. Before that migration every name expression in
this schema ended `..., au.email)` and `agents.display_name` was NULL for all
eight production agents, so the fallback *was* the answer: the leader of the
only live agency appeared as `jacef8778099@gmail.com` on the team table, all
seven boards, both record scopes and — stored, not merely rendered — on four
`agency_records.holder_name` rows his two downline agents could read.

The chain:

| | Source | Why here |
|---|---|---|
| 1 | `agents.display_name` | what the agent typed in Settings |
| 2 | `raw_user_meta_data->>'display_name'` | the old chain's key, preserved |
| 3–4 | `->>'full_name'`, `->>'name'` | the identity provider names a PERSON |
| 5 | `dba_name` → `business_legal_name` → `agency_name` | the business profile |
| 6 | the email's **local part**, prettified | never the address |
| 7 | `'Agent'` | rather than a blank cell |

Steps 3–4 sit **above** the business profile deliberately. A board row names a
person; ranking "Frenkel Financial LLC" against ten people reads as a bug.

`ppAgentName()` in `// <team-core>` is the browser's half, and it **refuses any
string containing `@`** — if a stale cache or an unmigrated RPC ever hands the
browser an address in a name field, it derives a name instead of publishing it.
`ppInitials()` builds avatars from that name, so a monogram can never spell an
address either.

**The Settings field used to write localStorage only.** An agent typed their
name, watched it stick, and stayed an email address to their whole agency. It
now writes `agents.display_name` and drops the team/leaderboard caches.

**The one place an address is still shown:** a *pending* or *declined* invite
card, where no account exists and the address the leader typed is the only
identifier the row has. A *connected* agent is a person and is named as one.
Search is unaffected — typing an email to find a colleague in the transfer
picker still works. The rule is about what is rendered, not what is matched.

---

## Periods: Lifetime, a month picker, and custom ranges

Added 2026-07-30 to **both** the Summary screen and the Agency tab. No schema
change was needed: every window is expressed in bounds the RPCs already accept.

One key grammar, one parser, both engines:

```
'month:2026-04'                 a past calendar month
'custom:2026-04-01:2026-04-17'  an inclusive range
```

`ppParsePeriodKey()` / `ppDynamicRange()` live in `// <team-core>` and are called
by `summaryPeriodRange()` and `teamPeriodRange()` alike. A test asserts each is
defined exactly once and that neither engine grew its own week-start or quarter
arithmetic. The keys are strings so they persist in `localStorage` and travel
through the existing setter/renderer plumbing untouched.

- **`end` is exclusive** (the day after `to`) because every consumer in this app
  is half-open. The picker is inclusive because that is what a person means by
  "the 1st to the 17th".
- **Most Improved compares against the preceding range of EQUAL LENGTH**, and
  for a picked month against the month before. That is why the board stays
  available on a custom range rather than being hidden: `ppDynamicRange` emits
  `prevStart`/`prevEnd`, which is exactly what `lb_board_rows` already reads, so
  `20260750` needed no change. The screen says which comparison it made.
- **The AT-RISK window does not move.** It is always this calendar month versus
  last, for every period key including a picked one — a leader browsing last
  April must not see agents flagged for April's numbers. A test asserts the
  at-risk pair is byte-identical across all six key shapes.
- **A stored key that no longer resolves is ignored**, on both screens, so a
  corrupt value cannot brick the page on every future load.
- `_lgInRange` / `_lgWhenInRange` and the Summary calls query all had to learn
  that **null bounds mean unbounded** — they used to dereference `range.start`
  unconditionally, so Lifetime would have thrown the moment it appeared.

---

## Peer visibility — the new consent question

Until this feature a downline consented to sharing performance data with their
**leader**. A board shows it to **peers**. That is genuinely new, so:

1. **`agents.hide_from_leaderboards`** — agent-controlled, owner-writable
   through the existing `agents_update_own` policy, and deliberately **not**
   added to `agents_protect_privileged_columns`. This is the one column on that
   table the agent is *supposed* to write.
2. **The switch lives at the foot of the Leaderboards panel**, where it means
   something, and says in a sentence what it does.
3. **A one-time notice** the first time an agent's data would appear, naming
   the switch and where it is. Dismissal is remembered
   (`pp_lb_peer_notice`).

### What "hidden" means, exactly

`lb_visible_members()` is the single enforcement point and it sits **below
every peer-visible read** — the boards, the agency records, and the milestone
feed. Not in the UI, and not in the browser.

A hidden agent:

- appears on **no** board, to anybody, **including themselves** — being hidden
  means being out of the running, and a private ranking only you can see is
  still a ranking of a book you asked us not to rank;
- **cannot hold an agency record** and does not lift the team-combined ones
  (otherwise the opt-out would leak production back in through a record row);
- **writes no milestone**;
- **still sees the boards**, and is told plainly that they are hidden;
- **keeps their personal records and achievements**, updating privately.

---

## Records

**Personal** (every agent, every tier, agency or not): best day by AP, best day
by policy count, best week, best month, biggest single policy, longest sales
streak, fastest lead-to-sale.

**Agency** (per agency): best single day for the whole team, best single day by
one agent, best week, best month, biggest policy ever, most policies in one day
by one agent, fastest lead-to-sale in agency history.

**No agency record carries a client name, a policy number or a carrier.** That
is the line `docs/agency-team-screen.md` draws for every cross-agent surface,
and a test asserts the two tables' column lists.

`holder_agent_id` is `ON DELETE SET NULL` and `holder_name` is denormalized:
an agent leaving must not erase the fact that the record was set, nor blank the
name beside it.

### The streak rule

"Consecutive business days, where weekend sales extend a streak and weekend
gaps don't break one" is implemented as one index rather than a special case.
`lb_biz_index(date)` counts weekdays and folds Saturday and Sunday onto the
**following Monday's** index, so:

- Friday → Monday are consecutive indices (a weekend gap does not break it);
- Saturday shares Monday's index (a weekend sale extends it).

`1970-01-05` is the epoch because it is a Monday, so the modulo can never go
negative for any date this app can hold.

### Progress nudges

`lbNudge()` fires only when the agent is **close and behind** — within a third
of the record. "$800 away from your record" is encouraging; the same sentence
at 80% short is a scold, so it returns `''`.

---

## Achievements

18 definitions, seeded in `achievement_definitions`, grouped into five families
in the gallery. Earned badges are in colour; unearned are greyed **with their
criteria visible**, so the gallery doubles as the goal map.

### Early Bird and Closer are not built, deliberately

The brief asks for "policy before 10:00 AM" and "policy after 7:00 PM". **There
is no sale-time timestamp anywhere in this schema.** `dateSubmitted` and
`draft` are dates; the only time-of-day signal is `policies.created_at` (and
`policy.id`, which is `Date.now()` at Save) — i.e. **when the row was typed
into the CRM**. A badge on that rewards early data entry and calls it early
selling. Put to Jace on 2026-07-30 with three options; he chose to drop both.

**Weekend Warrior survives** because it reads the sale **date**: a Saturday
sale date is genuinely a Saturday sale whenever it was typed in.

### Placed & Paid

"10 consecutive policies reaching placed with no fall-off" counts only
**resolved** policies. A `pending` or Approved-Not-Paid application has not
fallen off — it simply has not landed yet — so it neither counts toward the run
nor breaks it.

---

## The evaluator, and why re-running it is always safe

`lb_evaluate(agent, silent)` computes every record and unlock from the agent's
whole history. It is idempotent three ways:

| Thing | Made idempotent by |
|---|---|
| achievements | `UNIQUE (agent_id, achievement_key)` + `ON CONFLICT DO NOTHING` |
| records | written only when **strictly better** (`lb_record_is_better`, which knows lead-to-sale is lower-is-better) |
| milestones | `UNIQUE (leader_id, dedupe_key)`, where the key encodes the **event** — `agency_record:agent_day_ap:4000` |

It runs from three places:

- **`lb_refresh_me()`** — the browser, once per page load when the Agency tab
  is opened. A record broken since your last visit is on screen the first time
  you look, not the second.
- **`leaderboard-nightly`** — pg_cron, 06:05 UTC, `p_silent => false`. The
  safety net for everything that happens while nobody is looking: a lapse from
  the carrier-mail pipeline changing net AP, a statement moving a policy to
  chargeback, or an agent who simply has not opened the app.
- **the launch backfill** — `lb_evaluate_all(true)`.

### The backfill is feed-silent, on both sides

Server-side, `p_silent` suppresses every milestone write. Client-side,
`lbNewlyEarned(list, seen)` returns `[]` when `seen` is `null` — meaning this
browser has never looked — so the first load after the backfill seeds the
remembered set instead of firing twelve toasts for history.

A personal best also only announces when it **beat** something: the first time
a record is set there was nothing to break, and an agency switching the feature
on would otherwise see seven "records" per member on day one.

---

## Seasons and the Hall of Fame

`lb_snapshot_period()` freezes the top ten of every board when a period closes,
reading **the same `lb_board_rows()` the live board reads** — so July's frozen
winner is the winner the board showed all July, not a second computation.

`leaderboard-rollover` (pg_cron, 06:20 UTC) runs nightly and decides for itself
what closed: Monday closes a week, the 1st closes a month, and the 1st of
Jan/Apr/Jul/Oct also closes a quarter. It reasons in **America/Chicago**, not
in the server's UTC, which is why there is no CDT/CST job pair here unlike
`schedule_email_pipeline.sql` — a DST shift changes when it runs, never what it
does.

Snapshots are frozen against later edits: a policy whose status changes in
September cannot rewrite who won July.

**The uniqueness grain is the AGENT, not the rank** — and that is a correction
the behavioural pass caught before the table ever held a row. Keyed on `rank`,
a board with two agents tied at rank 6 offered the same key twice and
`ON CONFLICT DO NOTHING` swallowed the second: a ten-place board froze with
nine rows, and the missing one was somebody's tied placement.

---

## Authorization

Identical posture to `get_team_summary` / `apply_producer_codes` /
`get_downline_commission_rollup`.

- **No function an `authenticated` caller may execute takes a parameter naming
  an agent or a leader.** The agency is resolved solely from `auth.uid()` via
  `lb_leader_for()`. There is nothing to point at somebody else's team, and a
  test asserts every browser-callable signature is uuid-free. Verified live:
  passing an invented `p_leader_id` returns HTTP 404 rather than being ignored.
- **The internal helpers that DO take an agent array** (`lb_agent_metrics`,
  `lb_board_rows`, `lb_members`, `lb_visible_members`, `lb_evaluate`,
  `lb_evaluate_agency`, `lb_evaluate_all`, `lb_snapshot_period`, `lb_rollover`,
  `lb_agent_name`, `lb_leader_for`) are **REVOKEd from `anon` and
  `authenticated`**. They are reachable only from inside the definer functions
  above them.
- **No table in this migration has an INSERT, UPDATE or DELETE policy.** Three
  SELECT policies, and that is all. `agency_records`,
  `leaderboard_snapshots` and `agency_milestones` have **no policy at all** —
  RLS-enabled-with-no-policy is how "reachable only through a definer function"
  is expressed in Postgres, the same idiom as `reputation_config`,
  `lead_transfers` and the four commission tables.
- **`get_my_achievements()` is SECURITY INVOKER**, reading through the caller's
  own RLS, so it cannot return another agent's unlocks even by accident.

Do not "fix" any of this by adding an INSERT policy. A policy wide enough to
let the browser record an achievement is wide enough to let it record one it
did not earn; one wide enough to write `agency_records` is wide enough to claim
somebody else's record.

---

## Decisions taken without asking

1. **Talk time is `duration_sec`, the same expression the team table's "Call
   time" column uses.** `calls.answered_at` exists and connected time *is*
   distinguishable — but `duration_sec` is only written when a call completes,
   and across all 1,298 production rows the two definitions differ by **13
   seconds**. Two "call time" numbers on one screen differing at all is the bug
   class this schema keeps paying for.
2. **Close rate is policies ÷ dials.** Appointments were the alternative
   denominator and there is one qualifying row in the database.
3. **The period value is shared with the team table** (`pp_team_period`). Two
   selectors on one tab is a second way for the screens to disagree. "Lifetime"
   is this app's word for the brief's "All-Time"; the label was not changed
   because `TEAM_PERIODS` is the one list.
4. **Live boards use the viewer's local period bounds** (whatever
   `teamPeriodRange()` produces), because AP buckets on a **date** and is
   therefore timezone-independent; only dials are instant-bucketed, exactly as
   the team table already does it. The **snapshot** job uses America/Chicago,
   and the snapshot is the frozen authority.
5. **Achievement day-buckets for calls are America/Chicago**, because a 7 PM
   Central dial is tomorrow in UTC and bucketing on the server's zone would
   silently break a dial streak.
6. **`earned_at` is stamped at NOON on the historical day**, never midnight —
   it is a `timestamptz` rendered in the reader's local zone, and midnight
   shows the previous day for every agent west of UTC. This schema paid for
   that lesson once already, on all 23 rows (`20260741`).
7. **Both cron jobs call SQL directly** rather than `net.http_post`-ing an edge
   function. There is no edge function in this feature, so there is no secret
   to store and no `verify_jwt` flag to get wrong.
8. **A solo agent gets records and achievements and an honest empty state**
   where the boards would be, not a hidden tab. `lb_leader_for()` returning
   NULL is a real state, not an error.
9. **`docs/PRODUCERSTACK_BUILD_CHECKLIST.md` line 6 excluded leaderboards "on
   purpose".** PROMPT_17 supersedes it; the line now points here rather than
   leaving two docs contradicting each other.

---

## Files

| File | What |
|---|---|
| `supabase/migrations/20260750_agency_leaderboards.sql` | 6 tables, RLS, 18-badge seed, 20 functions |
| `supabase/schedule_leaderboards.sql` | the two pg_cron jobs |
| `app.html` — `// <leaderboard-core>` | pure logic: boards, cutoff split, records, badges, banners |
| `app.html` — `lbLoadBoards` | the one RPC call site |
| `app.html` — `lbRender*` | the five area renderers |
| `app.html` — `<style id="leaderboard-styles">` | `.lb-*`, on the same `--tm-*` palette as the team roster |
| `test/leaderboards.test.mjs` | 60 tests — `npm run test:leaderboards` |

---

## Verification

| Layer | Result |
|---|---|
| Behavioural, against production inside a rolled-back transaction | **70/70** |
| Unit tests (`npm run test:leaderboards`) | **60** |
| Full suite + `npm run check` | **747 tests, 0 failures, check clean** |
| Headless Chrome against the real UI, 13 throwaway accounts | **62/62** |
| Residue after the browser run | **zero** — production back to baseline |

The behavioural pass builds a 13-agent fixture (a leader + 11 downline, plus a
separate agency) inside a transaction that rolls back, with FK triggers
disabled for the transaction only, so it needs no `auth.users` rows and
**`auth.*` is never written**. Every figure comes from June 2019, a window in
which production holds no policies and no calls, so the numbers are exact
rather than "production plus fixture".

The browser run creates 13 real throwaway accounts, seeds the current month,
drives the actual `app.html` in headless Chrome over the DevTools Protocol
(zero new dependencies), and deletes every account in a `finally` block.

### What the runs found

- **The tie bug in the snapshot's unique key** (above). Caught by check 53,
  fixed before the table held a row.
- **`fmt$()` accepts a numeric string and then crashes on it.** `fmt$` guards
  with `isFinite(n)`, and global `isFinite('1200')` is `true`, so a string
  slips past and `.toFixed` throws. **Not a shipped bug and not this feature's
  code** — all 24 production policies store `ap` as a JSON *number* and
  `addPolicy()` writes one; it surfaced only because the QA fixture seeded AP
  as a string. Left alone (it is a 40-call-site formatter, out of scope here)
  but worth knowing: any future writer that puts a string in `data.ap` will
  break the dashboard, while the SQL side is already guarded by regex.

---

## Hand-test script

You need an agency. Production has one (Jace plus two accepted agents).

1. **Agency tab** → five tabs across the top. **Leaderboards.**
2. **Most AP** is selected, showing this month. Ranks 1–3 carry a thin
   gold/silver/bronze rule. The one-time peer-visibility notice appears — read
   it, dismiss it, reload; it stays dismissed.
3. **Click through the boards.** Most Dials re-ranks. Highest Close Rate shows
   only agents with 50+ dials and states the bar.
4. **Switch the period to Lifetime.** Most Improved disappears from the chip
   row entirely — it has no comparable prior period.
5. **Switch the basis to Placed.** AP drops for anyone holding Approved-Not-Paid
   business.
6. **Records.** Personal bests on top, agency records below with a holder name
   and no client anywhere. A record set in the last 7 days carries a quiet
   `NEW`.
7. **Achievements.** Earned in colour, unearned greyed with the criteria
   showing. There is no Early Bird and no Closer.
8. **Hall of Fame** is empty until a week/month/quarter closes. To see it now:
   `select public.lb_snapshot_period('<leader-uuid>','month', date '2026-07-01', date '2026-08-01');`
9. **Hide yourself.** The switch at the foot of Leaderboards. You vanish from
   the board for everyone including yourself, you are told so, and Records and
   Achievements keep working. Turn it back on.
10. **From a non-leader account**, Agency still opens on **Team** with the
    invitee view, and Leaderboards is reachable.
