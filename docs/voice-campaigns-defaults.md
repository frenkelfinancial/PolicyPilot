# The twelve pre-built voice campaigns — live on day one

**Added 2026-07-30.** Schema: `supabase/migrations/20260803_default_voice_campaigns.sql`.
Engine: `docs/voice-campaigns.md` (read that first — this file is the *content*
and the *seeding*, that one is the machine).
Consent tool: `supabase/functions/leads-consent`.
Tests: `npm run test:defaultcampaigns`.

Closes `docs/ORION_GAP_ANALYSIS.md` § 1.4.

## The product, in one paragraph

A new agent signs in and twelve voice campaigns are already there, already
active, already wired to the lead types they sell. Nothing to build, nothing to
configure. They do not call anybody until the agent has leads with **recorded
consent** — so the same release ships the bulk consent tool, and both screens
say so in a sentence rather than leaving twelve green cards to imply calls that
are not happening.

---

## 1. What the book actually contains — and why every rule looks the way it does

Audited against production on 2026-07-30: **1,363 leads, 8 agents.**

| field | reality |
|---|---|
| `data.lead_type` | **0 leads** |
| `data.type` | **0 leads** |
| `data.tags` | **0 leads** |
| `data.campaign_tag` | **0 leads** |
| `data.coverage_wanted` | 94 non-empty — and they are **dollar amounts** (`$25k - $50k`, `less than $250,000`) |
| `data.source` | all 1,363 — and they are **lead-vendor names** (`vrc`, `closr1`, `goat leads aged`, …) |
| `data.status` | `new` 757 · `no_answer` 539 · `not_interested` 41 · `appointment` 12 · `sold` 10 · `called` 4 |
| `data.military_status` | 111 (`veteran / retired`, `disabled veteran`, …) |

Two consequences drove every decision below.

**`lead_type` is VIRTUAL and it is shadowed.** It resolves
`coverage_wanted → lead_type → type → source`, and in this book
`coverage_wanted` holds a dollar amount. So the virtual field answers
`"$25k - $50k"` for a tenth of the book and falls through to a vendor name for
the rest. A campaign keyed on it alone would match almost nobody, and the few it
matched it would match by accident.

**`campaign_tag` is therefore the canonical field**, and this round is what
creates it. It was already in `VC_TAG_FIELDS` and already offered by the rule
editor; nothing had ever written it. Now three things do:

| Where | How |
|---|---|
| Add Lead modal | a `Campaign Tag` dropdown of the seven canonical values |
| CSV import | a `Campaign Tag` column option, auto-detected from headers like `lead type`, `vertical`, `product type` |
| `lead-ingest` webhook | vendor keys `lead_type` / `leadtype` / `campaign_tag` / `vertical` / `product_type`, normalised to snake_case |

`campaign` is **deliberately not** an alias on any of the three: `source`
already claims it, and for most vendors "campaign" means their *ad* campaign,
not a lead type.

### Why `military_status` was NOT used

It is the one field in this book that genuinely identifies veterans (111 rows),
and it was considered for `VC_TAG_FIELDS`. It was rejected because its values
are one vendor's dropdown wording — `veteran / retired`, `disabled veteran`,
`reserve / guard` — so catching them all means seven hard-coded strings in a
default that ships to every agent, most of whom have never heard of that
vendor. A campaign keyed to one lead company's spelling is a campaign that
quietly stops working when they change it. The Veteran campaign takes a tag
instead, and an agent whose book carries `military_status` maps that column to
`Campaign Tag` on import once.

---

## 2. The twelve, and exactly what each one is wired to

`sort_order` is the order on screen **and** the order the tick evaluates in —
see § 4.

