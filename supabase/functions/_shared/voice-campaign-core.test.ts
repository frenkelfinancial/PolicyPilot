// ============================================================
// voice-campaign-core.test.ts — run with:  npm run test:ai
//
// The campaign engine's decisions, tested where they are made. Nothing here
// needs a database, a phone or a clock it did not create.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VC_DOUBLE_DIAL_ATTEMPTS,
  VC_DOUBLE_DIAL_RETRY_SECS,
  VC_SLOT_LIMIT,
  VC_TAG_FIELDS,
  VC_TRANSIENT_RETRY_SECS,
  vcAdvanceAfterCall,
  vcCampaignStats,
  vcCampaignVars,
  vcConditionMatches,
  vcDripActive,
  vcDripAllows,
  vcDripWindowStart,
  vcEnrollSummary,
  vcEvaluateEnrollment,
  vcEvaluateStop,
  vcFirstStep,
  vcHandleGateRejection,
  vcIsNoAnswer,
  vcLeadFieldValue,
  vcMatchesTriggerGroups,
  vcNextAllowedInstant,
  vcNextStep,
  vcNormalizeGroups,
  vcPickCallerId,
  vcSlotsFree,
  vcSlotsInUse,
  vcSlotsLabel,
  vcStepAt,
  vcStepDueAt,
  vcStepsSorted,
  vcStopReasonLabel,
  vcTalkSeconds,
  vcValidateTriggerGroups,
  vcWaitLabel,
  vcWaitMs,
} from "./voice-campaign-core.ts";

const NOW = new Date("2026-07-30T15:00:00.000Z");
const CHI = "America/Chicago";

const lead = (data: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: "lead-1", data, tcpa_consent: true, dnc: false, ...over,
});

const tagCond = (value = "veteran") => ({ field: "lead_type", op: "is" as const, value });
const group = (...conds: Array<{ field: string; op: "is" | "is_not"; value: string }>) => ({ conditions: conds });

// ============================================================
// 1. Trigger matching — AND inside a group, OR between groups, NOT
// ============================================================

test("conditions inside a group are AND'd", () => {
  const groups = [group(tagCond(), { field: "state", op: "is", value: "TX" })];
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "veteran", state: "TX" }), groups), true);
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "veteran", state: "FL" }), groups), false);
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "iul", state: "TX" }), groups), false);
});

test("groups are OR'd", () => {
  const groups = [group(tagCond("veteran")), group(tagCond("final expense"))];
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "veteran" }), groups), true);
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "final expense" }), groups), true);
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "trucker" }), groups), false);
});

test("is_not is the exact negation of is", () => {
  const l = lead({ lead_type: "veteran", state: "TX" });
  assert.equal(vcConditionMatches(l, { field: "state", op: "is", value: "TX" }), true);
  assert.equal(vcConditionMatches(l, { field: "state", op: "is_not", value: "TX" }), false);
  assert.equal(vcConditionMatches(l, { field: "state", op: "is_not", value: "FL" }), true);
});

test("is_not on a MISSING field is true — unknown does not mean 'might be'", () => {
  const l = lead({ name: "Nobody" });
  assert.equal(vcConditionMatches(l, { field: "lead_type", op: "is_not", value: "trucker" }), true);
  assert.equal(vcConditionMatches(l, { field: "lead_type", op: "is", value: "trucker" }), false);
});

test("matching is case- and whitespace-insensitive", () => {
  const groups = [group(tagCond("Veteran"))];
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "  veteran " }), groups), true);
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "VETERAN" }), groups), true);
});

test("an array field is a membership test in both directions", () => {
  const l = lead({ tags: ["Veteran", "hot"] });
  assert.equal(vcConditionMatches(l, { field: "tags", op: "is", value: "veteran" }), true);
  assert.equal(vcConditionMatches(l, { field: "tags", op: "is", value: "cold" }), false);
  assert.equal(vcConditionMatches(l, { field: "tags", op: "is_not", value: "cold" }), true);
  assert.equal(vcConditionMatches(l, { field: "tags", op: "is_not", value: "veteran" }), false);
});

