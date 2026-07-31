// ============================================================
// campaign-sms.test.ts — the text half of the campaign engine.
//
// Run with:  npm run test:ai
//
// The voice engine's own tests (voice-campaign-core.test.ts,
// voice-campaign-flow.test.ts, voice-campaign-enroll.test.ts,
// voice-campaign-mission.test.ts) all still run unchanged and are the
// regression suite for the half of this engine that did not move. What is here
// is what is new — plus one section, "voice pacing is untouched", that exists
// solely to pin the two shared functions this round DID reach into.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VC_CHANNELS,
  VC_MERGE_VARS,
  VC_SMS_CONVERSATION_WINDOW_HOURS,
  VC_SMS_STEP_TYPES,
  VC_SMS_TAKEOVER_RECHECK_MINUTES,
  VC_VOICE_STEP_TYPES,
  renderMergeVars,
  vcAdvanceAfterCall,
  vcAdvanceAfterSend,
  vcBodyStats,
  vcCampaignStats,
  vcChannel,
  vcChannelLabel,
  vcDripAllows,
  vcEvaluateEnrollment,
  vcEvaluateSmsHold,
  vcEvaluateSmsStop,
  vcFirstActionableStep,
  vcFirstStep,
  vcHandleGateRejection,
  vcHandleSmsRejection,
  vcMergeIssues,
  vcMergePreview,
  vcMergeValues,
  vcNextActionText,
  vcPersonName,
  vcPrettyPhone,
  vcResolveNextDue,
  vcSmsDailyByNumber,
  vcSmsFeedEntry,
  vcSmsMeterSentence,
  vcStepIsActionable,
  vcStepTypesFor,
  vcStopReasonLabel,
  vcValidateSmsSteps,
  vcWaitReasonLabel,
} from "./voice-campaign-core.ts";
import { countSegments } from "./segments.ts";

const NOW = new Date("2026-08-10T15:00:00.000Z");
const iso = (d: Date) => d.toISOString();
const plus = (ms: number) => new Date(NOW.getTime() + ms);
const minus = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ============================================================
// 1. The channel itself
// ============================================================

test("channel defaults to voice, which is what every existing row is", () => {
  assert.equal(vcChannel(null), "voice");
  assert.equal(vcChannel({}), "voice");
  assert.equal(vcChannel({ channel: null }), "voice");
  assert.equal(vcChannel({ channel: "" }), "voice");
  // An unrecognised value is voice, not an error and not a third channel.
  assert.equal(vcChannel({ channel: "fax" }), "voice");
  assert.equal(vcChannel({ channel: "sms" }), "sms");
  assert.equal(vcChannel({ channel: "SMS" }), "sms");
  assert.deepEqual(VC_CHANNELS, ["voice", "sms"]);
});

test("a step type belongs to exactly one channel", () => {
  assert.deepEqual(vcStepTypesFor("voice"), VC_VOICE_STEP_TYPES);
  assert.deepEqual(vcStepTypesFor("sms"), VC_SMS_STEP_TYPES);
  assert.deepEqual(vcStepTypesFor(null), VC_VOICE_STEP_TYPES);
  // The two lists do not overlap. A `call` step inside a text campaign is the
  // tick being told to dial somebody in a texting program.
  for (const t of VC_SMS_STEP_TYPES) assert.ok(!VC_VOICE_STEP_TYPES.includes(t));
});

test("channel labels", () => {
  assert.equal(vcChannelLabel("sms"), "Text");
  assert.equal(vcChannelLabel("voice"), "Voice");
  assert.equal(vcChannelLabel(null), "Voice");
});

// ============================================================
// 2. Merge variables
// ============================================================

test("merge variables render from a real lead", () => {
  const values = vcMergeValues({
    lead: { id: "l1", data: { first_name: "Maria", carrier: "Mutual of Omaha", coverage_wanted: "$25,000" } },
    agentName: "Jordan Reyes",
    agencyName: "Reyes Financial",
    fromE164: "+12625099123",
  });
  assert.equal(
    renderMergeVars("Hi {{firstName}}, it's {{agentName}} with {{companyName}}.", values),
    "Hi Maria, it's Jordan Reyes with Reyes Financial.",
  );
  assert.equal(
    renderMergeVars("Your {{carrier}} policy for {{coverageAmount}} — call {{agentPhone}}.", values),
    "Your Mutual of Omaha policy for $25,000 — call (262) 509-9123.",
  );
});

test("🔴 a raw {{…}} never reaches a phone", () => {
  // Every known variable falls back to a word. None of them is blank.
  const out = renderMergeVars(
    "Hi {{firstName}}, it's {{agentName}} with {{companyName}} about your {{carrier}} " +
    "policy for {{coverageAmount}}. Reply here or call {{agentPhone}}.",
    {},
  );
  assert.ok(!out.includes("{{"), out);
  assert.ok(!out.includes("}}"), out);
  assert.equal(
    out,
    "Hi there, it's your agent with our office about your your carrier policy for your coverage. " +
    "Reply here or call this number.",
  );
  // And an UNKNOWN variable is removed entirely rather than left in braces.
  assert.equal(renderMergeVars("Hi {{frstName}}, how are you?", {}), "Hi, how are you?");
  assert.ok(!renderMergeVars("{{nope}}", {}).includes("{"));
});

