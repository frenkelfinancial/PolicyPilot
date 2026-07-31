// ============================================================
// default-campaigns.test.mjs — run with:  npm run test:defaultcampaigns
//
// The twelve pre-built voice campaigns, the seeder that installs them, and the
// bulk consent tool that is the only thing standing between them and a dial.
//
// Four kinds of test:
//
//   1. THE TWELVE THEMSELVES. The seed JSON is extracted out of the migration
//      text — it lives in exactly one place, inside vc_default_campaigns() —
//      and every rule is run through the REAL matcher and the REAL validator
//      from voice-campaign-core.ts, against synthetic leads of each type. A
//      campaign whose rule matches nobody, or matches everybody, fails here.
//
//   2. THE SEEDER'S THREE PROMISES, as source text: re-running adds nothing;
//      a deactivated or edited campaign is never overwritten; a DELETED one is
//      never resurrected. The third is the one that needs a tombstone table,
//      and it is the one worth breaking a build over — resurrecting a campaign
//      somebody deleted restarts a program that phones consumers.
//
//   3. APPOINTMENT-ANCHORED STEP MATH, including the skip-if-past rule, run
//      through both the server core and the extracted browser core.
//
//   4. THE CONSENT TOOL's boundaries: the attestation, the agent from the JWT,
//      the append-only ledger, and the column guard that makes the endpoint
//      the only door.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as SRV from '../supabase/functions/_shared/voice-campaign-core.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Normalised to LF: these files are edited on Windows, and a source-text
// assertion that depends on the line ending is a test that passes on one
// machine and fails on the next.
const read = (p) => readFileSync(join(ROOT, p), 'utf8').split('\r\n').join('\n');

const APP      = read('app.html');
const MIG      = read('supabase/migrations/20260803_default_voice_campaigns.sql');
const TICK     = read('supabase/functions/voice-campaign-tick/index.ts');
const CONSENT  = read('supabase/functions/leads-consent/index.ts');
const START    = read('supabase/functions/ai-call-start/index.ts');
const WEBHOOK  = read('supabase/functions/ai-call-webhook/index.ts');
const DOC      = read('docs/ai-assistant-script-v1.md');

/** Drops comment lines so a rule stated in prose is not mistaken for code. */
const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');

// ------------------------------------------------------------
// The seed JSON, straight out of the migration. One copy, and this is it.
// ------------------------------------------------------------
function loadDefaults() {
  const m = MIG.match(/\$json\$([\s\S]*?)\$json\$::jsonb/);
  assert.ok(m, 'the migration must carry the twelve inside a $json$…$json$::jsonb literal');
  return JSON.parse(m[1]);
}
const DEFAULTS = loadDefaults();