| # | Campaign | Steps | Trigger | Matches on | Stops on |
|---|---|---|---|---|---|
| 10 | **Appointment Reminder** | 2 | an appointment is booked | `status is appointment` | sold · DNC |
| 20 | **No-Show Follow-up** | 5 | an appointment is marked `no_show` | `status is appointment` | booked · sold · answered 15s · DNC |
| 30 | **Customer Care** | 6 | the lead is marked sold | `status is sold` | **DNC only** |
| 40 | **Emergency Contact** | 5 | the lead is marked sold | `status is sold` | answered 15s · DNC |
| 50 | **Beneficiary Referral** | 5 | the lead is marked sold | `status is sold` | answered 15s · DNC |
| 60 | **Chargeback Recovery** | 9 | the tag is applied | `campaign_tag is chargeback` OR `status is chargeback` | booked · sold · answered 15s · DNC |
| 70 | **Veteran Lead** | 6 | a new lead arrives | `campaign_tag is veteran` OR `lead_type is` veteran / veterans / va | booked · sold · answered 15s · DNC |
| 80 | **Final Expense** | 6 | a new lead arrives | `campaign_tag is final_expense` OR `lead_type is` "final expense" / final_expense / fex / burial | as above |
| 90 | **Mortgage Protection** | 6 | a new lead arrives | `campaign_tag is mortgage_protection` OR `lead_type is` "mortgage protection" / mortgage_protection / mortgage | as above |
| 100 | **IUL** | 6 | a new lead arrives | `campaign_tag is iul` OR `lead_type is` iul / "indexed universal life" | as above |
| 110 | **General Life** | 6 | a new lead arrives | `campaign_tag is general_life` OR `lead_type is` "general life" / life / "term life" / "whole life" | as above |
| 120 | **Trucker** | 6 | a new lead arrives | `campaign_tag is trucker` OR `lead_type is` trucker / "truck driver" / cdl | as above |

Every lead-type campaign carries the canonical tag as its **first** group and
the natural words a vendor might already have written as further OR groups — so
a book that already says "veteran" works with no tagging at all, and a book that
says nothing works the moment one column is mapped on import.

**Cadence.** The six lead-type campaigns are identical and deliberately so:
call within a minute, double-dial two hours later (throttled 40/hour), then day
1, day 3, day 7, day 14. Speed-to-lead then decay.

### Two honest gaps, stated rather than hidden

- **Nothing marks an appointment `no_show` yet.** `ai_appointments.status` only
  ever holds `scheduled` in production today, so No-Show Follow-up is wired,
  active and waiting. It fires the day the calendar round writes that status.
  Shipped active rather than held back because a campaign that exists and is
  empty is honest; one that is missing looks like a feature nobody built.
- **Chargeback is a POLICY status, not a lead one.** The policy tracker knows
  about chargebacks; `leads.data.status` does not, and inventing a lead↔policy
  write path was out of scope. So Chargeback Recovery enrols on an applied
  `campaign_tag`, and its rule *also* accepts `status is chargeback` so it
  starts working for free if that status is ever written.

---

## 3. The tag guard, widened by exactly four values

The original rule: **every trigger group must carry a positive (`is`) condition
on a lead-type / campaign-tag field**, because a campaign whose rule matches the
whole book is the one mistake in this feature that cannot be taken back once the
calls have gone out.

Six of the twelve are **lifecycle** campaigns — call the client we just sold,
remind the person whose appointment is tomorrow, chase the one who did not show.
Their audience is bounded by a terminal status and by the trigger, not by a
lead-type tag, and under the original rule **they could not be expressed at
all.**

So `status` now counts as a narrowing condition, for **four values only**:

```
sold · appointment · chargeback · lapsed
```

Each describes people who have already been through something. **`status is
new` still does not count** — it describes every fresh row in the book, which
is the exact reason `status` was left out of `VC_TAG_FIELDS` in the first
place — and neither do `called`, `no_answer` or `not_interested`. `is_not`
never narrows, in either case.

Same four values in all three enforcement points, and a test compares them:

| Where | Function |
|---|---|
| the editor | `vcIsNarrowingCondition()` in `// <vcamp-core>` |
| the server | `vcIsNarrowingCondition()` in `_shared/voice-campaign-core.ts` |
| the database | `voice_campaigns_validate()` in `20260803` |

Verified against production: `status is new` and `status is_not sold` are both
refused by the database trigger; `status is sold` is accepted.

---

## 4. `sort_order` is load-bearing, not cosmetic

The seeder writes twelve rows in **one transaction**, so `now()` is identical
for all twelve and `created_at` cannot order them. That matters twice.

**On screen**, twelve cards in a different order on every refresh is a product
that looks broken.

**In the tick**, three of the twelve trigger on the same event — a client was
sold — while **a lead may be ACTIVE in only one voice campaign at a time** (a
partial unique index says so). Without an order, *which* of the three enrols a
newly-sold client is whatever PostgreSQL returned first, and it could differ
minute to minute.

With one, they form a stated queue: **Customer Care takes the client; when it
completes, Emergency Contact takes them; then Beneficiary Referral.** A
newly-sold client is never phoned by three robots in one week. That is the
feature, not a limitation — and it is why the tick's campaign query now orders
by `sort_order, id`.