test("every merge variable has a non-blank fallback", () => {
  for (const v of VC_MERGE_VARS) {
    assert.ok(v.fallback && v.fallback.trim(), `${v.key} has a blank fallback`);
    assert.ok(v.sample && v.sample.trim(), `${v.key} has a blank sample`);
    assert.ok(v.source && v.source.trim(), `${v.key} does not say where it comes from`);
  }
});

test("substitution artefacts are tidied, so a hole never shows as punctuation", () => {
  // Reachable only through an unknown variable, which is exactly the case
  // where the output is about to be read by a stranger.
  assert.equal(renderMergeVars("Hi {{nope}}, how are you?", {}), "Hi, how are you?");
  assert.equal(renderMergeVars("Call us on {{nope}} .", {}), "Call us on.");
  assert.equal(renderMergeVars("a  b", {}), "a b");
});

test("variable names are case- and whitespace-tolerant", () => {
  const v = { firstName: "Maria" };
  assert.equal(renderMergeVars("{{firstName}}", v), "Maria");
  assert.equal(renderMergeVars("{{firstname}}", v), "Maria");
  assert.equal(renderMergeVars("{{FIRSTNAME}}", v), "Maria");
  assert.equal(renderMergeVars("{{  firstName  }}", v), "Maria");
});

test("vcMergeIssues names the typo the editor has to refuse", () => {
  const ok = vcMergeIssues("Hi {{firstName}}, {{agentName}} here.");
  assert.deepEqual(ok.unknown, []);
  assert.deepEqual(ok.used, ["firstName", "agentName"]);

  const bad = vcMergeIssues("Hi {{frstName}} and {{firstName}} and {{frstName}}");
  assert.deepEqual(bad.unknown, ["frstName"]);   // deduped
  assert.deepEqual(bad.used, ["firstName"]);
});

test("🔴 a merge value that is an email address is never sent as a name", () => {
  // agents.display_name is null for most of the production book and the
  // historical fallback was the login email. Without this a campaign would
  // text strangers "it's jacef8778099@gmail.com from our office."
  assert.equal(vcPersonName("jacef8778099@gmail.com"), "Jacef");
  assert.equal(vcPersonName("jordan.reyes@agency.com"), "Jordan Reyes");
  assert.equal(vcPersonName("Jordan Reyes"), "Jordan Reyes");
  assert.equal(vcPersonName(""), "");
  assert.equal(vcPersonName(null), "");
  // Nothing usable in the local part falls through to the variable's fallback.
  assert.equal(vcPersonName("123@x.com"), "");

  const values = vcMergeValues({ agentName: "jacef8778099@gmail.com" });
  const out = renderMergeVars("It's {{agentName}}.", values);
  assert.ok(!out.includes("@"), out);
  assert.equal(out, "It's Jacef.");
});

test("a phone number is rendered the way a person reads one", () => {
  assert.equal(vcPrettyPhone("+12625099123"), "(262) 509-9123");
  assert.equal(vcPrettyPhone("+447700900123"), "+447700900123");  // passed through
  assert.equal(vcPrettyPhone(""), "");
});

test("the preview uses the documented sample values", () => {
  const p = vcMergePreview("Hi {{firstName}}, {{agentName}} with {{companyName}}.");
  assert.equal(p, "Hi Maria, Jordan Reyes with Reyes Financial.");
});

test("body stats price the PREVIEW, not the template", () => {
  const body = "Hi {{firstName}}, quick question about your {{carrier}} cover.";
  const stats = vcBodyStats(body, { countSegments });
  // The template is longer than the message; an agent shown the template's
  // length would write to the wrong budget.
  assert.ok(stats.chars < body.length, `${stats.chars} !< ${body.length}`);
  assert.equal(stats.segments, 1);
  assert.equal(stats.unicode, false);
  assert.equal(stats.mms, false);

  const emoji = vcBodyStats("Hi 👋 there", { countSegments });
  assert.equal(emoji.unicode, true);

  // An attachment changes the billing shape entirely.
  assert.equal(vcBodyStats("hi", { mediaUrl: "https://x/y.jpg", countSegments }).mms, true);
  // An empty body has no segments — it is not "one empty segment".
  assert.equal(vcBodyStats("", { countSegments }).segments, 0);
});

test("vcValidateSmsSteps refuses what the database refuses", () => {
  assert.equal(vcValidateSmsSteps([]).ok, false);
  assert.equal(
    vcValidateSmsSteps([{ position: 1, step_type: "wait", wait_value: 1, wait_unit: "days" }]).ok,
    false,
    "a campaign of nothing but waits enrols people and texts none of them",
  );
  assert.equal(vcValidateSmsSteps([{ position: 1, step_type: "sms_message", body: "  " }]).ok, false);
  assert.equal(vcValidateSmsSteps([{ position: 1, step_type: "sms_message", body: "hi {{frstName}}" }]).ok, false);
  const good = vcValidateSmsSteps([
    { position: 1, step_type: "sms_message", body: "Hi {{firstName}}" },
    { position: 2, step_type: "wait", wait_value: 2, wait_unit: "days" },
    { position: 3, step_type: "sms_message", body: "Still there?" },
  ]);
  assert.equal(good.ok, true);
  assert.equal(good.error, null);
});

