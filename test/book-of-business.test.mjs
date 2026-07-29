// ============================================================
// book-of-business.test.mjs — run with:  npm run test:bob
//
// Back Office Phase 3. Two kinds of test, the same split as
// test/back-office.test.mjs and test/team-roster.test.mjs.
//
//   1. BEHAVIOUR. The pure block between the // <bob-core> sentinels in
//      app.html is extracted and executed verbatim. app.html has no build step
//      and no module system, so a mirrored copy in a .mjs file would be a
//      second definition that drifts from the one that ships.
//
//   2. STRUCTURE. Assertions about app.html, the migration and the edge
//      function as source text. These are regression tests for the bug CLASSES
//      this phase is exposed to — a status list existing in two places and
//      drifting, an audit trail the client can rewrite or forge the provenance
//      of, a policy being silently auto-marked paid — not for any one number.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260741_book_of_business.sql'), 'utf8');
const PARSE_FN = readFileSync(join(ROOT, 'supabase/functions/statement-parse/index.ts'), 'utf8');
const CORE_TS = readFileSync(join(ROOT, 'supabase/functions/_shared/statement-core.ts'), 'utf8');

// Both files describe their own rules in comments; counting those as
// violations would make documenting a rule break it.
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
  'BOB_STATUSES', 'BOB_TABS', 'BOB_NOT_A_SALE', 'BOB_ENDED', 'BOB_PRODUCT_CATEGORIES',
  'bobTabFilterValue', 'bobTabForFilter', 'bobTabCounts', 'bobStatusLabel',
  'bobProductCategory', 'bobPresentOptions', 'bobTimeline', 'bobSourceLabel',
  'bobTimelineSentence',
];

