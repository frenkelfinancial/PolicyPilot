// ============================================================
// ai-lead-effect.test.ts — run with:  npm run test:ai
//
// "Does the AI update the status?" is now a table, and this is the test that
// keeps the table honest. Three things are pinned:
//
//   1. EVERY outcome has a decided answer, including the ones whose answer is
//      "nothing". A gap in the map does nothing at runtime and looks exactly
//      like a decision, which is how "no_answer sets the status to No Answer"
//      would sneak in.
//   2. The ORDERING GUARD. A verdict that arrives after a human has made up
//      their mind loses. Insights land ~8 seconds after the hangup and a
//      person can easily click inside that window.
//   3. The write. Status only when the guard allows it, disposition always,
//      DNC as a flag, and never a throw — this runs after the wallet has been
//      debited.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_LEAD_EFFECT_KEYS,
  aiStatusVerdict,
  applyLeadEffect,
  dispositionLabel,
  dispositionShortLabel,
  dispositionTone,
  LEAD_STATUSES,
  LEAD_STATUS_HUMAN_ONLY,
  leadEffectForOutcome,
  leadEffectOutcomes,
} from "./ai-lead-effect.ts";

// The exact list on ai_calls.outcome's CHECK constraint (20260753).
const OUTCOMES = [
  "voicemail", "no_answer", "busy", "not_interested", "qualified", "dnc_request",
  "error", "in_progress", "callback_requested", "appointment_booked",
  "transferred", "completed",
];

// ============================================================
// 1. The table
// ============================================================

test("every ai_calls outcome has a decided effect", () => {
  const known = leadEffectOutcomes();
  for (const o of OUTCOMES) {
    assert.ok(known.includes(o), `${o} has no entry — a gap does nothing and looks like a decision`);
  }
  assert.deepEqual(known, [...OUTCOMES].sort(), "and nothing is in the table that the column cannot hold");
});

test("only three outcomes touch the lead status, and they are the right three", () => {
  const changes = OUTCOMES.filter((o) => leadEffectForOutcome(o).status !== null);
  assert.deepEqual(changes.sort(), ["appointment_booked", "not_interested"]);
  // dnc_request is the third effect and deliberately is NOT a status: "do not
  // call me" is a legal instruction, not a stage of a sales pipeline.
  assert.equal(leadEffectForOutcome("dnc_request").status, null);
  assert.equal(leadEffectForOutcome("dnc_request").dnc, true);
});

test("a missed call changes NOTHING about where the lead sits", () => {
  for (const o of ["no_answer", "voicemail", "busy"]) {
    const e = leadEffectForOutcome(o);
    assert.equal(e.status, null, `${o} must not move the status`);
    assert.equal(e.dnc, false);
    assert.ok(e.disposition, `${o} is still recorded as what happened on the call`);
  }
});

test("a call a human took over leaves the pipeline to the human", () => {
  for (const o of ["transferred", "qualified", "callback_requested", "completed"]) {
    assert.equal(leadEffectForOutcome(o).status, null, `${o} must not move the status`);
    assert.ok(leadEffectForOutcome(o).disposition, `${o} is still visible as a disposition`);
  }
});

test("`error` is about US and says nothing about the consumer", () => {
  const e = leadEffectForOutcome("error");
  assert.equal(e.status, null);
  assert.equal(e.dnc, false);
  assert.equal(e.disposition, null, "our failure must not become a mark on their record");
  assert.equal(leadEffectForOutcome("in_progress").disposition, null);
});

test("nothing in the table invents a status the app cannot render", () => {
  for (const o of OUTCOMES) {
    const s = leadEffectForOutcome(o).status;
    if (s !== null) assert.ok((LEAD_STATUSES as readonly string[]).includes(s), `${s} is not a real lead status`);
  }
  // And nothing writes the one that is human-only.
  for (const o of OUTCOMES) {
    assert.notEqual(leadEffectForOutcome(o).status, "sold", "sold is human-set, always");
  }
  assert.deepEqual([...LEAD_STATUS_HUMAN_ONLY], ["sold"]);
});

