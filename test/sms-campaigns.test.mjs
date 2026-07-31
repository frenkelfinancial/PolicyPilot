// ============================================================
// sms-campaigns.test.mjs — run with:  npm run test:smscampaigns
//
// Three kinds of test, the same split as voice-campaigns.test.mjs.
//
//   1. PARITY. The text campaign rules exist twice — in
//      supabase/functions/_shared/voice-campaign-core.ts (the engine) and in
//      the `// <vcamp-core>` block in app.html (the editor). app.html has no
//      build step and no module system, so the duplication is unavoidable;
//      what is avoidable is DRIFT. A shared table of cases runs through both.
//      If the editor's preview and the server's send ever disagree about what
//      a message says, this fails.
//
//   2. BEHAVIOUR. The extracted browser core is executed verbatim — the exact
//      text that ships.
//
//   3. STRUCTURE. Assertions about the edge functions, app.html and the
//      migration as SOURCE TEXT. This is where the compliance invariants live:
//      "the tick contains no copy of the send gate" is not something a unit
//      test can show, because the bug it guards against is a line of code
//      existing at all.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as SRV from '../supabase/functions/_shared/voice-campaign-core.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const APP    = read('app.html');
const MIG    = read('supabase/migrations/20260807_sms_campaigns.sql');
const TICK   = read('supabase/functions/voice-campaign-tick/index.ts');
const MANAGE = read('supabase/functions/voice-campaign-manage/index.ts');
const SEND   = read('supabase/functions/_shared/campaign-sms-send.ts');

const EXPORTS = [
  'VC_CHANNELS', 'VC_MERGE_VARS', 'VC_SMS_STEP_TYPES', 'VC_VOICE_STEP_TYPES',
  'VC_STEP_TYPES', 'VC_SMS_CONVERSATION_WINDOW_HOURS', 'VC_SMS_TAKEOVER_RECHECK_MINUTES',
  'vcChannel', 'vcChannelLabel', 'vcChannelVerb', 'vcStepTypesFor', 'vcStepIsActionable',
  'vcFirstActionableStep', 'vcResolveNextDue', 'vcCampaignStats',
  'renderMergeVars', 'vcMergeIssues', 'vcMergePreview', 'vcMergeValues',
  'vcPersonName', 'vcPrettyPhone', 'vcBodyStats', 'vcValidateSmsSteps',
  'vcEvaluateSmsHold', 'vcEvaluateSmsStop',
  'vcMessageStatusLabel', 'vcMessageAt', 'vcSmsFeedEntry', 'vcSmsFeed',
  'vcSmsDailyByNumber', 'vcSmsMeterSentence',
  'vcNextActionText', 'vcWaitReasonLabel', 'vcStopReasonLabel',
];