test("lead_type is virtual and follows the same chain the assistant is given", () => {
  assert.equal(vcLeadFieldValue(lead({ coverage_wanted: "final expense" }), "lead_type"), "final expense");
  assert.equal(vcLeadFieldValue(lead({ type: "iul" }), "lead_type"), "iul");
  assert.equal(vcLeadFieldValue(lead({ source: "veteran-form" }), "lead_type"), "veteran-form");
  // coverage_wanted outranks the rest, exactly as ai-call-start orders it.
  assert.equal(
    vcLeadFieldValue(lead({ coverage_wanted: "mortgage", lead_type: "iul", source: "x" }), "lead_type"),
    "mortgage",
  );
});

test("the compliance columns are readable as fields", () => {
  assert.equal(vcLeadFieldValue(lead({}, { tcpa_consent: false }), "tcpa_consent"), false);
  assert.equal(vcLeadFieldValue(lead({}, { dnc: true }), "dnc"), true);
});

test("NO groups and an EMPTY group both match nobody", () => {
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "veteran" }), []), false);
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "veteran" }), null), false);
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "veteran" }), [{ conditions: [] }]), false);
  assert.equal(vcMatchesTriggerGroups(lead({ lead_type: "veteran" }), [[]]), false);
});

test("a group may be written as a bare array or as {conditions:[…]}", () => {
  const bare = [[tagCond()]];
  const wrapped = [group(tagCond())];
  const l = lead({ lead_type: "veteran" });
  assert.equal(vcMatchesTriggerGroups(l, bare), true);
  assert.equal(vcMatchesTriggerGroups(l, wrapped), true);
  assert.deepEqual(vcNormalizeGroups(bare), vcNormalizeGroups(wrapped));
});

// ============================================================
// 2. The tag rule — what keeps a campaign off the whole book
// ============================================================

test("a group with no tag condition is refused", () => {
  const v = vcValidateTriggerGroups([group({ field: "state", op: "is", value: "TX" })]);
  assert.equal(v.ok, false);
  assert.match(v.error || "", /lead type or campaign tag/i);
  assert.equal(v.groupErrors.length, 1);
});

test("an is_not tag condition does NOT satisfy the rule", () => {
  const v = vcValidateTriggerGroups([group({ field: "lead_type", op: "is_not", value: "trucker" })]);
  assert.equal(v.ok, false, "is_not excludes a sliver and admits the rest — that is the campaign nobody meant");
});

test("EVERY group needs its own tag condition, not just one of them", () => {
  const v = vcValidateTriggerGroups([
    group(tagCond("veteran")),
    group({ field: "state", op: "is", value: "TX" }),
  ]);
  assert.equal(v.ok, false);
  assert.equal(v.groupErrors[0], null);
  assert.ok(v.groupErrors[1]);
});

test("every field in VC_TAG_FIELDS satisfies the rule", () => {
  for (const field of VC_TAG_FIELDS) {
    const v = vcValidateTriggerGroups([group({ field, op: "is", value: "x" })]);
    assert.equal(v.ok, true, `${field} should count as a tag`);
  }
});

test("status does NOT count as a tag", () => {
  const v = vcValidateTriggerGroups([group({ field: "status", op: "is", value: "new" })]);
  assert.equal(v.ok, false, '"status is New" describes every fresh row in the book');
});

test("empty, missing-value and missing-field rules are all refused", () => {
  assert.equal(vcValidateTriggerGroups([]).ok, false);
  assert.equal(vcValidateTriggerGroups(null).ok, false);
  assert.equal(vcValidateTriggerGroups([group({ field: "", op: "is", value: "x" })]).ok, false);
  assert.equal(vcValidateTriggerGroups([group({ field: "lead_type", op: "is", value: "" })]).ok, false);
});

test("a valid rule passes and reports no group errors", () => {
  const v = vcValidateTriggerGroups([group(tagCond(), { field: "state", op: "is_not", value: "NY" })]);
  assert.equal(v.ok, true);
  assert.equal(v.error, null);
  assert.deepEqual(v.groupErrors, [null]);
});