// ============================================================
// 3. Wait steps fold away
// ============================================================

const SMS_STEPS = [
  { position: 1, step_type: "sms_message", body: "one",   wait_value: 0, wait_unit: "minutes" },
  { position: 2, step_type: "wait",                       wait_value: 2, wait_unit: "days" },
  { position: 3, step_type: "sms_message", body: "two",   wait_value: 0, wait_unit: "minutes" },
  { position: 4, step_type: "wait",                       wait_value: 5, wait_unit: "days" },
  { position: 5, step_type: "sms_message", body: "three", wait_value: 0, wait_unit: "minutes" },
];

test("a wait step is not actionable and never becomes a current position", () => {
  assert.equal(vcStepIsActionable({ position: 1, step_type: "sms_message" }), true);
  assert.equal(vcStepIsActionable({ position: 2, step_type: "wait" }), false);
  assert.equal(vcStepIsActionable({ position: 1, step_type: "call" }), true);
  assert.equal(vcStepIsActionable(null), false);

  const first = vcResolveNextDue({ steps: SMS_STEPS, now: NOW });
  assert.equal(first.step?.position, 1);
  assert.deepEqual(first.folded, []);

  // From step 1, the two-day wait folds in and the answer is step 3.
  const second = vcResolveNextDue({ steps: SMS_STEPS, fromPosition: 1, now: NOW });
  assert.equal(second.step?.position, 3);
  assert.deepEqual(second.folded, [2]);
  assert.equal(second.dueAt, iso(plus(2 * DAY)));

  const third = vcResolveNextDue({ steps: SMS_STEPS, fromPosition: 3, now: NOW });
  assert.equal(third.step?.position, 5);
  assert.deepEqual(third.folded, [4]);
  assert.equal(third.dueAt, iso(plus(5 * DAY)));
});

test("consecutive waits add up, and a trailing wait completes the sequence", () => {
  const steps = [
    { position: 1, step_type: "sms_message", body: "a", wait_value: 0, wait_unit: "minutes" },
    { position: 2, step_type: "wait", wait_value: 1, wait_unit: "days" },
    { position: 3, step_type: "wait", wait_value: 12, wait_unit: "hours" },
    { position: 4, step_type: "sms_message", body: "b", wait_value: 0, wait_unit: "minutes" },
    { position: 5, step_type: "wait", wait_value: 3, wait_unit: "days" },
  ];
  const next = vcResolveNextDue({ steps, fromPosition: 1, now: NOW });
  assert.equal(next.step?.position, 4);
  assert.deepEqual(next.folded, [2, 3]);
  assert.equal(next.dueAt, iso(plus(DAY + 12 * HOUR)));

  // A sequence that ENDS in a wait completes when the last real step is done.
  // Anything else would leave an enrollment waiting three days to do nothing.
  const done = vcResolveNextDue({ steps, fromPosition: 4, now: NOW });
  assert.equal(done.step, null);
  assert.equal(done.dueAt, null);
  assert.equal(done.reason, "no_steps");
  assert.deepEqual(done.folded, [5]);
});

test("a folded wait and a step's own wait COMPOSE rather than replacing", () => {
  const steps = [
    { position: 1, step_type: "sms_message", body: "a", wait_value: 0, wait_unit: "minutes" },
    { position: 2, step_type: "wait", wait_value: 1, wait_unit: "days" },
    { position: 3, step_type: "sms_message", body: "b", wait_value: 6, wait_unit: "hours" },
  ];
  const next = vcResolveNextDue({ steps, fromPosition: 1, now: NOW });
  assert.equal(next.dueAt, iso(plus(DAY + 6 * HOUR)));
});

test("a campaign of nothing but waits has steps but nothing to do", () => {
  const steps = [
    { position: 1, step_type: "wait", wait_value: 1, wait_unit: "days" },
    { position: 2, step_type: "wait", wait_value: 1, wait_unit: "days" },
  ];
  // vcFirstStep says yes — which is exactly why every guard now asks the other
  // one. A count-based check would enrol people and text none of them.
  assert.ok(vcFirstStep(steps));
  assert.equal(vcFirstActionableStep(steps), null);
  const r = vcResolveNextDue({ steps, now: NOW });
  assert.equal(r.step, null);
});

test("vcAdvanceAfterSend walks the sequence and then completes", () => {
  const a = vcAdvanceAfterSend({
    steps: SMS_STEPS,
    enrollment: { status: "active", current_step_position: 1, step_attempts: 1, next_action_at: null },
    now: NOW,
  });
  assert.equal(a.status, "active");
  assert.equal(a.decision, "next_step");
  assert.equal(a.current_step_position, 3);
  assert.equal(a.next_action_at, iso(plus(2 * DAY)));
  assert.equal(a.step_attempts, 0);

  const done = vcAdvanceAfterSend({
    steps: SMS_STEPS,
    enrollment: { status: "active", current_step_position: 5, step_attempts: 1, next_action_at: null },
    now: NOW,
  });
  assert.equal(done.status, "completed");
  assert.equal(done.decision, "completed");
  assert.equal(done.next_action_at, null);
});

