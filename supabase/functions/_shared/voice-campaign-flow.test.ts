// ============================================================
// voice-campaign-flow.test.ts — run with:  npm run test:ai
//
// Three things this proves that voice-campaign-core.test.ts cannot:
//
//   1. THE CLAIM IS ATOMIC. Two ticks racing for one due enrollment: exactly
//      one dials. Driven through vcClaimEnrollment() against a fake client
//      that models Postgres' post-lock WHERE re-check.
//   2. A FINISHED CALL ADVANCES ITS ENROLLMENT, and releases the claim as it
//      does — the write ai-call-webhook's finalize block makes.
//   3. THE TICK AND ai-call-start SAY WHAT THEY ARE SUPPOSED TO. Source-text
//      assertions on the parts that live inside serve() and cannot be
//      imported — the same arrangement as ai-inbound-webhook.test.ts.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { vcClaimEnrollment } from "./voice-campaign-claim.ts";
import { recordCampaignCallResult } from "./voice-campaign-result.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..");
const TICK = readFileSync(join(FUNCS, "voice-campaign-tick/index.ts"), "utf8");
const START = readFileSync(join(FUNCS, "ai-call-start/index.ts"), "utf8");
const MANAGE = readFileSync(join(FUNCS, "voice-campaign-manage/index.ts"), "utf8");
const WEBHOOK = readFileSync(join(FUNCS, "ai-call-webhook/index.ts"), "utf8");
const MIG = readFileSync(join(FUNCS, "../migrations/20260802b_voice_campaigns.sql"), "utf8");

const NOW = "2026-07-30T15:00:00.000Z";
const STALE = "2026-07-30T14:50:00.000Z";

// ============================================================
// A fake client that models the ONE semantic this test is about: an UPDATE
// with a WHERE re-evaluates that WHERE against the row as it stands at the
// moment the update runs, not as it stood when the caller read it.
// ============================================================
function makeStore(tables: Record<string, Record<string, unknown>[]>) {
  const store: Record<string, Record<string, unknown>[]> = { ...tables };
  const writes: Array<{ table: string; patch: Record<string, unknown> }> = [];

  const builder = (table: string) => {
    store[table] = store[table] || [];
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    let rowsForUpdate: Record<string, unknown>[] | null = null;

    const applyUpdate = () => {
      if (!patch) return [];
      const hit = store[table].filter((r) => filters.every((f) => f(r)));
      for (const r of hit) Object.assign(r, patch);
      if (hit.length) writes.push({ table, patch });
      rowsForUpdate = hit;
      return hit;
    };

    const api: Record<string, unknown> = {
      select() { return api; },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return api; },
      lte(col: string, v: unknown) {
        filters.push((r) => r[col] != null && String(r[col]) <= String(v));
        return api;
      },
      or(expr: string) {
        // `claimed_at.is.null,claimed_at.lt.<iso>` — the only form used here.
        const parts = String(expr).split(",");
        filters.push((r) => parts.some((p) => {
          const [col, op, val] = p.split(".");
          if (op === "is" && val === "null") return r[col] == null;
          if (op === "lt") return r[col] != null && String(r[col]) < String(p.slice(p.indexOf(".lt.") + 4));
          return false;
        }));
        return api;
      },
      order() { return api; },
      limit() { return api; },
      update(p: Record<string, unknown>) { patch = p; return api; },
      maybeSingle() {
        if (patch) { const hit = applyUpdate(); return Promise.resolve({ data: hit[0] ?? null, error: null }); }
        const hit = store[table].filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: hit[0] ?? null, error: null });
      },
      then(res: (v: { data: unknown; error: null }) => unknown) {
        if (patch) { const hit = applyUpdate(); return Promise.resolve(res({ data: hit, error: null })); }
        const hit = store[table].filter((r) => filters.every((f) => f(r)));
        return Promise.resolve(res({ data: hit, error: null }));
      },
      _rowsForUpdate: () => rowsForUpdate,
    };
    return api;
  };

  return { sb: { from: builder } as never, store, writes };
}

const dueEnrollment = (over: Record<string, unknown> = {}) => ({
  id: "enr-1", campaign_id: "camp-1", agent_id: "agent-1", lead_id: "lead-1",
  status: "active", current_step_position: 1, step_attempts: 0, calls_placed: 0,
  answers: 0, appointments: 0,
  next_action_at: "2026-07-30T14:59:00.000Z", claimed_at: null,
  ...over,
});

// ============================================================
// 1. The claim
// ============================================================