// The browser core, executed verbatim — the exact text that ships.
const BROWSER_EXPORTS = [
  'VC_TAG_FIELDS', 'VC_LIFECYCLE_STATUSES', 'VC_STEP_ANCHORS', 'VC_CAMPAIGN_GOALS',
  'vcIsNarrowingCondition', 'vcValidateTriggerGroups', 'vcMatchesTriggerGroups',
  'vcStepIsAnchored', 'vcAnchoredDueAt', 'vcStepDueAt', 'vcResolveNextDue',
  'vcStepScheduleLabel', 'vcWaitLabel', 'vcCampaignGoal', 'vcStepsSorted',
];
function loadBrowserCore() {
  const m = APP.match(/\/\/ <vcamp-core>([\s\S]*?)\/\/ <\/vcamp-core>/);
  assert.ok(m, 'app.html must contain the // <vcamp-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${BROWSER_EXPORTS.join(',')}};`)();
}
const B = loadBrowserCore();

// ============================================================
// 1. The twelve
// ============================================================

// The step counts come from the Orion teardown (docs/ORION_GAP_ANALYSIS.md
// § 1.4). They are in the table because a campaign quietly losing half its
// cadence is invisible on screen.
const EXPECTED = {
  chargeback_recovery_v1:   { name: 'Chargeback Recovery',  steps: 9 },
  emergency_contact_v1:     { name: 'Emergency Contact',    steps: 5 },
  beneficiary_referral_v1:  { name: 'Beneficiary Referral', steps: 5 },
  customer_care_sold_v1:    { name: 'Customer Care',        steps: 6 },
  no_show_followup_v1:      { name: 'No-Show Follow-up',    steps: 5 },
  appointment_reminder_v1:  { name: 'Appointment Reminder', steps: 2 },
  trucker_v1:               { name: 'Trucker',              steps: 6 },
  iul_v1:                   { name: 'IUL',                  steps: 6 },
  mortgage_protection_v1:   { name: 'Mortgage Protection',  steps: 6 },
  general_life_v1:          { name: 'General Life',         steps: 6 },
  final_expense_v1:         { name: 'Final Expense',        steps: 6 },
  veteran_lead_v1:          { name: 'Veteran Lead',         steps: 6 },
};

test('there are exactly twelve, with the step counts the teardown specified', () => {
  assert.equal(DEFAULTS.length, 12);
  const bySeed = new Map(DEFAULTS.map((d) => [d.seed_key, d]));
  for (const [key, want] of Object.entries(EXPECTED)) {
    const d = bySeed.get(key);
    assert.ok(d, `missing default campaign ${key}`);
    assert.equal(d.name, want.name, `${key} name`);
    assert.equal((d.steps || []).length, want.steps, `${key} step count`);
  }
  assert.equal(bySeed.size, 12, 'seed_key must be unique across the twelve');
});

test('every campaign has a unique sort_order, so the cards and the tick agree on an order', () => {
  const orders = DEFAULTS.map((d) => d.sort_order);
  assert.equal(new Set(orders).size, 12, 'sort_order must be unique — it decides which of the three sold-triggered campaigns takes a client first');
  for (const o of orders) assert.equal(typeof o, 'number');
});

test('every rule passes the guard — on the server AND in the editor', () => {
  for (const d of DEFAULTS) {
    const srv = SRV.vcValidateTriggerGroups(d.trigger_groups);
    const brw = B.vcValidateTriggerGroups(d.trigger_groups);
    assert.equal(srv.ok, true, `${d.seed_key}: ${srv.error}`);
    assert.equal(brw.ok, true, `${d.seed_key} (browser): ${brw.error}`);
  }
});

test('every campaign_goal is one the assistant knows about', () => {
  for (const d of DEFAULTS) {
    assert.ok(
      SRV.VC_CAMPAIGN_GOALS.includes(d.campaign_goal),
      `${d.seed_key} has goal "${d.campaign_goal}", which is not in VC_CAMPAIGN_GOALS`,
    );
  }
});

test('every campaign names at least one enrollment trigger — a campaign with none enrols nobody, for ever', () => {
  for (const d of DEFAULTS) {
    const any = d.auto_enroll_new_leads || d.trigger_on_missed_appointment ||
      d.trigger_on_sold || d.trigger_on_appointment_booked;
    assert.ok(any, `${d.seed_key} has no enrollment trigger`);
  }
});

// ---- Trigger mapping, against synthetic leads of each type ------------------
//
// The book these were written against carries NO lead_type, NO tags and NO
// campaign_tag; `coverage_wanted` holds dollar amounts and `source` holds
// vendor names. So the rules are checked two ways: with the canonical tag
// applied, and with the natural words a vendor might already have written.

const lead = (data, extra = {}) => ({ id: 'x', data, tcpa_consent: true, dnc: false, ...extra });

const MATCH_CASES = [
  // seed_key,                 leads that MUST match
  ['veteran_lead_v1',          [{ campaign_tag: 'veteran' }, { lead_type: 'Veteran' }, { type: 'va' }]],
  ['final_expense_v1',         [{ campaign_tag: 'final_expense' }, { coverage_wanted: 'Final Expense' }, { lead_type: 'fex' }]],
  ['mortgage_protection_v1',   [{ campaign_tag: 'mortgage_protection' }, { lead_type: 'Mortgage Protection' }]],
  ['iul_v1',                   [{ campaign_tag: 'iul' }, { lead_type: 'IUL' }]],
  ['general_life_v1',          [{ campaign_tag: 'general_life' }, { lead_type: 'term life' }]],
  ['trucker_v1',               [{ campaign_tag: 'trucker' }, { lead_type: 'CDL' }]],
  ['chargeback_recovery_v1',   [{ campaign_tag: 'chargeback' }, { status: 'chargeback' }]],
  ['customer_care_sold_v1',    [{ status: 'sold' }]],
  ['emergency_contact_v1',     [{ status: 'sold' }]],
  ['beneficiary_referral_v1',  [{ status: 'sold' }]],
  ['appointment_reminder_v1',  [{ status: 'appointment' }]],
  ['no_show_followup_v1',      [{ status: 'appointment' }]],
];

test('each campaign matches leads of its own type, on the server and in the editor', () => {
  const bySeed = new Map(DEFAULTS.map((d) => [d.seed_key, d]));
  for (const [key, datas] of MATCH_CASES) {
    const d = bySeed.get(key);
    for (const data of datas) {
      const l = lead(data);
      assert.equal(SRV.vcMatchesTriggerGroups(l, d.trigger_groups), true,
        `${key} should match ${JSON.stringify(data)}`);
      assert.equal(B.vcMatchesTriggerGroups(l, d.trigger_groups), true,
        `${key} (browser) should match ${JSON.stringify(data)}`);
    }
  }
});

test('NO campaign matches an untagged lead — the twelve must never phone a whole book', () => {
  // Exactly the shape of every lead in the production book audited 2026-07-30:
  // a vendor name in `source`, a dollar amount or blank in `coverage_wanted`,
  // and `status: new`.
  const bookShapes = [
    { source: 'vrc', coverage_wanted: '', status: 'new', name: 'A' },
    { source: 'goat leads aged', coverage_wanted: '$25k - $50k', status: 'new' },
    { source: 'closr1', coverage_wanted: '', status: 'no_answer' },
    { source: 'imported', status: 'called' },
    { source: 'manual', status: 'not_interested' },
  ];
  for (const d of DEFAULTS) {
    for (const data of bookShapes) {
      assert.equal(SRV.vcMatchesTriggerGroups(lead(data), d.trigger_groups), false,
        `${d.seed_key} matched an untagged book lead: ${JSON.stringify(data)}`);
    }
  }
});

test('a lead-type campaign does not match a different lead type', () => {
  const bySeed = new Map(DEFAULTS.map((d) => [d.seed_key, d]));
  const vet = bySeed.get('veteran_lead_v1');
  const fex = bySeed.get('final_expense_v1');
  assert.equal(SRV.vcMatchesTriggerGroups(lead({ campaign_tag: 'trucker' }), vet.trigger_groups), false);
  assert.equal(SRV.vcMatchesTriggerGroups(lead({ campaign_tag: 'veteran' }), fex.trigger_groups), false);
});

test('the sold-triggered three do not also auto-enrol the book', () => {
  const sold = DEFAULTS.filter((d) => d.trigger_on_sold);
  assert.equal(sold.length, 3, 'exactly three campaigns trigger on a sale');
  for (const d of sold) {
    assert.equal(d.auto_enroll_new_leads, false,
      `${d.seed_key} must not auto-enrol: the sale is the trigger`);
  }
});

test('Customer Care never stops on "sold" — it is triggered BY the sale', () => {
  const care = DEFAULTS.find((d) => d.seed_key === 'customer_care_sold_v1');
  assert.equal(care.trigger_on_sold, true);
  assert.equal(care.stop_on_sold, false,
    'stop_on_sold on a sold-triggered campaign stops it the instant it starts');
  assert.equal(care.stop_on_answered, false, 'a check-in campaign is not trying to reach them once');
});

test('Appointment Reminder does not stop on the appointment that started it', () => {
  const rem = DEFAULTS.find((d) => d.seed_key === 'appointment_reminder_v1');
  assert.equal(rem.trigger_on_appointment_booked, true);
  assert.equal(rem.stop_on_appointment_booked, false,
    'the booked appointment IS the trigger; stopping on it would stop every enrollment at once');
  assert.equal(rem.steps.every((s) => s.anchor === 'appointment'), true);
});

test('only the Appointment Reminder uses anchored steps, and only it triggers on a booking', () => {
  for (const d of DEFAULTS) {
    const anchored = (d.steps || []).some((s) => s.anchor === 'appointment');
    assert.equal(anchored, d.seed_key === 'appointment_reminder_v1',
      `${d.seed_key}: anchored steps and the appointment trigger must travel together`);
    if (anchored) assert.equal(d.trigger_on_appointment_booked, true);
  }
});

test('every anchored step is BEFORE the appointment', () => {
  for (const d of DEFAULTS) {
    for (const s of d.steps || []) {
      if (s.anchor !== 'appointment') continue;
      assert.ok(s.offset_minutes < 0,
        `${d.seed_key} step ${s.position}: a reminder is scheduled before the appointment, not after`);
    }
  }
});

test('the lead-type campaigns are speed-to-lead: step 1 is inside a minute', () => {
  const speed = ['veteran_lead_v1', 'final_expense_v1', 'mortgage_protection_v1',
    'iul_v1', 'general_life_v1', 'trucker_v1'];
  const bySeed = new Map(DEFAULTS.map((d) => [d.seed_key, d]));
  for (const key of speed) {
    const first = bySeed.get(key).steps.find((s) => s.position === 1);
    assert.equal(first.wait_unit, 'minutes');
    assert.ok(first.wait_value <= 1, `${key} step 1 waits ${first.wait_value} ${first.wait_unit}`);
  }
});

test('step positions are 1..n with no gaps and no duplicates', () => {
  for (const d of DEFAULTS) {
    const pos = (d.steps || []).map((s) => s.position);
    assert.deepEqual(pos, pos.map((_, i) => i + 1), `${d.seed_key} step positions`);
  }
});

// ============================================================
// 2. The seeder's three promises
// ============================================================

test('the seeder claims through a tombstone table, not by looking for the campaign', () => {
  assert.match(MIG, /create table if not exists public\.voice_campaign_seed_state/);
  assert.match(MIG, /insert into public\.voice_campaign_seed_state \(agent_id, seed_key\)[\s\S]{0,120}on conflict \(agent_id, seed_key\) do nothing/);
  // FOUND after the ON CONFLICT insert is the whole idempotency story.
  assert.match(MIG, /if found then claimed := true; end if;/);
});

test('RE-SEEDING NEVER RESURRECTS A DELETED CAMPAIGN', () => {
  // The tombstone is never removed by anything automatic. If this ever finds a
  // delete, a re-seed would restart a program that phones consumers for an
  // agent who deliberately switched it off.
  const seedStateDeletes = MIG.match(/delete\s+from\s+public\.voice_campaign_seed_state/gi) || [];
  assert.equal(seedStateDeletes.length, 0,
    'nothing in the migration may delete a seed tombstone — that is what makes a delete stick');
});

test('RE-SEEDING NEVER OVERWRITES OR REACTIVATES AN EXISTING CAMPAIGN', () => {
  const fnStart = MIG.indexOf('function public.vc_seed_default_campaigns_for');
  const fnEnd = MIG.indexOf('revoke all on function public.vc_seed_default_campaigns_for');
  assert.ok(fnStart > 0 && fnEnd > fnStart, 'seeder function not found');
  const body = MIG.slice(fnStart, fnEnd);
  assert.ok(!/update\s+public\.voice_campaigns/i.test(body),
    'the seeder must never UPDATE a campaign — an agent who edited or deactivated one keeps their version');
  assert.ok(!/on conflict[\s\S]{0,80}do update/i.test(body),
    'the seeder must never upsert a campaign');
  assert.ok(!/delete\s+from\s+public\.voice_campaign/i.test(body),
    'the seeder must never delete a campaign or its steps');
  // And the belt to that braces: an existing row wearing the seed_key is left alone.
  assert.match(body, /if exists \([\s\S]{0,200}from public\.voice_campaigns c[\s\S]{0,300}continue;/);
});

test('the seeder creates the campaign and its steps in one transaction', () => {
  const fnStart = MIG.indexOf('function public.vc_seed_default_campaigns_for');
  const body = MIG.slice(fnStart, MIG.indexOf('revoke all on function public.vc_seed_default_campaigns_for'));
  assert.match(body, /insert into public\.voice_campaigns/);
  assert.match(body, /insert into public\.voice_campaign_steps/);
  // A campaign with no steps enrols nobody — it would be a live, permanently
  // empty card.
  assert.ok(body.indexOf('insert into public.voice_campaigns') <
            body.indexOf('insert into public.voice_campaign_steps'));
});

test('all twelve ship ACTIVE — and the screen has to say so', () => {
  const fnStart = MIG.indexOf('function public.vc_seed_default_campaigns_for');
  const body = MIG.slice(fnStart, MIG.indexOf('revoke all on function public.vc_seed_default_campaigns_for'));
  assert.match(body, /stop_answer_talk_secs, seed_key\s*\)\s*values \([\s\S]{0,120}\btrue\b/,
    'the seeder must insert active = true');
  // Active with no consented leads means nobody is called and nothing happens.
  // Saying so is the difference between honest and misleading.
  assert.match(APP, /Your campaigns are live/);
  assert.match(APP, /Record consent/);
});

test('the browser-callable seeder names no agent; the internal one is revoked', () => {
  assert.match(MIG, /create or replace function public\.vc_seed_default_campaigns\(\)/);
  assert.match(MIG, /return query select \* from public\.vc_seed_default_campaigns_for\(auth\.uid\(\)\)/);
  assert.match(MIG, /revoke all on function public\.vc_seed_default_campaigns_for\(uuid\) from public, anon, authenticated/);
  assert.match(MIG, /grant execute on function public\.vc_seed_default_campaigns\(\) to authenticated/);
  // The browser calls the no-argument form and nothing else.
  assert.ok(!/vc_seed_default_campaigns_for/.test(APP),
    'app.html must never call the agent-naming form');
});

test('a new agent gets the twelve, and a failure there cannot break sign-up', () => {
  assert.match(MIG, /create trigger agents_seed_voice_campaigns\s+after insert on public\.agents/);
  const fn = MIG.slice(MIG.indexOf('function public.agents_seed_voice_campaigns'));
  assert.match(fn.slice(0, 900), /exception when others then/,
    'the agent-creation hook must swallow its own failure — a sign-up must never fail over a default campaign');
});

test('the tombstone table is SELECT-only for authenticated', () => {
  const policies = MIG.match(/create policy "voice_campaign_seed_state_[^"]*"[\s\S]*?;/g) || [];
  assert.equal(policies.length, 1);
  assert.match(policies[0], /for select using \(auth\.uid\(\) = agent_id\)/);
});

// ============================================================
// 3. The lifecycle-status widening, and anchored step math
// ============================================================

test('the four lifecycle statuses agree in all THREE enforcement points', () => {
  assert.deepEqual(B.VC_LIFECYCLE_STATUSES, SRV.VC_LIFECYCLE_STATUSES);
  const m = MIG.match(/life_status\s+text\[\]\s*:=\s*array\[([^\]]*)\]/);
  assert.ok(m, 'the SQL validator must carry the lifecycle list');
  const sql = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(sql, SRV.VC_LIFECYCLE_STATUSES,
    'the browser, the server and the database must agree about which statuses narrow');
});

test('"status is new" is still refused — that exclusion is why status was left out', () => {
  for (const bad of ['new', 'called', 'no_answer', 'not_interested']) {
    const rule = [{ conditions: [{ field: 'status', op: 'is', value: bad }] }];
    assert.equal(SRV.vcValidateTriggerGroups(rule).ok, false, `status is ${bad} must not narrow`);
    assert.equal(B.vcValidateTriggerGroups(rule).ok, false, `status is ${bad} must not narrow (browser)`);
  }
});

test('"status is sold" narrows; "status is not sold" does not', () => {
  const good = [{ conditions: [{ field: 'status', op: 'is', value: 'sold' }] }];
  assert.equal(SRV.vcValidateTriggerGroups(good).ok, true);
  assert.equal(B.vcValidateTriggerGroups(good).ok, true);
  const bad = [{ conditions: [{ field: 'status', op: 'is_not', value: 'sold' }] }];
  assert.equal(SRV.vcValidateTriggerGroups(bad).ok, false,
    'is_not never narrows — it excludes a sliver and admits everyone else');
  assert.equal(B.vcValidateTriggerGroups(bad).ok, false);
});

test('PARITY: vcIsNarrowingCondition agrees on every field × op × value', () => {
  const fields = ['campaign_tag', 'tags', 'lead_type', 'coverage_wanted', 'source', 'status', 'state', ''];
  const values = ['sold', 'SOLD', ' appointment ', 'chargeback', 'lapsed', 'new', 'veteran', ''];
  for (const field of fields) {
    for (const op of ['is', 'is_not']) {
      for (const value of values) {
        const cond = { field, op, value };
        assert.equal(B.vcIsNarrowingCondition(cond), SRV.vcIsNarrowingCondition(cond),
          `disagreement on ${JSON.stringify(cond)}`);
      }
    }
  }
});

// ---- anchored math ---------------------------------------------------------

const NOW = new Date('2026-08-04T15:00:00.000Z');
const APPT = '2026-08-06T17:00:00.000Z';           // 50 hours after NOW
const REMINDER_STEPS = [
  { position: 1, step_type: 'call', anchor: 'appointment', offset_minutes: -1440 },
  { position: 2, step_type: 'call', anchor: 'appointment', offset_minutes: -120 },
];

test('an anchored step is due at the appointment plus its (negative) offset', () => {
  const due = SRV.vcAnchoredDueAt(REMINDER_STEPS[0], APPT);
  assert.equal(due.toISOString(), '2026-08-05T17:00:00.000Z');
  assert.equal(B.vcAnchoredDueAt(REMINDER_STEPS[0], APPT).toISOString(), due.toISOString());
});

test('with the appointment two days out, the FIRST reminder is the day-before one', () => {
  const r = SRV.vcResolveNextDue({ steps: REMINDER_STEPS, now: NOW, appointmentAt: APPT });
  assert.equal(r.reason, 'ok');
  assert.equal(r.step.position, 1);
  assert.equal(r.dueAt, '2026-08-05T17:00:00.000Z');
  assert.deepEqual(r.skipped, []);
});

test('SKIP-IF-PAST: a reminder whose moment has gone is skipped, never fired late', () => {
  // Ninety minutes before the appointment: the day-before step is long gone
  // and the two-hours-before step has also passed.
  const late = new Date('2026-08-06T15:30:00.000Z');
  const r = SRV.vcResolveNextDue({ steps: REMINDER_STEPS, now: late, appointmentAt: APPT });
  assert.equal(r.step, null);
  assert.equal(r.dueAt, null);
  assert.equal(r.reason, 'all_past');
  assert.deepEqual(r.skipped, [1, 2]);
  assert.deepEqual(B.vcResolveNextDue({ steps: REMINDER_STEPS, now: late, appointmentAt: APPT }), r);
});

test('SKIP-IF-PAST: one gone, one left — it lands on the survivor', () => {
  // Six hours before: step 1 (day before) has passed, step 2 (2h before) has not.
  const mid = new Date('2026-08-06T11:00:00.000Z');
  const r = SRV.vcResolveNextDue({ steps: REMINDER_STEPS, now: mid, appointmentAt: APPT });
  assert.equal(r.step.position, 2);
  assert.equal(r.dueAt, '2026-08-06T15:00:00.000Z');
  assert.deepEqual(r.skipped, [1]);
});

test('an anchored step with NO appointment resolves to nothing, not to "now"', () => {
  const r = SRV.vcResolveNextDue({ steps: REMINDER_STEPS, now: NOW, appointmentAt: null });
  assert.equal(r.step, null);
  assert.equal(r.reason, 'no_appointment');
  assert.deepEqual(B.vcResolveNextDue({ steps: REMINDER_STEPS, now: NOW, appointmentAt: null }), r);
});

test('an ORDINARY step is never skipped — its due time is computed forward from now', () => {
  const steps = [{ position: 1, step_type: 'call', wait_value: 1, wait_unit: 'minutes' }];
  const r = SRV.vcResolveNextDue({ steps, now: NOW });
  assert.equal(r.step.position, 1);
  assert.equal(r.dueAt, '2026-08-04T15:01:00.000Z');
  assert.deepEqual(r.skipped, []);
});

test('advancing past the last surviving reminder completes the enrollment', () => {
  const campaign = { stop_on_appointment_booked: false, stop_on_sold: false, stop_on_answered: false };
  const adv = SRV.vcAdvanceAfterCall({
    campaign,
    steps: REMINDER_STEPS,
    enrollment: { status: 'active', current_step_position: 2, step_attempts: 1, next_action_at: null },
    call: { outcome: 'no_answer', answered_at: null, ended_at: null },
    now: new Date('2026-08-06T15:05:00.000Z'),
    appointmentAt: APPT,
  });
  assert.equal(adv.decision, 'completed');
  assert.equal(adv.next_action_at, null);
});

test('advancing from step 1 lands on step 2 at the appointment-anchored instant', () => {
  const campaign = { stop_on_appointment_booked: false, stop_on_sold: false, stop_on_answered: false };
  const adv = SRV.vcAdvanceAfterCall({
    campaign,
    steps: REMINDER_STEPS,
    enrollment: { status: 'active', current_step_position: 1, step_attempts: 1, next_action_at: null },
    call: { outcome: 'no_answer', answered_at: null, ended_at: null },
    now: new Date('2026-08-05T17:00:30.000Z'),
    appointmentAt: APPT,
  });
  assert.equal(adv.decision, 'next_step');
  assert.equal(adv.current_step_position, 2);
  assert.equal(adv.next_action_at, '2026-08-06T15:00:00.000Z');
});

test('PARITY: the anchored schedule label agrees, and reads backwards', () => {
  const cases = [
    { anchor: 'appointment', offset_minutes: -1440 },
    { anchor: 'appointment', offset_minutes: -120 },
    { anchor: 'appointment', offset_minutes: -45 },
    { anchor: 'appointment', offset_minutes: 0 },
    { anchor: 'appointment', offset_minutes: 60 },
    { anchor: 'previous_step', wait_value: 3, wait_unit: 'days' },
    { anchor: 'previous_step', wait_value: 1, wait_unit: 'hours' },
  ];
  for (const s of cases) {
    assert.equal(B.vcStepScheduleLabel(s), SRV.vcStepScheduleLabel(s), JSON.stringify(s));
  }
  assert.equal(SRV.vcStepScheduleLabel(REMINDER_STEPS[0]), '1 day before the appointment');
  assert.equal(SRV.vcStepScheduleLabel(REMINDER_STEPS[1]), '2 hours before the appointment');
});

test('PARITY: vcCampaignGoal agrees, and blank means qualify', () => {
  for (const g of [...SRV.VC_CAMPAIGN_GOALS, '', null, undefined, 'nonsense', 'REMIND']) {
    const c = { campaign_goal: g };
    assert.equal(B.vcCampaignGoal(c), SRV.vcCampaignGoal(c), `goal ${g}`);
  }
  assert.equal(SRV.vcCampaignGoal({}), 'qualify');
  assert.equal(SRV.vcCampaignGoal({ campaign_goal: 'nonsense' }), 'qualify');
});

test('PARITY: the new constants are literally the same', () => {
  assert.deepEqual(B.VC_STEP_ANCHORS, SRV.VC_STEP_ANCHORS);
  assert.deepEqual(B.VC_CAMPAIGN_GOALS, SRV.VC_CAMPAIGN_GOALS);
});

// ---- the editor must not silently un-anchor a step -------------------------

test('the Steps tab carries anchor and offset through its delete-and-reinsert save', () => {
  // Saving that tab deletes and re-inserts every row. A save path that did not
  // name these two would turn "the day before" into "immediately" the first
  // time anybody opened the Appointment Reminder and pressed Save.
  const save = APP.slice(APP.indexOf('async function vcampSaveSteps'), APP.indexOf('// ---------- Enrollments tab ----------'));
  assert.match(save, /anchor:\s*VC_STEP_ANCHORS\.indexOf\(s\.anchor\)/);
  assert.match(save, /offset_minutes:\s*vcInt\(s\.offset_minutes, 0\)/);
});

// ============================================================
// 4. The engine wiring
// ============================================================

test('the tick still owns none of the gate chain', () => {
  // Unchanged from the previous round, re-asserted because this one added a
  // fourth trigger and a re-arm path to the same file.
  for (const forbidden of [
    'min_ai_call_start_mills', 'balance_mills', 'ai_daily_call_cap',
    'evaluateDailyPace', 'wallet_accounts', 'api.telnyx.com/v2/calls',
  ]) {
    assert.ok(!TICK.includes(forbidden),
      `voice-campaign-tick must not read or re-implement ${forbidden}`);
  }
});

test('the tick evaluates campaigns in a deterministic order', () => {
  assert.match(TICK, /\.order\("sort_order", \{ ascending: true \}\)/);
  assert.match(TICK, /\.order\("id", \{ ascending: true \}\)/);
});

test('an appointment reminder only ever enrols against a FUTURE scheduled appointment', () => {
  const sweep = TICK.slice(TICK.indexOf('async function sweepEnrollments'));
  assert.match(sweep, /\.eq\("status", "scheduled"\)/);
  assert.match(sweep, /\.gt\("starts_at", nowIso\)/);
});

test('a cancelled or elapsed appointment stops the reminder by name', () => {
  const sweep = TICK.slice(TICK.indexOf('async function sweepStops'), TICK.indexOf('async function sweepEnrollments'));
  assert.match(sweep, /appointment_cancelled/);
  assert.match(sweep, /appointment_passed/);
});

test('campaign_goal reaches the assistant, and an unknown one is normalised rather than passed through', () => {
  assert.match(TICK, /campaign_goal: vars\.campaign_goal/);
  assert.match(START, /VALID_CAMPAIGN_GOALS\.has\(body\.campaign_goal\.trim\(\)\.toLowerCase\(\)\)/);
  assert.match(START, /campaign_goal: campaignGoal/);
  // Gated on the internal flag, like every other campaign field: a browser
  // must not be able to change what the assistant says it is calling about.
  assert.match(START, /isInternal && typeof body\.campaign_goal === "string"/);
});

test('the goal changes only the REASON clause — the disclosure is identical on every call', () => {
  const fn = WEBHOOK.slice(WEBHOOK.indexOf('export function buildReasonClause'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  // Every branch is a reason. None of them touches who is speaking or on
  // whose behalf: that sentence is built once, above, and is the disclosure.
  assert.ok(!/assistant calling on behalf of/i.test(body),
    'buildReasonClause must never rebuild the disclosure clause');
  for (const goal of ['remind', 'rebook', 'care', 'emergency_contact', 'referral', 'chargeback']) {
    assert.ok(body.includes(`case "${goal}"`), `buildReasonClause has no branch for ${goal}`);
  }
  // And the one sentence that must survive every rewording.
  assert.match(WEBHOOK, /I'm an assistant calling on behalf of \$\{agent\} with \$\{agency\}\./);
});

test('every reason clause the webhook can speak is documented, and ends in one question', () => {
  const fn = WEBHOOK.slice(WEBHOOK.indexOf('export function buildReasonClause'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  // Six quoted branches plus the default, which is a template literal because
  // it interpolates the lead type.
  const clauses = [...body.matchAll(/return\s+((?:(?:"[^"]*"|`[^`]*`)\s*\+?\s*)+);/g)]
    .map((m) => m[1].replace(/"\s*\+\s*"/g, '').replace(/^["`]|["`]$/g, ''));
  assert.ok(clauses.length >= 7, `expected 7 reason clauses, found ${clauses.length}`);
  for (const c of clauses) {
    assert.ok(c.trim().endsWith('?'), `reason clause does not end in a question: ${c}`);
  }
  // The doc's table is what transcript QA is checked against; the instructions
  // branch on these phrases, so a reword here without a reword there is a
  // silent break.
  assert.match(DOC, /WHY YOU'RE CALLING — READ YOUR OWN OPENING LINE/);
  for (const phrase of [
    'confirm the appointment you have coming up',
    "we weren't able to reach you",
    'checking in on your coverage',
    'someone we should have down as an emergency contact',
    'about the people you named on your policy',
    'your coverage may have lapsed',
  ]) {
    assert.ok(DOC.includes(phrase), `the assistant instructions do not mention "${phrase}"`);
  }
});

// ============================================================
// 5. The consent tool
// ============================================================

test('the consent endpoint takes the agent from the JWT — there is no agent id in the body', () => {
  assert.match(CONSENT, /const \{ data: \{ user \} \} = await sbAuth\.auth\.getUser\(\)/);
  assert.ok(!/body\.agent_id/.test(CONSENT), 'leads-consent must never read an agent id from the body');
  // Every write is re-scoped, so the id list is a selection and not a boundary.
  const updates = CONSENT.match(/\.from\("leads"\)\s*\.update\([\s\S]*?\.eq\("agent_id", user\.id\)/g) || [];
  assert.equal(updates.length, 2, 'both the grant and the revoke update must be scoped to the caller');
  assert.match(CONSENT, /\.from\("leads"\)[\s\S]{0,200}\.eq\("agent_id", user\.id\)[\s\S]{0,60}\.in\("id", leadIds\)/);
});

test('the attestation is required and is stored verbatim', () => {
  assert.match(CONSENT, /if \(body\.attestation !== true\)[\s\S]{0,200}attestation_required/);
  assert.match(CONSENT, /attestation_text: CONSENT_ATTESTATION/);
  // The browser renders the same sentence it is about to have stored.
  const m = CONSENT.match(/export const CONSENT_ATTESTATION =\s*([\s\S]*?);/);
  assert.ok(m);
  const server = m[1].replace(/"\s*\+\s*"/g, '').replace(/\s+/g, ' ').replace(/^\s*"|"\s*$/g, '').trim();
  assert.ok(APP.includes('I confirm these leads gave prior express consent to be contacted by phone'),
    'the modal must show the attestation');
  assert.ok(server.startsWith('I confirm these leads gave prior express consent'), server);
});

test('the checkbox is NOT pre-checked and Record stays disabled until it is', () => {
  // The friction is the feature: the agent is putting their name to a
  // statement about what a consumer agreed to.
  const modal = APP.slice(APP.indexOf('id="consentModal"'), APP.indexOf('id="addLeadModal"'));
  assert.ok(!/id="cs-attest"[^>]*\bchecked\b/.test(modal), 'the attestation must not be pre-checked');
  assert.match(modal, /id="cs-confirm"[^>]*disabled/);
  assert.match(APP, /document\.getElementById\('cs-attest'\)\.checked = false;/);
});

test('a person on the do-not-call list cannot be consented back', () => {
  assert.match(CONSENT, /from\("dnc_list"\)/);
  assert.match(CONSENT, /if \(lead\.dnc === true\) \{ skip\(lead\.id, "dnc"\); continue; \}/);
  assert.match(CONSENT, /if \(dncPhones\.has\(phone\)\) \{ skip\(lead\.id, "dnc"\); continue; \}/);
});

test('REVOKING CONSENT NEVER TOUCHES DNC OR SUPPRESSION', () => {
  // "I was wrong to think I had consent" and "this person told me never to
  // call again" are different statements. Collapsing them either over- or
  // under-reports what the consumer actually said.
  const revoke = CONSENT.slice(CONSENT.indexOf('if (action === "revoke")'), CONSENT.indexOf('// grant'));
  assert.ok(!/dnc_list/.test(revoke), 'revoke must not write dnc_list');
  assert.ok(!/suppression_list/.test(revoke), 'revoke must not write suppression_list');
  assert.match(revoke, /action: "revoked"/);
  assert.match(APP, /does NOT add them to your do-not-call list/i);
});

test('the consent ledger is append-only: SELECT and nothing else, and nothing deletes from it', () => {
  const policies = MIG.match(/create policy "lead_consent_events_[^"]*"[\s\S]*?;/g) || [];
  assert.equal(policies.length, 1, 'exactly one policy on lead_consent_events');
  assert.match(policies[0], /for select using \(auth\.uid\(\) = agent_id\)/);
  assert.ok(!/delete\s+from\s+public\.lead_consent_events/i.test(MIG));
  assert.ok(!/\.delete\(/.test(CONSENT), 'leads-consent must never delete anything');
  // Every path writes a row: grant/voice, grant/sms, revoke/voice, revoke/sms.
  // Four since 20260804 added the text-consent channel; it was two.
  const inserts = CONSENT.match(/from\("lead_consent_events"\)\s*\.insert\(/g) || [];
  assert.equal(inserts.length, 4, 'grant and revoke each record an event per channel');
  // And every one of them names its channel explicitly — a defaulted channel
  // would file a text-consent event as a voice one and lose the distinction
  // the column exists to keep.
  const channels = CONSENT.match(/channel:\s*"(voice|sms)"/g) || [];
  assert.equal(channels.length, 4, 'each ledger insert states its channel');
  assert.equal(channels.filter(c => c.includes('voice')).length, 2);
  assert.equal(channels.filter(c => c.includes('sms')).length, 2);
});

test('the browser cannot write consent columns at all — the endpoint is the only door', () => {
  assert.match(MIG, /create trigger leads_protect_consent_columns\s+before insert or update on public\.leads/);
  const fn = MIG.slice(MIG.indexOf('function public.leads_protect_consent_columns'),
                       MIG.indexOf('drop trigger if exists leads_protect_consent_columns'));
  assert.match(fn, /new\.tcpa_consent\s*:=\s*old\.tcpa_consent/);
  assert.match(fn, /new\.tcpa_consent\s*:=\s*false/);   // the INSERT branch
  // NO ADMIN EXEMPTION, unlike the phone_numbers and agents guards. This
  // column records what a consumer agreed to, not something an administrator
  // administers.
  assert.ok(!/is_admin/.test(fn),
    'the consent guard must not exempt admins — there is no such thing as an administrator asserting consent for a consumer');
  // And app.html must not try: an UPDATE naming the column would be silently
  // reverted, which is worse than failing.
  assert.ok(!/tcpa_consent\s*:\s*(true|false)/.test(APP),
    'app.html must never try to write tcpa_consent directly');
});

test('the leads screen says how much of the book is callable, from ONE definition', () => {
  assert.match(APP, /id="lead-callable-count"/);
  assert.match(APP, /function voiceCallableCount\(\)/);
  const uses = APP.match(/voiceCallableCount\(\)/g) || [];
  assert.ok(uses.length >= 3, 'the count is used by the header, the campaign banner and the dialer note');
  // Blank, not "0 callable", until it has actually loaded.
  assert.match(APP, /if \(!_voiceConsent\.loaded\) \{ el\.textContent = ''; return; \}/);
});

test('voice consent and TEXT consent stay separate permissions', () => {
  // _leadConsent is the texting state, read from consent_records and used by
  // the SMS gate. _voiceConsent is leads.tcpa_consent, read by ai-call-start's
  // gate 3. Recording one must never widen the other.
  //
  // AMENDED 2026-07-31 (owner's decision, prompt H/D2). leads-consent may now
  // write consent_records — but ONLY behind a second, separately-ticked
  // attestation. The rule was never "this function must not touch that
  // table"; it was "recording calling consent must not silently record
  // texting consent". That is what the assertions below pin.
  assert.match(APP, /let _voiceConsent = /);
  assert.match(MIG, /Separate from consent_records on purpose/);
});

test('🔴 a text-consent row is written ONLY behind its own attestation flag', () => {
  // The flag is a LITERAL boolean compare. `truthy` would let the string
  // "false", or a stray 1 from some future caller, opt a consumer in.
  assert.match(CONSENT, /const wantsSms = body\.sms_attestation === true;/);

  // There is exactly one insert into consent_records, and it is inside the
  // `if (wantsSms)` branch. Sliced by index rather than by regex so a future
  // second insert somewhere else in the file fails this rather than hiding.
  const insertRe = /from\("consent_records"\)\s*\.insert\(/g;
  const inserts = CONSENT.match(insertRe) || [];
  assert.equal(inserts.length, 1, 'exactly one consent_records insert');
  const branchStart = CONSENT.indexOf('if (wantsSms) {');
  const insertAt = CONSENT.search(/from\("consent_records"\)\s*\.insert\(/);
  assert.ok(branchStart > 0, 'the wantsSms branch exists');
  assert.ok(insertAt > branchStart, 'the consent_records insert sits inside the wantsSms branch');

  // The two grades of evidence stay tellable apart forever.
  assert.match(CONSENT, /export const SMS_ATTESTATION_SOURCE = "agent_attestation";/);
  assert.match(CONSENT, /consent_method: "agent_attested"/);
  assert.ok(!/consent_method:\s*"web_form"/.test(CONSENT),
    'only the hosted opt-in page may write the web_form grade');

  // The gate needs express_written when sms_require_written_consent is on,
  // which it is — anything weaker records a row the composer would refuse.
  assert.match(CONSENT, /consent_type:\s*"express_written"/);
});

test('the modal never pre-ticks the text attestation, and it does not gate the button', () => {
  assert.match(APP, /id="cs-sms-attest"/);
  // Reset on EVERY open, not just the first.
  assert.match(APP, /document\.getElementById\('cs-sms-attest'\)\.checked = false;/);
  // The HTML checkbox itself carries no `checked`.
  const el = APP.match(/<input type="checkbox" id="cs-sms-attest"[^>]*>/);
  assert.ok(el && !/\bchecked\b/.test(el[0]), 'cs-sms-attest must not ship checked');
  // Voice-only must stay possible: the disabled expression reads the CALLING
  // attestation and the source, never the SMS one.
  const sync = APP.slice(APP.indexOf('function consentSyncButton()'),
                         APP.indexOf('async function consentConfirm()'));
  assert.match(sync, /btn\.disabled = !attested \|\| !key \|\| \(needsDetail && !detail\);/);
});

test('revoking pulls back the attested text consent, but never the consumer\'s own opt-in', () => {
  // Scoped to rows this tool wrote. A web_form row is the consumer's own
  // statement and is not the agent's to withdraw.
  assert.match(CONSENT, /\.eq\("source", SMS_ATTESTATION_SOURCE\)/);
  // Still never touches the stronger lists. Comment-stripped: the function's
  // own header explains at length that it does not, and a naive grep for the
  // table name matches that prose.
  const code = stripLineComments(CONSENT, ['//', '*', '/*']);
  assert.ok(!/from\("dnc_list"\)\s*\.insert/.test(code), 'revoke must never add a DNC row');
  assert.ok(!/suppression_list/.test(code), 'revoke must never touch suppression_list');
});
