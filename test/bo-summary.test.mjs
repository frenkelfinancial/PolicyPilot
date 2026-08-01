// ============================================================
// bo-summary.test.mjs — run with:  npm run test:bosummary
//
// The Back Office's own Summary (office split, Round 2). Same two halves as
// test/back-office.test.mjs:
//
//   1. BEHAVIOUR. The pure block between the // <bo-summary-core> sentinels is
//      extracted from app.html and executed verbatim, together with the two
//      blocks it declares a dependency on — // <comm-core> (commTotals,
//      commDebtRanked, COMM_CARD_DEFS) and // <persist-core> (persistBand,
//      persistBandLabel, persistWindowLabel). app.html has no build step and
//      no module system, so a mirrored copy here would be a second definition
//      that drifts from the one that ships.
//
//   2. STRUCTURE. Assertions about app.html as source text. These are the
//      regression tests for the bug CLASSES this screen is exposed to:
//
//        * a debt figure that moves when somebody clicks a range chip;
//        * an empty cohort rendered as 0% — a red band on an agent who has
//          simply not been writing long enough;
//        * three zero queues with no sentence, which reads as broken rather
//          than clean;
//        * a permanently empty Override card, or a greyed-out team strip, on
//          the screen an owner sees every single day;
//        * a second get_team_summary call site, or a browser-side SELECT on
//          commission_rows, sneaking in behind a new dashboard.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const COMMISSIONS_DOC = readFileSync(join(ROOT, 'docs/back-office-commissions.md'), 'utf8');

// Both this file and app.html describe their own rules in comments; counting
// those as violations would make documenting a rule break it.
const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);

// ------------------------------------------------------------
// Load the shipped core (plus its two declared dependencies)
// ------------------------------------------------------------
const EXPORTS = [
  'bosDebtArgs', 'bosCount', 'bosCents', 'BOS_DEBT_NOTE', 'bosMoneyCards', 'BOS_QUEUES', 'BOS_NOTHING_TO_DO',
  'bosAttention', 'BOS_PERSIST_WINDOWS', 'BOS_MIN_COHORT', 'BOS_PERSIST_WHY',
  'BOS_PERSIST_LEGEND', 'bosPersistency', 'bosTeam', 'bosHasDownline', 'bosIsEmpty',
  'BOS_EMPTY_TITLE', 'BOS_EMPTY_BODY', 'BOS_ERROR_DOORS', 'bosLoadError',
  // Round 4 — the book, not just the statements (// <bos-chart-core>).
  'BOS_ISSUED_STATUSES', 'BOS_ISSUED_DEF', 'bosPolicyDay', 'bosDay', 'bosIso', 'bosInRange',
  'bosIsIssued', 'bosIssuedPolicies', 'bosIssuedAP', 'bosIssuedCount', 'bosEstCommission',
  'bosCarrierKey', 'BOS_CARRIER_UNKNOWN', 'bosCarrierMix', 'BOS_DAILY_MAX_DAYS', 'BOS_DAILY_DAYS',
  'BOS_EMPTY_CHART', 'bosChartSpec', 'bosChartSeries',
  // From the blocks bo-summary-core declares a dependency on, so the tests can
  // prove the delegation rather than assume it.
  'COMM_CARD_DEFS', 'COMM_RANGES', 'commRange', 'commTotals', 'RECON_QUEUES',
  'persistBand', 'persistBandLabel',
  // The SHIPPED period engine and the SHIPPED commission estimate, lifted out
  // of app.html rather than re-typed here — see topLevelFn() below.
  'summaryPeriodRange', 'ppDynamicRange', 'ppParsePeriodKey', 'ppDay', 'ppIsDynamicPeriod',
  'ppPeriodLabel', '_lgAdvComm', 'ppProductionDate',
];

function block(name) {
  const m = APP.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`));
  assert.ok(m, `app.html must contain the // <${name}> ... // </${name}> block`);
  return m[1];
}

/**
 * Lift a top-level `function NAME(...) { ... }` out of app.html by brace
 * matching. The period engine and _lgAdvComm() are not inside a core sentinel,
 * and a mirrored copy in this file would be a second definition of exactly the
 * things this round must not have two of.
 */
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