test("two concurrent ticks claim the same enrollment — exactly one wins", async () => {
  const { sb, store } = makeStore({ voice_campaign_enrollments: [dueEnrollment()] });

  const [a, b] = await Promise.all([
    vcClaimEnrollment(sb, "enr-1", NOW, STALE),
    vcClaimEnrollment(sb, "enr-1", NOW, STALE),
  ]);

  const winners = [a, b].filter(Boolean);
  assert.equal(winners.length, 1, "a tick that re-fires a minute later must not double-call anyone");
  assert.equal(winners[0]!.id, "enr-1");
  assert.equal(store.voice_campaign_enrollments[0].claimed_at, NOW);
});

test("a third tick a moment later still gets nothing", async () => {
  const { sb } = makeStore({ voice_campaign_enrollments: [dueEnrollment()] });
  assert.ok(await vcClaimEnrollment(sb, "enr-1", NOW, STALE));
  assert.equal(await vcClaimEnrollment(sb, "enr-1", NOW, STALE), null);
  assert.equal(await vcClaimEnrollment(sb, "enr-1", NOW, STALE), null);
});

test("a claim older than the lease may be taken — a dead tick strands nobody", async () => {
  const { sb } = makeStore({
    voice_campaign_enrollments: [dueEnrollment({ claimed_at: "2026-07-30T14:30:00.000Z" })],
  });
  const claimed = await vcClaimEnrollment(sb, "enr-1", NOW, STALE);
  assert.ok(claimed, "a 30-minute-old claim is a tick that died, not a call in progress");
});

test("a claim inside the lease is left alone", async () => {
  const { sb } = makeStore({
    voice_campaign_enrollments: [dueEnrollment({ claimed_at: "2026-07-30T14:59:30.000Z" })],
  });
  assert.equal(await vcClaimEnrollment(sb, "enr-1", NOW, STALE), null, "that call is still ringing");
});

test("an enrollment that is not due, or not active, is never claimed", async () => {
  const notDue = makeStore({
    voice_campaign_enrollments: [dueEnrollment({ next_action_at: "2026-07-30T16:00:00.000Z" })],
  });
  assert.equal(await vcClaimEnrollment(notDue.sb, "enr-1", NOW, STALE), null);

  const stopped = makeStore({ voice_campaign_enrollments: [dueEnrollment({ status: "stopped" })] });
  assert.equal(await vcClaimEnrollment(stopped.sb, "enr-1", NOW, STALE), null);
});

// ============================================================
// 2. A finished call advances its enrollment
// ============================================================

const campaignRow = (over: Record<string, unknown> = {}) => ({
  id: "camp-1", name: "Veteran Lead", active: true,
  stop_on_appointment_booked: true, stop_on_sold: true,
  stop_on_answered: false, stop_answer_talk_secs: 15, ...over,
});

const stepRows = [
  { id: "s1", campaign_id: "camp-1", position: 1, step_type: "call", wait_value: 1, wait_unit: "minutes", drip_rate: null },
  { id: "s2", campaign_id: "camp-1", position: 2, step_type: "call", wait_value: 2, wait_unit: "hours", drip_rate: null },
];

function flowStore(over: { enrollment?: Record<string, unknown>; campaign?: Record<string, unknown>; lead?: Record<string, unknown> } = {}) {
  return makeStore({
    voice_campaign_enrollments: [dueEnrollment({ claimed_at: NOW, ...over.enrollment })],
    voice_campaigns: [campaignRow(over.campaign)],
    voice_campaign_steps: stepRows.map((s) => ({ ...s })),
    leads: [{ id: "lead-1", data: { status: "called" }, dnc: false, ...over.lead }],
  });
}

const callRow = (over: Record<string, unknown> = {}) => ({
  id: "call-1", agent_id: "agent-1", lead_id: "lead-1", enrollment_id: "enr-1",
  outcome: "no_answer", answered_at: null, ended_at: NOW, appointment_id: null,
  ...over,
}) as never;

test("a call nobody's campaign asked for is a no-op", async () => {
  const { sb, writes } = flowStore();
  const r = await recordCampaignCallResult(sb, callRow({ enrollment_id: null }), new Date(NOW));
  assert.equal(r.applied, false);
  assert.equal(r.reason, "not_a_campaign_call");
  assert.equal(writes.length, 0, "most calls in this product are manual — they must cost nothing here");
});

test("a no-answer schedules the next step and releases the claim", async () => {
  const { sb, store } = flowStore();
  const r = await recordCampaignCallResult(sb, callRow(), new Date(NOW));
  assert.equal(r.applied, true);
  assert.equal(r.decision, "next_step");
  const row = store.voice_campaign_enrollments[0];
  assert.equal(row.status, "active");
  assert.equal(row.current_step_position, 2);
  assert.equal(row.next_action_at, "2026-07-30T17:00:00.000Z");
  assert.equal(row.claimed_at, null, "the claim must be released or the tick never picks it up again");
  assert.equal(row.answers, 0);
});

test("an answered call counts an answer", async () => {
  const { sb, store } = flowStore();
  await recordCampaignCallResult(sb, callRow({
    outcome: "completed", answered_at: "2026-07-30T14:59:00.000Z",
  }), new Date(NOW));
  assert.equal(store.voice_campaign_enrollments[0].answers, 1);
});

