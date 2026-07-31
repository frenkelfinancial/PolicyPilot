# Text campaigns — the drip runs on the voice engine

**Added 2026-07-31.** Prompt SMS-2. Schema:
`supabase/migrations/20260807_sms_campaigns.sql`.
Decisions: section 13 of `supabase/functions/_shared/voice-campaign-core.ts`,
mirrored in the `// <vcamp-core>` block in `app.html`.
Send path: `supabase/functions/_shared/campaign-sms-send.ts`.
Engine: `supabase/functions/voice-campaign-tick` (the same one).
Actions: `supabase/functions/voice-campaign-manage` (the same one).
Tests: `npm run test:ai` (`campaign-sms.test.ts`, 54) and
`npm run test:smscampaigns` (32).

Read `docs/voice-campaigns.md` first — this extends that engine, it does not
sit beside it. Read `docs/sms-ai-responder.md` second: the conversation
responder is a **different feature** and the relationship between the two is
the thing most likely to be got wrong.

## The architecture choice, and why

**There are no new campaign tables.** `voice_campaigns`,
`voice_campaign_steps` and `voice_campaign_enrollments` grew a `channel`
column. One tick, one enrollment model, one claim, one set of stop conditions,
one manual door, one seeding seam.

The alternative — `sms_campaigns` / `sms_campaign_steps` /
`sms_campaign_enrollments` beside the voice ones — was rejected because it
produces **two of every single thing this feature is made of**: two ticks
racing the same minute, two definitions of "who may be enrolled", two claim
protocols, two "Add to campaign" doors, two seeders, two mission-control
screens. Every one of those pairs is a place where the two halves quietly start
disagreeing, and the only reason the voice engine is trustworthy is that there
is exactly one of each.

### Why the tables still say `voice`

A row in `voice_campaigns` with `channel = 'sms'` **is a texting campaign**.
The prefix is historical.

Renaming the three tables, the three edge functions, the pg_cron job, the
twelve seeded campaigns and roughly fifteen hundred lines of `app.html` would
be a large, risky change that buys nothing an agent can see — the word "voice"
appears nowhere in the product's UI for these; the screen is called
**Campaigns** and every card carries a channel badge. `channel` is the truth.

## What diverges, and it is only three things

Everything else — trigger matching, the enrollment model, the claim, the drip
arithmetic, `seed_key`, the manual door, pause/resume/remove — is byte-identical
code running for both channels.

| | Voice | Text |
|---|---|---|
| **Slots** | 3 concurrent, per agent | none — a text occupies nothing |
| **The action** | `ai-call-start` | `sendCampaignSms()` |
| **The hold** | — | defer while a conversation is live |

**Slots are voice-only and that is load-bearing.** Before this round the tick
returned early for the whole agent when three calls were in the air. Left
alone, that would have meant three calls silently stopping every text campaign
on the account. A test pins that the tick only gives up entirely when there is
no text work either.

## 🔴 The one rule, restated for text

**Every campaign text goes through `sendCampaignSms()`, and there is no second
path.** Consent, DNC, suppression and lead-local quiet hours are enforced once,
there, by `runComplianceGate` — the same function a hand-typed message and a
broadcast go through. `voice-campaign-tick` and `voice-campaign-manage` contain
no copy of any of them, and a test greps both for `runComplianceGate`,
`sendMessageCore`, `resolveTextingNumber` and `api.telnyx.com/v2/messages` and
asserts they appear in neither.

### Why it is not `messaging-send-sms`

Because that function **means "a person typed this"**. SMS-1 keys the AI
takeover on exactly that: a send through it mutes the responder on the thread
(`agent_takeover`), on the correct reasoning that the only thing reaching it is
a human at a keyboard. A campaign step routed through it would silence the
conversation AI on every lead it dripped at — which is the opposite of what a
drip is for. The drip opens the conversation; the responder is what answers it.

So: same gate, same sender resolution, same billing core, same thread writer, a
different caller, and `sent_by = 'ai'`.

## 🔴 One active campaign per lead PER CHANNEL

`voice_campaign_enrollments_one_active_uidx` moved from `(lead_id)` to
`(lead_id, channel)`.

Both halves matter. **Allowing both channels is the point of the feature** — a
speed-to-lead call sequence and a nurture text sequence are complementary, and
forcing a choice would make this builder useless to anybody already running
voice. **Forbidding two of a kind** is the original reason the index exists:
two robots texting the same person in one afternoon is exactly as bad as two
robots phoning them.

