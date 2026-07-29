// ============================================================
// producer-codes.test.mjs — run with:  npm run test:producercodes
//
// Same split as the other app.html suites: the pure block between the
// // <producer-codes-core> sentinels is extracted and executed verbatim, then
// structural assertions cover the invariants that keep the bug classes shut.
//
// The one that matters most is the LAST one in section 1: `pcNormalizeCode()`
// in the browser and `pc_normalize_code()` in Postgres must agree about which
// codes are the same code. If they drift, the bulk-load preview shows the
// agency owner one thing and the database does another — silently, on money.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260740_producer_codes.sql'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n')
  .filter(l => !markers.some(m => l.trim().startsWith(m)))
  .join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);
const SQL_CODE = stripLineComments(MIGRATION, ['--']);

const EXPORTS = [
  'pcNormalizeCode', 'pcLooksLikeNpn', 'pcDetectBulkColumns',
  'pcPlanBulk', 'pcBulkSummary', 'pcCoverageLine',
];
function loadCore() {
  const m = APP.match(/\/\/ <producer-codes-core>([\s\S]*?)\/\/ <\/producer-codes-core>/);
  assert.ok(m, 'app.html must contain the // <producer-codes-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const P = loadCore();

const CARRIERS = [
  { key: 'americo', label: 'Americo' },
  { key: 'trans', label: 'Transamerica' },
  { key: 'mutual', label: 'Mutual of Omaha' },
];
const MEMBERS = [
  { agent_id: 'me', agent_email: 'lead@example.com', agent_name: 'Jane Leader', is_self: true },
  { agent_id: 'd1', agent_email: 'dana@example.com', agent_name: 'Dana Reyes', is_self: false },
  { agent_id: 'd2', agent_email: 'sam@example.com', agent_name: 'Sam Okafor', is_self: false },
];

// ============================================================
// 1. BEHAVIOUR
// ============================================================

test('code normalization folds case and every separator carriers print', () => {
  assert.equal(P.pcNormalizeCode('QA-777'), 'QA777');
  assert.equal(P.pcNormalizeCode('qa 777'), 'QA777');
  assert.equal(P.pcNormalizeCode('  qa/777  '), 'QA777');
  assert.equal(P.pcNormalizeCode(''), '');
  assert.equal(P.pcNormalizeCode(null), '');
  assert.equal(P.pcNormalizeCode(undefined), '');
});

test('an NPN is digits, up to ten of them', () => {
  assert.equal(P.pcLooksLikeNpn('12345678'), true);
  assert.equal(P.pcLooksLikeNpn('1'), true);
  assert.equal(P.pcLooksLikeNpn('1234567890'), true);
  assert.equal(P.pcLooksLikeNpn('12345678901'), false);
  assert.equal(P.pcLooksLikeNpn('AGT-4471'), false);
  assert.equal(P.pcLooksLikeNpn(''), false);
});

// ---- column detection ----

test('bulk columns are detected from ordinary spreadsheet headings', () => {
  const c = P.pcDetectBulkColumns(
    ['Agent Email', 'Agent Name', 'NPN', 'Americo', 'Transamerica'], CARRIERS);
  assert.equal(c.email, 0);
  assert.equal(c.name, 1);
  assert.equal(c.npn, 2);
  assert.deepEqual(c.carrierCols, [{ index: 3, carrier: 'Americo' }, { index: 4, carrier: 'Transamerica' }]);
  assert.deepEqual(c.ignored, []);
});

test('a carrier column survives the words people add after the carrier name', () => {
  const c = P.pcDetectBulkColumns(
    ['Email', 'Americo Writing Number', 'Transamerica Code', 'Mutual of Omaha #'], CARRIERS);
  assert.deepEqual(c.carrierCols.map(x => x.carrier), ['Americo', 'Transamerica', 'Mutual of Omaha']);
});

test('an unrecognised column is reported, never loaded as somebody\'s writing number', () => {
  const c = P.pcDetectBulkColumns(['Email', 'NPN', 'Start Date', 'Notes'], CARRIERS);
  assert.deepEqual(c.ignored, ['Start Date', 'Notes']);
  assert.deepEqual(c.carrierCols, []);
});

test('column detection is case- and whitespace-insensitive', () => {
  const c = P.pcDetectBulkColumns(['  E-MAIL ', 'npn', 'AMERICO'], CARRIERS);
  assert.equal(c.email, 0);
  assert.equal(c.npn, 1);
  assert.equal(c.carrierCols[0].carrier, 'Americo');
});

// ---- planning ----

const SHEET = [
  ['Agent Email', 'NPN', 'Americo', 'Transamerica'],
  ['dana@example.com', '19283746', 'AM-100', 'TA-100'],
  ['sam@example.com', '55667788', 'AM-200', ''],
  ['lead@example.com', '11112222', '', ''],
];

test('a clean sheet plans exactly the rows it would write', () => {
  const plan = P.pcPlanBulk(SHEET, CARRIERS, MEMBERS);
  assert.equal(plan.problems.length, 0);
  assert.equal(plan.entries.length, 6, 'dana 3, sam 2, leader 1');
  const dana = plan.entries.filter(e => e.subjectId === 'd1');
  assert.deepEqual(dana.map(e => [e.carrier, e.code]),
    [[null, '19283746'], ['Americo', 'AM-100'], ['Transamerica', 'TA-100']]);
  assert.equal(dana[0].kind, 'npn');
  assert.equal(dana[1].kind, 'writing_number');
  assert.equal(plan.entries.find(e => e.subjectId === 'me').isSelf, true);
});

test('a blank cell is not a code', () => {
  const plan = P.pcPlanBulk(SHEET, CARRIERS, MEMBERS);
  assert.equal(plan.entries.filter(e => e.code === '').length, 0);
  assert.equal(plan.entries.filter(e => e.subjectId === 'd2').length, 2, 'sam has no Transamerica code');
});

test('a row naming somebody outside the agency is reported, never guessed at', () => {
  const plan = P.pcPlanBulk([
    ['Agent Email', 'NPN'],
    ['stranger@elsewhere.com', '99999999'],
    ['dana@example.com', '19283746'],
  ], CARRIERS, MEMBERS);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].reason, /not you and is not an agent in your agency/);
  assert.equal(plan.problems[0].row, 2);
});

