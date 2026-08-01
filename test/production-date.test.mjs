// ============================================================
// production-date.test.mjs — run with:  npm run test:productiondate
//
// ONE ANSWER TO "WHAT MONTH DOES THIS POLICY BELONG TO" (office split, FO5).
//
// The app had FOUR answers. Three were the same chain written out by hand
// three times — _lgSubDate (Ledger Summary), _ptSubForRange (Policy Tracker
// period drill-in), and an inline slice in _lbCurrentTotals (record nudges).
// The fourth was the Back Office Summary's bosPolicyDay(), which bucketed on
// `p.draft` alone, so a policy submitted in March that drafts in April was
// March production in the Front Office and April production in the Back
// Office — the same policy, two months, one sidebar toggle apart.
//
// ppProductionDate() in the team-core block is now the only one. This file
// holds three kinds of assertion:
//
//   1. BEHAVIOUR of the resolver itself — the four branches, executed.
//   2. EQUIVALENCE. The pre-change source of _lgSubDate and _ptSubForRange is
//      frozen below and run against the new resolver on the same fixtures. The
//      Front Office and the Policy Tracker must not have moved a single
//      policy; this is what proves it rather than asserting it.
//   3. NO FOURTH COPY, against app.html as source text. This is the bug class:
//      a hand-written date chain that drifts from the others. Every remaining
//      `dateSubmitted` line in the file is classified, so a new one has to be
//      classified too rather than quietly becoming answer number five.
//
// Plus the one place behaviour DID change, asserted directly: the Back Office
// Summary now counts a policy in its submitted month.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');

function block(name) {
  const m = APP.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`));
  assert.ok(m, `app.html must contain the // <${name}> ... // </${name}> block`);
  return m[1];
}

/** Lift a top-level `function NAME(...) {...}` out of app.html by brace matching. */
function topLevelFn(name) {
  const at = APP.indexOf(`\nfunction ${name}(`);
  assert.ok(at > -1, `app.html must define function ${name}()`);
  const open = APP.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}') { depth--; if (depth === 0) return APP.slice(at + 1, i + 1); }
  }
  assert.fail(`could not brace-match ${name}()`);
}

// The SHIPPED resolver, plus everything the Back Office Summary needs to place
// a policy in a window. Lifted from app.html, never re-typed here.
const EXPORTS = [
  'ppProductionDate',
  'bosPolicyDay', 'bosDay', 'bosIso', 'bosInRange', 'bosIsIssued',
  'bosIssuedPolicies', 'bosIssuedAP', 'bosIssuedCount', 'bosCarrierMix',
  'bosChartSpec', 'bosChartSeries', 'BOS_ISSUED_STATUSES',
  'summaryPeriodRange', 'ppParsePeriodKey', 'ppDay', 'ppIsDynamicPeriod',
  'ppDynamicRange', 'ppPeriodLabel',
];

