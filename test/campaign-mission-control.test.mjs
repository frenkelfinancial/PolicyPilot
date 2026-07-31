// ============================================================
// campaign-mission-control.test.mjs — run with:  npm run test:mission
//
// The BROWSER half of Prompt J. Its server half is pinned by
// supabase/functions/_shared/ai-lead-effect.test.ts and
// .../voice-campaign-mission.test.ts; this file is the other side of both
// mirrors, plus the structural rules that only exist in app.html.
//
//   1. PARITY. Two rule sets now live twice.
//
//        `// <leadeffect-core>`  ↔  _shared/ai-lead-effect.ts
//        `// <vcamp-core>`       ↔  _shared/voice-campaign-core.ts
//
//      The first is the one that matters: it decides what an AI call does to a
//      lead's STATUS, and the leads board renders the same verdict the webhook
//      writes. If the two drift, the screen explains a decision the server did
//      not take. Same arrangement as pcNormalizeCode() vs pc_normalize_code().
//
//   2. BEHAVIOUR. The extracted browser core is executed verbatim — the exact
//      text that ships — against the rules that show on screen.
//
//   3. STRUCTURE. app.html as source text. The two invariants worth having:
//      there is ONE writer of a lead status in this browser, and there is no
//      version of the pause/resume/remove buttons that writes an enrollment
//      row directly.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as EFF from '../supabase/functions/_shared/ai-lead-effect.ts';
import * as SRV from '../supabase/functions/_shared/voice-campaign-core.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8').split('\r\n').join('\n');
const MIG = readFileSync(join(ROOT, 'supabase/migrations/20260805_campaign_mission_control.sql'), 'utf8');
const OUTCOME_MIG = readFileSync(join(ROOT, 'supabase/migrations/20260753_ai_transfer_booking.sql'), 'utf8');

// ------------------------------------------------------------
// Extract the two blocks and run them, in order — vcamp-core's
// vcLastCallLabel() calls leadEffectForOutcome(), so the lead-effect table has
// to be in scope. Same arrangement as persist-core loading team-core.
// ------------------------------------------------------------
const EFFECT_EXPORTS = [
  'LEAD_STATUSES', 'LEAD_STATUS_HUMAN_ONLY', 'AI_LEAD_EFFECT_KEYS',
  'leadEffectForOutcome', 'leadEffectOutcomes',
  'dispositionLabel', 'dispositionShortLabel', 'dispositionTone',
  'aiStatusVerdict',
];
const MISSION_EXPORTS = [
  'VC_ENROLLMENT_OPS', 'vcStepProgressLabel', 'vcRelTime', 'vcWaitReasonLabel',
  'vcNextAction', 'vcNextActionText', 'vcLastCallLabel', 'vcLastCallAt',
  'vcFeedEntry', 'vcFeed',
];

function block(name) {
  const m = APP.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`));
  assert.ok(m, `app.html must contain the // <${name}> … // </${name}> block`);
  return m[1];
}