// ============================================================
// 3. Enrollment gates
// ============================================================

test("no consent, DNC, suppression, no phone and one-campaign each refuse", () => {
  assert.equal(vcEvaluateEnrollment({ lead: lead({}, { tcpa_consent: false }) }).reason, "no_consent");
  assert.equal(vcEvaluateEnrollment({ lead: lead({}, { dnc: true }) }).reason, "dnc");
  assert.equal(vcEvaluateEnrollment({ lead: lead({}), suppressed: true }).reason, "suppressed");
  assert.equal(vcEvaluateEnrollment({ lead: lead({}), hasPhone: false }).reason, "no_phone");
  assert.equal(vcEvaluateEnrollment({ lead: lead({}), activeElsewhere: true }).reason, "already_enrolled");
});

test("a consented, callable, unenrolled lead is admitted", () => {
  const v = vcEvaluateEnrollment({ lead: lead({}), hasPhone: true, suppressed: false, activeElsewhere: false });
  assert.equal(v.ok, true);
  assert.equal(v.reason, null);
});

test("consent is checked before DNC so the message names the first problem", () => {
  const v = vcEvaluateEnrollment({ lead: lead({}, { tcpa_consent: false, dnc: true }) });
  assert.equal(v.reason, "no_consent");
});

test("the enrollment summary reads the way the toast should", () => {
  assert.equal(vcEnrollSummary(12, { no_consent: 3 }), "12 leads enrolled, 3 skipped: no consent");
  assert.equal(vcEnrollSummary(1, {}), "1 lead enrolled");
  assert.equal(
    vcEnrollSummary(4, { no_consent: 2, dnc: 1 }),
    "4 leads enrolled, 3 skipped: 2 no consent, 1 on DNC",
  );
});

// ============================================================
// 4. Steps, waits, advance
// ============================================================

const steps = [
  { position: 1, step_type: "call", wait_value: 1, wait_unit: "minutes" },
  { position: 2, step_type: "double_dial", wait_value: 2, wait_unit: "hours" },
  { position: 3, step_type: "call", wait_value: 1, wait_unit: "days" },
];

test("wait math covers all three units and refuses nonsense", () => {
  assert.equal(vcWaitMs(1, "minutes"), 60_000);
  assert.equal(vcWaitMs(2, "hours"), 7_200_000);
  assert.equal(vcWaitMs(1, "days"), 86_400_000);
  assert.equal(vcWaitMs(-5, "minutes"), 0);
  assert.equal(vcWaitMs(5, "fortnights"), 0);
  assert.equal(vcWaitMs("x", "minutes"), 0);
});

test("a step is due wait-after the previous one completed", () => {
  assert.equal(vcStepDueAt(NOW, steps[0]).toISOString(), "2026-07-30T15:01:00.000Z");
  assert.equal(vcStepDueAt(NOW, steps[1]).toISOString(), "2026-07-30T17:00:00.000Z");
  assert.equal(vcStepDueAt(NOW, steps[2]).toISOString(), "2026-07-31T15:00:00.000Z");
});

test("steps sort by position and next/at resolve against sparse positions", () => {
  const sparse = [{ position: 9 }, { position: 2 }, { position: 5 }];
  assert.deepEqual(vcStepsSorted(sparse).map((s) => s.position), [2, 5, 9]);
  assert.equal(vcFirstStep(sparse)?.position, 2);
  assert.equal(vcNextStep(sparse, 2)?.position, 5);
  assert.equal(vcNextStep(sparse, 9), null);
  assert.equal(vcStepAt(sparse, 5)?.position, 5);
});

test("wait labels read like English", () => {
  assert.equal(vcWaitLabel({ position: 1, wait_value: 1, wait_unit: "hours" }), "1 hour");
  assert.equal(vcWaitLabel({ position: 1, wait_value: 3, wait_unit: "days" }), "3 days");
  assert.equal(vcWaitLabel({ position: 1, wait_value: 0, wait_unit: "minutes" }), "immediately");
});

