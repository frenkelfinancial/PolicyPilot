// ============================================================
// voice-campaign-enroll.test.ts — run with:  npm run test:ai
//
// The MANUAL door: "select leads → Add to campaign", and the same planner
// reached from the CSV importer and the Add Lead modal.
//
// What is being pinned here is the thing the feature promises and the thing
// it could most easily get wrong: that the sentence shown before the button
// is pressed describes what the button then does. preview_enroll and
// enroll_leads in voice-campaign-manage are the SAME call to
// vcPlanManualEnrollment() with one flag flipped, so every count below is
// simultaneously a test of the preview and a test of the write.
//
// The other half is the gate. A door that let an agent point at a lead and
// have the AI phone them would be a door around consent, and the whole
// compliance story of this product rests on there not being one.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VC_ENROLL_TAG_FIELD,
  vcAutoEnrollPhrase,
  vcCampaignTag,
  vcEnrollPlanSentence,
  vcPlanManualEnrollment,
  vcStopReasonLabel,
  vcTagLabel,
} from "./voice-campaign-core.ts";
import type { VcLead, VcStep } from "./voice-campaign-core.ts";

const NOW = new Date("2026-08-01T15:00:00.000Z");

const STEPS: VcStep[] = [
  { id: "s1", position: 1, step_type: "call", wait_value: 1, wait_unit: "minutes" },
  { id: "s2", position: 2, step_type: "call", wait_value: 2, wait_unit: "hours" },
];

/** A campaign whose rule names one campaign_tag — the shipped lead-type shape. */
const TAGGED_CAMPAIGN = {
  id: "c1",
  name: "Final Expense",
  trigger_groups: [
    { conditions: [{ field: "campaign_tag", op: "is", value: "final_expense" }] },
    { conditions: [{ field: "lead_type", op: "is", value: "final expense" }] },
  ],
  auto_enroll_new_leads: true,
};

function lead(id: string, over: Partial<VcLead> = {}, data: Record<string, unknown> = {}): VcLead {
  return {
    id,
    data: { phone: "+12025550100", ...data },
    tcpa_consent: true,
    dnc: false,
    ...over,
  } as VcLead;
}

/** The planner with every collection defaulted to "nothing in the way". */
function plan(input: {
  leads: VcLead[];
  lead_ids?: string[];
  seen?: string[];
  elsewhere?: Record<string, string>;
  suppressed?: string[];
  noPhone?: string[];
  appointments?: Record<string, string>;
  onConflict?: "skip" | "move";
  campaign?: unknown;
  steps?: VcStep[];
  limit?: number;
}) {
  const ids = input.lead_ids || input.leads.map((l) => String(l.id));
  const noPhone = new Set(input.noPhone || []);
  return vcPlanManualEnrollment({
    lead_ids: ids,
    leads: input.leads,
    steps: input.steps || STEPS,
    now: NOW,
    seenInThisCampaign: new Set(input.seen || []),
    activeElsewhere: new Map(
      Object.entries(input.elsewhere || {}).map(([leadId, enrId]) => [leadId, { id: enrId, campaign_id: "other" }]),
    ),
    suppressed: new Set(input.suppressed || []),
    hasPhone: new Set(input.leads.map((l) => String(l.id)).filter((id) => !noPhone.has(id))),
    appointments: new Map(
      Object.entries(input.appointments || {}).map(([leadId, at]) => [leadId, { id: "appt-" + leadId, starts_at: at }]),
    ),
    onConflict: input.onConflict || "skip",
    // deno-lint-ignore no-explicit-any
    campaign: (input.campaign === undefined ? TAGGED_CAMPAIGN : input.campaign) as any,
    limit: input.limit === undefined ? 500 : input.limit,
  });
}

// ============================================================
// 1. THE GATE — what the manual door refuses
//
// Identical to the sweep's, because it IS the sweep's: the planner calls
// vcEvaluateEnrollment(), the one function ai-call-start's gate 3 agrees
// with. Pointing at a lead is not a way around any of this.
// ============================================================

test("a lead with no consent is never enrolled by hand", () => {
  const p = plan({ leads: [lead("a", { tcpa_consent: false })] });
  assert.equal(p.items.length, 0);
  assert.equal(p.skipped.no_consent, 1);
});

