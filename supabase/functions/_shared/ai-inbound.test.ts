// ============================================================
// ai-inbound.test.ts — run with:  npm run test:ai
//
// The guard is the important thing in this file. ONE Telnyx Call Control
// application carries the power dialer, the outbound AI dialer and now inbound
// AI answering, so the four conditions in shouldHandleInbound() are the only
// thing standing between a new feature and the PIN IVR that agents use to run
// the power dialer every day. See docs/ai-inbound-routing.md.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_RING_SECS,
  MAX_PRE_ANSWER_SECS,
  buildInboundGreeting,
  buildInboundLeadRow,
  buildInboundWhisper,
  inboundLeadClientId,
  last10,
  leadFirstName,
  matchLeadByPhone,
  shouldHandleInbound,
} from "./ai-inbound.ts";

const ENABLED = { ai_inbound_enabled: true, status: "active" };
const DIALER = "+12625099123";       // the power-dialer PIN-IVR host
const AI_NUM = "+12029981783";       // the one opted-in number

const base = {
  eventType: "call.initiated",
  direction: "incoming",
  to: AI_NUM,
  dialerNumber: DIALER,
  numberRow: ENABLED,
};

// ---- the guard ----------------------------------------------------------

test("guard: claims an inbound call to an opted-in number", () => {
  assert.equal(shouldHandleInbound(base), true);
  assert.equal(shouldHandleInbound({ ...base, direction: "inbound" }), true);
});

test("guard: NEVER claims the power-dialer host number", () => {
  // The single most damaging false positive available. Agents call this number
  // to start a power-dialer session; answering it with a sales assistant would
  // break the dialer for everyone on the platform.
  assert.equal(shouldHandleInbound({ ...base, to: DIALER }), false);
  // …even if somebody flags it in phone_numbers by mistake.
  assert.equal(shouldHandleInbound({ ...base, to: DIALER, numberRow: ENABLED }), false);
  // …and tolerating the 1-prefix, since Telnyx and our columns disagree on it.
  assert.equal(shouldHandleInbound({ ...base, to: "2625099123" }), false);
});

test("guard: a number that has not opted in is ignored", () => {
  assert.equal(shouldHandleInbound({ ...base, numberRow: { ai_inbound_enabled: false, status: "active" } }), false);
  assert.equal(shouldHandleInbound({ ...base, numberRow: null }), false);
  assert.equal(shouldHandleInbound({ ...base, numberRow: undefined }), false);
});

test("guard: a released or inactive number is ignored", () => {
  assert.equal(shouldHandleInbound({ ...base, numberRow: { ai_inbound_enabled: true, status: "released" } }), false);
});

test("guard: OUTBOUND calls never reach the inbound flow", () => {
  // Every outbound AI call and every power-dialer leg is direction=outgoing.
  assert.equal(shouldHandleInbound({ ...base, direction: "outgoing" }), false);
  assert.equal(shouldHandleInbound({ ...base, direction: "outbound" }), false);
  assert.equal(shouldHandleInbound({ ...base, direction: null }), false);
});

test("guard: only call.initiated starts a flow", () => {
  for (const e of ["call.answered", "call.hangup", "call.gather.ended", "call.machine.premium.detection.ended"]) {
    assert.equal(shouldHandleInbound({ ...base, eventType: e }), false, e);
  }
});

test("guard: an unset dialer number does not open the floodgates", () => {
  // telnyx-call-status's own dialer check treats a MISSING TELNYX_DIALER_NUMBER
  // as "every inbound call is the dialer". This guard must not mirror that
  // logic in reverse — an opted-in number is still opted in.
  assert.equal(shouldHandleInbound({ ...base, dialerNumber: null }), true);
});

// ---- ring-first timing --------------------------------------------------

test("the agent ring is shorter than the caller's patience ceiling", () => {
  // A digit is required to bridge, so voicemail can never take the call — but
  // the ring still has to finish before the caller gives up, and comfortably
  // before a typical carrier voicemail pickup (~20-25s).
  assert.ok(AGENT_RING_SECS < MAX_PRE_ANSWER_SECS,
    "the agent leg must stop ringing before the pre-answer ceiling");
  assert.ok(AGENT_RING_SECS <= 15, "longer than 15s and the caller hears a suspicious amount of ringing");
  assert.ok(MAX_PRE_ANSWER_SECS <= 20, "nobody should hear more than ~20s of ringback before someone answers");
});

// ---- caller identification ----------------------------------------------

test("matchLeadByPhone tolerates every format the book actually contains", () => {
  const leads = [
    { id: "a", data: { phone: "(920) 416-9244" } },
    { id: "b", data: { phone: "+19204227733" } },
    { id: "c", data: { phone: "9207094998" } },
  ];
  assert.equal(matchLeadByPhone(leads, "+19204169244")?.id, "a");
  assert.equal(matchLeadByPhone(leads, "+19204227733")?.id, "b");
  assert.equal(matchLeadByPhone(leads, "19207094998")?.id, "c");
  assert.equal(matchLeadByPhone(leads, "+15551234567"), null);
});

