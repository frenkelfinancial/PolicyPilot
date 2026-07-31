// ============================================================
// voice-campaigns.test.mjs — run with:  npm run test:voicecampaigns
//
// Three kinds of test, same split as ai-meter.test.mjs.
//
//   1. PARITY. The campaign rules exist twice — in
//      supabase/functions/_shared/voice-campaign-core.ts (the engine) and in
//      the `// <vcamp-core>` block in app.html (the editor). app.html has no
//      build step and no module system, so the duplication is unavoidable;
//      what is avoidable is DRIFT. A shared table of cases runs through both.
//      If the editor and the scheduler ever disagree about which leads a rule
//      catches, or about whether a rule may be saved at all, this fails.
//
//   2. BEHAVIOUR. The extracted browser core is executed verbatim — the exact
//      text that ships — against the rules that matter on screen.
//
//   3. STRUCTURE. Assertions about app.html and the migration as source text.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as SRV from '../supabase/functions/_shared/voice-campaign-core.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIG = readFileSync(join(ROOT, 'supabase/migrations/20260802b_voice_campaigns.sql'), 'utf8');

const EXPORTS = [
  'VC_SLOT_LIMIT', 'VC_INFLIGHT_STALE_SECS', 'VC_DOUBLE_DIAL_ATTEMPTS',
  'VC_TAG_FIELDS', 'VC_WAIT_UNITS', 'VC_STEP_TYPES',
  'vcNormalizeGroups', 'vcLeadFieldValue', 'vcConditionMatches',
  'vcMatchesTriggerGroups', 'vcValidateTriggerGroups',
  'vcWaitMs', 'vcWaitLabel', 'vcStepDueAt', 'vcStepsSorted', 'vcFirstStep',
  'vcStepAt', 'vcNextStep', 'vcDripActive',
  'vcSlotsInUse', 'vcSlotsFree', 'vcSlotsLabel',
  'vcCampaignStats', 'vcStopReasonLabel', 'vcEnrollSummary',
  // The manual "Add to campaign" door's screen-side half.
  'VC_ENROLL_TAG_FIELD', 'vcCampaignTag', 'vcTagLabel', 'vcAutoEnrollPhrase',
];

