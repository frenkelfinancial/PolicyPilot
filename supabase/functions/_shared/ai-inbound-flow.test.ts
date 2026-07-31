// ============================================================
// ai-inbound-flow.test.ts — run with:  npm run test:ai
//
// Drives startInboundIfEnabled() and cancelInboundIfAbandoned() end to end
// against a fake Supabase client and a fake fetch, and asserts the exact
// Telnyx requests each branch WOULD issue.
//
// This exists because the three inbound branches are otherwise only provable
// by making a real phone ring. The one thing it cannot prove is that Telnyx
// behaves the way its OpenAPI spec says (in particular that `answer` honours a
// `webhook_url` override) — that is listed under PENDING LIVE VERIFICATION and
// is the whole reason this file stops where it does.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { cancelInboundIfAbandoned, startInboundIfEnabled } from "./ai-inbound.ts";

const AI_NUM = "+12029981783";     // the opted-in number
const DIALER = "+12625099123";     // power-dialer host
const CALLER = "+19204169244";     // a known lead's cell
const AGENT  = "agent-uuid-1";
const XFER   = "+19204227733";

// ---- a fake Supabase client, just chainable enough ----------------------

interface FakeTables {
  phone_numbers?: Record<string, unknown>[];
  agents?: Record<string, unknown>[];
  leads?: Record<string, unknown>[];
  ai_calls?: Record<string, unknown>[];
}

function makeSb(tables: FakeTables) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const store: Record<string, Record<string, unknown>[]> = {
    phone_numbers: tables.phone_numbers ?? [],
    agents:        tables.agents ?? [],
    leads:         tables.leads ?? [],
    ai_calls:      tables.ai_calls ?? [],
    ai_call_events: [],
  };

  const builder = (table: string) => {
    let rows = [...(store[table] || [])];
    let pending: { op: string; payload: unknown } | null = null;

    const api: Record<string, unknown> = {
      select() { return api; },
      eq(col: string, val: unknown) { rows = rows.filter((r) => r[col] === val); return api; },
      is(col: string, val: unknown) { rows = rows.filter((r) => (r[col] ?? null) === val); return api; },
      like(col: string, pat: string) {
        const needle = String(pat).replace(/%/g, "");
        rows = rows.filter((r) => {
          // support the "data->>phone" form the flow uses
          const v = col.includes("->>")
            ? ((r.data as Record<string, unknown>)?.[col.split("->>")[1]] as string)
            : (r[col] as string);
          return String(v ?? "").includes(needle);
        });
        return api;
      },
      order() { return api; },
      limit() { return api; },
      maybeSingle() {
        if (pending) { const p = pending; pending = null; return Promise.resolve({ data: p.payload, error: null }); }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        if (pending) { const p = pending; pending = null; return Promise.resolve({ data: p.payload, error: null }); }
        return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "no rows" } });
      },
      insert(payload: Record<string, unknown>) {
        const row = { id: `${table}-new-id`, ...payload };
        store[table].push(row);
        writes.push({ table, op: "insert", payload });
        pending = { op: "insert", payload: row };
        return api;
      },
      upsert(payload: Record<string, unknown>) {
        const row = { id: `${table}-new-id`, ...payload };
        store[table].push(row);
        writes.push({ table, op: "upsert", payload });
        pending = { op: "upsert", payload: row };
        return api;
      },
      update(payload: Record<string, unknown>) {
        writes.push({ table, op: "update", payload });
        pending = { op: "update", payload: [{ id: "updated" }] };
        return api;
      },
      then(res: (v: { data: unknown; error: null }) => unknown) {
        // Awaiting a chain directly, with no .single()/.maybeSingle(). Two very
        // different cases share this path: a write (return what was written)
        // and a plain multi-row SELECT (return the filtered rows). Returning
        // `pending` for both is what made every flow test fail on the first
        // run — the phone_numbers lookup came back null and the guard then
        // correctly refused a call it should have claimed.
        const p = pending; pending = null;
        return Promise.resolve(res({ data: p ? p.payload : rows, error: null }));
      },
    };
    return api;
  };

  return { sb: { from: builder } as never, writes, store };
}

function makeFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = ((url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return Promise.resolve({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 422),
      json: () => Promise.resolve(r.body ?? {}),
      text: () => Promise.resolve(JSON.stringify(r.body ?? {})),
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: AGENT, display_name: "Jace Frenkel", agency_name: "Frenkel Financial",
  ai_agent_name: "Ashley", ai_voice: "Telnyx.Ultra.x", ai_dialer_enabled: true,
  ai_availability: "busy", transfer_number: XFER, ...over,
});

const numberRow = (over: Record<string, unknown> = {}) => ({
  id: "pn-1", agent_id: AGENT, e164: AI_NUM, status: "active", ai_inbound_enabled: true, ...over,
});

const deps = (sb: never, fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({
  sb, fetchImpl,
  telnyxHeaders: { Authorization: "Bearer x", "Content-Type": "application/json" },
  supabaseUrl: "https://proj.supabase.co",
  connectionId: "2983088288312592018",
  dialerNumber: DIALER,
  eventType: "call.initiated",
  direction: "incoming",
  to: AI_NUM,
  from: CALLER,
  callControlId: "v3:inbound-ccid",
  ...over,
});

const decodeState = (b64: string) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

// ==========================================================================
// BRANCH 1 — Busy: the AI answers immediately, and NO phone is dialed
// ==========================================================================

test("BUSY: answers the caller itself and never dials the agent", async () => {
  const { sb } = makeSb({
    phone_numbers: [numberRow()],
    agents: [agentRow({ ai_availability: "busy" })],
    leads: [{ id: "lead-1", agent_id: AGENT, data: { name: "Mark Johnson", phone: CALLER, coverage_wanted: "final expense" } }],
  });
  const { impl, calls } = makeFetch([{ ok: true }]);

  assert.equal(await startInboundIfEnabled(deps(sb, impl)), true, "the flow must claim the call");

  assert.equal(calls.length, 1, "exactly one Telnyx request — the answer");
  assert.match(calls[0].url, /\/calls\/v3:inbound-ccid\/actions\/answer$/);
  assert.ok(!calls.some((c) => c.url.endsWith("/v2/calls")), "NO agent leg may be dialed when busy");

  const st = decodeState(calls[0].body.client_state as string);
  assert.equal(st.role, "ai_call", "answering as 'ai_call' is what starts the assistant");
  assert.equal(st.vars.inbound, "1");
  assert.equal(st.vars.known, "1", "a matched lead is a known caller");
  assert.equal(st.vars.lead_first, "Mark");
  assert.equal(calls[0].body.webhook_url, "https://proj.supabase.co/functions/v1/ai-call-webhook",
    "without the override every later event goes to the wrong function");
});

test("AVAILABLE but no transfer number: treated exactly like busy", async () => {
  const { sb } = makeSb({
    phone_numbers: [numberRow()],
    agents: [agentRow({ ai_availability: "available", transfer_number: null })],
    leads: [],
  });
  const { impl, calls } = makeFetch([{ ok: true }]);

  assert.equal(await startInboundIfEnabled(deps(sb, impl)), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /actions\/answer$/, "an agent with nowhere to ring must not stall the caller");
});

// ==========================================================================
// BRANCH 2 — Available: ring the agent FIRST, do not answer the caller
// ==========================================================================

test("AVAILABLE: dials the agent and leaves the caller on real ringback", async () => {
  const { sb } = makeSb({
    phone_numbers: [numberRow()],
    agents: [agentRow({ ai_availability: "available" })],
    leads: [{ id: "lead-1", agent_id: AGENT, data: { name: "Mark Johnson", phone: CALLER, coverage_wanted: "final expense" } }],
  });
  const { impl, calls } = makeFetch([{ ok: true, body: { data: { call_control_id: "v3:agent-ccid" } } }]);

  assert.equal(await startInboundIfEnabled(deps(sb, impl)), true);

  assert.equal(calls.length, 1, "exactly one Telnyx request — the agent dial");
  assert.equal(calls[0].url, "https://api.telnyx.com/v2/calls");
  assert.ok(!calls.some((c) => /actions\/answer/.test(c.url)),
    "THE CALLER'S LEG MUST NOT BE ANSWERED — answering starts billing and replaces ringback with silence");

  const b = calls[0].body;
  assert.equal(b.to, XFER);
  assert.equal(b.from, AI_NUM, "caller ID should be the number they dialed");
  assert.equal(b.answering_machine_detection, "premium");
  assert.equal(b.timeout_secs, 15, "the ring must end before the caller gives up");
  assert.equal(b.webhook_url, "https://proj.supabase.co/functions/v1/ai-call-webhook");

  const st = decodeState(b.client_state as string);
  assert.equal(st.role, "inbound_agent_leg");
  assert.equal(st.lead_ccid, "v3:inbound-ccid", "the takeover needs the caller's leg id");
  assert.equal(st.whisper, "Incoming call from Mark Johnson, about final expense. Press 1 to answer.");
  assert.ok(!/hot lead/i.test(st.whisper), "nobody has spoken to this caller yet");
});

test("AVAILABLE: a rejected from_display_name drops it and dials anyway", async () => {
  // The exact failure that killed the outbound warm transfer: a cosmetic field
  // 422'd the whole dial. Here the ladder must fall through to a body without
  // it rather than dropping the caller.
  const { sb } = makeSb({
    phone_numbers: [numberRow()],
    agents: [agentRow({ ai_availability: "available" })],
    leads: [{ id: "lead-1", agent_id: AGENT, data: { name: "AI Test (my cell)", phone: CALLER } }],
  });
  const { impl, calls } = makeFetch([
    { ok: false, status: 422, body: { errors: [{ source: { pointer: "/from_display_name" } }] } },
    { ok: true, body: { data: { call_control_id: "v3:agent-ccid" } } },
  ]);

  assert.equal(await startInboundIfEnabled(deps(sb, impl)), true);
  assert.equal(calls.length, 2, "it must retry");
  assert.ok("from_display_name" in calls[0].body);
  assert.ok(!("from_display_name" in calls[1].body), "the retry drops the decoration");
  assert.equal(calls[1].body.to, XFER);
});

test("AVAILABLE: if the agent cannot be dialed at all, the AI answers", async () => {
  const { sb } = makeSb({
    phone_numbers: [numberRow()],
    agents: [agentRow({ ai_availability: "available" })],
    leads: [],
  });
  const { impl, calls } = makeFetch([
    { ok: false, status: 500 }, { ok: false, status: 500 }, { ok: true },
  ]);

  assert.equal(await startInboundIfEnabled(deps(sb, impl)), true);
  const answered = calls.find((c) => /actions\/answer$/.test(c.url));
  assert.ok(answered, "a caller must never be punished for a failed agent dial");
  assert.equal(decodeState(answered!.body.client_state as string).role, "ai_call");
});

// ==========================================================================
// BRANCH 3 — the guard: everything it must refuse to touch
// ==========================================================================

test("GUARD: the power-dialer host number is never claimed, and nothing is called", async () => {
  const { sb, writes } = makeSb({ phone_numbers: [numberRow({ e164: DIALER })], agents: [agentRow()] });
  const { impl, calls } = makeFetch([{ ok: true }]);
  assert.equal(await startInboundIfEnabled(deps(sb, impl, { to: DIALER })), false);
  assert.equal(calls.length, 0, "no Telnyx request at all");
  assert.equal(writes.length, 0, "and no rows written");
});

test("GUARD: a number that has not opted in is left to ring out", async () => {
  const { sb, writes } = makeSb({
    phone_numbers: [numberRow({ ai_inbound_enabled: false })], agents: [agentRow()],
  });
  const { impl, calls } = makeFetch([{ ok: true }]);
  assert.equal(await startInboundIfEnabled(deps(sb, impl)), false);
  assert.equal(calls.length, 0);
  assert.equal(writes.length, 0);
});

test("GUARD: the per-agent AI kill switch still applies to inbound", async () => {
  const { sb } = makeSb({
    phone_numbers: [numberRow()],
    agents: [agentRow({ ai_dialer_enabled: false, ai_availability: "available" })],
  });
  const { impl, calls } = makeFetch([{ ok: true }]);
  assert.equal(await startInboundIfEnabled(deps(sb, impl)), false,
    "an agent who turned the AI off must not have it answer their phone");
  assert.equal(calls.length, 0);
});

test("GUARD: an outbound leg can never enter the inbound flow", async () => {
  const { sb } = makeSb({ phone_numbers: [numberRow()], agents: [agentRow()] });
  const { impl, calls } = makeFetch([{ ok: true }]);
  for (const direction of ["outgoing", "outbound"]) {
    assert.equal(await startInboundIfEnabled(deps(sb, impl, { direction })), false, direction);
  }
  assert.equal(calls.length, 0);
});

// ==========================================================================
// Unknown callers become leads
// ==========================================================================

test("an unknown caller is written to the book before anyone answers", async () => {
  const { sb, writes } = makeSb({
    phone_numbers: [numberRow()],
    agents: [agentRow({ ai_availability: "busy" })],
    leads: [],
  });
  const { impl, calls } = makeFetch([{ ok: true }]);
  await startInboundIfEnabled(deps(sb, impl));

  const leadWrite = writes.find((w) => w.table === "leads");
  assert.ok(leadWrite, "a caller nobody has met is still a lead");
  const p = leadWrite!.payload as Record<string, unknown>;
  assert.equal(p.client_id, "inbound-9204169244", "derived id is what dedupes a repeat caller");
  assert.equal(p.tcpa_consent, false, "calling us is not consent to be dialed by an AI later");
  assert.equal((p.data as Record<string, unknown>).source, "inbound_call");

  const st = decodeState(calls[0].body.client_state as string);
  assert.equal(st.vars.known, "", "a brand-new lead must NOT be greeted as a returning caller");
});

// ==========================================================================
// The caller hangs up while the agent's phone is ringing
// ==========================================================================

test("ABANDONED: the agent's phone stops ringing when the caller gives up", async () => {
  const { sb, writes } = makeSb({
    ai_calls: [{
      id: "aic-1", call_control_id: "v3:inbound-ccid", direction: "inbound",
      status: "in_progress", transfer_status: "ringing_agent",
      transfer_call_control_id: "v3:agent-ccid",
    }],
  });
  const { impl, calls } = makeFetch([{ ok: true }]);

  assert.equal(await cancelInboundIfAbandoned({
    sb, telnyxHeaders: {}, callControlId: "v3:inbound-ccid", fetchImpl: impl,
  }), true);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/calls\/v3:agent-ccid\/actions\/hangup$/,
    "the AGENT leg is the one hung up — the caller is already gone");

  const upd = writes.find((w) => w.table === "ai_calls" && w.op === "update");
  const p = upd!.payload as Record<string, unknown>;
  assert.equal(p.answered_by, "none");
  assert.equal(p.billed_minutes, 0, "nobody spoke to anybody; nobody pays");
  assert.equal(p.outcome, "no_answer");
});

test("ABANDONED: an unrelated hangup is not claimed", async () => {
  const { sb } = makeSb({ ai_calls: [] });
  const { impl, calls } = makeFetch([{ ok: true }]);
  assert.equal(await cancelInboundIfAbandoned({
    sb, telnyxHeaders: {}, callControlId: "v3:some-power-dialer-leg", fetchImpl: impl,
  }), false, "a power-dialer leg must fall through to the dialer's own handler");
  assert.equal(calls.length, 0);
});

// ==========================================================================
// EVERY NUMBER AN AGENT OWNS (20260802b)
//
// ai_inbound_enabled now defaults TRUE, so an agent who buys five numbers has
// five numbers that answer callbacks. What must hold is that the number
// decides WHOSE agent gets rung: called number -> owning agent -> THAT agent's
// transfer_number and Available/Busy state. Five numbers, one agent, one cell;
// and a second agent's number that never crosses over.
// ==========================================================================

const FIVE = ["+12029981783", "+12026143091", "+12027953507", "+12027437798", "+12027718346"];
const AGENT_B = "agent-uuid-2";
const XFER_B  = "+13125550199";
const NUM_B   = "+12027428855";

const fleet = () => ({
  phone_numbers: [
    ...FIVE.map((e164, i) => numberRow({ id: `pn-a-${i}`, e164, agent_id: AGENT })),
    numberRow({ id: "pn-b-1", e164: NUM_B, agent_id: AGENT_B }),
  ],
  agents: [
    agentRow({ ai_availability: "available", transfer_number: XFER }),
    agentRow({ id: AGENT_B, display_name: "Other Agent", ai_availability: "available", transfer_number: XFER_B }),
  ],
  leads: [],
});

for (const num of FIVE) {
  test(`EVERY NUMBER: a callback to ${num} rings the owning agent's cell`, async () => {
    const { sb } = makeSb(fleet());
    const { impl, calls } = makeFetch([{ ok: true, body: { data: { call_control_id: "v3:agent-ccid" } } }]);

    assert.equal(await startInboundIfEnabled(deps(sb, impl, { to: num })), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.telnyx.com/v2/calls");
    assert.equal(calls[0].body.to, XFER, "all five numbers ring the SAME agent's transfer number");
    assert.equal(calls[0].body.from, num, "caller ID is the number they actually dialed");
  });
}

test("EVERY NUMBER: another agent's number rings THEIR cell, never the first agent's", async () => {
  const { sb } = makeSb(fleet());
  const { impl, calls } = makeFetch([{ ok: true, body: { data: { call_control_id: "v3:agent-ccid" } } }]);

  assert.equal(await startInboundIfEnabled(deps(sb, impl, { to: NUM_B })), true);
  assert.equal(calls[0].body.to, XFER_B);
  assert.notEqual(calls[0].body.to, XFER, "a number resolves to ITS OWN owner and nobody else");
});

test("EVERY NUMBER: one agent going Busy does not change the other agent's routing", async () => {
  const tables = fleet();
  // Agent A steps away; agent B is still available.
  tables.agents = [
    agentRow({ ai_availability: "busy", transfer_number: XFER }),
    agentRow({ id: AGENT_B, display_name: "Other Agent", ai_availability: "available", transfer_number: XFER_B }),
  ];

  const a = makeSb(tables);
  const fa = makeFetch([{ ok: true }]);
  assert.equal(await startInboundIfEnabled(deps(a.sb, fa.impl, { to: FIVE[2] })), true);
  assert.match(fa.calls[0].url, /actions\/answer$/, "A is busy — the assistant takes it");

  const b = makeSb(tables);
  const fb = makeFetch([{ ok: true, body: { data: { call_control_id: "v3:agent-ccid" } } }]);
  assert.equal(await startInboundIfEnabled(deps(b.sb, fb.impl, { to: NUM_B })), true);
  assert.equal(fb.calls[0].body.to, XFER_B, "B is available — B's cell rings");
});

test("EVERY NUMBER: the power-dialer host is still excluded even now the default is on", async () => {
  const tables = fleet();
  // Even if a row for it somehow existed and said enabled.
  tables.phone_numbers.push(numberRow({ id: "pn-host", e164: DIALER, agent_id: AGENT }));
  const { sb } = makeSb(tables);
  const { impl, calls } = makeFetch([{ ok: true }]);

  assert.equal(await startInboundIfEnabled(deps(sb, impl, { to: DIALER })), false);
  assert.equal(calls.length, 0, "the PIN IVR owns that number and the guard runs after it");
});