// ============================================================
// 4. VOICE PACING IS UNTOUCHED
//
// This round reached into two functions the voice engine depends on —
// vcResolveNextDue (wait folding) and vcEvaluateEnrollment (a channel
// parameter). A voice campaign cannot contain a wait step and defaults to the
// voice channel, so neither change can reach it. These pin that.
// ============================================================

const VOICE_STEPS = [
  { position: 1, step_type: "call",        wait_value: 1,  wait_unit: "minutes" },
  { position: 2, step_type: "double_dial", wait_value: 2,  wait_unit: "hours", drip_rate: { per_minutes: 60, max_calls: 40 } },
  { position: 3, step_type: "call",        wait_value: 1,  wait_unit: "days" },
  { position: 4, step_type: "call",        wait_value: 3,  wait_unit: "days" },
  { position: 5, step_type: "call",        wait_value: 7,  wait_unit: "days" },
  { position: 6, step_type: "call",        wait_value: 14, wait_unit: "days" },
];

test("voice pacing: every step of the shipped Veteran Lead sequence is unmoved", () => {
  const expected = [
    [0, 1, 60_000],
    [1, 2, 2 * HOUR],
    [2, 3, DAY],
    [3, 4, 3 * DAY],
    [4, 5, 7 * DAY],
    [5, 6, 14 * DAY],
  ] as Array<[number, number, number]>;
  for (const [from, pos, offset] of expected) {
    const r = vcResolveNextDue({ steps: VOICE_STEPS, fromPosition: from, now: NOW });
    assert.equal(r.step?.position, pos, `from ${from}`);
    assert.equal(r.dueAt, iso(plus(offset)), `from ${from}`);
    // The new field is present and EMPTY on every voice resolution.
    assert.deepEqual(r.folded, [], `from ${from}`);
  }
  const end = vcResolveNextDue({ steps: VOICE_STEPS, fromPosition: 6, now: NOW });
  assert.equal(end.step, null);
  assert.equal(end.reason, "no_steps");
});

test("voice pacing: an appointment-anchored step is still skipped, never fired late", () => {
  const steps = [
    { position: 1, step_type: "call", anchor: "appointment", offset_minutes: -1440 },
    { position: 2, step_type: "call", anchor: "appointment", offset_minutes: -120 },
    { position: 3, step_type: "call", anchor: "appointment", offset_minutes: -15 },
  ];
  const appt = iso(plus(90 * 60_000));      // 90 minutes away
  const r = vcResolveNextDue({ steps, now: NOW, appointmentAt: appt });
  assert.equal(r.step?.position, 3);
  assert.deepEqual(r.skipped, [1, 2]);
  assert.deepEqual(r.folded, []);

  const gone = vcResolveNextDue({ steps, now: NOW, appointmentAt: iso(plus(60_000)) });
  assert.equal(gone.step, null);
  assert.equal(gone.reason, "all_past");

  const none = vcResolveNextDue({ steps, now: NOW, appointmentAt: null });
  assert.equal(none.reason, "no_appointment");
});

test("voice pacing: vcAdvanceAfterCall's double-dial retry is unchanged", () => {
  const adv = vcAdvanceAfterCall({
    campaign: { stop_on_answered: false },
    steps: VOICE_STEPS,
    enrollment: { status: "active", current_step_position: 2, step_attempts: 1, next_action_at: null },
    call: { outcome: "no_answer", answered_at: null, ended_at: null },
    now: NOW,
  });
  assert.equal(adv.decision, "double_dial_retry");
  assert.equal(adv.current_step_position, 2);
  assert.equal(adv.next_action_at, iso(plus(60_000)));
});

test("voice enrollment gate: unchanged when no channel is passed", () => {
  const lead = { id: "l1", data: {}, tcpa_consent: true, dnc: false };
  assert.deepEqual(
    vcEvaluateEnrollment({ lead, hasPhone: true }),
    { ok: true, reason: null, detail: null },
  );
  assert.equal(vcEvaluateEnrollment({ lead: { ...lead, tcpa_consent: false }, hasPhone: true }).reason, "no_consent");
  assert.equal(vcEvaluateEnrollment({ lead: { ...lead, dnc: true }, hasPhone: true }).reason, "dnc");
  assert.equal(vcEvaluateEnrollment({ lead, hasPhone: false }).reason, "no_phone");
  assert.equal(vcEvaluateEnrollment({ lead, hasPhone: true, suppressed: true }).reason, "suppressed");
  assert.equal(
    vcEvaluateEnrollment({ lead, hasPhone: true, activeElsewhere: true }).detail,
    "already in another voice campaign",
  );
  // A lead with SMS consent but no calling consent is still refused by voice.
  assert.equal(
    vcEvaluateEnrollment({ lead: { ...lead, tcpa_consent: false }, hasPhone: true, hasSmsConsent: true }).reason,
    "no_consent",
  );
});

