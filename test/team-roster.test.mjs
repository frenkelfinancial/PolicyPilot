// ============================================================
// team-roster.test.mjs — run with:  npm run test:team
//
// Two kinds of test in here, and the split is deliberate.
//
//   1. BEHAVIOUR. The pure core between the // <team-core> sentinels in
//      app.html is extracted and executed verbatim. app.html has no build
//      step and no module system, so the alternative — a mirrored copy of
//      the logic in a .ts file — would be a second definition that drifts.
//      These tests run the exact text that ships.
//
//   2. STRUCTURE. Assertions about app.html and the migration as source
//      text: one RPC call site, one period engine, one renderer, and no
//      parameter that would let a caller point the RPC at somebody else's
//      downline. These are the regression tests for the bug CLASS (two
//      screens disagreeing), not for any individual number.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260738_team_roster.sql'), 'utf8');

// The one-call-site style invariants are about CODE, not prose. Both files
// describe their own rules in comments ("exactly ONE sb.rpc('get_team_summary')
// call site"), and counting those as violations would make documenting the
// rule break the rule. Strip whole-line comments before counting.
const stripLineComments = (src, markers) => src
  .split('\n')
  .filter(l => !markers.some(m => l.trim().startsWith(m)))
  .join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);
const SQL_CODE = stripLineComments(MIGRATION, ['--']);

// ------------------------------------------------------------
// Load the shipped core
// ------------------------------------------------------------
const EXPORTS = [
  'TEAM_PERIODS', 'TEAM_PERIOD_DEFAULT', 'TEAM_SORT_COLS',
  'AT_RISK_AP_DROP_PCT', 'AT_RISK_NO_DIAL_DAYS', 'AT_RISK_MIN_PRIOR_AP', 'AT_RISK_MIN_TENURE_DAYS',
  'teamPeriodRange', 'teamRpcArgs', 'teamNormalizeRow', 'teamAtRisk', 'teamShares',
  'teamSortKey', 'teamSortRows', 'buildTeamView',
  'tmMoney', 'tmMoneyK', 'tmDur', 'tmRatio', 'tmDate', 'tmAgo', 'tmDelta',
];

