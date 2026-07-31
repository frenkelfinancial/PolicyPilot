# Voice campaigns — the AI dials the book on its own

**Added 2026-07-30.** Schema: `supabase/migrations/20260802b_voice_campaigns.sql`.
Engine: `supabase/functions/voice-campaign-tick`.
Decisions: `supabase/functions/_shared/voice-campaign-core.ts`, mirrored in the
`// <vcamp-core>` block in `app.html`.
Enrollment actions: `supabase/functions/voice-campaign-manage`.
Call result: `supabase/functions/_shared/voice-campaign-result.ts`, called from
`ai-call-webhook`'s finalize block.
Cron: `supabase/schedule_voice_campaigns.sql` (every minute).
Tests: `npm run test:ai` (core + flow) and `npm run test:voicecampaigns`
(browser ↔ server parity + source invariants).

Closes `docs/ORION_GAP_ANALYSIS.md` § 1.3, the largest single gap in that
teardown.

## The product, in one paragraph

Today a human picks leads and presses run. A campaign instead *watches the
book*: "a new Veteran lead arrives → call within a minute → no answer? again in
two hours → then tomorrow morning", with stop rules like "stop once they book"
or "stop once they have actually **talked** to the assistant for fifteen
seconds". The agent describes who and when; the engine does the rest, for ever,
without anybody opening the app.

## The one rule that matters most

**Every campaign call goes through `ai-call-start`, and there is no second
path.** Consent, DNC, suppression, lead-local quiet hours, the agent's own
daily cap and the wallet floor are enforced in one function, in a fixed order,
by the same code the Test Rig calls. `voice-campaign-tick` contains no copy of
any of them — a test asserts it never reads `min_ai_call_start_mills`,
`balance_mills`, `ai_daily_call_cap`, `evaluateDailyPace` or `wallet_accounts`,
and never POSTs `api.telnyx.com/v2/calls`.

What the engine owns is **what to do when the answer is no**. See "Gate
rejections" below — that table is the actual design of this feature.

## The second rule: every group must name a lead type

`trigger_groups` is an array of groups OR'd together; conditions inside a group
are AND'd. Each condition is `{field, op: "is"|"is_not", value}`.

**Every group must carry at least one POSITIVE (`is`) condition on a
lead-type / campaign-tag field** — `campaign_tag`, `tags`, `lead_type`,
`coverage_wanted`, `source` (`VC_TAG_FIELDS`). Enforced in three places, on
purpose:

| Where | When |
|---|---|
| `vcValidateTriggerGroups()` in `// <vcamp-core>` | inline in the editor, per group, before the Active toggle will flip |
| `vcValidateTriggerGroups()` in `voice-campaign-manage` | before "Re-evaluate leads now" runs a rule over an entire book |
| `voice_campaigns_validate()` trigger | on any INSERT/UPDATE that leaves `active = true` |

**`is_not` does not count, and that is the whole point.** "Lead type is not
trucker" excludes a sliver and admits everyone else — which is exactly the rule
somebody types when they mean "everyone except truckers", and exactly the
campaign nobody meant to build. A campaign that phones a whole book is the one
mistake here that cannot be taken back once the calls have gone out.

Two more matching rules that are easy to get backwards:

- **`lead_type` is VIRTUAL** and resolves `coverage_wanted → lead_type → type →
  source` — the same chain `ai-call-start` hands the assistant as `lead_type`.
  A rule written against the words the assistant says on the call matches the
  leads it would say them to.
- **`is_not` on a MISSING field is TRUE.** "Unknown means it might be" silently
  shrinks every exclusion rule.
- **No groups, and an empty group, match NOBODY.** An unfinished rule must never
  read as "everyone". A draft may be saved half-written; only activation
  requires a rule that holds.

## The tick's decision order, per agent

1. **Sweep stops** that did not come from a call — the lead went DNC, was
   marked sold, booked an appointment, or was deleted. DNC stops unconditionally,
   above every campaign flag.
2. **Sweep enrollments** — leads matching the rule that this campaign has never
   seen, gated by `vcEvaluateEnrollment()` (consent, DNC, suppression, a phone
   number, and not already active in another campaign).
3. **Slots.** Three concurrent AI campaign calls per agent (`VC_SLOT_LIMIT`).
   Zero free means this agent dials nothing this minute and **nothing is
   claimed**. A call still `in_progress` past `VC_INFLIGHT_STALE_SECS` (40 min)
   stops counting — one lost hangup webhook must not stop an agent's campaigns
   permanently.
4. **Due enrollments**, oldest first, belonging to an active, unpaused campaign.
5. **Drip throttle** — the step's own `{per_minutes, max_calls}`, counted over a
   rolling window against `ai_calls (campaign_id, campaign_step, created_at)`.
   Being throttled is **not** a rescheduling: the enrollment stays due and the
   next tick tries again, so a 20-per-hour step drains across the hour on its own.