`channel` is denormalised onto the enrollment because a partial unique index
cannot reach another table, and it is **derived by a trigger**, never accepted
from a caller — a client-supplied channel could file a text enrollment as a
voice one and defeat the index it exists to serve.

## 🔴 A text campaign reads TEXT consent

`leads.tcpa_consent` is calling consent. Text consent is an unrevoked
`consent_records` row of an acceptable `consent_type` — the same fact
`runComplianceGate` reads, resolved the same way (most recent row per number
first, **then** check `revoked_at`, so a stale grant cannot beat a newer
revocation).

Likewise the suppression list is per channel: **`suppression_list` is the voice
AI's, `dnc_list` is what a texting STOP writes.** Reading the voice list for a
text campaign would enrol people who have already replied STOP; they would then
be refused one at a time by the send gate, but the campaign screen would have
spent the intervening days claiming it was about to text them.

`leads.dnc` stops **both** channels. A person who said "don't contact me" on
the phone did not mean "but do text me".

## The step model

Two types: `sms_message` (a body, optionally an attachment) and `wait`.

**Why `wait` exists when every step already has a wait.** Because that is how a
person describes a text sequence out loud — "send this, wait two days, send
that" — and a sequence written that way reads correctly in the editor. It costs
the engine nothing: `vcResolveNextDue()` **folds** a wait's delay into the next
actionable step's due time rather than waking up to do nothing. "send / wait 2d
/ send" and one step with a two-day wait produce the identical schedule and the
identical number of ticks, and `current_step_position` never lands on a step the
tick would not know what to do with.

- Consecutive waits add up.
- A sequence that **ends** in a wait completes when its last real step is done.
  Anything else leaves an enrollment waiting three days to do nothing.
- A folded wait and a step's own `wait_value` **compose** — one does not
  silently replace the other.
- **A campaign of nothing but waits has steps and nothing to do.** That is why
  every guard now asks `vcFirstActionableStep()` rather than `vcFirstStep()`: a
  count-based check passes, and the campaign enrols people and texts none of
  them for ever while showing green.

A voice campaign cannot contain a wait step (the steps trigger refuses one), so
`folded` is always empty there and voice pacing is untouched — pinned by a test
that runs the whole shipped Veteran Lead sequence through the changed function
and compares every due time.

## Merge variables

Six, and each names a field that genuinely exists on a lead or an agent in this
schema: `{{firstName}}`, `{{agentName}}`, `{{companyName}}`, `{{carrier}}`,
`{{coverageAmount}}`, `{{agentPhone}}`. A palette offering `{{policyNumber}}`
would be a promise the book cannot keep.

**🔴 A raw `{{…}}` never reaches a phone.** A known variable with no value gets
a fallback; an **unknown** one is removed entirely, and the result is tidied so
a hole does not surface as `"Hi , how are you"`. Every fallback is non-blank.
`{{agentPhone}}` falls back to **"this number"**, which is always literally
true — the lead is reading the message on the number it was sent from.

- **Rendered SERVER-SIDE at send time**, never stored rendered. A stored render
  texts somebody the coverage amount they had the day the campaign was written.
- The editor's live preview calls **the same `renderMergeVars()`** the send
  calls, against documented sample values. A preview computed by separate code
  is a preview that eventually lies.
- **`vcPersonName()` refuses an email address**, deriving from the local part
  instead. This is the `ppAgentName()` rule and it matters more here than
  anywhere it is already enforced: those protect what a colleague sees on a
  leaderboard, this decides what a **consumer** is told the agent is called.
  `agents.display_name` is null for most of the production book and the
  historical fallback was the login email.
- The character count and segment estimate are measured against the **preview**,
  not the template, and use `countSegments()` — the function the wallet bills
  on, so the estimate and the charge are the same arithmetic.

## The two rules that only exist for text

### End on reply (`stop_on_reply`, default true)

The drip stops when the lead writes back. Default true because the opposite
default is the one that embarrasses an agent: a lead who wrote "yes, call me"
and then received step 4 two days later has been ignored by a robot in front of
a witness.

**Measured against `enrolled_at`, not "any inbound ever".** Keying it on the
thread alone would immediately stop everybody who had ever replied to anything,
which is most of a working book. Confirmed in production: an inbound from
before the enrollment correctly did not stop it.

**It does not switch off the conversation responder.** SMS-1 answers an inbound
text wherever consent exists, whatever this column says — a different feature
with a different gate chain. The editor says so in as many words underneath the
checkbox, because an agent who unticks this expecting the opposite would be
confused by the lead getting an answer.