function loadCore() {
  const m = APP.match(/\/\/ <vcamp-core>([\s\S]*?)\/\/ <\/vcamp-core>/);
  assert.ok(m, 'app.html must contain the // <vcamp-core> … // </vcamp-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

// ============================================================
// 1. PARITY
// ============================================================

const LEADS = [
  { id: 'l1', data: { lead_type: 'veteran', state: 'TX', status: 'new' }, tcpa_consent: true, dnc: false },
  { id: 'l2', data: { coverage_wanted: 'Final Expense', state: 'FL', status: 'called' }, tcpa_consent: true, dnc: false },
  { id: 'l3', data: { tags: ['Veteran', 'hot'], state: 'TX' }, tcpa_consent: false, dnc: false },
  { id: 'l4', data: { source: 'mortgage-form', state: 'NY' }, tcpa_consent: true, dnc: true },
  { id: 'l5', data: { name: 'Nobody' }, tcpa_consent: true, dnc: false },
  { id: 'l6', data: { type: 'iul', state: '  tx  ' }, tcpa_consent: true, dnc: false },
  { id: 'l7', data: { campaign_tag: 'Trucker', status: 'sold' }, tcpa_consent: true, dnc: false },
];

const RULES = [
  [],
  null,
  'not-an-array',
  [{ conditions: [] }],
  [[]],
  [[{ field: 'lead_type', op: 'is', value: 'veteran' }]],
  [{ conditions: [{ field: 'lead_type', op: 'is', value: 'veteran' }] }],
  [{ conditions: [{ field: 'lead_type', op: 'is', value: 'VETERAN' }, { field: 'state', op: 'is', value: 'tx' }] }],
  [{ conditions: [{ field: 'lead_type', op: 'is', value: 'veteran' }, { field: 'state', op: 'is_not', value: 'TX' }] }],
  [{ conditions: [{ field: 'tags', op: 'is', value: 'veteran' }] }],
  [{ conditions: [{ field: 'tags', op: 'is_not', value: 'cold' }] }],
  [{ conditions: [{ field: 'campaign_tag', op: 'is', value: 'trucker' }] }],
  [{ conditions: [{ field: 'source', op: 'is', value: 'mortgage-form' }] }],
  [{ conditions: [{ field: 'status', op: 'is', value: 'new' }] }],
  [{ conditions: [{ field: 'lead_type', op: 'is_not', value: 'trucker' }] }],
  [{ conditions: [{ field: '', op: 'is', value: 'x' }] }],
  [{ conditions: [{ field: 'lead_type', op: 'is', value: '' }] }],
  [{ conditions: [{ field: 'lead_type', op: 'weird', value: 'x' }] }],
  [
    { conditions: [{ field: 'lead_type', op: 'is', value: 'veteran' }] },
    { conditions: [{ field: 'coverage_wanted', op: 'is', value: 'final expense' }] },
  ],
  [
    { conditions: [{ field: 'lead_type', op: 'is', value: 'veteran' }] },
    { conditions: [{ field: 'state', op: 'is', value: 'FL' }] },
  ],
  [{ conditions: [{ field: 'tcpa_consent', op: 'is', value: 'true' }] }],
];

test('PARITY: vcMatchesTriggerGroups agrees on every lead × rule', () => {
  let checked = 0;
  for (const rule of RULES) {
    for (const lead of LEADS) {
      const a = SRV.vcMatchesTriggerGroups(lead, rule);
      const b = B.vcMatchesTriggerGroups(lead, rule);
      assert.equal(b, a, `lead ${lead.id} vs ${JSON.stringify(rule)}`);
      checked++;
    }
  }
  assert.ok(checked >= 140, `only ${checked} cases`);
});

test('PARITY: vcValidateTriggerGroups agrees, including the per-group messages', () => {
  for (const rule of RULES) {
    const a = SRV.vcValidateTriggerGroups(rule);
    const b = B.vcValidateTriggerGroups(rule);
    assert.equal(b.ok, a.ok, JSON.stringify(rule));
    assert.equal(b.error, a.error, JSON.stringify(rule));
    assert.deepEqual(b.groupErrors, a.groupErrors, JSON.stringify(rule));
  }
});

test('PARITY: vcNormalizeGroups agrees', () => {
  for (const rule of RULES) {
    assert.deepEqual(B.vcNormalizeGroups(rule), SRV.vcNormalizeGroups(rule), JSON.stringify(rule));
  }
});

test('PARITY: vcLeadFieldValue agrees on every field × lead', () => {
  const fields = [
    'lead_type', 'coverage_wanted', 'tags', 'campaign_tag', 'source', 'state',
    'status', 'tcpa_consent', 'dnc', 'name', 'nonexistent', '',
  ];
  for (const lead of LEADS) {
    for (const f of fields) {
      assert.deepEqual(B.vcLeadFieldValue(lead, f), SRV.vcLeadFieldValue(lead, f), `${lead.id}.${f}`);
    }
  }
});

test('PARITY: wait maths and labels agree', () => {
  const values = [-5, 0, 1, 2, 7, 60, 999, 'x', null, undefined];
  const units = ['minutes', 'hours', 'days', 'fortnights', '', null];
  for (const v of values) {
    for (const u of units) {
      assert.equal(B.vcWaitMs(v, u), SRV.vcWaitMs(v, u), `${v} ${u}`);
      const step = { position: 1, wait_value: v, wait_unit: u };
      assert.equal(B.vcWaitLabel(step), SRV.vcWaitLabel(step), `${v} ${u}`);
      const from = new Date('2026-07-30T15:00:00.000Z');
      assert.equal(
        B.vcStepDueAt(from, step).toISOString(),
        SRV.vcStepDueAt(from, step).toISOString(),
        `${v} ${u}`,
      );
    }
  }
});

test('PARITY: step ordering agrees, including sparse and duplicate positions', () => {
  const sets = [
    [],
    [{ position: 1 }],
    [{ position: 3 }, { position: 1 }, { position: 2 }],
    [{ position: 9 }, { position: 2 }, { position: 5 }],
    [{ position: 2 }, { position: 2 }],
  ];
  for (const steps of sets) {
    assert.deepEqual(
      B.vcStepsSorted(steps).map(s => s.position),
      SRV.vcStepsSorted(steps).map(s => s.position),
    );
    assert.deepEqual(B.vcFirstStep(steps), SRV.vcFirstStep(steps));
    for (const p of [0, 1, 2, 5, 9, 99]) {
      assert.deepEqual(B.vcStepAt(steps, p), SRV.vcStepAt(steps, p), `at ${p}`);
      assert.deepEqual(B.vcNextStep(steps, p), SRV.vcNextStep(steps, p), `next ${p}`);
    }
  }
});

test('PARITY: slot counting agrees, stale window included', () => {
  const now = new Date('2026-07-30T15:00:00.000Z');
  const at = (mins) => new Date(now.getTime() - mins * 60000).toISOString();
  const sets = [
    [],
    [{ status: 'in_progress', created_at: at(0) }],
    [{ status: 'in_progress', created_at: at(0) }, { status: 'in_progress', created_at: at(5) }],
    [{ status: 'completed', created_at: at(0) }],
    [{ status: 'in_progress', created_at: at(0), ended_at: at(0) }],
    [{ status: 'in_progress', created_at: at(39) }],
    [{ status: 'in_progress', created_at: at(41) }],
    [{ status: 'in_progress', created_at: null }],
    [
      { status: 'in_progress', created_at: at(1) },
      { status: 'in_progress', created_at: at(2) },
      { status: 'in_progress', created_at: at(3) },
      { status: 'in_progress', created_at: at(4) },
    ],
  ];
  for (const s of sets) {
    const a = SRV.vcSlotsInUse(s, now);
    assert.equal(B.vcSlotsInUse(s, now), a, JSON.stringify(s));
    assert.equal(B.vcSlotsFree(a), SRV.vcSlotsFree(a));
    assert.equal(B.vcSlotsLabel(a), SRV.vcSlotsLabel(a));
  }
});

test('PARITY: stats, stop labels and the enrollment summary agree', () => {
  const sets = [
    [],
    [{ status: 'active', calls_placed: 2, answers: 1, appointments: 0 }],
    [
      { status: 'active', calls_placed: 2, answers: 1, appointments: 0 },
      { status: 'completed', calls_placed: 6, answers: 2, appointments: 1 },
      { status: 'stopped', calls_placed: 1, answers: 0, appointments: 0 },
      { status: 'paused', calls_placed: 0, answers: 0, appointments: 0 },
    ],
  ];
  for (const s of sets) assert.deepEqual(B.vcCampaignStats(s), SRV.vcCampaignStats(s));

  for (const r of ['dnc', 'appointment_booked', 'sold', 'answered', 'manual', 'unknown_thing', null, '']) {
    assert.equal(B.vcStopReasonLabel(r), SRV.vcStopReasonLabel(r), String(r));
  }

  const skips = [
    {}, { no_consent: 3 }, { no_consent: 2, dnc: 1 },
    { already_enrolled: 5, suppressed: 2, no_phone: 1 }, { weird_reason: 4 },
  ];
  for (const n of [0, 1, 12]) {
    for (const s of skips) {
      assert.equal(B.vcEnrollSummary(n, s), SRV.vcEnrollSummary(n, s), `${n} ${JSON.stringify(s)}`);
    }
  }
});

test('PARITY: the constants are literally the same', () => {
  assert.equal(B.VC_SLOT_LIMIT, SRV.VC_SLOT_LIMIT);
  assert.equal(B.VC_INFLIGHT_STALE_SECS, SRV.VC_INFLIGHT_STALE_SECS);
  assert.equal(B.VC_DOUBLE_DIAL_ATTEMPTS, SRV.VC_DOUBLE_DIAL_ATTEMPTS);
  assert.deepEqual(B.VC_TAG_FIELDS, SRV.VC_TAG_FIELDS);
  assert.deepEqual(B.VC_WAIT_UNITS, SRV.VC_WAIT_UNITS);
  assert.deepEqual(B.VC_STEP_TYPES, SRV.VC_STEP_TYPES);
});

test('PARITY: drip activation agrees', () => {
  const drips = [
    null, undefined, {}, { per_minutes: 60 }, { max_calls: 20 },
    { per_minutes: 60, max_calls: 20 }, { per_minutes: 0, max_calls: 20 },
    { per_minutes: 60, max_calls: 0 }, { per_minutes: '60', max_calls: '20' },
  ];
  for (const d of drips) assert.equal(B.vcDripActive(d), SRV.vcDripActive(d), JSON.stringify(d));
});

// ============================================================
// 2. BEHAVIOUR — the shipped browser text
// ============================================================

test('the editor refuses a rule with no positive tag condition', () => {
  const v = B.vcValidateTriggerGroups([{ conditions: [{ field: 'state', op: 'is', value: 'TX' }] }]);
  assert.equal(v.ok, false);
  assert.match(v.error, /lead type or campaign tag/i);
});

test('the editor refuses an is_not tag condition as the only tag', () => {
  const v = B.vcValidateTriggerGroups([{ conditions: [{ field: 'tags', op: 'is_not', value: 'trucker' }] }]);
  assert.equal(v.ok, false, 'excluding a sliver admits everyone else — the campaign nobody meant to build');
});

test('an empty rule matches nobody on screen too', () => {
  for (const lead of LEADS) {
    assert.equal(B.vcMatchesTriggerGroups(lead, []), false);
    assert.equal(B.vcMatchesTriggerGroups(lead, [{ conditions: [] }]), false);
  }
});

test('the slot label never exceeds the limit', () => {
  assert.equal(B.vcSlotsLabel(99), '3/3 active');
  assert.equal(B.vcSlotsLabel(-4), '0/3 active');
});

// ============================================================
// 3. STRUCTURE
// ============================================================

test('the vcamp-core sentinel appears exactly once', () => {
  // The harness extracts by lazy match, so a second mention swallows the file.
  assert.equal((APP.match(/\/\/ <vcamp-core>/g) || []).length, 1);
  assert.equal((APP.match(/\/\/ <\/vcamp-core>/g) || []).length, 1);
});

test('the vcamp-core block is pure — no DOM, network, storage or app globals', () => {
  const m = APP.match(/\/\/ <vcamp-core>([\s\S]*?)\/\/ <\/vcamp-core>/);
  const src = m[1]
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
  for (const forbidden of [
    'document.', 'window.', 'localStorage', 'sessionStorage', 'fetch(',
    'sb.', 'currentAgent', 'showToast', 'vcampState',
  ]) {
    assert.ok(!src.includes(forbidden), `vcamp-core must not reference ${forbidden}`);
  }
});

test('the campaign editor never writes an enrollment directly', () => {
  // Enrollments are SELECT-only; every write is voice-campaign-manage.
  const writes = APP.match(/from\('voice_campaign_enrollments'\)\s*\n?\s*\.(insert|update|upsert|delete)/g) || [];
  assert.deepEqual(writes, [], 'an enrollment is a standing instruction to phone a consumer');
});

test('every enrollment mutation goes through voice-campaign-manage', () => {
  const invokes = APP.match(/invoke\('voice-campaign-manage'/g) || [];
  assert.ok(invokes.length >= 3, 'unenroll, resume and re-evaluate');
});

test('the browser never calls voice-campaign-tick', () => {
  assert.ok(
    !APP.includes('voice-campaign-tick'),
    'the tick is a cron endpoint authenticated by a shared secret — a browser has no business there',
  );
});

test('activation validates the rule before it can be switched on', () => {
  const fn = APP.slice(APP.indexOf('async function vcampToggleActive'), APP.indexOf('async function vcampResume'));
  assert.ok(fn.includes('vcValidateTriggerGroups'), 'the Active toggle must run the validator');
  assert.ok(
    fn.indexOf('vcValidateTriggerGroups') < fn.indexOf(".update("),
    'and it must run BEFORE the write',
  );
  assert.ok(fn.includes('steps.length'), 'a campaign with no steps can never do anything');
});

test('the per-number inbound toggle is scoped to the signed-in agent', () => {
  const fn = APP.slice(APP.indexOf('async function pbSetAiInbound'), APP.indexOf('async function pbSetNumberAsPrimary'));
  assert.ok(fn.includes("ai_inbound_enabled"));
  assert.ok(fn.includes(".eq('agent_id', currentAgent.id)"), 'never let a browser flip somebody else\'s number');
});

test('the migration keeps enrollments SELECT-only and campaigns owner-writable', () => {
  const enrol = (MIG.match(/on public\.voice_campaign_enrollments\s+for \w+/g) || [])
    .map(s => s.replace(/\s+/g, ' '));
  assert.deepEqual(enrol, ['on public.voice_campaign_enrollments for select']);

  // `for (select|insert|update|delete)` only — `for each row` belongs to the
  // trigger definitions, not to a policy.
  const camp = (MIG.match(/on public\.voice_campaigns\s+for (select|insert|update|delete)/g) || [])
    .map(s => s.replace(/\s+/g, ' ').split(' for ')[1]).sort();
  assert.deepEqual(camp, ['delete', 'insert', 'select', 'update']);
});

test('one lead may be ACTIVE in only one voice campaign, enforced by an index', () => {
  assert.ok(
    /create unique index[\s\S]{0,200}voice_campaign_enrollments \(lead_id\)[\s\S]{0,80}where status = 'active'/.test(MIG),
    'two robots in one afternoon, and neither campaign\'s numbers mean anything afterwards',
  );
});

test('the tag rule is enforced in the database as well as the browser', () => {
  assert.ok(MIG.includes('voice_campaigns_validate'));
  for (const f of SRV.VC_TAG_FIELDS) {
    assert.ok(MIG.includes(`'${f}'`), `${f} must be in the SQL tag_fields array`);
  }
  // Only a POSITIVE condition counts, in SQL too.
  assert.ok(/coalesce\(cond->>'op', 'is'\) = 'is'/.test(MIG));
});

test("the validator only fires for ACTIVE campaigns — a draft may be half-written", () => {
  const fn = MIG.slice(MIG.indexOf('create or replace function public.voice_campaigns_validate'), MIG.indexOf('drop trigger if exists voice_campaigns_validate'));
  assert.ok(/if new\.active is not true then\s+return new;/.test(fn));
});

test('steps derive their agent from the campaign, never from the client', () => {
  assert.ok(MIG.includes('voice_campaign_steps_derive'));
  const fn = MIG.slice(MIG.indexOf('create or replace function public.voice_campaign_steps_derive'), MIG.indexOf('drop trigger if exists voice_campaign_steps_derive'));
  assert.ok(fn.includes('select agent_id into owner from public.voice_campaigns'));
  assert.ok(fn.includes('new.agent_id   := owner;'));
});

test('ai_calls links back to the enrollment that asked for the call', () => {
  assert.ok(/alter table public\.ai_calls[\s\S]{0,400}enrollment_id uuid/.test(MIG));
  assert.ok(MIG.includes('campaign_step integer'));
});

// ============================================================
// 4. THE MANUAL DOOR — "Add to campaign"
//
// Three entry points (a leads-tab selection, the CSV importer, the Add Lead
// modal) that must all be the SAME door. The bug this section exists to
// prevent is the obvious one: a second way in that forgets a gate.
// ============================================================

const MANAGE = readFileSync(join(ROOT, 'supabase/functions/voice-campaign-manage/index.ts'), 'utf8');

test('the tag rule and the card copy agree between browser and server', () => {
  const campaigns = [
    null,
    {},
    { trigger_groups: [{ conditions: [{ field: 'campaign_tag', op: 'is', value: 'final_expense' }] }] },
    { trigger_groups: [{ conditions: [{ field: 'campaign_tag', op: 'is_not', value: 'veteran' }] }] },
    { trigger_groups: [{ conditions: [{ field: 'lead_type', op: 'is', value: 'veteran' }] }] },
    { trigger_groups: [{ conditions: [{ field: 'coverage_wanted', op: 'is', value: '25000' }] }] },
    {
      trigger_groups: [
        { conditions: [{ field: 'campaign_tag', op: 'is', value: 'veteran' }] },
        { conditions: [{ field: 'campaign_tag', op: 'is', value: 'trucker' }] },
      ],
    },
    {
      trigger_groups: [
        { conditions: [{ field: 'campaign_tag', op: 'is', value: 'iul' }] },
        { conditions: [{ field: 'lead_type', op: 'is', value: 'iul' }] },
      ],
      auto_enroll_new_leads: true,
    },
    { trigger_on_sold: true, trigger_groups: [{ conditions: [{ field: 'status', op: 'is', value: 'sold' }] }] },
    { trigger_on_missed_appointment: true },
    { trigger_on_appointment_booked: true },
    { auto_enroll_new_leads: true, trigger_on_sold: true, trigger_on_appointment_booked: true, trigger_on_missed_appointment: true },
  ];
  for (const c of campaigns) {
    const label = JSON.stringify(c);
    assert.equal(B.vcCampaignTag(c), SRV.vcCampaignTag(c), `vcCampaignTag disagrees on ${label}`);
    assert.equal(B.vcAutoEnrollPhrase(c), SRV.vcAutoEnrollPhrase(c), `vcAutoEnrollPhrase disagrees on ${label}`);
  }
  for (const tag of ['', null, 'iul', 'veteran', 'final_expense', 'mortgage-protection', 'GENERAL_LIFE', '  trucker  ']) {
    assert.equal(B.vcTagLabel(tag), SRV.vcTagLabel(tag), `vcTagLabel disagrees on ${JSON.stringify(tag)}`);
  }
  assert.equal(B.VC_ENROLL_TAG_FIELD, SRV.VC_ENROLL_TAG_FIELD);
});

test('the only lead field the manual door writes is campaign_tag', () => {
  // The other four VC_TAG_FIELDS carry real data in the production book —
  // coverage_wanted holds dollar amounts, source holds vendor names. Writing
  // either to tidy up a join would corrupt the book.
  assert.equal(SRV.VC_ENROLL_TAG_FIELD, 'campaign_tag');
  for (const f of SRV.VC_TAG_FIELDS) {
    if (f === 'campaign_tag') continue;
    assert.equal(SRV.vcCampaignTag({ trigger_groups: [{ conditions: [{ field: f, op: 'is', value: 'x' }] }] }), '',
      `a rule on ${f} must never produce a tag write`);
  }
});

test('the browser holds NO copy of the enrollment gate', () => {
  // Consent, DNC, suppression and the one-active-campaign rule are decided by
  // vcEvaluateEnrollment on the server, once. A browser-side re-derivation
  // would be a second opinion that drifts, and the drift would be in the
  // direction of showing a green button for a call the server refuses.
  //
  // Comments are stripped: naming the server's function in a comment that
  // explains WHY it is not here is the opposite of the problem.
  const code = APP.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(!code.includes('vcEvaluateEnrollment'), 'the gate belongs to the server');
  assert.ok(!code.includes('vcPlanManualEnrollment'), 'the planner belongs to the server');
  assert.ok(!/from\('suppression_list'\)/.test(code),
    'the browser cannot see the suppression list and must not pretend to');
});

test('all three doors go through one function, and it goes through the endpoint', () => {
  // atcEnroll() is the single place the browser asks for an enrollment.
  const previews = APP.match(/action:\s*opts\.preview\s*\?\s*'preview_enroll'\s*:\s*'enroll_leads'/g) || [];
  assert.equal(previews.length, 1, 'exactly one place builds the enroll request');

  // Nobody else names the actions.
  assert.equal((APP.match(/'enroll_leads'/g) || []).length, 1);
  assert.equal((APP.match(/'preview_enroll'/g) || []).length, 1);

  // And the three doors all reach it.
  for (const caller of ['atcConfirm', 'atcEnrollByClientIds']) {
    assert.ok(APP.includes(`function ${caller}`) || APP.includes(`async function ${caller}`), `${caller} must exist`);
  }
  assert.ok(/async function atcConfirm[\s\S]{0,2000}atcEnroll\(/.test(APP), 'the leads-tab door calls atcEnroll');
  assert.ok(/async function atcEnrollByClientIds[\s\S]{0,1500}atcEnroll\(/.test(APP), 'the importer / Add Lead door calls atcEnroll');
  assert.ok(/async function saveManualLead[\s\S]{0,6000}atcEnrollByClientIds\(/.test(APP), 'the Add Lead modal chains in');
  assert.ok(/async function csvApplyCampaign[\s\S]{0,1200}atcEnrollByClientIds\(/.test(APP), 'the importer chains in');
});

test('the leads tab offers the button beside Record consent', () => {
  assert.ok(APP.includes('onclick="openAddToCampaignModal()"'), 'the bulk bar needs the door');
  const bar = APP.slice(APP.indexOf('id="lead-bulk-bar"'), APP.indexOf('id="lead-select-all-row"'));
  assert.ok(bar.includes('openConsentModal()'));
  assert.ok(bar.includes('openAddToCampaignModal()'), 'and it must be IN the bulk bar, next to consent');
});

test('the importer records consent through the consent tool, not a copy of it', () => {
  // "One implementation, never two" — the importer's consent step opens the
  // same modal, so the sentence the agent puts their name to exists once.
  assert.ok(/function csvOpenConsentStep[\s\S]{0,1200}openConsentModal\(/.test(APP));
  // Exactly THREE leads-consent call sites, and the importer added none of
  // them: the bulk modal's grant, the per-lead revoke, and the Phase 1 AI
  // test rig (which goes through this endpoint deliberately — exempting it
  // would have left a hole shaped like that one function).
  assert.equal((APP.match(/invoke\('leads-consent'/g) || []).length, 3,
    'the importer must not add a fourth leads-consent call site');
  // And the attestation still appears once, in the modal's markup.
  assert.equal(
    (APP.match(/gave prior express consent to be contacted by phone/g) || []).length, 2,
    'the sentence lives in the modal and in the constant that mirrors the server — nowhere else',
  );
});

test('a chained consent scope is always cleared', () => {
  // A stale scope would record consent against the wrong leads on the next
  // ordinary press of the button — the worst bug this modal could have.
  const fn = APP.slice(APP.indexOf('function closeConsentModal'), APP.indexOf('function consentSourceChange'));
  assert.ok(fn.includes('_consentScope = null'), 'closing must drop the scope');
  assert.ok(fn.indexOf('_consentScope = null') < fn.indexOf('if (back)'),
    'and drop it BEFORE handing control back, so a callback cannot inherit it');
});

test('the server takes the agent from the JWT for the new actions too', () => {
  const block = MANAGE.slice(MANAGE.indexOf('preview_enroll'), MANAGE.indexOf('reevaluate — run the rules'));
  assert.ok(!/body\.agent_id/.test(MANAGE), 'there is no agent id in the body, ever');
  for (const scoped of ['.eq("agent_id", user.id)']) {
    assert.ok(block.includes(scoped), 'every read is re-scoped to the caller');
  }
  assert.ok(block.includes('.eq("id", campaignId)') && block.includes('.eq("agent_id", user.id)'),
    'the campaign id is a selection, not a boundary');
});

test('preview and write are the same plan', () => {
  const block = MANAGE.slice(MANAGE.indexOf('if (action === "preview_enroll"'), MANAGE.indexOf('// reevaluate — run the rules'));
  assert.equal((block.match(/vcPlanManualEnrollment\(/g) || []).length, 1,
    'one planner call serves both actions — a second would be a preview that drifts');
  assert.ok(block.indexOf('if (!write)') > block.indexOf('vcPlanManualEnrollment('),
    'the split happens AFTER the plan is made, not before');
});

test('a move stops the old enrollment before the new one is written', () => {
  const block = MANAGE.slice(MANAGE.indexOf('// ---- Write ---'), MANAGE.indexOf('// ---- The tag ---'));
  assert.ok(block.includes('"moved_by_user"'), 'a move is recorded as a move');
  assert.ok(block.indexOf('moved_by_user') < block.indexOf('.upsert(rows'),
    'the opposite order leaves a window where the lead is active in two campaigns at once');
  assert.ok(block.includes('.eq("status", "active")'), 'only an ACTIVE enrollment can be moved');
});

test('the manual door reimplements no CALL-TIME gate', () => {
  // Same rule the tick lives under: consent/DNC/suppression are decided by
  // vcEvaluateEnrollment, and everything about money, quiet hours and caps
  // belongs to ai-call-start.
  for (const forbidden of [
    'balance_mills', 'wallet_accounts', 'ai_daily_call_cap', 'evaluateDailyPace',
    'isWithinAllowedHours', 'api.telnyx.com',
  ]) {
    assert.ok(!MANAGE.includes(forbidden), `voice-campaign-manage must not reference ${forbidden}`);
  }
});

test('the enrolled_by value the manual door writes is one the schema allows', () => {
  const allowed = MIG.match(/enrolled_by\s+text not null default 'auto'\s*\n?\s*check \(enrolled_by in \(([^)]*)\)\)/);
  assert.ok(allowed, 'the CHECK constraint must still be there');
  const values = allowed[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.ok(values.includes('manual'), 'manual must be a permitted enrolled_by');
  assert.ok(/enrolled_by: "manual"/.test(MANAGE), 'and it is what the manual door writes');
});