const campaign = {
  id: "c1", name: "Veteran Lead", active: true,
  stop_on_appointment_booked: true, stop_on_sold: true,
  stop_on_answered: false, stop_answer_talk_secs: 15,
};

const enrollment = (pos: number, attempts = 0) => ({
  status: "active", current_step_position: pos, step_attempts: attempts, next_action_at: null,
});

test("a completed step schedules the next one at its own wait", () => {
  const adv = vcAdvanceAfterCall({
    campaign, steps, enrollment: enrollment(1),
    call: { outcome: "no_answer", answered_at: null, ended_at: null },
    now: NOW,
  });
  assert.equal(adv.decision, "next_step");
  assert.equal(adv.current_step_position, 2);
  assert.equal(adv.step_attempts, 0);
  assert.equal(adv.next_action_at, "2026-07-30T17:00:00.000Z");
});

test("the last step completes the enrollment", () => {
  const adv = vcAdvanceAfterCall({
    campaign, steps, enrollment: enrollment(3),
    call: { outcome: "no_answer", answered_at: null, ended_at: null },
    now: NOW,
  });
  assert.equal(adv.decision, "completed");
  assert.equal(adv.status, "completed");
  assert.equal(adv.next_action_at, null);
});

// ============================================================
// 5. Double dial — two attempts, a minute apart, no-answer only
// ============================================================

test("double_dial retries once, a minute later, on a no-answer", () => {
  const adv = vcAdvanceAfterCall({
    campaign, steps, enrollment: enrollment(2, 1),
    call: { outcome: "no_answer", answered_at: null, ended_at: null },
    now: NOW,
  });
  assert.equal(adv.decision, "double_dial_retry");
  assert.equal(adv.current_step_position, 2, "same step");
  assert.equal(
    adv.next_action_at,
    new Date(NOW.getTime() + VC_DOUBLE_DIAL_RETRY_SECS * 1000).toISOString(),
  );
});

test("double_dial stops at VC_DOUBLE_DIAL_ATTEMPTS and moves on", () => {
  const adv = vcAdvanceAfterCall({
    campaign, steps, enrollment: enrollment(2, VC_DOUBLE_DIAL_ATTEMPTS),
    call: { outcome: "no_answer", answered_at: null, ended_at: null },
    now: NOW,
  });
  assert.equal(adv.decision, "next_step");
  assert.equal(adv.current_step_position, 3);
});

test("double_dial does NOT retry when somebody actually answered", () => {
  const adv = vcAdvanceAfterCall({
    campaign, steps, enrollment: enrollment(2, 1),
    call: {
      outcome: "completed",
      answered_at: "2026-07-30T14:59:00.000Z",
      ended_at: "2026-07-30T15:00:00.000Z",
    },
    now: NOW,
  });
  assert.equal(adv.decision, "next_step", "dialing someone again 60s after they picked up is what gets a number labelled");
});

test("a plain call step never double-dials", () => {
  const adv = vcAdvanceAfterCall({
    campaign, steps, enrollment: enrollment(1, 1),
    call: { outcome: "no_answer", answered_at: null, ended_at: null },
    now: NOW,
  });
  assert.equal(adv.decision, "next_step");
});

test("vcIsNoAnswer keys on the answer stamp, with the outcome list as backstop", () => {
  assert.equal(vcIsNoAnswer({ answered_at: null }), true);
  assert.equal(vcIsNoAnswer({ outcome: "voicemail", answered_at: "2026-07-30T15:00:00Z" }), true);
  assert.equal(vcIsNoAnswer({ outcome: "busy" }), true);
  assert.equal(vcIsNoAnswer({ outcome: "completed", answered_at: "2026-07-30T15:00:00Z" }), false);
});

// ============================================================
// 6. Stop conditions — especially the talk-time threshold
// ============================================================

const answeredFor = (secs: number) => ({
  outcome: "completed",
  answered_at: "2026-07-30T15:00:00.000Z",
  ended_at: new Date(Date.parse("2026-07-30T15:00:00.000Z") + secs * 1000).toISOString(),
});

