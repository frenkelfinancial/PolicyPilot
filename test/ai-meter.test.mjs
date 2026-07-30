// ============================================================
// ai-meter.test.mjs — run with:  npm run test:aimeter
//
// Three kinds of test, and the split is deliberate.
//
//   1. PARITY. The daily-call meter's math exists twice — once in
//      supabase/functions/_shared/ai-call-meter.ts (the gate in ai-call-start)
//      and once in the // <ai-meter-core> block in app.html (the screen).
//      app.html has no build step and no module system, so the duplication is
//      unavoidable; what is avoidable is DRIFT. A shared table of cases is run
//      through both and the answers compared. If the screen and the server
//      ever disagree about whether a call is allowed, this fails.
//
//   2. BEHAVIOUR. The extracted browser core is executed verbatim — the exact
//      text that ships — against the rules that matter on screen.
//
//   3. STRUCTURE. Assertions about app.html as source text: the sentinel
//      appears once, the core is pure, the meter reads the OUTBOUND direction
//      only, and the cap gate is not quietly turned into a wall.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as SRV from '../supabase/functions/_shared/ai-call-meter.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP  = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIG  = readFileSync(join(ROOT, 'supabase/migrations/20260802_ai_call_meter.sql'), 'utf8');
const FN   = readFileSync(join(ROOT, 'supabase/functions/ai-call-start/index.ts'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n')
  .filter(l => !markers.some(m => l.trim().startsWith(m)))
  .join('\n');

const EXPORTS = [
  'AI_DAILY_CALL_RECOMMENDATION', 'AI_RAMP_SCHEDULE', 'AI_RAMP_DAYS',
  'AI_DEFAULT_DAILY_CAP', 'AI_METER_DEFAULT_TZ',
  'aiIsValidTimezone', 'aiResolveAgentTimezone', 'aiLocalDayKey', 'aiAddDays',
  'aiDaysBetween', 'aiLocalMidnightUtc', 'aiLocalDayWindow', 'aiRampDayIndex',
  'aiNumberRampValue', 'aiRecommendedDailyCalls', 'aiEvaluateDailyPace',
  'aiDailyCapMessage', 'aiPaceBannerText',
];

function loadCore() {
  const m = APP.match(/\/\/ <ai-meter-core>([\s\S]*?)\/\/ <\/ai-meter-core>/);
  assert.ok(m, 'app.html must contain the // <ai-meter-core> … // </ai-meter-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

const CHI = 'America/Chicago';

// ============================================================
// 1. PARITY — the screen and the server must answer identically
// ============================================================

test('parity: the constants are the same numbers on both sides', () => {
  assert.equal(B.AI_DAILY_CALL_RECOMMENDATION, SRV.AI_DAILY_CALL_RECOMMENDATION);
  assert.deepEqual(B.AI_RAMP_SCHEDULE, SRV.AI_RAMP_SCHEDULE);
  assert.equal(B.AI_RAMP_DAYS, SRV.AI_RAMP_DAYS);
  assert.equal(B.AI_DEFAULT_DAILY_CAP, SRV.AI_DEFAULT_DAILY_CAP);
  assert.equal(B.AI_METER_DEFAULT_TZ, SRV.AI_METER_DEFAULT_TZ);
});

test('parity: the ramp returns the same day and the same value, every case', () => {
  const nows = [
    '2026-07-15T18:00:00Z', '2026-07-15T02:00:00Z', '2026-07-15T05:00:00Z',
    '2026-03-08T09:00:00Z', '2026-11-01T07:30:00Z', '2027-01-01T00:00:00Z',
  ];
  const firsts = [
    null, undefined, '', 'not-a-date',
    '2026-07-15T09:00:00-05:00', '2026-07-14T23:59:00-05:00', '2026-07-09T12:00:00Z',
    '2026-07-08T12:00:00Z', '2026-06-01T12:00:00Z', '2026-08-01T12:00:00Z',
  ];
  const zones = [CHI, 'UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Honolulu'];
  let cases = 0;
  for (const n of nows) for (const f of firsts) for (const tz of zones) {
    const now = new Date(n);
    assert.equal(B.aiRampDayIndex(f, now, tz), SRV.rampDayIndex(f, now, tz),
      `rampDayIndex(${f}, ${n}, ${tz})`);
    assert.equal(B.aiNumberRampValue(f, now, tz), SRV.numberRampValue(f, now, tz),
      `numberRampValue(${f}, ${n}, ${tz})`);
    cases++;
  }
  assert.ok(cases >= 300, `expected a broad sweep, ran ${cases}`);
});

test('parity: the day window is the same half-open UTC range on both sides', () => {
  const instants = [
    '2026-07-15T02:00:00Z', '2026-07-15T04:59:59Z', '2026-07-15T05:00:00Z',
    '2026-03-08T06:00:00Z', '2026-03-08T08:30:00Z', '2026-11-01T05:30:00Z',
    '2026-12-31T23:59:59Z', '2026-01-01T00:00:00Z',
  ];
  const zones = [CHI, 'UTC', 'America/New_York', 'America/Los_Angeles', 'America/Phoenix',
                 'Asia/Kolkata', 'Australia/Adelaide', 'Not/AZone'];
  for (const i of instants) for (const tz of zones) {
    const d = new Date(i);
    const a = B.aiLocalDayWindow(d, tz);
    const b = SRV.localDayWindow(d, tz);
    assert.deepEqual(
      { k: a.dayKey, s: a.startIso, e: a.endIso, t: a.timezone },
      { k: b.dayKey, s: b.startIso, e: b.endIso, t: b.timezone },
      `localDayWindow(${i}, ${tz})`,
    );
  }
});

test('parity: the recommendation over a pool matches, number for number', () => {
  const pools = [
    [],
    [{ e164: '+12029981783', ai_first_used_at: '2026-06-01T12:00:00Z' }],
    [{ e164: '+12029981783', ai_first_used_at: null }],
    [
      { e164: '+12029981783', ai_first_used_at: '2026-06-01T12:00:00Z' },
      { e164: '+12026143091', ai_first_used_at: '2026-07-14T12:00:00Z' },
      { e164: '+15550001234', ai_first_used_at: null },
    ],
    [{ e164: null, ai_first_used_at: '2026-07-13T12:00:00Z' }],
  ];
  const now = new Date('2026-07-15T18:00:00Z');
  for (const pool of pools) for (const tz of [CHI, 'UTC', 'America/Los_Angeles']) {
    const a = B.aiRecommendedDailyCalls(pool, now, tz);
    const b = SRV.recommendedDailyCalls(pool, now, tz);
    assert.equal(a.recommended, b.recommended);
    assert.equal(a.numberCount, b.numberCount);
    assert.deepEqual(a.numbers, b.numbers);
    assert.deepEqual(a.ramping, b.ramping);
  }
});

test('parity: the verdict — blocked, warned or fine — is identical', () => {
  const counts = [0, 1, 29, 30, 31, 299, 300, 301, 499, 500, 501, 9999, -3, NaN];
  const caps = [null, undefined, 0, 1, 30, 300, 500, -1, Infinity];
  const recs = [null, 30, 90, 300, 600];
  for (const callsToday of counts) for (const cap of caps) for (const recommended of recs) {
    assert.deepEqual(
      B.aiEvaluateDailyPace({ callsToday, cap, recommended }),
      SRV.evaluateDailyPace({ callsToday, cap, recommended }),
      `evaluateDailyPace(${callsToday}, ${cap}, ${recommended})`,
    );
  }
});

test('parity: the copy is byte-identical — the same sentence is shown and returned', () => {
  for (const cap of [0, 1, 300, 500, 1200]) {
    assert.equal(B.aiDailyCapMessage(cap), SRV.dailyCapMessage(cap));
  }
  for (const n of [0, 1, 2, 3, 17]) {
    assert.equal(B.aiPaceBannerText(n), SRV.paceBannerText(n));
  }
});

test('parity: timezone resolution agrees, including on junk', () => {
  const inputs = [
    { timezone: 'America/Denver' }, { timezone: '  America/Denver  ' },
    { timezone: '' }, { timezone: null }, { timezone: 'Mars/Olympus_Mons' },
    { timezone: 7 }, {}, null, undefined,
  ];
  for (const i of inputs) {
    assert.equal(B.aiResolveAgentTimezone(i), SRV.resolveAgentTimezone(i));
  }
});

// ============================================================
// 2. BEHAVIOUR — the shipped browser core
// ============================================================

test('the recommendation never blocks — only the agent\'s own cap does', () => {
  // The single most important property of this feature. 500 calls, one number,
  // recommendation 300: warned, then dialled.
  const v = B.aiEvaluateDailyPace({ callsToday: 480, cap: 500, recommended: 300 });
  assert.equal(v.blocked, false);
  assert.equal(v.overRecommendation, true);
  // And with no cap at all, nothing ever blocks.
  assert.equal(B.aiEvaluateDailyPace({ callsToday: 100000, cap: null, recommended: 300 }).blocked, false);
});

test('no cap is null, and null is not zero', () => {
  const v = B.aiEvaluateDailyPace({ callsToday: 5, cap: null, recommended: 300 });
  assert.equal(v.cap, null);
  assert.equal(v.remaining, null);
  // An agent with no active numbers has no recommendation — not one of 0.
  assert.equal(B.aiRecommendedDailyCalls([], new Date(), CHI).recommended, null);
  assert.equal(B.aiEvaluateDailyPace({ callsToday: 5, cap: null, recommended: null }).state, 'normal');
});

test('a brand-new number is recommended 30, not 300', () => {
  const now = new Date('2026-07-15T18:00:00Z');
  const r = B.aiRecommendedDailyCalls([{ e164: '+15550001234', ai_first_used_at: null }], now, CHI);
  assert.equal(r.recommended, 30);
  assert.equal(r.ramping.length, 1);
  assert.equal(r.ramping[0].day, 1);
  assert.equal(r.ramping[0].neverUsed, true);
  assert.equal(r.ramping[0].last4, '1234');
});

test('a mature number gets no ramp chip', () => {
  const now = new Date('2026-07-15T18:00:00Z');
  const r = B.aiRecommendedDailyCalls([{ e164: '+12029981783', ai_first_used_at: '2026-01-01T00:00:00Z' }], now, CHI);
  assert.equal(r.ramping.length, 0);
  assert.equal(r.recommended, 300);
});

test('the amber banner names the pace, the risk and the fix — and never a block', () => {
  const t = B.aiPaceBannerText(2);
  assert.match(t, /past the recommended daily pace for 2 numbers\./);
  assert.match(t, /Spam Likely/);
  assert.match(t, /Adding another AI number raises the recommendation\./);
  assert.doesNotMatch(t, /block|stopped|suspend/i);
});

// ============================================================
// 3. STRUCTURE
// ============================================================

test('every core sentinel appears EXACTLY ONCE in app.html, including the new one', () => {
  ['bob-core', 'comm-core', 'persist-core', 'backoffice-core', 'team-core',
   'producer-codes-core', 'leaderboard-core', 'recon-core', 'referral-core', 'ai-meter-core']
    .forEach(name => {
      const opens  = (APP.match(new RegExp(`// <${name}>`, 'g')) || []).length;
      const closes = (APP.match(new RegExp(`// </${name}>`, 'g')) || []).length;
      assert.equal(opens, 1, `// <${name}> must appear exactly once, found ${opens}`);
      assert.equal(closes, 1, `// </${name}> must appear exactly once, found ${closes}`);
    });
});

test('the ai-meter core is pure — no DOM, network, storage or app globals', () => {
  const m = APP.match(/\/\/ <ai-meter-core>([\s\S]*?)\/\/ <\/ai-meter-core>/);
  const body = stripLineComments(m[1], ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/,
   /\bcurrentAgent\b/, /\bshowToast\(/, /\bnav\(/, /\baiMeterState\b/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
});

test('the meter counts OUTBOUND calls only, in the browser and on the server', () => {
  // Inbound is never metered and never blocked: the consumer called us. Both
  // count queries must carry the direction filter.
  const browserCount = APP.match(/from\('ai_calls'\)[\s\S]{0,400}?count: 'exact'[\s\S]{0,400}?\.lt\('created_at'/);
  assert.ok(browserCount, 'app.html must count today\'s calls with an exact head count');
  assert.match(browserCount[0], /\.eq\('direction', 'outbound'\)/,
    'the browser meter must filter direction=outbound');

  const serverCount = FN.match(/from\("ai_calls"\)[\s\S]{0,400}?count: "exact"[\s\S]{0,400}?\.lt\("created_at"/);
  assert.ok(serverCount, 'ai-call-start must count today\'s calls with an exact head count');
  assert.match(serverCount[0], /\.eq\("direction", "outbound"\)/,
    'the gate must filter direction=outbound');
});

test('the gate blocks on the CAP and never on the recommendation', () => {
  const code = stripLineComments(FN, ['//', '*', '/*']);
  // Exactly one refusal, and it is the cap's.
  assert.equal((code.match(/daily_cap_reached/g) || []).length, 1);
  assert.match(code, /if \(pace\.blocked\)[\s\S]{0,400}?daily_cap_reached/);
  // The recommendation branch writes a row and falls through — it must not
  // return, ever.
  const over = code.match(/if \(pace\.overRecommendation\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(over, 'ai-call-start must have an overRecommendation branch');
  assert.ok(!/\breturn\b/.test(over[1]),
    'the over-recommendation branch must never return — the recommendation is advice, not a wall');
  assert.match(over[1], /ai_pace_events/);
  assert.match(over[1], /ignoreDuplicates: true/,
    'one warning per agent per day is enforced by the key, not by the caller');
});

test('the gate order is documented and the compliance gates keep their places', () => {
  const order = ['ai_disabled', 'upgrade_required', 'not_callable', 'quiet_hours',
                 'daily_cap_reached', 'insufficient_balance'];
  const header = FN.slice(0, FN.indexOf('serve('));
  let at = -1;
  for (const code of order) {
    const i = header.indexOf(code);
    assert.ok(i > at, `${code} must be listed after the gate before it in the header comment`);
    at = i;
  }
  // And in the body: the cap gate sits above the wallet floor, because hitting
  // your own cap is a pacing answer, not a money answer.
  assert.ok(FN.indexOf('daily_cap_reached') < FN.indexOf('insufficient_balance'));
});

test('ai_first_used_at is stamped once, only after Telnyx accepted the call', () => {
  const code = stripLineComments(FN, ['//', '*', '/*']);
  const stamp = code.match(/\.update\(\{ ai_first_used_at:[\s\S]{0,200}?;/);
  assert.ok(stamp, 'ai-call-start must stamp phone_numbers.ai_first_used_at');
  assert.match(stamp[0], /\.is\("ai_first_used_at", null\)/,
    'the stamp must be write-once — a re-stamp slides a mature number back to day 1');
  // It happens after the dial, not before: a rejected dial never touched the number.
  assert.ok(code.indexOf('ai_first_used_at:') > code.indexOf('telnyx_call_leg_id'));
});

// ============================================================
// 4. THE MIGRATION
// ============================================================

test('the migration keeps NULL meaning "no cap" and defaults everyone to 300', () => {
  const sql = stripLineComments(MIG, ['--']);
  assert.match(sql, /add column if not exists ai_daily_call_cap integer default 300/i);
  assert.match(sql, /ai_daily_call_cap is null or ai_daily_call_cap >= 0/i);
  // The default IS the recommendation.
  assert.equal(SRV.AI_DEFAULT_DAILY_CAP, SRV.AI_DAILY_CALL_RECOMMENDATION);
  // Nothing may force a cap back onto a row that was deliberately cleared.
  assert.ok(!/update\s+public\.agents\s+set\s+ai_daily_call_cap/i.test(sql),
    'no blanket backfill of ai_daily_call_cap — clearing the cap must survive a re-run');
});

test('ai_pace_events is one row per agent per local day, and owner-read-only', () => {
  const sql = stripLineComments(MIG, ['--']);
  assert.match(sql, /unique \(agent_id, local_day\)/i);
  assert.match(sql, /create policy "ai_pace_events_select_own"[\s\S]{0,200}?for select/i);
  // SELECT and nothing else — the browser must not be able to forge or suppress
  // the record that it was warned.
  assert.ok(!/on public\.ai_pace_events for (insert|update|delete)/i.test(sql));
});

test('ai_first_used_at is client-immutable', () => {
  // A browser that could backdate it would buy a fresh number a matured
  // number's recommendation on the day it was purchased.
  assert.match(MIG, /NEW\.ai_first_used_at\s+:=\s+OLD\.ai_first_used_at;/);
});
