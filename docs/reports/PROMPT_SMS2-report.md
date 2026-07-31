# PROMPT SMS-2 — SMS campaign builder: text drips on the same engine as voice

**Completed 2026-07-31.** Prompt: `prompts/PROMPT_SMS2_sms_campaign_builder_CLAUDE_CODE.md`.
Commit: `8599253` — *"A campaign can text now, and it is the same campaign"*.
Schema: `20260807_sms_campaigns.sql` (applied + verified).
Docs: `docs/sms-campaigns.md`. Suite: **1,614 passing, 0 failing** (+87).

> **Filed as a backfill on 2026-07-31.** The SMS-2 round shipped its code,
> schema, docs and tests but never committed the report the prompt asked for.
> Everything below is reconstructed from the repository at `8599253` — the
> commit message, `docs/sms-campaigns.md`, the CLAUDE.md section, the migration
> and the shipped code. Nothing here is new work and nothing here is invented;
> where the repo is the only witness to a production run, it is quoted rather
> than paraphrased.

---

## 1. The architecture decision, and why

The prompt gave a preference and a test: *"prefer extending the existing
campaign schema/engine with a `channel` (`voice` | `sms`) over parallel tables —
but read the actual code first and choose whichever keeps ONE tick, ONE
enrollment model, ONE set of stop conditions, and ONE assignment path."*

**Chosen: extend. There are no new campaign tables.**

`voice_campaigns`, `voice_campaign_steps` and `voice_campaign_enrollments`
each grew a `channel` column (`voice` | `sms`). A row in `voice_campaigns` with
`channel = 'sms'` **is a texting campaign**, and it is run by the engine that
was already there — the same `voice-campaign-tick` sweep, the same trigger-group
matching, the same enrollment model, the same claim, the same drip arithmetic,
the same manual door (`voice-campaign-manage`), and the same `seed_key` seam.

**The alternative was rejected on a specific ground.** `sms_campaigns` /
`sms_campaign_steps` / `sms_campaign_enrollments` beside the voice ones produces
**two of every single thing this feature is made of**: two ticks racing the same
minute over the same tables, two definitions of "who may be enrolled", two claim
protocols that do not know about each other, two "Add to campaign" doors, two
seeders, two mission-control screens. Every one of those pairs is a place where
the two halves quietly start disagreeing, and the only reason the voice engine is
trustworthy is that there is exactly one of each.

**Why the tables still say `voice`.** The prefix is now historical. Renaming
three tables, three edge functions, a pg_cron job, the twelve seeded campaigns
and roughly fifteen hundred lines of `app.html` would be a large, risky change
that buys nothing an agent can see: the word "voice" appears nowhere in the
product's UI for these. The screen is called **Campaigns**, every card carries a
channel badge, and **`channel` is the truth**.

### The three divergences — and there are exactly three

Everything else — trigger matching, the enrollment model, the claim, the drip
arithmetic, `seed_key`, the manual door, pause/resume/remove — is byte-identical
code running for both channels.

| | Voice | Text |
|---|---|---|
| **Slots** | 3 concurrent, per agent | none — a text occupies nothing |
| **The action** | `ai-call-start` | `sendCampaignSms()` |
| **The hold** | — | defer while a conversation is live |

1. **Slots are voice-only, and that is load-bearing.** Before this round the
   tick returned early *for the whole agent* when three calls were in the air.
   Left alone, that would have meant three phone calls silently stopping every
   text campaign on the account. A test pins that the tick only gives up
   entirely when there is no text work either.

2. **The step action is `ai-call-start` or `sendCampaignSms()`.** Every campaign
   text goes through `_shared/campaign-sms-send.ts` and there is no second path:
   `runComplianceGate` → `resolveTextingNumber` → `sendMessageCore` → the
   `sms_messages` thread. `voice-campaign-tick` and `voice-campaign-manage`
   contain no copy of any of them, and a test greps both for
   `runComplianceGate`, `sendMessageCore`, `resolveTextingNumber` and
   `api.telnyx.com/v2/messages` and asserts they appear in neither.

   **It is deliberately NOT `messaging-send-sms`.** That function *means* "a
   person typed this", and SMS-1 keys the AI takeover on exactly that: a send
   through it mutes the responder on the thread (`agent_takeover`). A campaign
   step routed through it would silence the conversation AI on every lead it
   dripped at — the opposite of what a drip is for. The drip opens the
   conversation; the responder is what answers it. So: same gate, same sender
   resolution, same billing core, same thread writer, a different caller, and
   `sent_by = 'ai'`.