test("voice wording: vcNextActionText is byte-identical without a channel", () => {
  const cases: Array<[string, string, string]> = [
    ["calling", "", "Calling now…"],
    ["paused_lead", "2h ago", "Paused 2h ago"],
    ["paused_lead", "", "Paused"],
    ["paused_campaign", "", "Campaign paused"],
    ["campaign_off", "", "Campaign switched off"],
    ["ended", "", "—"],
    ["waiting_on_call", "", "Call in progress…"],
    ["due", "", "Due now"],
    ["unknown", "", "—"],
  ];
  for (const [kind, when, want] of cases) {
    assert.equal(vcNextActionText({ kind, at: null, code: null } as never, when), want, kind);
  }
  assert.equal(
    vcNextActionText({ kind: "scheduled", at: null, code: "quiet_hours" } as never, "9:05 AM"),
    "Quiet hours where they live · next call 9:05 AM",
  );
  assert.equal(
    vcNextActionText({ kind: "scheduled", at: null, code: null } as never, "9:05 AM"),
    "9:05 AM",
  );
});

test("voice rejections: vcHandleGateRejection's table is unchanged", () => {
  assert.equal(vcHandleGateRejection({ code: "insufficient_balance", now: NOW }).action, "pause_campaign");
  assert.equal(vcHandleGateRejection({ code: "ai_disabled", now: NOW }).action, "pause_campaign");
  assert.equal(vcHandleGateRejection({ code: "upgrade_required", now: NOW }).action, "pause_campaign");
  assert.equal(vcHandleGateRejection({ code: "no_caller_id", now: NOW }).action, "pause_campaign");
  assert.equal(vcHandleGateRejection({ code: "not_callable", now: NOW }).action, "stop_enrollment");
  assert.equal(vcHandleGateRejection({ code: "missing_lead_id", now: NOW }).stop_reason, "lead_missing");
  assert.equal(
    vcHandleGateRejection({ code: "daily_cap_reached", now: NOW, resetsAt: iso(plus(3 * HOUR)) }).next_action_at,
    iso(plus(3 * HOUR)),
  );
  assert.equal(vcHandleGateRejection({ code: "http_502", now: NOW }).action, "retry_soon");
});

// ============================================================
// 5. One active campaign per lead PER CHANNEL
// ============================================================

test("🔴 a lead may be in one voice AND one text campaign, never two of either", () => {
  const lead = { id: "l1", data: {}, tcpa_consent: true, dnc: false };

  // Active in a VOICE campaign, being considered for a TEXT one. The caller
  // scopes `activeElsewhere` by channel, so this is `false` and the text
  // enrollment is allowed — which is the whole point of the feature.
  assert.equal(
    vcEvaluateEnrollment({ lead, channel: "sms", hasPhone: true, hasSmsConsent: true, activeElsewhere: false }).ok,
    true,
  );
  // Active in another TEXT campaign — refused, and worded for the channel.
  const clash = vcEvaluateEnrollment({
    lead, channel: "sms", hasPhone: true, hasSmsConsent: true, activeElsewhere: true,
  });
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, "already_enrolled");
  assert.equal(clash.detail, "already in another text campaign");
});

test("🔴 a text campaign reads TEXT consent, never leads.tcpa_consent", () => {
  // Calling consent and texting consent are different permissions. Reading the
  // voice one for a text campaign would message people who agreed only to a
  // phone call.
  const callOnly = { id: "l1", data: {}, tcpa_consent: true, dnc: false };
  const v = vcEvaluateEnrollment({ lead: callOnly, channel: "sms", hasPhone: true, hasSmsConsent: false });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "no_sms_consent");
  assert.equal(v.detail, "no text consent on file");

  // And the reverse: text consent alone is enough for a text campaign, even
  // with calling consent absent.
  const textOnly = { id: "l2", data: {}, tcpa_consent: false, dnc: false };
  assert.equal(
    vcEvaluateEnrollment({ lead: textOnly, channel: "sms", hasPhone: true, hasSmsConsent: true }).ok,
    true,
  );
});

test("leads.dnc stops BOTH channels", () => {
  // "They asked not to be contacted" — a person who said that on the phone did
  // not mean "but do text me".
  const lead = { id: "l1", data: {}, tcpa_consent: true, dnc: true };
  assert.equal(vcEvaluateEnrollment({ lead, channel: "sms", hasPhone: true, hasSmsConsent: true }).reason, "dnc");
  assert.equal(vcEvaluateEnrollment({ lead, channel: "voice", hasPhone: true }).reason, "dnc");
});

test("the SMS suppression refusal is worded as an opt-out", () => {
  const lead = { id: "l1", data: {}, tcpa_consent: true, dnc: false };
  assert.equal(
    vcEvaluateEnrollment({ lead, channel: "sms", hasPhone: true, hasSmsConsent: true, suppressed: true }).detail,
    "opted out of texts",
  );
});

// ============================================================
// 6. The live-conversation hold
// ============================================================

const HOLD_ON = { pause_on_active_conversation: true };