test("talk time is measured from the same two stamps the biller uses", () => {
  assert.equal(vcTalkSeconds(answeredFor(42)), 42);
  assert.equal(vcTalkSeconds({ answered_at: null, ended_at: "2026-07-30T15:01:00Z" }), 0);
  assert.equal(vcTalkSeconds(null), 0);
});

test("stop_on_answered fires at the threshold, not below it", () => {
  const c = { ...campaign, stop_on_answered: true, stop_answer_talk_secs: 15 };
  assert.equal(vcEvaluateStop({ campaign: c, call: answeredFor(14) }).stop, false);
  assert.equal(vcEvaluateStop({ campaign: c, call: answeredFor(15) }).stop, true);
  assert.equal(vcEvaluateStop({ campaign: c, call: answeredFor(60) }).reason, "answered");
});

test("a 3-second pickup is NOT an answer", () => {
  const c = { ...campaign, stop_on_answered: true, stop_answer_talk_secs: 15 };
  const v = vcEvaluateStop({ campaign: c, call: answeredFor(3) });
  assert.equal(v.stop, false, "heard the disclosure and hung up — that is not a conversation");
});

test("a custom threshold is honoured", () => {
  const c = { ...campaign, stop_on_answered: true, stop_answer_talk_secs: 45 };
  assert.equal(vcEvaluateStop({ campaign: c, call: answeredFor(30) }).stop, false);
  assert.equal(vcEvaluateStop({ campaign: c, call: answeredFor(45) }).stop, true);
});

test("stop_on_answered off means a long conversation does not stop the campaign", () => {
  assert.equal(vcEvaluateStop({ campaign, call: answeredFor(300) }).stop, false);
});

test("DNC stops unconditionally, above every campaign flag", () => {
  const off = {
    ...campaign,
    stop_on_appointment_booked: false, stop_on_sold: false, stop_on_answered: false,
  };
  assert.deepEqual(vcEvaluateStop({ campaign: off, call: { outcome: "dnc_request" } }), { stop: true, reason: "dnc" });
  assert.deepEqual(vcEvaluateStop({ campaign: off, leadDnc: true }), { stop: true, reason: "dnc" });
  assert.deepEqual(vcEvaluateStop({ campaign: off, call: { dnc: true } }), { stop: true, reason: "dnc" });
});

test("a booked appointment and a sold lead stop when their flags are on", () => {
  assert.equal(vcEvaluateStop({ campaign, call: { appointment_booked: true } }).reason, "appointment_booked");
  assert.equal(vcEvaluateStop({ campaign, leadSold: true }).reason, "sold");
  const off = { ...campaign, stop_on_appointment_booked: false, stop_on_sold: false };
  assert.equal(vcEvaluateStop({ campaign: off, call: { appointment_booked: true } }).stop, false);
  assert.equal(vcEvaluateStop({ campaign: off, leadSold: true }).stop, false);
});

test("a stop beats a step that still had steps left", () => {
  const adv = vcAdvanceAfterCall({
    campaign, steps, enrollment: enrollment(1),
    call: { outcome: "completed", appointment_booked: true, answered_at: "2026-07-30T15:00:00Z", ended_at: "2026-07-30T15:02:00Z" },
    now: NOW,
  });
  assert.equal(adv.status, "stopped");
  assert.equal(adv.stop_reason, "appointment_booked");
  assert.equal(adv.next_action_at, null);
});

test("a DNC beats an in-flight double dial", () => {
  const adv = vcAdvanceAfterCall({
    campaign, steps, enrollment: enrollment(2, 1),
    call: { outcome: "dnc_request", answered_at: "2026-07-30T15:00:00Z", ended_at: "2026-07-30T15:00:20Z" },
    now: NOW,
  });
  assert.equal(adv.status, "stopped");
  assert.equal(adv.stop_reason, "dnc");
});

// ============================================================
// 7. Drip throttle
// ============================================================

test("a drip rate needs both halves to be a throttle at all", () => {
  assert.equal(vcDripActive(null), false);
  assert.equal(vcDripActive({ per_minutes: 60 }), false);
  assert.equal(vcDripActive({ max_calls: 20 }), false);
  assert.equal(vcDripActive({ per_minutes: 60, max_calls: 20 }), true);
  assert.equal(vcDripActive({ per_minutes: 0, max_calls: 20 }), false);
});