test("consent is checked as a LITERAL true — not truthy", () => {
  for (const bad of [1, "true", "yes", {}, null, undefined]) {
    const p = plan({ leads: [lead("a", { tcpa_consent: bad as unknown as boolean })] });
    assert.equal(p.items.length, 0, `tcpa_consent=${JSON.stringify(bad)} must not enroll`);
    assert.equal(p.skipped.no_consent, 1);
  }
});

test("a lead on the do-not-call list is never enrolled by hand", () => {
  const p = plan({ leads: [lead("a", { dnc: true })] });
  assert.equal(p.items.length, 0);
  assert.equal(p.skipped.dnc, 1);
});

test("a suppressed lead is never enrolled by hand", () => {
  const p = plan({ leads: [lead("a")], suppressed: ["a"] });
  assert.equal(p.items.length, 0);
  assert.equal(p.skipped.suppressed, 1);
});

test("a lead with no phone number is never enrolled by hand", () => {
  const p = plan({ leads: [lead("a")], noPhone: ["a"] });
  assert.equal(p.items.length, 0);
  assert.equal(p.skipped.no_phone, 1);
});

test("an id the agent does not own is reported, never silently ignored", () => {
  const p = plan({ leads: [lead("a")], lead_ids: ["a", "somebody-elses-lead"] });
  assert.equal(p.items.length, 1);
  assert.equal(p.skipped.not_found, 1);
});

test("every id handed in lands in exactly one bucket", () => {
  const leads = [
    lead("ok"),
    lead("nc", { tcpa_consent: false }),
    lead("dnc", { dnc: true }),
    lead("supp"),
    lead("np"),
  ];
  const p = plan({
    leads,
    lead_ids: ["ok", "nc", "dnc", "supp", "np", "ghost"],
    suppressed: ["supp"],
    noPhone: ["np"],
  });
  const skippedTotal = Object.values(p.skipped).reduce((s, n) => s + n, 0);
  assert.equal(p.items.length + skippedTotal + p.truncated, 6);
});

test("the same lead offered twice is one lead", () => {
  const p = plan({ leads: [lead("a")], lead_ids: ["a", "a", "a"] });
  assert.equal(p.items.length, 1);
  assert.equal(Object.values(p.skipped).reduce((s, n) => s + n, 0), 0);
});

// ============================================================
// 2. ONE ACTIVE CAMPAIGN — skip, or move
// ============================================================

test("SKIP (the default) leaves a lead in the campaign they are already in", () => {
  const p = plan({ leads: [lead("a")], elsewhere: { a: "enr-1" } });
  assert.equal(p.items.length, 0);
  assert.equal(p.moves, 0);
  assert.equal(p.skipped.already_enrolled, 1);
});

test("MOVE stops the old enrollment and enrolls here", () => {
  const p = plan({ leads: [lead("a")], elsewhere: { a: "enr-1" }, onConflict: "move" });
  assert.equal(p.items.length, 1);
  assert.equal(p.moves, 1);
  assert.equal(p.items[0].action, "move");
  assert.equal(p.items[0].from_enrollment_id, "enr-1");
  assert.equal(p.skipped.already_enrolled, undefined);
});

test("MOVE does not invent a conflict for a lead that had none", () => {
  const p = plan({ leads: [lead("a"), lead("b")], elsewhere: { a: "enr-1" }, onConflict: "move" });
  assert.equal(p.items.length, 2);
  assert.equal(p.moves, 1);
  assert.equal(p.items.filter((i) => i.action === "enroll").length, 1);
  assert.equal(p.items.filter((i) => i.action === "enroll")[0].from_enrollment_id, null);
});

test("MOVE never rescues a lead the gate refused — consent outranks the conflict", () => {
  // The ordering that matters: a lead with no consent must be reported as
  // "no consent", not as "already in another campaign". Telling an agent to
  // resolve the conflict for a lead nobody may call sends them to fix the
  // wrong thing, and moving them would end a campaign for no gain.
  const p = plan({
    leads: [lead("a", { tcpa_consent: false })],
    elsewhere: { a: "enr-1" },
    onConflict: "move",
  });
  assert.equal(p.items.length, 0);
  assert.equal(p.moves, 0);
  assert.equal(p.skipped.no_consent, 1);
  assert.equal(p.skipped.already_enrolled, undefined);
});

test("a lead this campaign has already run is not re-enrolled, in either mode", () => {
  for (const onConflict of ["skip", "move"] as const) {
    const p = plan({ leads: [lead("a")], seen: ["a"], onConflict });
    assert.equal(p.items.length, 0);
    assert.equal(p.skipped.already_this_campaign, 1);
    // and NOT counted as the other kind of conflict
    assert.equal(p.skipped.already_enrolled, undefined);
  }
});