test("matchLeadByPhone returns null for a caller with no number", () => {
  assert.equal(matchLeadByPhone([{ id: "a", data: { phone: "+19204169244" } }], ""), null);
});

test("leadFirstName ignores placeholder junk", () => {
  assert.equal(leadFirstName({ first_name: "Mark" }), "Mark");
  assert.equal(leadFirstName({ name: "Mark Johnson" }), "Mark");
  assert.equal(leadFirstName({ name: "there" }), "");
  assert.equal(leadFirstName({ first_name: "unknown" }), "");
  assert.equal(leadFirstName(null), "");
});

test("last10 makes +1 and no-1 compare equal", () => {
  assert.equal(last10("+19204169244"), "9204169244");
  assert.equal(last10("(920) 416-9244"), "9204169244");
  assert.equal(last10(null), "");
});

// ---- unknown-caller lead creation ---------------------------------------

test("the same caller ringing twice is ONE lead", () => {
  // leads is unique on (agent_id, client_id), so a stable derived client_id is
  // what makes the second call a conflict instead of a duplicate person.
  assert.equal(inboundLeadClientId("+19204169244"), inboundLeadClientId("(920) 416-9244"));
  assert.equal(inboundLeadClientId("+19204169244"), "inbound-9204169244");
});

test("an inbound-created lead has NO TCPA consent, and never invents a name", () => {
  const row = buildInboundLeadRow({
    agentId: "agent-1", callerE164: "+19204169244", calledE164: AI_NUM,
    now: "2026-08-01T00:00:00.000Z",
  }) as { tcpa_consent: boolean; dnc: boolean; data: Record<string, unknown> };

  // Calling US is what makes ANSWERING lawful. It is not consent to be dialed
  // by an artificial voice tomorrow, and ai-call-start's gate must keep
  // refusing them until real consent is captured.
  assert.equal(row.tcpa_consent, false);
  assert.equal(row.dnc, false);
  assert.equal(row.data.source, "inbound_call");
  assert.equal(row.data.name, "", "nothing invents a name for a caller who has not given one");
  assert.equal(row.data.phone, "+19204169244");
});

// ---- what each side hears ------------------------------------------------

test("the inbound whisper never claims the caller has been screened", () => {
  // Outbound says "hot lead" because the AI already qualified them. On inbound
  // nobody has spoken to the caller at all, and telling the agent otherwise is
  // a lie they would act on.
  const w = buildInboundWhisper({ leadName: "Mark Johnson", leadType: "final expense" });
  assert.equal(w, "Incoming call from Mark Johnson, about final expense. Press 1 to answer.");
  assert.ok(!/hot lead/i.test(w));
});

test("the inbound whisper degrades to an unknown caller", () => {
  assert.equal(buildInboundWhisper({}), "Incoming call from an unknown caller. Press 1 to answer.");
  assert.equal(buildInboundWhisper({ leadName: "Mark" }), "Incoming call from Mark. Press 1 to answer.");
});

test("a KNOWN caller is greeted by name and by what they asked about", () => {
  const g = buildInboundGreeting({
    known: true, lead_first: "Mark", lead_type: "final expense",
    ai_name: "Sarah", agent_name: "Jace Frenkel", agency_name: "Frenkel Financial",
  });
  assert.match(g, /^Hi Mark — thanks for calling back about your final expense coverage\./);
  assert.match(g, /an assistant with Frenkel Financial, working with Jace Frenkel/);
});

test("an UNKNOWN caller is asked for a name, never greeted as a returning one", () => {
  const g = buildInboundGreeting({
    known: false, ai_name: "Sarah", agent_name: "Jace Frenkel", agency_name: "Frenkel Financial",
  });
  assert.match(g, /^Thanks for calling Frenkel Financial\./);
  assert.match(g, /Can I start with your name\?$/);
  assert.ok(!/calling back/.test(g));
});

test("a known lead with no first name is not greeted by a blank", () => {
  const g = buildInboundGreeting({ known: true, lead_first: "", agent_name: "Jace Frenkel" });
  assert.ok(!/Hi\s+—/.test(g), "produced 'Hi  —'");
  assert.match(g, /Can I start with your name\?$/);
});

test("EVERY inbound greeting carries the disclosure, however much is blank", () => {
  const shapes = [
    { known: true, lead_first: "Mark", ai_name: "Sarah", agent_name: "Jace", agency_name: "FF", lead_type: "term" },
    { known: true, lead_first: "Mark", agent_name: "Jace" },
    { known: false, ai_name: "Sarah", agency_name: "FF", agent_name: "Jace" },
    { known: false },
    {},
  ];
  for (const v of shapes) {
    const g = buildInboundGreeting(v);
    assert.match(g, /an assistant/i, `no disclosure in: ${g}`);
    assert.ok(!/undefined|null|\s{2,}/.test(g), `ragged output: ${g}`);
  }
});