test("no drip rate allows everything", () => {
  assert.deepEqual(vcDripAllows({ drip: null, placedInWindow: 9999 }), { allowed: true, remaining: null });
});

test("the drip allows up to max_calls in the window and then holds", () => {
  const drip = { per_minutes: 60, max_calls: 20 };
  assert.deepEqual(vcDripAllows({ drip, placedInWindow: 0 }), { allowed: true, remaining: 20 });
  assert.deepEqual(vcDripAllows({ drip, placedInWindow: 19 }), { allowed: true, remaining: 1 });
  assert.deepEqual(vcDripAllows({ drip, placedInWindow: 20 }), { allowed: false, remaining: 0 });
  assert.deepEqual(vcDripAllows({ drip, placedInWindow: 500 }), { allowed: false, remaining: 0 });
});

test("the drip window is rolling, per_minutes back from now", () => {
  const start = vcDripWindowStart(NOW, { per_minutes: 60, max_calls: 20 });
  assert.equal(start?.toISOString(), "2026-07-30T14:00:00.000Z");
  assert.equal(vcDripWindowStart(NOW, null), null);
});

// ============================================================
// 8. Slots
// ============================================================

const inflight = (over: Record<string, unknown> = {}) => ({
  status: "in_progress", created_at: NOW.toISOString(), ended_at: null, ...over,
});

test("slots count only live, non-stale, in-progress calls", () => {
  assert.equal(vcSlotsInUse([inflight(), inflight(), inflight()], NOW), 3);
  assert.equal(vcSlotsInUse([inflight({ status: "completed" })], NOW), 0);
  assert.equal(vcSlotsInUse([inflight({ ended_at: NOW.toISOString() })], NOW), 0);
  assert.equal(vcSlotsInUse([], NOW), 0);
});

test("a call whose hangup never arrived stops holding a slot for ever", () => {
  const ancient = inflight({ created_at: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString() });
  assert.equal(vcSlotsInUse([ancient], NOW), 0, "one lost webhook must not stop an agent's campaigns permanently");
});

test("free slots and the label", () => {
  assert.equal(vcSlotsFree(0), VC_SLOT_LIMIT);
  assert.equal(vcSlotsFree(3), 0);
  assert.equal(vcSlotsFree(9), 0);
  assert.equal(vcSlotsLabel(0), "0/3 active");
  assert.equal(vcSlotsLabel(2), "2/3 active");
  assert.equal(vcSlotsLabel(7), "3/3 active");
});

// ============================================================
// 9. Caller-ID rotation
// ============================================================

const NUM_A = { e164: "+12025550001", ai_first_used_at: "2026-06-01T00:00:00Z" }; // mature: 300
const NUM_B = { e164: "+12025550002", ai_first_used_at: "2026-06-01T00:00:00Z" }; // mature: 300
const NUM_NEW = { e164: "+12025550003", ai_first_used_at: null };                 // day 1: 30

test("no numbers means no choice, not a fabricated one", () => {
  assert.equal(vcPickCallerId([], {}, NOW, CHI), null);
  assert.equal(vcPickCallerId(null, {}, NOW, CHI), null);
});

test("the number with the most headroom against ITS OWN ramp wins", () => {
  const pick = vcPickCallerId([NUM_A, NUM_B], { [NUM_A.e164]: 100 }, NOW, CHI);
  assert.equal(pick?.e164, NUM_B.e164);
  assert.equal(pick?.headroom, 300);
});

test("a brand-new number is not preferred just because it is unused", () => {
  // NUM_NEW is on ramp day 1 (30 recommended) and has carried nothing;
  // NUM_A is mature with 100 already placed. 200 > 30.
  const pick = vcPickCallerId([NUM_A, NUM_NEW], { [NUM_A.e164]: 100 }, NOW, CHI);
  assert.equal(pick?.e164, NUM_A.e164);
  assert.equal(pick?.recommended, 300);
  assert.equal(pick?.headroom, 200);
});