function loadCore() {
  const m = APP.match(/\/\/ <team-core>([\s\S]*?)\/\/ <\/team-core>/);
  assert.ok(m, 'app.html must contain the // <team-core> ... // </team-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const T = loadCore();

const D = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h, 0, 0);
const DAY = 86400000;
const daysAgo = (from, n) => new Date(from.getTime() - n * DAY);

// ============================================================
// 1. PERIOD MATH — and the fact that both surfaces share it
// ============================================================

test('period math: this month is the calendar month, prior month is the one before', () => {
  const r = T.teamPeriodRange('month', D(2026, 7, 15));
  assert.equal(+r.start, +D(2026, 7, 1, 0));
  assert.equal(+r.end, +D(2026, 8, 1, 0));
  assert.equal(+r.prevStart, +D(2026, 6, 1, 0));
  assert.equal(+r.prevEnd, +r.start);
});

test('period math: this week starts Monday, matching summaryPeriodRange', () => {
  // 2026-07-15 is a Wednesday.
  const r = T.teamPeriodRange('week', D(2026, 7, 15));
  assert.equal(r.start.getDay(), 1, 'week starts on a Monday');
  assert.equal(+r.start, +D(2026, 7, 13, 0));
  assert.equal(+r.end, +D(2026, 7, 20, 0));
  assert.equal(+r.prevStart, +D(2026, 7, 6, 0));
  assert.equal(r.end - r.start, 7 * DAY);
});

test('period math: a Monday belongs to the week it starts, not the one before', () => {
  const r = T.teamPeriodRange('week', D(2026, 7, 13));   // Monday
  assert.equal(+r.start, +D(2026, 7, 13, 0));
});

test('period math: a Sunday is the LAST day of its week', () => {
  const r = T.teamPeriodRange('week', D(2026, 7, 19));   // Sunday
  assert.equal(+r.start, +D(2026, 7, 13, 0));
  assert.equal(+r.end, +D(2026, 7, 20, 0));
});

test('period math: quarter is the calendar quarter, and Q1 rolls back into last year', () => {
  const q3 = T.teamPeriodRange('quarter', D(2026, 7, 15));
  assert.equal(+q3.start, +D(2026, 7, 1, 0));
  assert.equal(+q3.end, +D(2026, 10, 1, 0));
  assert.equal(+q3.prevStart, +D(2026, 4, 1, 0));

  const q1 = T.teamPeriodRange('quarter', D(2026, 2, 10));
  assert.equal(+q1.start, +D(2026, 1, 1, 0));
  assert.equal(+q1.prevStart, +new Date(2025, 9, 1));  // Oct 1 of the prior year
});

test('period math: lifetime is unbounded and has no prior period to fake a trend from', () => {
  const r = T.teamPeriodRange('lifetime', D(2026, 7, 15));
  assert.equal(r.start, null);
  assert.equal(r.end, null);
  assert.equal(r.prevStart, null);
  assert.equal(r.prevEnd, null);
});

test('period math: the at-risk month pair is the SAME for every period on screen', () => {
  const today = D(2026, 7, 15);
  const keys = ['week', 'month', 'quarter', 'lifetime'];
  const pairs = keys.map(k => {
    const r = T.teamPeriodRange(k, today);
    return [+r.monthStart, +r.monthEnd, +r.prevMonthStart, +r.prevMonthEnd].join('|');
  });
  assert.equal(new Set(pairs).size, 1, 'at-risk windows must not move with the period selector');
  const r = T.teamPeriodRange('week', today);
  assert.equal(+r.monthStart, +D(2026, 7, 1, 0));
  assert.equal(+r.prevMonthStart, +D(2026, 6, 1, 0));
});

test('period math: an unknown period key falls back to the default rather than throwing', () => {
  const bad = T.teamPeriodRange('fortnight', D(2026, 7, 15));
  const def = T.teamPeriodRange(T.TEAM_PERIOD_DEFAULT, D(2026, 7, 15));
  assert.equal(bad.key, T.TEAM_PERIOD_DEFAULT);
  assert.equal(+bad.start, +def.start);
});

test('period math: month boundaries are local midnight, not UTC midnight', () => {
  // The whole reason the RPC takes month bounds instead of deriving them
  // from now(): the browser knows the agent's calendar, the server does not.
  const r = T.teamPeriodRange('month', D(2026, 7, 15));
  assert.equal(r.monthStart.getHours(), 0);
  assert.equal(r.monthStart.getDate(), 1);
});

test('teamRpcArgs maps all eight bounds, and nulls survive as nulls', () => {
  const args = T.teamRpcArgs(T.teamPeriodRange('month', D(2026, 7, 15)));
  assert.deepEqual(Object.keys(args).sort(), [
    'p_end', 'p_month_end', 'p_month_start', 'p_prev_end', 'p_prev_month_end',
    'p_prev_month_start', 'p_prev_start', 'p_start',
  ]);
  Object.values(args).forEach(v => assert.equal(typeof v, 'string'));

  const life = T.teamRpcArgs(T.teamPeriodRange('lifetime', D(2026, 7, 15)));
  assert.equal(life.p_start, null);
  assert.equal(life.p_end, null);
  assert.equal(life.p_prev_start, null);
  assert.ok(life.p_month_start, 'lifetime still carries the at-risk month pair');
});

test('THE PERIOD-MATCH INVARIANT: both surfaces resolve through one engine and one period value', () => {
  const defs = APP.match(/function teamPeriodRange\s*\(/g) || [];
  assert.equal(defs.length, 1, 'exactly one period engine may exist');

  // Both render paths pass the same persisted value into it.
  assert.match(APP, /const entry = await loadTeamRoster\(_teamPeriod\)/,
    'the Agency screen must load the roster for _teamPeriod');
  assert.match(APP, /teamEnsure\(_teamPeriod,/,
    'the Summary mini-card must load the roster for _teamPeriod');
  assert.match(APP, /teamPeriodRange\(_teamPeriod, now\)/,
    'the Summary mini-card must label itself from the same engine');

  // And nothing else builds a team window by hand.
  const handRolled = APP.match(/p_start:\s*range\.start\.toISOString\(\)/g) || [];
  assert.equal(handRolled.length, 0, 'no surface may hand-roll the RPC window');
});

// ============================================================
// 2. AT-RISK — both directions, and every guard
// ============================================================

const NOW = D(2026, 7, 29);
/** A tenured downline agent who has fallen off and gone quiet. */
const risky = (over = {}) => T.teamNormalizeRow({
  agent_id: 'a1', agent_name: 'Dana', is_leader: false,
  joined_at: daysAgo(NOW, 200).toISOString(),
  last_dial_at: daysAgo(NOW, 9).toISOString(),
  month_ap: 5000, prev_month_ap: 10000,
  ...over,
});

test('at-risk FIRES when production is down and the phone has gone quiet', () => {
  const v = T.teamAtRisk(risky(), NOW);
  assert.equal(v.atRisk, true);
  assert.equal(v.reason, 'AP down 50% vs last month, no dials in 9 days');
  assert.equal(v.productionDown, true);
  assert.equal(v.quiet, true);
  assert.equal(v.eligible, true);
});

test('at-risk does NOT fire when production held up, however quiet they are', () => {
  const v = T.teamAtRisk(risky({ month_ap: 9000, last_dial_at: daysAgo(NOW, 60).toISOString() }), NOW);
  assert.equal(v.atRisk, false);
  assert.equal(v.productionDown, false);
  assert.equal(v.quiet, true, 'quiet on its own is not a flag');
});

test('at-risk does NOT fire while they are still dialling, however far production fell', () => {
  const v = T.teamAtRisk(risky({ month_ap: 0, last_dial_at: daysAgo(NOW, 2).toISOString() }), NOW);
  assert.equal(v.atRisk, false);
  assert.equal(v.productionDown, true, 'production really is down');
  assert.equal(v.quiet, false, 'but they are working the phone');
});

test('at-risk does NOT fire for an agent who joined inside the grace period', () => {
  const v = T.teamAtRisk(risky({ joined_at: daysAgo(NOW, 10).toISOString() }), NOW);
  assert.equal(v.atRisk, false);
  assert.equal(v.eligible, false);
  assert.equal(v.tenureDays, 10);
});

test('at-risk does NOT fire when there was no prior production to fall from', () => {
  const v = T.teamAtRisk(risky({ month_ap: 0, prev_month_ap: 0, last_dial_at: null }), NOW);
  assert.equal(v.atRisk, false);
  assert.equal(v.dropPct, 0, 'you cannot be down 100% from zero');
});

test('at-risk never flags the leader on their own dashboard', () => {
  const v = T.teamAtRisk(risky({ is_leader: true, joined_at: null }), NOW);
  assert.equal(v.atRisk, false);
  assert.equal(v.eligible, false);
});

test('at-risk treats "never dialled at all" as the quietest state there is', () => {
  const v = T.teamAtRisk(risky({ last_dial_at: null }), NOW);
  assert.equal(v.atRisk, true);
  assert.equal(v.daysSinceDial, null);
  assert.equal(v.reason, 'AP down 50% vs last month, no dials on record');
});

test('at-risk boundaries: exactly 40% and exactly 7 days both count as met', () => {
  const exact = T.teamAtRisk(risky({
    prev_month_ap: 10000, month_ap: 6000,                       // exactly -40%
    last_dial_at: daysAgo(NOW, 7).toISOString(),                // exactly 7 days
  }), NOW);
  assert.equal(exact.atRisk, true);
  assert.equal(exact.reason, 'AP down 40% vs last month, no dials in 7 days');
});

test('at-risk boundaries: a hair under either threshold does not flag', () => {
  const shallow = T.teamAtRisk(risky({ prev_month_ap: 10000, month_ap: 6001 }), NOW);
  assert.equal(shallow.atRisk, false, '39.99% is not 40%');

  const recent = T.teamAtRisk(risky({ last_dial_at: daysAgo(NOW, 6).toISOString() }), NOW);
  assert.equal(recent.atRisk, false, '6 days is not 7');
});

test('at-risk: growth is never a drop, even against a big prior month', () => {
  const v = T.teamAtRisk(risky({ prev_month_ap: 10000, month_ap: 25000 }), NOW);
  assert.equal(v.dropPct, 0);
  assert.equal(v.atRisk, false);
});

test('at-risk: the thresholds are the documented ones', () => {
  assert.equal(T.AT_RISK_AP_DROP_PCT, 0.40);
  assert.equal(T.AT_RISK_NO_DIAL_DAYS, 7);
  assert.equal(T.AT_RISK_MIN_TENURE_DAYS, 30);
  assert.equal(T.AT_RISK_MIN_PRIOR_AP, 1);
});

test('at-risk reason is empty when not flagged, so no UI can print a phantom one', () => {
  assert.equal(T.teamAtRisk(risky({ month_ap: 10000 }), NOW).reason, '');
});

// ============================================================
// 3. VOLUME SHARE — must total exactly 100
// ============================================================

const shareOf = aps => T.teamShares(aps.map(ap => ({ ap })));
const sum = a => a.reduce((s, v) => s + v, 0);

test('shares total exactly 100 for an even split that does not divide evenly', () => {
  assert.equal(sum(shareOf([1, 1, 1])), 100);
  assert.equal(sum(shareOf([1, 1, 1, 1, 1, 1, 1])), 100);
  assert.equal(sum(shareOf([100, 100, 100])), 100);
});

test('shares total exactly 100 across lopsided and realistic books', () => {
  [
    [12000, 8000, 3400, 900],
    [1],
    [0.01, 0.02, 0.03],
    [99999, 1],
    [5000, 5000],
  ].forEach(aps => assert.equal(sum(shareOf(aps)), 100, JSON.stringify(aps)));
});

test('shares are all zero when the team wrote nothing — 0/0 is not 100%', () => {
  assert.deepEqual(shareOf([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(shareOf([]), []);
});

test('shares ignore negative AP rather than producing a negative percentage', () => {
  const s = shareOf([-500, 1000]);
  assert.deepEqual(s, [0, 100]);
});

test('shares total 100 for 300 randomised books (property check)', () => {
  let seed = 20260729;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rnd() * 12);
    const aps = Array.from({ length: n }, () => Math.floor(rnd() * 40000));
    const s = shareOf(aps);
    assert.equal(s.length, n);
    if (aps.reduce((a, b) => a + b, 0) > 0) {
      assert.equal(sum(s), 100, `n=${n} aps=${aps}`);
    } else {
      assert.equal(sum(s), 0);
    }
    s.forEach(v => assert.ok(v >= 0 && v <= 100 && Number.isInteger(v)));
  }
});

test('the biggest producer never gets a smaller share than a smaller producer', () => {
  const s = shareOf([9000, 3000, 3000, 100]);
  assert.ok(s[0] >= s[1] && s[1] >= s[3]);
});

// ============================================================
// 4. VIEW MODEL — totals, averages, and "you"
// ============================================================

const rpcRow = (o) => ({
  agent_id: o.id, agent_name: o.name, agent_email: o.name + '@x.test', agent_plan: o.plan || 'Basic Producer',
  is_leader: !!o.you, joined_at: o.joined || daysAgo(NOW, 120).toISOString(),
  last_activity_at: o.act || daysAgo(NOW, 1).toISOString(),
  last_dial_at: o.dial === null ? null : (o.dial || daysAgo(NOW, 1).toISOString()),
  ap: o.ap || 0, sales: o.sales || 0, dials: o.dials || 0, call_time_sec: o.time || 0,
  prev_ap: o.prevAp || 0, prev_sales: 0, prev_dials: 0, prev_call_time_sec: 0,
  month_ap: o.monthAp || 0, prev_month_ap: o.prevMonthAp || 0,
  lifetime_ap: o.lifeAp || 0, lifetime_sales: 0, lifetime_dials: 0, lifetime_call_time_sec: 0,
});

test('buildTeamView totals, averages and shares agree with each other', () => {
  const view = T.buildTeamView([
    rpcRow({ id: 'L', name: 'Lee', you: true, ap: 6000, sales: 3, dials: 90, time: 3600 }),
    rpcRow({ id: 'A', name: 'Ann', ap: 3000, sales: 2, dials: 60, time: 1800 }),
    rpcRow({ id: 'B', name: 'Bo', ap: 1000, sales: 1, dials: 30, time: 600 }),
  ], NOW);

  assert.equal(view.count, 3);
  assert.equal(view.totals.ap, 10000);
  assert.equal(view.totals.sales, 6);
  assert.equal(view.totals.dials, 180);
  assert.equal(view.totals.ratio, 30);                 // 180 dials / 6 sales
  assert.equal(view.avg.ap, 10000 / 3);
  assert.equal(view.you.name, 'Lee');
  assert.equal(sum(view.rows.map(r => r.share)), 100);
  assert.deepEqual(view.rows.map(r => r.share), [60, 30, 10]);
});

test('buildTeamView survives an empty team without dividing by zero', () => {
  const view = T.buildTeamView([], NOW);
  assert.equal(view.count, 0);
  assert.equal(view.totals.ap, 0);
  assert.equal(view.avg.ap, 0);
  assert.equal(view.you, null);
  assert.deepEqual(view.atRisk, []);
});

test('buildTeamView collects exactly the flagged agents', () => {
  const view = T.buildTeamView([
    rpcRow({ id: 'L', name: 'Lee', you: true, monthAp: 0, prevMonthAp: 9000, dial: null }),
    rpcRow({ id: 'A', name: 'Ann', monthAp: 1000, prevMonthAp: 10000, dial: daysAgo(NOW, 20).toISOString() }),
    rpcRow({ id: 'B', name: 'Bo', monthAp: 9000, prevMonthAp: 10000, dial: daysAgo(NOW, 20).toISOString() }),
  ], NOW);
  assert.deepEqual(view.atRisk.map(r => r.name), ['Ann'], 'the leader is exempt, Bo held production');
});

test('call-to-close is null (not Infinity, not 0) when there are no sales', () => {
  const view = T.buildTeamView([rpcRow({ id: 'A', name: 'Ann', dials: 40, sales: 0 })], NOW);
  assert.equal(view.rows[0].ratio, null);
  assert.equal(T.tmRatio(view.rows[0].ratio), '—');
});

// ============================================================
// 5. SORTING
// ============================================================

const sortFixture = () => T.buildTeamView([
  rpcRow({ id: 'A', name: 'Ann', ap: 3000, sales: 2, dials: 60, plan: 'Pro Producer' }),
  rpcRow({ id: 'B', name: 'Bo', ap: 9000, sales: 0, dials: 10, plan: 'Basic Producer' }),
  rpcRow({ id: 'C', name: 'Cy', ap: 1000, sales: 5, dials: 25, plan: 'Leader' }),
], NOW).rows;

test('sorting by AP descending is the default order', () => {
  assert.deepEqual(T.teamSortRows(sortFixture(), 'ap', 'desc').map(r => r.name), ['Bo', 'Ann', 'Cy']);
  assert.deepEqual(T.teamSortRows(sortFixture(), 'ap', 'asc').map(r => r.name), ['Cy', 'Ann', 'Bo']);
});

test('sorting by name is alphabetical, not by whatever the RPC returned', () => {
  assert.deepEqual(T.teamSortRows(sortFixture(), 'name', 'asc').map(r => r.name), ['Ann', 'Bo', 'Cy']);
});

test('"no sales yet" never wins the best-call-to-close sort', () => {
  const asc = T.teamSortRows(sortFixture(), 'ratio', 'asc').map(r => r.name);
  assert.equal(asc[asc.length - 1], 'Bo', 'Bo has no sales, so no ratio — he sorts last, not first');
  assert.equal(asc[0], 'Cy', 'Cy closes in 5 dials');
});

test('an unknown sort column falls back to AP instead of scrambling the table', () => {
  assert.deepEqual(T.teamSortRows(sortFixture(), 'favourite_colour', 'desc').map(r => r.name), ['Bo', 'Ann', 'Cy']);
});

test('sorting is stable-ish: equal values break ties by name, not at random', () => {
  const rows = T.buildTeamView([
    rpcRow({ id: 'B', name: 'Bo', ap: 100 }),
    rpcRow({ id: 'A', name: 'Ann', ap: 100 }),
  ], NOW).rows;
  assert.deepEqual(T.teamSortRows(rows, 'ap', 'desc').map(r => r.name), ['Ann', 'Bo']);
});

// ============================================================
// 6. FORMATTERS
// ============================================================

test('formatters render the empty cases as dashes rather than NaN or Invalid Date', () => {
  assert.equal(T.tmMoney(null), '$0');
  assert.equal(T.tmMoney(1234.6), '$1,235');
  assert.equal(T.tmDur(0), '0m');
  assert.equal(T.tmDur(3725), '1h 2m');
  assert.equal(T.tmDate(null), '—');
  assert.equal(T.tmDate('not a date'), '—');
  assert.equal(T.tmAgo(null, NOW), 'never');
  assert.equal(T.tmRatio(null), '—');
  assert.equal(T.tmMoneyK(2500), '$2.5k');
});

test('tmAgo reads in plain language', () => {
  assert.equal(T.tmAgo(NOW, NOW), 'today');
  assert.equal(T.tmAgo(daysAgo(NOW, 1), NOW), 'yesterday');
  assert.equal(T.tmAgo(daysAgo(NOW, 9), NOW), '9d ago');
  assert.equal(T.tmAgo(daysAgo(NOW, 60), NOW), '2mo ago');
  assert.equal(T.tmAgo(daysAgo(NOW, 400), NOW), '1y ago');
});

test('tmDelta hides the trend when there is no prior period at all', () => {
  assert.equal(T.tmDelta(100, 0, false), null, 'lifetime has nothing to compare against');
  assert.equal(T.tmDelta(150, 100, true).dir, 'up');
  assert.equal(T.tmDelta(50, 100, true).dir, 'down');
  assert.equal(T.tmDelta(100, 100, true).dir, 'flat');
  assert.equal(T.tmDelta(500, 0, true).text, 'new this period');
});

// ============================================================
// 7. STRUCTURAL INVARIANTS — the anti-drift tests
// ============================================================

test('THE ONE-QUERY INVARIANT: exactly one get_team_summary call site exists', () => {
  const calls = APP_CODE.match(/sb\.rpc\(\s*'get_team_summary'/g) || [];
  assert.equal(calls.length, 1,
    'both team surfaces must go through loadTeamRoster(); a second call site is how they drift');
  const idx = APP_CODE.indexOf("sb.rpc('get_team_summary'");
  const fnStart = APP_CODE.lastIndexOf('async function loadTeamRoster', idx);
  assert.ok(fnStart > -1 && fnStart < idx, 'the one call site must be inside loadTeamRoster');
});

test('get_agency_stats is no longer called from the app at all', () => {
  const calls = APP_CODE.match(/rpc\(\s*'get_agency_stats'/g) || [];
  assert.equal(calls.length, 0,
    'a second team query with its own filters is exactly what produced the AP-inflation bug');
});

test('THE ONE-RENDERER INVARIANT: one table renderer, used by both surfaces', () => {
  assert.equal((APP.match(/function teamTableHTML\s*\(/g) || []).length, 1);
  assert.match(APP, /teamTableHTML\(view, 'agency', now\)/, 'the Agency screen renders it');
  assert.match(APP, /teamTableHTML\(view, 'summary', now\)/, 'the Summary card renders it');
  assert.equal((APP.match(/function teamVsHTML\s*\(/g) || []).length, 1, 'one you-vs-team strip');
});

test('the old duplicate team plumbing is gone, not merely unused', () => {
  ['_lgFetchTeam', '_lgTeamSort', 'ledgerSortTeam', '_lgTeam['].forEach(dead => {
    assert.ok(!APP_CODE.includes(dead), `${dead} must not survive as code`);
  });
});

test('the team core is pure — no DOM, storage, network or app globals inside the sentinels', () => {
  const m = APP.match(/\/\/ <team-core>([\s\S]*?)\/\/ <\/team-core>/);
  const code = m[1].split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/, /\bcurrentAgent\b/, /\bescapeHTML\(/]
    .forEach(re => assert.ok(!re.test(code), `team core must not reference ${re}`));
});

test('the at-risk thresholds are named constants, not numbers buried in a render', () => {
  assert.match(APP, /const AT_RISK_AP_DROP_PCT\s*=\s*0\.40;/);
  assert.match(APP, /const AT_RISK_NO_DIAL_DAYS\s*=\s*7;/);
  assert.match(APP, /const AT_RISK_MIN_TENURE_DAYS\s*=\s*30;/);
  // The drill-down explains itself from the same constants it is judged by.
  assert.match(APP, /AT_RISK_AP_DROP_PCT \* 100/);
});

test('the period selector persists, and the mini-card starts collapsed', () => {
  assert.match(APP, /localStorage\.setItem\('pp_team_period'/);
  assert.match(APP, /localStorage\.getItem\('pp_team_card_open'\) === '1'/,
    'absent preference must read as closed — collapsed is the default');
  assert.match(APP, /localStorage\.setItem\('pp_team_card_open'/);
});

test('the Agency nav item is still ungated, so invitees can still accept', () => {
  // Regression guard for the bug fixed in 4a216aa: a leader gate on nav()
  // made every emailed invite unacceptable.
  assert.ok(!/id === 'agency' && _navTier !== 'leader'/.test(APP),
    'a tier check on nav(\'agency\') breaks invite acceptance for downline agents');
  assert.match(APP, /async function _agRenderAgentView/, 'the invitee view must still exist');
  assert.match(APP, /function agAcceptInvite/);
  assert.match(APP, /function agRevokeAccess/);
});

test('Send Leads still hangs off the profile view', () => {
  assert.match(APP, /onclick="openAgLeadPicker\('\$\{escapeHTML\(member\.agent_id\)\}'\)"/);
  assert.match(APP, /function openAgLeadPicker/);
});

test('roster mutations drop the cached team view', () => {
  const invalidations = (APP.match(/teamInvalidate\(\); _agencyMembers = null;/g) || []).length;
  assert.equal(invalidations, 6,
    'invite, cancel, remove, accept, decline and revoke must all invalidate');
});

// ============================================================
// 8. THE LEADER-ONLY RPC — source invariants on the migration
//    (the live refusal is exercised behaviourally; see
//     docs/schema-state.md for the 13/13 run against production)
// ============================================================

test('the RPC is anchored on auth.uid() and takes NO leader parameter to tamper with', () => {
  assert.match(MIGRATION, /ai\.leader_id\s*=\s*auth\.uid\(\)/,
    'the downline must be scoped to the caller, not to an argument');

  const sig = MIGRATION.slice(
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.get_team_summary'),
    MIGRATION.indexOf('RETURNS TABLE'),
  );
  assert.ok(sig.length > 0, 'function signature found');
  assert.ok(!/p_leader/i.test(sig),
    'a leader-id parameter is a thing an attacker can change; there must not be one');
  // Every parameter is a time bound and nothing else.
  const params = sig.match(/p_[a-z_]+\s+timestamptz/g) || [];
  assert.equal(params.length, 8, 'all eight parameters are time bounds');
});

test('the RPC stays SECURITY DEFINER with the same grants as before', () => {
  assert.match(MIGRATION, /SECURITY DEFINER/);
  assert.match(MIGRATION, /SET search_path = public/);
  assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.get_team_summary\([\s\S]*?\) TO authenticated, service_role;/);
  assert.match(MIGRATION, /REVOKE ALL ON FUNCTION public\.get_team_summary/);
});

test('the RPC returns aggregates only — no column that could carry client data', () => {
  const ret = MIGRATION.slice(MIGRATION.indexOf('RETURNS TABLE ('), MIGRATION.indexOf(')\nLANGUAGE sql'));
  [/client/i, /policy_number/i, /commission/i, /comp_/i, /\bphone\b/i, /premium_detail/i]
    .forEach(re => assert.ok(!re.test(ret), `leader views are aggregates only; ${re} must not appear`));
  assert.match(ret, /agent_email\s+text/);
  assert.match(ret, /month_ap\s+numeric/);
});

test('the migration is additive: it drops a function, never a table or a column', () => {
  const drops = SQL_CODE.match(/^\s*DROP\s+\w+/gim) || [];
  assert.ok(drops.length > 0, 'the function replacement is expected to appear as a DROP');
  drops.forEach(d => {
    assert.ok(/DROP\s+(FUNCTION|TRIGGER)/i.test(d), `unexpected ${d.trim()} — only function/trigger drops are allowed here`);
  });
  [/DROP\s+COLUMN/i, /DROP\s+TABLE/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i]
    .forEach(re => assert.ok(!re.test(SQL_CODE), `${re} must not appear in an additive migration`));
  assert.ok(!/\b(auth|storage)\.\w+\s+(SET|DROP|ADD)/i.test(SQL_CODE), 'nothing may alter auth.* or storage.*');
  assert.match(SQL_CODE, /ADD COLUMN IF NOT EXISTS accepted_at/);
});

test('a malformed AP cannot take down the whole team rollup', () => {
  assert.match(MIGRATION, /CASE WHEN COALESCE\(po\.data->>'ap',''\) ~ '\^-\?\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'/,
    'AP must be regex-guarded before the numeric cast');
});

test('the status filter matches the one both screens were aligned on in 20260736', () => {
  assert.match(MIGRATION, /NOT IN \('lapsed','chargeback'\)/);
});