6. **Claim** — one conditional `UPDATE … RETURNING`.
7. **Dial** through `ai-call-start`, with an explicitly rotated caller ID.
8. **Handle the refusal**, if there was one.

## Idempotency — the claim

`voice-campaign-tick` runs every minute. If it dies halfway through, the next
one fires sixty seconds later and sees the same due enrollments. The claim
(`_shared/voice-campaign-claim.ts`) is what stops both dialing the same lead:

```sql
update voice_campaign_enrollments
   set claimed_at = now()
 where id = ? and status = 'active' and next_action_at <= now()
   and (claimed_at is null or claimed_at < now() - interval '10 minutes')
returning …
```

Postgres re-evaluates that `WHERE` **after** taking the row lock, so of two
concurrent ticks exactly one gets a row back. No advisory lock, no queue table.

It **leases** rather than latches (`VC_CLAIM_LEASE_SECS` = 10 min), because a
claim that never expired would be a lead nobody ever calls again. The claim is
released by `recordCampaignCallResult()` in the webhook's finalize block, not
by the tick — until the call ends, the enrollment is off the queue, which is
what stops a second call going out while the first is still connected.

`test/…/voice-campaign-flow.test.ts` drives two "concurrent" claims against a
fake client that models exactly that re-check.

## Gate rejections — three behaviours, chosen per code

`vcHandleGateRejection()` is the shape of the answer to "how should a scheduler
behave when the thing it schedules says no".

| Code | Action | Why |
|---|---|---|
| `daily_cap_reached` | **reschedule** at `resets_at` from the 429 body | the refusal has a stated expiry. Coming back in a minute, sixty times an hour, for the rest of the evening, is the failure mode |
| `quiet_hours` | **reschedule** at the next allowed instant | computed with the *same* predicate gate 4 uses (`isWithinAllowedHours` / `…UnknownTz` + `billing_config`), so "when does it open" and "is it open" can never become two answers |
| `insufficient_balance` | **pause the campaign** + a sentence on the card | it is about the ACCOUNT, not this lead — every enrollment would get the same answer. Retry-hammering an empty wallet fills a log and tells nobody |
| `ai_disabled`, `upgrade_required`, `no_caller_id` | **pause the campaign** | same reasoning |
| `not_callable`, `missing_lead_id` | **stop the enrollment** | about this LEAD and permanent until something else changes it. Leaving them queued re-asks the same question every tick, for ever |
| anything else (Telnyx 5xx, network) | **retry in 5 min** | ours or theirs; back off, keep the enrollment |

A paused campaign leaves its enrollment **due and unclaimed**, so it is first in
the queue the moment the agent tops up and presses Resume. A test asserts no
rejection path ever schedules a retry sooner than a minute out.

## Caller-ID rotation — this is what makes the meter honest

`docs/ai-call-meter.md` § "Left for the campaign-builder round" left this open,
with a note not to leave it silently. It is closed here.

The daily recommendation sums every active number's ramp value, but until now
every AI call went out on `agents.signalwire_caller_id` — so a two-number agent
was recommended 600 calls and all 600 landed on one number. Campaign calls now
pass an explicit `caller_id`, chosen by `vcPickCallerId()` as the number with
the most room left **against its own ramp**, using the same `numberRampValue()`
the meter and the gate use. Per-number usage comes from `ai_calls.from_e164`,
in the agent's own day.

- Ties break on the number itself so the choice is deterministic; because the
  winner's usage goes up the moment it dials, a tie alternates on the next call.
  **That is the rotation.**
- **A brand-new number is not preferred just because it is unused** — it is on
  ramp day 1 and recommended 30, so a mature number with 100 calls behind it
  (headroom 200) still wins. Confirmed against production in the dry run below.
- **Everyone over budget still returns a number.** The recommendation is advice;
  refusing to dial here would turn it into the wall `ai-call-meter.ts` exists to
  say it is not.
- `ai-call-start` now **verifies a requested caller ID belongs to the agent**
  (falling back to their primary if not). A rotation bug must not be able to
  dial from someone else's number; Telnyx would reject it, but "the connection
  rejected it" is a coincidence, not a boundary.

## `ai-call-start` has a second caller now

| Mode | Auth | agent from |
|---|---|---|
| the browser | the agent's session JWT | the verified token |
| `voice-campaign-tick` | **the service role key** as its bearer | `body.agent_id` |

This is the only branch in the codebase that reads an agent id from a request
body, and it is safe for exactly one reason worth naming: **the browser never
holds the service role key.** `ai-call-start` therefore stays `verify_jwt = true`
(it is *not* in `supabase/config.toml`) — the service key is itself a valid
Supabase JWT, so the same header satisfies the platform gate. Do not relax that.

