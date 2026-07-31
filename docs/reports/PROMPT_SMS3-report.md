# PROMPT SMS-3 — The twelve pre-written text campaigns, shipped switched off

**Completed 2026-07-31.** Prompt: `prompts/PROMPT_SMS3_12_sms_campaigns_CLAUDE_CODE.md`.
Schema: `20260808_default_sms_campaigns.sql` (applied + verified).
Docs: `docs/sms-campaigns-defaults.md`. Suite: **1,666 passing, 0 failing** (+52).

## Before starting: was SMS-2 concrete enough to follow?

The instruction was to stop rather than approximate. I read
`docs/reports/PROMPT_SMS1-report.md` and `docs/reports/PROMPT_SMS2-report.md`
first. **Yes — with one clarification I checked in the code rather than
guessing at, and it turned out to matter more than anything else in the round.**

The architecture decision was unambiguous: extend `voice_campaigns` with a
`channel`, one tick, three divergences. Nothing here needed to reopen it.

The seed format was concrete: a JSON blob, `seed_key` as the seam, seeded by SQL
or an edge function and never a browser upsert, and INSERT-INACTIVE → STEPS →
ACTIVATE in one transaction. What was loose was one sentence:

> "The twelve voice defaults' `seed_key`s ARE the twelve `sms_ai_settings`
> campaign types … **Keep the seed keys aligned with `SMS_AI_TYPES`.**"

The twelve voice defaults are keyed `final_expense_v1`, `veteran_lead_v1` … ;
`SMS_AI_TYPES` is `final_expense`, `veteran_lead` … — no `_v1`. So the sentence
is not literally true, and the SMS-3 prompt's own example (`sms_veteran_v1`)
would have made it less true still.

I resolved it by reading the path instead of picking. `voice-campaign-tick:1077`
passes `campaign.seed_key` straight through as `campaignType`;
`getOrCreateConversation()` stores it verbatim in
`sms_conversations.campaign_type`; `loadSettings()` matches it against
`sms_ai_settings.campaign_type` with `.in("campaign_type", [wanted, "default"])`
— **an exact string compare with a silent fallback to `default`**.

So a key of `sms_final_expense_v1` would not error. It would answer every Final
Expense drip in the *Default* voice, for ever, with nothing on any screen to say
so. **The twelve seed keys are therefore the twelve `SMS_AI_TYPES` values,
character for character**, and two tests hold it: one compares the lists as
sets, one pins the line in the tick that makes the alignment load-bearing. The
suffix does not matter for voice because a voice campaign never calls
`sendCampaignSms`, which is why the voice twelve could drift without consequence.

That is the only place the brief and the code disagreed, and it is written up in
`docs/sms-campaigns-defaults.md` § "The seed keys are the SMS AI campaign types".

---

## The twelve

`sort_order` 210–320, after the voice twelve (10–120). All `channel = 'sms'`,
all `active = false`, all `pause_on_active_conversation = true`. 209 messages
per agent; 1,881 step rows across the nine live accounts.

| # | Campaign | Msgs | Cadence span | Trigger mapping | Ends on reply |
|---|---|---|---|---|---|
| 1 | Appointment Reminder (text) | **7** | anchored, −7d → +1d | appointment booked · `status is appointment` | no |
| 2 | No-Show Follow-Up (text) | **18** | 209d (~7 months) | appointment missed · `status is appointment` | yes |
| 3 | Customer Care (text) | **12** | 1,020d (~2.8 years) | lead sold · `status is sold` | no |
| 4 | Emergency Contact (text) | **8** | 92d (~3 months) | lead sold · `status is sold` | yes |
| 5 | Beneficiary Referral (text) | **8** | 274d (~9 months) | lead sold · `status is sold` | yes |
| 6 | Chargeback Recovery (text) | **10** | 89d (~3 months) | `campaign_tag is chargeback` \| `status is chargeback` | yes |
| 7 | Veteran (text) | **26** | 532d (~17.5 months) | `campaign_tag is veteran` \| lead_type veteran / veterans / va | yes |
| 8 | Final Expense (text) | **24** | 412d (~13.5 months) | `campaign_tag is final_expense` \| final expense / final_expense / fex / burial | yes |
| 9 | Mortgage Protection (text) | **24** | 412d (~13.5 months) | `campaign_tag is mortgage_protection` \| mortgage protection / mortgage_protection / mortgage | yes |
| 10 | IUL (text) | **24** | 412d (~13.5 months) | `campaign_tag is iul` \| iul / indexed universal life | yes |
| 11 | General Life (text) | **24** | 412d (~13.5 months) | `campaign_tag is general_life` \| general life / life / term life / whole life | yes |
| 12 | Trucker (text) | **24** | 412d (~13.5 months) | `campaign_tag is trucker` \| trucker / truck driver / cdl | yes |