test("a ramping number is used once the mature one is loaded up", () => {
  const pick = vcPickCallerId([NUM_A, NUM_NEW], { [NUM_A.e164]: 290 }, NOW, CHI);
  assert.equal(pick?.e164, NUM_NEW.e164, "10 left on the mature one, 30 on the new one");
});

test("ties are deterministic, and usage makes the next call alternate", () => {
  const usage: Record<string, number> = {};
  const first = vcPickCallerId([NUM_B, NUM_A], usage, NOW, CHI);
  assert.equal(first?.e164, NUM_A.e164, "lowest e164 breaks a tie");
  usage[first!.e164] = 1;
  const second = vcPickCallerId([NUM_B, NUM_A], usage, NOW, CHI);
  assert.equal(second?.e164, NUM_B.e164, "the loser of the tie wins the next one — that IS the rotation");
});

test("everyone over budget still returns a number — the recommendation never blocks", () => {
  const pick = vcPickCallerId([NUM_A, NUM_B], { [NUM_A.e164]: 500, [NUM_B.e164]: 400 }, NOW, CHI);
  assert.equal(pick?.e164, NUM_B.e164);
  assert.equal(pick?.headroom, -100);
});

// ============================================================
// 10. Gate rejections
// ============================================================

test("daily_cap_reached reschedules at the reset boundary the 429 stated", () => {
  const plan = vcHandleGateRejection({
    code: "daily_cap_reached", now: NOW, resetsAt: "2026-07-31T05:00:00.000Z",
  });
  assert.equal(plan.action, "reschedule");
  assert.equal(plan.next_action_at, "2026-07-31T05:00:00.000Z");
  assert.equal(plan.pause_reason, null);
});

test("daily_cap_reached with no resets_at still backs off an hour, never a minute", () => {
  const plan = vcHandleGateRejection({ code: "daily_cap_reached", now: NOW });
  assert.equal(plan.next_action_at, new Date(NOW.getTime() + 3_600_000).toISOString());
});

test("quiet_hours reschedules at the next allowed instant", () => {
  const plan = vcHandleGateRejection({
    code: "quiet_hours", now: NOW, quietUntil: "2026-07-31T13:00:00.000Z",
  });
  assert.equal(plan.action, "reschedule");
  assert.equal(plan.next_action_at, "2026-07-31T13:00:00.000Z");
});

test("an empty wallet PAUSES the campaign rather than retrying every minute", () => {
  const plan = vcHandleGateRejection({ code: "insufficient_balance", now: NOW });
  assert.equal(plan.action, "pause_campaign");
  assert.match(plan.pause_reason || "", /wallet/i);
  assert.equal(plan.leaveDue, true, "first in the queue the moment they top up");
});

test("every account-level refusal pauses with a sentence a person can act on", () => {
  for (const code of ["insufficient_balance", "ai_disabled", "upgrade_required", "no_caller_id"]) {
    const plan = vcHandleGateRejection({ code, now: NOW });
    assert.equal(plan.action, "pause_campaign", code);
    assert.ok((plan.pause_reason || "").length > 20, `${code} needs a real sentence`);
    assert.match(plan.pause_reason || "", /^Paused: /);
  }
});

test("a per-lead refusal stops that enrollment and nothing else", () => {
  const plan = vcHandleGateRejection({ code: "not_callable", now: NOW });
  assert.equal(plan.action, "stop_enrollment");
  assert.equal(plan.stop_reason, "not_callable");
  assert.equal(plan.pause_reason, null);
});

test("an unknown or transient failure backs off and keeps the enrollment", () => {
  for (const code of ["telnyx_error", "http_500", "network_error", "assistant_not_found"]) {
    const plan = vcHandleGateRejection({ code, now: NOW });
    assert.equal(plan.action, "retry_soon", code);
    assert.equal(
      plan.next_action_at,
      new Date(NOW.getTime() + VC_TRANSIENT_RETRY_SECS * 1000).toISOString(),
    );
  }
});

