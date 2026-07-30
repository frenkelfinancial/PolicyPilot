// ============================================================
// ai-call-outcome.test.ts — run with:  npm run test:ai   (Node 24, no deps)
//
// The regression this file exists for: six consecutive production calls
// finished normally and every one of them was stored as `outcome = 'error'`
// with a null summary, because Telnyx's insights event carries a prose
// paragraph and the old parser only looked for an object containing an
// `outcome` key. THE_REAL_PAYLOAD below is that exact event, copied out of
// ai_call_events (call_control_id v3:lAjxbqZUF2TUu3QctQdqmUFuue1eVBbS…).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coerceQualification,
  extractJsonObject,
  keywordOutcome,
  outcomeFromCallFlow,
  parseInsightPayload,
  shouldReplaceOutcome,
} from "./ai-call-outcome.ts";

// ---- extractJsonObject --------------------------------------------------

test("extractJsonObject: lifts a JSON block out of surrounding prose", () => {
  const o = extractJsonObject('Here is the result:\n{"outcome":"qualified","age":"58"}\nThanks!');
  assert.deepEqual(o, { outcome: "qualified", age: "58" });
});

test("extractJsonObject: is brace-balanced, not greedy", () => {
  // A greedy /\{[\s\S]*\}/ spans BOTH objects and parses as neither.
  const o = extractJsonObject('first {"outcome":"qualified"} then {"other":"thing"}');
  assert.deepEqual(o, { outcome: "qualified" });
});

test("extractJsonObject: a brace inside a string value does not close the object", () => {
  const o = extractJsonObject('{"notes":"said \\"} maybe {\\" on the call","age":"60"}');
  assert.equal(o?.age, "60");
});

test("extractJsonObject: nested objects survive", () => {
  const o = extractJsonObject('{"outcome":"qualified","meta":{"a":{"b":1}},"age":"58"}');
  assert.equal(o?.age, "58");
});

test("extractJsonObject: prose with no object at all is null", () => {
  assert.equal(extractJsonObject("the caller was busy and rang off"), null);
  assert.equal(extractJsonObject("{ not json at all"), null);
});

// ---- coerceQualification ------------------------------------------------

test("coerceQualification: maps the v1 script's key names onto the new schema", () => {
  const q = coerceQualification({
    outcome: "qualified", age_band: "50-59", coverage_type: "FEX",
    budget: "~$85/mo", callback_window: "weekday evenings", summary: "Mark is interested.",
  });
  assert.equal(q?.age, "50-59");
  assert.equal(q?.coverage_interest, "FEX");
  assert.equal(q?.budget_text, "~$85/mo");
  assert.equal(q?.best_callback_text, "weekday evenings");
  assert.equal(q?.summary, "Mark is interested.");
});

test("coerceQualification: a managed insight ({score,reason}) is NOT a qualification", () => {
  // Agent Instruction Following and User Satisfaction both return this shape
  // and both ride in the same results[] array. Accepting it would file "Good"
  // as the caller's age.
  assert.equal(coerceQualification({ score: "Good", reason: "followed the script" }), null);
});

test("coerceQualification: numbers survive as strings, blanks are dropped", () => {
  const q = coerceQualification({ outcome: "qualified", age: 58, budget_text: "   " });
  assert.equal(q?.age, "58");
  assert.equal(q?.budget_text, null);
});

test("coerceQualification: a canonical key is never clobbered by an alias", () => {
  const q = coerceQualification({ age: "58", age_band: "70-79", outcome: "qualified" });
  assert.equal(q?.age, "58");
});

// ---- keywordOutcome -----------------------------------------------------

test("keywordOutcome: an opt-out outranks everything else in the sentence", () => {
  assert.equal(
    keywordOutcome("The caller asked to be removed from the list, though they suggested a callback next week."),
    "dnc_request",
  );
  assert.equal(keywordOutcome("She told the assistant to stop calling."), "dnc_request");
});

test("keywordOutcome: 'not interested' is never read as 'interested'", () => {
  assert.equal(keywordOutcome("The user was not interested in additional coverage."), "not_interested");
});

test("keywordOutcome: booking, transfer and callback are distinguished", () => {
  assert.equal(keywordOutcome("An appointment was booked for Tuesday afternoon."), "appointment_booked");
  assert.equal(keywordOutcome("The caller was transferred to the licensed agent."), "transferred");
  assert.equal(keywordOutcome("The caller requested a callback tomorrow morning."), "callback_requested");
});

test("keywordOutcome: refuses to guess", () => {
  assert.equal(keywordOutcome("The weather came up, then the call ended."), null);
  assert.equal(keywordOutcome(""), null);
});

// ---- parseInsightPayload: the real production payload --------------------

const THE_REAL_PAYLOAD = {
  to: "+19204169244",
  from: "+12029981783",
  results: [{
    result:
      "Owen Clark, an assistant for Jace Frenkel at Frenkel Financial, contacted the user about " +
      "final expense coverage. The user was busy and initially unsure about the coverage, but after " +
      "a brief explanation, they mentioned already having coverage through the VA. The conversation " +
      "ended with the user's existing coverage being acknowledged, and no further action or decision " +
      "was made regarding additional coverage.",
    insight_id: "cfcc865c-d3d4-4823-8a4b-f0df57d9f56f",
  }],
  call_control_id: "v3:lAjxbqZUF2TUu3QctQdqmUFuue1eVBbS2zusyw6PWZfuKx1khSm2Bw",
  insight_group_id: "0ef2400e-529b-4727-864b-023f08103f67",
};

