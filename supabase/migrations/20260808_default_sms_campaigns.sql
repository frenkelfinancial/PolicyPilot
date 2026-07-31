-- ============================================================
-- 20260808_default_sms_campaigns.sql
-- The twelve pre-written TEXT campaigns — built, visible, and SWITCHED OFF.
--
-- Read docs/sms-campaigns-defaults.md alongside this. The DECISIONS live
-- there; this file is the shape. The engine these run on is SMS-2
-- (20260807_sms_campaigns.sql + docs/sms-campaigns.md) and nothing about it
-- changes here: a row in `voice_campaigns` with `channel = 'sms'` is a texting
-- campaign, run by the same tick, the same enrollment model, the same claim
-- and the same stop machinery as a calling one.
--
-- ---- 🔴 THE ONE DIFFERENCE FROM THE VOICE DEFAULTS -------------------------
--
-- The twelve voice campaigns (20260803) ship ACTIVE. These twelve ship
-- `active = false`. Owner's decision, and the reason is asymmetry of harm: a
-- calling campaign on a book with no consented leads enrols nobody and dials
-- nobody, so shipping it live costs nothing and saves a setup step. A text
-- arrives on a phone and stays there. A surprise text is more invasive than a
-- call that never happened, and an agent who has not read the copy has not yet
-- agreed to send it.
--
-- So: twelve cards, every step written, every rule set, nothing sent until
-- somebody presses the switch. The card says so in one sentence and the switch
-- asks once, restating the consent gate.
--
-- ---- 🔴 THE SEED KEYS ARE THE SMS AI CAMPAIGN TYPES, EXACTLY ---------------
--
-- `voice-campaign-tick` passes `campaign.seed_key` STRAIGHT THROUGH to
-- sendCampaignSms as `campaignType`; getOrCreateConversation() stores it
-- verbatim in `sms_conversations.campaign_type`; and loadSettings() matches it
-- against `sms_ai_settings.campaign_type` with an exact string compare and a
-- SILENT fallback to `default`.
--
-- So a key of `sms_final_expense_v1` would not fail loudly. It would quietly
-- answer every Final Expense drip in the Default voice, for ever. The twelve
-- keys below are therefore the twelve SMS_AI_TYPES values from
-- _shared/sms-ai-core.ts, character for character, and a test compares the two
-- lists. They cannot collide with the voice defaults' `*_v1` keys, so the
-- (agent_id, seed_key) uniqueness that the tombstone rests on is untouched.
--
-- ---- 🔴 THE INSERT ORDER IS THE SMS-2 CONTRACT -----------------------------
--
-- INSERT INACTIVE -> INSERT STEPS -> ACTIVATE, all in one transaction.
-- voice_campaigns_validate() refuses an ACTIVE text campaign that has no
-- sms_message steps, and a campaign row is necessarily written before the steps
-- that reference it, so `active = true` on the insert raises every time. The
-- seeder below does all three; for these twelve the third is a no-op because
-- every one of them ships off, and that is deliberate rather than accidental —
-- a future default that ships live works with no change to this function.
--
-- Idempotent: safe to run more than once. Wrap in begin/commit when applying.
-- ============================================================