Every count meets or beats the brief. **The counts are MESSAGE steps, not
rows** — a `wait` step is scheduling, not a touch, and counting one toward the
depth the owner set would be padding the number. There are no `wait` steps here
anyway: every sequence is a straight run of messages carrying their own
`wait_value`, which produces an identical schedule in half the rows.

**Every trigger group is byte-identical to its voice sibling's**, compared with
`deepEqual` in a test, as are all four enrollment-trigger flags. An agent who
tags a lead `veteran` expects both channels to recognise it, and two definitions
of "this is a veteran lead" on one book is the bug class this repo has already
fixed four times.

### Two of them do not stop on a reply, deliberately

`stop_on_reply` defaults true and ten keep it. **Customer Care and Appointment
Reminder set it false.** A check-in sequence that ends the first time a client
says "thanks" never runs, and "see you then" must not cancel the day-of
reminder. Neither is trying to reach anybody, so the failure `stop_on_reply`
exists to prevent does not apply. Both still hold on a live conversation, and
both still stop instantly on STOP, DNC or a closed thread — those sit above
every campaign setting in `vcEvaluateSmsStop()`.

---

## The copy — Final Expense in full, for the taste check

Every line below is what a lead actually receives, and every one of these
twenty-four is **one segment**.

| # | After | Message |
|---|---|---|
| 1 | 2 min | Hi {{firstName}}, it's {{agentName}} with {{companyName}}. You asked about final expense coverage. Is now an OK time for a quick call? Reply STOP to opt out. |
| 2 | 20 min | No worries if you're busy. Tell me a better time and I'll ring then. |
| 3 | 2 hrs | {{firstName}}, most people I talk to want enough to cover a funeral and not leave a bill behind. Is that roughly it for you? |
| 4 | 5 hrs | Whenever you're ready. It's a short conversation, about ten minutes. |
| 5 | 1 day | Morning {{firstName}}. Still want me to look at options around {{coverageAmount}}? |
| 6 | 1 day | {{firstName}}, it's {{agentName}} with {{companyName}}. Two answers get me a real number: your date of birth, and whether you use tobacco. Reply STOP to opt out. |
| 7 | 2 days | A lot of people ask whether there's a medical exam. For most of these plans there isn't, it's health questions instead. |
| 8 | 2 days | Still here when you want to pick this up, {{firstName}}. |
| 9 | 3 days | {{firstName}}, would it help if I sent a couple of options in writing rather than calling? |
| 10 | 4 days | Honest question: is this still something you want to sort out, or has it moved down the list? |
| 11 | 5 days | {{firstName}}, I'd rather know than keep texting. Yes, no or later all work. Reply STOP to opt out. |
| 12 | 7 days | Worth knowing: what you pay is based on your age when you start, so it moves on your birthday rather than on any deadline. |
| 13 | 7 days | Checking in, {{firstName}}. Anything changed on your end? |
| 14 | 10 days | {{firstName}}, if you'd rather I stopped, just say. Otherwise I'm happy to run the numbers whenever. |
| 15 | 14 days | Still happy to help with this, {{firstName}}. What's holding it up? |
| 16 | 14 days | {{firstName}}, it's {{agentName}} at {{companyName}}. Want me to put a couple of options together? Reply STOP to opt out. |
| 17 | 21 days | Some people wait until something happens in the family. I'd rather you didn't have to. |
| 18 | 21 days | {{firstName}}, still around if you need me. - {{agentName}} |
| 19 | 30 days | It's been about a month, {{firstName}}. Want another look at what's available? |
| 20 | 30 days | Hope you're keeping well. Is cover still on the list, or all handled? |
| 21 | 45 days | {{firstName}}, it's {{agentName}} with {{companyName}}. You asked about final expense cover a while back. Still want that quote? Reply STOP to opt out. |
| 22 | 45 days | Reply YES and I'll call you. Reply STOP and I'll leave it there, {{firstName}}. |
| 23 | 60 days | {{firstName}}, checking in from {{companyName}}. If the timing is better now, I can get you numbers today. Reply STOP to opt out. |
| 24 | 90 days | Last one from me, {{firstName}}. If you ever want to look at this I'm on {{agentPhone}}. Reply STOP to opt out. - {{agentName}} |

