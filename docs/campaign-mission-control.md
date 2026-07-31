# Campaign mission control — see it working, and let the verdict reach the lead

**Added 2026-08-05.** Prompt J. Schema:
`supabase/migrations/20260805_campaign_mission_control.sql`.
Outcome → lead mapping: `supabase/functions/_shared/ai-lead-effect.ts`, mirrored
in the `// <leadeffect-core>` block of `app.html`.
Screen rules: the mission-control half of
`supabase/functions/_shared/voice-campaign-core.ts`, mirrored in
`// <vcamp-core>`.
Actions: `supabase/functions/voice-campaign-manage` (`enrollment_action`).
Applied from: `ai-call-webhook`'s finalize block.
Tests: `npm run test:ai` (`ai-lead-effect.test.ts`,
`voice-campaign-mission.test.ts`) and `npm run test:mission` (browser ↔ server
parity + source invariants).

Builds directly on Prompt I's manual enrollment door — same planner discipline,
same `preview`-is-the-plan rule. Read `docs/voice-campaigns.md` first.

## The product, in one paragraph

A campaign used to be a rule builder with a count on it: you described who to
call, pressed save, and then had no way to watch it happen. Opening one now
shows the leads it is working, what happened on each call, what is next — and,
the part that did not exist at all, **why a lead that is not being called is not
being called**. Every reason was already known to the engine and thrown away.

## Part 1 — The Leads table

The campaign's Enrollments tab is now its main event. One row per enrolled
lead:

| Column | Where it comes from |
|---|---|
| Name + number | `leads`, indexed in the browser |
| Lead status chip | `leads.data.status`, the same chip the leads board draws |
| Progress | `vcStepProgressLabel(position, steps)` → "Step 2 of 6" |
| Last call result | `vcLastCallLabel(call)` + `vcRelTime` → "No answer · 2h ago" |
| Next call | `vcNextAction()` → see below |

Row click opens the **existing** lead view — `vcampOpenLead()` navigates to the
Leads screen, expands the row through the same `expandedLeadIds` set the leads
screen uses, and scrolls to it. It renders no lead markup of its own; a test
asserts that. The call's transcript and AI summary open from the same table
through `vcampOpenCall()`.

Paginated at 25 (`VCAMP_PAGE_SIZE`), reading at most `VCAMP_CALL_WINDOW = 500`
of the campaign's calls. The selection lives in `vcampState.sel`, outside the
DOM, so it survives paging and every 10-second refresh — the same rule the
leads screen's own selection follows.

### Why a lead is waiting — `vcNextAction()`

**The negative cases are the whole point.** "Tomorrow 9:05 AM" on a screen an
agent opened *because nothing seems to be happening* reads as a broken product.

| Verdict | When | What the row says |
|---|---|---|
| `calling` | an `ai_calls` row for this lead is `in_progress` | "Calling now…" |
| `paused_lead` | `status = 'paused'` | "Paused 20m ago" |
| `ended` | stopped / completed | "—" |
| `waiting_on_call` | claimed, nothing due | "Call in progress…" |
| `paused_campaign` | `campaigns.paused_at` | "Campaign paused" |
| `campaign_off` | `active = false` | "Campaign switched off" |
| `due` | `next_action_at <= now` | "Due now" |
| `scheduled` | in the future | reason · "next call 9:05 AM" |

The reason comes from **`voice_campaign_enrollments.last_gate_code`**, new in
this migration. `vcHandleGateRejection()` already decided it and discarded it:
a `quiet_hours` refusal and a `daily_cap_reached` refusal both came out the far
side as nothing but a later date.

