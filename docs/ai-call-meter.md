# Daily AI-call meter — recommended pace, ramp-up, and the agent's own cap

Added 2026-07-30. Schema: `supabase/migrations/20260802_ai_call_meter.sql`.
Math: `supabase/functions/_shared/ai-call-meter.ts`, mirrored in the
`// <ai-meter-core>` block in `app.html`. Gate: `ai-call-start`, gate 5.
Tests: `supabase/functions/_shared/ai-call-meter.test.ts` (`npm run test:ai`)
and `test/ai-meter.test.mjs` (`npm run test:aimeter`).

## The product decision, in one paragraph

Carriers flag numbers that place hundreds of calls a day as "Spam Likely", and
a brand-new number is at its most fragile in its first week. So this feature
**meters and recommends**. It does not police. The recommendation is ~300 AI
calls a day per active number, ramped over a number's first seven days. Passing
it **never blocks a call** — the screen goes amber, one row is written for the
day, and the call is placed. The only thing that refuses is the number the
agent typed into their own settings, and clearing it is one click. An agent who
wants 500 calls a day on one number gets a clear warning about what that does
to the number, and then gets their 500 calls. **The upsell — "add another AI
number and the recommendation goes up" — is a line of copy, never a wall.**

## The numbers

| | |
|---|---|
| Recommendation | **300** calls/day **per active number** |
| Ramp (day 1 → 7) | **30, 60, 100, 150, 200, 250, 300** |
| Day 8 onward | 300 |
| Default cap | **300** (the recommendation *is* the default) |
| No cap | `agents.ai_daily_call_cap IS NULL` |

Recommendation = Σ over the agent's `status='active'` numbers of
`min(300, rampValue(number))`.

## Rules that are easy to get wrong

- **`NULL` cap is "no cap", and it is a state the agent chose.** It is not a
  missing value and must never be defaulted back to 300 by a migration re-run.
  The migration contains no `update … set ai_daily_call_cap`; a test asserts it.
- **A recommendation of `null` is not a recommendation of `0`.** An agent with
  no active number has no pool to advise on, so `recommendedDailyCalls()`
  returns `null` and nothing is ever flagged as over pace. Returning 0 would
  paint every call red on an account that cannot dial at all.
- **A number that has never carried an AI call is on ramp day 1, not day 0.**
  The moment it carries one it *is* day 1, so 30 is both the safe answer and
  the true one. This is also what makes the upsell honest: adding a number
  raises the recommendation by 30 today, reaching +300 a week later.
- **`ai_first_used_at` is stamped once, only after Telnyx accepted the call**
  (`.is("ai_first_used_at", null)` in the update). A rejected dial never put a
  call on the number. A re-stamp would slide a mature number back to day 1 and
  quietly halve the recommendation on every later call.
- **INBOUND IS NEVER COUNTED AND NEVER BLOCKED.** A consumer who dialed the
  agent's number is not outbound volume, does nothing to the number's outbound
  reputation, and refusing to answer them is the one failure this feature
  cannot justify. Both count queries — the browser's and the server's — carry
  `direction = 'outbound'`, and a test greps for it in both.
- **One threshold, used by the gate and the screen:** `callsToday >= limit`
  means "the call about to be placed is beyond it". Two definitions is how the
  screen ends up green for a call the server refuses.
- **A blocked call writes no warning.** `overRecommendation` requires
  `!blocked` — a call that never happened must not leave a record saying it did.

## "Today" is the agent's day

`agents.timezone` holds an IANA zone, written by the **browser** from
`Intl.DateTimeFormat().resolvedOptions().timeZone`, and only when it changed.
NULL falls back to `America/Chicago`. There is deliberately **no area-code
inference** here: guessing where a *person* is from a number they bought online
is the kind of almost-right that files a call on the wrong day. (Contrast
`_shared/tcpa.ts`, which infers a *recipient's* zone from their number — that
is a different question with a different failure mode.)