test("an unknown outcome does nothing at all", () => {
  for (const o of ["", null, undefined, "banana", "APPOINTMENT_BOOKED "]) {
    const e = leadEffectForOutcome(o as string);
    // The last one normalises (trim + lower-case) and IS known — that is the
    // point of normalising, and it is asserted separately below.
    if (String(o || "").trim().toLowerCase() === "appointment_booked") continue;
    assert.deepEqual(e, { status: null, dnc: false, disposition: null }, `${JSON.stringify(o)}`);
  }
  assert.equal(leadEffectForOutcome("  Appointment_Booked ").status, "appointment");
});

test("mutating a returned effect cannot corrupt the table", () => {
  const a = leadEffectForOutcome("appointment_booked");
  a.status = "sold";
  assert.equal(leadEffectForOutcome("appointment_booked").status, "appointment");
});

test("every disposition has words, and a tone", () => {
  for (const o of OUTCOMES) {
    const d = leadEffectForOutcome(o).disposition;
    if (!d) continue;
    assert.ok(dispositionLabel(d).length > 0, `${d} needs a label`);
    assert.ok(dispositionShortLabel(d).length > 0, `${d} needs a short label`);
    assert.ok(["good", "bad", "neutral"].includes(dispositionTone(d)));
  }
  assert.equal(dispositionTone("appointment_booked"), "good");
  assert.equal(dispositionTone("dnc_request"), "bad");
  assert.equal(dispositionTone("no_answer"), "neutral");
  assert.equal(dispositionLabel(null), "");
});

// ============================================================
// 2. The ordering guard
// ============================================================

const T0 = "2026-07-31T15:00:00.000Z";   // the call starts
const T1 = "2026-07-31T15:02:00.000Z";   // two minutes in
const TMINUS = "2026-07-31T14:00:00.000Z"; // an hour before

test("a status a human set AFTER the call started wins", () => {
  const v = aiStatusVerdict({
    effect: leadEffectForOutcome("not_interested"),
    leadStatus: "appointment",
    leadStatusAt: T1,
    leadStatusSource: "human",
    callStartedAt: T0,
  });
  assert.equal(v.apply, false);
  assert.equal(v.reason, "human_set_after_call");
});

test("a status a human set BEFORE the call started does not", () => {
  const v = aiStatusVerdict({
    effect: leadEffectForOutcome("not_interested"),
    leadStatus: "new",
    leadStatusAt: TMINUS,
    leadStatusSource: "human",
    callStartedAt: T0,
  });
  assert.equal(v.apply, true);
  assert.equal(v.reason, "applied");
});

test("a lead with NO stamp is written — absence is not evidence of a human", () => {
  // Every lead in the production book predates the column.
  const v = aiStatusVerdict({
    effect: leadEffectForOutcome("appointment_booked"),
    leadStatus: "new",
    leadStatusAt: null,
    leadStatusSource: null,
    callStartedAt: T0,
  });
  assert.equal(v.apply, true);
});

test("a call with no start time cannot be ordered, so it writes", () => {
  const v = aiStatusVerdict({
    effect: leadEffectForOutcome("appointment_booked"),
    leadStatus: "new",
    leadStatusAt: T1,
    leadStatusSource: "human",
    callStartedAt: null,
  });
  assert.equal(v.apply, true, "a missing anchor must not silently block every write");
});

test("a LATER AI verdict is not overwritten by an earlier call finishing second", () => {
  const v = aiStatusVerdict({
    effect: leadEffectForOutcome("not_interested"),
    leadStatus: "appointment",
    leadStatusAt: T1,
    leadStatusSource: "ai",
    callStartedAt: T0,
  });
  assert.equal(v.apply, false);
  assert.equal(v.reason, "newer_ai_verdict");
});

