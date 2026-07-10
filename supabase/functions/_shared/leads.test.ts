// ============================================================
// leads.test.ts — run with:  npm run test:messaging   (Node 24, no deps)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import { expandLeadsToRecipients, leadMatchesStatusFilter, type LeadRow } from "./leads.ts";

test("expands leads with a valid `data.phone` into E.164 recipients", () => {
  const leads: LeadRow[] = [
    { id: "lead-1", data: { phone: "5551234567", name: "Alice" } },
    { id: "lead-2", data: { phone: "+15559876543", name: "Bob" } },
  ];
  const { recipients, invalid } = expandLeadsToRecipients(leads);
  assert.equal(invalid.length, 0);
  assert.deepEqual(recipients, [
    { leadId: "lead-1", toAddress: "+15551234567", source: "lead" },
    { leadId: "lead-2", toAddress: "+15559876543", source: "lead" },
  ]);
});

test("drops leads with no phone or an unparseable phone as invalid_phone, does not throw", () => {
  const leads: LeadRow[] = [
    { id: "lead-1", data: { name: "No phone at all" } },
    { id: "lead-2", data: { phone: "123", name: "Too short" } },
    { id: "lead-3", data: null },
    { id: "lead-4", data: { phone: "5551234567", name: "Valid" } },
  ];
  const { recipients, invalid } = expandLeadsToRecipients(leads);
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].leadId, "lead-4");
  assert.equal(invalid.length, 3);
  assert.ok(invalid.every((r) => r.skipReason === "invalid_phone"));
  assert.deepEqual(invalid.map((r) => r.leadId), ["lead-1", "lead-2", "lead-3"]);
});

test("dedupes two leads that normalize to the same E.164 number — first lead wins", () => {
  const leads: LeadRow[] = [
    { id: "lead-1", data: { phone: "(555) 123-4567" } },
    { id: "lead-2", data: { phone: "555-123-4567" } }, // same number, different formatting
    { id: "lead-3", data: { phone: "5559998888" } },
  ];
  const { recipients } = expandLeadsToRecipients(leads);
  assert.equal(recipients.length, 2);
  assert.equal(recipients[0].leadId, "lead-1"); // first occurrence wins the dedupe
  assert.equal(recipients[0].toAddress, "+15551234567");
  assert.equal(recipients[1].leadId, "lead-3");
});

test("leadMatchesStatusFilter: 'all' and empty match everything", () => {
  const lead: LeadRow = { id: "l1", data: { status: "contacted" } };
  assert.equal(leadMatchesStatusFilter(lead, "all"), true);
  assert.equal(leadMatchesStatusFilter(lead, ""), true);
});

test("leadMatchesStatusFilter: exact status match only", () => {
  const contacted: LeadRow = { id: "l1", data: { status: "contacted" } };
  const brandNew: LeadRow = { id: "l2", data: { status: "new" } };
  assert.equal(leadMatchesStatusFilter(contacted, "contacted"), true);
  assert.equal(leadMatchesStatusFilter(brandNew, "contacted"), false);
});

test("leadMatchesStatusFilter: lead with no status never matches a specific filter", () => {
  const noStatus: LeadRow = { id: "l1", data: {} };
  assert.equal(leadMatchesStatusFilter(noStatus, "new"), false);
  assert.equal(leadMatchesStatusFilter(noStatus, "all"), true);
});