Rendered live in production, step 1 against a synthetic lead:

> "Hi SMS3, it's Jace Frenkel with Frenkel Financial. You asked about final
> expense coverage. Is now an OK time for a quick call? Reply STOP to opt out."
> — **1 segment**, five gates passed.

### 🔴 Every body is plain ASCII, and that is a cost decision

The GSM-7 alphabet has no em dash, no curly quote and no emoji. **One of them
anywhere forces the whole message to UCS-2**, where a segment is 67 characters
instead of 153 — on every send, for ever, for punctuation nobody asked for.

A test runs every body through the biller's own `countSegments()` and fails on a
UCS-2 result. The payoff: **201 of the 209 messages are one segment (96%), eight
are two, and none needs a third.**

That also answers the emoji question the brief left open ("only where the
per-type setting would default on"): `defaultSmsAiSettings()` has
`emojis: false` for all thirteen types, so the answer is nowhere.

### The opt-out rule, made mechanical

A message must carry a `Reply STOP` line when it is **(a)** the first message of
the sequence, **(b)** at a position `≡ 1 (mod 5)` — 1, 6, 11, 16, 21, 26 — or
**(c)** the first message after a gap of **45 days or more**. A text arriving
four months after the last one is a new conversation to the person reading it,
whatever our database thinks. Bodies carry one elsewhere too; the rule is a
floor.

A separate test renders every required step with **every variable resolving to
nothing** and asserts the opt-out survives — a merge fallback must not be able
to eat it. The first message of every sequence must also name the sender, and a
test checks both `{{agentName}}` and `{{companyName}}` are in it.

### What the copy may never say

A banned-phrase list runs over all 209 bodies: guaranteed approval, blanket
no-questions promises, fake urgency ("last chance", "expires tonight", "rates
double tomorrow"), premium promises ("as low as $", "only $"), underwriting
promises, disparagement, implied government affiliation, and collections
language. On top of that:

- **Veteran** says in its opening line that we are **not the VA**, and later
  that this sits *alongside* VA benefits rather than replacing them. Both
  asserted.
- **Chargeback Recovery** may not contain `owe`, `arrears`, `delinquent`,
  `overdue` or `collections`, and must offer to put the coverage back.
- **No-Show Follow-Up** may not say `you missed`, `you didn't`, `you failed` or
  `no-show`. Its opener is "looks like we missed each other".

### 🔴 Beneficiary Referral asks the client, and never texts a beneficiary

`referralsFromPolicy()` deliberately creates a referral lead with **no consent**
so the compliance gate refuses it. This campaign must not be the door that
routes around that. It triggers on the **insured** being sold, its audience is
`status is sold` and nothing else, and its ask is for the client to pass the
agent's number on — never for a third party's details. Three assertions hold it,
including a grep for any body asking to be sent somebody else's number.

### The fallbacks the copy had to survive

Every merge fallback is non-blank, which rules out the obvious phrasings: "your
{{carrier}} policy" renders as "your your carrier policy", and
"{{coverageAmount}} of cover" as "your coverage of cover". The bodies use "your
policy with {{carrier}}" and "options around {{coverageAmount}}", which read
correctly both ways. A test renders every body twice — full sample values, then
nothing at all — and fails on a leftover brace, a double space, a space before
punctuation, or an empty result.

---

## The screen

**Twenty-four cards on day one**, twelve running and twelve written and waiting,
each with its channel badge. The channel filter appears automatically now that
every account has both.

An off text campaign gains one line and one button:

> **Not turned on yet** — switch it on when you've read the messages. Once it is
> on, texts only go to leads with recorded text consent. **[Turn on]**

**"Off" is not "Paused", and the card must not blur them.** The pill already
says `Off` for `active = false` and `Paused` for an engine pause that has a
reason attached — no SMS-capable number, an empty wallet. A paused campaign hit
a wall; an off one has not been asked to start. Printing "Paused" on both would
make the word mean nothing on the day it matters.

`Turn on` calls `vcampTurnOn()` → `vcampToggleActive(id, true)` — the same path
as the Active checkbox, so it cannot skip the confirm. A test asserts no second
path exists.

**The confirm** runs LAST, after every reason the switch could be refused
anyway, so nobody is asked to confirm something that was going to fail:

> Turn on "Final Expense (text)"?
>
> It will text leads on a schedule, and it only ever texts a lead with recorded
> text consent who has not opted out.
>
> Right now none of your leads has recorded text consent, so this will enrol
> nobody until some do.

The last line comes from `textableCount()` — the same function the leads header
and the campaign banner use, so the three cannot disagree about one account. A
calling campaign gets no confirm: it has shipped live since `20260803`, and
adding one now would be a change nobody asked for.

---

## 🔴 The one engine change: a hold must not fire an anchored reminder late

Found while building the Appointment Reminder, and it is a fault SMS-2 could not
have hit — there was no anchored *text* campaign until this round.

`vcEvaluateSmsHold()` moves a held step's due time to when the conversation
window closes. For an ordinary step that is exactly right. For **"your call is
in about an hour"** it is not: a lead who texts at 09:00 Monday holds the thread
until 09:00 Tuesday, and the reminder for Monday's 15:00 appointment goes out a
day *after* the appointment. That is precisely the failure
`vcResolveNextDue()`'s skip rule exists to prevent, reached through a different
door.

`vcSmsHoldWouldMissAnchor({ step, holdUntil, appointmentAt })` answers "would
holding this make it arrive after the moment it describes". When it does, the
tick **skips the step** — `vcResolveNextDue()` from that position, exactly as an
already-passed step is skipped at enrollment — instead of holding it. Trace
event `sms_anchor_skipped_not_held`. The enrollment stays alive on whatever step
still has a moment left; when nothing does, it completes rather than re-asking
every minute for ever. The conversation is still not talked over, because the
step that would have talked over it is the one being dropped.

Ordinary steps are untouched — the helper returns false for anything not
appointment-anchored — so voice pacing and every non-reminder text sequence are
byte-identical to before. Ten unit cases plus the browser/server parity run.

**And most reminders are skipped anyway, which is the design.** Seven anchored
steps sounds like a lot; in practice a lead who books for tomorrow starts at the
−1d step, one who books for ninety minutes' time starts at −60, and one who
books for ten minutes' time gets only the two steps that fall *after* the
appointment. Because each step is anchored, its copy can state the relative time
truthfully — "we're on in about 4 hours" is correct by construction.

**There is deliberately no `{{appointmentTime}}` merge variable.** The value
exists on the enrollment, but rendering it for a consumer means choosing a
timezone, and getting that wrong on a reminder is worse than not stating it. The
anchored offsets carry the same information without the risk.

---

## The seeder

Same shape and the same tombstone table as the voice seeder, because the
question — "has this agent already been *offered* this default?" — has to have
one answer for both channels. The keys cannot collide (voice ends `_v1`), so one
`(agent_id, seed_key)` primary key still decides both.

**🔴 The order is the SMS-2 contract: INSERT INACTIVE → STEPS → ACTIVATE, one
transaction.** `voice_campaigns_validate()` refuses an active text campaign with
no `sms_message` steps and the campaign row necessarily precedes its steps, so
any other order raises. The campaign insert writes `false` **literally**, not
`def->>'active'` — step 3 is the only thing that ever turns a campaign on. Step 3
never fires for these twelve; it exists so a future default that ships live needs
no change to the function, and so the contract lives in code rather than in a
comment. A test pins all three positions and the literal `false`.

`vc_seed_default_sms_campaigns_for(uuid)` is `SECURITY DEFINER` and REVOKEd from
`anon`/`authenticated` because it names an agent. The browser calls
`vc_seed_default_sms_campaigns()`, which takes no parameter and anchors on
`auth.uid()`.

`agents_seed_sms_campaigns` is a **second** AFTER INSERT trigger on
`public.agents`, not an edit to the voice one: the voice hook is live for nine
accounts and a change to the text seeder must not be able to break sign-up
seeding for the calling campaigns. Both swallow their own exceptions — a sign-up
must never fail over a default campaign — and both are repaired by the idempotent
call `vcampEnsureDefaults()` makes on load, which now makes two RPCs rather than
one for the same reason.

---

## Verified in production, 2026-07-31 — no text was sent

Applied inside `begin; … ; rollback;` first, then for real.

```
before   9 agents · 108 campaigns (108 voice, 97 active) · 108 seed rows · 0 enrollments
after    216 campaigns (108 voice UNCHANGED + 108 sms, 0 sms active)
         1,881 sms_message steps · 216 seed rows · 0 enrollments
         vc_default_sms_campaigns / vc_seed_default_sms_campaigns_for /
         vc_seed_default_sms_campaigns                    present
         trigger agents_seed_sms_campaigns on public.agents  present, enabled
```

**Idempotency and the three promises**, in one rolled-back transaction against
the real data: switched one seeded campaign on, renamed it, rewrote its first
message, deleted another — then re-ran the seeder three more times.

```
sms_campaigns_after   107     <- the deleted one did NOT come back
trucker_rows            8     <- eight agents still have it, the ninth does not
still_active            1     <- the one switched on stayed on
kept_name             "MY final expense texts"
kept_body             "My own words entirely."
seed_rows_after       216     <- no new tombstones
```

**A live sweep**, three synthetic leads on the owner's account, all three with
`leads.tcpa_consent` **FALSE** — so this also re-proves that a text campaign
reads TEXT consent and not the calling flag:

| Lead | `campaign_tag` | `consent_records` | Result |
|---|---|---|---|
| SMS3 Alpha | `final_expense` | yes | **enrolled**, step 1, due +2 min |
| SMS3 Bravo | `final_expense` | no | skipped |
| SMS3 Charlie | `trucker` | yes | rule did not match |

```
tick 1 (campaign off)          campaigns swept: 97   <- the 108 sms rows are not read
tick 2 (switched on, dry_run)  enrolled 1
tick 3 (step due)              gate  no_sms_capable_number
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

Before flipping `sms_capable` I confirmed nothing else on the account could
send: 0 conversations, 0 scheduled nudges, 0 live non-dry-run text campaigns.

Afterwards: `sms_capable` back to false everywhere, the campaign off and out of
dry run, every synthetic lead, consent row and enrollment deleted, and
`sms_messages`, `sms_conversations` and `messages` to the test numbers all **0**.
A final unscoped tick swept 9 agents and 97 campaigns with 0 errors and 0 work.

**Flags unchanged.** `supabase/config.toml` has zero diff, and after deploying
`voice-campaign-tick` and `voice-campaign-manage`:

```
ai-call-webhook            {"error":"invalid_signature"}   own check answering
ai-call-tools              {"error":"invalid_secret"}      own check answering
messaging-inbound-webhook  {"error":"invalid_signature"}   own check answering
sms-ai-nudge-sweep         {"error":"unauthorized"}        own check answering
voice-campaign-tick        {"error":"unauthorized"}        own check answering
```

**Voice campaigns untouched:** 108 rows, 97 active, before and after. The
migration reads no voice default and writes no voice row (asserted with comments
stripped, since the file discusses the voice seeder at length). The only shared
code touched is one new exported function nothing on the voice path calls.

---

## What shipped

| File | What |
|---|---|
| `supabase/migrations/20260808_default_sms_campaigns.sql` | the twelve as one jsonb literal, the seeder, the signup hook, the backfill |
| `supabase/functions/_shared/voice-campaign-core.ts` | `vcSmsHoldWouldMissAnchor()` |
| `supabase/functions/voice-campaign-tick/index.ts` | skip-not-hold for a stale anchored step |
| `app.html` (+ `www/` mirrors) | the off-card sentence, `vcampTurnOn()`, `vcampConfirmTurnOn()`, the second seed RPC |
| `test/default-sms-campaigns.test.mjs` | 50 |
| `supabase/functions/_shared/campaign-sms.test.ts` | +2 (56) |
| `docs/sms-campaigns-defaults.md` | the decisions |
| `docs/schema-state.md` | apply ledger for `20260807` (backfilled) and `20260808` |
| `CLAUDE.md` | Phase 9 |

---

# PENDING LIVE VERIFICATION

Everything below needs a real phone, and all of it is blocked on the same one
thing — unchanged from the A2P round, SMS-1 and SMS-2.

1. **🔴 Attach an SMS-capable number to the 10DLC campaign `CD2166Q`.** Until
   then any text campaign an agent turns on will enrol normally and pause on its
   first send with "none of your numbers is set up for texting yet". Proven
   again by tick 3 above.
2. **The first real drip send** from a seeded campaign.
3. **The first real reply** ending a sequence, and the Finished tab saying "They
   wrote back".
4. **The first real appointment reminder**, including one enrolled late enough
   that the earlier steps are skipped.
5. **The two open carrier review items on `CD2166Q`** (`docs/a2p-campaign-draft.md`).
   Nothing here changes the campaign registration, and nothing should carry real
   traffic before those are resolved.

# WHAT NEEDS THE OWNER'S HANDS

Nothing, beyond two readings and one decision that is not mine:

1. **Read the copy.** `docs/reports/PROMPT_SMS3-report.md` has Final Expense in
   full above; the other eleven are in
   `supabase/migrations/20260808_default_sms_campaigns.sql`, which is the only
   copy of them. Editing a body there changes what a *future* agent is seeded
   with; editing it on the Campaigns screen changes what *you* send. The
   campaigns are off, so there is no clock on this.
2. **Turn on the ones you want**, one click and one confirm each. Nothing sends
   until the number is attached anyway.
3. The 10DLC number attachment above — the one item that has now been on three
   consecutive reports.

# 2-MINUTE EYEBALL CHECKLIST

| # | Do this | Expect |
|---|---|---|
| 1 | Hard-refresh → **Campaigns** | **24 cards**, each with a 📞 Voice or 💬 Text badge, and an `All 24 / 📞 Voice 12 / 💬 Text 12` filter above them |
| 2 | Look at the twelve text cards | Every one says **Off**, and under it "Not turned on yet … texts only go to leads with recorded text consent", with a **Turn on** button |
| 3 | Check there is no "Your text campaigns are live" banner | Correct — none of them is |
| 4 | Open **Final Expense (text)** → Steps | 24 message steps, first one 2 minutes after enrollment, waits widening to 90 days |
| 5 | Look at any step's preview and character count | It renders `{{firstName}}` etc. and says about 1 segment. No `{{…}}` anywhere |
| 6 | Open **Appointment Reminder (text)** → Steps | 7 steps, and each reads "1 week before the appointment", "4 hours before the appointment", "45 minutes after the appointment" — not a wait |
| 7 | Press **Turn on** on any text card | A confirm naming the campaign and restating the text-consent rule, plus how many of your leads currently qualify |
| 8 | Press Cancel | The card stays **Off**. Nothing changed |
| 9 | Press **Turn on** again, then OK | The pill flips to **Active**. Within a minute the card shows **Paused** with "none of your numbers is set up for texting yet" — the 10DLC gap, working exactly as designed |
| 10 | Untick **Active** to put it back | Off, and the "Not turned on yet" line returns |
| 11 | Rename one, then reload | Your name survives — the seeder never overwrites |
| 12 | Delete one, then reload | It stays deleted. The seeder never resurrects |

No text is sent and no wallet is charged by any step above.

## Deliberately left

- **No `{{appointmentTime}}`** — a timezone guess on a reminder is worse than
  not stating the time.
- **No `wait` steps in the twelve.** The engine has them; these sequences read
  the same in half the rows.
- **No emojis**, because every campaign type defaults them off and one would
  cost every message that carried it an extra segment.
- **No localisation seam.** The copy is US English and this round did not invent
  one.
- **No confirm on switching a CALLING campaign on** — unchanged behaviour since
  `20260803`.
- **`ai_appointments.status` still never holds `no_show`**, so No-Show
  Follow-Up is wired and waiting, exactly as its voice sibling has been.