test("a step is HELD while the lead is mid-conversation, and resumes after", () => {
  const wroteAt = minus(2 * HOUR);
  const held = vcEvaluateSmsHold({
    campaign: HOLD_ON,
    thread: { status: "open", last_inbound_at: iso(wroteAt) },
    now: NOW,
  });
  assert.equal(held.hold, true);
  assert.equal(held.reason, "live_conversation");
  // Until the window closes — 24h after THEIR message, not 24h from now.
  assert.equal(held.until, iso(new Date(wroteAt.getTime() + VC_SMS_CONVERSATION_WINDOW_HOURS * HOUR)));

  // Once the window has passed, the sequence carries on by itself. Nothing was
  // skipped: the enrollment kept its step the whole time.
  const after = vcEvaluateSmsHold({
    campaign: HOLD_ON,
    thread: { status: "open", last_inbound_at: iso(minus(25 * HOUR)) },
    now: NOW,
  });
  assert.deepEqual(after, { hold: false, reason: null, until: null });
});

test("an agent takeover holds with no expiry, and is re-checked hourly", () => {
  const v = vcEvaluateSmsHold({
    campaign: HOLD_ON,
    thread: { status: "open", ai_muted: true, ai_muted_reason: "agent_takeover", last_inbound_at: iso(minus(5 * DAY)) },
    now: NOW,
  });
  assert.equal(v.hold, true);
  assert.equal(v.reason, "agent_takeover");
  // A takeover outranks the inbound window, which had long since expired here.
  assert.equal(v.until, iso(plus(VC_SMS_TAKEOVER_RECHECK_MINUTES * 60_000)));
});

test("a mute that is NOT a takeover does not hold", () => {
  // `booked` means the AI succeeded and stepped back; `agent_toggle` is the
  // agent switching the responder off. Neither is somebody mid-sentence.
  for (const reason of ["booked", "agent_toggle", "opted_out"]) {
    const v = vcEvaluateSmsHold({
      campaign: HOLD_ON,
      thread: { status: "open", ai_muted: true, ai_muted_reason: reason },
      now: NOW,
    });
    assert.equal(v.hold, false, reason);
  }
});

test("the hold can be switched off, and off means off", () => {
  const v = vcEvaluateSmsHold({
    campaign: { pause_on_active_conversation: false },
    thread: { status: "open", last_inbound_at: iso(minus(60_000)) },
    now: NOW,
  });
  assert.equal(v.hold, false);
});

test("no thread and a closed thread are both no-hold", () => {
  assert.equal(vcEvaluateSmsHold({ campaign: HOLD_ON, thread: null, now: NOW }).hold, false);
  // A closed thread is an opt-out, which is a STOP decided above this.
  assert.equal(
    vcEvaluateSmsHold({
      campaign: HOLD_ON,
      thread: { status: "closed", closed_reason: "opted_out", last_inbound_at: iso(minus(60_000)) },
      now: NOW,
    }).hold,
    false,
  );
});

test("the hold reason is a sentence on screen, not a bare timestamp", () => {
  assert.equal(vcWaitReasonLabel("live_conversation"), "They’re mid-conversation — holding");
  assert.equal(vcWaitReasonLabel("agent_takeover"), "You’re handling this thread");
  assert.equal(vcWaitReasonLabel("daily_limit_reached"), "Your carrier’s daily text limit");
  assert.equal(vcWaitReasonLabel("a2p_not_approved"), "Texting registration not approved yet");
});

// ============================================================
// 7. Stopping a text sequence
// ============================================================

const ENROLLED = iso(minus(3 * DAY));

test("end-on-response: a reply after enrollment stops the drip", () => {
  const v = vcEvaluateSmsStop({
    campaign: { stop_on_reply: true },
    thread: { status: "open", last_inbound_at: iso(minus(HOUR)) },
    enrolledAt: ENROLLED,
  });
  assert.deepEqual(v, { stop: true, reason: "replied" });
  // And it reads as the good outcome it is, not as a failure.
  assert.equal(vcStopReasonLabel("replied"), "They wrote back");
});

test("🔴 a reply from BEFORE enrollment is not a reply to this campaign", () => {
  // Keying on "any inbound ever" would refuse to work anybody who had ever
  // replied to anything, which is most of a live book.
  const v = vcEvaluateSmsStop({
    campaign: { stop_on_reply: true },
    thread: { status: "open", last_inbound_at: iso(minus(10 * DAY)) },
    enrolledAt: ENROLLED,
  });
  assert.equal(v.stop, false);
});

test("end-on-response OFF keeps the drip going — the responder is a separate feature", () => {
  // The conversation AI still answers their text; this setting only decides
  // whether the SEQUENCE keeps going. Nothing here can switch the responder
  // off, and nothing here is read by it.
  const v = vcEvaluateSmsStop({
    campaign: { stop_on_reply: false },
    thread: { status: "open", last_inbound_at: iso(minus(HOUR)) },
    enrolledAt: ENROLLED,
  });
  assert.equal(v.stop, false);
  assert.equal(v.reason, null);
});

test("stop_on_reply defaults to true on a row that predates the column", () => {
  const v = vcEvaluateSmsStop({
    campaign: {},                                    // no stop_on_reply at all
    thread: { status: "open", last_inbound_at: iso(minus(HOUR)) },
    enrolledAt: ENROLLED,
  });
  assert.equal(v.stop, true);
  assert.equal(v.reason, "replied");
});