test("a booked appointment stops the enrollment and counts", async () => {
  const { sb, store } = flowStore();
  const r = await recordCampaignCallResult(sb, callRow({
    outcome: "qualified", answered_at: "2026-07-30T14:57:00.000Z", appointment_id: "appt-1",
  }), new Date(NOW));
  assert.equal(r.status, "stopped");
  assert.equal(r.stop_reason, "appointment_booked");
  const row = store.voice_campaign_enrollments[0];
  assert.equal(row.status, "stopped");
  assert.equal(row.appointments, 1);
  assert.equal(row.next_action_at, null);
  assert.equal(row.completed_at, NOW);
});

test("stop_on_answered fires off the REAL timestamps on the call row", async () => {
  const { sb, store } = flowStore({ campaign: { stop_on_answered: true, stop_answer_talk_secs: 15 } });
  await recordCampaignCallResult(sb, callRow({
    outcome: "completed",
    answered_at: "2026-07-30T14:59:40.000Z",   // 20 seconds of talking
  }), new Date(NOW));
  assert.equal(store.voice_campaign_enrollments[0].status, "stopped");
  assert.equal(store.voice_campaign_enrollments[0].stop_reason, "answered");
});

test("a 5-second pickup with stop_on_answered on does NOT stop it", async () => {
  const { sb, store } = flowStore({ campaign: { stop_on_answered: true, stop_answer_talk_secs: 15 } });
  await recordCampaignCallResult(sb, callRow({
    outcome: "completed",
    answered_at: "2026-07-30T14:59:55.000Z",   // 5 seconds
  }), new Date(NOW));
  assert.equal(store.voice_campaign_enrollments[0].status, "active");
});

test("a lead who went DNC is stopped whatever the campaign's flags say", async () => {
  const { sb, store } = flowStore({
    campaign: { stop_on_appointment_booked: false, stop_on_sold: false, stop_on_answered: false },
    lead: { dnc: true },
  });
  await recordCampaignCallResult(sb, callRow(), new Date(NOW));
  assert.equal(store.voice_campaign_enrollments[0].stop_reason, "dnc");
});

test("a lead marked sold stops when stop_on_sold is on", async () => {
  const { sb, store } = flowStore({ lead: { data: { status: "sold" } } });
  await recordCampaignCallResult(sb, callRow(), new Date(NOW));
  assert.equal(store.voice_campaign_enrollments[0].stop_reason, "sold");
});

test("an enrollment already stopped is not resurrected by a late call", async () => {
  const { sb, store } = flowStore({ enrollment: { status: "stopped", stop_reason: "manual" } });
  const r = await recordCampaignCallResult(sb, callRow(), new Date(NOW));
  assert.equal(r.applied, false);
  assert.equal(r.reason, "enrollment_stopped");
  assert.equal(store.voice_campaign_enrollments[0].status, "stopped");
  assert.equal(store.voice_campaign_enrollments[0].stop_reason, "manual", "the hand on the Unenroll button wins");
});

test("the last step completes the enrollment", async () => {
  const { sb, store } = flowStore({ enrollment: { current_step_position: 2 } });
  const r = await recordCampaignCallResult(sb, callRow(), new Date(NOW));
  assert.equal(r.status, "completed");
  assert.equal(store.voice_campaign_enrollments[0].next_action_at, null);
});

test("a bookkeeping failure never throws — the call is already billed", async () => {
  const exploding = { from() { throw new Error("db is down"); } } as never;
  const r = await recordCampaignCallResult(exploding, callRow(), new Date(NOW));
  assert.equal(r.applied, false);
  assert.equal(r.reason, "error", "a 500 here would make Telnyx replay a finalized, debited call");
});

// ============================================================
// 3. What the code must say
// ============================================================

test("the tick places every call through ai-call-start and nowhere else", () => {
  assert.ok(TICK.includes("/functions/v1/ai-call-start"), "the tick must call the gate chain");
  assert.ok(
    !/api\.telnyx\.com\/v2\/calls/.test(TICK),
    "the tick must never dial Telnyx directly — that would be a second, ungated call path",
  );
});