3. **SMS adds a live-conversation hold that voice has no equivalent of.**
   `pause_on_active_conversation` (default true) is **not a stop and not a
   pause**: the enrollment stays active on the same step and only the due time
   moves. "Live" is an inbound within `VC_SMS_CONVERSATION_WINDOW_HOURS` (24)
   **or** a thread the agent has taken over by hand; a takeover outranks the
   inbound window because it has no expiry, and is re-checked hourly rather than
   left due (sixty re-asks an hour) or stopped (throwing away a sequence because
   somebody answered one message by hand). `last_gate_code` stores
   `live_conversation` / `agent_takeover` so the screen can say **"They're
   mid-conversation — holding · next text Thu 9:00 AM"** instead of a bare
   future timestamp, which reads as broken.

### The rules that came with the choice

- **🔴 One active campaign per lead PER CHANNEL.**
  `voice_campaign_enrollments_one_active_uidx` moved from `(lead_id)` to
  `(lead_id, channel)`. Both halves matter: allowing one of each is the point of
  the feature (a speed-to-lead call sequence and a nurture text sequence are
  complementary, and forcing a choice would make this builder useless to anybody
  already running voice); forbidding two of a kind is the original reason the
  index exists. `channel` is denormalised onto the enrollment because a partial
  unique index cannot reach another table, and it is **derived by a trigger**,
  never accepted from a caller.
- **🔴 A text campaign reads TEXT consent.** `leads.tcpa_consent` is *calling*
  consent. Text consent is an unrevoked `consent_records` row of an acceptable
  `consent_type` — the same fact `runComplianceGate` reads, resolved the same
  way. Likewise the suppression list is per channel: **`suppression_list` is the
  voice AI's, `dnc_list` is what a texting STOP writes.** `leads.dnc` stops
  both.
- **A `wait` step folds into the next actionable step** (`vcResolveNextDue()`),
  so it costs no tick and never becomes a `current_step_position`. Every "has
  steps?" guard now asks `vcFirstActionableStep()` — a campaign of nothing but
  waits passes a count check, then enrols people and texts none of them for ever
  while showing green. A voice campaign cannot contain a wait (the steps trigger
  refuses it), so `folded` is always empty there; a test runs the whole shipped
  Veteran Lead sequence through the changed function and compares every due time.
- **🔴 A raw `{{…}}` never reaches a phone.** Six variables
  (`{{firstName}}`, `{{agentName}}`, `{{companyName}}`, `{{carrier}}`,
  `{{coverageAmount}}`, `{{agentPhone}}`), each with a non-blank fallback; an
  unknown one is stripped and the sentence tidied after it. Rendered
  **server-side at send time**, never stored rendered, and the editor's live
  preview calls the same `renderMergeVars()`. `vcPersonName()` refuses an email
  address — the `ppAgentName()` rule, and it matters more here because this
  decides what a **consumer** is told the agent is called.
- **`stop_on_reply` is measured against `enrolled_at`**, not "any inbound ever",
  and it does **not** switch off the SMS-1 responder.
- **Send Test only reaches the agent's own numbers**, and that check is the
  entire safety property; everything else about it is real, including the charge.
- **The daily text count is counted, not capped.** There is no text limit of
  ours; inventing one would be advice nobody can support.

## 2. 🔴 Current blocker — no number on this account is SMS-capable

**All 7 rows in `phone_numbers` have `sms_capable = false`** (checked
2026-07-31, at the time of the SMS-2 round). So today every text campaign on
every agent enrols normally, reaches the send gate, and is refused with
`no_sms_capable_number` — at which point the engine **pauses the campaign** and
writes a sentence onto the card:

```
Paused: none of your numbers is set up for texting yet.
Check Settings → Texting.
```

That is the designed behaviour for an account-level refusal (see the gate table
below), not a fault in this round.

The A2P campaign `CD2166Q` is **ACTIVE and billed**, so this is the
number→campaign assignment not having run or not having propagated — a
pre-existing gap in the 10DLC path, the same one SMS-1's report ended on.
`+12029981783` is the only number on a messaging profile and it has no campaign.

**This is the one thing standing between this feature and a live send.** It is
also why the SMS-2 production dry run had to temporarily flag `sms_capable` on
the owner's own number to exercise the render/fold path, and restored it to
false afterwards.

Two carrier review items on `CD2166Q` are also still open (see
`docs/a2p-campaign-draft.md`). Nothing in SMS-2 changes the campaign
registration, and nothing here should be switched on for real traffic before
those are resolved.

### Gate rejections — the same three behaviours as voice