-- ============================================================
-- PART 1 — the twelve
-- ============================================================
--
-- ONE COPY, HERE. test/default-sms-campaigns.test.mjs extracts this literal
-- out of the migration text and runs every rule through the REAL matcher and
-- the REAL validator, and every body through the REAL renderer and the REAL
-- segment counter. There is no second copy in TypeScript to drift from — the
-- same arrangement vc_default_campaigns() has.
--
-- ---- THE TRIGGERS ARE THE VOICE ONES, MIRRORED -----------------------------
--
-- Byte-for-byte the same `trigger_groups` as each campaign's voice sibling in
-- 20260803, for the same reason that file gives at length: the production book
-- carries NO `lead_type`, NO `tags` and NO `type`; `coverage_wanted` holds
-- dollar amounts and `source` holds vendor names. `campaign_tag` is the
-- canonical field and the six canonical values were created by that round.
-- Each lead-type campaign therefore carries the canonical tag as group 1 and
-- the natural vendor words as further OR groups.
--
-- Mirroring rather than re-deriving is the point: an agent who tags a lead
-- `veteran` expects BOTH the calling campaign and the texting campaign to
-- recognise it. Two definitions of "this is a veteran lead" on one book is the
-- bug class this repo has fixed four times.
--
--  Campaign              Trigger                    Matches on
--  --------------------  -------------------------  --------------------------
--  Appointment Reminder  appointment booked         status is appointment
--  No-Show Follow-Up     appointment marked no_show status is appointment
--  Customer Care         lead marked sold           status is sold
--  Emergency Contact     lead marked sold           status is sold
--  Beneficiary Referral  lead marked sold           status is sold
--  Chargeback Recovery   tag applied                campaign_tag is chargeback
--  Veteran               new lead                   campaign_tag is veteran | ...
--  Final Expense         new lead                   campaign_tag is final_expense | ...
--  Mortgage Protection   new lead                   campaign_tag is mortgage_protection | ...
--  IUL                   new lead                   campaign_tag is iul | ...
--  General Life          new lead                   campaign_tag is general_life | ...
--  Trucker               new lead                   campaign_tag is trucker | ...
--
-- ---- WHY THERE IS NO `campaign_goal` ---------------------------------------
--
-- `campaign_goal` is documented as what this CALL is for: it travels to
-- ai-call-start, becomes the reason clause of the SPOKEN greeting and selects a
-- branch of the assistant's instructions. Nothing on the text path reads it.
-- Setting it on a campaign that never dials would put a value in a column that
-- describes something the row does not do. A text campaign's tone is carried by
-- the copy itself, and the responder's tone by the `sms_ai_settings` row the
-- seed_key resolves to. So it stays NULL, on purpose.
--
-- ---- WHY THERE ARE NO `wait` STEPS -----------------------------------------
--
-- The engine has them and they work (vcResolveNextDue folds them). They are not
-- used here because every sequence below is a straight run of messages, and a
-- step's own wait_value expresses that in one row instead of two. "Send / wait
-- 2 days / send" and one step with a two-day wait produce the identical
-- schedule; at 24 steps it is also the difference between 24 rows and 47.
-- A hand-built campaign is exactly where a `wait` step reads better, and the
-- editor still offers it.
--
-- ---- 🔴 EVERY BODY IS PLAIN ASCII, AND THAT IS A COST DECISION -------------
--
-- The GSM-7 alphabet (_shared/segments.ts) has no em dash, no curly quote and
-- no emoji. ONE of them anywhere in a message forces the whole thing to UCS-2,
-- where a segment is 67 characters instead of 153 — so a 200-character text
-- goes from 2 segments to 3, on every send, for ever. A test runs every body
-- through countSegments() and fails on a UCS-2 result.
--
-- That also answers the emoji question the brief left open ("only where the
-- per-type setting would default on"): `defaultSmsAiSettings()` has
-- `emojis: false` for all thirteen types, so the answer is nowhere.
--
-- ---- THE OPT-OUT RULE, STATED SO IT CAN BE TESTED --------------------------
--
-- A message step must carry a "Reply STOP" line when it is
--   (a) the FIRST message of the sequence — it is the one that introduces a
--       number the consumer has not seen before; or
--   (b) at a position congruent to 1 mod 5 (1, 6, 11, 16, 21, 26) — the
--       "roughly every fifth message" rule; or
--   (c) the first message after a gap of 45 DAYS OR MORE. A text arriving four
--       months after the last one is a new conversation to the person reading
--       it, whatever our database thinks.
-- Bodies may carry one anywhere else too; the rule is a floor, not a ceiling.
-- ============================================================
create or replace function public.vc_default_sms_campaigns()
returns jsonb
language sql
immutable
as $fn$
select $json$
[
  {
    "seed_key": "appointment_reminder",
    "sort_order": 210,
    "name": "Appointment Reminder (text)",
    "description": "Five reminders counting down to the appointment, then a follow-up after it. Anchored to the appointment itself, so a step whose moment has passed is skipped rather than sent late.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "appointment" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": true,
    "stop_on_appointment_booked": false,
    "stop_on_sold": true,
    "stop_on_reply": false,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1, "step_type": "sms_message", "anchor": "appointment", "offset_minutes": -10080,
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. We're booked in a week from today to go over your options. I'll send a reminder nearer the time. Reply STOP to opt out." },
      { "position": 2, "step_type": "sms_message", "anchor": "appointment", "offset_minutes": -4320,
        "body": "{{firstName}}, our call is 3 days out. Still a good time for you?" },
      { "position": 3, "step_type": "sms_message", "anchor": "appointment", "offset_minutes": -1440,
        "body": "Quick reminder {{firstName}}, we're talking tomorrow. Anything you'd like me to have ready?" },
      { "position": 4, "step_type": "sms_message", "anchor": "appointment", "offset_minutes": -240,
        "body": "{{firstName}}, we're on in about 4 hours. If something has come up, just reply here and we'll move it." },
      { "position": 5, "step_type": "sms_message", "anchor": "appointment", "offset_minutes": -60,
        "body": "Talk in about an hour, {{firstName}}. I'll ring the number you gave me." },
      { "position": 6, "step_type": "sms_message", "anchor": "appointment", "offset_minutes": 45,
        "body": "Thanks for your time, {{firstName}}. If we missed each other, reply here and I'll find another slot. Reply STOP to opt out." },
      { "position": 7, "step_type": "sms_message", "anchor": "appointment", "offset_minutes": 1440,
        "body": "{{firstName}}, anything from yesterday you'd like me to put in writing? Happy to send it over. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "no_show_followup",
    "sort_order": 220,
    "name": "No-Show Follow-Up (text)",
    "description": "They booked and we missed each other. Eighteen texts over about seven months, front-loaded on the day itself, rebooking without ever making it their fault.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "appointment" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": true,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 15, "wait_unit": "minutes",
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. Looks like we missed each other. Happy to try again whenever suits you. Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "hours",
        "body": "No problem at all, {{firstName}}. Later today, or would tomorrow be easier?" },
      { "position": 3,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "{{firstName}}, still want to look at this? I can do mornings or evenings, whichever is easier." },
      { "position": 4,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Just send me a day and a rough time and I'll make it work." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 3,  "wait_unit": "days",
        "body": "{{firstName}}, if calls aren't your thing we can do the whole thing by text. Genuinely fine either way." },
      { "position": 6,  "step_type": "sms_message", "wait_value": 4,  "wait_unit": "days",
        "body": "It's {{agentName}} at {{companyName}}. Still happy to pick this up whenever you are. Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 5,  "wait_unit": "days",
        "body": "{{firstName}}, has something changed, or is it just a busy week? Either is fine." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Been a week. Want me to keep a slot open, or park it for now?" },
      { "position": 9,  "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "{{firstName}}, park it is a perfectly good answer. Just let me know either way." },
      { "position": 10, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "Still here if you want those numbers, {{firstName}}." },
      { "position": 11, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "{{firstName}}, a quick yes or no is all I need and I'll act on it. Reply STOP to opt out." },
      { "position": 12, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "If you sorted this out elsewhere, that's genuinely fine. Tell me and I'll stop." },
      { "position": 13, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "Checking in, {{firstName}}. Anything changed since we last spoke?" },
      { "position": 14, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "{{firstName}}, still happy to rebook whenever suits you." },
      { "position": 15, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "No pressure from me. The door stays open. - {{agentName}}" },
      { "position": 16, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. It's been about a month. Want to try again? Reply STOP to opt out." },
      { "position": 17, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Checking in once more, {{firstName}}. Happy to work around whatever is easiest for you. Reply STOP to opt out." },
      { "position": 18, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Last one from me, {{firstName}}. I'm on {{agentPhone}} if you ever want to pick it up. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "customer_care_sold",
    "sort_order": 230,
    "name": "Customer Care (text)",
    "description": "Twelve check-ins across the first two and a half years of a policy, at the moments that actually matter. It is not selling anything, so it does not stop when they reply.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "sold" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": true,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": false,
    "stop_on_sold": false,
    "stop_on_reply": false,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 1,   "wait_unit": "days",
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. Your policy is in, welcome aboard. I'll check in now and then. Nothing needed from you today. Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 6,   "wait_unit": "days",
        "body": "{{firstName}}, your paperwork from {{carrier}} should be with you. Anything on it you want explained, just ask." },
      { "position": 3,  "step_type": "sms_message", "wait_value": 23,  "wait_unit": "days",
        "body": "First month in, {{firstName}}. Did the first payment come out cleanly?" },
      { "position": 4,  "step_type": "sms_message", "wait_value": 30,  "wait_unit": "days",
        "body": "{{firstName}}, quick one: is the beneficiary on file still who you want it to be? Easy to change if not." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 60,  "wait_unit": "days",
        "body": "Hope you're well, {{firstName}}. Nothing needed here, just so you know I'm still your point of contact. Reply STOP to opt out." },
      { "position": 6,  "step_type": "sms_message", "wait_value": 90,  "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. Three months in. Anything changed - address, bank, phone? Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 90,  "wait_unit": "days",
        "body": "Half a year, {{firstName}}. If anything has changed at home, a marriage, a baby, a house, it's worth five minutes on the policy. Reply STOP to opt out." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 90,  "wait_unit": "days",
        "body": "Checking in, {{firstName}}. Still happy with how everything is set up? Reply STOP to opt out." },
      { "position": 9,  "step_type": "sms_message", "wait_value": 90,  "wait_unit": "days",
        "body": "{{firstName}}, that's a year. Thank you for staying with us. Anything you want reviewed, just say the word. Reply STOP to opt out." },
      { "position": 10, "step_type": "sms_message", "wait_value": 180, "wait_unit": "days",
        "body": "Eighteen months in, {{firstName}}. Circumstances change and so does what makes sense. Happy to check yours still does. Reply STOP to opt out." },
      { "position": 11, "step_type": "sms_message", "wait_value": 180, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} with {{companyName}}. Two years now. Anything you'd like me to look at? Reply STOP to opt out." },
      { "position": 12, "step_type": "sms_message", "wait_value": 180, "wait_unit": "days",
        "body": "Still here whenever you need me, {{firstName}}, on {{agentPhone}}. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "emergency_contact",
    "sort_order": 240,
    "name": "Emergency Contact (text)",
    "description": "Asks a new client for one thing: somebody to contact if we cannot reach them. Eight polite asks over three months, and it stops the moment they answer.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "sold" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": true,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": false,
    "stop_on_sold": false,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1, "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. One small thing for your file: who should we contact if we can't reach you? A name and number is all I need. Reply STOP to opt out." },
      { "position": 2, "step_type": "sms_message", "wait_value": 3,  "wait_unit": "days",
        "body": "{{firstName}}, no rush on that emergency contact. Whenever you get a second." },
      { "position": 3, "step_type": "sms_message", "wait_value": 5,  "wait_unit": "days",
        "body": "Just a name and a number and I'll add it, {{firstName}}. It's the only thing missing." },
      { "position": 4, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "{{firstName}}, this matters if the policy is ever claimed and we can't reach you. Takes ten seconds." },
      { "position": 5, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "Still after one emergency contact for your file whenever you have a moment." },
      { "position": 6, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. Last ask on the emergency contact, a name and number is plenty. Reply STOP to opt out." },
      { "position": 7, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "No problem at all if you'd rather not, {{firstName}}. Just say and I'll mark it declined." },
      { "position": 8, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Leaving it there, {{firstName}}. If you ever want to add someone, I'm on {{agentPhone}}. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "beneficiary_referral",
    "sort_order": 250,
    "name": "Beneficiary Referral (text)",
    "description": "Asks the CLIENT whether the people they named would want the same conversation. It never texts a beneficiary - a person named on an application has not asked to hear from anyone.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "status", "op": "is", "value": "sold" }] }
    ],
    "auto_enroll_new_leads": false,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": true,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": false,
    "stop_on_sold": false,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. A question, only if you're comfortable with it: would any of the people you named want the same conversation? Reply STOP to opt out." },
      { "position": 2, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "{{firstName}}, no obligation at all. I only ever reach out to somebody who has asked me to." },
      { "position": 3, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "If anyone comes to mind, {{firstName}}, the easiest thing is to pass on my number: {{agentPhone}}." },
      { "position": 4, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "{{firstName}}, most of my work comes from people passing my name along. If that isn't for you, no problem at all." },
      { "position": 5, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Still here if anyone in the family wants a look at their own cover, {{firstName}}." },
      { "position": 6, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. The same offer stands for anyone you'd like me to help. Reply STOP to opt out." },
      { "position": 7, "step_type": "sms_message", "wait_value": 60, "wait_unit": "days",
        "body": "Nothing needed from you on this, {{firstName}}. Just so you know the door is open. Reply STOP to opt out." },
      { "position": 8, "step_type": "sms_message", "wait_value": 90, "wait_unit": "days",
        "body": "Last one on this, {{firstName}}. If somebody ever wants a hand, my number is {{agentPhone}}. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "chargeback_recovery",
    "sort_order": 260,
    "name": "Chargeback Recovery (text)",
    "description": "Ten texts over three months to a client whose cover came off the books. Empathetic by design: this is about putting protection back, never about money owed.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "chargeback" }] },
      { "conditions": [{ "field": "status", "op": "is", "value": "chargeback" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 5,  "wait_unit": "minutes",
        "drip_rate": { "per_minutes": 60, "max_calls": 60 },
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. Your policy has come off the books, which is usually just a missed draft. Want me to see about putting it back? Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 4,  "wait_unit": "hours",
        "body": "No lecture from me, {{firstName}}. These things happen. Just tell me if you want it back in place and I'll take it from there." },
      { "position": 3,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "{{firstName}}, if the draft date with {{carrier}} was the problem, we can usually move it to match your payday." },
      { "position": 4,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Still happy to help sort this out. Putting cover back is usually simpler than starting over." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 4,  "wait_unit": "days",
        "body": "{{firstName}}, if money is tight right now, say so. There is often a smaller amount that still keeps something in place." },
      { "position": 6,  "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "It's {{agentName}} at {{companyName}} again. Your cover is off at the moment. Want me to look at the options? Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "{{firstName}}, no pressure at all. I'd rather you knew where you stand than assumed it was still active." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "If you'd rather leave it, that's your call and I'll stop asking. Just let me know." },
      { "position": 9,  "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "{{firstName}}, checking in once more. If you want cover back in place, I can usually get it done in a day." },
      { "position": 10, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Last one from me, {{firstName}}. I'm on {{agentPhone}} if you ever want to pick this back up. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "veteran_lead",
    "sort_order": 270,
    "name": "Veteran (text)",
    "description": "Twenty-six texts over about fifteen months for veteran leads. Opens inside two minutes, says plainly that we are not the VA, then decays from hours to months.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "veteran" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "veteran" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "veterans" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "va" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "minutes",
        "drip_rate": { "per_minutes": 60, "max_calls": 60 },
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. You asked about coverage for veterans and their families. We're an independent agency, not the VA. Free for a few minutes? Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 20, "wait_unit": "minutes",
        "body": "If now isn't good, {{firstName}}, tell me a time that is and I'll work around it." },
      { "position": 3,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "hours",
        "body": "{{firstName}}, quick one: are you looking at cover for yourself, or for you and a spouse?" },
      { "position": 4,  "step_type": "sms_message", "wait_value": 3,  "wait_unit": "hours",
        "body": "No rush. When you're ready I can put a couple of options in front of you. About ten minutes on the phone." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 6,  "wait_unit": "hours",
        "body": "{{firstName}}, would mornings or evenings suit you better for a short call?" },
      { "position": 6,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "Morning {{firstName}}, {{agentName}} here with {{companyName}}. Still want me to look at what's available for you? Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "One thing people ask a lot: this sits alongside anything you have through the VA. It doesn't replace it." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "{{firstName}}, most of what I need is your date of birth and whether you use tobacco. Two answers and I can get you real numbers." },
      { "position": 9,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Still here whenever you want to pick this up, {{firstName}}." },
      { "position": 10, "step_type": "sms_message", "wait_value": 3,  "wait_unit": "days",
        "body": "Quick question {{firstName}}: is the goal to leave something behind for family, or to cover final costs?" },
      { "position": 11, "step_type": "sms_message", "wait_value": 4,  "wait_unit": "days",
        "body": "{{firstName}}, some people want enough to cover a funeral, others want more. Either is fine, I just need to know which. Reply STOP to opt out." },
      { "position": 12, "step_type": "sms_message", "wait_value": 5,  "wait_unit": "days",
        "body": "If you'd rather I put it in writing than call, say the word and I'll text you a summary instead." },
      { "position": 13, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "It's been a week, {{firstName}}. Still thinking about cover, or has it moved down the list? An honest answer is fine." },
      { "position": 14, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "{{firstName}}, no pressure either way. I'd just rather know than keep guessing." },
      { "position": 15, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "Worth knowing: what you pay is set by your age when you start, so it moves on your birthday rather than on any deadline." },
      { "position": 16, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "{{firstName}}, still happy to run some numbers whenever you want them. Reply STOP to opt out." },
      { "position": 17, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "Checking in. Has anything changed on your end since we first spoke?" },
      { "position": 18, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "{{firstName}}, if you already sorted this out elsewhere that's genuinely fine. Just let me know and I'll stop." },
      { "position": 19, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "Still around if you need me. - {{agentName}}, {{companyName}}" },
      { "position": 20, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "{{firstName}}, it's been about a month. Want me to take another look at what's available for you?" },
      { "position": 21, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Hope you're well, {{firstName}}. Is the coverage question still open, or all handled? Reply STOP to opt out." },
      { "position": 22, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} with {{companyName}} again. You asked about veteran coverage a while back. Still want a quote? Reply STOP to opt out." },
      { "position": 23, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "No news from me unless you want it, {{firstName}}. Reply YES and I'll call. Reply STOP and I'll leave you be." },
      { "position": 24, "step_type": "sms_message", "wait_value": 60, "wait_unit": "days",
        "body": "{{firstName}}, checking in once more from {{companyName}}. If the timing is better now, I can get you numbers today. Reply STOP to opt out." },
      { "position": 25, "step_type": "sms_message", "wait_value": 90, "wait_unit": "days",
        "body": "Hi {{firstName}}, {{agentName}} here. Three months on: still worth a conversation about cover? Reply STOP to opt out." },
      { "position": 26, "step_type": "sms_message", "wait_value": 120, "wait_unit": "days",
        "body": "Last one from me, {{firstName}}. If you ever want that quote I'm on {{agentPhone}}. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "final_expense",
    "sort_order": 280,
    "name": "Final Expense (text)",
    "description": "Twenty-four texts over about thirteen months for final-expense leads. Speed-to-lead in the first two minutes, then a cadence that decays from hours to months.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "final_expense" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "final expense" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "final_expense" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "fex" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "burial" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "minutes",
        "drip_rate": { "per_minutes": 60, "max_calls": 60 },
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. You asked about final expense coverage. Is now an OK time for a quick call? Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 20, "wait_unit": "minutes",
        "body": "No worries if you're busy. Tell me a better time and I'll ring then." },
      { "position": 3,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "hours",
        "body": "{{firstName}}, most people I talk to want enough to cover a funeral and not leave a bill behind. Is that roughly it for you?" },
      { "position": 4,  "step_type": "sms_message", "wait_value": 5,  "wait_unit": "hours",
        "body": "Whenever you're ready. It's a short conversation, about ten minutes." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "Morning {{firstName}}. Still want me to look at options around {{coverageAmount}}?" },
      { "position": 6,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} with {{companyName}}. Two answers get me a real number: your date of birth, and whether you use tobacco. Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "A lot of people ask whether there's a medical exam. For most of these plans there isn't, it's health questions instead." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Still here when you want to pick this up, {{firstName}}." },
      { "position": 9,  "step_type": "sms_message", "wait_value": 3,  "wait_unit": "days",
        "body": "{{firstName}}, would it help if I sent a couple of options in writing rather than calling?" },
      { "position": 10, "step_type": "sms_message", "wait_value": 4,  "wait_unit": "days",
        "body": "Honest question: is this still something you want to sort out, or has it moved down the list?" },
      { "position": 11, "step_type": "sms_message", "wait_value": 5,  "wait_unit": "days",
        "body": "{{firstName}}, I'd rather know than keep texting. Yes, no or later all work. Reply STOP to opt out." },
      { "position": 12, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Worth knowing: what you pay is based on your age when you start, so it moves on your birthday rather than on any deadline." },
      { "position": 13, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Checking in, {{firstName}}. Anything changed on your end?" },
      { "position": 14, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "{{firstName}}, if you'd rather I stopped, just say. Otherwise I'm happy to run the numbers whenever." },
      { "position": 15, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "Still happy to help with this, {{firstName}}. What's holding it up?" },
      { "position": 16, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. Want me to put a couple of options together? Reply STOP to opt out." },
      { "position": 17, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "Some people wait until something happens in the family. I'd rather you didn't have to." },
      { "position": 18, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "{{firstName}}, still around if you need me. - {{agentName}}" },
      { "position": 19, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "It's been about a month, {{firstName}}. Want another look at what's available?" },
      { "position": 20, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Hope you're keeping well. Is cover still on the list, or all handled?" },
      { "position": 21, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} with {{companyName}}. You asked about final expense cover a while back. Still want that quote? Reply STOP to opt out." },
      { "position": 22, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "Reply YES and I'll call you. Reply STOP and I'll leave it there, {{firstName}}." },
      { "position": 23, "step_type": "sms_message", "wait_value": 60, "wait_unit": "days",
        "body": "{{firstName}}, checking in from {{companyName}}. If the timing is better now, I can get you numbers today. Reply STOP to opt out." },
      { "position": 24, "step_type": "sms_message", "wait_value": 90, "wait_unit": "days",
        "body": "Last one from me, {{firstName}}. If you ever want to look at this I'm on {{agentPhone}}. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "mortgage_protection",
    "sort_order": 290,
    "name": "Mortgage Protection (text)",
    "description": "Twenty-four texts over about thirteen months for mortgage-protection leads, opening inside two minutes and tapering to a quarterly check-in.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "mortgage_protection" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "mortgage protection" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "mortgage_protection" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "mortgage" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "minutes",
        "drip_rate": { "per_minutes": 60, "max_calls": 60 },
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. You asked about covering the mortgage if something happened to you. Free to talk for a few minutes? Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 20, "wait_unit": "minutes",
        "body": "If now is bad, just send me a time that works and I'll call then." },
      { "position": 3,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "hours",
        "body": "{{firstName}}, roughly how many years are left on the mortgage? That's the main thing that shapes this." },
      { "position": 4,  "step_type": "sms_message", "wait_value": 5,  "wait_unit": "hours",
        "body": "No rush. It's about a ten minute conversation and you'll have real numbers at the end of it." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "Morning {{firstName}}. Still want me to look at cover around {{coverageAmount}}?" },
      { "position": 6,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. Two things get me a quote: your date of birth, and whether you use tobacco. Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Worth saying: this would be your own policy, not something tied to the lender. You choose who it pays." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Still here whenever you want to pick this up." },
      { "position": 9,  "step_type": "sms_message", "wait_value": 3,  "wait_unit": "days",
        "body": "{{firstName}}, is this just for you, or for you and a partner?" },
      { "position": 10, "step_type": "sms_message", "wait_value": 4,  "wait_unit": "days",
        "body": "Would you rather I sent options in writing than called? Happy either way." },
      { "position": 11, "step_type": "sms_message", "wait_value": 5,  "wait_unit": "days",
        "body": "{{firstName}}, an honest answer is fine: still worth looking at, or has it dropped down the list? Reply STOP to opt out." },
      { "position": 12, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "One thing people don't always know: you can cover the balance without covering the whole house." },
      { "position": 13, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Checking in. Anything changed with the mortgage or at home since we spoke?" },
      { "position": 14, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "{{firstName}}, still happy to run numbers whenever you want them." },
      { "position": 15, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "Has this gone quiet because you sorted it elsewhere? Genuinely fine if so. Just tell me and I'll stop." },
      { "position": 16, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} with {{companyName}}. Want me to put a couple of options together? Reply STOP to opt out." },
      { "position": 17, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "A lot of people do this when they refinance or move. If either is coming up, it's a good moment." },
      { "position": 18, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "Still around if you need me, {{firstName}}. - {{agentName}}" },
      { "position": 19, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "It's been about a month. Want another look at what's available?" },
      { "position": 20, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Hope things are good, {{firstName}}. Is mortgage cover still on the list?" },
      { "position": 21, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. You asked about mortgage protection a while back. Still want that quote? Reply STOP to opt out." },
      { "position": 22, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "Reply YES and I'll call. Reply STOP and I'll leave you be, {{firstName}}." },
      { "position": 23, "step_type": "sms_message", "wait_value": 60, "wait_unit": "days",
        "body": "Checking in from {{companyName}}, {{firstName}}. If the timing is better now I can get you numbers today. Reply STOP to opt out." },
      { "position": 24, "step_type": "sms_message", "wait_value": 90, "wait_unit": "days",
        "body": "Last one from me. If you ever want to look at this I'm on {{agentPhone}}. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "iul",
    "sort_order": 300,
    "name": "IUL (text)",
    "description": "Twenty-four texts over about thirteen months for indexed universal life. Says out loud that an illustration is a projection rather than a promise, because that is the thing this product gets wrong most often.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "iul" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "iul" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "indexed universal life" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "minutes",
        "drip_rate": { "per_minutes": 60, "max_calls": 60 },
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. You asked about indexed universal life. Got a few minutes to go through how it actually works? Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 20, "wait_unit": "minutes",
        "body": "If now isn't good, send me a time and I'll call then." },
      { "position": 3,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "hours",
        "body": "{{firstName}}, are you looking at this mainly for the protection, the cash value side, or both?" },
      { "position": 4,  "step_type": "sms_message", "wait_value": 5,  "wait_unit": "hours",
        "body": "It's a longer conversation than a term quote, about fifteen minutes. Worth it before you decide anything." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "Morning {{firstName}}. Still want to look at this? I'll walk you through the illustration line by line." },
      { "position": 6,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. To model anything I need your date of birth and roughly what you'd put in each month. Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Something I always say up front: an illustration is a projection, not a promise. I'll show you the guaranteed column too." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Still here when you want to pick this up." },
      { "position": 9,  "step_type": "sms_message", "wait_value": 3,  "wait_unit": "days",
        "body": "{{firstName}}, is there a timeframe in your head? Ten years, twenty, retirement?" },
      { "position": 10, "step_type": "sms_message", "wait_value": 4,  "wait_unit": "days",
        "body": "Happy to send a summary in writing instead of calling, if that's easier." },
      { "position": 11, "step_type": "sms_message", "wait_value": 5,  "wait_unit": "days",
        "body": "{{firstName}}, still worth a conversation, or has this moved down the list? Either answer is useful. Reply STOP to opt out." },
      { "position": 12, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Worth knowing: these are designed to be funded steadily over years. Started and stopped, they don't do much." },
      { "position": 13, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Checking in. Anything changed on your end?" },
      { "position": 14, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "{{firstName}}, still happy to run this whenever you want." },
      { "position": 15, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "If you've already spoken to somebody else about it, no problem. Just tell me and I'll leave it." },
      { "position": 16, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} with {{companyName}}. Want me to put an illustration together? Reply STOP to opt out." },
      { "position": 17, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "A lot of people look at this around a raise, a bonus or a business selling. If any of that is on the horizon, say so." },
      { "position": 18, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "Still around if you need me. - {{agentName}}" },
      { "position": 19, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "It's been about a month, {{firstName}}. Want another look?" },
      { "position": 20, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Hope you're well. Is this still something you want to understand properly?" },
      { "position": 21, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. You asked about IUL a while back. Still want me to run one? Reply STOP to opt out." },
      { "position": 22, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "Reply YES and I'll call. Reply STOP and I'll leave it there." },
      { "position": 23, "step_type": "sms_message", "wait_value": 60, "wait_unit": "days",
        "body": "Checking in from {{companyName}}. If the timing is better now, I can get you an illustration this week. Reply STOP to opt out." },
      { "position": 24, "step_type": "sms_message", "wait_value": 90, "wait_unit": "days",
        "body": "Last one from me, {{firstName}}. I'm on {{agentPhone}} whenever you want to pick it up. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "general_life",
    "sort_order": 310,
    "name": "General Life (text)",
    "description": "Twenty-four texts over about thirteen months for general life leads. The broadest of the six, so it asks early what the cover is actually for.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "general_life" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "general life" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "life" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "term life" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "whole life" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "minutes",
        "drip_rate": { "per_minutes": 60, "max_calls": 60 },
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. You asked about life insurance. Free for a quick call? Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 20, "wait_unit": "minutes",
        "body": "If now isn't good, tell me a time and I'll work around it." },
      { "position": 3,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "hours",
        "body": "{{firstName}}, is this for you, or for you and a partner?" },
      { "position": 4,  "step_type": "sms_message", "wait_value": 5,  "wait_unit": "hours",
        "body": "It's a short conversation. About ten minutes and you'll have real numbers." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "Morning {{firstName}}. Still want me to look at options around {{coverageAmount}}?" },
      { "position": 6,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. Your date of birth and whether you use tobacco is all I need to start. Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Most people are surprised how much of this comes down to age and health rather than the company name on the policy." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Still here whenever you want to pick this up." },
      { "position": 9,  "step_type": "sms_message", "wait_value": 3,  "wait_unit": "days",
        "body": "{{firstName}}, do you have any cover through work? Worth knowing before we look at anything." },
      { "position": 10, "step_type": "sms_message", "wait_value": 4,  "wait_unit": "days",
        "body": "Happy to send options in writing rather than calling, if that's easier." },
      { "position": 11, "step_type": "sms_message", "wait_value": 5,  "wait_unit": "days",
        "body": "{{firstName}}, still worth looking at, or has it moved down the list? An honest answer is fine. Reply STOP to opt out." },
      { "position": 12, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Worth knowing: what you pay is set by your age when you start, so it moves on your birthday." },
      { "position": 13, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Checking in. Anything changed since we first spoke?" },
      { "position": 14, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "{{firstName}}, still happy to run numbers whenever you want them." },
      { "position": 15, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "If you sorted this out elsewhere, that's genuinely fine. Just say and I'll stop." },
      { "position": 16, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} with {{companyName}}. Want me to put a couple of options together? Reply STOP to opt out." },
      { "position": 17, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "A lot of people do this around a new baby, a new house or a new job. If any of that is happening, it's a good moment." },
      { "position": 18, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "Still around if you need me. - {{agentName}}" },
      { "position": 19, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "It's been about a month, {{firstName}}. Want another look at what's available?" },
      { "position": 20, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Hope you're well. Is life cover still on the list, or all handled?" },
      { "position": 21, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. You asked about life insurance a while back. Still want that quote? Reply STOP to opt out." },
      { "position": 22, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "Reply YES and I'll call. Reply STOP and I'll leave you be." },
      { "position": 23, "step_type": "sms_message", "wait_value": 60, "wait_unit": "days",
        "body": "Checking in from {{companyName}}. If the timing is better now, I can get you numbers today. Reply STOP to opt out." },
      { "position": 24, "step_type": "sms_message", "wait_value": 90, "wait_unit": "days",
        "body": "Last one from me, {{firstName}}. I'm on {{agentPhone}} if you ever want to pick it up. Reply STOP to opt out. - {{agentName}}" }
    ]
  },
  {
    "seed_key": "trucker",
    "sort_order": 320,
    "name": "Trucker (text)",
    "description": "Twenty-four texts over about thirteen months for driver leads. Written for somebody who cannot take a call, so it offers to do the whole thing by text.",
    "channel": "sms",
    "active": false,
    "trigger_groups": [
      { "conditions": [{ "field": "campaign_tag", "op": "is", "value": "trucker" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "trucker" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "truck driver" }] },
      { "conditions": [{ "field": "lead_type", "op": "is", "value": "cdl" }] }
    ],
    "auto_enroll_new_leads": true,
    "trigger_on_missed_appointment": false,
    "trigger_on_sold": false,
    "trigger_on_appointment_booked": false,
    "stop_on_appointment_booked": true,
    "stop_on_sold": true,
    "stop_on_reply": true,
    "pause_on_active_conversation": true,
    "steps": [
      { "position": 1,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "minutes",
        "drip_rate": { "per_minutes": 60, "max_calls": 60 },
        "body": "Hi {{firstName}}, it's {{agentName}} with {{companyName}}. You asked about life cover for drivers. Text is fine if you're rolling. Reply STOP to opt out." },
      { "position": 2,  "step_type": "sms_message", "wait_value": 20, "wait_unit": "minutes",
        "body": "No need to pull over. Answer when you're stopped and I'll work around your hours." },
      { "position": 3,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "hours",
        "body": "{{firstName}}, are you company or owner-operator? It changes what makes sense." },
      { "position": 4,  "step_type": "sms_message", "wait_value": 5,  "wait_unit": "hours",
        "body": "Whenever you're parked up. About ten minutes on the phone, or we can do the whole thing by text." },
      { "position": 5,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "Morning {{firstName}}. Still want me to look at options around {{coverageAmount}}?" },
      { "position": 6,  "step_type": "sms_message", "wait_value": 1,  "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. Your date of birth and whether you use tobacco gets me a real number. Reply STOP to opt out." },
      { "position": 7,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Worth saying: a DOT physical and life insurance underwriting are not the same thing. One doesn't decide the other." },
      { "position": 8,  "step_type": "sms_message", "wait_value": 2,  "wait_unit": "days",
        "body": "Still here when you've got a minute." },
      { "position": 9,  "step_type": "sms_message", "wait_value": 3,  "wait_unit": "days",
        "body": "{{firstName}}, is anybody depending on the income if you're off the road? Spouse, kids?" },
      { "position": 10, "step_type": "sms_message", "wait_value": 4,  "wait_unit": "days",
        "body": "Happy to send this in writing so you can read it at a stop rather than talk." },
      { "position": 11, "step_type": "sms_message", "wait_value": 5,  "wait_unit": "days",
        "body": "{{firstName}}, still worth looking at? Yes, no or later all work. Reply STOP to opt out." },
      { "position": 12, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "What you pay is based on age and health when you start, so it moves on your birthday rather than on a deadline." },
      { "position": 13, "step_type": "sms_message", "wait_value": 7,  "wait_unit": "days",
        "body": "Checking in. Anything changed with the route or at home?" },
      { "position": 14, "step_type": "sms_message", "wait_value": 10, "wait_unit": "days",
        "body": "{{firstName}}, still happy to sort this whenever you're off the clock." },
      { "position": 15, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "If you covered this through the company or somewhere else, no problem. Just tell me and I'll stop." },
      { "position": 16, "step_type": "sms_message", "wait_value": 14, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} with {{companyName}}. Want me to put some options together? Reply STOP to opt out." },
      { "position": 17, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "A lot of drivers do this at renewal or when they change companies. If either is coming, it's a good time." },
      { "position": 18, "step_type": "sms_message", "wait_value": 21, "wait_unit": "days",
        "body": "Still around if you need me. - {{agentName}}" },
      { "position": 19, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "It's been about a month, {{firstName}}. Want another look?" },
      { "position": 20, "step_type": "sms_message", "wait_value": 30, "wait_unit": "days",
        "body": "Hope the miles are treating you well. Is cover still on the list?" },
      { "position": 21, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "{{firstName}}, it's {{agentName}} at {{companyName}}. You asked about coverage a while back. Still want that quote? Reply STOP to opt out." },
      { "position": 22, "step_type": "sms_message", "wait_value": 45, "wait_unit": "days",
        "body": "Reply YES and I'll call when you're stopped. Reply STOP and I'll leave you be." },
      { "position": 23, "step_type": "sms_message", "wait_value": 60, "wait_unit": "days",
        "body": "Checking in from {{companyName}}. If the timing is better now I can get you numbers today. Reply STOP to opt out." },
      { "position": 24, "step_type": "sms_message", "wait_value": 90, "wait_unit": "days",
        "body": "Last one from me, {{firstName}}. I'm on {{agentPhone}} whenever you want it. Reply STOP to opt out. - {{agentName}}" }
    ]
  }
]
$json$::jsonb;
$fn$;

comment on function public.vc_default_sms_campaigns() is
  'The twelve pre-written TEXT campaigns, as one jsonb literal. THE ONLY COPY: the seeder reads this and test/default-sms-campaigns.test.mjs extracts the same literal out of the migration text and runs every rule through the real matcher, every body through the real renderer and the real segment counter. Do not mirror it into TypeScript. Every one of them ships active = false, deliberately.';

-- ============================================================
-- PART 2 — the seeder
-- ============================================================
--
-- The SAME tombstone table as the voice defaults (voice_campaign_seed_state),
-- and that is on purpose rather than convenient: the question it answers is
-- "has this agent already been OFFERED this default", and the answer has to be
-- the same shape for both channels. The keys cannot collide (the voice twelve
-- all end `_v1`; these are the bare SMS AI type names), so one table with one
-- primary key still decides both.
--
-- 🔴 THE TOMBSTONE IS WHAT MAKES A DELETE STICK. An agent who deleted a seeded
-- campaign looks exactly like an agent who never had it, and re-creating it
-- would restart a program that TEXTS consumers. Nothing here removes a
-- tombstone row, this function contains no UPDATE of a campaign, no DO UPDATE
-- and no DELETE, and three tests plus a production dry run pin that.
--
-- ---- THE ORDER, WHICH IS THE SMS-2 CONTRACT --------------------------------
--
--   1. INSERT the campaign with active = false.
--   2. INSERT its steps.
--   3. ACTIVATE, only if the default asks for it.
--
-- All three in one transaction. voice_campaigns_validate() refuses an active
-- text campaign with no sms_message steps and the campaign row necessarily
-- precedes its steps, so any other order raises. Step 3 never fires for the
-- twelve below because all twelve ship off — it is here so that a future
-- default which ships live needs no change to this function, and so the
-- contract is expressed in code rather than in a comment.
-- ============================================================
create or replace function public.vc_seed_default_sms_campaigns_for(p_agent uuid)
returns table (campaign_seed_key text, was_created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  def      jsonb;
  step     jsonb;
  new_id   uuid;
  claimed  boolean;
begin
  if p_agent is null then
    return;
  end if;

  for def in select * from jsonb_array_elements(public.vc_default_sms_campaigns())
  loop
    -- The claim. One insert, one primary key, one answer to "has this agent
    -- already been offered this default". FOUND is false when ON CONFLICT
    -- swallowed it, which is exactly "already offered".
    claimed := false;
    insert into public.voice_campaign_seed_state (agent_id, seed_key)
    values (p_agent, def->>'seed_key')
    on conflict (agent_id, seed_key) do nothing;
    if found then claimed := true; end if;

    if not claimed then
      return query select (def->>'seed_key')::text, false;
      continue;
    end if;

    -- Belt and braces: a campaign already wearing this seed_key is left
    -- exactly as it is. Never updated, never reactivated.
    if exists (
      select 1 from public.voice_campaigns c
       where c.agent_id = p_agent and c.seed_key = def->>'seed_key'
    ) then
      return query select (def->>'seed_key')::text, false;
      continue;
    end if;

    -- ---- 1. THE CAMPAIGN, INACTIVE ----------------------------------------
    insert into public.voice_campaigns (
      agent_id, name, description, active, dry_run, sort_order, channel,
      trigger_groups,
      auto_enroll_new_leads, trigger_on_missed_appointment, trigger_on_sold,
      trigger_on_appointment_booked,
      stop_on_appointment_booked, stop_on_sold, stop_on_answered,
      stop_answer_talk_secs, stop_on_reply, pause_on_active_conversation,
      seed_key
    ) values (
      p_agent,
      def->>'name',
      def->>'description',
      false,   -- ALWAYS false here. Step 3 below is the only thing that turns
               -- a campaign on, and it needs the steps to exist first.
      false,
      coalesce((def->>'sort_order')::int, 200),
      'sms',
      coalesce(def->'trigger_groups', '[]'::jsonb),
      coalesce((def->>'auto_enroll_new_leads')::boolean, false),
      coalesce((def->>'trigger_on_missed_appointment')::boolean, false),
      coalesce((def->>'trigger_on_sold')::boolean, false),
      coalesce((def->>'trigger_on_appointment_booked')::boolean, false),
      coalesce((def->>'stop_on_appointment_booked')::boolean, true),
      coalesce((def->>'stop_on_sold')::boolean, true),
      false,   -- stop_on_answered is a voice idea; a delivery receipt is not a
               -- conversation.
      15,
      coalesce((def->>'stop_on_reply')::boolean, true),
      coalesce((def->>'pause_on_active_conversation')::boolean, true),
      def->>'seed_key'
    )
    returning id into new_id;

    -- ---- 2. THE STEPS ------------------------------------------------------
    for step in select * from jsonb_array_elements(coalesce(def->'steps', '[]'::jsonb))
    loop
      insert into public.voice_campaign_steps (
        campaign_id, agent_id, position, step_type,
        wait_value, wait_unit, anchor, offset_minutes, drip_rate,
        body, media_url
      ) values (
        new_id,
        p_agent, -- overwritten by voice_campaign_steps_derive; sent for clarity
        (step->>'position')::int,
        coalesce(step->>'step_type', 'sms_message'),
        coalesce((step->>'wait_value')::int, 0),
        coalesce(step->>'wait_unit', 'minutes'),
        coalesce(step->>'anchor', 'previous_step'),
        coalesce((step->>'offset_minutes')::int, 0),
        step->'drip_rate',
        step->>'body',
        null
      );
    end loop;

    -- ---- 3. ACTIVATE, IF THE DEFAULT ASKS ---------------------------------
    --
    -- Never reached by the twelve below. Present because the ORDER is the
    -- contract, and a contract that only exists in a comment is one somebody
    -- eventually breaks.
    if coalesce((def->>'active')::boolean, false) then
      update public.voice_campaigns set active = true where id = new_id;
    end if;

    return query select (def->>'seed_key')::text, true;
  end loop;
end;
$$;

revoke all on function public.vc_seed_default_sms_campaigns_for(uuid) from public, anon, authenticated;

comment on function public.vc_seed_default_sms_campaigns_for(uuid) is
  'Seeds the twelve shipped TEXT campaigns for one agent, all switched OFF. Idempotent AND respectful: presence is keyed on voice_campaign_seed_state, so re-running adds nothing and an agent who edited, activated or DELETED a seeded campaign never has it overwritten, reset or resurrected. Writes the campaign inactive, then its steps, then activates only if the default asks — the order voice_campaigns_validate() requires. SECURITY DEFINER and REVOKEd from anon/authenticated because it names an agent; the browser-callable form is vc_seed_default_sms_campaigns().';

-- The browser-callable form. No parameter names an agent; same shape and
-- reasoning as vc_seed_default_campaigns() and apply_producer_codes().
create or replace function public.vc_seed_default_sms_campaigns()
returns table (campaign_seed_key text, was_created boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'vc_seed_default_sms_campaigns: no authenticated agent';
  end if;
  return query select * from public.vc_seed_default_sms_campaigns_for(auth.uid());
end;
$$;

grant execute on function public.vc_seed_default_sms_campaigns() to authenticated;

-- ============================================================
-- PART 3 — the new-signup hook
-- ============================================================
--
-- A SECOND trigger on public.agents rather than an edit to
-- agents_seed_voice_campaigns(). The voice hook is live for nine accounts and
-- has a job it already does; widening it would mean a change to the text
-- seeder could break the calling one, and the two have no reason to share a
-- failure. Both swallow their own exceptions for the same reason: a sign-up
-- must never fail because a default campaign did not insert. The cost of
-- swallowing is an agent with no campaigns, which is fully recoverable — both
-- seeders are idempotent and the app calls them on load.
-- ============================================================
create or replace function public.agents_seed_sms_campaigns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.vc_seed_default_sms_campaigns_for(new.id);
  exception when others then
    raise warning 'agents_seed_sms_campaigns: seeding failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists agents_seed_sms_campaigns on public.agents;
create trigger agents_seed_sms_campaigns
  after insert on public.agents
  for each row execute function public.agents_seed_sms_campaigns();

-- ============================================================
-- PART 4 — the backfill
-- ============================================================
--
-- Every agent that exists right now gets the twelve, switched off. Idempotent
-- through the tombstone: running this file again adds nothing at all.
-- ============================================================
do $$
declare
  a record;
begin
  for a in select id from public.agents
  loop
    perform public.vc_seed_default_sms_campaigns_for(a.id);
  end loop;
end $$;
