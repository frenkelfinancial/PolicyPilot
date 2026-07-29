// ============================================================
// commissions.test.mjs — run with:  npm run test:commissions
//
// Back Office Phase 4. Same split as the other Back Office test files.
//
//   1. BEHAVIOUR. The pure block between the // <comm-core> sentinels in
//      app.html is extracted and executed verbatim, so the tests run the code
//      that ships rather than a copy of it that drifts.
//
//   2. STRUCTURE. Assertions about app.html and the migration as source text —
//      the bug classes: a cross-agent RPC growing a parameter that names an
//      agent, the rollup returning a client name, money vanishing from a
//      total, a headline figure whose definition lives somewhere no test runs.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260742_commissions_dashboard.sql'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);
const SQL_CODE = stripLineComments(MIGRATION, ['--']);

const EXPORTS = [
  'COMM_RANGES', 'COMM_TABS', 'COMM_PERSONAL_TYPES', 'COMM_DEBT_TYPES', 'COMM_CARD_DEFS',
  'commRange', 'commTotals', 'commCards', 'commWeekly', 'commTrendGeometry',
  'commMix', 'commAttributionNote', 'commMoney', 'commWeekLabel', 'commDebtRanked',
];
function loadCore() {
  const m = APP.match(/\/\/ <comm-core>([\s\S]*?)\/\/ <\/comm-core>/);
  assert.ok(m, 'app.html must contain the // <comm-core> ... // </comm-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const C = loadCore();

// A bucket as get_commission_buckets returns one.
const B = (week, type, own, amount, extra = {}) => ({
  week_start: week,
  transaction_type: type,
  is_own: own,
  amount_cents: amount,
  positive_cents: amount > 0 ? amount : 0,
  negative_cents: amount < 0 ? amount : 0,
  row_count: 1,
  ...extra,
});

// The fixture used across the totals tests. Deliberately the same shape as the
// SQL behavioural check, so the two halves are checking one story.
const BOOK = [
  B('2026-07-06', 'advance', true, 100000),
  B('2026-07-06', 'renewal', true, 10000),
  B('2026-07-13', 'chargeback', true, -30000),
  B('2026-07-13', 'override', true, 25000),
  B('2026-07-20', 'adjustment', true, -5000),
  B('2026-07-06', 'advance', false, 200000),   // written by a downline agent
];

// ============================================================
// 1. BEHAVIOUR
// ============================================================

test('the three ranges are MTD, YTD and All time', () => {
  assert.deepEqual(C.COMM_RANGES.map(r => r.key), ['mtd', 'ytd', 'all']);
});

test('a range is a half-open local-calendar window, and All time is unbounded', () => {
  const day = new Date(2026, 6, 15);           // 15 Jul 2026, local
  assert.deepEqual(C.commRange('mtd', day), { start: '2026-07-01', end: '2026-08-01' });
  assert.deepEqual(C.commRange('ytd', day), { start: '2026-01-01', end: '2027-01-01' });
  assert.deepEqual(C.commRange('all', day), { start: null, end: null });
  // Local, not UTC: a date built from local parts must not slide a day.
  assert.equal(C.commRange('mtd', new Date(2026, 0, 1)).start, '2026-01-01');
  assert.equal(C.commRange('mtd', new Date(2026, 11, 31)).end, '2027-01-01');
});

test('gross is every positive line and nothing else', () => {
  assert.equal(C.commTotals(BOOK).gross, 100000 + 10000 + 25000 + 200000);
});

test('chargebacks are reported as a positive magnitude', () => {
  assert.equal(C.commTotals(BOOK).chargebacks, 35000);
});

test('net is every line added up — the arithmetic sum', () => {
  assert.equal(C.commTotals(BOOK).net, 300000);
  assert.equal(C.commTotals(BOOK).net, C.commTotals(BOOK).gross - C.commTotals(BOOK).chargebacks);
});

test('total commission counts earnings only — an adjustment is not commission', () => {
  // 100000 + 10000 - 30000 + 25000 + 200000 = 305000. The -5000 adjustment is
  // in `net` (it reached the bank) but not in `total` (it is not commission).
  assert.equal(C.commTotals(BOOK).total, 305000);
  assert.notEqual(C.commTotals(BOOK).total, C.commTotals(BOOK).net,
    'these two must be able to differ, or one of the cards is decoration');
});

test('personal sales exclude a line attributed to another agent', () => {
  // own advance + own renewal - own chargeback. The 200000 is a downline
  // agent's business on the leader's consolidated statement.
  assert.equal(C.commTotals(BOOK).personal, 80000);
});

test('personal sales exclude override — that is the whole point of the split', () => {
  const t = C.commTotals([B('2026-07-06', 'override', true, 50000)]);
  assert.equal(t.personal, 0);
  assert.equal(t.override, 50000);
});

test('override income counts override lines whoever they are attributed to', () => {
  assert.equal(C.commTotals(BOOK).override, 25000);
});

test('totals survive an empty or absent result', () => {
  const t = C.commTotals([]);
  assert.deepEqual(
    [t.gross, t.chargebacks, t.net, t.total, t.personal, t.override], [0, 0, 0, 0, 0, 0]);
  assert.equal(C.commTotals(null).net, 0);
});

test('six cards, in order, each with a plain-English definition', () => {
  const cards = C.commCards(C.commTotals(BOOK), 35000);
  assert.deepEqual(cards.map(c => c.key),
    ['total', 'gross', 'net', 'personal', 'override', 'debt']);
  cards.forEach(c => {
    assert.ok(c.def && c.def.length > 30, `${c.key} must carry its definition`);
    assert.ok(/\.$/.test(c.def), `${c.key}'s definition should read as a sentence`);
    assert.ok(!/undefined|NaN/.test(c.def));
  });
});

test('the six definitions are all different — no two cards claim the same thing', () => {
  const defs = Object.values(C.COMM_CARD_DEFS);
  assert.equal(new Set(defs).size, defs.length);
});

test('the debt card carries the debt figure, and is marked as the inverted one', () => {
  const debt = C.commCards(C.commTotals(BOOK), 35000).find(c => c.key === 'debt');
  assert.equal(debt.cents, 35000);
  assert.equal(debt.invert, true, 'a big debt is bad news and must not render as a big green number');
});

test('weekly buckets split commission, personal, override and debt', () => {
  const w = C.commWeekly(BOOK, { start: null, end: null });
  const wk = k => w.find(x => x.week === k);
  assert.equal(wk('2026-07-06').commission, 310000);      // 100000+10000+200000
  assert.equal(wk('2026-07-06').personal, 110000);        // own only
  assert.equal(wk('2026-07-13').commission, -5000);       // -30000+25000
  assert.equal(wk('2026-07-13').override, 25000);
  assert.equal(wk('2026-07-13').debt, 30000, 'a chargeback is debt in that week');
  assert.equal(wk('2026-07-20').debt, 5000, 'a negative adjustment is debt too');
});

test('a POSITIVE adjustment is a repayment, never negative debt', () => {
  const w = C.commWeekly([B('2026-07-06', 'adjustment', true, 5000)], { start: null, end: null });
  assert.equal(w[0].debt, 0, 'debt must not go negative and paint a bar upward');
});

test('empty weeks are filled in, so a quiet month is not compressed away', () => {
  const w = C.commWeekly([B('2026-07-06', 'advance', true, 100)],
    { start: '2026-07-01', end: '2026-08-01' });
  assert.ok(w.length >= 5, `expected the whole month of weeks, got ${w.length}`);
  assert.ok(w.every((x, i) => i === 0 || x.week > w[i - 1].week), 'weeks must be ascending');
  assert.equal(w.filter(x => x.commission !== 0).length, 1);
});

test('an unbounded range does not invent weeks that have no data', () => {
  const w = C.commWeekly([B('2026-07-06', 'advance', true, 100)], { start: null, end: null });
  assert.equal(w.length, 1);
});

test('the trend chart puts commission above the zero line and debt below it', () => {
  const g = C.commTrendGeometry(C.commWeekly(BOOK, { start: null, end: null }), { width: 300, height: 200 });
  assert.equal(g.empty, false);
  const up = g.bars.filter(b => b.up);
  const down = g.bars.filter(b => b.down);
  assert.ok(up.length > 0 && down.length > 0);
  up.forEach(b => assert.ok(b.up.y + b.up.h <= g.zeroY + 0.01, 'an up bar must end at the zero line'));
  down.forEach(b => assert.ok(b.down.y >= g.zeroY - 0.01, 'a down bar must start at the zero line'));
});

test('with no debt the zero line sits at the bottom, not floating mid-air', () => {
  const g = C.commTrendGeometry([{ week: '2026-07-06', commission: 100, personal: 100, override: 0, debt: 0 }],
    { width: 300, height: 200 });
  assert.ok(g.zeroY > 150, `zero line should be near the bottom, got ${g.zeroY}`);
});

test('with only debt the zero line sits at the top', () => {
  const g = C.commTrendGeometry([{ week: '2026-07-06', commission: 0, personal: 0, override: 0, debt: 500 }],
    { width: 300, height: 200 });
  assert.ok(g.zeroY < 30, `zero line should be near the top, got ${g.zeroY}`);
});

test('the geometry never divides by zero on an all-zero period', () => {
  const g = C.commTrendGeometry([{ week: '2026-07-06', commission: 0, personal: 0, override: 0, debt: 0 }],
    { width: 300, height: 200 });
  assert.equal(g.empty, true);
  g.bars.forEach(b => { assert.ok(!Number.isNaN(b.x)); });
  assert.ok(!Number.isNaN(g.zeroY));
});

test('the geometry survives no weeks at all', () => {
  const g = C.commTrendGeometry([], {});
  assert.equal(g.empty, true);
  assert.deepEqual(g.bars, []);
});

test('the mix totals exactly 100, never 99 or 101', () => {
  for (const [p, o] of [[1, 2], [1, 1], [1000, 3], [7, 13], [333, 667], [1, 0], [0, 1]]) {
    const m = C.commMix({ personal: p, override: o });
    assert.equal(m.personalPct + m.overridePct, 100, `${p}/${o} produced ${m.personalPct}+${m.overridePct}`);
  }
});

test('a book that earned nothing has no mix — 0/0, not 100/0', () => {
  const m = C.commMix({ personal: 0, override: 0 });
  assert.equal(m.hasData, false);
  assert.equal(m.personalPct, 0);
  assert.equal(m.overridePct, 0);
});

test('a negative personal figure does not produce a negative slice', () => {
  const m = C.commMix({ personal: -500, override: 100 });
  assert.ok(m.personalPct >= 0 && m.overridePct >= 0);
  assert.equal(m.personalPct + m.overridePct, 100);
});

test('the attribution note only appears for a leader, and only when it applies', () => {
  const t = C.commTotals(BOOK);
  assert.ok(t.notOwnRows > 0);
  assert.equal(C.commAttributionNote(t, false), null, 'a solo agent has no agency to explain');
  assert.match(C.commAttributionNote(t, true), /1 line on your statements is attributed/);
  assert.equal(C.commAttributionNote(C.commTotals([]), true), null);
});

test('the attribution note is grammatical in the singular and the plural', () => {
  const one = C.commAttributionNote({ notOwnRows: 1 }, true);
  const two = C.commAttributionNote({ notOwnRows: 2 }, true);
  assert.match(one, /^1 line .* is attributed/);
  assert.match(two, /^2 lines .* are attributed/);
});

test('money is signed, and a negative is money moving the other way', () => {
  assert.equal(C.commMoney(123456), '$1,234.56');
  assert.equal(C.commMoney(-5000), '-$50.00');
  assert.equal(C.commMoney(0), '$0.00');
  assert.equal(C.commMoney(null), '$0.00');
});

test('a week label renders in UTC, so it cannot slide a day', () => {
  assert.equal(C.commWeekLabel('2026-07-06'), 'Jul 6');
  assert.equal(C.commWeekLabel('2026-01-01'), 'Jan 1');
  assert.equal(C.commWeekLabel(null), '');
});

test('carriers rank by debt, largest first, with shares that make sense', () => {
  const d = C.commDebtRanked([
    { carrier: 'Aetna', debt_cents: 5000, row_count: 1, unmatched_rows: 0 },
    { carrier: 'Americo', debt_cents: 30000, row_count: 3, unmatched_rows: 1 },
    { carrier: 'Zero', debt_cents: 0, row_count: 1, unmatched_rows: 0 },
  ]);
  assert.equal(d.total, 35000);
  assert.deepEqual(d.carriers.map(c => c.carrier), ['Americo', 'Aetna']);
  assert.ok(Math.abs(d.carriers[0].pct - (30000 / 35000) * 100) < 0.001);
  assert.equal(d.carriers[0].unmatched, 1, 'an unmatched debt line is still money owed');
});

test('no debt is an empty list and a zero total, not a divide by zero', () => {
  const d = C.commDebtRanked([]);
  assert.equal(d.total, 0);
  assert.deepEqual(d.carriers, []);
  assert.equal(C.commDebtRanked(null).total, 0);
});

// ============================================================
// 2. STRUCTURE
// ============================================================

test('the comm-core block is pure — no DOM, network, storage or app globals', () => {
  const m = APP.match(/\/\/ <comm-core>([\s\S]*?)\/\/ <\/comm-core>/);
  const body = stripLineComments(m[1], ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/, /\bcurrentAgent\b/,
   /\bescHTML\(/, /\bshowToast\(/, /\bnav\(/, /_cmCache/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
});

test('NEITHER commission RPC takes a parameter naming an agent', () => {
  // The whole authorization model is that there is nothing to point at
  // somebody else's book. Same rule as get_team_summary and
  // apply_producer_codes.
  const sigs = [...SQL_CODE.matchAll(
    /create or replace function public\.(get_commission_buckets|get_commission_debt|get_downline_commission_rollup)\(([^)]*)\)/gi)];
  assert.equal(sigs.length, 3, 'all three functions must be found');
  sigs.forEach(([, name, params]) => {
    assert.ok(!/agent|leader|uid|user/i.test(params),
      `${name} must not take a parameter naming an agent — got (${params.trim()})`);
    // Every parameter is a date bound.
    params.split(',').map(s => s.trim()).filter(Boolean).forEach(p => {
      assert.match(p, /\bdate\b/, `${name}: every parameter must be a time bound, got "${p}"`);
    });
  });
});

test('only the DOWNLINE rollup is SECURITY DEFINER; the personal ones read through RLS', () => {
  const block = n => {
    const i = SQL_CODE.indexOf(`create or replace function public.${n}(`);
    return SQL_CODE.slice(i, SQL_CODE.indexOf('$fn$;', i));
  };
  assert.ok(!/security definer/i.test(block('get_commission_buckets')),
    'the caller\'s own figures must read through their own RLS');
  assert.ok(!/security definer/i.test(block('get_commission_debt')));
  assert.match(block('get_downline_commission_rollup'), /security definer/i);
});

test('the rollup is anchored on auth.uid() and on an ACCEPTED invite', () => {
  const i = SQL_CODE.indexOf('create or replace function public.get_downline_commission_rollup(');
  const body = SQL_CODE.slice(i);
  assert.match(body, /ai\.leader_id\s*=\s*auth\.uid\(\)/);
  assert.match(body, /ai\.status\s*=\s*'accepted'/);
});

test('the rollup returns FIGURES — never a client name or a policy number', () => {
  const i = SQL_CODE.indexOf('create or replace function public.get_downline_commission_rollup(');
  const ret = SQL_CODE.slice(SQL_CODE.indexOf('returns table (', i), SQL_CODE.indexOf(')\nlanguage sql', i));
  [/client/i, /insured/i, /policy_number/i, /carrier/i, /statement/i, /phone/i, /dedupe/i]
    .forEach(re => assert.ok(!re.test(ret),
      `the rollup's RETURNS TABLE must not carry ${re} — enforced by the query, not by the UI`));
  // …and it does return the money figures it is for.
  ['gross_cents', 'net_cents', 'personal_cents', 'override_cents', 'debt_cents'].forEach(c =>
    assert.ok(ret.includes(c), `${c} must be returned`));
});

test('the rollup is bounded to the caller’s own agency by the UPLOADER', () => {
  const i = SQL_CODE.indexOf('create or replace function public.get_downline_commission_rollup(');
  const body = SQL_CODE.slice(i);
  assert.match(body, /cr\.agent_id in \(select uid from team\)/,
    'without this, a stranger’s row attributed to my downline enters my rollup');
});

test('a row attributed OUTSIDE the team falls back to the uploader, never vanishes', () => {
  // Excluding it made money disappear from the total with nothing on screen to
  // say so — an agent leaving the agency would silently shrink the leader's
  // figures. Found by the behavioural check.
  const i = SQL_CODE.indexOf('create or replace function public.get_downline_commission_rollup(');
  const body = SQL_CODE.slice(i);
  assert.match(body, /else cr\.agent_id\s*\n?\s*end as uid/i);
  assert.ok(!/and coalesce\(cr\.attributed_agent_id, cr\.agent_id\) in \(select uid from team\)/i.test(body),
    'the old exclusion predicate must not come back');
});

test('the migration adds no table, no column and no data', () => {
  [/create table/i, /alter table/i, /\binsert into\b/i, /\bupdate\s+public\./i,
   /DROP\s+TABLE/i, /DROP\s+COLUMN/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i]
    .forEach(re => assert.ok(!re.test(SQL_CODE), `${re} must not appear — this migration is three functions`));
  assert.ok(!/\b(auth|storage)\.\w+\s+(SET|DROP|ADD)/i.test(SQL_CODE));
});

test('no RLS policy is added or changed on commission_rows', () => {
  assert.ok(!/create policy/i.test(SQL_CODE), 'commission_rows must stay SELECT-only and per-tenant');
  assert.ok(!/row level security/i.test(SQL_CODE));
});

test('debt is chargeback and adjustment only — an advance is not a carrier balance', () => {
  const i = SQL_CODE.indexOf('create or replace function public.get_commission_debt(');
  const body = SQL_CODE.slice(i, SQL_CODE.indexOf('$fn$;', i));
  assert.match(body, /transaction_type in \('chargeback', 'adjustment'\)/);
  assert.deepEqual(C.COMM_DEBT_TYPES, ['chargeback', 'adjustment'],
    'the browser and the SQL must agree on what debt is made of');
});

test('debt is reported as a positive balance and a carrier in credit is not listed', () => {
  const i = SQL_CODE.indexOf('create or replace function public.get_commission_debt(');
  const body = SQL_CODE.slice(i, SQL_CODE.indexOf('$fn$;', i));
  assert.match(body, /greatest\(0, -coalesce\(sum\(cr\.amount_cents\), 0\)\)/);
  assert.match(body, /having greatest\(0/);
});

test('the debt figure is deliberately NOT range-filtered in the UI', () => {
  // You owe a carrier what you owe them; a balance that shrank because the
  // range chip moved would be a number nobody could act on.
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function cmRender'));
  assert.match(fn.slice(0, 2000), /get_commission_debt',\s*\{\s*p_start:\s*null,\s*p_end:\s*null\s*\}/);
});

test('the rollup is only fetched for a leader', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function cmRender'));
  assert.match(fn.slice(0, 2500), /if \(cmIsLeader\(\)\)[\s\S]{0,120}get_downline_commission_rollup/);
});

test('Back Office panels are resolved structurally, never from a list', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function boArea('));
  assert.match(fn.slice(0, 1200), /\[id\^="bopanel-"\]/);
  // The Settings tabs cost a shipped broken screen for exactly this.
  assert.ok(!/\['ingest',\s*'commissions'\]/.test(fn.slice(0, 1200)),
    'panels must not be enumerated one by one');
});

test('Bonuses is a LINK to the existing tracker, not a fourth panel', () => {
  assert.deepEqual(C.COMM_TABS.map(t => t.key), ['trends', 'payouts', 'debt']);
  assert.match(APP_CODE, /onclick="nav\(\\'bonuses\\'\)"[^>]*>Bonuses/);
});

test('switching tab does not re-query — the data does not depend on the tab', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function cmSetTab('), APP_CODE.indexOf('function cmIsLeader'));
  assert.match(fn, /cmPaint\(\)/);
  assert.ok(!/cmRender\(/.test(fn), 'a tab click must not spend three round trips');
});