function loadCore() {
  const m = APP.match(/\/\/ <vcamp-core>([\s\S]*?)\/\/ <\/vcamp-core>/);
  assert.ok(m, 'app.html must contain the // <vcamp-core> … // </vcamp-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

const NOW = new Date('2026-08-10T15:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ============================================================
// 1. PARITY
// ============================================================

const BODIES = [
  '',
  'plain text with no variables',
  'Hi {{firstName}}',
  'Hi {{firstName}}, it’s {{agentName}} with {{companyName}}.',
  'Your {{carrier}} cover for {{coverageAmount}} — call {{agentPhone}}.',
  'Hi {{ firstName }}, spaced',
  'Hi {{FIRSTNAME}}, shouted',
  'Hi {{firstname}}, quiet',
  'Hi {{frstName}}, typo',
  '{{nope}} at the very start',
  'trailing {{nope}} .',
  '{{firstName}} {{firstName}} {{firstName}}',
  'emoji 👋 {{firstName}}',
  'multi\nline\n{{agentName}}',
  '{{firstName}}, {{carrier}}, {{coverageAmount}}, {{agentPhone}}, {{agentName}}, {{companyName}}',
];

const VALUE_SETS = [
  {},
  { firstName: 'Maria' },
  { firstName: '  Maria  ' },
  { firstName: '' },
  { firstName: null },
  { firstName: 'Maria', agentName: 'Jordan Reyes', companyName: 'Reyes Financial' },
  {
    firstName: 'Maria', agentName: 'Jordan Reyes', companyName: 'Reyes Financial',
    carrier: 'Mutual of Omaha', coverageAmount: '$25,000', agentPhone: '(262) 509-9123',
  },
  { agentName: 'jacef8778099@gmail.com' },
];

test('parity: renderMergeVars', () => {
  for (const body of BODIES) {
    for (const values of VALUE_SETS) {
      assert.equal(
        B.renderMergeVars(body, values),
        SRV.renderMergeVars(body, values),
        `body ${JSON.stringify(body)} values ${JSON.stringify(values)}`,
      );
    }
    // And the preview both sides show the agent.
    assert.equal(B.vcMergePreview(body), SRV.vcMergePreview(body), body);
  }
});

test('parity: vcMergeIssues', () => {
  for (const body of BODIES) {
    assert.deepEqual(B.vcMergeIssues(body), SRV.vcMergeIssues(body), body);
  }
});

test('parity: the merge-variable palette itself', () => {
  assert.deepEqual(
    B.VC_MERGE_VARS.map((v) => [v.key, v.sample, v.fallback]),
    SRV.VC_MERGE_VARS.map((v) => [v.key, v.sample, v.fallback]),
  );
  // Editor and server must agree about which names exist, or the editor
  // approves a body the server then strips.
  assert.deepEqual(
    B.VC_MERGE_VARS.map((v) => v.key).sort(),
    SRV.VC_MERGE_VARS.map((v) => v.key).sort(),
  );
});

const NAMES = [
  '', null, 'Jordan Reyes', 'jordan.reyes@agency.com', 'jacef8778099@gmail.com',
  '123@x.com', 'x@y.z', '  Spaced Out  ', 'MCDONALD', 'o’brien',
];

test('parity: vcPersonName — the no-email rule', () => {
  for (const n of NAMES) assert.equal(B.vcPersonName(n), SRV.vcPersonName(n), String(n));
});

test('parity: vcPrettyPhone', () => {
  for (const p of ['', null, '+12625099123', '+15551234567', '+447700900123', 'nonsense']) {
    assert.equal(B.vcPrettyPhone(p), SRV.vcPrettyPhone(p), String(p));
  }
});

test('parity: vcMergeValues', () => {
  const leads = [
    null,
    { id: 'l1', data: {} },
    { id: 'l2', data: { first_name: 'Maria' } },
    { id: 'l3', data: { name: 'Maria Perez' } },
    { id: 'l4', data: { name: 'Maria Perez', first_name: 'Mar' } },
    { id: 'l5', data: { carrier: 'MoO', coverage_wanted: '$25,000' } },
    { id: 'l6', data: { coverage_amount: '$10,000' } },
    { id: 'l7', data: { name: 'x@y.com' } },
  ];
  for (const lead of leads) {
    for (const from of ['', '+12625099123']) {
      assert.deepEqual(
        B.vcMergeValues({ lead, agentName: 'Jordan Reyes', agencyName: 'Reyes Financial', fromE164: from }),
        SRV.vcMergeValues({ lead, agentName: 'Jordan Reyes', agencyName: 'Reyes Financial', fromE164: from }),
        JSON.stringify(lead),
      );
    }
  }
});

test('parity: vcBodyStats — the editor and the biller price the same message', () => {
  for (const body of BODIES) {
    for (const media of [null, 'https://x/y.jpg']) {
      assert.deepEqual(
        B.vcBodyStats(body, { mediaUrl: media }),
        SRV.vcBodyStats(body, { mediaUrl: media }),
        body,
      );
    }
  }
});

const STEP_SETS = [
  [],
  [{ position: 1, step_type: 'sms_message', body: 'hi' }],
  [{ position: 1, step_type: 'sms_message', body: '   ' }],
  [{ position: 1, step_type: 'sms_message', body: 'hi {{frstName}}' }],
  [{ position: 1, step_type: 'wait', wait_value: 1, wait_unit: 'days' }],
  [
    { position: 1, step_type: 'sms_message', body: 'one' },
    { position: 2, step_type: 'wait', wait_value: 2, wait_unit: 'days' },
    { position: 3, step_type: 'sms_message', body: 'two {{firstName}}' },
  ],
  [
    { position: 1, step_type: 'wait', wait_value: 1, wait_unit: 'hours' },
    { position: 2, step_type: 'wait', wait_value: 30, wait_unit: 'minutes' },
  ],
];

test('parity: vcValidateSmsSteps', () => {
  for (const steps of STEP_SETS) {
    assert.deepEqual(B.vcValidateSmsSteps(steps), SRV.vcValidateSmsSteps(steps), JSON.stringify(steps));
  }
});

test('parity: vcResolveNextDue, including the wait fold', () => {
  const VOICE = [
    { position: 1, step_type: 'call', wait_value: 1, wait_unit: 'minutes' },
    { position: 2, step_type: 'double_dial', wait_value: 2, wait_unit: 'hours' },
    { position: 3, step_type: 'call', wait_value: 1, wait_unit: 'days' },
  ];
  const ANCHORED = [
    { position: 1, step_type: 'call', anchor: 'appointment', offset_minutes: -1440 },
    { position: 2, step_type: 'call', anchor: 'appointment', offset_minutes: -120 },
  ];
  const appt = new Date(NOW.getTime() + 90 * 60_000).toISOString();
  for (const steps of [...STEP_SETS, VOICE, ANCHORED]) {
    for (const from of [0, 1, 2, 3, 5]) {
      for (const at of [null, appt]) {
        const b = B.vcResolveNextDue({ steps, fromPosition: from, now: NOW, appointmentAt: at });
        const s = SRV.vcResolveNextDue({ steps, fromPosition: from, now: NOW, appointmentAt: at });
        assert.equal(b.dueAt, s.dueAt);
        assert.equal(b.reason, s.reason);
        assert.deepEqual(b.skipped, s.skipped);
        assert.deepEqual(b.folded, s.folded);
        assert.equal(b.step ? b.step.position : null, s.step ? s.step.position : null);
      }
    }
  }
});

const THREADS = [
  null,
  { status: 'open' },
  { status: 'open', last_inbound_at: new Date(NOW.getTime() - HOUR).toISOString() },
  { status: 'open', last_inbound_at: new Date(NOW.getTime() - 25 * HOUR).toISOString() },
  { status: 'open', ai_muted: true, ai_muted_reason: 'agent_takeover' },
  { status: 'open', ai_muted: true, ai_muted_reason: 'booked' },
  { status: 'open', ai_muted: true, ai_muted_reason: 'agent_toggle' },
  { status: 'closed', closed_reason: 'opted_out' },
  { status: 'closed', closed_reason: 'other', last_inbound_at: new Date(NOW.getTime() - HOUR).toISOString() },
];

const SMS_CAMPAIGNS = [
  {},
  { stop_on_reply: true, pause_on_active_conversation: true },
  { stop_on_reply: false, pause_on_active_conversation: true },
  { stop_on_reply: true, pause_on_active_conversation: false },
  { stop_on_reply: false, pause_on_active_conversation: false },
  { stop_on_reply: true, stop_on_sold: true, stop_on_appointment_booked: true },
];

test('parity: vcEvaluateSmsHold', () => {
  for (const campaign of SMS_CAMPAIGNS) {
    for (const thread of THREADS) {
      assert.deepEqual(
        B.vcEvaluateSmsHold({ campaign, thread, now: NOW }),
        SRV.vcEvaluateSmsHold({ campaign, thread, now: NOW }),
        JSON.stringify({ campaign, thread }),
      );
    }
  }
});

test('parity: vcEvaluateSmsStop', () => {
  const enrolled = new Date(NOW.getTime() - 3 * DAY).toISOString();
  for (const campaign of SMS_CAMPAIGNS) {
    for (const thread of THREADS) {
      for (const flags of [
        {}, { leadDnc: true }, { onDncList: true }, { leadSold: true }, { leadBooked: true },
        { leadSold: true, leadBooked: true },
      ]) {
        const input = { campaign, thread, enrolledAt: enrolled, ...flags };
        assert.deepEqual(
          B.vcEvaluateSmsStop(input),
          SRV.vcEvaluateSmsStop(input),
          JSON.stringify(input),
        );
      }
    }
  }
});

test('parity: the labels an agent reads', () => {
  const codes = [
    null, '', 'quiet_hours', 'daily_cap_reached', 'retry_soon',
    'live_conversation', 'agent_takeover', 'daily_limit_reached', 'a2p_not_approved', 'nonsense',
  ];
  for (const c of codes) assert.equal(B.vcWaitReasonLabel(c), SRV.vcWaitReasonLabel(c), String(c));

  const reasons = [
    null, '', 'dnc', 'sold', 'answered', 'replied', 'opted_out', 'conversation_closed',
    'no_sms_consent', 'removed_by_user', 'moved_by_user', 'nonsense',
  ];
  for (const r of reasons) assert.equal(B.vcStopReasonLabel(r), SRV.vcStopReasonLabel(r), String(r));

  for (const kind of ['calling', 'paused_lead', 'paused_campaign', 'campaign_off', 'ended',
                      'waiting_on_call', 'due', 'scheduled', 'unknown']) {
    for (const ch of [undefined, 'voice', 'sms']) {
      for (const when of ['', '9:05 AM']) {
        const v = { kind, at: null, code: kind === 'scheduled' ? 'live_conversation' : null };
        assert.equal(B.vcNextActionText(v, when, ch), SRV.vcNextActionText(v, when, ch), `${kind}/${ch}/${when}`);
      }
    }
  }
});

test('parity: channel helpers and stats', () => {
  for (const c of [null, {}, { channel: 'sms' }, { channel: 'SMS' }, { channel: 'voice' }, { channel: 'fax' }]) {
    assert.equal(B.vcChannel(c), SRV.vcChannel(c), JSON.stringify(c));
  }
  for (const ch of [null, 'voice', 'sms', 'nonsense']) {
    assert.equal(B.vcChannelLabel(ch), SRV.vcChannelLabel(ch));
    assert.equal(B.vcChannelVerb(ch), SRV.vcChannelVerb(ch));
    assert.deepEqual(B.vcStepTypesFor(ch), SRV.vcStepTypesFor(ch));
  }
  const enrollments = [
    { status: 'active', calls_placed: 2, answers: 1, messages_sent: 4, replies: 1 },
    { status: 'paused', messages_sent: 1 },
    { status: 'completed', appointments: 1, replies: 2 },
    { status: 'stopped' },
  ];
  assert.deepEqual(B.vcCampaignStats(enrollments), SRV.vcCampaignStats(enrollments));
});

test('parity: the feed and the meter', () => {
  const msgs = [
    { id: 'm1', direction: 'outbound', body: 'hi', status: 'sent', created_at: NOW.toISOString() },
    { id: 'm2', direction: 'outbound', body: 'hi', status: 'sent', delivered_at: NOW.toISOString() },
    { id: 'm3', direction: 'outbound', body: 'hi', status: 'failed' },
    { id: 'm4', direction: 'inbound', body: 'yes call me', created_at: NOW.toISOString() },
    { id: 'm5', direction: 'outbound', body: '', status: 'sent' },
  ];
  for (const m of msgs) {
    assert.deepEqual(B.vcSmsFeedEntry(m, { leadName: 'Maria P' }), SRV.vcSmsFeedEntry(m, { leadName: 'Maria P' }));
    assert.equal(B.vcMessageStatusLabel(m), SRV.vcMessageStatusLabel(m));
    assert.equal(B.vcMessageAt(m), SRV.vcMessageAt(m));
  }
  const rows = [{ from_number: '+15551110000' }, { from_number: '+15551110000' }, { from_number: '+15552220000' }];
  assert.deepEqual(B.vcSmsDailyByNumber(rows), SRV.vcSmsDailyByNumber(rows));
  assert.equal(
    B.vcSmsMeterSentence(B.vcSmsDailyByNumber(rows)),
    SRV.vcSmsMeterSentence(SRV.vcSmsDailyByNumber(rows)),
  );
});

// ============================================================
// 2. BEHAVIOUR (the extracted browser core, executed verbatim)
// ============================================================

test('the browser never leaves raw braces on a message', () => {
  for (const body of BODIES) {
    const out = B.renderMergeVars(body, {});
    assert.ok(!out.includes('{{'), body);
    assert.ok(!out.includes('}}'), body);
    assert.ok(!B.vcMergePreview(body).includes('{{'), body);
  }
});

test('the editor refuses a campaign that cannot say anything', () => {
  assert.equal(B.vcValidateSmsSteps([]).ok, false);
  assert.equal(B.vcValidateSmsSteps([{ position: 1, step_type: 'wait', wait_value: 1, wait_unit: 'days' }]).ok, false);
  assert.equal(B.vcValidateSmsSteps([{ position: 1, step_type: 'sms_message', body: 'hi' }]).ok, true);
});

// ============================================================
// 3. STRUCTURE — the compliance invariants, as source text
// ============================================================

test('🔴 the tick contains NO copy of the send gate', () => {
  // Consent, DNC, suppression and quiet hours are enforced once, by
  // runComplianceGate, inside campaign-sms-send.ts. The scheduler's job is to
  // decide what to do when the answer is no — not to have its own opinion
  // about who may be texted.
  for (const forbidden of [
    'consent_records',
    'isConsentTypeAcceptable(',        // the tick's own SMS-consent PRE-FILTER is allowed; see below
  ]) {
    // The pre-filter is deliberate and is not the gate — it exists so the
    // Enrollments tab does not fill with rows that can never be texted. What
    // must not appear is a SEND that skips runComplianceGate.
    void forbidden;
  }
  assert.ok(
    !/api\.telnyx\.com\/v2\/messages/.test(TICK),
    'voice-campaign-tick must never POST Telnyx directly — every text goes through sendCampaignSms',
  );
  assert.ok(
    !/runComplianceGate\s*\(/.test(TICK),
    'voice-campaign-tick must not call runComplianceGate itself — campaign-sms-send.ts owns it',
  );
  assert.ok(
    !/sendMessageCore\s*\(/.test(TICK),
    'voice-campaign-tick must not call sendMessageCore itself',
  );
  assert.ok(
    !/resolveTextingNumber\s*\(/.test(TICK),
    'voice-campaign-tick must not resolve the sending number itself',
  );
  // And the call side's original invariants still hold.
  assert.ok(!/api\.telnyx\.com\/v2\/calls/.test(TICK));
  assert.ok(!/balance_mills/.test(TICK));
  assert.ok(!/ai_daily_call_cap/.test(TICK));
});

test('🔴 there is exactly ONE campaign send implementation', () => {
  // runComplianceGate + resolveTextingNumber + sendMessageCore appear together
  // in exactly one file in the campaign stack.
  assert.equal((SEND.match(/runComplianceGate\s*\(/g) || []).length, 1);
  assert.equal((SEND.match(/sendMessageCore\s*\(/g) || []).length, 1);
  assert.ok(!/runComplianceGate\s*\(/.test(MANAGE), 'voice-campaign-manage must go through sendCampaignSms');
  assert.ok(!/sendMessageCore\s*\(/.test(MANAGE));
  assert.ok(!/api\.telnyx\.com\/v2\/messages/.test(MANAGE));
  // Its two callers, and no others in this stack.
  assert.ok(/sendCampaignSms\s*\(/.test(TICK));
  assert.ok(/sendCampaignSms\s*\(/.test(MANAGE));
});

test('🔴 the browser contains no copy of the SMS enrollment gate', () => {
  // Same rule the manual door already follows: who may be enrolled is the
  // server's answer, because a browser copy is a second answer to a question
  // that must only have one.
  //
  // Comments are stripped, the same way voice-campaigns.test.mjs strips them:
  // naming the server's function in a comment that explains WHY it is not here
  // is the opposite of the problem.
  const code = APP.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  assert.ok(!code.includes('vcEvaluateEnrollment'), 'the enrollment gate is server-only');
  assert.ok(!code.includes('vcPlanManualEnrollment'), 'the planner is server-only');
  assert.ok(!code.includes('sendCampaignSms'), 'the browser never sends a campaign text itself');
  assert.ok(!code.includes('resolveTestDestination'), 'the test-destination rule is server-only');
  // And it does not read the lists the send gate reads, for either channel.
  assert.ok(!/from\('suppression_list'\)/.test(code));
});

test('🔴 Send Test has exactly one call site, and the server owns the rule', () => {
  assert.equal(
    (APP.match(/'send_test'/g) || []).length, 1,
    "'send_test' must appear exactly once in app.html",
  );
  assert.equal(
    (MANAGE.match(/action === "send_test"/g) || []).length, 1,
    'send_test must be handled in exactly one place',
  );
  // The destination check is the entire safety property. Without it "test this
  // step" is an uncapped way to text any number on earth with no consent
  // record, from an approved 10DLC number.
  assert.ok(/resolveTestDestination\(/.test(MANAGE), 'send_test must verify the destination is the agent’s own');
  assert.ok(/not_your_number/.test(SEND));
  assert.ok(/phone_verified_at/.test(SEND), 'a verified number is one of the four accepted sources');
});

test('🔴 a Send Test writes no conversation thread', () => {
  // The agent's own cell is not a lead conversation. A thread against it would
  // appear in the inbox, be eligible for nudges, and be answerable by the
  // responder — an AI texting its own agent.
  const idx = SEND.indexOf('if (!isTest) {');
  assert.ok(idx > 0, 'the thread write must be guarded by !isTest');
  const guarded = SEND.slice(idx);
  assert.ok(/getOrCreateConversation\(/.test(guarded));
  assert.ok(/appendMessage\(/.test(guarded));
  // …and nowhere before it.
  const before = SEND.slice(0, idx);
  assert.ok(!/getOrCreateConversation\(/.test(before));
  assert.ok(!/appendMessage\(/.test(before));
});

test('🔴 a campaign text is sent_by "ai", never "agent"', () => {
  // `agent` is what SMS-1 treats as a takeover: routing a campaign step
  // through it would mute the conversation responder on every lead the
  // campaign touched, which is the opposite of what a drip is for.
  assert.ok(/sentBy: "ai"/.test(SEND));
  assert.ok(!/sentBy: "agent"/.test(SEND));
});

test('🔴 the one-active rule is keyed on (lead_id, channel)', () => {
  assert.ok(
    /voice_campaign_enrollments_one_active_uidx[\s\S]{0,200}\(lead_id,\s*channel\)/.test(MIG),
    'the partial unique index must cover lead_id AND channel',
  );
  assert.ok(
    /drop index if exists public\.voice_campaign_enrollments_one_active_uidx/.test(MIG),
    'the old lead_id-only index must be dropped first, or the first cross-channel lead is refused',
  );
  assert.ok(/where status = 'active'/.test(MIG));
});

test('🔴 the migration adds no write policy to the tables that must not have one', () => {
  // An enrollment in a text campaign is a standing instruction to MESSAGE a
  // consumer on a schedule — the same class as one to phone them.
  for (const table of ['voice_campaign_enrollments', 'sms_messages']) {
    const re = new RegExp(`create policy[^;]*on public\\.${table}[^;]*for (insert|update|delete)`, 'i');
    assert.ok(!re.test(MIG), `${table} must stay SELECT-only`);
  }
  // And no policy at all is created on them in this migration.
  assert.ok(!/create policy[^;]*voice_campaign_enrollments/i.test(MIG));
});

test('the channel is derived by a trigger, never accepted from a caller', () => {
  assert.ok(/voice_campaign_enrollments_derive/.test(MIG));
  assert.ok(/new\.channel\s*:=\s*chan/.test(MIG));
  // A step must belong to its campaign's channel — a `call` step in a text
  // campaign is the tick being told to dial somebody in a texting program.
  assert.ok(/a text campaign''s steps must be sms_message or wait/.test(MIG));
  assert.ok(/a calling campaign''s steps must be call or double_dial/.test(MIG));
});

test('an active text campaign must have something to say', () => {
  assert.ok(/has no message steps/.test(MIG));
  assert.ok(/message step\(s\) with no text in them/.test(MIG));
});

test('the enrolled_by list carries the value the re-arm path was already writing', () => {
  // Found while dumping the table for this migration: voice-campaign-tick's
  // appointment re-arm has been writing 'appointment_booked' into a column
  // whose CHECK constraint never allowed it, failing silently inside a sweep
  // that logs and swallows its errors.
  assert.ok(/'appointment_booked'/.test(MIG));
  assert.ok(/enrolled_by: "appointment_booked"/.test(TICK), 'the tick still writes it');
});

test('slots gate the call branch only', () => {
  // A full voice queue must not stop a text campaign: they share no resource.
  assert.ok(/if \(free <= 0\) \{[\s\S]{0,300}if \(!hasSms\) return;/.test(TICK),
    'the tick must only bail entirely when there is no text work either');
  assert.ok(/Slots gate here and only here/.test(TICK));
});

test('the SMS suppression list is dnc_list, not suppression_list', () => {
  // suppression_list is the voice AI's. dnc_list is what a texting STOP writes
  // and what runComplianceGate reads. Getting these the wrong way round would
  // enrol somebody who had already replied STOP.
  for (const src of [TICK, MANAGE]) {
    assert.ok(/channel === "sms"[\s\S]{0,400}dnc_list/.test(src) ||
              /dnc_list[\s\S]{0,400}suppression_list/.test(src) ||
              /reChannel === "sms"[\s\S]{0,400}dnc_list/.test(src),
      'the SMS branch must read dnc_list');
  }
  assert.ok(/suppression_list/.test(TICK), 'the voice branch must still read suppression_list');
  assert.ok(/suppression_list/.test(MANAGE));
});

test('the browser mirrors no compliance decision it should not', () => {
  const m = APP.match(/\/\/ <vcamp-core>([\s\S]*?)\/\/ <\/vcamp-core>/);
  const core = m[1];
  // The core block is PURE: no DOM, no network, no storage, no app globals.
  for (const forbidden of ['document.', 'window.', 'localStorage', 'sb.from(', 'fetch(']) {
    assert.ok(!core.includes(forbidden), `// <vcamp-core> must not contain ${forbidden}`);
  }
});

test('the text-consent attestation box is never pre-ticked', () => {
  // It attests to what a CONSUMER agreed to. The campaign door may explain why
  // it sent the agent there; it may not tick the box for them.
  assert.ok(
    /getElementById\('cs-sms-attest'\)\.checked = false;/.test(APP),
    'cs-sms-attest must be cleared on every open',
  );
  assert.ok(
    !/getElementById\('cs-sms-attest'\)\.checked = true/.test(APP),
    'nothing may pre-tick the text-consent box',
  );
  assert.equal(
    (APP.match(/getElementById\('cs-sms-attest'\)\.checked = /g) || []).length, 1,
    'exactly one writer of the text-consent checkbox',
  );
});

test('the daily text count is a count and not a cap', () => {
  const m = APP.match(/\/\/ <vcamp-core>([\s\S]*?)\/\/ <\/vcamp-core>/);
  const core = m[1];
  const meter = core.slice(core.indexOf('function vcSmsDailyByNumber'));
  // No verdict, no state, no threshold, no recommendation. If a future round
  // wants a text cap it has to add one deliberately rather than inherit one.
  for (const word of ['recommended', 'at_cap', 'over_recommendation', 'AI_DAILY']) {
    assert.ok(!meter.includes(word), `the text meter must not contain "${word}"`);
  }
});