function loadCore() {
  const m = APP.match(/\/\/ <bob-core>([\s\S]*?)\/\/ <\/bob-core>/);
  assert.ok(m, 'app.html must contain the // <bob-core> ... // </bob-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

const P = (status, extra = {}) => ({ id: 1, status, ...extra });

// ============================================================
// 1. BEHAVIOUR — the pure core
// ============================================================

test('the ten statuses are in lifecycle order and keep the original six keys', () => {
  assert.deepEqual(B.BOB_STATUSES.map(s => s.key), [
    'pending', 'approved', 'issued', 'paid',
    'denied', 'withdrawn', 'lapsed', 'surrendered', 'claim', 'chargeback',
  ]);
  // The first six are the keys already stored in policies.data.status for
  // every policy in production. Renaming one is a data migration, not a label
  // change, and nothing about this phase needed one.
  const original = ['pending', 'approved', 'issued', 'paid', 'lapsed', 'chargeback'];
  original.forEach(k => assert.ok(B.BOB_STATUSES.some(s => s.key === k), `${k} must survive`));
});

test('"Approved Not Paid" is the label an agent sees, not "Sub/Approved"', () => {
  assert.equal(B.bobStatusLabel('approved'), 'Approved Not Paid');
});

test('an unrecognised status is shown as-is rather than hidden', () => {
  assert.equal(B.bobStatusLabel('teleported'), 'teleported');
  assert.equal(B.bobStatusLabel(null), '—');
});

test('the tab strip is All plus nine, and Issued / Paid is the one compound tab', () => {
  assert.equal(B.BOB_TABS.length, 10);
  assert.equal(B.BOB_TABS[0].key, 'all');
  assert.equal(B.BOB_TABS[0].statuses, null);
  const compound = B.BOB_TABS.filter(t => t.statuses && t.statuses.length > 1);
  assert.equal(compound.length, 1);
  assert.deepEqual(compound[0].statuses, ['issued', 'paid']);
});

test('every status has exactly one tab, and every tab only names real statuses', () => {
  const keys = new Set(B.BOB_STATUSES.map(s => s.key));
  const covered = B.BOB_TABS.filter(t => t.statuses).flatMap(t => t.statuses);
  assert.deepEqual(covered.slice().sort(), [...keys].sort(),
    'a status with no tab is unreachable; a status on two tabs is double-counted');
});

test('a tab round-trips through its filter value', () => {
  B.BOB_TABS.forEach(t => {
    assert.equal(B.bobTabForFilter(B.bobTabFilterValue(t)), t.key);
  });
  assert.equal(B.bobTabFilterValue(B.BOB_TABS[0]), '');
  assert.equal(B.bobTabFilterValue({ statuses: ['issued', 'paid'] }), 'issued+paid');
});

test('the Summary "ended" drill-in lights up NO tab rather than falsely lighting All', () => {
  // All means "no status filter". Claiming it while six statuses are filtered
  // out would tell the agent the table is showing everything when it is not.
  assert.equal(B.bobTabForFilter(B.BOB_ENDED.join('+')), null);
  assert.equal(B.bobTabForFilter('lapsed+chargeback'), null);
  assert.equal(B.bobTabForFilter(''), 'all');
});

test('tab counts span the whole book, so clicking a tab never moves them', () => {
  const book = [P('pending'), P('paid'), P('paid'), P('issued'), P('chargeback')];
  const counts = B.bobTabCounts(book);
  assert.equal(counts.all, 5);
  assert.equal(counts.pending, 1);
  assert.equal(counts.issued_paid, 3, 'Issued / Paid must total both statuses');
  assert.equal(counts.chargeback, 1);
  assert.equal(counts.denied, 0);
  // Same input, same answer, whatever is selected — there is no filter argument.
  assert.deepEqual(B.bobTabCounts(book), counts);
});

test('tab counts survive an empty or absent book', () => {
  assert.equal(B.bobTabCounts([]).all, 0);
  assert.equal(B.bobTabCounts(null).all, 0);
  assert.equal(B.bobTabCounts([{}]).pending, 0, 'a policy with no status is in no status tab');
});

test('a policy that never became a sale is lapsed, chargeback, denied or withdrawn', () => {
  assert.deepEqual(B.BOB_NOT_A_SALE.slice().sort(),
    ['chargeback', 'denied', 'lapsed', 'withdrawn']);
  // Surrendered and claim describe business that WAS written. Excluding them
  // would erase real production from every AP figure in the app.
  assert.ok(!B.BOB_NOT_A_SALE.includes('surrendered'));
  assert.ok(!B.BOB_NOT_A_SALE.includes('claim'));
});

test('BOB_ENDED is exactly the statuses that are not in force', () => {
  const active = ['pending', 'approved', 'issued', 'paid'];
  const expected = B.BOB_STATUSES.map(s => s.key).filter(k => !active.includes(k));
  assert.deepEqual(B.BOB_ENDED.slice().sort(), expected.sort());
});

test('Final Expense and Annuity are recognised only when the data says so', () => {
  assert.equal(B.bobProductCategory('Final Expense Whole Life', 'Whole Life'), 'Final Expense');
  assert.equal(B.bobProductCategory('FEX', 'Whole Life'), 'Final Expense');
  assert.equal(B.bobProductCategory('Fixed Annuity', 'Whole Life'), 'Annuity');
  assert.equal(B.bobProductCategory('MYGA 5', ''), 'Annuity');
});

test('a COMP key is NEVER re-classified as Final Expense behind the agent’s back', () => {
  // mutual_fe / ahl_fe / aflac_final_ex are whole-life final-expense products,
  // but the Add Policy dropdown recorded them as "Whole Life" and that is what
  // the agent chose. Moving them would change counts they recognise.
  ['mutual_fe', 'ahl_fe', 'aflac_final_ex', 'sbli_fex', 'lb_fx', 'insta_fe_wl'].forEach(k => {
    assert.equal(B.bobProductCategory(k, 'Whole Life'), 'Whole Life', `${k} must stay Whole Life`);
  });
});

test('the product category otherwise falls back to the display label', () => {
  assert.equal(B.bobProductCategory('Term', 'Term'), 'Term');
  assert.equal(B.bobProductCategory('trans_ffiul', 'IUL'), 'IUL');
  assert.equal(B.bobProductCategory('', ''), 'Other');
  assert.equal(B.bobProductCategory(null, null), 'Other');
});

test('filter options come from the book, deduped, sorted, blanks dropped', () => {
  const book = [P('paid', { carrier: 'Americo' }), P('paid', { carrier: 'Aetna / Accendo' }),
    P('paid', { carrier: 'Americo' }), P('paid', { carrier: '' }), P('paid', {})];
  assert.deepEqual(B.bobPresentOptions(book, p => p.carrier), ['Aetna / Accendo', 'Americo']);
  assert.deepEqual(B.bobPresentOptions([], p => p.carrier), []);
  assert.deepEqual(B.bobPresentOptions(null, p => p.carrier), []);
});

test('the timeline merges both sources, newest first', () => {
  const entries = B.bobTimeline(
    [
      { changed_at: '2026-03-01T00:00:00Z', old_status: null, new_status: 'pending', source: 'migration' },
      { changed_at: '2026-05-01T00:00:00Z', old_status: 'approved', new_status: 'paid', source: 'statement', source_detail: 'A commission payment' },
    ],
    [{ created_at: '2026-04-01T00:00:00Z', old_status: 'pending', new_status: 'approved', summary: 'Carrier approved it' }],
    P('paid'),
  );
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.to), ['paid', 'approved', 'pending']);
  assert.equal(entries[1].source, 'carrier_email', 'a policy_events row is a carrier email');
  assert.ok(entries.every(e => e.synthetic === false));
});

