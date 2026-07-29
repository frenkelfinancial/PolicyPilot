// ============================================================
// lead-transfer.test.ts — run with:  npm run test:leadtransfer
//
// Covers the three things that must never regress:
//   1. the authorization matrix (who may send to whom)
//   2. duplicate handling and the batch cap
//   3. the compliance rules — consent does not follow the lead, DNC does
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agencyPeers,
  canTransferBetween,
  planTransfer,
  sanitizeTransferredLead,
  summarizeTransfer,
  CLEARED_ON_TRANSFER,
  TRANSFER_MAX_PER_REQUEST,
  type AgencyInviteRow,
  type SenderLeadRow,
} from "./lead-transfer.ts";

const LEADER = "leader-1";
const DOWN_A = "down-a";
const DOWN_B = "down-b";
const OTHER_LEADER = "leader-2";
const OTHER_DOWN = "down-x";
const STRANGER = "stranger-1";

/** One agency: LEADER with DOWN_A and DOWN_B. A second, unrelated agency. */
const INVITES: AgencyInviteRow[] = [
  { leader_id: LEADER, invitee_id: DOWN_A, status: "accepted" },
  { leader_id: LEADER, invitee_id: DOWN_B, status: "accepted" },
  { leader_id: OTHER_LEADER, invitee_id: OTHER_DOWN, status: "accepted" },
];

// ------------------------------------------------------------
// 1. Authorization matrix
// ------------------------------------------------------------

test("leader sees both downlines; each downline sees the leader and its sibling", () => {
  const forLeader = agencyPeers(INVITES, LEADER);
  assert.deepEqual([...forLeader.entries()].sort(), [[DOWN_A, "downline"], [DOWN_B, "downline"]]);

  const forA = agencyPeers(INVITES, DOWN_A);
  assert.equal(forA.get(LEADER), "upline");
  assert.equal(forA.get(DOWN_B), "sibling");
  assert.equal(forA.size, 2, "a downline sees exactly its leader and its siblings");
});

test("all three intended directions are allowed", () => {
  assert.equal(canTransferBetween(INVITES, LEADER, DOWN_A), true, "leader -> downline");
  assert.equal(canTransferBetween(INVITES, DOWN_A, LEADER), true, "downline -> leader");
  assert.equal(canTransferBetween(INVITES, DOWN_A, DOWN_B), true, "downline -> sibling downline");
});

test("strangers and other agencies are refused in both directions", () => {
  assert.equal(canTransferBetween(INVITES, LEADER, STRANGER), false);
  assert.equal(canTransferBetween(INVITES, STRANGER, LEADER), false);
  assert.equal(canTransferBetween(INVITES, DOWN_A, OTHER_DOWN), false, "different agency");
  assert.equal(canTransferBetween(INVITES, OTHER_DOWN, DOWN_A), false);
  assert.equal(canTransferBetween(INVITES, LEADER, OTHER_LEADER), false, "two leaders are not peers");
});

test("an agent with no accepted invites has no peers at all", () => {
  assert.equal(agencyPeers(INVITES, STRANGER).size, 0);
  assert.equal(agencyPeers([], LEADER).size, 0);
});

test("pending and declined invites confer nothing", () => {
  const pending: AgencyInviteRow[] = [
    { leader_id: LEADER, invitee_id: DOWN_A, status: "pending" },
    { leader_id: LEADER, invitee_id: DOWN_B, status: "declined" },
  ];
  assert.equal(canTransferBetween(pending, LEADER, DOWN_A), false);
  assert.equal(canTransferBetween(pending, DOWN_A, DOWN_B), false);
});

test("an invite with a null invitee_id (invited, never signed up) is not a link", () => {
  const unaccepted: AgencyInviteRow[] = [
    { leader_id: LEADER, invitee_id: null, status: "accepted" },
  ];
  assert.equal(agencyPeers(unaccepted, LEADER).size, 0);
});

test("nobody can transfer to themselves", () => {
  assert.equal(canTransferBetween(INVITES, LEADER, LEADER), false);
  assert.equal(canTransferBetween(INVITES, DOWN_A, DOWN_A), false);
  assert.equal(agencyPeers(INVITES, DOWN_A).has(DOWN_A), false);
});

