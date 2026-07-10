// ============================================================
// messaging-send-core.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
//
// Unit tests for the shared authorize-then-capture core used by BOTH
// messaging-send-sms/mms and messaging-broadcast-run — this is the
// "billing parity" guarantee from PROMPT_07 §6: because both callers
// invoke this exact function with no caller-identity branch inside it,
// a single-send and a broadcast-driven send for the same inputs place
// identical holds and follow identical never-charge-undelivered rules.
// The Supabase client and Telnyx fetch are both injected, so these tests
// never touch a real database or the real Telnyx API.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { sendMessageCore } from "./messaging-send-core.ts";

interface Call {
  op: "insert" | "update" | "rpc";
  table?: string;
  name?: string;
  payload: Record<string, unknown>;
}

function makeMockSb(opts: {
  billingConfig?: { sms_segment_mills?: number; mms_mills?: number };
  insertError?: string;
  holdError?: string;
  holdLedgerId?: string;
} = {}) {
  const calls: Call[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: opts.billingConfig ?? { sms_segment_mills: 10, mms_mills: 30 },
                  error: null,
                }),
              };
            },
          };
        },
        insert(row: Record<string, unknown>) {
          calls.push({ op: "insert", table, payload: row });
          return {
            select() {
              return {
                single: async () => opts.insertError
                  ? { data: null, error: { message: opts.insertError } }
                  : { data: { id: "msg-1" }, error: null },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          calls.push({ op: "update", table, payload: patch });
          return { eq: async () => ({ error: null }) };
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ op: "rpc", name, payload: args });
      if (name === "wallet_hold") {
        return opts.holdError
          ? Promise.resolve({ data: null, error: { message: opts.holdError } })
          : Promise.resolve({ data: opts.holdLedgerId ?? "hold-1", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { sb, calls };
}

function makeMockFetch(opts: { ok?: boolean; status?: number; jsonBody?: unknown; errText?: string } = {}) {
  const ok = opts.ok ?? true;
  const fn = async () => ({
    ok,
    status: opts.status ?? (ok ? 200 : 500),
    json: async () => opts.jsonBody ?? { data: { id: "telnyx-msg-1" } },
    text: async () => opts.errText ?? "provider error",
  });
  return fn as unknown as typeof fetch;
}

const baseParams = {
  agentId: "agent-1",
  to: "+15551234567",
  fromNumber: "+15557654321",
  consentId: "consent-1",
};

test("happy path SMS: places one hold, sends via Telnyx, marks the message sent", async () => {
  const { sb, calls } = makeMockSb();
  const result = await sendMessageCore(
    { ...baseParams, channel: "sms", text: "Hello" },
    { sb, supabaseUrl: "https://x.supabase.co", telnyxApiKey: "key", fetchImpl: makeMockFetch() },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.providerMessageId, "telnyx-msg-1");
    assert.equal(result.segments, 1);
    assert.equal(result.amountMills, 10);
    assert.equal(result.holdLedgerId, "hold-1");
  }

  const rpcCalls = calls.filter((c) => c.op === "rpc");
  assert.equal(rpcCalls.length, 1, "exactly one wallet RPC (the hold) — no settle/void on a clean send");
  assert.equal(rpcCalls[0].name, "wallet_hold");

  const finalUpdate = calls.filter((c) => c.op === "update").at(-1);
  assert.equal(finalUpdate?.payload.status, "sent");
});

test("MMS bills the flat mms_mills rate regardless of body length, with null segments", async () => {
  const { sb } = makeMockSb({ billingConfig: { sms_segment_mills: 10, mms_mills: 30 } });
  const result = await sendMessageCore(
    { ...baseParams, channel: "mms", text: "a".repeat(500), mediaUrls: ["https://example.com/x.jpg"] },
    { sb, supabaseUrl: "https://x.supabase.co", telnyxApiKey: "key", fetchImpl: makeMockFetch() },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.amountMills, 30);
    assert.equal(result.segments, null);
  }
});

test("never-charge-undelivered: a Telnyx rejection voids the hold and marks the message failed", async () => {
  const { sb, calls } = makeMockSb({ holdLedgerId: "hold-99" });
  const result = await sendMessageCore(
    { ...baseParams, channel: "sms", text: "Hello" },
    { sb, supabaseUrl: "https://x.supabase.co", telnyxApiKey: "key", fetchImpl: makeMockFetch({ ok: false, status: 502, errText: "carrier rejected" }) },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.httpStatus, 502);

  const voidCall = calls.find((c) => c.op === "rpc" && c.name === "wallet_void");
  assert.ok(voidCall, "wallet_void must run on provider rejection — the hold must never survive a failed send");
  assert.equal(voidCall?.payload.p_ledger_id, "hold-99");

  const finalUpdate = calls.filter((c) => c.op === "update" && c.table === "messages").at(-1);
  assert.equal(finalUpdate?.payload.status, "failed");
});

test("a failed messages insert places zero holds and never calls Telnyx", async () => {
  const { sb, calls } = makeMockSb({ insertError: "db unreachable" });
  let telnyxCalled = false;
  const fetchImpl = (async () => { telnyxCalled = true; return { ok: true, json: async () => ({}), text: async () => "" }; }) as unknown as typeof fetch;

  const result = await sendMessageCore(
    { ...baseParams, channel: "sms", text: "Hello" },
    { sb, supabaseUrl: "https://x.supabase.co", telnyxApiKey: "key", fetchImpl },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "db_insert_failed");
  assert.equal(calls.some((c) => c.op === "rpc"), false, "no wallet_hold should ever be attempted without a messages row");
  assert.equal(telnyxCalled, false);
});

test("insufficient_balance surfaces as 402 and never reaches Telnyx", async () => {
  const { sb } = makeMockSb({ holdError: "insufficient_balance: shortfall" });
  let telnyxCalled = false;
  const fetchImpl = (async () => { telnyxCalled = true; return { ok: true, json: async () => ({}), text: async () => "" }; }) as unknown as typeof fetch;

  const result = await sendMessageCore(
    { ...baseParams, channel: "sms", text: "Hello" },
    { sb, supabaseUrl: "https://x.supabase.co", telnyxApiKey: "key", fetchImpl },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.httpStatus, 402);
    assert.equal(result.error, "insufficient_balance");
  }
  assert.equal(telnyxCalled, false, "Telnyx must never be called when the hold itself failed");
});

test("billing parity: two calls with identical SMS inputs (simulating single-send vs broadcast-run callers) produce identical segments/amount", async () => {
  const paramsA = { ...baseParams, channel: "sms" as const, text: "Hi {name}, your quote is ready. Reply STOP to opt out." };
  const paramsB = { ...paramsA }; // a broadcast-run call passes the same shape — no caller-identity branch exists in the core
  const depsA = { sb: makeMockSb().sb, supabaseUrl: "https://x.supabase.co", telnyxApiKey: "key", fetchImpl: makeMockFetch() };
  const depsB = { sb: makeMockSb().sb, supabaseUrl: "https://x.supabase.co", telnyxApiKey: "key", fetchImpl: makeMockFetch() };

  const resultA = await sendMessageCore(paramsA, depsA);
  const resultB = await sendMessageCore(paramsB, depsB);

  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  if (resultA.ok && resultB.ok) {
    assert.equal(resultA.segments, resultB.segments);
    assert.equal(resultA.amountMills, resultB.amountMills);
  }
});