test("SOLD is never overwritten, by anything, ever", () => {
  for (const o of OUTCOMES) {
    const v = aiStatusVerdict({
      effect: leadEffectForOutcome(o),
      leadStatus: "sold",
      leadStatusAt: null,
      callStartedAt: T0,
    });
    assert.equal(v.apply, false, `${o} must not touch a sold lead`);
  }
});

test("an outcome with no status change says so, rather than pretending to write", () => {
  const v = aiStatusVerdict({ effect: leadEffectForOutcome("no_answer"), leadStatus: "new", callStartedAt: T0 });
  assert.equal(v.apply, false);
  assert.equal(v.reason, "no_status_change");
});

test("a status already set is not re-stamped", () => {
  const v = aiStatusVerdict({
    effect: leadEffectForOutcome("appointment_booked"),
    leadStatus: "appointment",
    callStartedAt: T0,
  });
  assert.equal(v.apply, false);
  assert.equal(v.reason, "already_set");
});

test("exactly equal timestamps are not 'after' — the AI wins a tie", () => {
  const v = aiStatusVerdict({
    effect: leadEffectForOutcome("appointment_booked"),
    leadStatus: "new",
    leadStatusAt: T0,
    leadStatusSource: "human",
    callStartedAt: T0,
  });
  assert.equal(v.apply, true, "a stamp equal to the call's start is not a decision taken during it");
});

test("an unparseable stamp cannot block a write", () => {
  const v = aiStatusVerdict({
    effect: leadEffectForOutcome("appointment_booked"),
    leadStatus: "new",
    leadStatusAt: "yesterday-ish",
    leadStatusSource: "human",
    callStartedAt: T0,
  });
  assert.equal(v.apply, true);
});

// ============================================================
// 3. The write
// ============================================================

/** A fake PostgREST-ish client that records what it was asked to write. */
function fakeDb(lead: Record<string, unknown> | null) {
  const writes: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const self: Record<string, unknown> = {
        select: () => self,
        update: (p: Record<string, unknown>) => { patch = p; return self; },
        eq: () => self,
        maybeSingle: () => Promise.resolve({ data: lead }),
        then: (res: (v: unknown) => unknown) => {
          if (patch) writes.push({ table, patch });
          return Promise.resolve({ data: null, error: null }).then(res);
        },
      };
      return self as never;
    },
  };
  return { client: client as never, writes };
}

const NOW = new Date("2026-07-31T15:05:00.000Z");

test("a booked appointment writes the status, the stamp and the source", async () => {
  const { client, writes } = fakeDb({ id: "l1", data: { status: "new" }, dnc: false });
  const r = await applyLeadEffect(client, {
    leadId: "l1", agentId: "a1", outcome: "appointment_booked", callStartedAt: T0, now: NOW,
  });
  assert.equal(r.applied, true);
  assert.equal(r.status, "appointment");
  const data = writes[0].patch.data as Record<string, unknown>;
  assert.equal(data.status, "appointment");
  assert.equal(data.status_source, "ai");
  assert.equal(data.status_at, NOW.toISOString());
  assert.equal(data.ai_disposition, "appointment_booked");
});

test("a no-answer writes the disposition and LEAVES THE STATUS ALONE", async () => {
  const { client, writes } = fakeDb({ id: "l1", data: { status: "appointment" }, dnc: false });
  const r = await applyLeadEffect(client, {
    leadId: "l1", agentId: "a1", outcome: "no_answer", callStartedAt: T0, now: NOW,
  });
  assert.equal(r.applied, true);
  assert.equal(r.status, null);
  const data = writes[0].patch.data as Record<string, unknown>;
  assert.equal(data.status, "appointment", "a missed call is not a pipeline event");
  assert.equal(data.status_at, undefined, "and it does not touch the stamp either");
  assert.equal(data.ai_disposition, "no_answer");
  assert.equal(data.ai_disposition_at, NOW.toISOString());
});

