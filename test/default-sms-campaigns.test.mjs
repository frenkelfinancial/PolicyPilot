// ============================================================
// default-sms-campaigns.test.mjs — run with:  npm run test:defaultsms
//
// The twelve pre-written TEXT campaigns (SMS-3), the seeder that installs them
// switched OFF, and the one-click switch that turns one on.
//
// Six kinds of test:
//
//   1. THE TWELVE THEMSELVES. The seed JSON is extracted out of the migration
//      text — it lives in exactly one place, inside vc_default_sms_campaigns()
//      — and every rule is run through the REAL matcher and the REAL validator
//      from voice-campaign-core.ts. A campaign whose rule matches nobody, or
//      matches everybody, fails here.
//
//   2. THE COPY, mechanically. Every body goes through the REAL renderer twice
//      (full sample values, and then nothing at all) and the REAL segment
//      counter. No raw braces, no holes, no UCS-2, and the opt-out rule is
//      checked position by position.
//
//   3. 🔴 THE SEED KEYS ARE THE SMS AI CAMPAIGN TYPES. sendCampaignSms passes
//      seed_key through as the conversation's campaign_type and loadSettings()
//      matches it EXACTLY with a silent fallback to `default`, so a drifted key
//      answers the whole campaign in the wrong voice and nothing errors.
//
//   4. THE SEEDER'S PROMISES, as source text: it writes the campaign INACTIVE
//      before its steps and only then activates (the SMS-2 contract); re-running
//      adds nothing; a deleted campaign is never resurrected; and all twelve
//      ship off.
//
//   5. APPOINTMENT-ANCHORED STEP MATH for the reminder sequence, including
//      skip-if-past, run through both the server core and the extracted
//      browser core — plus the hold that must not fire an anchored step late.
//
//   6. THE SCREEN: the off-card sentence, the one-click switch, and the confirm
//      that restates the consent gate.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as SRV from '../supabase/functions/_shared/voice-campaign-core.ts';
import { SMS_AI_TYPES } from '../supabase/functions/_shared/sms-ai-core.ts';
import { countSegments } from '../supabase/functions/_shared/segments.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Normalised to LF: these files are edited on Windows, and a source-text
// assertion that depends on the line ending is a test that passes on one
// machine and fails on the next.
const read = (p) => readFileSync(join(ROOT, p), 'utf8').split('\r\n').join('\n');

const APP       = read('app.html');
const MIG       = read('supabase/migrations/20260808_default_sms_campaigns.sql');
const VOICE_MIG = read('supabase/migrations/20260803_default_voice_campaigns.sql');
const TICK      = read('supabase/functions/voice-campaign-tick/index.ts');
const CORE      = read('supabase/functions/_shared/voice-campaign-core.ts');

// ------------------------------------------------------------
// The seed JSON, straight out of the migration. One copy, and this is it.
// ------------------------------------------------------------
function loadFrom(src, what) {
  const m = src.match(/\$json\$([\s\S]*?)\$json\$::jsonb/);
  assert.ok(m, `${what} must carry its defaults inside a $json$…$json$::jsonb literal`);
  return JSON.parse(m[1]);
}
const DEFAULTS = loadFrom(MIG, 'the SMS migration');
const VOICE    = loadFrom(VOICE_MIG, 'the voice migration');

