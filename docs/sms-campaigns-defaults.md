# The twelve pre-written text campaigns — built, visible, switched off

**Added 2026-07-31.** Prompt SMS-3. Schema:
`supabase/migrations/20260808_default_sms_campaigns.sql`.
Engine: SMS-2 (`docs/sms-campaigns.md`) — unchanged except for one fix, below.
Tests: `npm run test:defaultsms` (50) and `npm run test:ai`
(`campaign-sms.test.ts`, 56).

Read `docs/sms-campaigns.md` first — that is the engine these run on. Read
`docs/voice-campaigns-defaults.md` second: this is its twin, and the two
differences between them are the whole of this document that matters.

## The one decision that shapes everything else

**The twelve voice campaigns ship ACTIVE. These twelve ship OFF.** Owner's
decision, and the reason is an asymmetry of harm.

A calling campaign on a book with no consented leads enrols nobody and dials
nobody: `ai-call-start`'s gate 3 refuses any lead without recorded TCPA consent,
so shipping it live costs nothing and saves the agent a step. A text is
different. It arrives on a phone, it stays there, and the person reading it did
not choose the wording — we did. An agent who has not read the copy has not yet
agreed to send it.

So: twenty-four cards on day one, twelve of them running and twelve of them
written and waiting. The card says which, in one sentence, and the switch asks
once.

### What "off" looks like, and why it is not called "paused"

`voice_campaigns.active = false`, `paused_at = null`. The tick's campaign query
is `.eq("active", true).is("paused_at", null)`, so an off campaign is not read,
not swept, and enrols nobody — proven live: an unscoped tick after seeding all
108 rows reported `campaigns: 97`, which is the voice twelve across nine agents
and nothing else.

**"Off" and "Paused" are different states and the card must not blur them.**
The pill already says `Off` for `active = false` and `Paused` for an engine
pause with a `pause_reason` attached. A paused campaign hit a wall — no
SMS-capable number, an empty wallet — and there is a sentence explaining it. An
off one simply has not been asked to start. Printing "Paused" on both would make
the word mean nothing on the day it matters.

What an off TEXT campaign gains is a line and a button:

> **Not turned on yet** — switch it on when you've read the messages. Once it is
> on, texts only go to leads with recorded text consent. **[Turn on]**

`Turn on` calls `vcampTurnOn()`, which calls `vcampToggleActive(id, true)` —
deliberately the same path as the Active checkbox rather than a second one. A
button that could start a campaign without the confirm below would make the
confirm decorative, and a test asserts no such path exists.

### The one question

`vcampConfirmTurnOn()` runs LAST, after every reason the switch could be refused
anyway (a rule that does not narrow, a campaign with no actionable step, a
message step with no text), so an agent is never asked to confirm something that
was going to fail. It restates the only thing that actually bounds a live text
campaign, and then counts:

> Turn on "Final Expense (text)"?
>
> It will text leads on a schedule, and it only ever texts a lead with recorded
> text consent who has not opted out.
>
> Right now none of your leads has recorded text consent, so this will enrol
> nobody until some do.

The last line comes from `textableCount()` — the same function the leads header
and the campaign banner use — so the three cannot disagree about the same
account. A calling campaign gets no confirm: it has shipped live since
`20260803` and adding one now would be a change nobody asked for.

## 🔴 The seed keys are the SMS AI campaign types, character for character

This is the sharpest edge in the round.

`voice-campaign-tick` passes `campaign.seed_key` **straight through** to
`sendCampaignSms` as `campaignType`. `getOrCreateConversation()` stores it
verbatim in `sms_conversations.campaign_type`. `loadSettings()` then matches it
against `sms_ai_settings.campaign_type` with

```ts
.in("campaign_type", wanted === "default" ? ["default"] : [wanted, "default"])
```

— an **exact string compare with a silent fallback to `default`**.

