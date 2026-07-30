// ============================================================
// persistency.test.mjs — run with:  npm run test:persistency
//
// Back Office Phase 5. Same split as the other Back Office test files: the
// pure // <persist-core> block is extracted from app.html and executed
// verbatim, then structural assertions about app.html and the migration.
//
// The bug classes here are specific and expensive: a cohort quietly missing
// two thirds of the book, an empty cohort rendering as 0% and painting a red
// band on an agent who has just started, a claim counted as a lapse, and the
// browser and the SQL disagreeing about what "kept" means.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260743_persistency.sql'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);
const SQL_CODE = stripLineComments(MIGRATION, ['--']);

const EXPORTS = [
  'PERSIST_WINDOWS', 'PERSIST_BANDS', 'PERSIST_COHORT_EXCLUDED', 'PERSIST_KEPT',
  'persistBand', 'persistBandLabel', 'persistStartDate', 'persistCutoff',
  'persistCohort', 'persistIsKept', 'persistRate', 'persistWindows',
  'persistLeadSource', 'persistBySegment', 'persistOutlier', 'persistWindowLabel',
  'persistAgentRows',
];
function loadCore() {
  const m = APP.match(/\/\/ <persist-core>([\s\S]*?)\/\/ <\/persist-core>/);
  assert.ok(m, 'app.html must contain the // <persist-core> ... // </persist-core> block');
  // persistAgentRows() labels each agent, and that goes through ppAgentName()
  // — the ONE identity resolver, which lives in team-core because every screen
  // that names an agent needs it. Load team-core alongside rather than letting
  // this block grow a second copy of the "a person has a name, not an address"
  // rule. Same arrangement as test/leaderboards.test.mjs pulling in tmDur().
  const team = APP.match(/\/\/ <team-core>([\s\S]*?)\/\/ <\/team-core>/);
  assert.ok(team, 'app.html must contain the // <team-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${team[1]}\n${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const P = loadCore();

const NOW = new Date('2026-07-29T12:00:00Z');
// A policy: `ago` months before NOW, given status and AP.
const pol = (ago, status, extra = {}) => {
  const d = new Date(NOW); d.setMonth(d.getMonth() - ago);
  return { issueDate: d.toISOString().slice(0, 10), status, ap: 1200, ...extra };
};

// ============================================================
// 1. BEHAVIOUR
// ============================================================

test('the four windows are the ones the industry quotes', () => {
  assert.deepEqual(P.PERSIST_WINDOWS, [4, 9, 13, 25]);
});

test('the bands are green >=85, yellow 70-84, red below 70', () => {
  assert.equal(P.persistBand(100), 'green');
  assert.equal(P.persistBand(85), 'green');
  assert.equal(P.persistBand(84.9), 'yellow');
  assert.equal(P.persistBand(70), 'yellow');
  assert.equal(P.persistBand(69.9), 'red');
  assert.equal(P.persistBand(0), 'red');
});

test('no rate is NOT a red band — it is no band', () => {
  // 0/0 is not 0%. Painting red on an agent who has not been writing long
  // enough to have a cohort is the single most misleading thing this screen
  // could do.
  assert.equal(P.persistBand(null), null);
  assert.equal(P.persistBand(undefined), null);
  assert.equal(P.persistBand(NaN), null);
  assert.equal(P.persistBandLabel(null), '—');
});

test('the start date falls back issueDate -> draft -> dateSubmitted', () => {
  assert.equal(P.persistStartDate({ issueDate: '2025-01-05', draft: '2025-02-01' }), '2025-01-05');
  assert.equal(P.persistStartDate({ draft: '2025-02-01' }), '2025-02-01');
  assert.equal(P.persistStartDate({ dateSubmitted: '2025-03-01' }), '2025-03-01');
  assert.equal(P.persistStartDate({}), null);
  assert.equal(P.persistStartDate(null), null);
});

test('a malformed date is refused rather than parsed into nonsense', () => {
  assert.equal(P.persistStartDate({ issueDate: 'soon', draft: '2025-02-01' }), '2025-02-01');
  assert.equal(P.persistStartDate({ issueDate: '', draft: '' }), null);
  assert.equal(P.persistStartDate({ issueDate: 12345 }), null);
});

test('THE FIX: a policy with no issueDate is still in the cohort', () => {
  // In production 8 of 23 policies carry an issueDate and all 23 carry a
  // draft date. Keying on issueDate alone computed a rate over a third of the
  // book and presented it as the book's persistency.
  const onlyDraft = [{ draft: '2024-01-01', status: 'paid', ap: 1200 }];
  assert.equal(P.persistCohort(onlyDraft, 13, NOW).length, 1);
});

test('the cutoff clamps for short months rather than rolling over', () => {
  // 31 March minus one month is 28/29 February, not 3 March.
  assert.equal(P.persistCutoff(1, new Date('2026-03-31T12:00:00Z')), '2026-02-28');
  assert.equal(P.persistCutoff(1, new Date('2024-03-31T12:00:00Z')), '2024-02-29');
  assert.equal(P.persistCutoff(13, new Date('2026-07-29T12:00:00Z')), '2025-06-29');
});

test('a policy that never issued is NOT in the cohort', () => {
  // It was never at risk of lapsing. Counting it as a lapse punishes an agent
  // for underwriting.
  assert.deepEqual(P.PERSIST_COHORT_EXCLUDED.slice().sort(),
    ['approved', 'denied', 'pending', 'withdrawn']);
  const book = ['pending', 'approved', 'denied', 'withdrawn'].map(s => pol(20, s));
  assert.equal(P.persistCohort(book, 13, NOW).length, 0);
});

test('a policy too young for the window is not in it', () => {
  assert.equal(P.persistCohort([pol(3, 'paid')], 4, NOW).length, 0);
  assert.equal(P.persistCohort([pol(5, 'paid')], 4, NOW).length, 1);
  assert.equal(P.persistCohort([pol(14, 'paid')], 13, NOW).length, 1);
  assert.equal(P.persistCohort([pol(12, 'paid')], 13, NOW).length, 0);
});

test('A DEATH CLAIM IS NOT A LAPSE', () => {
  // The policy stayed in force until the insured died — the policy doing its
  // job. On a final-expense book this is common enough to matter.
  assert.ok(P.PERSIST_KEPT.includes('claim'));
  assert.equal(P.persistIsKept({ status: 'claim' }), true);
  assert.equal(P.persistIsKept({ status: 'paid' }), true);
  assert.equal(P.persistIsKept({ status: 'issued' }), true);
  assert.equal(P.persistIsKept({ status: 'placed' }), true, 'a legacy status must not read as lapsed');
});

test('lapsed, surrendered and charged-back policies are not kept', () => {
  ['lapsed', 'surrendered', 'chargeback'].forEach(s =>
    assert.equal(P.persistIsKept({ status: s }), false, `${s} must not count as in force`));
});

test('flat persistency counts policies', () => {
  const book = [pol(20, 'paid'), pol(20, 'paid'), pol(20, 'paid'), pol(20, 'lapsed')];
  const r = P.persistRate(P.persistCohort(book, 13, NOW), false);
  assert.equal(r.rate, 75);
  assert.equal(r.cohort, 4);
  assert.equal(r.kept, 3);
  assert.equal(r.lost, 1);
  assert.equal(r.basis, 'count');
});

test('weighted persistency counts premium, and that is the point of the toggle', () => {
  // Nine small policies kept and one big one lost: 90% flat, 31% weighted.
  const book = [];
  for (let i = 0; i < 9; i++) book.push(pol(20, 'paid', { ap: 300 }));
  book.push(pol(20, 'lapsed', { ap: 6000 }));
  const cohort = P.persistCohort(book, 13, NOW);
  assert.equal(Math.round(P.persistRate(cohort, false).rate), 90);
  assert.equal(Math.round(P.persistRate(cohort, true).rate), 31);
});

test('an empty cohort has NO rate, not a zero rate', () => {
  const r = P.persistRate([], false);
  assert.equal(r.rate, null);
  assert.equal(r.cohort, 0);
  assert.equal(P.persistBand(r.rate), null);
});

test('a cohort with no premium at all has no WEIGHTED rate, not zero', () => {
  const book = [pol(20, 'paid', { ap: 0 }), pol(20, 'lapsed', { ap: 0 })];
  const r = P.persistRate(P.persistCohort(book, 13, NOW), true);
  assert.equal(r.rate, null);
  assert.equal(r.noPremium, true);
  assert.equal(r.cohort, 2, 'the policies are still counted, just not weighable');
});

test('all four windows come back at once, each with its band', () => {
  const book = [pol(30, 'paid'), pol(30, 'lapsed'), pol(5, 'paid')];
  const w = P.persistWindows(book, false, NOW);
  assert.deepEqual(w.map(x => x.months), [4, 9, 13, 25]);
  assert.equal(w.find(x => x.months === 25).cohort, 2);
  assert.equal(w.find(x => x.months === 4).cohort, 3);
  w.forEach(x => assert.equal(x.band, P.persistBand(x.rate)));
});

test('the lead source comes from the live lead first, the snapshot second', () => {
  const leads = new Map([['77', { id: 77, source: 'VRC' }]]);
  assert.equal(P.persistLeadSource({ soldLeadId: 77, leadSource: 'old snapshot' }, leads), 'VRC');
  assert.equal(P.persistLeadSource({ leadSource: 'Referral' }, leads), 'Referral');
  assert.equal(P.persistLeadSource({ soldLeadId: 999, leadSource: 'Referral' }, leads), 'Referral',
    'a deleted lead falls back to the snapshot rather than losing the link');
});

test('a policy with no lead link at all returns null, never a fake bucket', () => {
  assert.equal(P.persistLeadSource({}, new Map()), null);
  assert.equal(P.persistLeadSource(null, new Map()), null);
});

test('segments rank worst first, and unlinked policies are counted separately', () => {
  const book = [
    pol(20, 'paid', { carrier: 'Americo' }), pol(20, 'paid', { carrier: 'Americo' }),
    pol(20, 'paid', { carrier: 'Americo' }), pol(20, 'lapsed', { carrier: 'Americo' }),
    pol(20, 'paid', { carrier: 'Aetna' }), pol(20, 'lapsed', { carrier: 'Aetna' }),
    pol(20, 'lapsed', { carrier: 'Aetna' }), pol(20, 'paid', {}),
  ];
  const seg = P.persistBySegment(book, 13, false, p => p.carrier || null, NOW);
  assert.equal(seg.rows[0].key, 'Aetna', 'worst first');
  assert.equal(Math.round(seg.rows[0].rate), 33);
  assert.equal(Math.round(seg.rows[1].rate), 75);
  assert.equal(seg.unlinked, 1, 'the carrier-less policy is counted, not dropped');
  assert.equal(seg.cohortSize, 8);
});

test('a one-policy segment is flagged thin rather than treated as a rate', () => {
  const book = [pol(20, 'lapsed', { carrier: 'Tiny' })];
  const seg = P.persistBySegment(book, 13, false, p => p.carrier, NOW);
  assert.equal(seg.rows[0].thin, true);
  assert.equal(seg.rows[0].rate, 0, 'the figure is still shown — it is just not an outlier');
});

test('a segment with no rate sorts LAST, not to the top as the worst', () => {
  const book = [
    pol(20, 'paid', { carrier: 'Good', ap: 1200 }),
    pol(20, 'paid', { carrier: 'Good', ap: 1200 }),
    pol(20, 'lapsed', { carrier: 'NoPremium', ap: 0 }),
  ];
  const seg = P.persistBySegment(book, 13, true, p => p.carrier, NOW);
  assert.equal(seg.rows[seg.rows.length - 1].key, 'NoPremium');
});

test('an outlier only fires when the segment is MATERIALLY worse', () => {
  const seg = { rows: [{ key: 'Aetna', rate: 84, cohort: 10, lost: 2, thin: false, band: 'yellow' }] };
  assert.equal(P.persistOutlier(seg, 88, 'Carrier'), null, 'four points behind is noise');
  const out = P.persistOutlier(seg, 99, 'Carrier');
  assert.ok(out);
  assert.match(out.reason, /^Carrier Aetna persists at 84%, 15 points below your book/);
  assert.match(out.reason, /2 of 10 policies did not stay on the books\.$/);
});

test('an outlier never accuses a thin segment', () => {
  const seg = { rows: [{ key: 'Tiny', rate: 0, cohort: 1, lost: 1, thin: true, band: 'red' }] };
  assert.equal(P.persistOutlier(seg, 90, 'Carrier'), null);
});

test('an outlier is silent when there is no book rate to compare against', () => {
  const seg = { rows: [{ key: 'X', rate: 10, cohort: 9, lost: 8, thin: false, band: 'red' }] };
  assert.equal(P.persistOutlier(seg, null, 'Carrier'), null);
  assert.equal(P.persistOutlier(null, 90, 'Carrier'), null);
});

test('the outlier reason names a number, a gap and a count — never a bare label', () => {
  const seg = { rows: [{ key: 'VRC', rate: 55, cohort: 20, lost: 9, thin: false, band: 'red' }] };
  const out = P.persistOutlier(seg, 85, 'Lead source');
  assert.ok(!/undefined|NaN|null/.test(out.reason), out.reason);
  assert.match(out.reason, /55%/);
  assert.match(out.reason, /30 points/);
  assert.match(out.reason, /9 of 20/);
});

test('agent rows fold the RPC result to one row per agent for the chosen window', () => {
  const rpc = [
    { agent_id: 'a', agent_name: 'Ann', is_self: true,  window_months: 13, cohort_count: 10, kept_count: 9, cohort_ap: 12000, kept_ap: 6000 },
    { agent_id: 'a', agent_name: 'Ann', is_self: true,  window_months: 25, cohort_count: 4,  kept_count: 2, cohort_ap: 4800,  kept_ap: 2400 },
    { agent_id: 'b', agent_name: 'Bob', is_self: false, window_months: 13, cohort_count: 10, kept_count: 5, cohort_ap: 12000, kept_ap: 6000 },
  ];
  const flat = P.persistAgentRows(rpc, 13, false);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].name, 'Bob', 'worst first');
  assert.equal(flat[0].rate, 50);
  assert.equal(flat[1].rate, 90);
  // Weighted uses the AP columns, so Ann drops from 90% to 50%.
  const weighted = P.persistAgentRows(rpc, 13, true);
  assert.equal(weighted.find(r => r.name === 'Ann').rate, 50);
});