test("moved_by_user reads as a move, not as an unenrolment", () => {
  assert.equal(vcStopReasonLabel("moved_by_user"), "Moved to another campaign");
  assert.notEqual(vcStopReasonLabel("moved_by_user"), vcStopReasonLabel("manual"));
});

// ============================================================
// 3. THE ENROLLMENT ITSELF — step 1, normal timing
// ============================================================

test("an enrolled lead starts at the first step with that step's own wait", () => {
  const p = plan({ leads: [lead("a")] });
  assert.equal(p.items[0].current_step_position, 1);
  // one minute after now, exactly as the sweep would schedule it
  assert.equal(p.items[0].next_action_at, new Date(NOW.getTime() + 60000).toISOString());
});

test("an appointment-anchored campaign whose moment has passed enrolls nobody", () => {
  const anchored: VcStep[] = [
    { id: "s1", position: 1, step_type: "call", anchor: "appointment", offset_minutes: -1440 },
  ];
  const p = plan({
    leads: [lead("a")],
    steps: anchored,
    appointments: { a: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() },
  });
  assert.equal(p.items.length, 0);
  assert.equal(p.skipped.appointment_too_soon, 1);
});

test("the enroll limit truncates rather than dropping silently", () => {
  const leads = Array.from({ length: 5 }, (_, i) => lead("l" + i));
  const p = plan({ leads, limit: 3 });
  assert.equal(p.items.length, 3);
  assert.equal(p.truncated, 2);
  assert.match(vcEnrollPlanSentence(p), /2 over the limit/);
});

// ============================================================
// 4. THE TAG — coherence, and the two ways it must NOT fire
// ============================================================

test("a campaign whose rule names one campaign_tag yields that tag", () => {
  assert.equal(vcCampaignTag(TAGGED_CAMPAIGN), "final_expense");
});

test("a rule written on lead_type yields NO tag", () => {
  // lead_type is virtual and resolves through coverage_wanted first, which in
  // the production book holds DOLLAR AMOUNTS. "Make the lead match" would
  // mean writing a coverage amount of "veteran".
  assert.equal(vcCampaignTag({ trigger_groups: [{ conditions: [{ field: "lead_type", op: "is", value: "veteran" }] }] }), "");
  assert.equal(vcCampaignTag({ trigger_groups: [{ conditions: [{ field: "source", op: "is", value: "acme" }] }] }), "");
  assert.equal(vcCampaignTag({ trigger_groups: [{ conditions: [{ field: "coverage_wanted", op: "is", value: "25000" }] }] }), "");
});

test("an is_not condition never yields a tag", () => {
  assert.equal(vcCampaignTag({ trigger_groups: [{ conditions: [{ field: "campaign_tag", op: "is_not", value: "veteran" }] }] }), "");
});

test("TWO different campaign_tag values is ambiguous, and ambiguous writes nothing", () => {
  const two = {
    trigger_groups: [
      { conditions: [{ field: "campaign_tag", op: "is", value: "veteran" }] },
      { conditions: [{ field: "campaign_tag", op: "is", value: "trucker" }] },
    ],
  };
  assert.equal(vcCampaignTag(two), "");
});

test("the SAME campaign_tag repeated across groups is not ambiguous", () => {
  const same = {
    trigger_groups: [
      { conditions: [{ field: "campaign_tag", op: "is", value: "veteran" }, { field: "state", op: "is", value: "TX" }] },
      { conditions: [{ field: "campaign_tag", op: "is", value: "VETERAN" }] },
    ],
  };
  assert.equal(vcCampaignTag(same), "veteran");
});

test("only leads actually being enrolled are put forward for tagging", () => {
  const p = plan({
    leads: [lead("ok"), lead("nope", { tcpa_consent: false })],
  });
  assert.deepEqual(p.tag_lead_ids, ["ok"]);
  assert.equal(p.tag, "final_expense");
});

test("a lead already carrying the tag is not rewritten", () => {
  const p = plan({ leads: [lead("a", {}, { [VC_ENROLL_TAG_FIELD]: "Final_Expense" })] });
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.tag_lead_ids, []);
});