The stop reason is `replied` and it renders as **"They wrote back"** — the good
outcome the whole sequence was for. Wording it as a failure would make a working
campaign's Finished tab look like a graveyard.

### Hold on a live conversation (`pause_on_active_conversation`, default true)

**🔴 Not a stop and not a pause.** The enrollment stays active on the same step;
only the due time moves. A lead who asks a question on Tuesday still gets
Thursday's step on Thursday — they simply do not get it on top of their own
sentence.

"Live" is an inbound within `VC_SMS_CONVERSATION_WINDOW_HOURS` (24), **or** a
thread the agent has taken over by hand. A takeover outranks the inbound window
because it has no expiry, and is re-checked hourly rather than left due (which
would re-ask sixty times an hour) or stopped (which would throw away a sequence
because somebody answered one message by hand).

`last_gate_code` stores `live_conversation` / `agent_takeover` so the screen can
say **"They're mid-conversation — holding · next text Thu 9:00 AM"** instead of
a bare future timestamp, which reads as broken. It is display only and is
cleared the moment a text goes out — the same rule the voice engine follows.

A mute that is **not** a takeover (`booked`, `agent_toggle`, `opted_out`) does
not hold: none of them is somebody mid-sentence.

## Gate rejections — the same three behaviours

| Code | Action |
|---|---|
| `quiet_hours` | **reschedule** at the next legal instant, computed with the gate's own predicate |
| `daily_limit_reached` | **reschedule** at midnight UTC — which is when the carrier's window actually rolls over, and what the gate's own refusal says |
| `a2p_not_approved`, `no_sms_capable_number`, `insufficient_balance`, `upgrade_required` | **pause the campaign** with a sentence on the card |
| `no_consent`, `on_dnc_list`, `invalid_phone`, `missing_lead_id` | **stop the enrollment** |
| anything else | **retry in 5 minutes** |

A test asserts no path ever retries sooner than a minute. `no_consent` reaching
here means consent was **revoked underneath a live sequence** — the enrollment
gate already refused anybody who never had it.

## Send Test

**🔴 The destination is checked against the agent's own numbers, and that check
is the entire safety property.** Without it, "test this step" would be an
uncapped, unlogged way to text any number on earth with no consent record, from
an approved 10DLC number — precisely what the rest of this feature exists to
make impossible.

`resolveTestDestination()` accepts four sources, all of them things the agent
supplied about themselves: `agents.phone_e164` (**only** when
`phone_verified_at` is set — an unverified value is a string somebody typed),
`transfer_number`, `signalwire_caller_id`, and any row in `phone_numbers` they
own. The last three are needed because `phone_e164` is NULL for every agent that
existed at 20260804: the verification migration grandfathered all nine live
agents past the gate, so `phone_verified_at` is set and `phone_e164` is not.

Everything else about the send is **real**: the same renderer, the same
`resolveTextingNumber`, the same `sendMessageCore`, the same wallet hold, the
same Telnyx call, against the agent's most recent real lead so what comes back
is what a lead would actually receive. What it skips is `runComplianceGate`,
because the recipient is our customer rather than a consumer — the same
treatment the opt-out confirmation and the hot-lead alert already get.
Manufacturing a `consent_records` row for an agent's own cell would put a false
attestation in the table carrier review reads.

- It sends the **unsaved draft body**. Testing what is on screen is the point;
  demanding a save first makes the button useless for the edit you are checking.
- **It writes no conversation thread.** The agent's own cell is not a lead
  conversation, and a thread against it would appear in the inbox, be eligible
  for nudges, and be answerable by the responder — an AI texting its own agent.
  The `messages` row is the record and its preview says `[Campaign test]`.

## MMS

A per-step `media_url` in the `campaign-media` storage bucket, under a folder
named with the agent's own uid — the write policy keys on that first path
segment, so the path convention is the boundary rather than a naming habit. Its
presence makes the send an MMS (flat `mms_mills`) rather than an SMS
(per-segment).

The bucket is **public-read, and that is forced rather than chosen**: Telnyx
fetches `media_urls` from its own infrastructure with no Authorization header we
control, so a signed URL would have to be minted at send time and would expire
mid-retry. What keeps it safe is the write side, plus the fact that the only
thing anybody puts there is a picture they are about to text to strangers.

5 MB ceiling in the bucket, 1 MB warning in the editor — carriers re-encode MMS
aggressively and most reject over ~1 MB outright.