function loadCores() {
  const src = block('leadeffect-core') + '\n' + block('vcamp-core');
  const names = EFFECT_EXPORTS.concat(MISSION_EXPORTS);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {${names.join(',')}};`)();
}
const B = loadCores();

// ============================================================
// 0. THE BLOCK ITSELF
// ============================================================

test('the leadeffect-core sentinel appears exactly once', () => {
  // The harness extracts by lazy match, so a comment mentioning the sentinel
  // above the real block swallows the file. Same rule as the other cores.
  assert.equal((APP.match(/\/\/ <leadeffect-core>/g) || []).length, 1);
  assert.equal((APP.match(/\/\/ <\/leadeffect-core>/g) || []).length, 1);
});

test('leadeffect-core is PURE — no DOM, network, storage or app globals', () => {
  const src = block('leadeffect-core')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const bad of [
    /\bdocument\./, /(^|[^.\w])window\./, /localStorage/, /sessionStorage/,
    /\bfetch\(/, /\bsb\./, /getElementById/, /querySelector/,
  ]) {
    assert.ok(!bad.test(src), `leadeffect-core must not contain ${bad}`);
  }
});

// ============================================================
// 1. PARITY — what a call does to a lead
// ============================================================

test('🔴 browser and server map EVERY outcome to the same lead effect', () => {
  const outcomes = EFF.leadEffectOutcomes();
  assert.deepEqual(B.leadEffectOutcomes(), outcomes);
  assert.ok(outcomes.length >= 12);

  for (const o of outcomes) {
    const s = EFF.leadEffectForOutcome(o);
    const b = B.leadEffectForOutcome(o);
    assert.equal(b.status, s.status, `status for ${o}`);
    assert.equal(b.dnc, s.dnc, `dnc for ${o}`);
    assert.equal(b.disposition, s.disposition, `disposition for ${o}`);
  }
});

test('the mapping covers the ai_calls.outcome CHECK constraint EXACTLY', () => {
  // An outcome missing from the table silently does nothing to the lead, and
  // "nothing" has to be a written decision rather than a gap. An outcome in
  // the table that the column cannot hold is a rule for a call that cannot
  // exist.
  const m = OUTCOME_MIG.match(/check \(outcome in \(([\s\S]*?)\)\)/);
  assert.ok(m, '20260753 must still carry the outcome CHECK constraint');
  const allowed = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(EFF.leadEffectOutcomes(), allowed);
  assert.deepEqual(B.leadEffectOutcomes(), allowed);
});

test('browser and server agree on the status vocabulary and what is off limits', () => {
  assert.deepEqual([...B.LEAD_STATUSES], [...EFF.LEAD_STATUSES]);
  assert.deepEqual([...B.LEAD_STATUS_HUMAN_ONLY], [...EFF.LEAD_STATUS_HUMAN_ONLY]);
  assert.deepEqual([...B.AI_LEAD_EFFECT_KEYS], [...EFF.AI_LEAD_EFFECT_KEYS]);
});

test('every status this module writes is one the app can actually render', () => {
  // STATUS_CONFIG is what the leads board draws chips from. A status outside
  // it would land in a book humans filter, sort and count on, with no screen
  // knowing what to call it.
  const cfg = APP.match(/const STATUS_CONFIG\s*=\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(cfg, 'app.html must still define STATUS_CONFIG');
  const keys = [...cfg[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((x) => x[1]);
  for (const o of EFF.leadEffectOutcomes()) {
    const s = EFF.leadEffectForOutcome(o).status;
    if (s) assert.ok(keys.includes(s), `${o} writes status "${s}" which STATUS_CONFIG does not have`);
  }
  for (const s of EFF.LEAD_STATUSES) {
    assert.ok(keys.includes(s), `LEAD_STATUSES names "${s}" which STATUS_CONFIG does not have`);
  }
});

test('the labels and the tone read the same in both halves', () => {
  for (const o of EFF.leadEffectOutcomes()) {
    const d = EFF.leadEffectForOutcome(o).disposition;
    assert.equal(B.dispositionLabel(d), EFF.dispositionLabel(d), `label for ${o}`);
    assert.equal(B.dispositionShortLabel(d), EFF.dispositionShortLabel(d), `short label for ${o}`);
    assert.equal(B.dispositionTone(d), EFF.dispositionTone(d), `tone for ${o}`);
  }
  for (const junk of [null, undefined, '', '  ', 'nonsense', 'SOLD']) {
    assert.equal(B.dispositionLabel(junk), EFF.dispositionLabel(junk));
    assert.equal(B.dispositionShortLabel(junk), EFF.dispositionShortLabel(junk));
    assert.equal(B.dispositionTone(junk), EFF.dispositionTone(junk));
  }
});

test('the case and whitespace of an outcome do not change the answer', () => {
  for (const raw of ['  APPOINTMENT_BOOKED ', 'Dnc_Request', ' no_answer']) {
    assert.deepEqual(B.leadEffectForOutcome(raw), EFF.leadEffectForOutcome(raw));
    assert.ok(B.leadEffectForOutcome(raw).disposition);
  }
});

// ============================================================
// 2. PARITY — the ordering guard
// ============================================================

const T0 = '2026-08-05T14:00:00.000Z';   // the call starts
const BEFORE = '2026-08-05T13:55:00.000Z';
const AFTER = '2026-08-05T14:02:00.000Z';  // ...and a human clicks mid-call

const GUARD_CASES = [
  // The plain yes.
  { effect: 'appointment_booked', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  { effect: 'not_interested', leadStatus: 'called', leadStatusAt: BEFORE, leadStatusSource: 'human' },
  // Nothing to write.
  { effect: 'no_answer', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  { effect: 'voicemail', leadStatus: 'called', leadStatusAt: null, leadStatusSource: null },
  { effect: 'busy', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  { effect: 'dnc_request', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  { effect: 'transferred', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  { effect: 'qualified', leadStatus: 'called', leadStatusAt: null, leadStatusSource: null },
  { effect: 'callback_requested', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  { effect: 'completed', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  { effect: 'error', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  { effect: 'in_progress', leadStatus: 'new', leadStatusAt: null, leadStatusSource: null },
  // Sold is human, always — in both directions.
  { effect: 'appointment_booked', leadStatus: 'sold', leadStatusAt: BEFORE, leadStatusSource: 'human' },
  { effect: 'not_interested', leadStatus: 'sold', leadStatusAt: null, leadStatusSource: null },
  // Already there.
  { effect: 'appointment_booked', leadStatus: 'appointment', leadStatusAt: BEFORE, leadStatusSource: 'ai' },
  // A person decided while the call was in the air.
  { effect: 'not_interested', leadStatus: 'appointment', leadStatusAt: AFTER, leadStatusSource: 'human' },
  { effect: 'appointment_booked', leadStatus: 'called', leadStatusAt: AFTER, leadStatusSource: 'human' },
  // A later AI verdict already landed.
  { effect: 'not_interested', leadStatus: 'appointment', leadStatusAt: AFTER, leadStatusSource: 'ai' },
  // A stamp from before the call is no obstacle.
  { effect: 'appointment_booked', leadStatus: 'called', leadStatusAt: BEFORE, leadStatusSource: 'human' },
  // Unparseable stamps must not decide anything by accident.
  { effect: 'appointment_booked', leadStatus: 'called', leadStatusAt: 'not a date', leadStatusSource: 'human' },
  { effect: 'appointment_booked', leadStatus: 'called', leadStatusAt: '', leadStatusSource: '' },
  // Case and padding.
  { effect: 'appointment_booked', leadStatus: '  SOLD ', leadStatusAt: null, leadStatusSource: null },
];

test('🔴 the ordering guard reaches the same verdict in both halves', () => {
  for (const c of GUARD_CASES) {
    const input = {
      effect: EFF.leadEffectForOutcome(c.effect),
      leadStatus: c.leadStatus,
      leadStatusAt: c.leadStatusAt,
      leadStatusSource: c.leadStatusSource,
      callStartedAt: T0,
    };
    const s = EFF.aiStatusVerdict(input);
    const b = B.aiStatusVerdict({ ...input, effect: B.leadEffectForOutcome(c.effect) });
    assert.equal(b.apply, s.apply, `apply for ${c.effect} over ${c.leadStatus}`);
    assert.equal(b.reason, s.reason, `reason for ${c.effect} over ${c.leadStatus}`);
  }
});

test('a missed call never moves the status — the rule that protects the pipeline', () => {
  // A six-step campaign dialling somebody five times would otherwise walk that
  // lead back to "No Answer" on every attempt, and the leads board would
  // become a log of the robot's afternoon.
  for (const o of ['no_answer', 'voicemail', 'busy']) {
    const e = B.leadEffectForOutcome(o);
    assert.equal(e.status, null, `${o} must not carry a status`);
    assert.ok(e.disposition, `${o} must still be visible as a last call result`);
    assert.equal(
      B.aiStatusVerdict({ effect: e, leadStatus: 'new', callStartedAt: T0 }).reason,
      'no_status_change',
    );
  }
});

test('🔴 nothing here writes `sold`, and nothing here writes over it', () => {
  for (const o of EFF.leadEffectOutcomes()) {
    assert.notEqual(EFF.leadEffectForOutcome(o).status, 'sold', `${o} must never write sold`);
    assert.notEqual(B.leadEffectForOutcome(o).status, 'sold', `${o} must never write sold`);
  }
  const v = B.aiStatusVerdict({
    effect: B.leadEffectForOutcome('appointment_booked'),
    leadStatus: 'sold',
    callStartedAt: T0,
  });
  assert.equal(v.apply, false);
  assert.equal(v.reason, 'human_only_status');
});

test('a legacy lead with no stamp is written, because no stamp is evidence of nothing', () => {
  // Every lead in the production book predates status_at.
  const v = B.aiStatusVerdict({
    effect: B.leadEffectForOutcome('appointment_booked'),
    leadStatus: 'called',
    leadStatusAt: null,
    leadStatusSource: null,
    callStartedAt: T0,
  });
  assert.equal(v.apply, true);
  assert.equal(v.reason, 'applied');
});

test('an unknown outcome does nothing at all', () => {
  for (const o of ['', null, undefined, 'sold', 'lapsed', 'wat']) {
    assert.deepEqual(B.leadEffectForOutcome(o), { status: null, dnc: false, disposition: null });
    assert.deepEqual(EFF.leadEffectForOutcome(o), { status: null, dnc: false, disposition: null });
  }
});

test('the appointment status is the SAME value the lifecycle campaigns trigger on', () => {
  // Otherwise the Appointment Reminder campaign never sees a booking the AI
  // made, and there are two appointment vocabularies one click apart.
  assert.equal(EFF.leadEffectForOutcome('appointment_booked').status, 'appointment');
  const guard = APP.match(/VC_LIFECYCLE_STATUSES\s*=\s*\[([^\]]*)\]/);
  assert.ok(guard, 'app.html must still carry the lifecycle-status allow-list');
  assert.match(guard[1], /'appointment'/);
  assert.ok(SRV.VC_LIFECYCLE_STATUSES.includes('appointment'));
});

// ============================================================
// 3. PARITY — what the campaign screen says
// ============================================================

const NOW = new Date('2026-08-05T15:00:00.000Z');

test('"step 2 of 6" counts the same steps on both sides', () => {
  const steps = [
    { id: 'a', position: 1 }, { id: 'b', position: 2 }, { id: 'c', position: 3 },
  ];
  for (const pos of [-3, 0, 1, 2, 3, 9, null, undefined, '2']) {
    assert.equal(B.vcStepProgressLabel(pos, steps), SRV.vcStepProgressLabel(pos, steps), `pos ${pos}`);
  }
  assert.equal(B.vcStepProgressLabel(1, []), 'No steps');
  assert.equal(B.vcStepProgressLabel(2, steps), 'Step 2 of 3');
  // Past the end still reads as the end, not as step 9 of 3.
  assert.equal(B.vcStepProgressLabel(9, steps), 'Step 3 of 3');
});

test('relative time agrees, and never shows a fraction', () => {
  const cases = [
    0, 10 * 1000, 44 * 1000, 45 * 1000, 90 * 1000, 59 * 60 * 1000,
    60 * 60 * 1000, 110 * 60 * 1000, 23 * 60 * 60 * 1000, 26 * 60 * 60 * 1000,
    9 * 24 * 60 * 60 * 1000,
  ];
  for (const ms of cases) {
    for (const sign of [1, -1]) {
      const when = new Date(NOW.getTime() + sign * ms).toISOString();
      const b = B.vcRelTime(when, NOW);
      assert.equal(b, SRV.vcRelTime(when, NOW), `${sign * ms}ms`);
      assert.ok(!/\./.test(b), `"${b}" must not carry a fraction — a 10s refresh would flicker`);
    }
  }
  assert.equal(B.vcRelTime(null, NOW), '');
  assert.equal(B.vcRelTime('nonsense', NOW), '');
  assert.equal(B.vcRelTime(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), NOW), '2h ago');
  assert.equal(B.vcRelTime(new Date(NOW.getTime() + 90 * 60 * 1000), NOW), 'in 1h');
});

const NEXT_CASES = [
  ['in flight beats everything', { status: 'active', next_action_at: '2026-08-05T16:00:00Z' }, null, true],
  ['a paused lead', { status: 'paused', paused_at: '2026-08-05T14:40:00Z' }, null, false],
  ['a stopped enrollment', { status: 'stopped' }, null, false],
  ['a completed enrollment', { status: 'completed' }, null, false],
  ['claimed with nothing due is a call in the air', { status: 'active', next_action_at: null, claimed_at: '2026-08-05T14:59:00Z' }, null, false],
  ['a paused campaign', { status: 'active', next_action_at: '2026-08-05T16:00:00Z' }, { paused_at: '2026-08-05T10:00:00Z' }, false],
  ['a switched-off campaign', { status: 'active', next_action_at: '2026-08-05T16:00:00Z' }, { active: false }, false],
  ['due now', { status: 'active', next_action_at: '2026-08-05T14:59:00Z' }, { active: true }, false],
  ['exactly now is due', { status: 'active', next_action_at: '2026-08-05T15:00:00.000Z' }, { active: true }, false],
  ['scheduled, quiet hours', { status: 'active', next_action_at: '2026-08-06T14:05:00Z', last_gate_code: 'quiet_hours' }, { active: true }, false],
  ['scheduled, daily cap', { status: 'active', next_action_at: '2026-08-06T14:05:00Z', last_gate_code: 'daily_cap_reached' }, { active: true }, false],
  ['scheduled, a hiccup', { status: 'active', next_action_at: '2026-08-05T15:02:00Z', last_gate_code: 'retry_soon' }, { active: true }, false],
  ['scheduled, no reason recorded', { status: 'active', next_action_at: '2026-08-06T14:05:00Z' }, { active: true }, false],
  ['scheduled, a code nobody knows', { status: 'active', next_action_at: '2026-08-06T14:05:00Z', last_gate_code: 'wat' }, { active: true }, false],
  ['nothing due and nothing claimed', { status: 'active', next_action_at: null }, { active: true }, false],
  ['an unparseable date', { status: 'active', next_action_at: 'soonish' }, { active: true }, false],
];

test('🔴 "what happens next" is the same verdict on both sides', () => {
  for (const [name, enrollment, campaign, inFlight] of NEXT_CASES) {
    const input = { enrollment, campaign, inFlight, now: NOW };
    const s = SRV.vcNextAction(input);
    const b = B.vcNextAction(input);
    assert.equal(b.kind, s.kind, name);
    assert.equal(b.at, s.at, `${name} — at`);
    assert.equal(b.code, s.code, `${name} — code`);
    // And the sentence built from it.
    const when = 'tomorrow 9:05 AM';
    assert.equal(B.vcNextActionText(b, when), SRV.vcNextActionText(s, when), `${name} — text`);
    assert.equal(B.vcNextActionText(b, ''), SRV.vcNextActionText(s, ''), `${name} — text, no time`);
  }
});

test('🔴 a lead that is NOT being called says why', () => {
  // "Tomorrow 9:05 AM" on a screen an agent opened because nothing seems to be
  // happening reads as a broken product. The engine already knew every one of
  // these reasons and threw them all away before 20260805.
  const at = { status: 'active', next_action_at: '2026-08-06T14:05:00Z' };
  const say = (enr, camp) => B.vcNextActionText(
    B.vcNextAction({ enrollment: enr, campaign: camp || { active: true }, now: NOW }),
    'tomorrow 9:05 AM',
  );

  assert.equal(say({ ...at, last_gate_code: 'quiet_hours' }),
    'Quiet hours where they live · next call tomorrow 9:05 AM');
  assert.equal(say({ ...at, last_gate_code: 'daily_cap_reached' }),
    'Your daily call limit · next call tomorrow 9:05 AM');
  assert.equal(say({ ...at, last_gate_code: 'retry_soon' }),
    'A hiccup on the line — retrying · next call tomorrow 9:05 AM');
  assert.equal(say(at, { paused_at: '2026-08-05T10:00:00Z' }), 'Campaign paused');
  assert.equal(say(at, { active: false }), 'Campaign switched off');
  assert.equal(say({ status: 'paused', paused_at: '2026-08-05T14:40:00Z' }), 'Paused tomorrow 9:05 AM');
  assert.equal(
    B.vcNextActionText(B.vcNextAction({ enrollment: at, inFlight: true, now: NOW }), ''),
    'Calling now…',
  );
  // An unrecognised gate code degrades to the plain time rather than to a
  // blank — a reason we cannot name is still a wait we can date.
  assert.equal(say({ ...at, last_gate_code: 'wat' }), 'tomorrow 9:05 AM');
});

test('the wait reasons read the same, and an unknown one is silent', () => {
  for (const c of ['quiet_hours', 'daily_cap_reached', 'retry_soon', 'wat', '', null, undefined, ' QUIET_HOURS ']) {
    assert.equal(B.vcWaitReasonLabel(c), SRV.vcWaitReasonLabel(c), `code ${c}`);
  }
  assert.equal(B.vcWaitReasonLabel('quiet_hours'), 'Quiet hours where they live');
  assert.equal(B.vcWaitReasonLabel('nope'), '');
});

test('the last call result is worded by the SAME table the lead row uses', () => {
  const calls = [
    { outcome: 'no_answer' }, { outcome: 'appointment_booked' }, { outcome: 'dnc_request' },
    { outcome: 'error' }, { outcome: 'in_progress' }, { status: 'in_progress', outcome: null },
    { outcome: 'transferred' }, { outcome: 'completed' }, { outcome: 'wat' }, {}, null,
  ];
  for (const c of calls) {
    assert.equal(B.vcLastCallLabel(c), SRV.vcLastCallLabel(c), JSON.stringify(c));
  }
  assert.equal(B.vcLastCallLabel({ outcome: 'no_answer' }), 'No answer');
  assert.equal(B.vcLastCallLabel({ status: 'in_progress' }), 'Calling now');
  // `error` means WE broke — it is not a fact about the consumer, so it gets
  // no disposition, but the row still has to say something.
  assert.equal(B.vcLastCallLabel({ outcome: 'error' }), 'Call failed');
  assert.equal(B.vcLastCallLabel(null), '');
});

test('"when" prefers the end of the call over the start of the row', () => {
  const c = { created_at: '2026-08-05T14:00:00Z', ended_at: '2026-08-05T14:03:00Z' };
  assert.equal(B.vcLastCallAt(c), SRV.vcLastCallAt(c));
  assert.equal(B.vcLastCallAt(c), '2026-08-05T14:03:00Z');
  assert.equal(B.vcLastCallAt({ created_at: '2026-08-05T14:00:00Z' }), '2026-08-05T14:00:00Z');
  assert.equal(B.vcLastCallAt(null), null);
});

// ============================================================
// 4. PARITY — the activity feed
// ============================================================

const FEED_CALLS = [
  { id: 'c1', lead_id: 'l1', outcome: 'no_answer', created_at: '2026-08-05T14:00:00Z', ended_at: '2026-08-05T14:00:30Z' },
  { id: 'c2', lead_id: 'l2', outcome: 'appointment_booked', created_at: '2026-08-05T14:09:00Z', ended_at: '2026-08-05T14:12:00Z' },
  { id: 'c3', lead_id: 'l3', outcome: 'dnc_request', created_at: '2026-08-05T13:58:00Z', ended_at: '2026-08-05T13:58:40Z' },
  { id: 'c4', lead_id: null, outcome: 'voicemail', created_at: '2026-08-05T13:40:00Z', ended_at: null },
  { id: 'c5', lead_id: 'l1', outcome: null, status: 'in_progress', created_at: '2026-08-05T14:59:00Z', ended_at: null },
  { id: 'c6', lead_id: 'l4', outcome: 'error', created_at: '2026-08-05T12:00:00Z', ended_at: '2026-08-05T12:00:10Z' },
];
const NAMES = { l1: 'Mark J.', l2: 'Lisa P.', l3: 'Ray T.', l4: '' };

test('🔴 the feed assembles identically on both sides', () => {
  const ctx = {
    leadName: (id) => NAMES[id] || '',
    retryAt: (id) => (id === 'l1' ? '2026-08-06T15:00:00Z' : null),
    limit: 50,
  };
  const b = B.vcFeed(FEED_CALLS, ctx);
  const s = SRV.vcFeed(FEED_CALLS, ctx);
  assert.equal(b.length, s.length);
  for (let i = 0; i < b.length; i++) {
    assert.deepEqual(
      { ...b[i] }, { ...s[i] },
      `feed entry ${i}`,
    );
  }
});

test('newest first, and the limit is honoured', () => {
  const ctx = { leadName: (id) => NAMES[id] || '' };
  const all = B.vcFeed(FEED_CALLS, ctx);
  assert.deepEqual(all.map((e) => e.call_id), ['c5', 'c2', 'c1', 'c3', 'c4', 'c6']);
  assert.equal(B.vcFeed(FEED_CALLS, { ...ctx, limit: 2 }).length, 2);
  assert.equal(B.vcFeed(FEED_CALLS, { ...ctx, limit: 0 }).length, 0);
  assert.equal(B.vcFeed(FEED_CALLS, { ...ctx, limit: -5 }).length, 0);
  assert.equal(B.vcFeed(null, ctx).length, 0);
});

test('a live call reports itself as live whatever the outcome column says', () => {
  // The row is written outcome='in_progress' at dial time and only settles at
  // hangup; a feed that trusted the column would announce a result mid-call.
  const e = B.vcFeedEntry({ id: 'x', status: 'in_progress', outcome: 'no_answer' }, { leadName: 'Mark J.' });
  assert.equal(e.outcome, 'in_progress');
  assert.equal(e.headline, 'Calling Mark J.…');
  assert.deepEqual(e, SRV.vcFeedEntry({ id: 'x', status: 'in_progress', outcome: 'no_answer' }, { leadName: 'Mark J.' }));
});

test('a nameless lead never produces "Called ."', () => {
  for (const name of ['', '   ', null, undefined]) {
    const e = B.vcFeedEntry({ id: 'x', outcome: 'no_answer' }, { leadName: name });
    assert.equal(e.headline, 'Called a lead — no answer');
    assert.deepEqual(e, SRV.vcFeedEntry({ id: 'x', outcome: 'no_answer' }, { leadName: name }));
  }
});

test('good news and bad news are toned apart, the same way in both halves', () => {
  const tone = (outcome) => B.vcFeedEntry({ id: 'x', outcome }, { leadName: 'A' }).tone;
  assert.equal(tone('appointment_booked'), 'good');
  assert.equal(tone('transferred'), 'good');
  assert.equal(tone('qualified'), 'good');
  assert.equal(tone('dnc_request'), 'bad');
  assert.equal(tone('not_interested'), 'bad');
  assert.equal(tone('error'), 'bad');
  assert.equal(tone('no_answer'), 'neutral');
  for (const o of EFF.leadEffectOutcomes()) {
    assert.equal(tone(o), SRV.vcFeedEntry({ id: 'x', outcome: o }, { leadName: 'A' }).tone, o);
  }
});

test('the three ops are the same three, in the same order', () => {
  assert.deepEqual([...B.VC_ENROLLMENT_OPS], [...SRV.VC_ENROLLMENT_OPS]);
  assert.deepEqual([...B.VC_ENROLLMENT_OPS], ['pause', 'resume', 'remove']);
});

// ============================================================
// 5. STRUCTURE — app.html
// ============================================================

// Comments are stripped before the greps below: several of them explain in as
// many words the thing being searched for, and a naive match hits the
// explanation rather than the code.
const CODE = APP.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('🔴 ppSetLeadStatus is the ONLY place this browser writes a lead status', () => {
  // There were five, and that was fine right up until the AI started writing
  // statuses too: leads.data is re-upserted for the ENTIRE book from memory on
  // every save, so a status the server wrote is erased by a stale copy unless
  // the two can be told apart — which needs every human write to stamp.
  assert.match(APP, /function ppSetLeadStatus\(lead, status, opts\)/);
  const fn = APP.slice(APP.indexOf('function ppSetLeadStatus(lead, status, opts)'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /lead\.status\s*=\s*status;/);
  assert.match(body, /lead\.status_at\s*=\s*new Date\(\)\.toISOString\(\);/);
  assert.match(body, /lead\.status_source\s*=\s*\(opts && opts\.source\) \|\| 'human';/);

  // Nothing else assigns a status onto a lead-shaped object. `leadEffectsSync`
  // is the one exception and it is the READ side — it copies the server's
  // verdict in, stamp and all, and is asserted separately below.
  const sync = CODE.slice(CODE.indexOf('function leadEffectsSync('));
  const syncBody = sync.slice(0, sync.indexOf('\n}\n') + 3);
  const elsewhere = CODE.split(syncBody).join('\n');
  const writes = [...elsewhere.matchAll(/^\s*(?:lead|l|row|c)\.status\s*=/gm)];
  assert.equal(writes.length, 1, `expected only ppSetLeadStatus to assign a lead status, found ${writes.length}`);
});

test('the sync copies the server\'s verdict in and NEVER pushes it back', () => {
  const at = CODE.indexOf('function leadEffectsSync(');
  assert.ok(at > 0);
  const body = CODE.slice(at, CODE.indexOf('\n}\n', at) + 3);
  // Newer wins, in both directions — a sync landing a second after the agent
  // picked a status must not undo them.
  assert.match(body, /remoteAt > localAt/);
  assert.match(body, /remoteDisp > localDisp/);
  // These values came FROM the server. Writing them back would be a whole-book
  // upsert to tell it something it already knows.
  assert.ok(!/sbUpsertAllLeads|saveLeads\(/.test(body),
    'the sync must not trigger a whole-book write');
  assert.match(body, /localStorage\.setItem/);
});

test('🔴 there is no version of these buttons that writes an enrollment row', () => {
  // voice_campaign_enrollments is SELECT-only for the browser on purpose — an
  // enrollment is a standing instruction to phone a consumer.
  for (const verb of ['insert', 'update', 'upsert', 'delete']) {
    const re = new RegExp(`from\\(['"]voice_campaign_enrollments['"]\\)[\\s\\S]{0,120}\\.${verb}\\(`);
    assert.ok(!re.test(CODE), `app.html must never .${verb}() voice_campaign_enrollments`);
  }
});