test("🔴 DNC is unconditional and outranks every campaign setting", () => {
  const loud = {
    stop_on_reply: false, stop_on_sold: false, stop_on_appointment_booked: false,
  };
  assert.deepEqual(
    vcEvaluateSmsStop({ campaign: loud, leadDnc: true, enrolledAt: ENROLLED }),
    { stop: true, reason: "dnc" },
  );
  assert.deepEqual(
    vcEvaluateSmsStop({ campaign: loud, onDncList: true, enrolledAt: ENROLLED }),
    { stop: true, reason: "dnc" },
  );
});

test("an opt-out closes the thread, and that stops the sequence", () => {
  assert.deepEqual(
    vcEvaluateSmsStop({
      campaign: { stop_on_reply: false },
      thread: { status: "closed", closed_reason: "opted_out" },
      enrolledAt: ENROLLED,
    }),
    { stop: true, reason: "opted_out" },
  );
  assert.equal(
    vcEvaluateSmsStop({
      campaign: {},
      thread: { status: "closed", closed_reason: "something_else" },
      enrolledAt: ENROLLED,
    }).reason,
    "conversation_closed",
  );
});

test("the stop order puts consumer protection above campaign settings", () => {
  // Everything true at once: DNC must win, then the closed thread, then the
  // booking, then sold, then the reply.
  const all = {
    stop_on_reply: true, stop_on_sold: true, stop_on_appointment_booked: true,
  };
  const thread = { status: "closed", closed_reason: "opted_out", last_inbound_at: iso(minus(HOUR)) };
  assert.equal(
    vcEvaluateSmsStop({ campaign: all, thread, enrolledAt: ENROLLED, leadDnc: true, leadSold: true, leadBooked: true }).reason,
    "dnc",
  );
  assert.equal(
    vcEvaluateSmsStop({ campaign: all, thread, enrolledAt: ENROLLED, leadSold: true, leadBooked: true }).reason,
    "opted_out",
  );
  assert.equal(
    vcEvaluateSmsStop({
      campaign: all, thread: { status: "open", last_inbound_at: iso(minus(HOUR)) },
      enrolledAt: ENROLLED, leadSold: true, leadBooked: true,
    }).reason,
    "appointment_booked",
  );
  assert.equal(
    vcEvaluateSmsStop({
      campaign: all, thread: { status: "open", last_inbound_at: iso(minus(HOUR)) },
      enrolledAt: ENROLLED, leadSold: true,
    }).reason,
    "sold",
  );
});

test("nothing happening is not a stop", () => {
  assert.deepEqual(
    vcEvaluateSmsStop({ campaign: { stop_on_reply: true }, thread: { status: "open" }, enrolledAt: ENROLLED }),
    { stop: false, reason: null },
  );
  assert.deepEqual(
    vcEvaluateSmsStop({ campaign: {}, thread: null, enrolledAt: ENROLLED }),
    { stop: false, reason: null },
  );
});

// ============================================================
// 8. Gate rejections
// ============================================================

test("quiet hours DEFER a text to the next legal moment, never drop it", () => {
  const until = iso(plus(14 * HOUR));
  const plan = vcHandleSmsRejection({ code: "quiet_hours", now: NOW, quietUntil: until });
  assert.equal(plan.action, "reschedule");
  assert.equal(plan.next_action_at, until);
  assert.equal(plan.stop_reason, null);

  // With no computed instant it still comes back, half an hour later — never
  // "give up" and never a one-minute loop.
  const blind = vcHandleSmsRejection({ code: "quiet_hours", now: NOW });
  assert.equal(blind.action, "reschedule");
  assert.equal(blind.next_action_at, iso(plus(30 * 60_000)));
});

test("the carrier's daily ceiling reschedules at midnight UTC, which is when it resets", () => {
  const plan = vcHandleSmsRejection({ code: "daily_limit_reached", now: NOW });
  assert.equal(plan.action, "reschedule");
  assert.equal(plan.next_action_at, "2026-08-11T00:00:00.000Z");
});

test("account-level refusals PAUSE the campaign with a sentence", () => {
  for (const code of ["a2p_not_approved", "no_sms_capable_number", "insufficient_balance", "upgrade_required"]) {
    const plan = vcHandleSmsRejection({ code, now: NOW });
    assert.equal(plan.action, "pause_campaign", code);
    assert.ok(plan.pause_reason && plan.pause_reason.length > 20, code);
    assert.ok(plan.pause_reason!.startsWith("Paused:"), code);
  }
});

test("per-lead refusals STOP that enrollment and nobody else's", () => {
  assert.equal(vcHandleSmsRejection({ code: "no_consent", now: NOW }).stop_reason, "no_sms_consent");
  assert.equal(vcHandleSmsRejection({ code: "on_dnc_list", now: NOW }).stop_reason, "opted_out");
  assert.equal(vcHandleSmsRejection({ code: "invalid_phone", now: NOW }).stop_reason, "not_callable");
  for (const code of ["no_consent", "on_dnc_list", "invalid_phone", "missing_lead_id"]) {
    assert.equal(vcHandleSmsRejection({ code, now: NOW }).action, "stop_enrollment", code);
  }
});

