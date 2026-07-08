// ============================================================
// matcher.test.ts — run with:  npm run test:email
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  carrierKeyFromText,
  isPolicyEvent,
  last5Digits,
  matchEvent,
  nameSimilarity,
  normalizeName,
  normalizePolicyNumber,
} from "./matcher.ts";

const ev = (o = {}) => ({ carrier: "transamerica", eventType: "approved", confidence: 0.95, ...o });

test("normalizePolicyNumber strips zeros/punctuation and uppercases", () => {
  assert.equal(normalizePolicyNumber("bu-669 1749"), "BU6691749");
  assert.equal(normalizePolicyNumber("0000113615870"), "113615870");
});

test("last5Digits extracts the masked suffix", () => {
  assert.equal(last5Digits("xxxxx76911"), "76911");
  assert.equal(last5Digits("7260123638"), "23638");
});

test("carrierKeyFromText maps free-text carriers to our keys", () => {
  assert.equal(carrierKeyFromText("Transamerica"), "transamerica");
  assert.equal(carrierKeyFromText("Mutual of Omaha"), "mutual_of_omaha");
  assert.equal(carrierKeyFromText("AmAm"), "american_amicable");
  assert.equal(carrierKeyFromText("Occidental Life"), "american_amicable");
  assert.equal(carrierKeyFromText("Corebridge (AIG)"), "corebridge");
  assert.equal(carrierKeyFromText("Ethos"), "ethos");
});

test("nameSimilarity is order-independent and suffix-insensitive", () => {
  assert.equal(nameSimilarity("Terry Wingler", "WINGLER, TERRY"), 1);
  // middle initial adds a token -> a fuzzy candidate (surfaced, not auto-matched)
  const midInitial = nameSimilarity("John A. Smith Jr.", "john smith");
  assert.ok(midInitial >= 0.6 && midInitial < 0.99, `expected fuzzy, got ${midInitial}`);
  // a bare first name must NOT clear the fuzzy bar (avoids matching on first name alone)
  assert.ok(nameSimilarity("Terry", "Terry Wingler") < 0.6);
  assert.ok(nameSimilarity("Michael Kjenstad", "Patricia Peak") < 0.6);
});

test("policy_number exact match auto-attaches at high confidence", () => {
  const policies = [{ id: "p1", policyNumber: "BU6691749", carrierKey: "transamerica", name: "Larry Didlo" }];
  const r = matchEvent(ev({ policyNumber: "BU6691749" }), policies);
  assert.equal(r.status, "matched");
  assert.equal(r.status === "matched" && r.method, "policy_number");
  assert.equal(r.status === "matched" && r.policyId, "p1");
});

test("exact number but low parse confidence -> review, not auto-apply", () => {
  const policies = [{ id: "p1", policyNumber: "BU6691749", carrierKey: "transamerica", name: "Larry Didlo" }];
  const r = matchEvent(ev({ policyNumber: "BU6691749", confidence: 0.7 }), policies);
  assert.equal(r.status, "review");
});

test("Transamerica masked last-5 unique hit auto-attaches", () => {
  const policies = [{ id: "p1", policyNumber: "1076911", carrierKey: "transamerica", name: "Terry Wingler" }];
  const r = matchEvent(ev({ policyNumber: "xxxxx76911" }), policies);
  assert.equal(r.status, "matched");
  assert.equal(r.status === "matched" && r.method, "masked_last5");
});

test("masked last-5 with multiple hits -> ambiguous review", () => {
  const policies = [
    { id: "p1", policyNumber: "1076911", carrierKey: "transamerica", name: "A" },
    { id: "p2", policyNumber: "2076911", carrierKey: "transamerica", name: "B" },
  ];
  const r = matchEvent(ev({ policyNumber: "xxxxx76911" }), policies);
  assert.equal(r.status, "review");
  assert.equal(r.status === "review" && r.reason, "ambiguous_match");
  assert.equal(r.status === "review" && r.candidateIds.length, 2);
});

test("name+carrier candidate is surfaced for confirmation, never auto-applied", () => {
  const policies = [{ id: "p1", carrierKey: "transamerica", name: "Terry Wingler", policyNumber: null }];
  const r = matchEvent(ev({ clientName: "WINGLER, TERRY", policyNumber: null }), policies);
  assert.equal(r.status, "review");
  assert.equal(r.status === "review" && r.reason, "ambiguous_match");
  assert.deepEqual(r.status === "review" && r.candidateIds, ["p1"]);
});

test("name match requires the same carrier", () => {
  const policies = [{ id: "p1", carrierKey: "americo", name: "Terry Wingler", policyNumber: null }];
  const r = matchEvent(ev({ carrier: "transamerica", clientName: "Terry Wingler" }), policies);
  assert.equal(r.status === "review" && r.reason, "no_policy_match");
});

test("no candidates -> no_policy_match", () => {
  const r = matchEvent(ev({ clientName: "Nobody Here", policyNumber: null }), []);
  assert.equal(r.status, "review");
  assert.equal(r.status === "review" && r.reason, "no_policy_match");
});

test("low confidence short-circuits to low_confidence review", () => {
  const r = matchEvent(ev({ confidence: 0.3, policyNumber: "BU6691749" }), []);
  assert.equal(r.status === "review" && r.reason, "low_confidence");
});

test("isPolicyEvent excludes commission types", () => {
  assert.ok(isPolicyEvent("approved"));
  assert.ok(!isPolicyEvent("commission_snapshot"));
  assert.ok(!isPolicyEvent("debt_notice"));
});

test("normalizeName drops punctuation and suffixes", () => {
  assert.equal(normalizeName("O'Brien, Sean Jr."), "o brien sean");
});