test("parseInsightPayload: the real prose payload yields a summary, not an error", () => {
  const p = parseInsightPayload(THE_REAL_PAYLOAD);
  assert.ok(p.summary && p.summary.startsWith("Owen Clark"), "the paragraph is kept as the summary");
  assert.equal(p.qualification, null, "there is no JSON in it to find");
  // "already having coverage" is a not_interested signal; either that or a
  // clean null is acceptable — what is NOT acceptable is losing the summary.
  assert.ok(p.outcome === "not_interested" || p.outcome === null);
  assert.ok(p.method === "keywords" || p.method === "prose_only");
});

test("parseInsightPayload: a structured insight parses to a qualification", () => {
  const p = parseInsightPayload({
    results: [{
      insight_id: "structured-1",
      result: JSON.stringify({
        outcome: "qualified", age: "58", coverage_interest: "final expense",
        budget_text: "$85 a month", best_callback_text: "", notes: "Wife also needs cover.",
      }),
    }],
  });
  assert.equal(p.method, "json");
  assert.equal(p.outcome, "qualified");
  assert.equal(p.qualification?.age, "58");
  assert.equal(p.qualification?.budget_text, "$85 a month");
  assert.equal(p.qualification?.best_callback_text, null, "an empty string is not an answer");
});

test("parseInsightPayload: the structured insight wins over the prose Summary one", () => {
  const p = parseInsightPayload({
    results: [
      { insight_id: "summary-1", result: "The caller was not interested." },
      { insight_id: "structured-1", result: '{"outcome":"qualified","age":"61"}' },
    ],
  }, "structured-1");
  assert.equal(p.outcome, "qualified");
  assert.equal(p.qualification?.age, "61");
  assert.ok(p.summary?.includes("not interested"), "the prose is still kept as the summary");
});

test("parseInsightPayload: JSON wrapped in prose is still found", () => {
  const p = parseInsightPayload({
    results: [{ result: 'Summary of the call: {"outcome":"dnc_request","notes":"asked to be removed"} — end.' }],
  });
  assert.equal(p.method, "embedded_json");
  assert.equal(p.outcome, "dnc_request");
});

test("parseInsightPayload: an object with a blank outcome falls back to keywords", () => {
  const p = parseInsightPayload({
    results: [{ result: '{"outcome":"","age":"58","summary":"The caller asked to be taken off the list."}' }],
  });
  assert.equal(p.outcome, "dnc_request");
  assert.equal(p.method, "keywords");
  assert.equal(p.qualification?.age, "58", "the qualification data is kept either way");
});

test("parseInsightPayload: an empty payload is empty, not an error", () => {
  const p = parseInsightPayload({});
  assert.deepEqual(p, { qualification: null, summary: null, outcome: null, method: "none" });
});

// ---- outcomeFromCallFlow: 'error' is never the default -------------------

test("outcomeFromCallFlow: an answered, unclassified call is 'completed', NOT 'error'", () => {
  assert.equal(outcomeFromCallFlow({ answered: true, ourFault: false }), "completed");
});

test("outcomeFromCallFlow: 'error' means WE broke", () => {
  assert.equal(outcomeFromCallFlow({ answered: true, ourFault: true }), "error");
});

test("outcomeFromCallFlow: call-flow facts outrank silence", () => {
  assert.equal(outcomeFromCallFlow({ answered: false, ourFault: false }), "no_answer");
  assert.equal(outcomeFromCallFlow({ answered: true, ourFault: false, machineDetected: true }), "voicemail");
  assert.equal(outcomeFromCallFlow({ answered: true, ourFault: false, dncRequested: true }), "dnc_request");
  assert.equal(outcomeFromCallFlow({ answered: true, ourFault: false, transferStatus: "bridged" }), "transferred");
  assert.equal(outcomeFromCallFlow({ answered: true, ourFault: false, appointmentBooked: true }), "appointment_booked");
});

test("outcomeFromCallFlow: a failed transfer does not become 'transferred'", () => {
  assert.equal(outcomeFromCallFlow({ answered: true, ourFault: false, transferStatus: "agent_no_answer" }), "completed");
});

// ---- shouldReplaceOutcome ----------------------------------------------

test("shouldReplaceOutcome: the late insights event may correct a finalized call", () => {
  // Insights arrive ~8s AFTER call.hangup, so finalize has already written.
  assert.equal(shouldReplaceOutcome("completed", "qualified"), true);
  assert.equal(shouldReplaceOutcome("error", "qualified"), true);
  assert.equal(shouldReplaceOutcome("in_progress", "qualified"), true);
  assert.equal(shouldReplaceOutcome(null, "qualified"), true);
});

test("shouldReplaceOutcome: a terminal outcome is never downgraded", () => {
  assert.equal(shouldReplaceOutcome("dnc_request", "completed"), false);
  assert.equal(shouldReplaceOutcome("voicemail", "qualified"), false);
  assert.equal(shouldReplaceOutcome("transferred", "qualified"), false);
  assert.equal(shouldReplaceOutcome("appointment_booked", "not_interested"), false);
});

test("shouldReplaceOutcome: nothing is replaced by a non-answer", () => {
  assert.equal(shouldReplaceOutcome("completed", null), false);
  assert.equal(shouldReplaceOutcome("completed", "in_progress"), false);
});