test('rows match on name when the sheet has no email column', () => {
  const plan = P.pcPlanBulk([
    ['Agent Name', 'NPN'],
    ['Dana Reyes', '19283746'],
  ], CARRIERS, MEMBERS);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].subjectId, 'd1');
});

test('a non-numeric NPN is left out and said so, rather than stored as an NPN', () => {
  const plan = P.pcPlanBulk([
    ['Agent Email', 'NPN', 'Americo'],
    ['dana@example.com', 'PENDING', 'AM-100'],
  ], CARRIERS, MEMBERS);
  assert.deepEqual(plan.entries.map(e => e.code), ['AM-100']);
  assert.match(plan.problems[0].reason, /does not look like an NPN/);
});

test('the same code twice in one sheet is reported once, not left to collide', () => {
  const plan = P.pcPlanBulk([
    ['Agent Email', 'Americo'],
    ['dana@example.com', 'AM-100'],
    ['sam@example.com', 'am 100'],
  ], CARRIERS, MEMBERS);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].reason, /appears more than once/);
});

test('a sheet with nothing to load says which half is missing', () => {
  const noWho = P.pcPlanBulk([['NPN', 'Americo'], ['123', 'AM-1']], CARRIERS, MEMBERS);
  assert.match(noWho.problems[0].reason, /no email or name column/);
  assert.equal(noWho.entries.length, 0);

  const noCodes = P.pcPlanBulk([['Agent Email', 'Start Date'], ['dana@example.com', '2026-01-01']], CARRIERS, MEMBERS);
  assert.match(noCodes.problems[0].reason, /no NPN column and no carrier columns/);
  assert.equal(noCodes.entries.length, 0);

  const empty = P.pcPlanBulk([['Agent Email', 'NPN']], CARRIERS, MEMBERS);
  assert.match(empty.problems[0].reason, /no rows under its header/);
});

test('a row with an agent but no codes is reported rather than silently skipped', () => {
  const plan = P.pcPlanBulk([
    ['Agent Email', 'NPN', 'Americo'],
    ['dana@example.com', '', ''],
  ], CARRIERS, MEMBERS);
  assert.equal(plan.entries.length, 0);
  assert.match(plan.problems[0].reason, /has no codes on this row/);
});

test('every planned entry and every problem accounts for a real row of the sheet', () => {
  const plan = P.pcPlanBulk(SHEET, CARRIERS, MEMBERS);
  plan.entries.forEach(e => assert.ok(e.row >= 2 && e.row <= SHEET.length));
  plan.problems.forEach(p => assert.ok(p.row >= 1));
});

// ---- sentences ----

test('the bulk summary reads as a sentence in singular and plural', () => {
  assert.equal(P.pcBulkSummary({ entries: [{ subjectId: 'a' }], problems: [] }), '1 code for 1 agent');
  assert.equal(
    P.pcBulkSummary({ entries: [{ subjectId: 'a' }, { subjectId: 'b' }], problems: [{}] }),
    '2 codes for 2 agents · 1 row skipped');
  assert.equal(P.pcBulkSummary({ entries: [], problems: [{}, {}] }), '0 codes for 0 agents · 2 rows skipped');
});