So a seed key of `sms_final_expense_v1` would not fail. It would answer every
Final Expense drip in the Default voice, for ever, with nothing on any screen to
say so. The twelve keys are therefore exactly `SMS_AI_TYPES` minus `default`:

```
appointment_reminder   no_show_followup      customer_care_sold
emergency_contact      beneficiary_referral  chargeback_recovery
veteran_lead           final_expense         mortgage_protection
iul                    general_life          trucker
```

A test compares the two lists as sets and a second test pins the line in the
tick that passes the key through, so the alignment cannot become quietly
pointless.

They cannot collide with the voice defaults, whose keys all end `_v1`, which is
what lets **one** `voice_campaign_seed_state` table carry both channels.

## The twelve

`sort_order` 210–320, so they sort after the voice twelve (10–120) rather than
interleaving with them. All `channel = 'sms'`, all `active = false`, all
`pause_on_active_conversation = true`.

| Campaign | Msgs | Span | Trigger | Ends on reply |
|---|---|---|---|---|
| Appointment Reminder | 7 | anchored, −7d → +1d | appointment booked · `status is appointment` | no |
| No-Show Follow-Up | 18 | ~7 months (209d) | appointment missed · `status is appointment` | yes |
| Customer Care | 12 | ~2.8 years (1,020d) | lead sold · `status is sold` | no |
| Emergency Contact | 8 | ~3 months (92d) | lead sold · `status is sold` | yes |
| Beneficiary Referral | 8 | ~9 months (274d) | lead sold · `status is sold` | yes |
| Chargeback Recovery | 10 | ~3 months (89d) | `campaign_tag is chargeback` \| `status is chargeback` | yes |
| Veteran | 26 | ~17.5 months | `campaign_tag is veteran` \| lead_type veteran/veterans/va | yes |
| Final Expense | 24 | ~13.5 months (412d) | `campaign_tag is final_expense` \| final expense/fex/burial | yes |
| Mortgage Protection | 24 | ~13.5 months (412d) | `campaign_tag is mortgage_protection` \| mortgage protection/mortgage | yes |
| IUL | 24 | ~13.5 months (412d) | `campaign_tag is iul` \| iul/indexed universal life | yes |
| General Life | 24 | ~13.5 months (412d) | `campaign_tag is general_life` \| general life/life/term life/whole life | yes |
| Trucker | 24 | ~13.5 months (412d) | `campaign_tag is trucker` \| trucker/truck driver/cdl | yes |

**Every trigger is byte-identical to its voice sibling's**, and a test compares
them with `deepEqual`. An agent who tags a lead `veteran` expects the calling
campaign and the texting campaign to recognise it; two definitions of "this is a
veteran lead" on one book is the bug class this repo has already fixed four
times. The enrollment-trigger flags are mirrored too.

That also inherits the two honest gaps stated in `docs/voice-campaigns-defaults.md`:
nothing writes `ai_appointments.status = 'no_show'` yet, so No-Show Follow-Up is
wired and waiting; and chargeback is a policy status rather than a lead one, so
Chargeback Recovery enrols on an applied `campaign_tag`.

### Two of them do NOT stop on a reply, and that is the point

`stop_on_reply` defaults true and ten of the twelve keep it. **Customer Care and
Appointment Reminder set it false.**

A check-in sequence that ends the first time a client says "thanks!" is a
check-in sequence that never runs — and it is not trying to reach anybody, so
the failure `stop_on_reply` exists to prevent (dripping at somebody who has
written back) does not apply to it. A reminder is the same: "see you then" must
not cancel the day-of reminder. Both still **hold** while a conversation is live,
so neither can talk over a real exchange, and both still stop instantly on STOP,
DNC or a closed thread — those sit above every campaign setting in
`vcEvaluateSmsStop()`.

## The copy

~207 messages. Rules that are enforced mechanically rather than by review:

### 🔴 Every body is plain ASCII, and that is a cost decision