| Code | Action |
|---|---|
| `quiet_hours` | **reschedule** at the next legal instant, computed with the gate's own predicate |
| `daily_limit_reached` | **reschedule** at midnight UTC — when the carrier's window actually rolls over |
| `a2p_not_approved`, `no_sms_capable_number`, `insufficient_balance`, `upgrade_required` | **pause the campaign** with a sentence on the card |
| `no_consent`, `on_dnc_list`, `invalid_phone`, `missing_lead_id` | **stop the enrollment** |
| anything else | **retry in 5 minutes** |

A test asserts no path ever retries sooner than a minute.

## 3. The `enrolled_by` CHECK constraint — a live bug fixed in passing

Found while dumping `voice_campaign_enrollments` to write the migration, and
fixed there because the fix is one array element and leaving it means a
documented feature does not work.

**`enrolled_by = 'appointment_booked'` was already being written and was not in
the CHECK list.** `voice-campaign-tick`'s appointment **re-arm** path — added in
`20260803`, the branch that lets a client who books again in June be reminded
again — sets `enrolled_by = 'appointment_booked'`, a value the constraint had
never allowed. That UPDATE had therefore been failing with a check violation
every time it fired, **silently, inside a sweep whose errors are logged and
swallowed**.

`20260807_sms_campaigns.sql` drops and re-adds the constraint with two
additions — the bug fix, and this round's own value:

```sql
check (enrolled_by in (
  'auto', 'reevaluate', 'missed_appointment', 'sold', 'manual',
  'appointment_booked'
))
```

plus `campaign_sms`, which is how a lead enrolled into a text campaign by the
sweep is told apart from one enrolled by hand.

## 4. 🔴 THE SEED FORMAT SMS-3 MUST USE

*Copied verbatim from `docs/sms-campaigns.md` § "What SMS-3 needs from this
engine", which is the source of truth. Verification notes follow the block.*

---

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

---

### Verification of the copied section — three things checked against the code

The instruction was to make sure the above is concrete enough to follow without
guessing. It is, with three clarifications that the source text leaves implicit:

**a) The example JSON's `"active": true` is the DESIRED END STATE, not the
insert.** It does not contradict the INSERT-INACTIVE rule; a seeder reading this
blob writes the campaign row with `active = false`, inserts the steps, then
`UPDATE … SET active = true` — all three statements inside one transaction. The
blob's `active` field says which of those campaigns should end the transaction
switched on. (SMS-3's owner decision overrides that value to `false` for all
twelve — built, visible, PAUSED — which makes the third statement a no-op for
that round, but the ordering rule still applies to the trigger's *own* validation
on any later activation.)

**b) The seed keys that must align are the SMS campaigns' own, and they must
equal `SMS_AI_TYPES` EXACTLY.** The doc's sentence "the twelve voice defaults'
`seed_key`s ARE the twelve `sms_ai_settings` campaign types" is loose about the
suffix: the twelve *voice* defaults in `20260803` are keyed
`appointment_reminder_v1`, `final_expense_v1`, `veteran_lead_v1` … , while
`SMS_AI_TYPES` in `_shared/sms-ai-core.ts` is `appointment_reminder`,
`final_expense`, `veteran_lead` … — no `_v1`. The suffix does not matter for
voice, because a voice campaign never calls `sendCampaignSms` and so never sets
a `campaign_type`.

It matters absolutely for SMS. `voice-campaign-tick:1077` passes
`campaignType: campaign.seed_key` straight through, `getOrCreateConversation()`
stores it verbatim in `sms_conversations.campaign_type`, and
`loadSettings()` matches it against `sms_ai_settings.campaign_type` with
`.in("campaign_type", [wanted, "default"])` — **an exact string match with a
silent fallback to `default`**. A seed key of `sms_final_expense_v1` would
therefore not fail loudly; it would quietly answer every Final Expense drip in
the *Default* voice, for ever.

So the operative rule for SMS-3 is: **the twelve SMS seed keys are the twelve
`SMS_AI_TYPES` values, character for character** —

```
appointment_reminder   no_show_followup      customer_care_sold
emergency_contact      beneficiary_referral  chargeback_recovery
veteran_lead           final_expense         mortgage_protection
iul                    general_life          trucker
```

— and *not* the `sms_veteran_v1` shape the SMS-3 prompt offers as a loose
example. They cannot collide with the voice defaults' `_v1` keys, so the
`(agent_id, seed_key)` uniqueness is unaffected.