function loadCore() {
  const src = [
    block('comm-core'), block('persist-core'), block('recon-core'), block('bo-summary-core'),
    block('bos-chart-core'),
    topLevelFn('ppParsePeriodKey'), topLevelFn('ppDay'), topLevelFn('ppIsDynamicPeriod'),
    topLevelFn('ppDynamicRange'), topLevelFn('ppPeriodLabel'), topLevelFn('summaryPeriodRange'),
    // FO5: bos-chart-core's third declared dependency — the app's one
    // production-date resolver. Lifted, never re-typed.
    topLevelFn('ppProductionDate'),
    topLevelFn('_lgAdvComm'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

// A small book with one policy in every status that matters, all on the same
// day, so a status filter is the ONLY thing that can move the total.
const AP = 1200;
const policyIn = (status, o = {}) => ({
  id: o.id || status, client: 'C',
  // `=== undefined`, not `||` — a blank carrier is a real case this screen has
  // to render ("No carrier recorded"), so the fixture must be able to express it.
  carrier: o.carrier === undefined ? 'Americo' : o.carrier,
  ap: o.ap === undefined ? AP : o.ap, commPct: o.commPct === undefined ? 100 : o.commPct,
  draft: o.draft || '2026-07-10', status,
});
const ALL_STATUSES = ['pending', 'approved', 'issued', 'paid', 'denied', 'withdrawn',
  'lapsed', 'surrendered', 'claim', 'chargeback'];
const FULL_BOOK = ALL_STATUSES.map(s => policyIn(s));
const UNBOUNDED = { start: null, end: null };

// A get_commission_buckets payload with every shape that matters: own and not
// own, positive and negative, and one bonus line so Net and Total diverge.
const BUCKETS = [
  { week_start: '2026-07-06', transaction_type: 'advance',    is_own: true,  amount_cents: 500000, positive_cents: 500000, negative_cents: 0,      row_count: 5 },
  { week_start: '2026-07-06', transaction_type: 'renewal',    is_own: true,  amount_cents: 25000,  positive_cents: 25000,  negative_cents: 0,      row_count: 3 },
  { week_start: '2026-07-06', transaction_type: 'chargeback', is_own: true,  amount_cents: -80000, positive_cents: 0,      negative_cents: -80000, row_count: 1 },
  { week_start: '2026-07-13', transaction_type: 'override',   is_own: false, amount_cents: 120000, positive_cents: 120000, negative_cents: 0,      row_count: 4 },
  { week_start: '2026-07-13', transaction_type: 'bonus',      is_own: true,  amount_cents: 30000,  positive_cents: 30000,  negative_cents: 0,      row_count: 1 },
  { week_start: '2026-07-20', transaction_type: 'adjustment', is_own: true,  amount_cents: -5000,  positive_cents: 0,      negative_cents: -5000,  row_count: 1 },
];

const DEBT_ROWS = [
  { carrier: 'Americo',   debt_cents: 42000, chargeback_cents: -40000, adjustment_cents: -2000, row_count: 3, unmatched_rows: 1, last_at: '2026-06-02' },
  { carrier: 'Corebridge', debt_cents: 18000, chargeback_cents: -18000, adjustment_cents: 0,    row_count: 2, unmatched_rows: 0, last_at: '2026-05-11' },
  // A carrier in credit is not listed by the RPC; a zero here is defensive.
  { carrier: 'Aetna',      debt_cents: 0,     chargeback_cents: -1000,  adjustment_cents: 1000, row_count: 2, unmatched_rows: 0, last_at: '2026-04-01' },
];

const card = (cards, key) => cards.find(c => c.key === key);
const persistRow = (o = {}) => ({
  agent_id: o.agent_id || 'a1', agent_name: 'Jace', agent_email: null,
  is_self: o.is_self === undefined ? true : o.is_self,
  window_months: o.window_months, cohort_count: o.cohort_count, kept_count: o.kept_count,
  cohort_ap: o.cohort_ap || 0, kept_ap: o.kept_ap || 0,
});

// ============================================================
// 1. BEHAVIOUR — the money strip
// ============================================================

test('the money cards carry the exact Net / Personal / Override figures the buckets imply', () => {
  const cards = B.bosMoneyCards(BUCKETS, DEBT_ROWS, { hasDownline: true });
  assert.deepEqual(cards.map(c => c.key), ['net', 'personal', 'override', 'debt']);

  // Net  = every line added up, bonuses and adjustments included.
  assert.equal(card(cards, 'net').cents, 500000 + 25000 - 80000 + 120000 + 30000 - 5000);
  // Personal = OWN advance + renewal, net of chargebacks on own lines. The
  // override line is not own, so it must not appear here.
  assert.equal(card(cards, 'personal').cents, 500000 + 25000 - 80000);
  // Override = override lines only.
  assert.equal(card(cards, 'override').cents, 120000);
  // Debt = the RPC's per-carrier balances, summed. Zero-balance rows excluded.
  assert.equal(card(cards, 'debt').cents, 42000 + 18000);
});

test('the definitions under the cards are the documented ones, word for word', () => {
  const cards = B.bosMoneyCards(BUCKETS, DEBT_ROWS, { hasDownline: true });
  // Delegated to comm-core's COMM_CARD_DEFS rather than re-typed here: this
  // screen sits one click from the Commissions panel and two wordings of
  // "what actually reached your bank" is the drift these blocks exist to stop.
  assert.equal(card(cards, 'net').def, B.COMM_CARD_DEFS.net);
  assert.equal(card(cards, 'personal').def, B.COMM_CARD_DEFS.personal);
  assert.equal(card(cards, 'override').def, B.COMM_CARD_DEFS.override);
  assert.equal(card(cards, 'debt').def, B.COMM_CARD_DEFS.debt);

  // And those in turn are what docs/back-office-commissions.md says.
  const six = COMMISSIONS_DOC.slice(
    COMMISSIONS_DOC.indexOf('## The six cards'),
    COMMISSIONS_DOC.indexOf('## Debt'),
  );
  assert.match(six, /What actually reached your bank/);
  assert.match(B.COMM_CARD_DEFS.net, /What actually reached your bank\./);
  assert.match(six, /your own advance \+ renewal, net of chargebacks on your own lines/i);
  assert.match(B.COMM_CARD_DEFS.personal, /^Advance and renewal on business you wrote, less anything charged back on it\.$/);
  assert.match(six, /override lines — from agents in your hierarchy/i);
  assert.match(B.COMM_CARD_DEFS.override, /^Override lines — commission from agents in your hierarchy, not from your own sales\.$/);
});

test('🔴 DEBT IS NEVER RANGE-FILTERED — the chips do not reach it', () => {
  // The rule, verbatim from docs/back-office-commissions.md § Debt: "You owe a
  // carrier what you owe them; a balance that shrank because someone clicked
  // 'MTD' would be a number nobody could act on."
  assert.deepEqual(B.bosDebtArgs(), { p_start: null, p_end: null });

  const today = new Date('2026-07-29T12:00:00');
  const mtd = B.commRange('mtd', today);
  const ytd = B.commRange('ytd', today);
  const all = B.commRange('all', today);
  assert.notDeepEqual(mtd, ytd, 'the fixture ranges must actually differ');

  const debtFor = range => card(
    B.bosMoneyCards(BUCKETS, DEBT_ROWS, { hasDownline: true, range }), 'debt').cents;
  assert.equal(debtFor(mtd), 60000);
  assert.equal(debtFor(ytd), 60000, 'the range chip must not move the balance');
  assert.equal(debtFor(all), 60000, 'the range chip must not move the balance');
  assert.equal(debtFor(undefined), 60000);
});

test('the debt card says in small print that the range above does not apply', () => {
  const cards = B.bosMoneyCards(BUCKETS, DEBT_ROWS, { hasDownline: true });
  assert.equal(card(cards, 'debt').note, B.BOS_DEBT_NOTE);
  assert.match(B.BOS_DEBT_NOTE, /All time/);
  assert.match(B.BOS_DEBT_NOTE, /does not apply/);
  // Nothing else on the strip carries a note, so the exception is visible.
  assert.equal(cards.filter(c => c.note).length, 1);
});

test('Override is dropped — not zeroed — for an agent with no hierarchy', () => {
  const noOverride = BUCKETS.filter(b => b.transaction_type !== 'override');
  const solo = B.bosMoneyCards(noOverride, DEBT_ROWS, { hasDownline: false });
  assert.deepEqual(solo.map(c => c.key), ['net', 'personal', 'debt'],
    'a permanently empty card on the landing screen is noise every single day');

  // A leader with a downline keeps the card even at zero — it is a real zero.
  const leader = B.bosMoneyCards(noOverride, DEBT_ROWS, { hasDownline: true });
  assert.ok(card(leader, 'override'));
  assert.equal(card(leader, 'override').cents, 0);

  // And a non-zero override always shows, hierarchy known or not.
  const earned = B.bosMoneyCards(BUCKETS, DEBT_ROWS, { hasDownline: false });
  assert.equal(card(earned, 'override').cents, 120000);
});

test('bosHasDownline believes the roster first, then the rollup', () => {
  assert.equal(B.bosHasDownline([], 3), true);
  assert.equal(B.bosHasDownline([], 0), false);
  assert.equal(B.bosHasDownline([], null), false);
  assert.equal(B.bosHasDownline([{ is_self: true }], null), false);
  assert.equal(B.bosHasDownline([{ is_self: true }, { is_self: false }], null), true);
  assert.equal(B.bosHasDownline(null, null), false);
});

// ============================================================
// 2. BEHAVIOUR — what needs you
// ============================================================

test('three zero queues get the all-clear sentence, never three bare zeroes', () => {
  const a = B.bosAttention({ match_review: 0, unlinked_policies: 0, stuck_uploads: 0 });
  assert.equal(a.total, 0);
  assert.equal(a.clear, true);
  assert.equal(a.sentence, B.BOS_NOTHING_TO_DO);
  assert.equal(a.sentence, 'Nothing needs your attention right now.');
  assert.deepEqual(a.cards.map(c => c.count), [0, 0, 0],
    'the cards still render — the sentence explains them, it does not replace them');
});

test('the attention roll-up counts all three queues and says so in English', () => {
  const a = B.bosAttention({ match_review: 4, unlinked_policies: 1, stuck_uploads: 1, resolved_7d: 9 });
  assert.equal(a.total, 6);
  assert.equal(a.clear, false);
  assert.equal(a.sentence, '6 things need a look');
  assert.deepEqual(a.cards.map(c => c.count), [4, 1, 1]);

  assert.equal(B.bosAttention({ match_review: 1 }).sentence, '1 thing needs a look');
  assert.equal(B.bosAttention({ stuck_uploads: 2 }).total, 2);
});

test('a missing or malformed summary is zero, not NaN', () => {
  [null, undefined, {}, { match_review: null }, { match_review: 'x' }].forEach(s => {
    const a = B.bosAttention(s);
    assert.equal(a.total, 0, `bosAttention(${JSON.stringify(s)}) must not produce NaN`);
    assert.equal(a.sentence, B.BOS_NOTHING_TO_DO);
  });
  // A negative count is a nonsense the screen must not repeat back.
  assert.equal(B.bosAttention({ match_review: -3 }).total, 0);
});

test('a count is never NaN and money keeps its sign', () => {
  // Number('x' || 0) is NaN and Math.max(0, NaN) is NaN too, so the obvious
  // guard is not one. "NaN things need a look" is how a dashboard announces
  // that it has stopped working.
  [undefined, null, '', 'x', NaN, -3, {}].forEach(v =>
    assert.equal(B.bosCount(v), 0, `bosCount(${String(v)}) must be 0`));
  assert.equal(B.bosCount('7'), 7);
  assert.equal(B.bosCount(7), 7);

  // Money is different: a negative is real and must survive.
  assert.equal(B.bosCents(-4200), -4200);
  assert.equal(B.bosCents('x'), 0);
  assert.equal(B.bosCents(null), 0);
});

test('the queue keys are the ones rcSetQueue() already accepts', () => {
  // A card that opens a queue the panel does not have is a dead door.
  assert.deepEqual(B.BOS_QUEUES.map(q => q.key), B.RECON_QUEUES.map(q => q.key));
  assert.deepEqual(B.BOS_QUEUES.map(q => q.label), B.RECON_QUEUES.map(q => q.label));
  assert.deepEqual(B.BOS_QUEUES.map(q => q.label),
    ['Policy Match Review', 'Unlinked Policies', 'Stuck Uploads']);
});

// ============================================================
// 3. BEHAVIOUR — book health
// ============================================================

const NO_RATE_RULE =
  '"No rate is not a zero rate." 0/0 is not 0%, and painting a red band on an ' +
  'agent who has simply not been writing long enough is the single most ' +
  'misleading thing this screen could do. See docs/back-office-persistency.md.';

test('🔴 AN ABSENT COHORT RENDERS AN EM DASH, NEVER 0%', () => {
  const none = B.bosPersistency([], 13);
  assert.equal(none.rate, null, NO_RATE_RULE);
  assert.equal(none.display, '—', NO_RATE_RULE);
  assert.notEqual(none.display, '0%', NO_RATE_RULE);
  assert.equal(none.band, null, NO_RATE_RULE);
  assert.equal(none.hasRate, false, NO_RATE_RULE);
  assert.match(none.sub, /No policy has had 13 months to lapse yet\./);

  // Same for a cohort the RPC reported as literally zero.
  const zero = B.bosPersistency([persistRow({ window_months: 25, cohort_count: 0, kept_count: 0 })], 25);
  assert.equal(zero.display, '—', NO_RATE_RULE);
  assert.equal(zero.rate, null, NO_RATE_RULE);
});

test('🔴 A THIN COHORT RENDERS AN EM DASH TOO, AND SAYS WHY', () => {
  // One lapse in a two-policy cohort is a 50% headline on the owner's landing
  // screen. Below BOS_MIN_COHORT this screen refuses to headline a rate.
  assert.equal(B.BOS_MIN_COHORT, 3);
  const thin = B.bosPersistency([persistRow({ window_months: 13, cohort_count: 2, kept_count: 1 })], 13);
  assert.equal(thin.display, '—', NO_RATE_RULE);
  assert.equal(thin.rate, null, NO_RATE_RULE);
  assert.equal(thin.hasRate, false);
  assert.match(thin.sub, /Only 2 policies are old enough to count — too few for a rate\./);

  const one = B.bosPersistency([persistRow({ window_months: 13, cohort_count: 1, kept_count: 0 })], 13);
  assert.match(one.sub, /Only 1 policy is old enough/, 'the sentence has to read as English');

  // The threshold is overridable, so the panel's own rules are not bent by it.
  const forced = B.bosPersistency(
    [persistRow({ window_months: 13, cohort_count: 2, kept_count: 1 })], 13, { minCohort: 1 });
  assert.equal(forced.display, '50%');
});

test('a REAL zero is still a zero — nothing kept out of a real cohort reads 0%, in red', () => {
  const wipeout = B.bosPersistency(
    [persistRow({ window_months: 13, cohort_count: 8, kept_count: 0 })], 13);
  assert.equal(wipeout.rate, 0);
  assert.equal(wipeout.display, '0%');
  assert.equal(wipeout.band, 'red');
  assert.equal(wipeout.hasRate, true);
  assert.equal(wipeout.sub, '0 of 8 still on the books');
});

test('the headline windows read the SELF row, and the team view reads everyone', () => {
  const rows = [
    persistRow({ window_months: 13, cohort_count: 10, kept_count: 9, is_self: true }),
    persistRow({ agent_id: 'a2', window_months: 13, cohort_count: 10, kept_count: 5, is_self: false }),
    persistRow({ window_months: 25, cohort_count: 4, kept_count: 3, is_self: true }),
  ];
  assert.equal(B.bosPersistency(rows, 13).display, '90%');
  assert.equal(B.bosPersistency(rows, 25).display, '75%');
  // Team: both agents' cohorts pooled — 14 kept of 20.
  const team = B.bosPersistency(rows, 13, { selfOnly: false });
  assert.equal(team.cohort, 20);
  assert.equal(team.kept, 14);
  assert.equal(team.display, '70%');
});

test('the two headline windows are 13 and 25 months, labelled by the shared helper', () => {
  assert.deepEqual(B.BOS_PERSIST_WINDOWS, [13, 25]);
  assert.equal(B.bosPersistency([], 13).label, '13-month');
  assert.equal(B.bosPersistency([], 25).label, '25-month');
});

test('🔴 THE BANDS SIT EXACTLY ON THE CARRIER BONUS BOUNDARIES', () => {
  // data/carrier_bonuses.json is full of "13-mo persistency >= 85%", so these
  // boundaries are contractual, not cosmetic. Delegated to persist-core.
  assert.equal(B.persistBand(85), 'green');
  assert.equal(B.persistBand(84), 'yellow');
  assert.equal(B.persistBand(70), 'yellow');
  assert.equal(B.persistBand(69), 'red');
  assert.equal(B.persistBand(null), null);

  // And the bands the cards actually wear come from the same function.
  const at = (cohort, kept) => B.bosPersistency(
    [persistRow({ window_months: 13, cohort_count: cohort, kept_count: kept })], 13);
  assert.equal(at(100, 85).band, 'green');
  assert.equal(at(100, 84).band, 'yellow');
  assert.equal(at(100, 70).band, 'yellow');
  assert.equal(at(100, 69).band, 'red');
  assert.equal(at(100, 85).bandLabel, B.persistBandLabel(85));
});

test('the legend is rendered, because a colour with no key is a decoration', () => {
  assert.match(B.BOS_PERSIST_LEGEND, /85/);
  assert.match(B.BOS_PERSIST_LEGEND, /70/);
  assert.match(B.BOS_PERSIST_WHY, /bonus/i);
  assert.match(APP, /BOS_PERSIST_LEGEND/);
  assert.match(APP, /BOS_PERSIST_WHY/);
});

// ============================================================
// 4. BEHAVIOUR — the team strip, and the empty state
// ============================================================

test('🔴 A NON-LEADER GETS NO TEAM STRIP AT ALL — absent, not empty, not locked', () => {
  const rollup = [
    { agent_id: 'a1', is_self: true, net_cents: 500000, debt_cents: 0, gross_cents: 500000 },
    { agent_id: 'a2', is_self: false, net_cents: 200000, debt_cents: 42000, gross_cents: 240000 },
  ];
  assert.equal(B.bosTeam(rollup, [], { isLeader: false }), null,
    'the upgrade gate lives on the features that need it; a permanently greyed ' +
    'strip on the landing screen is noise every single day');
  assert.equal(B.bosTeam(rollup, [], {}), null);

  const t = B.bosTeam(rollup, [], { isLeader: true });
  assert.ok(t);
  assert.equal(t.productionCents, 700000, 'production is the whole agency, the leader included');
  assert.equal(t.downlineDebtCents, 42000);
  assert.equal(t.headcount, 1, 'headcount falls back to the rollup when the roster is unknown');
});

test('the roster is the honest headcount when we have it', () => {
  // The rollup only knows agents who have a commission line, so a downline
  // that has never uploaded a statement would read as no downline at all.
  const rollup = [{ agent_id: 'a1', is_self: true, net_cents: 100, debt_cents: 0 }];
  assert.equal(B.bosTeam(rollup, [], { isLeader: true, rosterDownline: 6 }).headcount, 6);
  assert.equal(B.bosTeam(rollup, [], { isLeader: true, rosterDownline: 0 }).headcount, 0);
  assert.equal(B.bosTeam(rollup, [], { isLeader: true, rosterDownline: null }).headcount, 0);
  assert.equal(B.bosTeam(rollup, [], { isLeader: true, rosterDownline: 0 }).headcountKnown, true);
  assert.equal(B.bosTeam(rollup, [], { isLeader: true }).headcountKnown, false);
});

test('team persistency pools the whole agency and obeys the same no-rate rule', () => {
  const rows = [
    persistRow({ window_months: 13, cohort_count: 1, kept_count: 1, is_self: true }),
    persistRow({ agent_id: 'a2', window_months: 13, cohort_count: 1, kept_count: 0, is_self: false }),
  ];
  const t = B.bosTeam([], rows, { isLeader: true });
  assert.equal(t.persist.months, 13);
  assert.equal(t.persist.cohort, 2);
  assert.equal(t.persist.display, '—', NO_RATE_RULE);
});

test('🔴 ZERO PROCESSED STATEMENTS IS THE EMPTY STATE; ONE OR MORE IS THE DASHBOARD', () => {
  assert.equal(B.bosIsEmpty({ ingested: 0, queued: 0, parsing: 0, persisting: 0, matching: 0, failed: 0 }), true);
  assert.equal(B.bosIsEmpty({}), true);
  assert.equal(B.bosIsEmpty(null), true);
  assert.equal(B.bosIsEmpty({ ingested: 1 }), false);
  assert.equal(B.bosIsEmpty({ ingested: 12, failed: 0 }), false);

  // Something still moving, or something that failed on the way, is not
  // "nothing here yet" — it is a screen about to fill, or one to go and fix.
  ['queued', 'parsing', 'persisting', 'matching', 'failed'].forEach(k => {
    assert.equal(B.bosIsEmpty({ ingested: 0, [k]: 1 }), false,
      `a statement in '${k}' must not be greeted with "Nothing here yet."`);
  });

  assert.equal(B.BOS_EMPTY_TITLE, 'Nothing here yet.');
  // Round 4 repointed the copy at the POLICY BOOK. bosIsEmpty() still answers
  // the statement question exactly as before — what changed is that it is no
  // longer on its own sufficient to blank the page (see bosIsBrandNew()).
  assert.match(B.BOS_EMPTY_BODY, /Add a policy and this screen fills itself in\./);
  assert.ok(!/Drop your first carrier statement/.test(B.BOS_EMPTY_BODY),
    'an owner with a full book of policies must never be sent to statement upload');
});

test('a failed RPC leaves a door open on its own card', () => {
  assert.equal(B.bosLoadError('commissions'), 'Couldn’t load — open Commissions to see this');
  assert.equal(B.bosLoadError('reconciliation'), 'Couldn’t load — open Reconciliation to see this');
  assert.equal(B.bosLoadError('persistency'), 'Couldn’t load — open Persistency to see this');
  assert.equal(B.bosLoadError('agency'), 'Couldn’t load — open Agency to see this');
  // An unknown area still names somewhere real rather than trailing off.
  assert.match(B.bosLoadError('nonsense'), /open Statements to see this$/);
  Object.keys(B.BOS_ERROR_DOORS).forEach(k => assert.ok(B.BOS_ERROR_DOORS[k]));
});

// ============================================================
// 5. STRUCTURE — registration and the office split
// ============================================================

test('bo-summary is registered in the ONE place office membership is declared', () => {
  const map = APP.slice(APP.indexOf('const OFFICE_OF = {'), APP.indexOf('const OFFICE_HOME'));
  assert.match(map, /'bo-summary':\s*'back'/,
    "OFFICE_OF is the only place office membership is declared; a nav item " +
    'with no entry is invisible in BOTH offices');
});

test('🔴 FLIPPING THE TOGGLE LANDS ON THE SUMMARY, NOT ON THE POLICY LIST', () => {
  const m = APP.match(/const OFFICE_HOME = \{([^}]*)\}/);
  assert.ok(m, 'app.html must define OFFICE_HOME exactly once');
  assert.match(m[1], /front:\s*'summary'/, 'the Front Office landing screen does not change');
  assert.match(m[1], /back:\s*'bo-summary'/);
  assert.ok(!/back:\s*'tracker'/.test(m[1]),
    'Round 1 parked the Back Office on Policy Tracker as a placeholder; Round 2 replaces it');
  assert.equal((APP.match(/const OFFICE_HOME\b/g) || []).length, 1);
});

test('the section exists, is prefixed sec- so nav() can resolve it, and is titled', () => {
  assert.match(APP, /<div class="section" id="sec-bo-summary">/);
  // nav() resolves a screen with getElementById('sec-' + id) — a section
  // without the prefix is unreachable however well it is registered.
  assert.match(APP, /'bo-summary':\s*'Summary'/, 'NAV_TITLES must name it');
  assert.match(APP, /<div id="bos-body"><\/div>/);
  // It reuses the Back Office design shell rather than inventing a layout.
  const sec = APP.slice(APP.indexOf('<div class="section" id="sec-bo-summary">'),
    APP.indexOf('<div class="section" id="sec-backoffice">'));
  assert.match(sec, /<div class="ledger">/);
  assert.match(sec, /<div class="lg-wrap">/);
  assert.match(sec, /class="pt-btn pt-btn-ghost" id="bos-refresh"/,
    'the refresh button reuses the style the Back Office header already uses');
});

test('the Back Office nav opens with Summary, and Round 1 s five screens follow', () => {
  const a = APP.indexOf('<div class="nav-office" data-office="back">');
  const b = APP.indexOf('<div class="sidebar-bot">', a);
  assert.ok(a > -1 && b > a);
  const backNav = APP.slice(a, b);
  const targets = [...backNav.matchAll(/<div class="nav-item"[^>]*onclick="nav\('([^']+)'\)"/g)].map(m => m[1]);
  assert.deepEqual(targets, ['bo-summary', 'tracker', 'carriermail', 'backoffice', 'bonuses', 'agency']);
  assert.equal(targets[0], 'bo-summary', 'Summary must be the FIRST item in the Back Office');
  // Same icon as the Front Office's Summary — deliberate symmetry.
  assert.match(backNav, /onclick="nav\('bo-summary'\)"><span class="ico" data-ico="gauge">/);
  // Every item in the wrapper carries its own data-office, as Round 1 requires.
  const items = backNav.match(/<div class="nav-item"[^>]*>/g) || [];
  items.forEach(i => assert.match(i, /data-office="back"/));
});

test('nav() initialises the screen, and the refresh allow-list can restore it', () => {
  assert.match(APP_CODE, /if \(id === 'bo-summary'\) renderBackOfficeSummary\(\);/);
  // Round 2 hand-added 'bo-summary' to `const valid = {…}` and this test pinned
  // it there. Round 3 deleted that list: having to remember an entry is exactly
  // how it ended up four screens behind the sidebar. The membership test is now
  // derived — a nav item plus an OFFICE_OF entry — so the thing to pin is that
  // bo-summary still has both. Full coverage in test/office-split.test.mjs.
  assert.ok(!APP_CODE.includes('const valid = {'),
    'the hand-written restore allow-list is gone and must not come back');
  assert.match(APP_CODE, /function _isRestorableSection\(id\) \{/,
    "bootDashboard()'s restore must still have a membership test");
  assert.match(APP_CODE, /if \(saved && _isRestorableSection\(saved\)/,
    'and the cached-section restore must be the thing consulting it');
  assert.match(APP, /onclick="nav\('bo-summary'\)"/,
    'without a nav item, F5 on the Back Office landing screen drops the agent elsewhere');
  // The other half — the OFFICE_OF entry — is pinned by the registration test
  // above, and _isRestorableSection() requires both.
});

// ============================================================
// 6. STRUCTURE — the rules this screen must not break
// ============================================================

test('🔴 NO NEW BACKEND: every RPC this screen calls already existed', () => {
  const fn = APP_CODE.slice(
    APP_CODE.indexOf('async function renderBackOfficeSummary('),
    APP_CODE.indexOf('function bosPaint('));
  assert.ok(fn.length > 0, 'renderBackOfficeSummary() must exist');
  const called = [...fn.matchAll(/rpc\('([a-z_]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(called)], [
    'get_commission_buckets', 'get_commission_debt', 'get_downline_commission_rollup',
    'get_downline_persistency', 'get_ingestion_summary', 'get_reconciliation_summary',
  ], 'a new name here means a new migration, which this round does not have');

  // And it never reaches past the aggregates into the rows themselves.
  assert.ok(!/from\('commission_rows'\)/.test(fn),
    'commission_rows is SELECT-only per tenant and the aggregates exist ' +
    'precisely so the browser does not do this');
  assert.ok(!/from\('commission_statements'\)/.test(fn));
});

test('🔴 THE DEBT CALL PASSES bosDebtArgs(), NOT THE SELECTED RANGE', () => {
  assert.match(APP_CODE, /rpc\('get_commission_debt', bosDebtArgs\(\)\)/);
  // The screen must not contain a second, range-bearing debt call.
  const debtCalls = APP_CODE.match(/rpc\('get_commission_debt',\s*([^)]*)\)/g) || [];
  debtCalls.forEach(c => assert.ok(
    /bosDebtArgs\(\)/.test(c) || /p_start:\s*null,\s*p_end:\s*null/.test(c),
    `a range-filtered debt call would be a number nobody could act on: ${c}`));
});

test('🔴 THE ONE get_team_summary CALL SITE IS STILL ONE', () => {
  // A second team query with its own window arithmetic is what produced the
  // 8,610x AP overstatement. This screen goes through loadTeamRoster().
  const calls = APP_CODE.match(/sb\.rpc\(\s*'get_team_summary'/g) || [];
  assert.equal(calls.length, 1);
  const idx = APP_CODE.indexOf("sb.rpc('get_team_summary'");
  const fnStart = APP_CODE.lastIndexOf('async function loadTeamRoster', idx);
  assert.ok(fnStart > -1 && fnStart < idx);
  assert.match(APP_CODE, /jobs\.push\(\['roster', loadTeamRoster\(_teamPeriod\)\]\)/);
});

test('🔴 THE TEAM STRIP IS GATED ON _planTier() === leader, AND RENDERS NOTHING OTHERWISE', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosTeamHTML()'),
    APP_CODE.indexOf('function bosEmptyHTML()'));
  assert.ok(fn.length > 0, 'bosTeamHTML() must exist');
  assert.match(fn, /if \(_planTier\(\) !== 'leader'\) return '';/);
  // Absent, not hidden: no display:none, no locked card, no upsell.
  assert.ok(!/display:\s*none/.test(fn), 'a hidden strip is still a strip in the DOM');
  assert.ok(!/showUpgradeGate|Upgrade|upsell|locked/i.test(fn));
  // The gate is checked BEFORE anything is built.
  assert.ok(fn.indexOf("_planTier() !== 'leader'") < fn.indexOf('cm-cards'));
});

test('the cards are doors, opened through boArea() rather than a bopanel- element', () => {
  const fns = APP_CODE.slice(APP_CODE.indexOf('function bosOpen('),
    APP_CODE.indexOf('function bosMoneyHTML('));
  assert.match(fns, /function bosOpen\(area\) \{\s*nav\('backoffice'\);\s*boArea\(area\);/);
  assert.match(fns, /rcSetQueue\(queue\)/);
  assert.ok(!/bopanel-/.test(fns),
    'Back Office panels are resolved structurally by boArea(); naming one here ' +
    'is the two-place edit that shipped a screen rendering on top of another');
  // Written either as a plain onclick string or escaped inside a JS template.
  ['commissions', 'persistency'].forEach(a =>
    assert.match(APP, new RegExp(`bosOpen\\(\\\\?'${a}\\\\?'\\)`), `no door to ${a}`));
  // Reconciliation is reached through bosOpenQueue(), which selects the queue
  // BEFORE the panel is shown, so the agent lands on the count they clicked
  // rather than on whichever queue they last looked at.
  assert.match(fns, /boArea\('reconciliation'\)/);
  assert.ok(fns.indexOf('rcSetQueue(queue)') < fns.indexOf("boArea('reconciliation')"));
  assert.match(APP_CODE, /open: "bosOpenQueue\('" \+ c\.key \+ "'\)"/,
    'each attention card must carry its own queue key, not a shared link');
  // The team strip's door is the Agency screen, which is not a Back Office panel.
  assert.match(APP_CODE, /const door = "nav\('agency'\)";/);
  assert.match(APP_CODE, /open: door/);
});

test('one failure does not blank the page — the loader is allSettled', () => {
  const fn = APP_CODE.slice(
    APP_CODE.indexOf('async function renderBackOfficeSummary('),
    APP_CODE.indexOf('function bosPaint('));
  assert.match(fn, /Promise\.allSettled\(/);
  assert.ok(!/Promise\.all\(/.test(fn),
    'Promise.all would let one rejected RPC take the whole dashboard down');
  // Each settle repaints, so a card fills the moment its own data lands.
  assert.match(fn, /bosPaint\(\);/);
});

test('money is formatted by boFmtMoney — there is no second formatter here', () => {
  const start = APP.indexOf('// <bo-summary-core>');
  const end = APP.indexOf('function boRefresh(');
  const screen = APP.slice(start, end);
  assert.ok(screen.includes('boFmtMoney('), 'the shared formatter must be used');
  assert.ok(!/toLocaleString\('en-US', \{ minimumFractionDigits/.test(screen),
    'a second money formatter is a second way to print a dollar amount');
  assert.ok(!/\/ 100/.test(stripLineComments(screen, ['//', '*', '/*'])),
    'money is never recomputed from a float on this screen');
});

test('the screen writes nothing — it is read-only, by construction', () => {
  const start = APP_CODE.indexOf('const BOS_TTL_MS');
  const end = APP_CODE.indexOf('function boRefresh(');
  const screen = APP_CODE.slice(start, end);
  [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /functions\.invoke\(/]
    .forEach(re => assert.ok(!re.test(screen), `${re} must not appear on a read-only dashboard`));
});

test('the bo-summary-core block is pure — no DOM, network, storage or app globals', () => {
  const body = stripLineComments(block('bo-summary-core'), ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsessionStorage\b/, /\bsb\./,
   /\bfetch\(/, /\bcurrentAgent\b/, /\bescHTML\(/, /\bshowToast\(/, /\bnav\(/,
   /\bboArea\(/, /_bosCache/, /_planTier\(/, /_cmRange\b/, /\bcurrentPlanName\b/,
   // The app's own arrays, read as objects rather than merely named in a
   // sentence — `' policies are'` is copy, `policies.filter` is a dependency.
   /\bpolicies\s*[.[]/, /\bleads\s*[.[]/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
});

test('every core sentinel still appears exactly once, including the new one', () => {
  // The harness extracts each core with a lazy match from its opening
  // sentinel, so a mention of one ABOVE its real block swallows the file.
  ['bob-core', 'comm-core', 'persist-core', 'recon-core', 'referral-core',
   'backoffice-core', 'team-core', 'producer-codes-core', 'ai-meter-core',
   'vcamp-core', 'leadfilter-core', 'bo-summary-core', 'bos-chart-core'].forEach(name => {
    assert.equal((APP.match(new RegExp(`// <${name}>`, 'g')) || []).length, 1, `// <${name}>`);
    assert.equal((APP.match(new RegExp(`// </${name}>`, 'g')) || []).length, 1, `// </${name}>`);
  });
});

test('the screen uses design tokens only — no hard-coded colour in its own CSS', () => {
  const css = APP.slice(APP.indexOf('/* ---- Back Office Summary'),
    APP.indexOf('/* ---- Reconciliation (Phase 6) ---- */'));
  assert.ok(css.length > 0, 'the Back Office Summary CSS block must exist');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css),
    'a hard-coded hex does not follow the reader into dark mode');
  assert.match(css, /var\(--lg-/);
});

// ============================================================
// 7. ROUND 4 — THE SCREEN READS THE BOOK, NOT JUST THE STATEMENTS
// ============================================================

const MONEY_DEF_RULE =
  'BOS_ISSUED_STATUSES is a MONEY DEFINITION. A silent drift here is the 8,610x ' +
  'class of bug: the figure changes, nothing errors, and nobody can tell from ' +
  'the screen. See docs/back-office-summary.md.';

test('🔴 ISSUED AP IS issued + paid, AND NOTHING ELSE', () => {
  assert.deepEqual(B.BOS_ISSUED_STATUSES, ['issued', 'paid'], MONEY_DEF_RULE);

  // issued + paid = two policies at $1,200.
  assert.equal(B.bosIssuedAP(FULL_BOOK, UNBOUNDED), AP * 2, MONEY_DEF_RULE);
  assert.equal(B.bosIssuedCount(FULL_BOOK, UNBOUNDED), 2, MONEY_DEF_RULE);

  // One assertion per excluded status, each naming the status it is about,
  // because "the total looks wrong" is not a debuggable failure message.
  ALL_STATUSES.filter(s => !B.BOS_ISSUED_STATUSES.includes(s)).forEach(status => {
    const only = [policyIn(status)];
    assert.equal(B.bosIssuedAP(only, UNBOUNDED), 0,
      `a policy in '${status}' must NOT count toward issued AP. ${MONEY_DEF_RULE}`);
    assert.equal(B.bosIssuedPolicies(only, UNBOUNDED).length, 0,
      `a policy in '${status}' must NOT be in the issued set. ${MONEY_DEF_RULE}`);
  });

  ['issued', 'paid'].forEach(status => {
    assert.equal(B.bosIssuedAP([policyIn(status)], UNBOUNDED), AP,
      `a policy in '${status}' MUST count toward issued AP. ${MONEY_DEF_RULE}`);
  });
});

test('🔴 ISSUED AP IS NOT THE SALE PREDICATE — it must never reach for BOB_NOT_A_SALE', () => {
  // get_team_summary() and lb_agent_metrics() answer "what was sold" and count
  // a pending application; this answers "what did the carrier issue". Both are
  // right about their own question. Quietly folding one into the other is what
  // this assertion exists to stop.
  const core = stripLineComments(block('bos-chart-core'), ['//', '*', '/*']);
  assert.ok(!/BOB_NOT_A_SALE/.test(core),
    'bosIssuedAP answers a different question from the sale predicate and must not borrow it');
  assert.ok(!/BOB_ENDED|PERSIST_KEPT|lb_agent_metrics|get_team_summary/.test(core),
    'no other status list may leak into this one');

  // And they demonstrably differ on the same book: a sale predicate counts the
  // pending and approved rows this one drops.
  const sold = FULL_BOOK.filter(p => !['lapsed', 'chargeback', 'denied', 'withdrawn'].includes(p.status));
  assert.equal(sold.length, 6);
  assert.notEqual(B.bosIssuedCount(FULL_BOOK, UNBOUNDED), sold.length,
    'the two definitions must be visibly different, or the warning on screen is noise');
});

test('a lapsed policy LEAVES the figure, so a past period can shrink — intended', () => {
  const march = { start: new Date(2026, 2, 1), end: new Date(2026, 3, 1) };
  const before = [policyIn('issued', { id: 'm1', draft: '2026-03-09' })];
  const after = [{ ...before[0], status: 'lapsed' }];
  assert.equal(B.bosIssuedAP(before, march), AP);
  assert.equal(B.bosIssuedAP(after, march), 0,
    'the owner was shown this trade-off and chose it — do NOT add a snapshot or an as-of date');
});

test('the AP card carries its definition, in words, always on', () => {
  assert.match(B.BOS_ISSUED_DEF, /issued or paid/i);
  assert.match(B.BOS_ISSUED_DEF, /[Pp]ending/);
  // Rendered under the card rather than hidden in a tooltip — the Commissions
  // panel's rule, and the reason it matters here is the Top Producers card
  // counting differently one strip below.
  assert.match(APP_CODE, /BOS_ISSUED_DEF/);
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosProductionHTML()'),
    APP_CODE.indexOf('const BOS_CHART_W'));
  assert.match(fn, /card\('Personal issued AP',[\s\S]{0,60}BOS_ISSUED_DEF\)/);
});

test('the four cards are AP, estimate, paid and count — and paid is a DASH, never a zero', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosProductionHTML()'),
    APP_CODE.indexOf('const BOS_CHART_W'));
  ['Personal issued AP', 'Est. commission', 'Commission paid', 'Policies issued']
    .forEach(l => assert.ok(fn.includes(l), `the ${l} card must exist`));
  // "$0.00" on an account with no statements claims the carriers paid nothing.
  assert.match(fn, /paidValue = '<div class="cm-card-v bos-zero">&mdash;<\/div>'/);
  assert.match(fn, /Upload a statement to see this\./);
  // The estimate goes through the app's ONE formula, taken as a parameter.
  assert.match(fn, /bosEstCommission\(pols, win, _lgAdvComm\)/);
  assert.ok(!/\* 0\.75/.test(fn), 'a second advance formula is a second answer');
});

test('the estimate is the SHIPPED _lgAdvComm formula, not a copy of it', () => {
  // _lgAdvComm is lifted out of app.html by topLevelFn(), so this runs the
  // arithmetic that ships: AP x comm% x 75% advance.
  const book = [policyIn('issued', { commPct: 100 }), policyIn('paid', { id: 'p2', commPct: 50 })];
  assert.equal(B._lgAdvComm(book[0]), AP * 0.75);
  assert.equal(B.bosEstCommission(book, UNBOUNDED, B._lgAdvComm), AP * 0.75 + AP * 0.375);
  // Excluded statuses are excluded here too — one set of policies, four cards.
  assert.equal(B.bosEstCommission(FULL_BOOK, UNBOUNDED, B._lgAdvComm),
    B.bosIssuedPolicies(FULL_BOOK, UNBOUNDED).reduce((s, p) => s + B._lgAdvComm(p), 0));
  // A missing resolver returns zero rather than throwing on the landing screen.
  assert.equal(B.bosEstCommission(book, UNBOUNDED, null), 0);
});

test('carrier mix groups on one spelling and never lists a carrier twice', () => {
  const book = [
    policyIn('issued', { id: 'c1', carrier: 'Americo', ap: 900 }),
    policyIn('paid',   { id: 'c2', carrier: 'americo ', ap: 300 }),
    policyIn('issued', { id: 'c3', carrier: 'Americo', ap: 100 }),
    policyIn('issued', { id: 'c4', carrier: 'Mutual of Omaha', ap: 700 }),
    policyIn('lapsed', { id: 'c5', carrier: 'Corebridge', ap: 5000 }),
    policyIn('issued', { id: 'c6', carrier: '', ap: 200 }),
  ];
  const mix = B.bosCarrierMix(book, UNBOUNDED);
  assert.deepEqual(mix.rows.map(r => r.label),
    ['Americo', 'Mutual of Omaha', B.BOS_CARRIER_UNKNOWN],
    'a carrier must not appear twice under two spellings');
  assert.equal(mix.rows[0].count, 3);
  assert.equal(mix.rows[0].ap, 1300);
  assert.equal(mix.total, 2200, 'a lapsed policy is not in the mix — same definition as the card');
  assert.equal(mix.count, 5);
  assert.ok(Math.abs(mix.rows.reduce((s, r) => s + r.share, 0) - 100) < 1e-9,
    'the shares must sum to 100, or the bar is a decoration');
  // Sorted by AP descending.
  assert.deepEqual(mix.rows.map(r => r.ap), [1300, 700, 200]);
  // Empty window is an empty list, not a throw.
  assert.deepEqual(B.bosCarrierMix([], UNBOUNDED).rows, []);
  assert.equal(B.bosCarrierMix(null, UNBOUNDED).total, 0);
});

// ---- the graph ---------------------------------------------------------

const TODAY = new Date(2026, 6, 15);   // Wednesday 15 July 2026
const spec = (key, pols) => B.bosChartSpec(key, B.summaryPeriodRange(key, TODAY), TODAY, pols || []);

test('🔴 "TODAY" DRAWS SEVEN DAILY BUCKETS, NOT TWENTY-FOUR HOURLY ONES', () => {
  const NO_CLOCK =
    'There is no sale-time timestamp anywhere in this schema — only the moment a ' +
    'row was entered — so an hourly axis plots data-entry habits, not production. ' +
    'Same evidence docs/agency-leaderboards.md records for cutting Early Bird and Closer.';
  const s = spec('daily');
  assert.equal(s.unit, 'day', NO_CLOCK);
  assert.equal(s.buckets.length, 7, NO_CLOCK);
  assert.equal(B.BOS_DAILY_DAYS, 7, NO_CLOCK);
  assert.notEqual(s.buckets.length, 24, NO_CLOCK);
  assert.deepEqual(s.buckets.map(b => b.label),
    ['Jul 9', 'Jul 10', 'Jul 11', 'Jul 12', 'Jul 13', 'Jul 14', 'Jul 15']);
  // Today is the last bucket and it is the emphasised one.
  assert.deepEqual(s.buckets.map(b => b.isNow), [false, false, false, false, false, false, true]);
  assert.match(s.note, /Last 7 days/);
});

test('every period shape produces the buckets the granularity table promises', () => {
  const week = spec('weekly');
  assert.equal(week.unit, 'day');
  assert.equal(week.buckets.length, 7, 'weekly is 7 daily buckets, Mon–Sun');
  assert.equal(week.buckets[0].label, 'Jul 13', 'the week starts on Monday');
  assert.equal(week.buckets[6].label, 'Jul 19');

  const month = spec('monthly');
  assert.equal(month.unit, 'day');
  assert.equal(month.buckets.length, 31, 'July has 31 days');
  assert.equal(month.buckets[0].label, 'Jul 1');
  assert.equal(month.buckets[30].label, 'Jul 31');

  const past = spec('month:2026-04');
  assert.equal(past.unit, 'day');
  assert.equal(past.buckets.length, 30, 'April has 30 days');
  assert.equal(past.buckets[0].label, 'Apr 1');
  assert.ok(past.buckets.every(b => !b.isNow), 'a past month contains no today');

  // Custom, short: daily.
  const short = spec('custom:2026-06-01:2026-06-20');
  assert.equal(short.unit, 'day');
  assert.equal(short.buckets.length, 20, 'the picker is inclusive — the 20th counts');

  // Custom, long: weekly buckets above the ceiling.
  assert.equal(B.BOS_DAILY_MAX_DAYS, 62);
  const long = spec('custom:2026-01-01:2026-06-30');
  assert.equal(long.unit, 'week');
  assert.ok(long.buckets.length >= 25 && long.buckets.length <= 27,
    'about 26 weeks, aligned to Monday — got ' + long.buckets.length);
  assert.match(long.note, /Weekly buckets/);

  // Exactly at the ceiling is still daily; one day past it is not.
  assert.equal(spec('custom:2026-05-01:2026-07-01').unit, 'day');   // 62 days
  assert.equal(spec('custom:2026-05-01:2026-07-02').unit, 'week');  // 63 days
});

test('lifetime draws monthly buckets, spanning the book itself', () => {
  const book = [
    policyIn('issued', { id: 'l1', draft: '2026-05-04' }),
    policyIn('paid',   { id: 'l2', draft: '2026-07-02' }),
    // A lapsed policy further back must NOT stretch the axis — it is not in
    // the figure, so it is not on the graph either.
    policyIn('lapsed', { id: 'l3', draft: '2024-01-01' }),
  ];
  const s = spec('lifetime', book);
  assert.equal(s.unit, 'month');
  assert.deepEqual(s.buckets.map(b => b.label), ["May '26", "Jun '26", "Jul '26"]);
  assert.deepEqual(s.buckets.map(b => b.isNow), [false, false, true]);

  // A book with no issued policy still yields one renderable bucket.
  const bare = spec('lifetime', []);
  assert.equal(bare.buckets.length, 1);
  assert.equal(bare.unit, 'month');
});

test('🔴 THE SERIES IS CUMULATIVE, AND ITS LAST VALUE IS THE CARD', () => {
  const book = [
    policyIn('issued', { id: 'g1', draft: '2026-07-02', ap: 500 }),
    policyIn('paid',   { id: 'g2', draft: '2026-07-02', ap: 250 }),
    policyIn('issued', { id: 'g3', draft: '2026-07-20', ap: 1000 }),
    policyIn('lapsed', { id: 'g4', draft: '2026-07-05', ap: 9999 }),
    policyIn('pending', { id: 'g5', draft: '2026-07-06', ap: 8888 }),
  ];
  const s = B.bosChartSpec('monthly', B.summaryPeriodRange('monthly', TODAY), TODAY, book);
  const series = B.bosChartSeries(book, s);

  // Non-decreasing: the line only ever climbs inside the window drawn.
  series.points.forEach((p, i) => {
    if (i === 0) return;
    assert.ok(p.cumulative >= series.points[i - 1].cumulative,
      `the running total fell at bucket ${i} (${p.label}) — a cumulative line must not descend`);
  });

  // THE assertion that catches the graph and the card disagreeing.
  assert.equal(series.total, B.bosIssuedAP(book, s.window),
    'the graph and the Personal issued AP card must be the same number');
  assert.equal(series.total, 1750);
  assert.equal(series.points[series.points.length - 1].cumulative, 1750);
  assert.equal(series.max, 1750);

  // And it is the same for every period shape, against that shape's own window.
  ['daily', 'weekly', 'monthly', 'lifetime', 'month:2026-07', 'custom:2026-07-01:2026-07-31']
    .forEach(key => {
      const sp = B.bosChartSpec(key, B.summaryPeriodRange(key, TODAY), TODAY, book);
      const se = B.bosChartSeries(book, sp);
      assert.equal(se.total, B.bosIssuedAP(book, sp.window),
        `the ${key} graph disagrees with bosIssuedAP over its own window`);
    });
});

test('all-zero, single-bucket and empty inputs each return a renderable series', () => {
  const noNaN = (s, what) => {
    assert.ok(Number.isFinite(s.total), `${what}: total must be a number, got ${s.total}`);
    assert.ok(Number.isFinite(s.max), `${what}: max must be a number, got ${s.max}`);
    s.points.forEach(p => {
      assert.ok(Number.isFinite(p.value), `${what}: a bucket value was ${p.value}`);
      assert.ok(Number.isFinite(p.cumulative), `${what}: a cumulative was ${p.cumulative}`);
    });
  };

  // All zero — a real window, no issued production.
  const zero = B.bosChartSeries([], B.bosChartSpec('monthly', B.summaryPeriodRange('monthly', TODAY), TODAY, []));
  assert.equal(zero.points.length, 31);
  assert.equal(zero.total, 0);
  assert.equal(zero.empty, true, 'the renderer needs to know to draw a baseline and a sentence');
  noNaN(zero, 'all-zero');

  // A single bucket — no (n - 1) to divide by.
  const one = B.bosChartSeries([policyIn('issued', { draft: '2026-07-15' })],
    { unit: 'day', buckets: [{ start: new Date(2026, 6, 15), end: new Date(2026, 6, 16), label: 'Jul 15', isNow: true }],
      window: { start: new Date(2026, 6, 15), end: new Date(2026, 6, 16) } });
  assert.equal(one.points.length, 1);
  assert.equal(one.total, AP);
  noNaN(one, 'single-bucket');

  // No policies at all, and outright rubbish.
  [null, undefined, [], [{}], [{ status: 'issued' }], [{ status: 'issued', ap: 'x', draft: 'nonsense' }]]
    .forEach(pols => {
      const s = B.bosChartSeries(pols, B.bosChartSpec('weekly', B.summaryPeriodRange('weekly', TODAY), TODAY, pols));
      noNaN(s, `pols=${JSON.stringify(pols)}`);
      assert.equal(s.total, 0);
    });

  // And a spec with no buckets at all does not throw on the way past.
  const none = B.bosChartSeries([], { buckets: [], window: {} });
  assert.deepEqual(none.points, []);
  assert.equal(none.total, 0);
  assert.equal(none.empty, true);

  assert.match(B.BOS_EMPTY_CHART, /No issued production in this period/);
});

test('a policy that resolves to no date at all is on no timeline, and never NaN', () => {
  // It cannot be placed, and inventing a date would move real money into a
  // month it did not happen in. FO5 note: `id: 'x'` is not a millisecond
  // stamp, so the resolver's third branch yields null rather than throwing —
  // which is the whole reason this fixture still reads 0 now that
  // bosPolicyDay() consults the id.
  const orphan = [{ id: 'x', status: 'issued', ap: 500, carrier: 'Americo' }];
  assert.equal(B.bosIssuedAP(orphan, UNBOUNDED), 0);
  assert.equal(B.bosPolicyDay(orphan[0]), null);
  assert.equal(B.bosInRange(null, UNBOUNDED), false);
  assert.equal(B.bosDay('nonsense'), null);
  assert.equal(B.bosIso('nonsense'), null);
  assert.equal(B.bosIso(new Date(2026, 0, 3)), '2026-01-03');
});

// ---- FO5: which month a policy belongs to -------------------------------
//
// Round 4 bucketed this screen on `p.draft`. The Ledger Summary has always
// bucketed on dateSubmitted -> draft -> id, so a policy submitted in one month
// and drafting in the next appeared in two different months on two screens one
// sidebar toggle apart. Both now go through ppProductionDate(). The full
// consolidation — including the equivalence proof that the Front Office did
// NOT move — is test/production-date.test.mjs; what belongs here is that this
// screen's own fixtures, cards, mix and chart moved together.

/**
 * Submitted in June, drafts in July. The policy the round exists for.
 *
 * Built explicitly rather than through policyIn(), which carries no
 * dateSubmitted — and deliberately still does not, so that every other fixture
 * in this file remains a branch-2 (draft-only) policy and goes on proving the
 * common case did not move.
 */
const straddler = (o = {}) => ({
  id: o.id || 'straddle', client: 'C',
  carrier: o.carrier === undefined ? 'Americo' : o.carrier,
  ap: o.ap === undefined ? 3000 : o.ap, commPct: 100,
  dateSubmitted: o.dateSubmitted || '2026-06-27',
  draft: o.draft || '2026-07-10',
  status: o.status || 'issued',
});
const JUNE = { start: new Date(2026, 5, 1), end: new Date(2026, 6, 1) };
const JULY = { start: new Date(2026, 6, 1), end: new Date(2026, 7, 1) };

test('🔴 THE SUBMITTED MONTH IS THE MONTH — draft no longer decides', () => {
  const book = [straddler({ dateSubmitted: '2026-06-27' })];
  assert.equal(B.bosPolicyDay(book[0]), '2026-06-27');
  assert.equal(B.bosIssuedAP(book, JUNE), 3000, 'counted in June, where it was sold');
  assert.equal(B.bosIssuedAP(book, JULY), 0, 'and not in July, where it merely drafts');
  assert.equal(B.bosIssuedCount(book, JUNE), 1);
  assert.equal(B.bosIssuedCount(book, JULY), 0);
});

test('every fixture that only has a draft date is UNCHANGED by FO5', () => {
  // Branch 2 of the resolver. This is the shape of most of this file's
  // fixtures and of most of the production book, and it must not have moved.
  const book = FULL_BOOK;                       // all draft: '2026-07-10'
  assert.equal(B.bosIssuedAP(book, JULY), AP * 2, 'issued + paid, as before');
  assert.equal(B.bosIssuedAP(book, JUNE), 0);
  assert.equal(B.bosPolicyDay(book[0]), '2026-07-10');
});

test('the cards, the carrier mix and the chart move together, not separately', () => {
  // One resolver means they cannot disagree. Same book, same two windows.
  const book = [
    straddler({ id: 's1', dateSubmitted: '2026-06-27', ap: 3000, carrier: 'Americo' }),
    policyIn('issued', { id: 's2', draft: '2026-07-10', ap: 1200, carrier: 'Foresters' }),
  ];

  const mixJun = B.bosCarrierMix(book, JUNE);
  assert.equal(mixJun.total, B.bosIssuedAP(book, JUNE));
  assert.equal(mixJun.total, 3000);
  assert.deepEqual(mixJun.rows.map(r => r.label), ['Americo']);

  const mixJul = B.bosCarrierMix(book, JULY);
  assert.equal(mixJul.total, B.bosIssuedAP(book, JULY));
  assert.equal(mixJul.total, 1200);
  assert.deepEqual(mixJul.rows.map(r => r.label), ['Foresters']);

  // And the chart, over its own window — the FO4 assertion, re-run on a book
  // where the two date fields disagree.
  ['month:2026-06', 'month:2026-07', 'lifetime'].forEach(key => {
    const sp = B.bosChartSpec(key, B.summaryPeriodRange(key, TODAY), TODAY, book);
    const se = B.bosChartSeries(book, sp);
    assert.equal(se.total, B.bosIssuedAP(book, sp.window),
      `the graph and the card disagree on ${key}`);
    se.points.forEach((p, i) => {
      if (i === 0) return;
      assert.ok(p.cumulative >= se.points[i - 1].cumulative,
        `the running total fell at bucket ${i} on ${key}`);
    });
  });

  // The June bar sits on the 27th — the submitted day — not on July 10th.
  const jun = B.bosChartSeries(book,
    B.bosChartSpec('month:2026-06', B.summaryPeriodRange('month:2026-06', TODAY), TODAY, book));
  assert.equal(jun.points.find(p => p.iso === '2026-06-27').value, 3000);
});

test('bosPolicyDay is the ONE seam — the block never reads a date field itself', () => {
  const core = stripLineComments(block('bos-chart-core'), ['//', '*', '/*']);
  assert.match(core, /function bosPolicyDay\(p\) \{ return ppProductionDate\(p\); \}/,
    'bosPolicyDay must delegate to the app’s one production-date resolver');
  assert.ok(!/p\.dateSubmitted/.test(core),
    'no field chain of its own — that is what made two screens disagree');
  assert.ok(!/\bp\.draft\b/.test(core),
    'and no bare p.draft either: `draft` is when the premium is taken, not when the policy was sold');
});

test('money on this screen goes through bosCents — never Math.max(0, Number(x || 0))', () => {
  // Round 2 shipped a real NaN bug of exactly this shape. `Number('x' || 0)`
  // is NaN and Math.max(0, NaN) is NaN too, so the obvious guard is not one.
  const core = stripLineComments(block('bos-chart-core'), ['//', '*', '/*']);
  assert.ok(!/Math\.max\(\s*0\s*,\s*Number\(/.test(core),
    'the obvious guard is not one — use bosCents / bosCount');
  assert.match(core, /bosCents\(p\.ap\)/, 'AP must be read through bosCents');

  // A junk AP is zero, not NaN, everywhere it is summed.
  const junk = [policyIn('issued', { id: 'j1', ap: 'x' }), policyIn('paid', { id: 'j2', ap: null }),
    policyIn('issued', { id: 'j3', ap: 400 })];
  assert.equal(B.bosIssuedAP(junk, UNBOUNDED), 400);
  assert.equal(B.bosCarrierMix(junk, UNBOUNDED).total, 400);
  const s = B.bosChartSeries(junk, B.bosChartSpec('lifetime', B.summaryPeriodRange('lifetime', TODAY), TODAY, junk));
  assert.equal(s.total, 400);
  assert.ok(Number.isFinite(s.max));
});

test('the bos-chart-core block is pure — no DOM, network, storage or app globals', () => {
  const body = stripLineComments(block('bos-chart-core'), ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsessionStorage\b/, /\bsb\./,
   /\bfetch\(/, /\bcurrentAgent\b/, /\bescHTML\(/, /\bshowToast\(/, /\bnav\(/,
   /\bboArea\(/, /_bosCache/, /_planTier\(/, /\bbosPeriod\b/, /_lgAdvComm/,
   /\bpolicies\s*[.[]/, /\bleads\s*[.[]/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
});

// ---- the period control -------------------------------------------------

test('🔴 THIS SCREEN WRITES pp_bos_period AND NOTHING ELSE', () => {
  const screen = APP_CODE.slice(APP_CODE.indexOf('const BOS_TTL_MS'),
    APP_CODE.indexOf('function boRefresh('));
  assert.match(screen, /const BOS_PERIOD_KEY = 'pp_bos_period'/);
  assert.match(screen, /localStorage\.setItem\(BOS_PERIOD_KEY, p\)/);
  // pp_summary_period is the Front Office Summary's and pp_team_period is the
  // Agency tab's. Clicking a chip here must not move either of those screens.
  ["'pp_summary_period'", "'pp_team_period'", "'pp_comm_range'"].forEach(k =>
    assert.ok(!screen.includes(k),
      `the Back Office Summary must not write ${k} — that is another screen's window`));
  assert.ok(!/_cmRange\s*=/.test(screen), 'nor the Commissions panel’s range');
  assert.ok(!/setLedgerPeriod\(/.test(screen) && !/teamSetPeriod\(/.test(screen),
    'nor another screen’s setter');

  // Exactly one owner of the key, in the whole file.
  assert.equal((APP_CODE.match(/'pp_bos_period'/g) || []).length, 1);
  assert.equal((APP_CODE.match(/localStorage\.setItem\(BOS_PERIOD_KEY/g) || []).length, 1);
});

test('the chips are the shared period control, and the shared engine resolves them', () => {
  const paint = APP_CODE.slice(APP_CODE.indexOf('function bosPaintPeriod()'),
    APP_CODE.indexOf('function bosOpen('));
  ["chip('daily', 'Today')", "chip('weekly', 'Weekly')",
   "chip('monthly', 'Monthly')", "chip('lifetime', 'Lifetime')"]
    .forEach(c => assert.ok(paint.includes(c), `the ${c} chip must be rendered`));
  assert.match(paint, /ppPeriodPickerHTML\(bosPeriod, 'setBosPeriod', 'bos', 'lg-chip lg-click pp-pick'\)/,
    'the month picker and custom range come from the ONE shared builder');
  assert.match(paint, /class="lg-chip lg-click/, 'the same chip markup the Ledger Summary uses');

  // Every date comes out of summaryPeriodRange(); this screen mints none.
  assert.match(APP_CODE, /function bosRange\(\) \{ return summaryPeriodRange\(bosPeriod, new Date\(\)\); \}/);
  const screen = APP_CODE.slice(APP_CODE.indexOf('const BOS_TTL_MS'),
    APP_CODE.indexOf('function boRefresh('));
  assert.ok(!/new Date\(\w+\.getFullYear\(\)/.test(screen),
    'a second window calculator is a second answer to "this month"');
  assert.equal((APP_CODE.match(/summaryPeriodRange\(bosPeriod/g) || []).length, 1,
    'one resolver, called in one place');

  // The custom-range Apply button dispatches to THIS screen's setter. Without
  // that branch it fell through to setLedgerPeriod and wrote pp_summary_period.
  const apply = APP_CODE.slice(APP_CODE.indexOf('function ppApplyRange('),
    APP_CODE.indexOf('function lgUpgrade('));
  assert.match(apply, /setter==='setBosPeriod'/);
  // And the picker's element id is this screen's, not the Front Office's — the
  // two sections are in the DOM at the same time.
  assert.match(paint, /'setBosPeriod', 'bos'/);
});

test('the period is honoured on load, and a broken stored key cannot brick the screen', () => {
  const init = APP_CODE.slice(APP_CODE.indexOf('let bosPeriod = '),
    APP_CODE.indexOf('function setBosPeriod('));
  assert.match(init, /LG_PERIODS\.includes\(v\)/);
  assert.match(init, /ppIsDynamicPeriod\(v\) && ppDynamicRange\(v\)/,
    'a stored month:/custom: key must survive a reload — teaching only the setter ' +
    'is what made a picked window silently revert on the next page load');
  assert.match(init, /return BOS_PERIOD_DEFAULT/);

  const setter = APP_CODE.slice(APP_CODE.indexOf('function setBosPeriod('),
    APP_CODE.indexOf('function bosRange()'));
  assert.match(setter, /if \(ppIsDynamicPeriod\(p\) && !ppDynamicRange\(p\)\) return;/,
    'a key that does not resolve must be refused rather than stored');

  // The engine really does understand all six shapes handed to it.
  ['daily', 'weekly', 'monthly', 'lifetime', 'month:2026-04', 'custom:2026-04-01:2026-04-17']
    .forEach(key => {
      const r = B.summaryPeriodRange(key, TODAY);
      assert.ok(r && 'start' in r && 'end' in r, `summaryPeriodRange did not resolve ${key}`);
    });
  assert.equal(B.summaryPeriodRange('lifetime', TODAY).start, null, 'lifetime is unbounded');
});

// ---- top producers, and the leaderboard invariants ---------------------

test('🔴 TOP PRODUCERS GOES THROUGH lbLoadBoards(), THE ONE CALL SITE', () => {
  // Still one. A second is a second set of window arguments, and two sets of
  // window arguments is two answers to "how did I do this month".
  const hits = APP_CODE.match(/sb\.rpc\(\s*['"]get_agency_leaderboards['"]/g) || [];
  assert.equal(hits.length, 1, 'two call sites is two sets of window arguments');

  const fn = APP_CODE.slice(APP_CODE.indexOf('async function renderBackOfficeSummary('),
    APP_CODE.indexOf('function bosPaint('));
  assert.match(fn, /lbLoadBoards\(bosPeriod, LB_BASIS_DEFAULT, false, win\)/,
    'the Back Office Summary must reach the boards through lbLoadBoards()');
  assert.ok(!/get_agency_leaderboards|lb_board_rows|lb_visible_members|from\('agents'\)/.test(fn),
    'querying around lbLoadBoards() loses lb_visible_members() — the single ' +
    'enforcement point for the leaderboard opt-out');

  // The optional range DEFAULTS to today's behaviour, byte for byte.
  const load = APP_CODE.slice(APP_CODE.indexOf('async function lbLoadBoards('),
    APP_CODE.indexOf('async function lbRefreshMe'));
  assert.match(load, /rangeOverride \|\| teamPeriodRange\(periodKey, new Date\(\)\)/,
    'omitting the range must leave the Agency tab exactly as it was');
  assert.match(load, /lbRangeKey\(range\)/,
    'the cache must be keyed by the RANGE — two windows behind one period name ' +
    'is how two screens serve each other a stale board');
  // lbRangeKey reads bounds; it mints nothing.
  const key = APP_CODE.slice(APP_CODE.indexOf('function lbRangeKey('),
    APP_CODE.indexOf('async function lbAgencyState('));
  assert.ok(!/new Date\(/.test(key), 'lbRangeKey must not mint a date of its own');
  // And the Agency tab's own call site is untouched.
  assert.match(APP_CODE, /lbLoadBoards\(_teamPeriod, _lbBasis\)/);
});

test('the top-producers card never re-derives the top-10 cutoff', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosTopProducersHTML()'),
    APP_CODE.indexOf('function bosAttentionHTML()'));
  assert.ok(fn.length > 0, 'bosTopProducersHTML() must exist');
  // It renders through lbBoardHTML(), which splits with lbSplitRows() — and
  // lbSplitRows trusts in_top. This card must not start filtering ranks.
  assert.match(fn, /lbBoardHTML\(/);
  assert.ok(!/rank\s*[<>]=?/.test(fn), 'the cutoff is enforced by the SERVER, not here');
  const split = APP_CODE.slice(APP_CODE.indexOf('function lbSplitRows('),
    APP_CODE.indexOf('function lbGapText('));
  assert.ok(!/LB_TOP_N/.test(split), 'lbSplitRows must trust in_top, not re-derive the cutoff');
  // It may NAME the rule in its own copy — that is the sentence on screen.
  assert.match(fn, /Only the top/);
});

test('🔴 NO AGENCY MEANS NO CARD — not an empty one, not an upsell', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosTopProducersHTML()'),
    APP_CODE.indexOf('function bosAttentionHTML()'));
  assert.match(fn, /if \(!st \|\| st\.unavailable \|\| !st\.leader_id\) return '';/);
  assert.ok(fn.indexOf('leader_id') < fn.indexOf('bos-strip'),
    'the gate is checked BEFORE anything is built');
  assert.ok(!/showUpgradeGate|upsell|locked/i.test(fn), 'no upgrade gate lives on this card');
  assert.ok(!/display:\s*none/.test(fn), 'a hidden card is still a card in the DOM');
  // It is visible to everyone in an agency — NOT gated on plan tier or on
  // being the leader, unlike the team strip below it.
  assert.ok(!/_planTier\(\)/.test(fn), 'everyone in an agency sees where they stand');
  // And it says out loud that it counts differently from the card above.
  assert.match(fn, /will not match your issued figure above/);
});

test('the leaderboard still owns no period engine, and pp_team_period is untouched', () => {
  // The CALLER supplies the window — which is what the Agency tab already does
  // implicitly. What the boards must never grow is date arithmetic of their own.
  const lbBlock = APP.slice(APP.indexOf('// <leaderboard-core>'), APP.indexOf('async function lbRenderFame'));
  assert.ok(!/getDay\(\)/.test(lbBlock), 'week-start arithmetic belongs to the period engines alone');
  const screen = APP_CODE.slice(APP_CODE.indexOf('const BOS_TTL_MS'),
    APP_CODE.indexOf('function boRefresh('));
  assert.ok(!/pp_team_period/.test(screen),
    'steering the board by writing the Agency tab’s key would move the Agency tab');
  assert.equal((APP_CODE.match(/localStorage\.setItem\('pp_team_period'/g) || []).length, 1);
});

// ---- the empty state, and what replaced it -----------------------------

test('🔴 THE PAGE-LEVEL STATEMENT EMPTY STATE IS GONE', () => {
  const paint = APP_CODE.slice(APP_CODE.indexOf('function bosPaint()'),
    APP_CODE.indexOf('function bosShellHTML()'));
  // The Round 2 branch — statements alone blanking the whole screen — must not
  // come back. An owner with a full book got a welcome mat.
  assert.ok(!/bosIsEmpty\(_bosCache\.ingest\)\)\s*\{\s*_bosCache\.empty/.test(paint));
  assert.match(paint, /if \(bosIsBrandNew\(\)\)/);

  const brand = APP_CODE.slice(APP_CODE.indexOf('function bosIsBrandNew()'),
    APP_CODE.indexOf('function bosShellHTML()'));
  assert.match(brand, /if \(pols\.length > 0\) return false;/,
    'one policy is enough for this screen to have something to say');
  assert.match(brand, /bosIsEmpty\(_bosCache\.ingest\)/,
    'and it still has to be true that no statement exists either');

  // The empty panel now points at the policy book, not at statement upload.
  const empty = APP_CODE.slice(APP_CODE.indexOf('function bosEmptyHTML()'),
    APP_CODE.indexOf('async function boRefresh('));
  // Written escaped inside a JS string literal, so the source text carries the
  // backslashes: onclick="nav(\'tracker\')".
  assert.match(empty, /nav\(\\?'tracker\\?'\)/);
  assert.ok(!/nav\(\\?'backoffice\\?'\)/.test(empty),
    'the welcome mat must not send a brand-new agent to statement upload');
});

test('the window is captioned by what it IS, not by the comparison it enables', () => {
  // summaryPeriodRange() labels a window for the Front Office Summary, which
  // renders a delta against it — "This month vs last month". This screen shows
  // no delta, so that caption would describe something not on the page.
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosPeriodLabel()'),
    APP_CODE.indexOf('async function renderBackOfficeSummary('));
  assert.match(fn, /return 'Today';/);
  assert.match(fn, /return 'This week';/);
  assert.match(fn, /return 'This month';/);
  assert.match(fn, /return 'All time';/);
  assert.match(fn, /ppDynamicRange\(bosPeriod\)/,
    'a picked month or custom range already labels itself');
  assert.ok(!/vs last/.test(fn));

  const screen = APP_CODE.slice(APP_CODE.indexOf('const BOS_TTL_MS'),
    APP_CODE.indexOf('function boRefresh('));
  assert.ok(!/win\.label/.test(screen) && !/bosRange\(\)\.label/.test(screen),
    'the comparison label must not reach the screen');
  // All three surfaces that name the window use the one helper: the chip row's
  // caption, the graph's header, and the top-producers board.
  assert.match(screen, /class="bos-chips-cap">' \+ escHTML\(bosPeriodLabel\(\)\)/);
  assert.match(screen, /Running total &middot; ' \+ escHTML\(bosPeriodLabel\(\)\)/);
  assert.match(screen, /lbBoardHTML\(entry\.boards\[def\.key\], def, bosPeriodLabel\(\)\)/);
  // One definition, three uses — nothing else may name the window.
  assert.equal((screen.match(/bosPeriodLabel\(\)/g) || []).length, 4);
});

test('🔴 THE MONEY STRIP SAYS SO WHEN THERE ARE NO STATEMENTS — never four $0.00s', () => {
  // All four figures come off a statement, so with none uploaded "$0.00" reads
  // as "the carriers paid you nothing" rather than "we have not been told yet".
  // Same rule as the Commission paid card. This is Round 2's page-level empty
  // state, scoped to the one strip it was ever actually about.
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosMoneyHTML()'),
    APP_CODE.indexOf('function bosProductionHTML()'));
  assert.match(fn, /bosState\('ingest'\) === 'ok' && bosIsEmpty\(_bosCache\.ingest\)/);
  assert.match(fn, /No carrier statements uploaded yet/);
  // The gate comes BEFORE any card is built, or the zeroes render anyway.
  assert.ok(fn.indexOf('bosIsEmpty(_bosCache.ingest)') < fn.indexOf('bosMoneyCards('));
  // And it opens the upload panel, which is boArea's 'ingest'.
  assert.match(fn, /bosOpen\(\\?'ingest\\?'\)/);
});

test('the policy-derived strips render above the statement-derived ones', () => {
  const shell = APP_CODE.slice(APP_CODE.indexOf('function bosShellHTML()'),
    APP_CODE.indexOf('function bosPaintPeriod()'));
  const order = ['bos-periods', 'bos-production', 'bos-chart', 'bos-mix', 'bos-top',
    'bos-money', 'bos-attention', 'bos-health', 'bos-team'];
  let last = -1;
  order.forEach(id => {
    const at = shell.indexOf('"' + id + '"');
    assert.ok(at > last, `${id} must render after ${order[order.indexOf(id) - 1] || 'the top'}`);
    last = at;
  });
  // Round 2's reconciliation and persistency strips are KEPT, unchanged, below.
  assert.match(shell, /bos-strip-t">What needs you/);
  assert.match(shell, /bos-strip-t">Book health/);
  assert.match(APP_CODE, /set\('bos-attention', bosAttentionHTML\(\)\)/);
  assert.match(APP_CODE, /set\('bos-health', bosHealthHTML\(\)\)/);
  // Including the debt rule, which lives on the money strip.
  assert.match(APP_CODE, /note: BOS_DEBT_NOTE/);
});

test('the new markup is token-only — no hard-coded hex anywhere in it', () => {
  const fns = ['bosProductionHTML', 'bosChartHTML', 'bosMixHTML', 'bosTopProducersHTML',
    'bosPaintPeriod', 'bosShellHTML'];
  fns.forEach(name => {
    const at = APP.indexOf(`function ${name}(`);
    assert.ok(at > -1, `${name}() must exist`);
    const open = APP.indexOf('{', at);
    let depth = 0, end = -1;
    for (let i = open; i < APP.length; i++) {
      if (APP[i] === '{') depth++;
      else if (APP[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = APP.slice(at, end);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body),
      `${name}() carries a hard-coded colour, which does not follow the reader into dark mode`);
  });
  // The graph is hand-rolled: no library, no <script src>, no canvas.
  const chart = APP_CODE.slice(APP_CODE.indexOf('function bosChartHTML()'),
    APP_CODE.indexOf('function bosMixHTML()'));
  assert.match(chart, /<svg class="bos-chart"/);
  assert.ok(!/canvas|Chart\.|d3\.|import\(/.test(chart), 'no chart library — none was added');
  assert.match(chart, /role="img"/, 'a chart with no accessible name is a picture of nothing');
});

test('🔴 STILL NO NEW BACKEND — including what the new card reads indirectly', () => {
  // The direct calls are pinned above. These two are reached through
  // lbAgencyState() and lbLoadBoards(); both shipped with 20260750, and both
  // are named here so "no new backend" is checked rather than assumed.
  ['lb_my_agency_state', 'get_agency_leaderboards'].forEach(rpc =>
    assert.ok(APP_CODE.includes(`sb.rpc('${rpc}')`) || APP_CODE.includes(`sb.rpc('${rpc}',`),
      `${rpc} must already exist — this round adds no migration`));
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function renderBackOfficeSummary('),
    APP_CODE.indexOf('function bosPaint('));
  assert.ok(!/from\('commission_rows'\)/.test(fn));
  assert.ok(!/from\('policies'\)/.test(fn),
    'the book is already in memory — bootDashboard() hydrated it');
});