test('the coverage line tells the agent what is missing, or that nothing is', () => {
  assert.match(P.pcCoverageLine([{ known: false, row_count: 142 }, { known: true, row_count: 9 }]),
    /^142 commission lines carry 1 code you have not recorded\.$/);
  assert.match(P.pcCoverageLine([{ known: false, row_count: 1 }, { known: false, row_count: 2 }]),
    /^3 commission lines carry 2 codes you have not recorded\.$/);
  assert.equal(P.pcCoverageLine([{ known: true, row_count: 5 }]), 'Every producer code on your statements is recorded.');
  assert.equal(P.pcCoverageLine([]), 'No commission line you have ingested carries a producer code yet.');
});

// ---- the invariant that matters most ----

test('the browser and Postgres agree about which codes are the same code', () => {
  // pc_normalize_code() is `upper(regexp_replace(…, '[^A-Za-z0-9]', '', 'g'))`.
  // Re-implement the SQL from the migration text itself, so a change to one
  // side without the other fails here rather than in production.
  const m = /regexp_replace\(coalesce\(p, ''\), '\[\^([A-Za-z0-9-]+)\]', '', 'g'\)/.exec(SQL_CODE);
  assert.ok(m, 'pc_normalize_code must strip a character class');
  assert.equal(m[1], 'A-Za-z0-9', 'the SQL must keep exactly alphanumerics');
  assert.match(SQL_CODE, /upper\(regexp_replace/, 'the SQL must uppercase');

  const sqlNormalize = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  for (const sample of ['QA-777', 'qa 777', ' a/b_c ', '12345678', 'ÅGT-1', '', 'x'.repeat(40)]) {
    assert.equal(P.pcNormalizeCode(sample), sqlNormalize(sample), `disagreement on ${JSON.stringify(sample)}`);
  }
});

// ============================================================
// 2. STRUCTURE
// ============================================================

test('the browser never writes commission_rows — attribution goes through the RPC', () => {
  const writes = APP_CODE.match(/from\(['"]commission_rows['"]\)[\s\S]{0,80}?\.(insert|update|upsert|delete)\(/g) || [];
  assert.equal(writes.length, 0);
  assert.match(APP_CODE, /sb\.rpc\('apply_producer_codes'\)/);
});

test('the reconcile is SECURITY DEFINER and takes no parameter naming an agent', () => {
  const fn = /create or replace function public\.apply_producer_codes\(([^)]*)\)([\s\S]*?)\$\$;/.exec(SQL_CODE);
  assert.ok(fn, 'apply_producer_codes must exist');
  assert.equal(fn[1].trim(), '', 'no parameter — there must be nothing to point at another agent');
  assert.match(fn[2], /security definer/);
  assert.match(fn[2], /me uuid := auth\.uid\(\)/);
});

test('the reconcile clears its own stale attributions but never a manual one', () => {
  assert.match(SQL_CODE, /r\.attribution_method = 'producer_code'[\s\S]*?not exists/);
  assert.match(SQL_CODE, /coalesce\(r\.attribution_method, 'producer_code'\) = 'producer_code'/);
});

test('subject_agent_id is guarded by a trigger, not merely by the write path', () => {
  // "Protect the column, not only the function that sets it" — the lesson
  // 20260703c, 20260730 and 20260736 each cost this schema once.
  assert.match(SQL_CODE, /create trigger producer_codes_guard_subject[\s\S]*?before insert or update/);
  assert.match(SQL_CODE, /producer code must belong to you or to an agent in your agency/);
  assert.match(SQL_CODE, /ai\.status = 'accepted'/);
});

test('code_key is derived by a trigger, so a client cannot file a code under the wrong key', () => {
  assert.match(SQL_CODE, /create trigger producer_codes_derive_key[\s\S]*?before insert or update/);
  assert.match(SQL_CODE, /new\.code_key := public\.pc_normalize_code\(new\.code\)/);
});

test('the migration is additive — no DROP of a table, column or data', () => {
  assert.equal(/drop\s+table/i.test(SQL_CODE), false);
  assert.equal(/drop\s+column/i.test(SQL_CODE), false);
  assert.equal(/\btruncate\b/i.test(SQL_CODE), false);
  (SQL_CODE.match(/drop\s+\w+/gi) || []).forEach(d =>
    assert.match(d, /drop\s+(policy|trigger)/i, 'unexpected drop: ' + d));
});

test('the migration touches nothing in auth.* or storage.*', () => {
  assert.equal(/(create|alter)\s+\w*\s*(table|policy|function|trigger)?\s*(auth|storage)\./i.test(SQL_CODE), false);
  assert.equal(/\bstorage\./i.test(SQL_CODE), false);
});

test('producer_codes is owner-scoped on every operation', () => {
  const policies = SQL_CODE.match(/create policy producer_codes_\w+[\s\S]*?;/g) || [];
  assert.equal(policies.length, 4, 'select, insert, update, delete');
  policies.forEach(p => assert.match(p, /agent_id = auth\.uid\(\)/, p.slice(0, 60)));
});

test('the Producer Codes tab is reachable and wired', () => {
  assert.match(APP, /data-stg-tab="codes"/);
  assert.match(APP, /id="stg-codes"/);
  assert.match(APP_CODE, /if \(id === 'codes'\) pcRenderTab\(\);/);
});

test('Settings panels are shown and hidden structurally, not from a hand-written list', () => {
  // Adding this tab needed the panel to be named in TWO places (settingsTab and
  // initSettingsSection), and missing the second one shipped a Producer Codes
  // panel that rendered on top of Account instead of replacing it — caught by
  // the click-through, not by any assertion that existed at the time.
  assert.match(APP_CODE, /function stgPanels\(\)[\s\S]*?querySelectorAll\('#sec-settings > \[id\^="stg-"\]'\)/);
  const settingsTab = /function settingsTab\(id, el\)([\s\S]*?)\n}/.exec(APP_CODE);
  assert.ok(settingsTab, 'settingsTab must exist');
  assert.match(settingsTab[1], /stgPanels\(\)\.forEach/);
  assert.equal(/getElementById\('stg-(account|carriers|integrations|texting|codes)'\)\.style\.display/.test(settingsTab[1]),
    false, 'settingsTab must not name panels one by one');

  const init = /function initSettingsSection\(\)([\s\S]*?)\n}/.exec(APP_CODE);
  assert.ok(init, 'initSettingsSection must exist');
  assert.match(init[1], /stgPanels\(\)\.forEach/);
  assert.equal(/stgTxt|stgInt|getElementById\('stg-carriers'\)\.style\.display/.test(init[1]),
    false, 'initSettingsSection must not name panels one by one either');

  // Every tab button has a panel, and every panel has a tab button.
  const tabIds = [...APP.matchAll(/data-stg-tab="([a-z]+)"/g)].map(m => m[1]);
  const panelIds = [...APP.matchAll(/<div id="stg-([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(tabIds)].sort(), [...new Set(panelIds)].sort());
});

test('saving or removing a code always runs the reconcile', () => {
  // A save that does not reconcile hides the entire point of the feature.
  assert.match(APP_CODE, /async function pcAddCode[\s\S]*?await pcReconcile\('Code saved'\)/);
  assert.match(APP_CODE, /async function pcDeleteCode[\s\S]*?await pcReconcile\('Code removed'\)/);
  assert.match(APP_CODE, /async function pcBulkApply[\s\S]*?await pcReconcile\('Bulk load applied'\)/);
});

test('the reconcile result is reported to the agent, not swallowed', () => {
  assert.match(APP_CODE, /commission lines attributed/);
  assert.match(APP_CODE, /no commission lines matched it yet/);
});

test('bulk load never writes without a preview the owner confirmed', () => {
  // pcBulkPick only PLANS; the insert lives in pcBulkApply, behind the button.
  const pick = /function pcBulkPick\(([\s\S]*?)\n}/.exec(APP_CODE);
  assert.ok(pick);
  assert.equal(/\.upsert\(|\.insert\(/.test(pick[1]), false, 'pcBulkPick must not write');
  assert.match(APP_CODE, /function pcBulkApply[\s\S]*?from\('producer_codes'\)\s*\n?\s*\.upsert\(/);
});

test('the core block is pure — no DOM, network, storage or app globals', () => {
  const m = APP.match(/\/\/ <producer-codes-core>([\s\S]*?)\/\/ <\/producer-codes-core>/);
  const code = stripLineComments(m[1], ['//', '*', '/*']);
  for (const forbidden of ['document.', 'window.', 'localStorage', 'fetch(', 'sb.', 'currentAgent', 'showToast', 'XLSX']) {
    assert.equal(code.includes(forbidden), false, `the core must not reference ${forbidden}`);
  }
});

test('the bulk-load upsert targets a real unique index, not an expression one', () => {
  // PostgREST's on_conflict can only name COLUMNS. The uniqueness rule folds a
  // NULL carrier to '', so it needs a generated column to be expressible that
  // way — without it the whole bulk batch fails the moment one code in the
  // sheet is already recorded, which is the normal case for a re-upload.
  assert.match(SQL_CODE, /add column if not exists carrier_key text generated always as \(coalesce\(carrier, ''\)\) stored/);
  assert.match(SQL_CODE, /create unique index if not exists producer_codes_key_uidx[\s\S]*?\(agent_id, carrier_key, code_key\)/);
  assert.match(APP_CODE, /onConflict: 'agent_id,carrier_key,code_key'/);
});