**c) Trigger mappings come from the voice defaults, not from invention.**
`20260803_default_voice_campaigns.sql` carries the twelve voice campaigns'
`trigger_groups` verbatim; the tag rule (`VC_TAG_FIELDS`, plus `status` for the
four lifecycle values `sold` / `appointment` / `chargeback` / `lapsed`, and
never `status is new`) is unchanged and applies identically to both channels.
Mirror them.

## 5. What the round verified in production, 2026-07-31 (no text was sent)

A synthetic campaign (`dry_run = true`) matching exactly one synthetic lead —
deliberately created with **`tcpa_consent = false`** and a recorded
`consent_records` row, so the run proves a text campaign reads *text* consent and
not the calling flag.

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

**The validate trigger caught the dry run's own seed on its first attempt** —
`active = true` on the campaign insert raised "This text campaign has no message
steps". That is the empirical origin of the INSERT-INACTIVE rule in § 4.

## 6. What shipped

| File | What |
|---|---|
| `supabase/migrations/20260807_sms_campaigns.sql` | `channel` on three tables, the derive trigger, the moved unique index, the SMS step columns, the `enrolled_by` fix, `sms_messages` attribution columns, the `campaign-media` bucket |
| `supabase/functions/_shared/campaign-sms-send.ts` | the one send path |
| `supabase/functions/_shared/voice-campaign-core.ts` | § 13 — the SMS decisions, pure |
| `supabase/functions/voice-campaign-tick/index.ts` | the SMS branch of the same sweep |
| `supabase/functions/voice-campaign-manage/index.ts` | the SMS half of the manual door + Send Test |
| `app.html` (+ `www/` mirrors) | channel badge, SMS step editor, merge palette, MMS attach, preview, meter card |
| `supabase/functions/_shared/campaign-sms.test.ts` | 54 |
| `test/sms-campaigns.test.mjs` | 32 |

Tests: `npm run test:ai` and `npm run test:smscampaigns`. Suite **1,614 green**.

---

# PENDING LIVE VERIFICATION

1. **🔴 Attach an SMS-capable number to the 10DLC campaign `CD2166Q`.** Until
   then every text campaign pauses on its first send attempt. Carried over
   unchanged from the A2P round and SMS-1.
2. **The first real drip send** — a consented, tag-matching lead receives step 1.
3. **The first real hold** — a live conversation defers a step and the card says
   "They're mid-conversation — holding".
4. **The first real `stop_on_reply`** — a lead writes back and the Finished tab
   says "They wrote back".
5. **The first real MMS** through `campaign-media`.
6. **A real Send Test** landing on the owner's own cell.

# 2-MINUTE EYEBALL CHECKLIST

| # | Do this | Expect |
|---|---|---|
| 1 | Hard-refresh → **Campaigns** | The list loads. Every card carries a channel badge |
| 2 | **New campaign** → pick **Text** | The step editor is bodies and waits, not call settings |
| 3 | Type a body with `{{firstName}}` and `{{nonsense}}` | The preview fills the first and *removes* the second — no raw braces, no double space |
| 4 | Watch the character/segment count | It counts the **preview**, not the template |
| 5 | Add a **wait** step between two messages | Saving keeps it; the schedule reads "send / wait 2d / send" |
| 6 | Save with only wait steps | It refuses — a campaign with nothing to say cannot go active |
| 7 | **Send Test** to a number that is not yours | Refused. To your own → real send, marked `[Campaign test]`, no thread created |
| 8 | Settings → Texting → look at the meter card | A count per number, and a line saying texting has no daily limit of ours. No verdict, no threshold |
| 9 | Try to switch an existing campaign's channel | There is no control — the channel is fixed at creation |
| 10 | With no SMS-capable number, activate a text campaign | It activates, then pauses on its first tick with the "none of your numbers is set up for texting yet" sentence |

Nothing above sends a text to a consumer or bills a wallet, except step 7's
deliberate test send to your own phone.

## Deliberately left

- **No text cap.** Counted, not capped; a test asserts the meter block contains
  no verdict, state, threshold or recommendation, so a future round wanting one
  has to add it deliberately rather than inherit it.
- **The `voice_` table prefix stays.** `channel` is the truth.
- **`sms_messages.lead_id` does not exist** — the feed resolves a lead through
  the enrollment's `conversation_id`, set on the first send.
- **Saving the Steps tab still deletes and re-inserts every step**, so `body`
  and `media_url` are carried through the save the same way `anchor` and
  `offset_minutes` are.
- **The twelve default text campaigns were not seeded here.** That is SMS-3,
  and § 4 is the contract it has to meet.