## The daily text count

**🔴 Counted, not capped. There is no text limit of ours and this must not grow
into one.** `ai_daily_call_cap` and the ~300/number/day recommendation exist
because a number that *dials* too much gets spam-labelled. Texting throughput is
carrier-assigned per 10DLC campaign, and the sole-proprietor ~1,000/day ceiling
is already refused by `runComplianceGate` with its own message and its own reset
time. Inventing a second, made-up number here and calling it a recommendation
would be advice nobody can support.

So the meter card shows the count, per number, and says that texting has no
daily limit of ours. A test asserts the meter block contains no verdict, no
state, no threshold and no recommendation — a future round wanting a text cap
has to add one deliberately rather than inherit one.

`sms_messages` grew `campaign_id` / `campaign_step` / `enrollment_id`, mirroring
`ai_calls` exactly, for the same two reasons: the drip window must be one
indexed query, and a campaign's history has to survive an enrollment being
deleted with its lead. **There is no second event log** — the activity feed
reads `sms_messages`, exactly as the voice feed reads `ai_calls`.

## What the screen does

One list, both channels, a badge on every card and a filter that only appears
once an account actually has both. The numbers on a card are **per channel**:
a text campaign shows texts sent and replies, a calling campaign shows calls
placed and answers. "Calls placed: 4" on a campaign that has never dialled
anybody is a small lie that costs the whole card its credibility.

**The channel is chosen at creation and is fixed.** Switching an existing
campaign would leave every step of the wrong type (the database refuses them),
every enrollment on the wrong side of the one-per-lead-per-channel index, and
its whole history describing something it no longer is. Making a second campaign
costs one click.

Two consent banners, not one: calling consent and texting consent are different
permissions, an account can easily have one and not the other, and a single
"record consent" banner would send an agent to tick a box that does not unblock
the campaigns they are looking at.

The three assignment doors are unchanged and list text campaigns with their
badge. The consent chain from a text campaign carries a **note** saying the
text-message box is the one that unblocks it — deliberately **not** a pre-tick.
That box attests to what a consumer agreed to; it is unticked on every open,
never remembered, and never set on somebody's behalf. A test pins that there is
exactly one writer of it and that it only ever writes `false`.

## Verified in production, 2026-07-31 (no text was sent)

A synthetic campaign (`dry_run = true`) matching exactly one synthetic lead —
deliberately created with **`tcpa_consent = false`** and a recorded
`consent_records` row, so the run proves the text campaign reads text consent
and not the calling flag.

```
tick 1 (production state untouched)
  enrolled     1                      ← enrolled on TEXT consent, tcpa_consent false
  slots        {in_use: 0, free: 3, has_sms: true}
  gate         no_sms_capable_number
  plan         pause_campaign · "Paused: none of your numbers is set up for
               texting yet. Check Settings → Texting."

tick 2 (sms_capable temporarily true on the owner's own +12029981783)
  dry_run_would_text
    to           +12625550147   from +12029981783   step 1   3 segments
    rendered     "Hi Dry, it's Jace Frenkel with Frenkel Financial — still
                  want me to look at that Mutual of Omaha quote for $25,000?
                  Reply here or call (202) 998-1783."
    gates_passed 1 A2P registration approved · 2 recipient SMS consent
                 (express written) · 3 do-not-contact list · 4 lead-local
                 quiet hours · 5 sending number is campaign-attached
    advance      next step → position 3, due +2 days   ← THE WAIT FOLDED

tick 3 (a conversation two hours old, stop_on_reply off)
  sms_held     reason live_conversation, until +24h from THEIR message
  DB after     step 1 (unchanged), last_gate_code live_conversation, active

tick 4 (their inbound predates the enrollment, stop_on_reply on)
  sms_held     again — correctly. A reply from before enrollment is not a
               reply to this campaign.

tick 5 (they write back NOW)
  swept_stop   reason "replied"
  DB after     status stopped, stop_reason replied, next_action_at null
```

Afterwards: `messages` to the test number **0**, `sms_messages` with a
`campaign_id` **0** account-wide, `sms_capable` restored to false on every
number, every synthetic row deleted. The unscoped tick then swept all 9 agents
and 97 live voice campaigns with 0 errors and 0 work.

**The validate trigger caught the dry run's own seed** on its first attempt: a
campaign row is necessarily written before the steps that reference it, so
`active = true` on the insert raises "This text campaign has no message steps".
See the seed format below.

## Known-fragile / open