- Written by `voice-campaign-tick` on a reschedule: `quiet_hours` and
  `daily_cap_reached` verbatim, everything else as `retry_soon` ("a hiccup on
  the line — retrying" is the true and complete answer for a Telnyx 5xx).
- **Cleared the moment a call goes out** — in the tick when it dials, and in
  `recordCampaignCallResult()` when the call finishes. A stale reason outliving
  its wait is how a screen ends up explaining a pause that is not happening.
- **Display only.** The engine branches on `vcHandleGateRejection`'s plan and
  never on this column. A deferral that says "quiet hours" and one that says
  nothing behave identically; the difference is entirely in whether the agent
  can tell a working campaign from a broken one.

## Part 2 — The activity feed

Newest first, last 50 (`VCAMP_FEED_LIMIT`), built by `vcFeed()` from the
`ai_calls` rows that already exist:

```
2:14 PM — Called Mark J. — no answer · retry tomorrow 10:00 AM
2:09 PM — Booked an appointment with Lisa P.
1:58 PM — Ray T. asked to stop — do-not-call recorded
```

**No second event log.** `ai_call_events` is the Telnyx webhook's diagnostic
trace, service-role-only, keyed to Telnyx payloads with no `agent_id`; this
feature deliberately does not start a rival to it. A test asserts the browser
never reads it. The only schema addition is one index,
`ai_calls_campaign_created_idx (campaign_id, created_at desc)` — the existing
`ai_calls_campaign_step_created_idx` leads on `campaign_step` and cannot serve
an ordering across all steps without a sort.

Three details worth keeping:

- **A live call reports itself as live whatever the outcome column says.** The
  row is written `outcome = 'in_progress'` at dial time and only settles at
  hangup; a feed that trusted the column would announce a result mid-call.
- **A nameless lead never produces "Called ."** — it falls back to "a lead",
  the same reasoning as `buildGreeting()`'s four openers.
- **A retry is only named while the campaign is still going to make one.** A
  stopped enrollment has no `next_action_at`, so the clause stays empty rather
  than promising a call that will not come.

Campaign cards carry two live numbers: **Calling now** (in-flight) and today's
calls placed, bucketed from `vcampDayStartIso()` — midnight in the agent's own
browser, the same day `agents.timezone` means.

Both the table and the feed refresh by polling every 10 seconds, and **stop
when nobody is looking**: the section must be `.active` and
`document.visibilityState` must be `visible`. An agent who leaves this open in
a background window all afternoon should not pay for a query every ten seconds
to render nothing.

## Part 3 — What a call does to the lead

The owner's question was "does the AI update the status?" and until now the
honest answer was "partly, in two places, and nowhere written down". This is
that mapping, in one table, applied in one place.

### The mapping

| Outcome | Lead status | Flag | Disposition chip |
|---|---|---|---|
| `appointment_booked` | → **`appointment`** | — | Booked an appointment |
| `not_interested` | → **`not_interested`** | — | Not interested |
| `dnc_request` | *unchanged* | **do-not-call raised** | Asked not to be called |
| `transferred` | *unchanged* | — | Transferred to you |
| `qualified` | *unchanged* | — | Qualified |
| `callback_requested` | *unchanged* | — | Asked for a callback |
| `completed` | *unchanged* | — | Spoke with the AI |
| `no_answer` | *unchanged* | — | No answer |
| `voicemail` | *unchanged* | — | Voicemail |
| `busy` | *unchanged* | — | Busy |
| `error` | *unchanged* | — | **none** |
| `in_progress` | *unchanged* | — | **none** |

All twelve values of the `ai_calls_outcome_check` constraint appear, including
the ones whose answer is "nothing" — an outcome missing from the table would
silently do nothing, and "nothing" has to be a written decision rather than a
gap. A test compares the table against the constraint's own list.

**The two rules that shape it:**

1. **A missed call is not a pipeline event.** `no_answer`, `voicemail` and
   `busy` change no status. A six-step campaign dialling somebody five times
   would otherwise walk that lead back to "No Answer" on every attempt,
   overwriting whatever a human decided, and the leads board — the thing the
   agent actually works from — would become a log of the robot's afternoon.
2. **Sold is human, always.** Nothing here writes `sold` and nothing here
   writes over it. A sale is a policy, a signature and money; the AI has no way
   to know one happened and no business asserting it.

`appointment_booked` writes the **same** `appointment` value the lifecycle
campaigns trigger on (`VC_LIFECYCLE_STATUSES`), so the Appointment Reminder
campaign fills itself off a booking the AI made with no second vocabulary in
between. Nothing in this module may invent a status: a new value would land in
a book humans filter, sort and count on, and no screen would know what to call
it. A test checks every written status against `STATUS_CONFIG`.

`dnc_request` deliberately leaves the status alone. "Do not call me" is not a
stage of a sales pipeline, and burying it in the status column is how it stops
being visible as a legal instruction — the flag and the chip are where it
shows, and the suppression row is what enforces it.

`error` gets no disposition at all. It means **we** broke; hanging a
disposition on the consumer for our own failure would be a lie on their record.

### 🔴 The ordering guard, and why it needed a database half

`aiStatusVerdict()` refuses to write when the lead's `status_at` is later than
the call's start: somebody knew something we did not, and insights land ~8
seconds after the hangup, so a human can easily have clicked in between. A lead
with **no** stamp is the ordinary case (every lead in the production book
predates the column) and gets written — no stamp is evidence of nothing.

That alone was not enough. `public.leads` is owner-writable and the lead book
is a browser-side app: **`sbUpsertAllLeads()` sends every lead's `data` blob,
from memory, on every save.** So a status the AI wrote at 2:04 PM was silently
reverted at 2:05 PM when the agent edited an unrelated lead's notes — not by a
conflicting decision, but by a stale copy of the old one. This is the same trap
that keeps appointments out of `leads.data`, and it is exactly why the question
had no honest yes.

So a status write now carries two companions in the same blob:

- **`status_at`** — when the decision was taken
- **`status_source`** — `ai` or `human`

and `leads_preserve_ai_status()` (20260805) reads the difference: a deliberate
edit stamps a fresh `status_at` and wins; an equal-or-older stamp arriving over
an AI-set status is an echo, not a decision, and is put back.

Which makes the browser's side of the bargain load-bearing:
**`ppSetLeadStatus()` is the only place this browser writes a lead status.**
There were five, and that was fine right up until the AI started writing them
too. A test asserts nothing else assigns a status onto a lead.

Two enforcement points for one rule, on purpose: the edge function's is what
decides not to write, and the trigger is what stops the write being undone.

Supporting details:

- **`pp_jsonb_ts()` parses those stamps.** A bare `::timestamptz` on a
  malformed string raises inside a `BEFORE` trigger and takes the agent's whole
  save with it — a display field turning into an outage.
- **The guard only protects a status the AI set.** A status one human set and
  another human is changing is none of the trigger's business.
- **Browser writes only** (`auth.role()` is `authenticated`/`anon`), like
  `leads_protect_consent_columns` above it. The service role is the only thing
  that writes `status_source = 'ai'` and always stamps fresh, so it would pass
  anyway.
- **The disposition is preserved against its own stamp,** unconditionally. It
  records what happened on a call rather than where the lead sits: a human
  moving the lead to Appointment afterwards does not make "no answer at 2:04"
  untrue.
- **`leadEffectsSync()` pulls the server's verdict back into the browser** every
  60 seconds while the tab is visible, newest-stamp-wins in both directions, and
  writes **localStorage only** — pushing it back would be a whole-book upsert to
  tell the server something it already knows.

The effect is applied in `ai-call-webhook`'s finalize block **before**
`recordCampaignCallResult()`, so the enrollment's stop evaluation reads the lead
as it now stands — a lead who just asked not to be called must be seen with the
flag already up. `applyLeadEffect()` never throws: it runs after the wallet has
been debited, and a bookkeeping failure must not make Telnyx replay a call that
is paid for and finished.

## Pause, resume, remove, move

All four go through `voice-campaign-manage`, agent from the JWT, no agent id in
the body. **`voice_campaign_enrollments` stays SELECT-only for the browser** —
an enrollment is a standing instruction to phone a consumer, and a "pause"
button is not a good enough reason to open that door. The migration adds no
write policy and a test asserts app.html never `.insert()`/`.update()`s the
table.

| Op | What it writes | Why |
|---|---|---|
| **pause** | `status='paused'`, `paused_at`, `claimed_at=null` | The tick's due query and `vcClaimEnrollment` both require `'active'`, so a paused enrollment is simply never picked up. No new flag for the engine to honour, and therefore no way for it to forget. |
| **resume** | `status='active'`, `paused_at=null` | Two statements: `next_action_at` is repaired only when null. |
| **remove** | `status='stopped'`, `stop_reason='removed_by_user'` | Records a decision. Never deletes. |
| **move** | stop then insert (Prompt I) | `stop_reason='moved_by_user'`, stop **before** the insert. |

- **`next_action_at` is left alone by pause**, so resuming puts the lead back
  where it was in the queue rather than at the front.
- **Resume repairs a null `next_action_at`.** A pause taken while a call was in
  the air leaves it null (the tick clears it before dialing). Resuming without
  repairing would leave a lead active, never due, and never called again — the
  exact silent failure this screen exists to make impossible.
- **Resume re-checks for a conflict.** `voice_campaign_enrollments_one_active_uidx`
  is partial on `status = 'active'`, so pausing *releases* the lead to be
  enrolled elsewhere. Catching that here turns a raw 23505 into a sentence.
- **`removed_by_user` is distinct from `manual`** (the old single-lead Unenroll)
  and from `moved_by_user`, so all three stay tellable apart on every row that
  already carries one.
- **Remove touches neither `dnc_list` nor `suppression_list`.** "Take them out
  of this campaign" and "this person told me never to call again" are different
  statements, and collapsing them misreports both.

**Preview and write are the same call with one flag.** Both build the plan with
`vcPlanEnrollmentAction()`; `preview: true` returns the counts without writing.
Same discipline as `preview_enroll` / `enroll_leads`, and for the same reason: a
count computed by separate code is a count that eventually lies, and these
buttons act on somebody's live calling program. Bulk actions confirm against
that preview; single-row ones do not, because one lead is small, visible and
reversible while forty are not.

## Deliberately not built

- **No new event-log table.** The feed reads `ai_calls`. See above.
- **No `not_interested` invention.** It mapped to a status that already exists
  in `STATUS_CONFIG`; had it not, it would have been a chip only. The prompt
  allowed a new value and the vocabulary did not need one.
- **No lead-status write from the tick.** Only the webhook's finalize applies an
  effect, because only it knows how the call ended.
- **No virtualization.** Pagination at 25 with a 500-call window covers
  "hundreds of enrollments" comfortably; a virtual list is a second scroll
  implementation to maintain for a case nobody has yet.
- **Re-enrolling a lead a campaign has already seen** still has no button, same
  as Prompt I.