test("no rejection path ever leaves next_action_at at 'a minute from now'", () => {
  const codes = [
    "daily_cap_reached", "quiet_hours", "insufficient_balance", "ai_disabled",
    "upgrade_required", "no_caller_id", "not_callable", "telnyx_error",
  ];
  for (const code of codes) {
    const plan = vcHandleGateRejection({ code, now: NOW });
    if (!plan.next_action_at) continue;
    const gap = Date.parse(plan.next_action_at) - NOW.getTime();
    assert.ok(gap >= 60_000, `${code} backed off only ${gap}ms`);
  }
});

// ============================================================
// 11. Next allowed instant
// ============================================================

test("the next allowed instant uses the caller's own predicate", () => {
  // Shut until 18:00Z, then open.
  const isAllowed = (at: Date) => at.getUTCHours() >= 18;
  const at = vcNextAllowedInstant(NOW, isAllowed);
  assert.equal(at, "2026-07-30T18:00:00.000Z");
});

test("already-allowed still moves forward rather than returning now", () => {
  const at = vcNextAllowedInstant(NOW, () => true);
  assert.ok(Date.parse(at) > NOW.getTime());
});

test("a window that never opens gives up after the horizon instead of spinning", () => {
  const at = vcNextAllowedInstant(NOW, () => false, 15, 2);
  assert.equal(at, new Date(NOW.getTime() + 3_600_000).toISOString());
});

// ============================================================
// 12. Assistant context and stats
// ============================================================

test("campaign vars carry the name, step and goal — blank NAME stays blank, blank GOAL does not", () => {
  // The name is a phrase the agent wrote and the assistant might repeat, so a
  // default would be a phrase they have to explain to a lead. The goal is an
  // internal switch nobody hears, so defaulting it to `qualify` invents
  // nothing — and leaving it blank would mean an unrecognised value landed on
  // no script at all.
  assert.deepEqual(
    vcCampaignVars({ name: "Veteran Lead", campaign_goal: "qualify" }, { position: 2, step_type: "double_dial" }),
    { campaign_name: "Veteran Lead", campaign_step: "2", campaign_step_type: "double_dial", campaign_goal: "qualify" },
  );
  assert.deepEqual(
    vcCampaignVars({ name: "Appointment Reminder", campaign_goal: "remind" }, { position: 1, step_type: "call" }),
    { campaign_name: "Appointment Reminder", campaign_step: "1", campaign_step_type: "call", campaign_goal: "remind" },
  );
  assert.deepEqual(
    vcCampaignVars({ name: "" }, null),
    { campaign_name: "", campaign_step: "", campaign_step_type: "", campaign_goal: "qualify" },
  );
  assert.deepEqual(
    vcCampaignVars(null, null),
    { campaign_name: "", campaign_step: "", campaign_step_type: "", campaign_goal: "qualify" },
  );
  assert.deepEqual(
    vcCampaignVars({ name: "x", campaign_goal: "nonsense" }, null).campaign_goal,
    "qualify",
  );
});

test("campaign stats roll enrollments into the card's numbers", () => {
  const s = vcCampaignStats([
    { status: "active", calls_placed: 2, answers: 1, appointments: 0 },
    { status: "completed", calls_placed: 6, answers: 2, appointments: 1 },
    { status: "stopped", calls_placed: 1, answers: 0, appointments: 0 },
  ]);
  assert.deepEqual(s, {
    enrolled: 3, active: 1, completed: 1, stopped: 1, calls: 9, answers: 3, appointments: 1,
  });
  assert.deepEqual(vcCampaignStats([]), {
    enrolled: 0, active: 0, completed: 0, stopped: 0, calls: 0, answers: 0, appointments: 0,
  });
});

test("stop reasons have human labels", () => {
  assert.equal(vcStopReasonLabel("appointment_booked"), "Appointment booked");
  assert.equal(vcStopReasonLabel("dnc"), "Asked not to be called");
  assert.equal(vcStopReasonLabel(null), "");
  assert.equal(vcStopReasonLabel("something_new"), "something_new");
});