- **🔴 NO NUMBER ON THIS ACCOUNT HAS `sms_capable = true`.** All 7 rows in
  `phone_numbers` are false, so today every text campaign on every agent would
  pause immediately with the sentence above. The A2P campaign `CD2166Q` is
  ACTIVE and billed, so this is the number→campaign assignment not having run
  or not having propagated — a pre-existing gap in the 10DLC path, not
  something this round introduced. **This is the one thing standing between
  this feature and a live send.**
- **Two carrier review items on `CD2166Q` are still open** (see
  `docs/a2p-campaign-draft.md`). Nothing here changes the campaign
  registration, and nothing here should be switched on for real traffic before
  those are resolved.
- The channel filter, the badge and the per-channel numbers are all derived
  from `channel`; nothing caches it.
- **Saving the Steps tab still deletes and re-inserts every step.** `body` and
  `media_url` are carried through the save the same way `anchor` and
  `offset_minutes` are — a field that tab forgets is a field it silently
  erases.
- `sms_messages.lead_id` does not exist; the feed resolves a lead through the
  enrollment's `conversation_id`, which is set on the first send. A campaign
  message sent before that column existed would show as "a lead".

## What SMS-3 needs from this engine

Everything a campaign is, is columns plus one jsonb rule blob, so a default is a
JSON object and nothing else — exactly as the voice defaults are. `seed_key` is
the same seam, with the same partial-index caveat: `on conflict (agent_id,
seed_key) where seed_key is not null` cannot be expressed by PostgREST, so
**the seed runs as SQL or inside an edge function, never as a browser upsert.**

**🔴 THE ORDER IS INSERT-INACTIVE → STEPS → ACTIVATE, IN ONE TRANSACTION.**
`voice_campaigns_validate()` refuses an ACTIVE text campaign that has no
`sms_message` steps, and a campaign row is necessarily written before the steps
that reference it. `active: true` on the insert raises every time. This is not
avoidable and should not be worked around by relaxing the trigger — a live text
campaign with nothing to say enrols people and messages none of them.

Also note:
- `voice_campaign_steps.agent_id` is derived by a trigger; send it or don't.
- A `call` step in a text campaign is refused by the steps trigger, and vice
  versa.
- Every trigger group still needs a positive narrowing condition — the tag rule
  is unchanged and applies to both channels. A text campaign that messages a
  whole book is the same mistake as a call campaign that phones one.
- The twelve voice defaults' `seed_key`s ARE the twelve `sms_ai_settings`
  campaign types, and `sendCampaignSms` passes `seed_key` through as the
  conversation's `campaign_type` — so a lead a text campaign opens a
  conversation with gets answered by SMS-1 in the matching voice, with no
  mapping table. **Keep the seed keys aligned with `SMS_AI_TYPES`.**

One example, complete:

```json
{
  "seed_key": "final_expense_nurture",
  "name": "Final Expense — text nurture",
  "description": "Three texts over a week for final-expense leads who went quiet.",
  "channel": "sms",
  "active": true,
  "trigger_groups": [
    { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "final_expense" }] }
  ],
  "auto_enroll_new_leads": true,
  "stop_on_reply": true,
  "pause_on_active_conversation": true,
  "stop_on_sold": true,
  "stop_on_appointment_booked": true,
  "steps": [
    {
      "position": 1, "step_type": "sms_message",
      "wait_value": 5, "wait_unit": "minutes",
      "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}} — you asked about final expense cover. Want me to send a couple of options? Reply STOP to opt out."
    },
    { "position": 2, "step_type": "wait", "wait_value": 2, "wait_unit": "days" },
    {
      "position": 3, "step_type": "sms_message",
      "body": "{{firstName}}, still happy for me to put those numbers together?",
      "drip_rate": { "per_minutes": 60, "max_calls": 40 }
    },
    { "position": 4, "step_type": "wait", "wait_value": 5, "wait_unit": "days" },
    {
      "position": 5, "step_type": "sms_message",
      "body": "Last one from me, {{firstName}} — just reply here if you'd still like a quote. — {{agentName}}"
    }
  ]
}
```

Notes on that shape:

- `drip_rate.max_calls` is the column name and it means **messages** on a text
  campaign. Renaming it would have been a migration on a live voice table to
  fix a word.
- `wait_value` on step 1 is the delay after **enrollment**.
- The step's own `wait_value` and a preceding `wait` step compose, so do not
  set both unless you mean the sum.
- Every `sms_message` body must be non-empty and use only the six documented
  variables, or activation raises.