test("the tick reimplements no CALL-TIME gate", () => {
  // The tick legitimately reads tcpa_consent / dnc / suppression_list, because
  // ENROLLING somebody who can never be dialed fills a screen with rows that
  // are a promise the product cannot keep. What it must never do is decide
  // whether a CALL may be placed: the wallet floor, the daily cap and the pace
  // verdict have no enrollment analogue, and a copy of any of them here is a
  // second opinion the server would overrule.
  for (const forbidden of [
    "min_ai_call_start_mills",
    "balance_mills",
    "ai_daily_call_cap",
    "evaluateDailyPace",
    "wallet_accounts",
  ]) {
    assert.ok(
      !TICK.includes(forbidden),
      `voice-campaign-tick must not read ${forbidden} — ai-call-start owns that gate`,
    );
  }
  // Quiet hours appear exactly once, and only to ask WHEN the window reopens
  // after the server has already refused — never to pre-empt the refusal.
  assert.ok(TICK.includes("computeQuietUntil"));
  assert.ok(
    TICK.indexOf("computeQuietUntil(claimed.lead_id)") > TICK.indexOf("gate_rejected") - 4000,
    "the quiet-hours question is asked only in response to a rejection",
  );
});

test("the tick counts only OUTBOUND calls for the caller-ID rotation", () => {
  assert.ok(
    /\.eq\("direction",\s*"outbound"\)/.test(TICK),
    "inbound is never counted and never blocked — same rule as the meter",
  );
});

test("ai-call-start's internal mode requires the service key, never a flag in the body", () => {
  assert.ok(
    START.includes("authHeader === `Bearer ${SERVICE_KEY}`"),
    "the internal caller is identified by the service role key and nothing else",
  );
  // The agent id may only be read inside that branch.
  const internalBlock = START.slice(START.indexOf("if (isInternal) {"), START.indexOf("const leadId"));
  assert.ok(internalBlock.includes("body.agent_id"), "agent_id is read in the internal branch");
  const outside = START.replace(internalBlock, "");
  assert.ok(
    !outside.includes("body.agent_id"),
    "no path other than the service-key branch may take an agent id from a request body",
  );
});

test("dry_run and every campaign field are internal-only", () => {
  for (const field of ["dry_run", "enrollment_id", "campaign_id", "campaign_step", "campaign_name"]) {
    const re = new RegExp(`isInternal && [^;]*body\\.${field}`);
    assert.ok(re.test(START), `body.${field} must be gated on isInternal`);
  }
});

test("the gate order in ai-call-start is unchanged", () => {
  const order = ["Gate 1:", "Gate 2:", "Gate 3:", "Gate 4:", "Gate 5:", "Gate 6:"];
  let at = -1;
  for (const g of order) {
    const i = START.indexOf(g);
    assert.ok(i > at, `${g} must come after the previous gate`);
    at = i;
  }
  // The dry run stops AFTER all six.
  assert.ok(
    START.indexOf("Gate 6:") < START.indexOf("if (dryRun)"),
    "a dry run must run every gate before it stops",
  );
  assert.ok(
    START.indexOf("if (dryRun)") < START.indexOf("api.telnyx.com/v2/calls"),
    "and it must stop before the dial",
  );
});

test("a requested caller ID must belong to the agent", () => {
  assert.ok(
    START.includes("callerIdOwned"),
    "a rotation bug must not be able to dial from another agent's number",
  );
});

test("the webhook advances the enrollment after the outcome is written", () => {
  const iOutcome = WEBHOOK.indexOf('status:         "completed"');
  const iCampaign = WEBHOOK.indexOf("recordCampaignCallResult(");
  assert.ok(iOutcome > 0 && iCampaign > iOutcome, "vcEvaluateStop reads the final outcome — it must already be stored");
});

test("nothing writes voice_campaign_enrollments from the browser", () => {
  // Every policy the migration declares on this table, in order. One, SELECT.
  // An enrollment is a standing instruction to phone a consumer; a browser
  // that could write one could enroll a lead with no consent.
  const enrollPolicies = MIG.match(/on public\.voice_campaign_enrollments\s+for \w+/g) || [];
  assert.deepEqual(
    enrollPolicies.map((s) => s.replace(/\s+/g, " ")),
    ["on public.voice_campaign_enrollments for select"],
  );
});

test("the manage endpoint takes the agent from the JWT and re-scopes every read", () => {
  assert.ok(MANAGE.includes("sbAuth.auth.getUser()"));
  assert.ok(!/body\.agent_id/.test(MANAGE), "there is no agent id in this request body");
  // Both mutating actions re-verify ownership.
  assert.ok(MANAGE.includes('.eq("agent_id", user.id)'));
});

test("re-evaluate refuses a rule that has not passed the tag check", () => {
  assert.ok(
    MANAGE.indexOf("vcValidateTriggerGroups") < MANAGE.indexOf("for (const lead of book"),
    "an unbounded rule must be refused BEFORE it is run over an entire book",
  );
});

test("the migration turns inbound on by default and keeps the dialer host out", () => {
  assert.ok(/alter column ai_inbound_enabled set default true/.test(MIG));
  assert.ok(MIG.includes("+12625099123"), "the power-dialer host is excluded by number");
  assert.ok(
    /set ai_inbound_enabled = false[\s\S]{0,120}\+12625099123/.test(MIG),
    "and forced off if it ever lands in this table",
  );
});