The GSM-7 alphabet (`_shared/segments.ts`) has no em dash, no curly quote and no
emoji. **One of them anywhere forces the whole message to UCS-2**, where a
segment is 67 characters instead of 153. A 200-character text goes from 2
segments to 3 — on every send, for ever, for punctuation nobody asked for.

A test runs every body through `countSegments()` and fails on a UCS-2 result. It
paid off immediately: **201 of the 209 messages fit in a single
segment (96%), and none needs a third**, and the production dry run billed the Final Expense opener at 1.

That also answers the emoji question the brief left open ("only where the
per-type setting would default on"): `defaultSmsAiSettings()` has
`emojis: false` for all thirteen types, so the answer is nowhere.

### The opt-out rule, stated so it can be tested

A message step must carry a `Reply STOP` line when it is

- **(a)** the first message of the sequence — it introduces a number the
  consumer has not seen before;
- **(b)** at a position congruent to 1 mod 5 (1, 6, 11, 16, 21, 26) — "roughly
  every fifth message"; or
- **(c)** the first message after a gap of **45 days or more**. A text arriving
  four months after the last one is a new conversation to the person reading it,
  whatever our database thinks.

A body may carry one anywhere else; the rule is a floor. A separate test renders
each required step with **every variable resolving to nothing** and asserts the
opt-out survives, because a merge fallback must not be able to eat it.

The first message of every sequence must also name the sender — a test asserts
both `{{agentName}}` and `{{companyName}}` are in it.

### What the copy may never say

A banned-phrase list runs over every body: guaranteed approval, blanket
no-questions promises, fake urgency ("last chance", "expires tonight", "rates
double tomorrow"), premium promises ("as low as $"), underwriting promises,
disparagement, implied government affiliation, and collections language.
Per-campaign rules on top of it:

- **Veteran** must say plainly, in the opening message, that this is **not the
  VA**, and somewhere in the sequence that it sits *alongside* VA benefits
  rather than replacing them.
- **Chargeback Recovery** may not contain `owe`, `arrears`, `delinquent`,
  `overdue` or `collections`, and must offer to put the coverage back.
- **No-Show Follow-Up** may not say `you missed`, `you didn't`, `you failed` or
  `no-show`. Its first message says "looks like we missed each other", because
  that is usually what it was.

### 🔴 Beneficiary Referral asks the CLIENT and never texts a beneficiary

`referralsFromPolicy()` deliberately creates a referral lead with **no consent**,
so `leadTextingState()` renders it `needs_optin` and `runComplianceGate()`
refuses. This campaign must not be the thing that routes around that.

It triggers on the **insured** being sold, its audience is
`status is sold` and nothing else, and its ask is for the client to *pass the
agent's number on* — never for somebody else's details. Three assertions hold
that: the trigger shape, the presence of a "pass on my number" message, and a
grep for any body asking to be sent a third party's number.

### The merge variables, and the fallbacks the copy has to survive

Six, from SMS-2. What matters for writing is that **every fallback is
non-blank**, so a sentence has to read correctly both ways:

| Variable | Sample | Fallback |
|---|---|---|
| `{{firstName}}` | Maria | there |
| `{{agentName}}` | Jordan Reyes | your agent |
| `{{companyName}}` | Reyes Financial | our office |
| `{{carrier}}` | Mutual of Omaha | your carrier |
| `{{coverageAmount}}` | $25,000 | your coverage |
| `{{agentPhone}}` | (262) 509-9123 | this number |

That rules out the obvious phrasings. "your {{carrier}} policy" becomes "your
your carrier policy"; "{{coverageAmount}} of cover" becomes "your coverage of
cover". The bodies use "your policy with {{carrier}}" and "options around
{{coverageAmount}}", which read correctly with a value and without one. A test
renders every body twice — full sample values, then nothing at all — and fails on
a leftover brace, a double space, a space before punctuation, or an empty result.

### There are no `wait` steps, on purpose

The engine has them and they work (`vcResolveNextDue()` folds them). Every
sequence here is a straight run of messages, and a step's own `wait_value`
expresses that in one row rather than two. At 24 steps it is also the difference
between 24 rows and 47. A hand-built campaign is exactly where a `wait` step
reads better, and the editor still offers it.

## 🔴 A live-conversation hold must not fire an anchored reminder late

**The one engine change this round makes**, and it is a fix SMS-2 could not have
hit: there was no anchored text campaign then, and now there are seven anchored
steps.

`vcEvaluateSmsHold()` moves the due time to when the conversation window closes.
For an ordinary step that is exactly right — the lead still gets Thursday's
message, just not on top of their own sentence. For **"your call is in about an
hour"** it is not: a lead who texts at 09:00 on Monday holds the whole thread
until 09:00 Tuesday, and the reminder for Monday's 15:00 appointment would go out
a day after the appointment. That is precisely the failure `vcResolveNextDue()`'s
skip rule exists to prevent, reached through a different door.

`vcSmsHoldWouldMissAnchor({ step, holdUntil, appointmentAt })` answers "would
holding this make it arrive after the moment it describes". When it does, the
tick **skips the step** — `vcResolveNextDue()` from that position, exactly as an
already-passed step is skipped at enrollment — instead of holding it. Trace event
`sms_anchor_skipped_not_held`.

The enrollment stays alive on whatever step still has a moment left, and the
conversation is still not talked over: the step that would have talked over it is
the one being dropped. When nothing is left, the enrollment completes rather than
leaving a row that re-asks every minute for ever.

Ordinary steps are untouched — the helper returns false for anything not
appointment-anchored, so voice pacing and every non-reminder text sequence behave
exactly as they did.

### And the reminders themselves are mostly skipped, which is the design

Seven anchored steps sounds like a lot of texts. In practice most enrollments get
two or three: a lead who books for tomorrow has already passed the −7d and −3d
steps, and `vcResolveNextDue()` starts them at −1d. A lead who books for ninety
minutes' time starts at −60. A lead who books for ten minutes' time gets only the
two steps that fall *after* the appointment. And because each step is anchored,
its copy can state the relative time truthfully — "we're on in about 4 hours" is
correct by construction, which is how the sequence works without an appointment
merge variable.

**There is deliberately no `{{appointmentTime}}`.** The value exists on the
enrollment, but rendering it for a consumer means picking a timezone, and getting
that wrong on a reminder is worse than not stating it. The anchored offsets carry
the same information without the risk.

## The seeder

Same shape as `vc_seed_default_campaigns_for()` and the same tombstone table.

**🔴 The tombstone is what makes a delete stick.** An agent who deleted a seeded
campaign looks exactly like an agent who never had one, and re-creating it would
restart a program that TEXTS consumers. Nothing removes a tombstone row; the
seeder contains no `DO UPDATE`, no `DELETE`, and exactly one `UPDATE` — the
activate step, keyed on the id it just created.

**🔴 The order is the SMS-2 contract: INSERT INACTIVE → STEPS → ACTIVATE, one
transaction.** `voice_campaigns_validate()` refuses an active text campaign with
no `sms_message` steps, and the campaign row necessarily precedes its steps, so
any other order raises. The campaign insert writes `false` **literally**, not
`def->>'active'` — step 3 is the only thing that ever turns a campaign on. For
these twelve step 3 never fires; it exists so a future default that ships live
needs no change to this function, and so the contract lives in code rather than
in a comment.

`vc_seed_default_sms_campaigns_for(uuid)` is `SECURITY DEFINER` and REVOKEd from
`anon`/`authenticated` because it names an agent. The browser calls
`vc_seed_default_sms_campaigns()`, which takes no parameter and anchors on
`auth.uid()` — same shape as `apply_producer_codes()`.

`agents_seed_sms_campaigns` is a **second** AFTER INSERT trigger on
`public.agents`, not an edit to the voice one. The voice hook is live for nine
accounts and has a job it already does; widening it would mean a change to the
text seeder could break the calling one. Both swallow their own exceptions,
because a sign-up must never fail over a default campaign, and both are repaired
by the idempotent call `vcampEnsureDefaults()` makes on load.

## Verified in production, 2026-07-31 (no text was sent)

Applied inside `begin; … ; rollback;` first, then for real.

```
before      9 agents · 108 campaigns (108 voice, 97 active) · 108 seed rows · 0 enrollments
after       216 campaigns (108 voice unchanged, 108 sms) · 0 sms active
            1,881 sms_message steps · 216 seed rows · 0 enrollments
```

**Idempotency and the three promises**, in one rolled-back transaction against
the real data: switched one seeded campaign on, renamed it, rewrote its first
message, and deleted another — then re-ran the seeder three more times.

```
sms_campaigns_after   107     <- the deleted one did NOT come back
trucker_rows            8     <- eight agents still have it, the ninth does not
still_active            1     <- the one switched on stayed on
kept_name             "MY final expense texts"
kept_body             "My own words entirely."
seed_rows_after       216     <- no new tombstones
```

**A live sweep**, with three synthetic leads on the owner's account — all three
with `leads.tcpa_consent` FALSE, so this also re-proves a text campaign reads
TEXT consent and not the calling flag:

| Lead | `campaign_tag` | `consent_records` | Result |
|---|---|---|---|
| SMS3 Alpha | `final_expense` | yes | **enrolled**, step 1, due +2 min |
| SMS3 Bravo | `final_expense` | no | skipped |
| SMS3 Charlie | `trucker` | yes | rule did not match |

```
tick 1 (campaign off)              campaigns swept: 97  <- the 108 sms rows are not read
tick 2 (switched on, dry_run)      enrolled 1
tick 3 (step due)                  gate  no_sms_capable_number
                                   plan  pause_campaign · "Paused: none of your
                                         numbers is set up for texting yet."
tick 4 (sms_capable temporarily true on the owner's own +12029981783)
  dry_run_would_text
    to           +12625550171   from +12029981783   step 1   1 SEGMENT
    rendered     "Hi SMS3, it's Jace Frenkel with Frenkel Financial. You asked
                  about final expense coverage. Is now an OK time for a quick
                  call? Reply STOP to opt out."
    gates_passed 1 A2P registration approved · 2 recipient SMS consent (express
                 written) · 3 do-not-contact list · 4 lead-local quiet hours ·
                 5 sending number is campaign-attached
    advance      next step -> position 2, due +20 minutes
```

Afterwards: `sms_capable` back to false everywhere, the campaign off and out of
dry run, every synthetic lead, consent row and enrollment deleted, and
`sms_messages`, `sms_conversations` and `messages` to the test numbers all **0**.
A final unscoped tick swept 9 agents and 97 campaigns with 0 errors and 0 work.

## Known-fragile / open

- **🔴 NO NUMBER ON THIS ACCOUNT HAS `sms_capable = true`** — unchanged from
  SMS-2, and confirmed again by tick 3 above. Every text campaign an agent turns
  on today will enrol normally and then pause on its first send with the sentence
  quoted. The 10DLC number→campaign assignment is the one thing between this and
  a live text.
- **Two carrier review items on `CD2166Q` are still open**
  (`docs/a2p-campaign-draft.md`). Nothing here changes the campaign
  registration.
- **`ai_appointments.status` never holds `no_show`**, so No-Show Follow-Up will
  not fire until the calendar round writes it. Inherited from the voice twelve
  and stated rather than hidden.
- **The Steps tab still deletes and re-inserts every step.** A seeded campaign an
  agent edits keeps only what that tab carries through the save — `body`,
  `media_url`, `anchor`, `offset_minutes`, `wait_value`, `wait_unit`,
  `drip_rate`. A field it forgets is a field it erases, and for these twelve that
  would silently turn "the day before" into "immediately".
- **The copy is written for a US book in English.** There is no localisation seam
  and this round did not invent one.
