// ============================================================
// voice-campaign-mission.test.ts — run with:  npm run test:ai
//
// The campaign screen's decisions: what happens to this lead next (and if
// nothing does, why not), what the last call did, what one line of the
// activity feed says, and what pause / resume / remove mean for a selection.
//
// The pause/resume rules are the ones with teeth. `status = 'paused'` is not a
// new flag the engine has to remember to honour — the tick's due query and
// vcClaimEnrollment both already require 'active', so a paused enrollment is
// simply never picked up. The cost of that is the one-active-campaign index,
// which covers ACTIVE rows only: pausing releases the lead, so resuming has to
// look before it steps back in.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  VC_ENROLLMENT_OPS,
  vcEnrollmentActionSentence,
  vcFeed,
  vcFeedEntry,
  vcLastCallAt,
  vcLastCallLabel,
  vcNextAction,
  vcNextActionText,
  vcPlanEnrollmentAction,
  vcRelTime,
  vcStepProgressLabel,
  vcStopReasonLabel,
  vcWaitReasonLabel,
} from "./voice-campaign-core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const NOW = new Date("2026-07-31T15:00:00.000Z");

const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ position: i + 1, step_type: "call", wait_value: 1, wait_unit: "days" }));

// ============================================================
// 1. Progress and relative time
// ============================================================

test("progress reads as a person counts, not as the column stores", () => {
  assert.equal(vcStepProgressLabel(1, steps(6)), "Step 1 of 6");
  assert.equal(vcStepProgressLabel(2, steps(6)), "Step 2 of 6");
  assert.equal(vcStepProgressLabel(6, steps(6)), "Step 6 of 6");
  // The step was deleted under a live enrollment. The tick completes it on the
  // next pass; until then it is still somewhere, and clamping beats "Step 9 of 6".
  assert.equal(vcStepProgressLabel(9, steps(6)), "Step 6 of 6");
  assert.equal(vcStepProgressLabel(0, steps(6)), "Step 1 of 6");
  assert.equal(vcStepProgressLabel(1, []), "No steps");
});

test("relative time is whole units, so a ten-second refresh cannot flicker", () => {
  const at = (mins: number) => new Date(NOW.getTime() + mins * 60000).toISOString();
  assert.equal(vcRelTime(at(0), NOW), "just now");
  assert.equal(vcRelTime(at(-0.5), NOW), "just now");
  assert.equal(vcRelTime(at(-2), NOW), "2m ago");
  assert.equal(vcRelTime(at(-119), NOW), "1h ago");
  assert.equal(vcRelTime(at(-120), NOW), "2h ago");
  assert.equal(vcRelTime(at(-60 * 25), NOW), "1d ago");
  assert.equal(vcRelTime(at(5), NOW), "in 5m");
  assert.equal(vcRelTime(at(60 * 20), NOW), "in 20h");
  assert.equal(vcRelTime(null, NOW), "");
  assert.equal(vcRelTime("not a date", NOW), "");
});

// ============================================================
// 2. What happens next — and why not
// ============================================================

const soon = new Date(NOW.getTime() + 3600_000).toISOString();
const past = new Date(NOW.getTime() - 3600_000).toISOString();

test("a live call outranks everything, including a pause", () => {
  const v = vcNextAction({
    enrollment: { status: "paused", paused_at: past },
    campaign: { active: false, paused_at: past },
    inFlight: true,
    now: NOW,
  });
  assert.equal(v.kind, "calling");
  assert.equal(vcNextActionText(v, ""), "Calling now…");
});

test("a paused lead says so, and says when", () => {
  const v = vcNextAction({ enrollment: { status: "paused", paused_at: past, next_action_at: soon }, now: NOW });
  assert.equal(v.kind, "paused_lead");
  assert.equal(v.at, past);
  assert.equal(vcNextActionText(v, "1h ago"), "Paused 1h ago");
});

test("a claim with nothing due is a ringing phone, not an error and not a pause", () => {
  const v = vcNextAction({
    enrollment: { status: "active", next_action_at: null, claimed_at: NOW.toISOString() },
    now: NOW,
  });
  assert.equal(v.kind, "waiting_on_call");
  assert.equal(vcNextActionText(v, ""), "Call in progress…");
});