// ------------------------------------------------------------
// 2. Planner — ownership, duplicates, cap, client_id collisions
// ------------------------------------------------------------

const lead = (clientId: string, phone: string | null, name = "Lead " + clientId): SenderLeadRow => ({
  id: "uuid-" + clientId,
  client_id: clientId,
  data: phone === null ? { name } : { name, phone },
});

const emptyPlanInput = {
  recipientPhones: new Set<string>(),
  recipientClientIds: new Set<string>(),
  newClientId: (n: number) => `new-${n}`,
};

test("lead ids the sender does not own are refused, never moved", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["1", "2", "3"],
    senderLeads: [lead("1", "5551234567")],   // only 1 is actually theirs
  });
  assert.deepEqual(plan.moves.map((m) => m.fromClientId), ["1"]);
  assert.deepEqual(
    plan.refused.sort((a, b) => a.clientId.localeCompare(b.clientId)),
    [{ clientId: "2", reason: "not_yours" }, { clientId: "3", reason: "not_yours" }],
  );
});

test("a re-send of leads already handed over reads as already_transferred, not an error", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["1", "2"],
    senderLeads: [],                            // both already moved away
    previouslyTransferred: new Set(["1", "2"]),
  });
  assert.equal(plan.moves.length, 0);
  assert.ok(plan.refused.every((r) => r.reason === "already_transferred"));
});

test("a phone already in the recipient's book is skipped, not duplicated", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["1", "2"],
    senderLeads: [lead("1", "(555) 123-4567"), lead("2", "5559998888")],
    recipientPhones: new Set(["+15551234567"]),   // differently formatted, same number
  });
  assert.deepEqual(plan.moves.map((m) => m.fromClientId), ["2"]);
  assert.deepEqual(plan.skipped, [{ clientId: "1", reason: "duplicate_phone", phone: "+15551234567" }]);
});

test("two leads with the same phone inside one batch only send once", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["1", "2"],
    senderLeads: [lead("1", "5551110000"), lead("2", "555-111-0000")],
  });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.skipped.length, 1);
});

test("a lead with no usable phone still moves — there is nothing to dedupe on", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["1", "2"],
    senderLeads: [lead("1", null), lead("2", "123")],   // missing and unparseable
    recipientPhones: new Set(["+15551234567"]),
  });
  assert.equal(plan.moves.length, 2);
  assert.ok(plan.moves.every((m) => m.phone === null));
});

test("a client_id the recipient already uses is reassigned, so the unique constraint cannot fire", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["1700000000000"],
    senderLeads: [lead("1700000000000", "5551234567")],
    recipientClientIds: new Set(["1700000000000"]),
  });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].fromClientId, "1700000000000");
  assert.equal(plan.moves[0].toClientId, "new-1", "reassigned away from the collision");
});

test("client_id reassignment keeps trying until it finds a free one", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["a"],
    senderLeads: [lead("a", "5551234567")],
    recipientClientIds: new Set(["a", "new-1", "new-2"]),
  });
  assert.equal(plan.moves[0].toClientId, "new-3");
});

test("the batch cap refuses the remainder instead of truncating silently", () => {
  const ids = Array.from({ length: 5 }, (_, i) => String(i));
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ids,
    senderLeads: ids.map((i) => lead(i, `55500000${i}0`)),
    cap: 3,
  });
  assert.equal(plan.moves.length, 3);
  assert.equal(plan.refused.filter((r) => r.reason === "over_cap").length, 2);
});

test("the shipped cap is 250", () => {
  assert.equal(TRANSFER_MAX_PER_REQUEST, 250);
});

test("the same id sent twice in one request is handled once", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["1", "1", "1"],
    senderLeads: [lead("1", "5551234567")],
  });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.refused.length, 0);
});