function loadCore() {
  const src = [
    block('comm-core'), block('persist-core'), block('recon-core'),
    block('bo-summary-core'), block('bos-chart-core'),
    topLevelFn('ppProductionDate'),
    topLevelFn('ppParsePeriodKey'), topLevelFn('ppDay'), topLevelFn('ppIsDynamicPeriod'),
    topLevelFn('ppDynamicRange'), topLevelFn('ppPeriodLabel'), topLevelFn('summaryPeriodRange'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

// ------------------------------------------------------------
// The three copies as they were, frozen at their pre-FO5 source.
//
// These are DELIBERATELY hand-copied — they are the OLD code, and their whole
// job is to be a fixed reference the new resolver is measured against. They
// must never be "kept in sync" with anything; if app.html changes and these
// stop agreeing, that is the test doing its job.
// ------------------------------------------------------------
const OLD_lgSubDate = p =>
  p && (p.dateSubmitted || p.draft || (p.id ? new Date(+p.id).toISOString().slice(0, 10) : null));

const OLD_ptSubForRange = p =>
  (p && (p.dateSubmitted || p.draft || (p.id ? new Date(+p.id).toISOString().slice(0, 10) : ''))) || '';

// A millisecond id whose UTC day is unambiguous (midday UTC, so no timezone a
// test runner might be in can slide it onto the neighbouring date).
const ID_2026_05_20 = Date.UTC(2026, 4, 20, 12, 0, 0);

const UNBOUNDED = { start: null, end: null };

// ============================================================
// 1. The resolver itself — one assertion per branch
// ============================================================

test('branch 1: dateSubmitted wins when it is there', () => {
  assert.equal(
    B.ppProductionDate({ id: ID_2026_05_20, dateSubmitted: '2026-03-28', draft: '2026-04-03' }),
    '2026-03-28',
    'submitted first — that is when the agent did the work');
});

test('branch 2: falls back to draft', () => {
  assert.equal(
    B.ppProductionDate({ id: ID_2026_05_20, draft: '2026-04-03' }),
    '2026-04-03');
  // An EMPTY dateSubmitted falls through too. The Edit Policy modal writes ''
  // when the field is cleared (app.html: `.value || p.dateSubmitted || ''`),
  // so this is a real stored shape and not a hypothetical.
  assert.equal(
    B.ppProductionDate({ id: ID_2026_05_20, dateSubmitted: '', draft: '2026-04-03' }),
    '2026-04-03');
});

test('branch 3: falls back to the id timestamp', () => {
  assert.equal(B.ppProductionDate({ id: ID_2026_05_20 }), '2026-05-20');
  // `id` is a Date.now() millisecond stamp, not a calendar date anybody typed,
  // so it is sliced in UTC — exactly as all three copies did.
  assert.equal(B.ppProductionDate({ id: ID_2026_05_20, dateSubmitted: '', draft: '' }), '2026-05-20');
});

test('branch 4: a policy with none of the three is on no timeline', () => {
  assert.equal(B.ppProductionDate({ status: 'issued', ap: 500 }), null);
  assert.equal(B.ppProductionDate({}), null);
  assert.equal(B.ppProductionDate(null), null);
  assert.equal(B.ppProductionDate(undefined), null);
});

test('a junk id yields null instead of taking a whole screen down with it', () => {
  // `new Date(NaN).toISOString()` is a RangeError, and all three copies would
  // have thrown it from inside a .filter() — i.e. the Ledger Summary would
  // have rendered nothing at all rather than one policy wrong. This is the one
  // respect in which the resolver is deliberately NOT byte-equivalent to them.
  assert.equal(B.ppProductionDate({ id: 'not-a-number', status: 'issued' }), null);
  assert.throws(() => OLD_lgSubDate({ id: 'not-a-number' }), RangeError,
    'the old copy threw here — that is what was fixed');
});

// ============================================================
// 2. Equivalence — the Front Office and the tracker did NOT move
// ============================================================

// Every branch, every combination that reaches a different line of the chain,
// including the ones where two fields disagree about the month.
const EQUIV_FIXTURES = [
  { id: ID_2026_05_20, dateSubmitted: '2026-03-28', draft: '2026-04-03' }, // both, months differ
  { id: ID_2026_05_20, dateSubmitted: '2026-04-03', draft: '2026-04-03' }, // both, agree
  { id: ID_2026_05_20, dateSubmitted: '2026-03-28' },                      // submitted only
  { id: ID_2026_05_20, draft: '2026-04-03' },                              // draft only
  { id: ID_2026_05_20 },                                                   // id only
  { id: ID_2026_05_20, dateSubmitted: '', draft: '' },                     // blanks fall through
  { id: 0, dateSubmitted: '2026-03-28' },                                  // falsy id, submitted
  { dateSubmitted: '2026-03-28', draft: '2026-04-03' },                    // no id
  { draft: '2026-04-03' },                                                 // no id, draft only
  {},                                                                      // nothing at all
];

test('🔴 EQUIVALENCE: the Ledger Summary resolves every fixture exactly as it did before', () => {
  for (const p of EQUIV_FIXTURES) {
    assert.equal(
      B.ppProductionDate(p), OLD_lgSubDate(p),
      `_lgSubDate moved for ${JSON.stringify(p)} — the Front Office Summary just changed`);
  }
});

test('🔴 EQUIVALENCE: the Policy Tracker drill-in resolves every fixture exactly as it did before', () => {
  // _ptSubForRange keeps its own `|| ''` at the call site, because the
  // tracker's range filter string-compares and wants '' rather than null.
  for (const p of EQUIV_FIXTURES) {
    assert.equal(
      (B.ppProductionDate(p) || ''), OLD_ptSubForRange(p),
      `_ptSubForRange moved for ${JSON.stringify(p)} — a period drill-in just changed`);
  }
});

test('both aliases are one line of delegation, not a second copy of the chain', () => {
  const lg = /function _lgSubDate\(p\)\{ return ([^;]+); \}/.exec(APP);
  assert.ok(lg, 'app.html must still define _lgSubDate');
  assert.equal(lg[1].trim(), 'ppProductionDate(p)');

  const pt = /function _ptSubForRange\(p\)\{ return ([^;]+); \}/.exec(APP);
  assert.ok(pt, 'app.html must still define _ptSubForRange');
  assert.equal(pt[1].trim(), "ppProductionDate(p) || ''");
});

// ============================================================
// 3. No fourth copy
// ============================================================

/**
 * Every line of app.html CODE (comments stripped) that mentions `dateSubmitted`,
 * classified. A line matching none of these is either a new copy of the chain
 * or a new question nobody has thought about — both need a human.
 */
const CLASSIFIED = [
  // The resolver itself.
  { why: 'the one resolver', re: /if \(p\.dateSubmitted\) return p\.dateSubmitted;/ },
  // DOM plumbing for the Add / Edit Policy modals — element ids, not a chain.
  { why: 'Add/Edit Policy form field', re: /['"#]e?p-dateSubmitted['"\)]/ },
  { why: 'Add/Edit Policy form field', re: /getElementById\('e?p-dateSubmitted'\)/ },
  // The policy object literal built on save.
  { why: 'the saved policy shape', re: /\bcov,\s*dateSubmitted,\s*draft\b/ },
  { why: 'the value read off the modal', re: /const dateSubmitted = document\.getElementById/ },
  // The tracker's Submitted COLUMN — a display field, no draft fallback, and
  // documented as deliberately not the production date.
  { why: '_ptGetSub — the Submitted column, deliberately not the chain',
    re: /function _ptGetSub\(p\)\{ return p\.dateSubmitted \|\| \(p\.id \?/ },
  // Two audit stamps. Both are `dateSubmitted || draft` with NO id fallback and
  // a null-means-unknown contract, because they date an entry in an
  // append-only trail rather than bucket a policy into a period. Giving them
  // the id fallback would have an audit row claim a date it does not have.
  { why: 'timeline genesis entry (no id fallback, null means unknown)',
    re: /const at = policy\.dateSubmitted \|\| policy\.draft \|\| null;/ },
  { why: 'policy_status_history genesis stamp (no id fallback)',
    re: /const d = policy && \(policy\.dateSubmitted \|\| policy\.draft\);/ },
  // The persistency COHORT date — issueDate first, a different question, and
  // CLAUDE.md records the chain as a deliberate bug fix of its own.
  { why: 'persist-core cohort date (issueDate first — a different question)',
    re: /pick\(p\.issueDate\) \|\| pick\(p\.draft\) \|\| pick\(p\.dateSubmitted\)/ },
];

test('🔴 NO FOURTH COPY: every dateSubmitted line in app.html is classified', () => {
  const lines = stripLineComments(APP, ['//', '*', '/*'])
    .split('\n')
    .map((text, i) => ({ text, n: i + 1 }))
    .filter(l => l.text.includes('dateSubmitted'));

  assert.ok(lines.length > 0, 'the sweep found nothing — it has stopped working');

  const unclassified = lines.filter(l => !CLASSIFIED.some(c => c.re.test(l.text)));
  assert.deepEqual(unclassified.map(l => `${l.n}: ${l.text.trim()}`), [],
    'An unclassified `dateSubmitted` appeared in app.html.\n' +
    'If it resolves a policy to a PRODUCTION DATE, it is a fourth copy of a chain\n' +
    'that already had three (_lgSubDate, _ptSubForRange, and an inline slice in\n' +
    '_lbCurrentTotals) and drifted into placing one policy in two different months\n' +
    'on two screens. Call ppProductionDate() instead.\n' +
    'If it genuinely answers a DIFFERENT question, add it to CLASSIFIED with the\n' +
    'reason — that is the whole point of this list.');
});

test('🔴 NO FOURTH COPY: the three-step chain is written out exactly once', () => {
  // The literal shape that was duplicated: dateSubmitted, then draft, then a
  // date built from the id. Comments are stripped so documenting the rule
  // cannot break it.
  const code = stripLineComments(APP, ['//', '*', '/*']);
  const chain = /dateSubmitted[\s\S]{0,80}?\|\|[\s\S]{0,40}?draft[\s\S]{0,80}?\|\|[\s\S]{0,80}?new Date\(\+p\.id\)/g;
  const hits = code.match(chain) || [];
  assert.equal(hits.length, 0,
    'The three-step production-date chain was found written out by hand:\n' +
    hits.join('\n---\n') + '\n' +
    'There is one resolver — ppProductionDate() in the team-core block — and\n' +
    '_lgSubDate / _ptSubForRange are one-line aliases over it. A fourth copy is\n' +
    'how the Back Office Summary and the Ledger Summary came to disagree.');
});

test('the record nudges go through the resolver, and keep their own slice', () => {
  // The slice belongs at the CALL SITE: _lbCurrentTotals compares against
  // iso() day strings, so it needs YYYY-MM-DD specifically. The resolver
  // returns whatever the policy stored.
  const fn = topLevelFn('_lbCurrentTotals');
  assert.match(fn, /ppProductionDate\(p\)/,
    'the inline (p.dateSubmitted || p.draft || "") copy must be gone');
  assert.match(fn, /\.slice\(0, 10\)/, 'the slice stays here, not in the resolver');
  assert.ok(!/p\.dateSubmitted/.test(fn), 'and no field chain of its own');
});

test('the resolver is in a pure core block, so these tests run the shipped code', () => {
  const core = block('team-core');
  assert.match(core, /function ppProductionDate\(p\) \{/,
    'ppProductionDate must live inside // <team-core> — a resolver the tests ' +
    'cannot execute is a resolver the tests cannot pin');
  const body = stripLineComments(topLevelFn('ppProductionDate'), ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/, /\bpolicies\b/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the resolver`));
});

// ============================================================
// 4. The Back Office moved — the assertion this round exists for
// ============================================================

// Submitted in March, drafts in April. Before FO5 this policy was April
// production in the Back Office and March production in the Front Office.
const STRADDLER = {
  id: ID_2026_05_20, client: 'C', carrier: 'Americo', ap: 3000, commPct: 100,
  status: 'issued', dateSubmitted: '2026-03-28', draft: '2026-04-03',
};
const MARCH = { start: new Date(2026, 2, 1), end: new Date(2026, 3, 1) };
const APRIL = { start: new Date(2026, 3, 1), end: new Date(2026, 4, 1) };

test('🔴 THE BACK OFFICE MOVED: a straddling policy counts in its SUBMITTED month', () => {
  assert.equal(B.bosIssuedAP([STRADDLER], MARCH), 3000,
    'the Back Office Summary must count this policy in March, where it was sold');
  assert.equal(B.bosIssuedAP([STRADDLER], APRIL), 0,
    'and NOT in April, which is only when the premium drafts');

  assert.equal(B.bosIssuedCount([STRADDLER], MARCH), 1);
  assert.equal(B.bosIssuedCount([STRADDLER], APRIL), 0);

  // bosPolicyDay is the single seam all of that runs through.
  assert.equal(B.bosPolicyDay(STRADDLER), '2026-03-28');
});

test('the Back Office and the Front Office now place the same policy in the same month', () => {
  // The Front Office's own resolver, unchanged in behaviour by this round —
  // proved above by the equivalence fixtures, and re-stated here on the exact
  // policy that used to disagree.
  assert.equal(B.bosPolicyDay(STRADDLER), OLD_lgSubDate(STRADDLER));
});

test('the cards, the carrier mix and the chart all read the one resolver', () => {
  // They must not merely agree by coincidence — they must agree because there
  // is one seam. Same window, same straddling policy, three surfaces.
  const mixMar = B.bosCarrierMix([STRADDLER], MARCH);
  assert.equal(mixMar.total, 3000);
  assert.equal(mixMar.rows.length, 1);
  assert.equal(B.bosCarrierMix([STRADDLER], APRIL).total, 0);

  const specMar = B.bosChartSpec('month:2026-03', MARCH, new Date(2026, 4, 20), [STRADDLER]);
  const serMar = B.bosChartSeries([STRADDLER], specMar);
  assert.equal(serMar.total, B.bosIssuedAP([STRADDLER], MARCH),
    'the chart total is the card — one resolver, one window');
  assert.equal(serMar.points[serMar.points.length - 1].cumulative, 3000,
    'and the cumulative series still ends on the card figure');
  // The money lands in the bucket for the SUBMITTED day, not the draft day.
  const mar28 = serMar.points.find(pt => pt.iso === '2026-03-28');
  assert.ok(mar28 && mar28.value === 3000, 'the bar is on Mar 28, where it was sold');

  const serApr = B.bosChartSeries([STRADDLER],
    B.bosChartSpec('month:2026-04', APRIL, new Date(2026, 4, 20), [STRADDLER]));
  assert.equal(serApr.total, 0);
});

test('a policy whose two dates agree did not move at all', () => {
  // The overwhelming majority of the production book. If this moves, the round
  // did something much bigger than it was meant to.
  const settled = { ...STRADDLER, dateSubmitted: '2026-04-03', draft: '2026-04-03' };
  assert.equal(B.bosIssuedAP([settled], MARCH), 0);
  assert.equal(B.bosIssuedAP([settled], APRIL), 3000);
});

test('the issued-status definition was NOT touched by the date change', () => {
  // FO5 is about WHEN a policy counts. WHAT counts is a separate, deliberate
  // question and the gap against the Top Producers board stays explained
  // rather than reconciled.
  assert.deepEqual(B.BOS_ISSUED_STATUSES, ['issued', 'paid']);
  const pending = { ...STRADDLER, status: 'pending' };
  assert.equal(B.bosIssuedAP([pending], MARCH), 0,
    'a pending application is still not issued AP — it just now has the right month');
  assert.equal(B.bosIssuedAP([{ ...STRADDLER, status: 'lapsed' }], UNBOUNDED), 0);
});