test("a paused or switched-off campaign explains the silence", () => {
  const paused = vcNextAction({
    enrollment: { status: "active", next_action_at: soon },
    campaign: { active: true, paused_at: past },
    now: NOW,
  });
  assert.equal(paused.kind, "paused_campaign");
  assert.equal(vcNextActionText(paused, "9:05 AM"), "Campaign paused");

  const off = vcNextAction({
    enrollment: { status: "active", next_action_at: soon },
    campaign: { active: false, paused_at: null },
    now: NOW,
  });
  assert.equal(off.kind, "campaign_off");
  assert.equal(vcNextActionText(off, ""), "Campaign switched off");
});

test("THE POINT: a scheduled wait names the gate that caused it", () => {
  const quiet = vcNextAction({
    enrollment: { status: "active", next_action_at: soon, last_gate_code: "quiet_hours" },
    campaign: { active: true },
    now: NOW,
  });
  assert.equal(quiet.kind, "scheduled");
  assert.equal(quiet.code, "quiet_hours");
  assert.equal(
    vcNextActionText(quiet, "9:05 AM"),
    "Quiet hours where they live · next call 9:05 AM",
    "a bare time on a screen somebody opened because nothing is happening reads as broken",
  );

  const cap = vcNextAction({
    enrollment: { status: "active", next_action_at: soon, last_gate_code: "daily_cap_reached" },
    campaign: { active: true },
    now: NOW,
  });
  assert.equal(vcNextActionText(cap, "8:00 AM"), "Your daily call limit · next call 8:00 AM");

  // No gate code — an ordinary step wait. Just the time; there is no reason to
  // give because nothing refused anything.
  const plain = vcNextAction({
    enrollment: { status: "active", next_action_at: soon },
    campaign: { active: true },
    now: NOW,
  });
  assert.equal(plain.code, null);
  assert.equal(vcNextActionText(plain, "Aug 1, 9:00 AM"), "Aug 1, 9:00 AM");
});

test("a wait reason we do not have words for adds none", () => {
  assert.equal(vcWaitReasonLabel("something_new"), "");
  assert.equal(vcWaitReasonLabel(null), "");
  const v = { kind: "scheduled" as const, at: soon, code: "something_new" };
  assert.equal(vcNextActionText(v, "9:05 AM"), "9:05 AM", "an unknown code must not print itself at a person");
});

test("due now is due now, and an ended enrollment has no next", () => {
  assert.equal(vcNextAction({
    enrollment: { status: "active", next_action_at: past }, campaign: { active: true }, now: NOW,
  }).kind, "due");
  for (const s of ["stopped", "completed"]) {
    assert.equal(vcNextAction({ enrollment: { status: s, next_action_at: soon }, now: NOW }).kind, "ended");
  }
  assert.equal(vcNextActionText({ kind: "ended", at: null, code: null }, ""), "—");
});

test("an active enrollment with nothing due and no claim is honestly 'unknown'", () => {
  // It should not happen; saying "Scheduled" about it would hide a bug.
  const v = vcNextAction({ enrollment: { status: "active" }, campaign: { active: true }, now: NOW });
  assert.equal(v.kind, "unknown");
  assert.equal(vcNextActionText(v, ""), "—");
});

// ============================================================
// 3. The last call, worded once
// ============================================================

test("the last call is worded exactly as the lead row words it", () => {
  assert.equal(vcLastCallLabel({ outcome: "no_answer", status: "completed" }), "No answer");
  assert.equal(vcLastCallLabel({ outcome: "appointment_booked", status: "completed" }), "Appointment booked");
  assert.equal(vcLastCallLabel({ outcome: "dnc_request", status: "completed" }), "Do not call");
  assert.equal(vcLastCallLabel({ outcome: "completed", status: "completed" }), "Talked");
  // A call still in the air reports itself, not its placeholder outcome.
  assert.equal(vcLastCallLabel({ outcome: "in_progress", status: "in_progress" }), "Calling now");
  assert.equal(vcLastCallLabel({ outcome: "error", status: "completed" }), "Call failed");
  assert.equal(vcLastCallLabel(null), "");
});

