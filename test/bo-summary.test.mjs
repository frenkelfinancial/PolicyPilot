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
  // From the blocks bo-summary-core declares a dependency on, so the tests can
  // prove the delegation rather than assume it.
  'COMM_CARD_DEFS', 'COMM_RANGES', 'commRange', 'commTotals', 'RECON_QUEUES',
  'persistBand', 'persistBandLabel',
];

function block(name) {
  const m = APP.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`));
  assert.ok(m, `app.html must contain the // <${name}> ... // </${name}> block`);
  return m[1];
}

function loadCore() {
  const src = [
    block('comm-core'), block('persist-core'), block('recon-core'), block('bo-summary-core'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

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
  assert.match(B.BOS_EMPTY_BODY, /Drop your first carrier statement in and this screen fills itself in\./);
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
   'vcamp-core', 'leadfilter-core', 'bo-summary-core'].forEach(name => {
    assert.equal((APP.match(new RegExp(`// <${name}>`, 'g')) || []).length, 1, `// <${name}>`);
    assert.equal((APP.match(new RegExp(`// </${name}>`, 'g')) || []).length, 1, `// </${name}>`);
  });
});

test('the range chips are the shared COMM_RANGES, and there is no fourth', () => {
  assert.deepEqual(B.COMM_RANGES.map(r => r.key), ['mtd', 'ytd', 'all']);
  const paint = APP_CODE.slice(APP_CODE.indexOf('function bosPaintRanges()'),
    APP_CODE.indexOf('function bosOpen('));
  assert.match(paint, /COMM_RANGES\.map/);
  assert.match(paint, /class="tracker-tab/, 'the same chip markup the Commissions panel uses');
  // One range calculator, one memory: bosSetRange writes the key cmRender reads.
  const setter = APP_CODE.slice(APP_CODE.indexOf('function bosSetRange('),
    APP_CODE.indexOf('function _bosRosterDownline('));
  assert.match(setter, /_cmRange = k/);
  assert.match(setter, /'pp_comm_range'/);
  assert.ok(!/new Date\(\w*\.getFullYear/.test(setter), 'no second range calculator');
});

test('the screen uses design tokens only — no hard-coded colour in its own CSS', () => {
  const css = APP.slice(APP.indexOf('/* ---- Back Office Summary'),
    APP.indexOf('/* ---- Reconciliation (Phase 6) ---- */'));
  assert.ok(css.length > 0, 'the Back Office Summary CSS block must exist');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css),
    'a hard-coded hex does not follow the reader into dark mode');
  assert.match(css, /var\(--lg-/);
});