`dry_run`, `enrollment_id`, `campaign_id`, `campaign_step` and `campaign_name`
are all gated on the same flag; a test asserts each one is.

## Row-level security

| Table | Policies |
|---|---|
| `voice_campaigns` | SELECT / INSERT / UPDATE / DELETE, all `auth.uid() = agent_id` |
| `voice_campaign_steps` | the same four; INSERT/UPDATE check the **campaign's** owner, because the row's `agent_id` is derived by a trigger and would not exist yet |
| `voice_campaign_enrollments` | **SELECT and nothing else** |

Campaigns and steps are the agent's own configuration — the same class as
`producer_codes` — so the browser writes them directly and triggers enforce
what must not be forged (the tag rule; the step's `agent_id`).

**An enrollment is a standing instruction to place phone calls to a consumer.**
A browser that could write one could enroll a lead with no consent, and the
compliance story would rest on the UI being polite. Every write goes through
`voice-campaign-tick` or `voice-campaign-manage` under the service role, and
`voice-campaign-manage` takes the agent **from the JWT** — there is no agent id
in its body. Do not add an INSERT or UPDATE policy.

## Steps

`wait_value` / `wait_unit` is the delay **after the previous step completed** —
including, for the first step, after enrollment. That is what lets "new lead
arrives → call within a minute" be step 1 with a one-minute wait.

`double_dial` makes a **second attempt about a minute after a no-answer**, twice
at most, then the campaign moves on. It does **not** retry when somebody
answered: dialing a person again sixty seconds after they picked up is the
behaviour that gets a number labelled.

`current_step_position` is the position of the step that runs **next**, not the
one that last ran.

## Stop conditions

`vcEvaluateStop()`, in order:

1. **DNC — unconditional**, above every campaign flag. `outcome='dnc_request'`,
   `leads.dnc`, or the call's own flag.
2. `stop_on_appointment_booked` and `ai_calls.appointment_id`.
3. `stop_on_sold` and the lead's `data.status`.
4. `stop_on_answered` and **talk length ≥ `stop_answer_talk_secs`** (default 15).

**"Answered" is a talk length, not a connect.** A lead who picked up, heard the
disclosure and hung up inside three seconds has not been spoken to, and dropping
them out of the campaign for it is how a book goes quiet. Talk time is computed
from `answered_at → ended_at` — the same two stamps the biller uses — and not
from `duration_secs`, which the finalize block may not have written yet at the
instant this runs.

## Verified in production, 2026-07-30 (no phone rang)

A synthetic campaign (`dry_run = true`) matching exactly one synthetic consented
lead out of a 122-lead book, enrolled through the real "Re-evaluate leads now"
endpoint with a real user JWT, then claimed by a real tick.

```
reevaluate  → {"ok":true,"matched":1,"enrolled":1,"skipped":{},"summary":"1 lead enrolled"}

tick        → slots {in_use: 0, free: 3}
            → dry_run_would_dial
                 would_dial   to +12025550147, from +12029981783, step 1,
                              assistant assistant-ddc05346-…, vars {lead_first,
                              lead_type "final expense", ai_name "Ashley",
                              campaign_name, campaign_step "1"}
                 gates_passed 1 kill switches · 2 plan tier ·
                              3 consent / DNC / suppression ·
                              4 lead-local quiet hours · 5 daily cap · 6 wallet floor
                 caller       +12029981783  recommended 150, used 11, headroom 139
                              (chose the MATURE number over an unused day-1
                               number whose headroom was only 30)
                 advance      next_step → position 2, due +2h, claim released

DB after    → status active, step 2, calls_placed 1, claimed_at null,
              next_action_at +2h, ai_calls rows written: 0
```

Then, with consent revoked on the same lead and the enrollment made due again:

```
tick        → gate_rejected {code: "not_callable"}
                 plan {action: "stop_enrollment", stop_reason: "not_callable",
                       next_action_at: null}
            → totals {stopped: 1, dialed: 0, errors: 0}
```

The pg_cron job was live throughout, firing every minute — `"nothing active"`
before the campaign existed, a full sweep while it did, and clean zero-work
ticks after it stopped. All synthetic rows were deleted afterwards.

## The twelve pre-built campaigns — SHIPPED

**Done, 2026-07-30.** `docs/voice-campaigns-defaults.md` +
`supabase/migrations/20260803_default_voice_campaigns.sql`. What changed in
*this* engine to carry them:

- **`sort_order`** on `voice_campaigns`, and the tick now orders by it. Load
  bearing: three of the twelve trigger on the same sale, and a lead may be
  active in only one campaign, so without an order the winner was arbitrary.
- **`trigger_on_appointment_booked`**, a fourth enrollment trigger, plus
  `voice_campaign_enrollments.appointment_id`.
- **Appointment-anchored steps** — `steps.anchor` / `offset_minutes` and
  `vcResolveNextDue()`, which SKIPS an anchored step whose moment has passed
  rather than firing it late.
- **`campaign_goal`**, which picks the reason clause of the spoken greeting.
- **The tag guard accepts four lifecycle statuses** (`sold`, `appointment`,
  `chargeback`, `lapsed`) as narrowing conditions. `status is new` still does
  not. See that doc § 3.

The notes below are the brief that round was written against; they are kept
because the reasoning still holds.

## What the next round (12 pre-built campaigns) needs from this engine

Everything a campaign is, is columns plus one jsonb rule blob, so a default is
a JSON object and nothing else. **`seed_key` is the seam**: `UNIQUE (agent_id,
seed_key)`, so re-seeding upserts rather than duplicating an agent's edits.

One caveat that will bite otherwise: the index is **partial**
(`where seed_key is not null`), because hand-made campaigns have a NULL key and
a total index would collide every one of them. A partial index cannot be
inferred from a bare column list, so the upsert must spell the predicate out —
`on conflict (agent_id, seed_key) where seed_key is not null` — which PostgREST
cannot express. **The seed therefore runs as SQL or inside an edge function,
never as a browser upsert.**

One example, complete:

```json
{
  "seed_key": "veteran_lead",
  "name": "Veteran Lead",
  "description": "Speed-to-lead on veteran leads, then two same-day retries.",
  "active": true,
  "trigger_groups": [
    { "conditions": [{ "field": "lead_type", "op": "is", "value": "veteran" }] }
  ],
  "auto_enroll_new_leads": true,
  "trigger_on_missed_appointment": false,
  "trigger_on_sold": false,
  "stop_on_appointment_booked": true,
  "stop_on_sold": true,
  "stop_on_answered": true,
  "stop_answer_talk_secs": 15,
  "steps": [
    { "position": 1, "step_type": "call",        "wait_value": 1, "wait_unit": "minutes" },
    { "position": 2, "step_type": "double_dial", "wait_value": 2, "wait_unit": "hours",
      "drip_rate": { "per_minutes": 60, "max_calls": 40 } },
    { "position": 3, "step_type": "call",        "wait_value": 1, "wait_unit": "days" },
    { "position": 4, "step_type": "call",        "wait_value": 3, "wait_unit": "days" },
    { "position": 5, "step_type": "call",        "wait_value": 7, "wait_unit": "days" },
    { "position": 6, "step_type": "call",        "wait_value": 14, "wait_unit": "days" }
  ]
}
```

Notes for whoever writes the seeder:

- **`active` on a seeded campaign is a decision, not a default.** Orion ships
  all twelve live on day 1. Every one of them still passes the full gate chain
  per call, and today **no lead in this production book carries TCPA consent**,
  so a live seeded campaign would enroll nobody until consent exists. Shipping
  them active is defensible; shipping them active *without saying so on screen*
  is not.
- **The tag values must match the words actually in `leads.data`.** The rule
  above matches `lead_type`, which resolves through `coverage_wanted` first —
  check what the book really contains before choosing a value.
- **`voice_campaign_steps.agent_id` is derived by a trigger.** Send it or don't;
  it is overwritten from the campaign either way.
- A campaign with **no steps enrolls nobody** (`vcFirstStep()` returns null and
  the sweep returns early), so seed steps in the same transaction.
- Twelve campaigns per agent do not multiply the work per tick: the outer loop
  is one indexed query over `voice_campaigns (active)`, and only enrollments
  that are actually due are read.

## Known-fragile

- **The slot count is per agent, campaign calls only.** A manual test-rig call
  does not consume a campaign slot. If an agent is on three campaign calls *and*
  hand-dials, four AI conversations can be live at once. Deliberate — the
  campaign queue should not be starved by manual work — but worth knowing.
- **`calls_placed` is a read-modify-write.** Two ticks incrementing the same
  enrollment concurrently could lose one, which cannot happen while the claim
  holds but would if the claim were ever removed. It is a display stat.
- **Saving the Steps tab deletes and re-inserts every step**, so positions are
  renumbered from the on-screen order. An enrollment mid-campaign keeps its
  position number and lands on whatever step now wears it — the same behaviour
  as editing a step in place, but it means reordering a live campaign moves
  people.
- **`voice-campaign-manage` reads at most 5,000 leads** per re-evaluation and
  enrolls at most 500; the tick's sweep reads 2,000 and enrolls 200 per campaign
  per tick. Both are logged in the response/trace rather than silently truncated,
  but a book larger than that needs paging.
- **The engine never re-enrolls a lead a campaign has already seen**, in any
  status. Re-running somebody through a finished campaign is a deliberate act
  that has no button yet.