test('an agent with no cohort has no rate and sorts last', () => {
  const rpc = [
    { agent_id: 'a', agent_name: 'Ann', window_months: 13, cohort_count: 0, kept_count: 0, cohort_ap: 0, kept_ap: 0 },
    { agent_id: 'b', agent_name: 'Bob', window_months: 13, cohort_count: 4, kept_count: 1, cohort_ap: 4800, kept_ap: 1200 },
  ];
  const rows = P.persistAgentRows(rpc, 13, false);
  assert.equal(rows[0].name, 'Bob');
  assert.equal(rows[1].rate, null);
  assert.equal(rows[1].band, null);
});

test('agent rows survive an empty or absent RPC result', () => {
  assert.deepEqual(P.persistAgentRows([], 13, false), []);
  assert.deepEqual(P.persistAgentRows(null, 13, false), []);
});

// ============================================================
// 2. STRUCTURE
// ============================================================

test('every core sentinel appears EXACTLY ONCE in app.html', () => {
  // The harness extracts each core with a lazy match from its opening
  // sentinel. A mention of one ABOVE its real block captures everything in
  // between, and the extracted code stops parsing — which is exactly what a
  // comment saying "delegates to the <persist-core> block" did.
  ['bob-core', 'comm-core', 'persist-core', 'backoffice-core', 'team-core', 'producer-codes-core']
    .forEach(name => {
      const opens = (APP.match(new RegExp(`// <${name}>`, 'g')) || []).length;
      const closes = (APP.match(new RegExp(`// </${name}>`, 'g')) || []).length;
      assert.equal(opens, 1, `// <${name}> must appear exactly once, found ${opens}`);
      assert.equal(closes, 1, `// </${name}> must appear exactly once, found ${closes}`);
    });
});