test("a campaign with no single tag puts nobody forward for tagging", () => {
  const p = plan({
    leads: [lead("a")],
    campaign: { trigger_groups: [{ conditions: [{ field: "status", op: "is", value: "sold" }] }] },
  });
  assert.equal(p.items.length, 1);
  assert.equal(p.tag, "");
  assert.deepEqual(p.tag_lead_ids, []);
});

test("the tag label is what a person calls it", () => {
  assert.equal(vcTagLabel("final_expense"), "Final Expense");
  assert.equal(vcTagLabel("mortgage-protection"), "Mortgage Protection");
  assert.equal(vcTagLabel("iul"), "IUL");
  assert.equal(vcTagLabel("veteran"), "Veteran");
  assert.equal(vcTagLabel(""), "");
  assert.equal(vcTagLabel(null), "");
});

// ============================================================
// 5. THE PREVIEW SENTENCE — the promise and the receipt
// ============================================================

test("the preview names the leads that would be blocked on consent", () => {
  const p = plan({
    leads: [lead("a"), lead("b", { tcpa_consent: false }), lead("c", { tcpa_consent: false })],
  });
  assert.deepEqual(p.no_consent_lead_ids, ["b", "c"]);
});

test("the preview sentence and the result sentence describe the same plan", () => {
  const p = plan({
    leads: [lead("a"), lead("b"), lead("nc", { tcpa_consent: false })],
    elsewhere: { b: "enr-1" },
    onConflict: "move",
  });
  const before = vcEnrollPlanSentence(p, "will");
  const after = vcEnrollPlanSentence(p, "did");
  assert.equal(before, "1 will be enrolled · 1 will move from another campaign · 1 no consent");
  assert.equal(after, "1 enrolled · 1 moved from another campaign · 1 no consent");
});

test("a plan with nothing in the way says only the one thing", () => {
  const p = plan({ leads: [lead("a"), lead("b")] });
  assert.equal(vcEnrollPlanSentence(p, "will"), "2 will be enrolled");
});

test("a plan that would do nothing still says so, and the count is zero", () => {
  const p = plan({ leads: [lead("a", { tcpa_consent: false })] });
  assert.equal(vcEnrollPlanSentence(p, "will"), "0 will be enrolled · 1 no consent");
  assert.equal(p.items.length, 0);
});

// ============================================================
// 6. "HOW THIS CAMPAIGN FILLS ITSELF" — helper copy that cannot over-promise
// ============================================================

test("an auto-enrolling tagged campaign says which tag", () => {
  assert.equal(vcAutoEnrollPhrase(TAGGED_CAMPAIGN), "Auto-enrolls: leads tagged Final Expense.");
});

test("a lifecycle campaign names its trigger, not a tag", () => {
  assert.equal(
    vcAutoEnrollPhrase({ trigger_on_sold: true, trigger_groups: [{ conditions: [{ field: "status", op: "is", value: "sold" }] }] }),
    "Fills when a lead is marked Sold.",
  );
  assert.equal(vcAutoEnrollPhrase({ trigger_on_missed_appointment: true }), "Fills when an appointment is marked no-show.");
  assert.equal(vcAutoEnrollPhrase({ trigger_on_appointment_booked: true }), "Fills when an appointment is booked.");
});

test("a campaign with NO trigger says so, rather than implying automation", () => {
  // This is the whole point of the line. A dormant campaign and an
  // auto-filling one used to look identical on the card.
  assert.equal(vcAutoEnrollPhrase({ trigger_groups: [{ conditions: [{ field: "campaign_tag", op: "is", value: "veteran" }] }] }),
    "Only leads you add by hand.");
  assert.equal(vcAutoEnrollPhrase(null), "Only leads you add by hand.");
  assert.equal(vcAutoEnrollPhrase({}), "Only leads you add by hand.");
});

test("several triggers are all named", () => {
  const s = vcAutoEnrollPhrase({
    auto_enroll_new_leads: true,
    trigger_on_sold: true,
    trigger_groups: [{ conditions: [{ field: "campaign_tag", op: "is", value: "veteran" }] }],
  });
  assert.equal(s, "Auto-enrolls: leads tagged Veteran · Fills when a lead is marked Sold.");
});

test("an untagged auto-enrolling campaign does not claim a tag it has not got", () => {
  assert.equal(
    vcAutoEnrollPhrase({ auto_enroll_new_leads: true, trigger_groups: [{ conditions: [{ field: "lead_type", op: "is", value: "veteran" }] }] }),
    "Auto-enrolls: leads matching your rules.",
  );
});