test('an undated entry sorts LAST, not to the top where it would look newest', () => {
  const entries = B.bobTimeline([
    { changed_at: null, new_status: 'paid', source: 'manual' },
    { changed_at: '2026-05-01T00:00:00Z', new_status: 'approved', source: 'manual' },
  ], [], null);
  assert.equal(entries[0].to, 'approved');
  assert.equal(entries[1].to, 'paid');
});

test('a policy with no rows anywhere still gets a dated genesis entry', () => {
  const entries = B.bobTimeline([], [], { status: 'approved', dateSubmitted: '2026-06-01' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].to, 'approved');
  assert.equal(entries[0].from, null);
  assert.equal(entries[0].synthetic, true, 'derived, so a future writer knows not to trust it as evidence');
  assert.match(entries[0].at, /^2026-06-01/);
});

test('the genesis fallback never fires when real rows exist', () => {
  const entries = B.bobTimeline(
    [{ changed_at: '2026-05-01T00:00:00Z', new_status: 'paid', source: 'manual' }], [],
    { status: 'approved', dateSubmitted: '2026-06-01' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].synthetic, false);
});

test('with nothing at all, the timeline is empty rather than invented', () => {
  assert.deepEqual(B.bobTimeline([], [], null), []);
  assert.deepEqual(B.bobTimeline(null, null, null), []);
});

test('every source has a plain-English label — that is the point of storing it', () => {
  assert.equal(B.bobSourceLabel('manual'), 'Manual edit');
  assert.equal(B.bobSourceLabel('system'), 'Automatic');
  assert.equal(B.bobSourceLabel('statement'), 'Commission statement');
  assert.equal(B.bobSourceLabel('carrier_email'), 'Carrier email');
  assert.equal(B.bobSourceLabel('migration'), 'Existing status');
  // Every value the check constraint allows must have a label, or an entry
  // renders as a raw column value on screen.
  const allowed = /new_status in \(([^)]*)\)/i;
  assert.ok(allowed.test(SQL_CODE));
});

test('a timeline entry reads as a sentence, including the two edge shapes', () => {
  assert.equal(B.bobTimelineSentence({ from: null, to: 'pending' }), 'Recorded as Pending');
  assert.equal(B.bobTimelineSentence({ from: 'approved', to: 'paid' }), 'Approved Not Paid → Paid');
  assert.equal(B.bobTimelineSentence({ from: 'paid', to: null }), 'Noted, with no status change');
  assert.equal(B.bobTimelineSentence(null), '');
});

// ============================================================
// 2. STRUCTURE — the bug classes, asserted against source text
// ============================================================

test('the bob-core block is pure — no DOM, network, storage or app globals', () => {
  const m = APP.match(/\/\/ <bob-core>([\s\S]*?)\/\/ <\/bob-core>/);
  const body = stripLineComments(m[1], ['//', '*', '/*']);
  // `policies` appears as a PARAMETER name in bobTabCounts/bobPresentOptions,
  // which shadows the app global rather than reaching for it — that is the
  // point of taking it as an argument, so it is not listed here.
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/, /\bcurrentAgent\b/,
   /\bescHTML\(/, /\bgetProductDisplayLabel\(/, /\bshowToast\(/, /\bicon\(/]
    .forEach(re => assert.ok(!re.test(body),
      `${re} must not appear in the extracted core — the tests would stop running the shipped code`));
});

test('the ten statuses in app.html are exactly the ten the database will accept', () => {
  const m = /new_status in \(([^)]*)\)/i.exec(SQL_CODE);
  assert.ok(m, 'the migration must constrain new_status');
  const allowed = m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(allowed.slice().sort(), B.BOB_STATUSES.map(s => s.key).sort(),
    'a status the UI offers and the database refuses is a save that fails at the last step');
});

test('the app and get_team_summary agree on what is not a sale', () => {
  // The predicate lives in whichever migration most recently defined the
  // function, so this resolves it rather than naming a file that will go stale.
  const dir = join(ROOT, 'supabase/migrations');
  const owner = readdirSync(dir).sort().reverse()
    .find(f => /create or replace function public\.get_team_summary/i
      .test(readFileSync(join(dir, f), 'utf8')));
  assert.ok(owner, 'some migration must define get_team_summary');
  const sql = readFileSync(join(dir, owner), 'utf8');
  // Anchored on the status expression: the same file also contains the guard's
  // `not in ('manual','system')`, and a bare /NOT IN/ finds that one first.
  const m = /data->>'status','?'?\)\s*NOT IN \(([^)]*)\)/i.exec(sql);
  assert.ok(m, `${owner} must carry the sale predicate`);
  const excluded = m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(excluded.slice().sort(), B.BOB_NOT_A_SALE.slice().sort(),
    'the Summary and the Agency tab would otherwise disagree about team AP');
});