// The browser core, executed verbatim — the exact text that ships.
const BROWSER_EXPORTS = [
  'vcValidateTriggerGroups', 'vcMatchesTriggerGroups', 'vcValidateSmsSteps',
  'vcMergePreview', 'renderMergeVars', 'vcMergeIssues', 'vcBodyStats',
  'vcStepIsAnchored', 'vcAnchoredDueAt', 'vcResolveNextDue', 'vcStepsSorted',
  'vcStepIsActionable', 'VC_MERGE_VARS',
];
function loadBrowserCore() {
  const m = APP.match(/\/\/ <vcamp-core>([\s\S]*?)\/\/ <\/vcamp-core>/);
  assert.ok(m, 'app.html must contain the // <vcamp-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${BROWSER_EXPORTS.join(',')}};`)();
}
const B = loadBrowserCore();

const bySeed = new Map(DEFAULTS.map((d) => [d.seed_key, d]));
const voiceBySeed = new Map(VOICE.map((d) => [d.seed_key, d]));
const msgSteps = (d) => (d.steps || []).filter((s) => s.step_type === 'sms_message');

// ============================================================
// 1. The twelve
// ============================================================

// The step counts are the owner's locked decision for this round ("match or
// beat"), taken from the Orion teardown. They are in the table because a
// campaign quietly losing half its cadence is invisible on screen.
const EXPECTED = {
  appointment_reminder: { name: 'Appointment Reminder (text)', min: 7,  voice: 'appointment_reminder_v1' },
  no_show_followup:     { name: 'No-Show Follow-Up (text)',    min: 18, voice: 'no_show_followup_v1' },
  customer_care_sold:   { name: 'Customer Care (text)',        min: 12, voice: 'customer_care_sold_v1' },
  emergency_contact:    { name: 'Emergency Contact (text)',    min: 8,  voice: 'emergency_contact_v1' },
  beneficiary_referral: { name: 'Beneficiary Referral (text)', min: 8,  voice: 'beneficiary_referral_v1' },
  chargeback_recovery:  { name: 'Chargeback Recovery (text)',  min: 10, voice: 'chargeback_recovery_v1' },
  veteran_lead:         { name: 'Veteran (text)',              min: 26, voice: 'veteran_lead_v1' },
  final_expense:        { name: 'Final Expense (text)',        min: 24, voice: 'final_expense_v1' },
  mortgage_protection:  { name: 'Mortgage Protection (text)',  min: 24, voice: 'mortgage_protection_v1' },
  iul:                  { name: 'IUL (text)',                  min: 24, voice: 'iul_v1' },
  general_life:         { name: 'General Life (text)',         min: 24, voice: 'general_life_v1' },
  trucker:              { name: 'Trucker (text)',              min: 24, voice: 'trucker_v1' },
};

test('there are exactly twelve, at or past the depth the brief specified', () => {
  assert.equal(DEFAULTS.length, 12);
  assert.equal(bySeed.size, 12, 'seed_key must be unique across the twelve');
  for (const [key, want] of Object.entries(EXPECTED)) {
    const d = bySeed.get(key);
    assert.ok(d, `missing default SMS campaign ${key}`);
    assert.equal(d.name, want.name, `${key} name`);
    // MESSAGE steps, not rows. A `wait` step is scheduling, not a touch, and
    // counting one toward the depth would be padding the number the owner set.
    assert.ok(msgSteps(d).length >= want.min,
      `${key} has ${msgSteps(d).length} message steps, the brief asked for at least ${want.min}`);
  }
});

test('🔴 THE SEED KEYS ARE THE SMS AI CAMPAIGN TYPES, CHARACTER FOR CHARACTER', () => {
  // voice-campaign-tick passes campaign.seed_key straight through as
  // campaignType; sms-thread's loadSettings() matches it against
  // sms_ai_settings.campaign_type with an EXACT compare and a silent fallback
  // to `default`. A drifted key does not fail — it answers every message of
  // that campaign in the Default voice, for ever.
  const wanted = SMS_AI_TYPES.filter((t) => t !== 'default').slice().sort();
  const got = DEFAULTS.map((d) => d.seed_key).slice().sort();
  assert.deepEqual(got, wanted,
    'the twelve SMS seed keys must be exactly SMS_AI_TYPES minus "default"');
});

test('the tick still passes seed_key through as the conversation campaign_type', () => {
  // If this stops being true the alignment above stops mattering, and the next
  // person to read the rule will not know it was ever load-bearing.
  assert.match(TICK, /campaignType:\s*\(campaign\.seed_key as string\)\s*\|\|\s*null/);
});

test('no SMS seed key collides with a voice one — the tombstone is one table', () => {
  for (const d of DEFAULTS) {
    assert.ok(!voiceBySeed.has(d.seed_key),
      `${d.seed_key} is also a voice default's key; (agent_id, seed_key) would collide`);
  }
});

test('every campaign has a unique sort_order, and all of them sort after the voice twelve', () => {
  const orders = DEFAULTS.map((d) => d.sort_order);
  assert.equal(new Set(orders).size, 12, 'sort_order must be unique');
  const voiceMax = Math.max(...VOICE.map((d) => d.sort_order));
  for (const d of DEFAULTS) {
    assert.equal(typeof d.sort_order, 'number');
    assert.ok(d.sort_order > voiceMax,
      `${d.seed_key} sorts at ${d.sort_order}, inside the voice range`);
  }
});

test('🔴 ALL TWELVE SHIP SWITCHED OFF', () => {
  for (const d of DEFAULTS) {
    assert.equal(d.active, false,
      `${d.seed_key} ships active — a surprise text is more invasive than a missed call`);
  }
});

test('every campaign is channel sms, and carries only text step types', () => {
  for (const d of DEFAULTS) {
    assert.equal(d.channel, 'sms', `${d.seed_key} channel`);
    for (const s of d.steps) {
      assert.ok(['sms_message', 'wait'].includes(s.step_type),
        `${d.seed_key} step ${s.position} is ${s.step_type} — a call step in a text campaign would dial somebody`);
    }
  }
});

test('every rule passes the guard — on the server AND in the editor', () => {
  for (const d of DEFAULTS) {
    const srv = SRV.vcValidateTriggerGroups(d.trigger_groups);
    const brw = B.vcValidateTriggerGroups(d.trigger_groups);
    assert.equal(srv.ok, true, `${d.seed_key}: ${srv.error}`);
    assert.equal(brw.ok, true, `${d.seed_key} (browser): ${brw.error}`);
  }
});

test('every campaign passes the SMS step validator it will be switched on against', () => {
  for (const d of DEFAULTS) {
    const srv = SRV.vcValidateSmsSteps(d.steps);
    const brw = B.vcValidateSmsSteps(d.steps);
    assert.equal(srv.ok, true, `${d.seed_key}: ${srv.error}`);
    assert.equal(brw.ok, true, `${d.seed_key} (browser): ${brw.error}`);
  }
});

test('🔴 EVERY TRIGGER MIRRORS ITS VOICE SIBLING EXACTLY', () => {
  // An agent who tags a lead `veteran` expects the calling campaign AND the
  // texting campaign to recognise it. Two definitions of "this is a veteran
  // lead" on one book is the bug class this repo has already fixed four times.
  for (const [key, want] of Object.entries(EXPECTED)) {
    const sms = bySeed.get(key);
    const voice = voiceBySeed.get(want.voice);
    assert.ok(voice, `voice sibling ${want.voice} not found`);
    assert.deepEqual(sms.trigger_groups, voice.trigger_groups,
      `${key} trigger_groups must be identical to ${want.voice}'s`);
  }
});

test('the enrollment triggers mirror the voice siblings too', () => {
  const FLAGS = ['auto_enroll_new_leads', 'trigger_on_missed_appointment',
    'trigger_on_sold', 'trigger_on_appointment_booked'];
  for (const [key, want] of Object.entries(EXPECTED)) {
    const sms = bySeed.get(key);
    const voice = voiceBySeed.get(want.voice);
    for (const f of FLAGS) {
      assert.equal(sms[f], voice[f], `${key}.${f} differs from ${want.voice}`);
    }
  }
});

test('every campaign names at least one enrollment trigger — one with none enrols nobody, for ever', () => {
  for (const d of DEFAULTS) {
    const any = d.auto_enroll_new_leads || d.trigger_on_missed_appointment ||
      d.trigger_on_sold || d.trigger_on_appointment_booked;
    assert.ok(any, `${d.seed_key} has no enrollment trigger`);
  }
});

// ---- Trigger mapping, against synthetic leads of each type ------------------

const lead = (data, extra = {}) => ({ id: 'x', data, tcpa_consent: true, dnc: false, ...extra });

const MATCH_CASES = [
  ['veteran_lead',         [{ campaign_tag: 'veteran' }, { lead_type: 'Veteran' }, { type: 'va' }]],
  ['final_expense',        [{ campaign_tag: 'final_expense' }, { coverage_wanted: 'Final Expense' }, { lead_type: 'fex' }]],
  ['mortgage_protection',  [{ campaign_tag: 'mortgage_protection' }, { lead_type: 'Mortgage Protection' }]],
  ['iul',                  [{ campaign_tag: 'iul' }, { lead_type: 'IUL' }]],
  ['general_life',         [{ campaign_tag: 'general_life' }, { lead_type: 'term life' }]],
  ['trucker',              [{ campaign_tag: 'trucker' }, { lead_type: 'CDL' }]],
  ['chargeback_recovery',  [{ campaign_tag: 'chargeback' }, { status: 'chargeback' }]],
  ['customer_care_sold',   [{ status: 'sold' }]],
  ['emergency_contact',    [{ status: 'sold' }]],
  ['beneficiary_referral', [{ status: 'sold' }]],
  ['appointment_reminder', [{ status: 'appointment' }]],
  ['no_show_followup',     [{ status: 'appointment' }]],
];

test('each campaign matches leads of its own type, on the server and in the editor', () => {
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

test('NO campaign matches an untagged lead — the twelve must never text a whole book', () => {
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

test('step positions are 1..n with no gaps and no duplicates', () => {
  for (const d of DEFAULTS) {
    const pos = (d.steps || []).map((s) => s.position);
    assert.deepEqual(pos, pos.map((_, i) => i + 1), `${d.seed_key} step positions`);
  }
});

test('the lead-type sequences are speed-to-lead, front-loaded, and then span months', () => {
  const LEAD_TYPES = ['veteran_lead', 'final_expense', 'mortgage_protection',
    'iul', 'general_life', 'trucker'];
  const DAY = 24 * 60 * 60 * 1000;
  for (const key of LEAD_TYPES) {
    const d = bySeed.get(key);
    const first = d.steps.find((s) => s.position === 1);
    assert.equal(first.wait_unit, 'minutes', `${key} step 1 unit`);
    assert.ok(first.wait_value <= 2, `${key} step 1 waits ${first.wait_value} ${first.wait_unit}`);

    // Front-loaded: at least five touches inside the first week.
    let ms = 0, inWeek = 0, total = 0;
    for (const s of d.steps) {
      ms += SRV.vcWaitMs(s.wait_value, s.wait_unit);
      if (ms <= 7 * DAY) inWeek++;
      total = ms;
    }
    assert.ok(inWeek >= 5, `${key} only makes ${inWeek} touches in the first week`);
    // …then decaying: the whole thing spans months, not weeks.
    assert.ok(total >= 300 * DAY, `${key} spans ${Math.round(total / DAY)} days`);
  }
});

test('the cadence never goes backwards inside the first week, then only widens', () => {
  // "front-loaded first week, then decaying cadence: days -> weeks". A gap that
  // shrinks late in a sequence is a sequence that gets MORE annoying over time.
  for (const d of DEFAULTS) {
    const anchored = d.steps.some((s) => s.anchor === 'appointment');
    if (anchored) continue;
    const waits = d.steps.map((s) => SRV.vcWaitMs(s.wait_value, s.wait_unit));
    for (let i = 2; i < waits.length; i++) {
      assert.ok(waits[i] >= waits[i - 1],
        `${d.seed_key}: step ${i + 1} waits less than step ${i} — the cadence tightens instead of decaying`);
    }
  }
});

// ============================================================
// 2. The copy
// ============================================================

const SAMPLE = Object.fromEntries(SRV.VC_MERGE_VARS.map((v) => [v.key, v.sample]));
const EMPTY  = Object.fromEntries(SRV.VC_MERGE_VARS.map((v) => [v.key, '']));

test('🔴 A RAW {{…}} NEVER SURVIVES — with full values and with none at all', () => {
  for (const d of DEFAULTS) {
    for (const s of msgSteps(d)) {
      for (const [label, vals] of [['sample', SAMPLE], ['empty', EMPTY]]) {
        const out = SRV.renderMergeVars(s.body, vals);
        assert.ok(!/\{\{|\}\}/.test(out),
          `${d.seed_key} step ${s.position} (${label}) still has braces: ${out}`);
        assert.ok(out.trim().length > 0,
          `${d.seed_key} step ${s.position} (${label}) rendered empty`);
        // The tidy pass exists so a hole does not surface as "Hi , how are you".
        assert.ok(!/\s{2,}/.test(out),
          `${d.seed_key} step ${s.position} (${label}) has a double space: ${out}`);
        assert.ok(!/\s[,.!?;:]/.test(out),
          `${d.seed_key} step ${s.position} (${label}) has a space before punctuation: ${out}`);
      }
      // Browser and server must render the same thing — the editor's preview is
      // the only thing an agent ever reads before a consumer does.
      assert.equal(B.renderMergeVars(s.body, SAMPLE), SRV.renderMergeVars(s.body, SAMPLE),
        `${d.seed_key} step ${s.position}: browser and server previews differ`);
    }
  }
});

test('every variable used is one of the six that exist', () => {
  for (const d of DEFAULTS) {
    for (const s of msgSteps(d)) {
      const issues = SRV.vcMergeIssues(s.body);
      assert.deepEqual(issues.unknown, [],
        `${d.seed_key} step ${s.position} uses {{${issues.unknown[0]}}}, which is not a variable`);
    }
  }
});

test('🔴 EVERY BODY IS GSM-7, SO A SEGMENT IS 153 CHARACTERS AND NOT 67', () => {
  // One em dash, curly quote or emoji anywhere forces UCS-2 on the WHOLE
  // message. At 24 steps across 12 campaigns that is a permanent surcharge on
  // every send, for punctuation nobody asked for.
  for (const d of DEFAULTS) {
    for (const s of msgSteps(d)) {
      const rendered = SRV.renderMergeVars(s.body, SAMPLE);
      const info = countSegments(rendered);
      assert.equal(info.encoding, 'GSM7',
        `${d.seed_key} step ${s.position} is UCS-2: ${JSON.stringify(rendered)}`);
      // Also check the raw template, so a non-GSM character hiding inside a
      // part the sample happens to replace cannot slip through.
      assert.equal(countSegments(s.body).encoding, 'GSM7',
        `${d.seed_key} step ${s.position} template is UCS-2`);
    }
  }
});

test('no message is longer than three segments, and most are one or two', () => {
  let one = 0, total = 0;
  for (const d of DEFAULTS) {
    for (const s of msgSteps(d)) {
      const info = countSegments(SRV.renderMergeVars(s.body, SAMPLE));
      assert.ok(info.segments <= 3,
        `${d.seed_key} step ${s.position} is ${info.segments} segments`);
      if (info.segments === 1) one++;
      total++;
    }
  }
  assert.ok(one / total >= 0.5,
    `only ${one}/${total} messages fit in one segment — this is a text, not an email`);
});

test('the browser segment estimate agrees with the biller, body for body', () => {
  for (const d of DEFAULTS) {
    for (const s of msgSteps(d)) {
      const srv = SRV.vcBodyStats(s.body, { countSegments });
      const brw = B.vcBodyStats(s.body, { countSegments });
      assert.deepEqual(brw, srv, `${d.seed_key} step ${s.position} stats`);
    }
  }
});

// ---- The opt-out rule -------------------------------------------------------
//
// A message must carry an opt-out line when it is (a) the first message,
// (b) at a position congruent to 1 mod 5, or (c) the first message after a gap
// of 45 days or more. Anywhere else it is allowed but not required.
const DAY_MS = 24 * 60 * 60 * 1000;
const hasOptOut = (body) => /reply\s+stop/i.test(body);
function optOutRequired(d) {
  const req = [];
  const msgs = msgSteps(d);
  msgs.forEach((s, i) => {
    const gapMs = SRV.vcWaitMs(s.wait_value, s.wait_unit);
    if (i === 0 || s.position % 5 === 1 || gapMs >= 45 * DAY_MS) req.push(s.position);
  });
  return req;
}

test('🔴 THE FIRST MESSAGE OF EVERY SEQUENCE IDENTIFIES THE SENDER AND OFFERS THE OPT-OUT', () => {
  for (const d of DEFAULTS) {
    const first = msgSteps(d)[0];
    assert.ok(hasOptOut(first.body),
      `${d.seed_key} step ${first.position} does not offer an opt-out`);
    assert.ok(first.body.includes('{{agentName}}') && first.body.includes('{{companyName}}'),
      `${d.seed_key} step ${first.position} does not say who is texting`);
  }
});

test('the opt-out line comes back every fifth message, and after any gap of 45 days or more', () => {
  for (const d of DEFAULTS) {
    for (const pos of optOutRequired(d)) {
      const s = d.steps.find((x) => x.position === pos);
      assert.ok(hasOptOut(s.body),
        `${d.seed_key} step ${pos} must carry an opt-out line`);
    }
  }
});

test('the opt-out line survives rendering with no values at all', () => {
  for (const d of DEFAULTS) {
    for (const pos of optOutRequired(d)) {
      const s = d.steps.find((x) => x.position === pos);
      assert.ok(hasOptOut(SRV.renderMergeVars(s.body, EMPTY)),
        `${d.seed_key} step ${pos} loses its opt-out when nothing resolves`);
    }
  }
});

// ---- What the copy must never say ------------------------------------------

const BANNED = [
  [/guarantee(d)?\s+(approval|acceptance|issue)/i, 'guaranteed approval'],
  [/no\s+(medical\s+)?(questions|exam)\s+(asked|required|needed)/i, 'a blanket no-questions promise'],
  [/\b(rates?|prices?|premiums?)\s+(will\s+)?(double|triple|go\s+up)\s+(tomorrow|today|tonight|this\s+week)/i, 'fake urgency'],
  [/\b(act|call|reply)\s+(now|today)\s+(or|before)\b/i, 'fake urgency'],
  [/\blast\s+chance\b/i, 'fake urgency'],
  [/\bexpires?\s+(today|tonight|tomorrow|at\s+midnight)\b/i, 'fake urgency'],
  [/\bfree\s+(money|cash)\b/i, 'a false inducement'],
  [/\b(only|just)\s+\$\d/i, 'a premium promise'],
  [/\bas\s+low\s+as\s+\$/i, 'a premium promise'],
  [/\byou\s+(will|'ll)\s+be\s+approved\b/i, 'an underwriting promise'],
  [/\b(worst|terrible|awful|rip[- ]?off)\b/i, 'disparagement'],
  [/\bgovernment\s+(program|benefit)\b/i, 'an implied government affiliation'],
  [/\b(we\s+are|we're|this\s+is)\s+the\s+VA\b/i, 'an implied government affiliation'],
  [/\bdebt\s+collect/i, 'collections language'],
  [/\b(past\s+due|amount\s+owed|you\s+owe)\b/i, 'collections language'],
];

test('no message makes a promise this industry does not let anybody make', () => {
  for (const d of DEFAULTS) {
    for (const s of msgSteps(d)) {
      for (const [re, what] of BANNED) {
        assert.ok(!re.test(s.body),
          `${d.seed_key} step ${s.position} contains ${what}: ${s.body}`);
      }
    }
  }
});

test('the veteran sequence says plainly that this is not the VA', () => {
  const vet = bySeed.get('veteran_lead');
  const first = msgSteps(vet)[0];
  assert.match(first.body, /not the VA/i,
    'the opening message must say what this is not, before it says what it is');
  const anySupplement = msgSteps(vet).some((s) => /doesn't replace|does not replace|alongside/i.test(s.body));
  assert.ok(anySupplement, 'the sequence must say this sits alongside VA benefits, not instead of them');
});

test('chargeback recovery is empathetic, not collections', () => {
  const cb = bySeed.get('chargeback_recovery');
  for (const s of msgSteps(cb)) {
    assert.ok(!/\b(owe|owed|arrears|delinquent|overdue|collections?)\b/i.test(s.body),
      `chargeback step ${s.position} sounds like collections: ${s.body}`);
  }
  assert.ok(msgSteps(cb).some((s) => /put it back|back in place|reinstat/i.test(s.body)),
    'the sequence must offer to fix the coverage, which is the whole point of it');
});

test('🔴 BENEFICIARY REFERRAL ASKS THE CLIENT, AND NEVER TEXTS A BENEFICIARY', () => {
  // referralsFromPolicy() deliberately creates a referral lead with NO consent,
  // so leadTextingState() renders it needs_optin and runComplianceGate refuses.
  // This campaign must not be the thing that routes around that: it triggers on
  // the INSURED being sold, and it asks THEM to pass the number on.
  const ref = bySeed.get('beneficiary_referral');
  assert.equal(ref.trigger_on_sold, true);
  assert.deepEqual(ref.trigger_groups,
    [{ conditions: [{ field: 'status', op: 'is', value: 'sold' }] }],
    'the audience is the client who was sold, never anybody they named');
  assert.ok(msgSteps(ref).some((s) => /pass on my number|pass my name|passing my name/i.test(s.body)),
    'the ask must be for the CLIENT to pass the number on, not for their details');
  for (const s of msgSteps(ref)) {
    assert.ok(!/(send|give)\s+me\s+(their|his|her)\s+(number|phone|details)/i.test(s.body),
      `referral step ${s.position} asks for somebody else's number: ${s.body}`);
  }
});

test('the no-show sequence never blames them for missing it', () => {
  const ns = bySeed.get('no_show_followup');
  for (const s of msgSteps(ns)) {
    assert.ok(!/\b(you\s+missed|you\s+didn't|you\s+failed|no[- ]show(ed)?)\b/i.test(s.body),
      `no-show step ${s.position} shames the lead: ${s.body}`);
  }
  assert.match(msgSteps(ns)[0].body, /missed each other/i,
    'the first message should make the miss mutual, because that is what it usually was');
});

test('the sold-triggered care sequence does not stop when a client says thanks', () => {
  const care = bySeed.get('customer_care_sold');
  assert.equal(care.trigger_on_sold, true);
  assert.equal(care.stop_on_sold, false,
    'stop_on_sold on a sold-triggered campaign stops it the instant it starts');
  assert.equal(care.stop_on_reply, false,
    'a check-in sequence that ends the first time a client replies is a check-in sequence that never runs');
  // …and the same for the reminder, which must still remind after "see you then".
  assert.equal(bySeed.get('appointment_reminder').stop_on_reply, false);
});

test('every sequence that is trying to reach somebody DOES stop when they write back', () => {
  const SHOULD_STOP = ['no_show_followup', 'emergency_contact', 'beneficiary_referral',
    'chargeback_recovery', 'veteran_lead', 'final_expense', 'mortgage_protection',
    'iul', 'general_life', 'trucker'];
  for (const key of SHOULD_STOP) {
    assert.equal(bySeed.get(key).stop_on_reply, true, `${key} must end on a reply`);
  }
});

test('every campaign holds while a conversation is live', () => {
  for (const d of DEFAULTS) {
    assert.equal(d.pause_on_active_conversation, true,
      `${d.seed_key} would text over the top of a real exchange`);
  }
});

// ============================================================
// 3. The seeder
// ============================================================

const SEEDER = (() => {
  const s = MIG.indexOf('function public.vc_seed_default_sms_campaigns_for');
  const e = MIG.indexOf('revoke all on function public.vc_seed_default_sms_campaigns_for');
  assert.ok(s > 0 && e > s, 'seeder function not found');
  return MIG.slice(s, e);
})();

test('the seeder claims through the tombstone table, not by looking for the campaign', () => {
  assert.match(SEEDER, /insert into public\.voice_campaign_seed_state \(agent_id, seed_key\)[\s\S]{0,160}on conflict \(agent_id, seed_key\) do nothing/);
  assert.match(SEEDER, /if found then claimed := true; end if;/);
});

test('🔴 RE-SEEDING NEVER RESURRECTS A DELETED CAMPAIGN', () => {
  const deletes = MIG.match(/delete\s+from\s+public\.voice_campaign_seed_state/gi) || [];
  assert.equal(deletes.length, 0,
    'nothing in this migration may delete a seed tombstone — that is what makes a delete stick');
});

test('🔴 RE-SEEDING NEVER OVERWRITES, REACTIVATES OR DELETES AN EXISTING CAMPAIGN', () => {
  assert.ok(!/on conflict[\s\S]{0,80}do update/i.test(SEEDER),
    'the seeder must never upsert a campaign');
  assert.ok(!/delete\s+from\s+public\.voice_campaign/i.test(SEEDER),
    'the seeder must never delete a campaign or its steps');
  // The ONE update it contains is the activate step, and it may only ever run
  // against the row this iteration just created.
  const updates = SEEDER.match(/update\s+public\.voice_campaigns[\s\S]{0,120}/gi) || [];
  assert.equal(updates.length, 1, 'the seeder has exactly one UPDATE: the activate step');
  assert.match(updates[0], /set active = true where id = new_id/);
  // And the belt to those braces: an existing row wearing the seed_key is skipped.
  assert.match(SEEDER, /if exists \([\s\S]{0,200}from public\.voice_campaigns c[\s\S]{0,300}continue;/);
});

test('🔴 THE ORDER IS INSERT-INACTIVE -> STEPS -> ACTIVATE, IN ONE TRANSACTION', () => {
  // voice_campaigns_validate() refuses an ACTIVE text campaign with no
  // sms_message steps, and the campaign row necessarily precedes its steps.
  // This is the SMS-2 contract and it is not avoidable.
  const iCamp = SEEDER.indexOf('insert into public.voice_campaigns');
  const iStep = SEEDER.indexOf('insert into public.voice_campaign_steps');
  const iAct  = SEEDER.indexOf('update public.voice_campaigns set active = true');
  assert.ok(iCamp > 0 && iStep > iCamp && iAct > iStep,
    'campaign, then steps, then activate');
  // The campaign insert must hard-code false rather than read the default's flag.
  const campInsert = SEEDER.slice(iCamp, iStep);
  assert.match(campInsert, /\n\s+false,\s+-- ALWAYS false here/,
    'the insert must write active = false literally, whatever the default says');
});

test('the seeder writes a body and passes the anchor through', () => {
  const iStep = SEEDER.indexOf('insert into public.voice_campaign_steps');
  const stepInsert = SEEDER.slice(iStep, iStep + 1200);
  for (const col of ['body', 'anchor', 'offset_minutes', 'drip_rate', 'wait_value', 'wait_unit']) {
    assert.ok(stepInsert.includes(col),
      `the step insert drops ${col} — a field the seeder forgets is a field it silently erases`);
  }
});

test('the browser-callable seeder names no agent; the internal one is revoked', () => {
  assert.match(MIG, /create or replace function public\.vc_seed_default_sms_campaigns\(\)/);
  assert.match(MIG, /if auth\.uid\(\) is null then/);
  assert.match(MIG, /revoke all on function public\.vc_seed_default_sms_campaigns_for\(uuid\) from public, anon, authenticated/);
  assert.match(MIG, /grant execute on function public\.vc_seed_default_sms_campaigns\(\) to authenticated/);
  // No browser-callable function may take a parameter naming an agent.
  assert.ok(!/grant execute on function public\.vc_seed_default_sms_campaigns_for/.test(MIG));
});

test('a new signup gets the twelve, and a failure there cannot break sign-up', () => {
  assert.match(MIG, /create trigger agents_seed_sms_campaigns\s+after insert on public\.agents/);
  const fn = MIG.slice(MIG.indexOf('function public.agents_seed_sms_campaigns'),
    MIG.indexOf('drop trigger if exists agents_seed_sms_campaigns'));
  assert.match(fn, /exception when others then/,
    'a sign-up must never fail because a default campaign did not insert');
  // The voice hook is left alone — a change to the text seeder must not be able
  // to break the calling one.
  assert.ok(!/create or replace function public\.agents_seed_voice_campaigns/.test(MIG));
});

test('every existing agent is backfilled', () => {
  assert.match(MIG, /for a in select id from public\.agents[\s\S]{0,200}vc_seed_default_sms_campaigns_for\(a\.id\)/);
});

test('the migration does not touch the voice campaigns', () => {
  // Comments stripped: this file DISCUSSES the voice seeder at length, and a
  // sentence about it is not a call to it.
  const code = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/vc_default_campaigns\(\)/.test(code), 'the voice defaults are not read here');
  assert.ok(!/vc_seed_default_campaigns_for\(/.test(code), 'the voice seeder is not invoked here');
  assert.ok(!/channel = 'voice'/.test(code));
  // Every campaign row it writes is a text one.
  const iCamp = SEEDER.indexOf('insert into public.voice_campaigns');
  assert.match(SEEDER.slice(iCamp, iCamp + 1400), /'sms',/);
});

// ============================================================
// 4. Appointment-anchored math
// ============================================================

const REMINDER = bySeed.get('appointment_reminder');

test('the reminder is the only anchored campaign, and it is the only one that triggers on a booking', () => {
  for (const d of DEFAULTS) {
    const anchored = (d.steps || []).some((s) => s.anchor === 'appointment');
    assert.equal(anchored, d.seed_key === 'appointment_reminder',
      `${d.seed_key}: anchored steps and the appointment trigger must travel together`);
    if (anchored) assert.equal(d.trigger_on_appointment_booked, true);
  }
  assert.ok(REMINDER.steps.every((s) => s.anchor === 'appointment'),
    'every step of the reminder is anchored — a relative wait inside it would drift');
});

test('the anchored offsets are inside the range the database allows', () => {
  for (const s of REMINDER.steps) {
    assert.ok(s.offset_minutes >= -10080 && s.offset_minutes <= 10080,
      `step ${s.position} offset ${s.offset_minutes} is outside the +/- 7 day CHECK`);
  }
  const offs = REMINDER.steps.map((s) => s.offset_minutes);
  assert.deepEqual(offs, offs.slice().sort((a, b) => a - b), 'offsets must ascend with position');
  assert.equal(new Set(offs).size, offs.length, 'two steps at the same instant is one wasted text');
});

test('🔴 AN ANCHORED STEP WHOSE MOMENT HAS PASSED IS SKIPPED, NEVER FIRED LATE', () => {
  const appt = new Date('2026-08-10T15:00:00Z');
  const steps = REMINDER.steps;

  // Enrolled 9 days out: every step is still ahead, so it starts at step 1.
  const early = SRV.vcResolveNextDue({
    steps, now: new Date('2026-08-01T15:00:00Z'), appointmentAt: appt,
  });
  assert.equal(early.step.position, 1);
  assert.deepEqual(early.skipped, []);

  // Enrolled 90 minutes out: the week, 3-day, day and 4-hour steps have all
  // gone. It lands on the 1-hour one and skips four.
  const late = SRV.vcResolveNextDue({
    steps, now: new Date('2026-08-10T13:30:00Z'), appointmentAt: appt,
  });
  assert.equal(late.step.offset_minutes, -60);
  assert.deepEqual(late.skipped, [1, 2, 3, 4]);
  assert.equal(new Date(late.dueAt).toISOString(), '2026-08-10T14:00:00.000Z');

  // Enrolled 10 minutes out: every reminder has gone, but the two AFTER the
  // appointment have not — so it is enrolled for those and nothing is sent late.
  const veryLate = SRV.vcResolveNextDue({
    steps, now: new Date('2026-08-10T14:50:00Z'), appointmentAt: appt,
  });
  assert.equal(veryLate.step.offset_minutes, 45);
  assert.deepEqual(veryLate.skipped, [1, 2, 3, 4, 5]);

  // Enrolled two days AFTER: nothing survives and the enrollment never happens.
  const past = SRV.vcResolveNextDue({
    steps, now: new Date('2026-08-12T15:00:00Z'), appointmentAt: appt,
  });
  assert.equal(past.step, null);
  assert.equal(past.reason, 'all_past');

  // The browser core must agree, step for step.
  for (const now of ['2026-08-01T15:00:00Z', '2026-08-10T13:30:00Z',
    '2026-08-10T14:50:00Z', '2026-08-12T15:00:00Z']) {
    const a = SRV.vcResolveNextDue({ steps, now: new Date(now), appointmentAt: appt });
    const b = B.vcResolveNextDue({ steps, now: new Date(now), appointmentAt: appt });
    assert.equal(b.dueAt, a.dueAt, `browser disagrees at ${now}`);
    assert.deepEqual(b.skipped, a.skipped, `browser skip list differs at ${now}`);
  }
});

test('with no appointment on file the reminder schedules nothing at all', () => {
  const r = SRV.vcResolveNextDue({
    steps: REMINDER.steps, now: new Date('2026-08-01T15:00:00Z'), appointmentAt: null,
  });
  assert.equal(r.step, null);
  assert.equal(r.reason, 'no_appointment');
});

test('🔴 A LIVE-CONVERSATION HOLD MUST NOT FIRE AN ANCHORED REMINDER LATE', () => {
  // The hold moves next_action_at to when the conversation window closes. For a
  // relative step that is exactly right. For "your call is in an hour" it would
  // send that sentence a day after the call — the precise failure the skip rule
  // exists to prevent, reached by a different door.
  const appt = new Date('2026-08-10T15:00:00Z');
  const oneHourBefore = REMINDER.steps.find((s) => s.offset_minutes === -60);
  const holdUntil = '2026-08-11T09:00:00Z'; // 24h after their inbound

  assert.equal(SRV.vcSmsHoldWouldMissAnchor({
    step: oneHourBefore, holdUntil, appointmentAt: appt,
  }), true);

  // A hold that expires BEFORE the moment is fine — that is the hold working.
  assert.equal(SRV.vcSmsHoldWouldMissAnchor({
    step: oneHourBefore, holdUntil: '2026-08-10T13:00:00Z', appointmentAt: appt,
  }), false);

  // An ordinary step is never affected: it has no moment to miss.
  assert.equal(SRV.vcSmsHoldWouldMissAnchor({
    step: { position: 1, step_type: 'sms_message', wait_value: 2, wait_unit: 'days' },
    holdUntil, appointmentAt: appt,
  }), false);

  // No appointment means nothing to be late for.
  assert.equal(SRV.vcSmsHoldWouldMissAnchor({
    step: oneHourBefore, holdUntil, appointmentAt: null,
  }), false);

  assert.match(CORE, /export function vcSmsHoldWouldMissAnchor/);
  assert.match(TICK, /vcSmsHoldWouldMissAnchor/);
});

// ============================================================
// 5. The screen
// ============================================================

test('a text campaign that is switched off says so, and offers one click to change it', () => {
  assert.match(APP, /Not turned on yet/);
  assert.match(APP, /texts only go to leads with recorded text consent/i);
  assert.match(APP, /vcampTurnOn\(/, 'the card must carry a Turn on button');
});

test('🔴 TURNING A TEXT CAMPAIGN ON ASKS ONCE, AND THE QUESTION RESTATES THE CONSENT GATE', () => {
  const i = APP.indexOf('function vcampConfirmTurnOn');
  assert.ok(i > 0, 'app.html must have vcampConfirmTurnOn()');
  const fn = APP.slice(i, i + 2600);
  assert.match(fn, /confirm\(/, 'it has to actually ask');
  assert.match(fn, /recorded text consent/i,
    'the question must restate the gate, in one sentence');
  // And it must be the ONLY thing standing between the switch and an active
  // text campaign — a second, silent path would make the confirm decorative.
  const toggles = APP.match(/vcampToggleActive\(/g) || [];
  assert.ok(toggles.length >= 2, 'the checkbox and the Turn on button both route through the toggle');
  assert.match(APP.slice(APP.indexOf('async function vcampToggleActive'), APP.indexOf('async function vcampResume')),
    /vcampConfirmTurnOn/, 'the toggle itself must ask before switching a text campaign on');
});

test('the seeded campaigns are reachable from the browser with no agent id anywhere', () => {
  assert.match(APP, /vc_seed_default_sms_campaigns/);
  const calls = APP.match(/rpc\('vc_seed_default_sms_campaigns'[^)]*\)/g) || [];
  for (const c of calls) {
    assert.ok(!/agent/i.test(c), `a seed call names an agent: ${c}`);
  }
});