The day window is the half-open UTC range `[local midnight, next local
midnight)`, solved by fixed point rather than by adding a constant offset: the
offset at UTC-midnight and at local-midnight differ across a DST boundary, and
one pass lands an hour out twice a year. Tests pin a 23-hour spring day and a
25-hour autumn day in Chicago, and a half-hour zone (Asia/Kolkata).

## The gate order in `ai-call-start`

1. `ai_disabled` — global OR per-agent kill switch
2. `upgrade_required` — plan tier
3. `not_callable` — consent / DNC / suppression
4. `quiet_hours` — lead-local calling window
5. **`daily_cap_reached`** — the agent's own cap *(new)*
6. `insufficient_balance` — wallet floor

Gates 1–4 are the Phase 0 compliance foundation and their order is unchanged.
Gate 5 sits **above** the wallet floor on purpose: hitting a cap you set
yourself is a pacing answer, not a money answer, and sending someone to top up
their wallet when the real reason is their own setting points them at the wrong
screen.

`daily_cap_reached` returns **429** with `detail`, `calls_today`, `cap`,
`recommended`, `resets_at` and `timezone` — everything the UI needs to explain
itself without a second round trip.

## `ai_pace_events`

One row per agent per local day, the first time that day a call went past the
recommendation. `unique (agent_id, local_day)` is what makes "once per day"
true: `ai-call-start` offers a row on *every* call past the recommendation and
the key discards all but the first, so `calls_today` on the row is the count at
the **first** warning, not the day's total. SELECT-only for `authenticated`;
the single writer is `ai-call-start` under the service role, taking the agent
from the JWT. Do not add an INSERT policy — a browser that can write here can
forge, or suppress, the record that it was warned.

`ai_call_events` was deliberately not reused: it is keyed on a Telnyx
`call_control_id`, carries raw Telnyx payloads, has no `agent_id` to scope an
owner policy by, and is service-role-only.

## Where the duplication is, and what holds it together

The math exists twice — the TS module (server) and the `// <ai-meter-core>`
block (browser) — because `app.html` has no build step and no module system.
What is avoidable is *drift*: `test/ai-meter.test.mjs` imports the module,
extracts the browser block with `new Function`, and runs a shared table of
several hundred cases through both, comparing ramp days, ramp values, day
windows, pool recommendations, verdicts and the rendered copy. If the screen
and the server ever disagree about whether a call is allowed, that test fails.
Same arrangement as `pcNormalizeCode()` vs `pc_normalize_code()`.

## Closed by the campaign-builder round (2026-07-30)

Both open items are done. See `docs/voice-campaigns.md`.

- **The rotation exists, so the recommendation is now honest.** Campaign calls
  pass an explicit `caller_id`, chosen by `vcPickCallerId()`
  (`_shared/voice-campaign-core.ts`) as the active number with the most room
  left against **its own** ramp — computed with this module's own
  `numberRampValue()`, so the meter and the rotation cannot disagree about a
  number's budget. Per-number usage comes from `ai_calls.from_e164` in the
  agent's day. A two-number agent recommended 600 now genuinely spreads across
  two numbers. Ties break deterministically and alternate on the next call,
  because the winner's usage goes up the moment it dials.
  **Manual test-rig calls still use `agents.signalwire_caller_id`** — one call
  placed by hand does not need spreading, and changing what the rig dials from
  would have changed what the live-call tests mean.
- **`resets_at` is what a blocked campaign reschedules on.**
  `vcHandleGateRejection('daily_cap_reached')` reads it straight out of the 429
  body rather than re-deriving midnight, so there is one definition of when an
  agent's day rolls over.

One thing the campaign round added here: `ai-call-start` now **verifies a
requested `caller_id` is one of the agent's own active numbers**, falling back
to their primary if it is not. A rotation bug must not be able to place a call
from another agent's number.