test('there is ONE status list in app.html — the tracker derives from it', () => {
  assert.match(APP_CODE, /const PT_STATUS_ORDER\s*=\s*BOB_STATUSES\.map/);
  assert.match(APP_CODE, /const PT_STATUS_LABELS\s*=\s*BOB_STATUSES\.reduce/);
  // The literal array is what used to drift. It must not come back.
  assert.ok(!/PT_STATUS_ORDER\s*=\s*\[\s*'pending'/.test(APP_CODE),
    'PT_STATUS_ORDER must not be re-written as a literal beside BOB_STATUSES');
});

test('the Add and Edit status dropdowns are generated, not hand-written', () => {
  // They had already drifted before this phase: Add offered five statuses and
  // Edit six, so a policy could hold a status one modal could not display.
  assert.match(APP_CODE, /function bobFillStatusSelect/);
  assert.match(APP_CODE, /bobFillStatusSelect\('p-status'/);
  assert.match(APP_CODE, /bobFillStatusSelect\('ep-status'/);
  assert.match(APP, /<select id="p-status"><\/select>/);
  assert.match(APP, /<select id="ep-status"><\/select>/);
});

test('the status dropdown is gone and nothing still reads it', () => {
  assert.ok(!/id="ptf-status"/.test(APP), 'the tab strip replaced it — two controls for one filter drift');
  assert.ok(!/getElementById\('ptf-status'\)/.test(APP_CODE));
  assert.match(APP, /id="pt-status-tabs"/);
});

test('a Summary drill-in still reaches the tracker now that the dropdown is gone', () => {
  // summaryDrillTo used to set #ptf-status and let applyTrackerFilters read it
  // back. applyTrackerFilters deliberately no longer reads status, so the
  // assignment has to be onto ptFilter directly or every drill-in silently
  // stops filtering.
  const fn = APP_CODE.slice(APP_CODE.indexOf('function summaryDrillTo'));
  assert.match(fn.slice(0, 2000), /ptFilter\.status\s*=\s*opts\.status/);
});

test('the draft-date auto-advance cannot mark an ENDED policy paid', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function autoSetPaidOnDraftDate'));
  const body = fn.slice(0, 900);
  assert.match(body, /excluded\s*=\s*new Set\(\['paid'\]\.concat\(BOB_ENDED\)\)/,
    'the exclusion must derive from BOB_ENDED — a hand-written pair is what missed the four new statuses');
});

test('the Summary status bar folds every ended status, so its percentages still total 100', () => {
  assert.match(APP_CODE, /BOB_ENDED\.includes\(p\.status\)\?'lapsed':p\.status/);
  assert.match(APP_CODE, /const NOT_SOLD = new Set\(BOB_NOT_A_SALE\)/);
});

test('the browser can only ever claim manual or system provenance', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function bobRecordStatusChange'));
  const body = fn.slice(0, 1200);
  assert.match(body, /source:\s*source === 'system' \? 'system' : 'manual'/,
    'a client that could send source=statement could fake a carrier saying something');
  assert.ok(!/'carrier_email'/.test(body));
});

test('the database refuses a forged provenance regardless of what the client sends', () => {
  assert.match(SQL_CODE, /auth\.role\(\)[\s\S]{0,120}authenticated/);
  assert.match(SQL_CODE, /not in \('manual', 'system'\)/);
  assert.match(SQL_CODE, /new\.agent_id\s*:=\s*auth\.uid\(\)/);
});

test('the status trail is APPEND-ONLY — no UPDATE or DELETE policy exists', () => {
  const policies = [...SQL_CODE.matchAll(/create policy\s+(\S+)\s+on public\.policy_status_history\s+for\s+(\w+)/gi)]
    .map(m => m[2].toLowerCase());
  assert.deepEqual(policies.slice().sort(), ['insert', 'select'],
    'something that can rewrite history is not a trail');
});

test('the migration is additive and touches neither auth.* nor storage.*', () => {
  [/DROP\s+COLUMN/i, /DROP\s+TABLE/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /DROP\s+FUNCTION/i]
    .forEach(re => assert.ok(!re.test(SQL_CODE), `${re} must not appear in an additive migration`));
  assert.ok(!/\b(auth|storage)\.\w+\s+(SET|DROP|ADD)/i.test(SQL_CODE));
  // The backfill must be re-runnable, or a second apply doubles every timeline.
  assert.match(SQL_CODE, /not exists \(\s*select 1 from public\.policy_status_history/i);
});

test('the backfill dates a genesis entry from the policy, not from the apply', () => {
  assert.match(SQL_CODE, /left\(po\.data->>'dateSubmitted', 10\)/);
  // Regex-guarded before the cast, the same lesson get_team_summary learned
  // about AP: one malformed value would abort the whole apply rather than
  // mis-date one row.
  ['dateSubmitted', 'draft'].forEach(f => {
    const re = new RegExp(`coalesce\\(po\\.data->>'${f}',''\\) ~ '\\^`);
    assert.match(SQL_CODE, re, `${f} must be regex-guarded before the timestamptz cast`);
  });
});

test('a date-derived entry is stamped at NOON, not midnight', () => {
  // changed_at is a timestamptz and the browser renders it in the reader's
  // LOCAL zone. A calendar date the agent typed casts to midnight UTC, which
  // renders as the PREVIOUS day for every agent west of UTC — on every policy
  // they own, silently. Noon is correct from UTC-11 to UTC+11.
  //
  // Both writers of a date-derived entry must agree on this:
  assert.match(SQL_CODE, /\+ interval '12 hours'/,
    'the migration backfill must stamp noon');
  assert.match(APP_CODE, /d \+ 'T12:00:00Z'/,
    'bobRecordPolicyCreated must stamp noon');
  // …and the migration must repair rows an earlier run of itself left at
  // midnight, or the fix only helps databases that had not applied it yet.
  assert.match(SQL_CODE, /update public\.policy_status_history[\s\S]{0,400}date_trunc\('day', h\.changed_at\)/i);
});

test('statement ingestion records WHY before it changes anything', () => {
  const applyBlock = PARSE_FN.slice(PARSE_FN.indexOf('planStatementStatusChanges('));
  const histAt = applyBlock.indexOf('policy_status_history');
  const updAt = applyBlock.indexOf('.from("policies")');
  assert.ok(histAt > -1 && updAt > -1, 'both writes must be present');
  assert.ok(histAt < updAt,
    'the history row is written first: an unexplained status change is worse than a recorded one that failed to apply');
  assert.match(applyBlock.slice(0, 2000), /source: "statement"/);
  assert.match(applyBlock.slice(0, 2000), /source_ref_id: st\.id/);
});

test('a status write-back failure never fails the ingestion', () => {
  const applyBlock = PARSE_FN.slice(PARSE_FN.indexOf('let statusChanges = 0;'), PARSE_FN.indexOf('const matched ='));
  assert.match(applyBlock, /try \{/);
  assert.match(applyBlock, /catch \(e\)/);
  assert.ok(!/throw /.test(applyBlock), 'the commission rows are already saved and are the primary product');
});

test('a statement is authoritative about paid and chargeback, and nothing else', () => {
  assert.match(CORE_TS, /STATEMENT_AUTHORITATIVE_STATUSES\s*=\s*\["paid", "chargeback"\]/);
  // A lapse must never be inferred from a debit; the reasoning is recorded in
  // the module so a future change has to argue with it rather than miss it.
  assert.match(CORE_TS, /NOT inferred: a LAPSE/);
});

test('the agent filter is gated and says why, rather than shipping a filter that lies', () => {
  assert.match(APP_CODE, /function renderTrackerAgentGate/);
  assert.match(APP, /id="pt-agent-gate"/);
  const fn = APP_CODE.slice(APP_CODE.indexOf('function renderTrackerAgentGate'));
  assert.match(fn.slice(0, 1500), /team hierarchy/i);
  // It must not attempt to query another agent's policies to populate itself.
  assert.ok(!/from\('policies'\)[\s\S]{0,200}neq\('agent_id'/.test(fn.slice(0, 1500)));
});

test('carrier and product filters are built from the book, not from a master list', () => {
  const carrier = APP_CODE.slice(APP_CODE.indexOf('function populateTrackerCarrierFilter'));
  assert.match(carrier.slice(0, 800), /bobPresentOptions\(policies/);
  assert.ok(!/TRACKER_CARRIER_LIST/.test(carrier.slice(0, 800)),
    'a filter offering 24 carriers to an agent appointed with three is 21 options that return nothing');
  const product = APP_CODE.slice(APP_CODE.indexOf('function populateTrackerProductFilter'));
  assert.match(product.slice(0, 800), /bobPresentOptions\(policies/);
});