test("🔴 no rejection path ever retries sooner than a minute", () => {
  const codes = [
    "quiet_hours", "daily_limit_reached", "a2p_not_approved", "no_sms_capable_number",
    "insufficient_balance", "upgrade_required", "no_consent", "on_dnc_list", "invalid_phone",
    "missing_lead_id", "send_failed", "hold_failed", "db_insert_failed", "", "nonsense",
  ];
  for (const code of codes) {
    const plan = vcHandleSmsRejection({ code, now: NOW });
    if (!plan.next_action_at) continue;
    const gap = new Date(plan.next_action_at).getTime() - NOW.getTime();
    assert.ok(gap >= 60_000, `${code} would retry in ${gap}ms`);
  }
});

test("anything unrecognised backs off and keeps the enrollment", () => {
  const plan = vcHandleSmsRejection({ code: "send_failed", now: NOW });
  assert.equal(plan.action, "retry_soon");
  assert.equal(plan.stop_reason, null);
  assert.equal(plan.pause_reason, null);
});

// ============================================================
// 9. The drip throttle — same arithmetic, different table
// ============================================================

test("the drip throttle is the SAME function the call path uses", () => {
  const drip = { per_minutes: 60, max_calls: 20 };
  assert.deepEqual(vcDripAllows({ drip, placedInWindow: 0 }), { allowed: true, remaining: 20 });
  assert.deepEqual(vcDripAllows({ drip, placedInWindow: 19 }), { allowed: true, remaining: 1 });
  assert.deepEqual(vcDripAllows({ drip, placedInWindow: 20 }), { allowed: false, remaining: 0 });
  assert.deepEqual(vcDripAllows({ drip, placedInWindow: 99 }), { allowed: false, remaining: 0 });
  // No drip is no throttle, not a throttle of zero.
  assert.deepEqual(vcDripAllows({ drip: null, placedInWindow: 999 }), { allowed: true, remaining: null });
  assert.deepEqual(vcDripAllows({ drip: { per_minutes: 60 }, placedInWindow: 999 }), { allowed: true, remaining: null });
});

// ============================================================
// 10. What the screen says
// ============================================================

test("text wording, without disturbing the voice wording", () => {
  assert.equal(vcNextActionText({ kind: "calling" } as never, "", "sms"), "Sending now…");
  assert.equal(vcNextActionText({ kind: "waiting_on_call" } as never, "", "sms"), "Sending…");
  assert.equal(
    vcNextActionText({ kind: "scheduled", code: "live_conversation" } as never, "Thu 9:00 AM", "sms"),
    "They’re mid-conversation — holding · next text Thu 9:00 AM",
  );
  // The same verdict on the voice side is unchanged.
  assert.equal(vcNextActionText({ kind: "calling" } as never, ""), "Calling now…");
});

test("the feed reports a delivery receipt honestly", () => {
  const sent = vcSmsFeedEntry(
    { id: "m1", direction: "outbound", body: "Hi Maria, quick question", status: "sent", created_at: iso(NOW) },
    { leadName: "Maria P" },
  );
  assert.equal(sent.outcome, "sent");
  assert.equal(sent.tone, "neutral");
  assert.ok(sent.headline.startsWith("Texted Maria P:"));

  const delivered = vcSmsFeedEntry(
    { id: "m2", direction: "outbound", body: "hi", status: "sent", delivered_at: iso(NOW) },
    { leadName: "Maria P" },
  );
  assert.equal(delivered.outcome, "delivered");

  const failed = vcSmsFeedEntry(
    { id: "m3", direction: "outbound", body: "hi", status: "failed" },
    { leadName: "Maria P" },
  );
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.tone, "bad");

  // An inbound line is the most important line on the screen: it is the moment
  // a drip turned into a conversation.
  const reply = vcSmsFeedEntry(
    { id: "m4", direction: "inbound", body: "yes please call me", created_at: iso(NOW) },
    { leadName: "Maria P" },
  );
  assert.equal(reply.outcome, "replied");
  assert.equal(reply.tone, "good");
  assert.ok(reply.headline.includes("replied"));
});

test("the card's numbers stay per channel", () => {
  const s = vcCampaignStats([
    { status: "active", messages_sent: 3, replies: 1 },
    { status: "completed", messages_sent: 2, replies: 2 },
  ]);
  assert.equal(s.messages, 5);
  assert.equal(s.replies, 3);
  assert.equal(s.calls, 0);
});

test("🔴 the text meter counts and does not cap", () => {
  const rows = vcSmsDailyByNumber([
    { from_number: "+15551110000" }, { from_number: "+15551110000" },
    { from_number: "+15552220000" }, { from_number: null }, {},
  ]);
  assert.deepEqual(rows, [
    { e164: "+15551110000", sent: 2 },
    { e164: "+15552220000", sent: 1 },
  ]);
  assert.equal(vcSmsMeterSentence(rows), "3 texts sent today across 2 numbers.");
  assert.equal(vcSmsMeterSentence([{ e164: "+1", sent: 1 }]), "1 text sent today.");
  assert.equal(vcSmsMeterSentence([]), "No texts sent today.");
  // Nothing in this module returns a verdict, a cap, a recommendation or a
  // state — it counts. A future round adding one has to add it deliberately.
  const s = vcSmsMeterSentence(rows);
  for (const word of ["limit", "cap", "recommend", "over", "warn"]) {
    assert.ok(!s.toLowerCase().includes(word), `the meter sentence must not say "${word}"`);
  }
});