---

## 5. Appointment-anchored steps — the smallest extension that works

Every other step in this engine waits a while after the previous one. An
appointment reminder cannot: "the day before" and "two hours before" are
measured backwards from a fixed instant.

So: **two optional columns and nothing else.**

```
anchor          'previous_step' (default, every hand-made step) | 'appointment'
offset_minutes  only read for an appointment anchor. NEGATIVE is before.
```

`voice_campaign_enrollments.appointment_id` carries which meeting.

**The skip rule is the other half.** `vcResolveNextDue()` walks forward from the
current position; an anchored step whose moment has already gone is **SKIPPED,
never fired late**. A reminder delivered after the appointment tells somebody
they are about to miss something they have already missed, and that is worse
than saying nothing.

- Enrolled two days out → lands on the day-before reminder.
- Enrolled six hours out → the day-before step is skipped; lands on the
  two-hours-before one.
- Enrolled ninety minutes out → both are past; **the lead is not enrolled at
  all**, because a dead enrollment on the Enrollments tab reads as a promise
  the product is not going to keep.
- No appointment at all → `reason: 'no_appointment'`, and nothing is scheduled.
  Guessing an instant would invent a reminder for a meeting nobody booked.

Ordinary steps are **never** skipped: their due time is computed forward from
`now`, so it is in the future by construction.

**The enrollment RE-ARMS.** A client who booked in March, was reminded, and
books again in June should be reminded again. Re-enrolling is impossible —
`(campaign_id, lead_id)` is unique — so the finished row is *reset in place*
against the new `appointment_id`. This is the only place the engine's
"never re-enrol a lead a campaign has already seen" rule is relaxed, and it is
relaxed for exactly one campaign shape.

A cancelled appointment stops the enrollment (`appointment_cancelled`); one that
has been and gone stops it too (`appointment_passed`). Both by name, so the
Enrollments tab says which.

**The Steps tab carries `anchor` and `offset_minutes` through its save.** That
tab deletes and re-inserts every row, so a save path that did not name those two
would quietly turn "the day before" into "immediately" the first time anybody
opened the Appointment Reminder and pressed Save. A test asserts it.

---

## 6. Per-campaign AI behaviour — `campaign_goal`

A reminder call, a qualification call, a customer-care check-in and a referral
ask cannot open with the same sentence. `voice_campaigns.campaign_goal` travels
`voice-campaign-tick` → `ai-call-start` → `client_state.vars` → the webhook.

**Only the REASON CLAUSE changes.** The opener and
`I'm an assistant calling on behalf of {agent} with {agency}.` are byte-identical
on every call, because that part **is the disclosure**.

| goal | reason clause |
|---|---|
| *(blank / unknown / `qualify`)* | `I'm reaching out about the {lead_type} coverage you asked about — do you have a quick minute?` |
| `remind` | `I'm just calling to confirm the appointment you have coming up with them — does that still work for you?` |
| `rebook` | `We had a time set aside for you and we weren't able to reach you — did you still want to get that rescheduled?` |
| `care` | `I'm just checking in on your coverage — is everything still working the way you expected?` |
| `emergency_contact` | `I'm just tidying up your file — is there someone we should have down as an emergency contact?` |
| `referral` | `I wanted to ask you something quick about the people you named on your policy — have you got a minute?` |
| `chargeback` | `I'm reaching out because it looks like your coverage may have lapsed — do you have a quick minute to sort it out?` |

The column is **CHECK-constrained**, not free text: an unrecognised value would
silently fall back to the qualification greeting, i.e. a robot phoning somebody
two hours before an appointment to ask about coverage they already bought.
`ai-call-start` normalises an unknown value to `qualify` rather than passing it
through, so a typo lands on a script rather than on none.

**The assistant branches on the phrases, not on a variable.** A new
`WHY YOU'RE CALLING — READ YOUR OWN OPENING LINE` section of the instructions
tells it to take the reason from the line it just spoke. That is deliberate:
`assistant.dynamic_variables` is the field that returned a 503 on the greeting's
critical path, and nothing goes back on that path to make something downstream
tidier. **Reword a row in that table and the matching bullet in the
instructions has to be reworded in the same commit** — a test checks both ends.

---

## 7. Seeding — idempotent, and respectful

### The tombstone is the whole idea

`voice_campaign_seed_state (agent_id, seed_key)` records that a default was
**offered**. It is never removed by anything automatic.