test("the last call's time prefers when it ended, then when it was placed", () => {
  assert.equal(vcLastCallAt({ ended_at: "b", created_at: "a" }), "b");
  assert.equal(vcLastCallAt({ ended_at: null, created_at: "a" }), "a");
  assert.equal(vcLastCallAt(null), null);
});

// ============================================================
// 4. The activity feed
// ============================================================

test("a feed line names the lead and what happened to them", () => {
  const e = vcFeedEntry(
    { id: "c1", lead_id: "l1", outcome: "appointment_booked", status: "completed", ended_at: "2026-07-31T14:09:00Z" },
    { leadName: "Lisa P.", retryAt: null },
  );
  assert.equal(e.headline, "Booked an appointment with Lisa P.");
  assert.equal(e.tone, "good");
  assert.equal(e.call_id, "c1");
  assert.equal(e.lead_id, "l1");
  assert.equal(e.at, "2026-07-31T14:09:00Z");
});

test("every outcome produces a sentence, and the bad news reads as bad news", () => {
  const OUTCOMES = [
    "voicemail", "no_answer", "busy", "not_interested", "qualified", "dnc_request",
    "error", "callback_requested", "appointment_booked", "transferred", "completed",
  ];
  for (const o of OUTCOMES) {
    const e = vcFeedEntry({ id: "c", lead_id: "l", outcome: o, status: "completed" }, { leadName: "Mark J." });
    assert.ok(e.headline.includes("Mark J."), `${o} must name the lead`);
    assert.ok(e.headline.length > 8, `${o} needs a real sentence`);
  }
  assert.equal(vcFeedEntry({ outcome: "dnc_request" }, { leadName: "X" }).tone, "bad");
  assert.equal(vcFeedEntry({ outcome: "not_interested" }, { leadName: "X" }).tone, "bad");
  assert.equal(vcFeedEntry({ outcome: "no_answer" }, { leadName: "X" }).tone, "neutral");
});

test("a nameless lead does not produce 'Called .'", () => {
  const e = vcFeedEntry({ id: "c", outcome: "no_answer" }, { leadName: "  " });
  assert.equal(e.headline, "Called a lead — no answer");
});

test("a call in progress reports itself as in progress whatever the outcome column says", () => {
  const e = vcFeedEntry({ id: "c", status: "in_progress", outcome: "no_answer" }, { leadName: "Mark J." });
  assert.equal(e.outcome, "in_progress");
  assert.equal(e.headline, "Calling Mark J.…");
});

test("the feed is newest first and stops at the limit", () => {
  const calls = [
    { id: "a", lead_id: "1", outcome: "no_answer", created_at: "2026-07-31T10:00:00Z" },
    { id: "c", lead_id: "1", outcome: "no_answer", created_at: "2026-07-31T12:00:00Z" },
    { id: "b", lead_id: "1", outcome: "no_answer", created_at: "2026-07-31T11:00:00Z" },
  ];
  const out = vcFeed(calls, { leadName: () => "Mark", limit: 2 });
  assert.deepEqual(out.map((e) => e.call_id), ["c", "b"]);
});

test("a retry is only named while the campaign is still going to make one", () => {
  const calls = [{ id: "a", lead_id: "l1", outcome: "no_answer", created_at: "2026-07-31T10:00:00Z" }];
  const withRetry = vcFeed(calls, { leadName: () => "Mark", retryAt: () => soon });
  assert.equal(withRetry[0].retry_at, soon);
  const stopped = vcFeed(calls, { leadName: () => "Mark", retryAt: () => null });
  assert.equal(stopped[0].retry_at, null);
});

// ============================================================
// 5. Pause / resume / remove
// ============================================================

const rows = (list: Array<[string, string, string]>) =>
  new Map(list.map(([id, lead, status]) => [id, { id, lead_id: lead, status }]));