test("planTransfer does not mutate the sets it was handed", () => {
  const phones = new Set(["+15550000000"]);
  const clientIds = new Set(["z"]);
  planTransfer({
    requestedClientIds: ["1"],
    senderLeads: [lead("1", "5551234567")],
    recipientPhones: phones,
    recipientClientIds: clientIds,
    newClientId: (n) => `new-${n}`,
  });
  assert.deepEqual([...phones], ["+15550000000"]);
  assert.deepEqual([...clientIds], ["z"]);
});

// ------------------------------------------------------------
// 3. Compliance — consent does not follow the lead, DNC does
// ------------------------------------------------------------

test("the cleared-column set resets TCPA consent and nothing else", () => {
  assert.deepEqual(CLEARED_ON_TRANSFER, {
    tcpa_consent: false,
    tcpa_consent_source: null,
    tcpa_consent_at: null,
  });
});

test("DNC columns are NOT in the cleared set — a suppression signal survives the handoff", () => {
  const keys = Object.keys(CLEARED_ON_TRANSFER);
  assert.ok(!keys.includes("dnc"), "dnc must never be cleared by a transfer");
  assert.ok(!keys.includes("dnc_at"), "dnc_at must never be cleared by a transfer");
});

test("consent-shaped keys are stripped out of the lead payload", () => {
  const dirty = {
    name: "Alice", phone: "+15551234567",
    tcpaConsent: true, consent: "express_written", trustedFormUrl: "https://cert",
    optIn: true, consent_type: "express",
  };
  const clean = sanitizeTransferredLead(dirty, {
    senderId: LEADER, senderName: "Pat Leader", at: "2026-07-28T12:00:00.000Z",
  });
  for (const k of ["tcpaConsent", "consent", "trustedFormUrl", "optIn", "consent_type"]) {
    assert.ok(!(k in clean), `${k} must not survive a transfer`);
  }
  assert.equal(clean.name, "Alice", "business fields are preserved");
  assert.equal(clean.phone, "+15551234567");
});

test("provenance is stamped so the recipient sees who sent it", () => {
  const clean = sanitizeTransferredLead({ name: "Alice" }, {
    senderId: LEADER, senderName: "Pat Leader", at: "2026-07-28T12:00:00.000Z",
  });
  assert.equal(clean.receivedFrom, "Pat Leader");
  assert.equal(clean.receivedFromId, LEADER);
  assert.equal(clean.receivedAt, "2026-07-28T12:00:00.000Z");
});

test("the lead identity is rewritten only when the client_id was reassigned", () => {
  const prov = { senderId: LEADER, senderName: "Pat", at: "2026-07-28T12:00:00.000Z" };
  assert.equal(sanitizeTransferredLead({ id: "111" }, prov).id, "111", "untouched by default");
  assert.equal(sanitizeTransferredLead({ id: "111" }, prov, "222").id, "222", "follows client_id");
});

test("sanitize does not mutate the input payload", () => {
  const original = { name: "Alice", tcpaConsent: true };
  sanitizeTransferredLead(original, { senderId: LEADER, senderName: "Pat", at: "now" });
  assert.equal(original.tcpaConsent, true, "caller's object is untouched");
});

test("a null payload is survivable", () => {
  const clean = sanitizeTransferredLead(null, { senderId: LEADER, senderName: "Pat", at: "now" });
  assert.equal(clean.receivedFrom, "Pat");
});

// ------------------------------------------------------------
// Toast summary
// ------------------------------------------------------------

test("the summary line reads the way the spec asks for it", () => {
  // 10 requested: 8 clean, 2 already in the recipient's book.
  const ids = Array.from({ length: 10 }, (_, i) => String(i));
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ids,
    senderLeads: ids.map((i) => lead(i, `55511100${i.padStart(2, "0")}`)),
    recipientPhones: new Set(["+15551110008", "+15551110009"]),
  });
  assert.equal(plan.moves.length, 8);
  assert.equal(summarizeTransfer(plan), "8 sent, 2 skipped — already in their book");
});

test("a clean full send says only what happened", () => {
  const plan = planTransfer({
    ...emptyPlanInput,
    requestedClientIds: ["1", "2"],
    senderLeads: [lead("1", "5551110001"), lead("2", "5551110002")],
  });
  assert.equal(summarizeTransfer(plan), "2 sent");
});