"Has this agent already been given the Veteran Lead default?" cannot be answered
by looking for the campaign, because **an agent who DELETED it looks exactly like
an agent who never had it** — and re-creating a campaign somebody deliberately
deleted is the worst thing a seeder can do. It would restart a program that
phones consumers.

So the seeder's first act per campaign is one `INSERT … ON CONFLICT DO NOTHING`
against that table, and `FOUND` is what decides whether the campaign gets built.
Idempotency lives in a primary key rather than in the caller remembering.

Verified against production, all three promises, in a rolled-back transaction:

| | result |
|---|---|
| re-run the seeder | 0 created, still 12 |
| deactivate + rename one, re-run | `active=false name="MY EDITED NAME"` — untouched |
| **delete one, re-run** | **does not come back**; 11, not 12 |

The seeder contains no `UPDATE`, no `DO UPDATE`, and no `DELETE` against any
campaign table. A test asserts each.

### Who runs it

| Caller | Function |
|---|---|
| a new agent | `agents_seed_voice_campaigns` — **AFTER INSERT on `public.agents`** |
| the app, on every visit to Campaigns | `vc_seed_default_campaigns()` — no parameter, anchored on `auth.uid()` |
| a backfill | `vc_seed_default_campaigns_for(uuid)` — **REVOKEd from `anon`/`authenticated`** |

The hook is on `public.agents` rather than inside `auth.handle_new_user()`:
every path that creates an agent goes through that table, and a trigger there
cannot break sign-up by editing a function the `auth` schema owns. **It swallows
its own exceptions on purpose** — a sign-up must never fail because a default
campaign did not insert. The cost is an agent with no campaigns, which the
idempotent app-side call repairs; the cost of not swallowing is an account that
cannot be created.

The JSON lives in **exactly one place**: `vc_default_campaigns()`, as a single
`$json$…$json$::jsonb` literal. There is no TypeScript copy to drift from —
`test/default-campaigns.test.mjs` extracts that literal out of the migration
text and runs every rule through the real matcher.

---

## 8. Consent — the only thing between the twelve and a dial

`ai-call-start`'s gate 3 refuses any lead whose `leads.tcpa_consent` is not
true, and **not one lead in this production book has ever carried it**. So all
twelve are live, correct, and enrol nobody. The consent genuinely exists — on
the vendor's form, the web form, the inbound call — it has simply never been
written down anywhere the gate can see.

### The tool

Leads screen → select (individual checkboxes or **select all across the
filter**) → **Record consent**:

- a **source**: vendor opt-in (which vendor — required), my own web form, they
  called me, existing client, or something else;
- an **attestation checkbox that is NOT pre-ticked**, and Record stays disabled
  until it is.

**The friction is the feature.** The agent is putting their name to a statement
about what a consumer agreed to. A pre-ticked box would make that a formality,
and the sentence they tick is stored **verbatim** on every row:

> I confirm these leads gave prior express consent to be contacted by phone by
> me or my agency.

On confirm, per lead: `tcpa_consent = true`, `tcpa_consent_source`,
`tcpa_consent_at = now()`, and one `lead_consent_events` row carrying the
attestation, the source, the phone as it stood and the instant.

The header then reads **"87 of 122 callable by AI"**, from `voiceCallableCount()`
— one definition, also read by the campaign banner and the AI dialer note, so
the three screens cannot disagree about whether the account can dial anybody.

### Four boundaries worth naming

**🔴 `leads.tcpa_consent` is no longer writable from a browser.** `public.leads`
is fully owner-writable — it has to be, the lead book re-upserts every row on
every save — which meant that until `20260803` a browser could set the column by
itself and gate 3 would honour it: no attestation, no named source, no audit
row, no friction. `leads_protect_consent_columns` closed that, and
`leads-consent` is the only door left. **The guard has NO admin exemption**,
unlike the `phone_numbers` and `agents` guards: those protect ownership and
billing fields an admin legitimately administers, and there is no version of
"an administrator may assert consent on a consumer's behalf" worth writing down.
The Phase 1 AI test rig used to set the column inline and now goes through the
endpoint like everything else — making it a special case would have left the
guard with a hole shaped like that one function.

**The agent comes from the JWT.** There is no agent id in the request body, and
every read and write is `.eq("agent_id", user.id)`, so the id list is a
selection and not a boundary. Somebody else's lead comes back `not_found`.