test('🔴 preview and write are the SAME call, with one flag', () => {
  // Same discipline as preview_enroll / enroll_leads. A count computed by
  // separate code is a count that eventually lies, and these buttons act on
  // somebody's live calling program.
  assert.equal((CODE.match(/action: 'enrollment_action'/g) || []).length, 1);
  const at = CODE.indexOf("async function vcampEnrollmentAction(op, enrollmentIds, preview)");
  assert.ok(at > 0, 'one function issues the call');
  const body = CODE.slice(at, at + 900);
  assert.match(body, /preview: !!preview/);
  assert.match(body, /invoke\('voice-campaign-manage'/);
  // The bulk confirm asks for the preview and then repeats the same call.
  assert.match(CODE, /vcampEnrollmentAction\(op, ids, true\)/);
  assert.match(CODE, /vcampEnrollmentAction\(_vcampBulk\.op, _vcampBulk\.ids, false\)/);
});

test('the bulk actions confirm and the single-row ones do not', () => {
  // One lead is small, visible and reversible; forty are not.
  assert.match(CODE, /async function vcampRowAction\(enrollmentId, op\)/);
  const row = CODE.slice(CODE.indexOf('async function vcampRowAction(enrollmentId, op)'));
  assert.match(row.slice(0, 600), /vcampEnrollmentAction\(op, \[enrollmentId\], false\)/);
  assert.match(CODE, /function vcampBulkConfirm\(\)/);
});

test('the feed is built from ai_calls — no second event log', () => {
  // ai_call_events is the Telnyx webhook's diagnostic trace, service-role-only,
  // and this feature deliberately does not start a rival to it.
  assert.match(CODE, /from\('ai_calls'\)/);
  assert.ok(!/from\('ai_call_events'\)/.test(CODE),
    'the browser must not read ai_call_events');
  assert.match(CODE, /const VCAMP_FEED_LIMIT = 50;/);
});

test('polling stops when nobody is looking', () => {
  const at = CODE.indexOf('function vcampStartPolling()');
  const body = CODE.slice(at, CODE.indexOf('function vcampStopPolling()'));
  assert.match(body, /classList\.contains\('active'\)/);
  assert.match(body, /document\.visibilityState !== 'visible'/);
  assert.match(body, /vcampState\.busy/);
  assert.match(CODE, /function vcampStopPolling\(\)[\s\S]{0,160}clearInterval/);
  // And the lead-board sync does the same.
  const le = CODE.slice(CODE.indexOf('function leadEffectsStartPolling()'));
  assert.match(le.slice(0, 500), /document\.visibilityState === 'visible'/);
});

test('the Leads table paginates, so hundreds of enrollments still render', () => {
  assert.match(CODE, /const VCAMP_PAGE_SIZE = 25;/);
  assert.match(CODE, /function vcampGoPage\(/);
  // The selection lives outside the DOM, so it survives paging and refresh —
  // the same rule the leads screen's own selection follows.
  assert.match(CODE, /vcampState\.sel\.(add|delete|has)\(/);
});

test('the row opens the EXISTING lead view, and builds no second one', () => {
  // "Reuse it — don't build a second lead view." It navigates to the leads
  // screen and expands the row that is already there, through the same
  // expandedLeadIds set and the same filterLeads() the leads screen uses.
  const at = CODE.indexOf('function vcampOpenLead(');
  assert.ok(at > 0);
  const body = CODE.slice(at, CODE.indexOf('\n}\n', at) + 3);
  assert.match(body, /nav\('leads'\)/);
  assert.match(body, /expandedLeadIds\.add\(/);
  assert.match(body, /filterLeads\(\)/);
  assert.match(body, /scrollIntoView/);
  // No lead markup of its own — that is what "a second lead view" would mean.
  assert.ok(!/innerHTML/.test(body), 'vcampOpenLead must not render a lead itself');
  // A lead the browser has not loaded gets a sentence, not a dead click.
  assert.match(body, /showToast\(/);
});

// ============================================================
// 6. STRUCTURE — the migration
// ============================================================

test('🔴 the migration adds NO write policy to voice_campaign_enrollments', () => {
  // A "pause" button is not a good enough reason to let a browser write a
  // standing instruction to phone a consumer.
  assert.ok(!/create policy[\s\S]*?on public\.voice_campaign_enrollments[\s\S]*?for (insert|update|delete|all)/i.test(MIG));
  assert.ok(!/for (insert|update|delete)/i.test(MIG.replace(/--[^\n]*/g, '')));
});

test('the two new columns are display and hold, and both say so', () => {
  assert.match(MIG, /add column if not exists paused_at timestamptz/);
  assert.match(MIG, /add column if not exists last_gate_code text/);
  assert.match(MIG, /comment on column public\.voice_campaign_enrollments\.paused_at/);
  assert.match(MIG, /comment on column public\.voice_campaign_enrollments\.last_gate_code/);
});

test('the feed has an index that can serve it without a sort', () => {
  assert.match(MIG, /create index if not exists ai_calls_campaign_created_idx\s*\n\s*on public\.ai_calls \(campaign_id, created_at desc\)/);
});

test('the status guard parses stamps safely — a bad one must not fail the save', () => {
  // A bare ::timestamptz on a malformed string raises inside a BEFORE trigger
  // and takes the agent's whole save with it, turning a display field into an
  // outage.
  assert.match(MIG, /create or replace function public\.pp_jsonb_ts\(v text\)/);
  assert.match(MIG, /exception when others then\s*\n\s*return null;/);
  const fn = MIG.slice(MIG.indexOf('create or replace function public.leads_preserve_ai_status()'));
  assert.match(fn, /pp_jsonb_ts\(old\.data->>'status_at'\)/);
  assert.match(fn, /pp_jsonb_ts\(new\.data->>'status_at'\)/);
  assert.ok(!/::timestamptz/.test(fn), 'the trigger must not cast a jsonb string directly');
});

test('the guard only ever protects a status the AI set', () => {
  const fn = MIG.slice(MIG.indexOf('create or replace function public.leads_preserve_ai_status()'));
  assert.match(fn, /if old\.data->>'status_source' = 'ai' then/);
  // Browser writes only — the service role is trusted and is the only thing
  // that writes status_source = 'ai'.
  assert.match(fn, /auth\.role\(\) is distinct from 'authenticated'/);
  assert.match(fn, /auth\.role\(\) is distinct from 'anon'/);
  // Newer stamp wins; equal or older is an echo, not a decision.
  assert.match(fn, /new_at is null or new_at <= old_at/);
});