test('the persist-core block is pure — no DOM, network, storage or app globals', () => {
  const m = APP.match(/\/\/ <persist-core>([\s\S]*?)\/\/ <\/persist-core>/);
  const body = stripLineComments(m[1], ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/, /\bcurrentAgent\b/,
   /\bescHTML\(/, /\bshowToast\(/, /\bnav\(/, /_psCache/, /\bleads\b\s*\)/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
});

test('the browser and the SQL agree on what a COHORT is', () => {
  const m = /status not in \(([^)]*)\)/i.exec(SQL_CODE);
  assert.ok(m, 'the migration must exclude the never-issued statuses');
  const excluded = m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(excluded.slice().sort(), P.PERSIST_COHORT_EXCLUDED.slice().sort(),
    'a browser figure and a leader figure computed differently is the worst kind of disagreement');
});

test('the browser and the SQL agree on what KEPT is', () => {
  const m = /status in \('issued','paid','placed','claim'\)/i.exec(SQL_CODE);
  assert.ok(m, 'the migration must define kept as the same four statuses');
  assert.deepEqual(P.PERSIST_KEPT.slice().sort(), ['claim', 'issued', 'paid', 'placed']);
});

test('the SQL uses the same issueDate -> draft -> dateSubmitted fallback', () => {
  ['issueDate', 'draft', 'dateSubmitted'].forEach(f =>
    assert.ok(SQL_CODE.includes(`po.data->>'${f}'`), `${f} must be in the fallback chain`));
  // Regex-guarded before every cast, the lesson get_team_summary learned on AP.
  const guards = (SQL_CODE.match(/~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}'/g) || []).length;
  assert.ok(guards >= 3, `every date cast must be regex-guarded, found ${guards}`);
});

test('the four windows in the SQL are the four in the browser', () => {
  const m = /values (\([0-9]+\)(?:, ?\([0-9]+\))*)/i.exec(SQL_CODE);
  assert.ok(m, 'the migration must enumerate its windows');
  const months = m[1].match(/\d+/g).map(Number);
  assert.deepEqual(months, P.PERSIST_WINDOWS);
});

test('the persistency RPC takes no parameter naming an agent', () => {
  const m = /create or replace function public\.get_downline_persistency\(([^)]*)\)/i.exec(SQL_CODE);
  assert.ok(m);
  assert.ok(!/agent|leader|uid|user/i.test(m[1]),
    `no parameter may name an agent — got (${m[1].trim()})`);
});

test('the RPC is anchored on auth.uid() and an ACCEPTED invite', () => {
  assert.match(SQL_CODE, /ai\.leader_id\s*=\s*auth\.uid\(\)/);
  assert.match(SQL_CODE, /ai\.status\s*=\s*'accepted'/);
  assert.match(SQL_CODE, /security definer/i);
});

test('the RPC returns COUNTS — never a policy, a client or a carrier', () => {
  const ret = SQL_CODE.slice(SQL_CODE.indexOf('returns table ('), SQL_CODE.indexOf(')\nlanguage sql'));
  [/client/i, /insured/i, /policy_number/i, /carrier/i, /lead/i, /status/i]
    .forEach(re => assert.ok(!re.test(ret), `the RETURNS TABLE must not carry ${re}`));
  ['cohort_count', 'kept_count', 'cohort_ap', 'kept_ap', 'window_months'].forEach(c =>
    assert.ok(ret.includes(c), `${c} must be returned`));
});

test('the migration adds no table, no column and no data', () => {
  [/create table/i, /alter table/i, /\binsert into\b/i, /\bupdate\s+public\./i,
   /DROP\s+TABLE/i, /DROP\s+COLUMN/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /create policy/i]
    .forEach(re => assert.ok(!re.test(SQL_CODE), `${re} must not appear — this migration is one function`));
});

test('there is ONE definition of persistency in app.html', () => {
  // persistency13mo/25mo used to carry their own cohort logic and their own
  // IN_FORCE set. Both now delegate.
  assert.match(APP_CODE, /function persistency13mo[\s\S]{0,200}persistCohort\(pols, 13/);
  assert.match(APP_CODE, /function persistency25mo[\s\S]{0,200}persistCohort\(pols, 25/);
  assert.ok(!/_polsIssuedMonthsAgo/.test(APP_CODE),
    'the old issueDate-only cohort helper must not come back');
});

test('the legacy callers still get a 0-1 fraction, not a percentage', () => {
  // The Summary rings and the FFL bonus card multiply by 100 themselves.
  assert.match(APP_CODE, /function persistency13mo[\s\S]{0,300}r\.rate \/ 100/);
});

test('the Persistency area is registered like the others', () => {
  assert.match(APP, /data-boarea="persistency"/);
  assert.match(APP, /id="bopanel-persistency"/);
  // Subtitles and refresh handlers are looked up by key, not chained in ifs
  // that grow a branch per area.
  assert.match(APP_CODE, /const SUBTITLES = \{/);
  assert.match(APP_CODE, /const REFRESH = \{/);
});

test('the lead-source panel says how to populate it rather than showing nothing', () => {
  assert.match(APP_CODE, /Link policies to leads to populate/);
  assert.match(APP_CODE, /Submit as Sold/);
});

test('the band legend is on screen, not just in the colours', () => {
  assert.match(APP_CODE, /Green &ge;85% &middot; Yellow 70&ndash;84% &middot; Red &lt;70%/);
});

test('the agent view explains itself to a solo agent', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function psAgentHTML'));
  assert.match(fn.slice(0, 2200), /never as their client list/,
    'the privacy posture should be stated where a leader will read it');
});