test("pause takes the active ones and reports the rest", () => {
  const plan = vcPlanEnrollmentAction({
    op: "pause",
    enrollment_ids: ["e1", "e2", "e3", "e4"],
    byId: rows([["e1", "l1", "active"], ["e2", "l2", "paused"], ["e3", "l3", "stopped"]]),
  });
  assert.deepEqual(plan.items.map((i) => i.enrollment_id), ["e1"]);
  assert.equal(plan.skipped.not_active, 1);      // already paused
  assert.equal(plan.skipped.already_ended, 1);   // stopped
  assert.equal(plan.skipped.not_found, 1);       // e4 is not this agent's
  assert.equal(vcEnrollmentActionSentence(plan, "will"),
    "1 will be paused · 1 not running · 1 already finished · 1 not yours");
});

test("resume refuses a lead who has been taken by another campaign meanwhile", () => {
  // Pausing releases the one-active-campaign slot (the unique index covers
  // ACTIVE rows only), so this is a real state, and without the check the
  // agent would get a raw 23505.
  const plan = vcPlanEnrollmentAction({
    op: "resume",
    enrollment_ids: ["e1", "e2"],
    byId: rows([["e1", "l1", "paused"], ["e2", "l2", "paused"]]),
    activeElsewhere: new Set(["l2"]),
  });
  assert.deepEqual(plan.items.map((i) => i.enrollment_id), ["e1"]);
  assert.equal(plan.skipped.active_elsewhere, 1);
  assert.ok(vcEnrollmentActionSentence(plan, "will").includes("now in another campaign"));
});

test("resume only takes paused rows", () => {
  const plan = vcPlanEnrollmentAction({
    op: "resume",
    enrollment_ids: ["e1", "e2"],
    byId: rows([["e1", "l1", "active"], ["e2", "l2", "completed"]]),
  });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.skipped.not_paused, 2);
});

test("remove takes both active and paused, and nothing already finished", () => {
  const plan = vcPlanEnrollmentAction({
    op: "remove",
    enrollment_ids: ["e1", "e2", "e3"],
    byId: rows([["e1", "l1", "active"], ["e2", "l2", "paused"], ["e3", "l3", "completed"]]),
  });
  assert.deepEqual(plan.items.map((i) => i.enrollment_id), ["e1", "e2"]);
  assert.equal(plan.skipped.already_ended, 1);
  assert.equal(vcEnrollmentActionSentence(plan, "did"), "2 removed · 1 already finished");
});

test("the same id twice is one lead", () => {
  const plan = vcPlanEnrollmentAction({
    op: "pause",
    enrollment_ids: ["e1", "e1", "e1"],
    byId: rows([["e1", "l1", "active"]]),
  });
  assert.equal(plan.items.length, 1);
});

test("an unknown op cannot silently become a destructive one", () => {
  const plan = vcPlanEnrollmentAction({
    // deno-lint-ignore no-explicit-any
    op: "delete_everything" as any,
    enrollment_ids: ["e1"],
    byId: rows([["e1", "l1", "active"]]),
  });
  assert.equal(plan.op, "pause", "the fallback is the reversible one");
  assert.deepEqual([...VC_ENROLLMENT_OPS], ["pause", "resume", "remove"]);
});

test("Remove is recorded as its own thing, not as the old Unenroll", () => {
  assert.equal(vcStopReasonLabel("removed_by_user"), "Removed by hand");
  assert.equal(vcStopReasonLabel("manual"), "Unenrolled by hand");
  assert.equal(vcStopReasonLabel("moved_by_user"), "Moved to another campaign");
});

// ============================================================
// 6. The endpoint and the engine, as source text
// ============================================================

const MANAGE = readFileSync(join(ROOT, "supabase/functions/voice-campaign-manage/index.ts"), "utf8");
const TICK = readFileSync(join(ROOT, "supabase/functions/voice-campaign-tick/index.ts"), "utf8");
const CLAIM = readFileSync(join(ROOT, "supabase/functions/_shared/voice-campaign-claim.ts"), "utf8");
const WEBHOOK = readFileSync(join(ROOT, "supabase/functions/ai-call-webhook/index.ts"), "utf8");
const MIG = readFileSync(join(ROOT, "supabase/migrations/20260805_campaign_mission_control.sql"), "utf8");

test("a paused enrollment is invisible to the tick, by the rule that already existed", () => {
  // This is the whole reason pause needed no new engine code: both the due
  // query and the claim require status = 'active'.
  assert.ok(CLAIM.includes('.eq("status", "active")'), "the claim only ever takes an active row");
  const due = TICK.slice(TICK.indexOf("---------- 3. Due"), TICK.indexOf("Steps, once"));
  assert.ok(due.includes('.eq("status", "active")'), "and so does the due query");
});