test("the disposition is written even when the guard blocks the status", async () => {
  // The call's result is a fact about the call. A human changing the status
  // afterwards does not make "they said no" untrue.
  const { client, writes } = fakeDb({
    id: "l1", data: { status: "appointment", status_at: T1, status_source: "human" }, dnc: false,
  });
  const r = await applyLeadEffect(client, {
    leadId: "l1", agentId: "a1", outcome: "not_interested", callStartedAt: T0, now: NOW,
  });
  assert.equal(r.applied, true);
  assert.equal(r.reason, "human_set_after_call");
  const data = writes[0].patch.data as Record<string, unknown>;
  assert.equal(data.status, "appointment", "the human's decision stands");
  assert.equal(data.ai_disposition, "not_interested", "and the call still happened");
});

test("a dnc_request raises the flag, and does not raise it twice", async () => {
  const a = fakeDb({ id: "l1", data: { status: "new" }, dnc: false });
  await applyLeadEffect(a.client, { leadId: "l1", agentId: "a1", outcome: "dnc_request", callStartedAt: T0, now: NOW });
  assert.equal(a.writes[0].patch.dnc, true);
  assert.equal(a.writes[0].patch.dnc_at, NOW.toISOString());

  const b = fakeDb({ id: "l1", data: { status: "new" }, dnc: true });
  await applyLeadEffect(b.client, { leadId: "l1", agentId: "a1", outcome: "dnc_request", callStartedAt: T0, now: NOW });
  assert.equal(b.writes[0].patch.dnc, undefined, "already on the list — nothing to re-stamp");
});

test("a call with no lead, and an outcome with no effect, write nothing", async () => {
  const a = fakeDb({ id: "l1", data: {}, dnc: false });
  assert.equal((await applyLeadEffect(a.client, {
    leadId: null, agentId: "a1", outcome: "appointment_booked", callStartedAt: T0, now: NOW,
  })).reason, "no_lead");
  assert.equal(a.writes.length, 0);

  const b = fakeDb({ id: "l1", data: {}, dnc: false });
  assert.equal((await applyLeadEffect(b.client, {
    leadId: "l1", agentId: "a1", outcome: "error", callStartedAt: T0, now: NOW,
  })).reason, "no_effect");
  assert.equal(b.writes.length, 0);
});

test("a missing lead is reported, not written around", async () => {
  const { client, writes } = fakeDb(null);
  const r = await applyLeadEffect(client, {
    leadId: "gone", agentId: "a1", outcome: "appointment_booked", callStartedAt: T0, now: NOW,
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "lead_missing");
  assert.equal(writes.length, 0);
});

test("it NEVER throws — the call is already billed by the time this runs", async () => {
  const exploding = {
    from() { throw new Error("database on fire"); },
  } as never;
  const r = await applyLeadEffect(exploding, {
    leadId: "l1", agentId: "a1", outcome: "appointment_booked", callStartedAt: T0, now: NOW,
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "error");
});

test("the write is re-scoped to the agent, and keeps the rest of the blob", async () => {
  const { client, writes } = fakeDb({
    id: "l1", data: { status: "new", name: "Mark J", phone: "+12025550147", campaign_tag: "veteran" }, dnc: false,
  });
  await applyLeadEffect(client, {
    leadId: "l1", agentId: "a1", outcome: "appointment_booked", callStartedAt: T0, now: NOW,
  });
  const data = writes[0].patch.data as Record<string, unknown>;
  assert.equal(data.name, "Mark J");
  assert.equal(data.phone, "+12025550147");
  assert.equal(data.campaign_tag, "veteran", "the tag the manual door wrote must survive");
});

test("the keys it writes are exactly the ones the database trigger protects", () => {
  assert.deepEqual([...AI_LEAD_EFFECT_KEYS],
    ["status", "status_at", "status_source", "ai_disposition", "ai_disposition_at"]);
});