**A person on `dnc_list` cannot be consented back.** They said stop, at a level
an attestation cannot reach back through. Same rule and the same reasoning as
`messaging-consent-record`.

**Revoking never touches DNC or suppression.** "I was wrong to think I had
consent" and "this person told me never to call again" are different statements,
and collapsing them either over- or under-reports what the consumer actually
said. Revoking stops the calls immediately (gate 3 refuses) and records why.
Per-lead, from the green **AI ✓** chip on the lead card.

**This is a different permission from texting.** `consent_records` is the SMS
gate's evidence, read by `runComplianceGate` on every send; `leads.tcpa_consent`
is what `ai-call-start` reads. `leads-consent` does not write `consent_records`
and must not — recording voice consent must never silently widen what may be
texted.

---

## 9. Zero blank state, honestly

Twelve live cards from the first minute. When the agent's consented-lead count
is **0** and any campaign is active, one calm banner sits above them:

> **Your campaigns are live** — they'll begin calling automatically as soon as
> you have leads with recorded consent. **Record consent →**

The same sentence appears in the AI dialer area, from the same function. Both
disappear the moment they stop being true; a permanent nag is a banner people
stop reading.

Shipping twelve campaigns active is defensible — every call still passes the
full six-gate chain. Shipping them active *without saying so on screen* is not.

---

## 10. Verified in production, 2026-07-30 → 31 (no phone rang)

Applied, audited before and after. **108 campaigns across 9 agents** (12 each),
**612 steps**, 0 enrollments, 0 `ai_calls`.

```
seed        → 9 agents × 12 campaigns, all active, sort_order 10..120
            → goals present: qualify, remind, rebook, care,
                             emergency_contact, referral, chargeback
            → Appointment Reminder steps: 1:appointment@-1440, 2:appointment@-120

consent     → attestation missing            → 422 attestation_required
            → vendor opt-in with no vendor   → 422 source_detail_required
            → another agent's lead id        → skipped {not_found: 1}
            → the real thing                 → {"granted":1,
                                                "source":"vendor_optin: proof harness"}
            → lead row: consent=true, source recorded, at stamped
            → audit row: attestation stored VERBATIM

enrol       → the LIVE pg_cron tick enrolled the consented lead into exactly ONE
              campaign — Final Expense — matched through `lead_type is final
              expense`. The other 122 leads stayed dormant: no consent.
              enrolled_by=auto, step 1, due +1 minute.

dial (dry)  → gates_passed 1 kill switches · 2 plan tier ·
                           3 consent / DNC / suppression ·
                           4 lead-local quiet hours · 5 daily cap · 6 wallet floor
            → vars {lead_type "final expense", campaign_name "Final Expense",
                    campaign_step "1", campaign_goal "qualify", ai_name "Ashley"}
            → caller +12029981783, recommended 150, used 11, headroom 139
            → advance next_step → position 2, due +2h
            → ai_calls rows written: 0

guard       → browser UPDATE of tcpa_consent   → silently reverted to false/null
            → service-role UPDATE              → applied
            → browser edits data.note          → applied; consent survives
```

**Cleanup done, and stated plainly:** the proof enrollment was stopped, the
proof lead deleted (its consent-audit rows cascaded with it), and all twelve
campaigns restored to `dry_run = false`. Final state: **12 active, 0 dry-run,
0 paused, 0 active enrollments anywhere, 0 queued, 0 leads with consent in the
entire database, 0 campaign calls ever placed.** A clean tick afterwards swept
all 9 agents and all 108 campaigns and did nothing.

Nothing is left queued. The cron will not dial anybody tonight.

---

## Known-fragile

- **The three sold-triggered campaigns queue rather than run together.** That is
  the one-active-campaign index doing its job, and `sort_order` is what makes
  the queue deterministic. Renumbering those three changes who gets called
  first.
- **A lead-type campaign only sees a tag that exists at enrollment time.**
  Tagging a lead after it has already been swept by another campaign does
  nothing until that enrollment finishes — the engine never re-enrols a lead a
  campaign has already seen, except the appointment re-arm in § 5.
- **`seed_key` values carry a `_v1` suffix.** A future round that wants to ship
  a *changed* Veteran cadence to existing agents cannot edit `veteran_lead_v1` —
  the seeder will not overwrite it, by design. It would ship `veteran_lead_v2`,
  and would have to decide what that means for an agent still running v1.
- **The consent tool touches at most 2,000 leads per request.** A larger batch
  is refused with a sentence rather than truncated.