test("the preview and the write are the same plan, on this door too", () => {
  const block = MANAGE.slice(
    MANAGE.indexOf('if (action === "enrollment_action")'),
    MANAGE.indexOf("preview_enroll / enroll_leads — the manual"),
  );
  assert.ok(block.length > 500, "the enrollment_action block must come before the enrol door");
  assert.equal((block.match(/vcPlanEnrollmentAction\(/g) || []).length, 1,
    "one planner call serves both — a second would be a preview that drifts");
  assert.ok(block.indexOf("if (!write)") > block.indexOf("vcPlanEnrollmentAction("),
    "the split happens AFTER the plan is made");
});

test("remove records a decision and never deletes", () => {
  const block = MANAGE.slice(
    MANAGE.indexOf('if (action === "enrollment_action")'),
    MANAGE.indexOf("preview_enroll / enroll_leads — the manual"),
  );
  assert.ok(!/\.delete\(/.test(block), "removing a lead from a campaign records why, it does not erase it");
  assert.ok(block.includes('"removed_by_user"'));
  assert.ok(!block.includes("dnc_list") && !block.includes("suppression_list"),
    "'take them out of this campaign' is not 'never call me again'");
});

test("every read and write is re-scoped to the caller", () => {
  const block = MANAGE.slice(
    MANAGE.indexOf('if (action === "enrollment_action")'),
    MANAGE.indexOf("preview_enroll / enroll_leads — the manual"),
  );
  assert.ok(!/body\.agent_id/.test(MANAGE), "there is no agent id in the body, ever");
  const scoped = (block.match(/\.eq\("agent_id", user\.id\)/g) || []).length;
  assert.ok(scoped >= 5, `every query names the caller (found ${scoped})`);
});

test("resume repairs an enrollment paused mid-call instead of stranding it", () => {
  const block = MANAGE.slice(MANAGE.indexOf('} else if (op === "resume")'), MANAGE.indexOf("} else {"));
  assert.ok(block.includes('.is("next_action_at", null)'), "the null case is handled explicitly");
  assert.ok(block.includes("next_action_at: nowIso"), "and given a date, or it would never be due again");
});

test("the tick records WHY it deferred, and clears it the moment it dials", () => {
  assert.ok(TICK.includes("last_gate_code:"), "the reason is stored");
  const dial = TICK.slice(TICK.indexOf("totals.dialed++"), TICK.indexOf("---------- 7. The gate said no"));
  assert.ok(dial.includes("last_gate_code:  null"), "a stale reason must not outlive its wait");
});

test("the webhook applies the outcome to the lead BEFORE it advances the campaign", () => {
  const iLead = WEBHOOK.indexOf("await applyLeadEffect(");
  const iCamp = WEBHOOK.indexOf("await recordCampaignCallResult(");
  assert.ok(iLead > 0 && iCamp > 0);
  assert.ok(iLead < iCamp,
    "the campaign's stop rules read the lead — a lead who just asked not to be called must be seen with the flag up");
});

test("the migration adds no write policy to the enrollment table", () => {
  assert.ok(!/create policy[^;]*voice_campaign_enrollments[^;]*for (insert|update|delete)/is.test(MIG));
  assert.ok(MIG.includes("NO INSERT OR UPDATE POLICY"), "and it says why in the file");
});

test("the status guard fires on browser writes only, and compares stamps", () => {
  const fn = MIG.slice(MIG.indexOf("function public.leads_preserve_ai_status()"), MIG.indexOf("drop trigger if exists leads_preserve_ai_status"));
  assert.ok(fn.includes("auth.role() is distinct from 'authenticated'"), "service-role writes are trusted");
  assert.ok(fn.includes("old.data->>'status_source' = 'ai'"), "it only ever guards a status the AI set");
  assert.ok(fn.includes("new_at <= old_at"), "an equal-or-older stamp is an echo, not a decision");
  assert.ok(/before update on public\.leads/.test(MIG));
});
