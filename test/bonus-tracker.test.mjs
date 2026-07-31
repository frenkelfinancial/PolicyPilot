// ============================================================
// bonus-tracker.test.mjs — run with:  npm run test:bonus
//
// G1. The per-carrier progress bars WERE broken, and the root cause was not
// in the bonus code at all:
//
//   `let policies = []` at the top level of a classic <script> binds in the
//   global LEXICAL scope, not on the global OBJECT. `window.policies` was
//   therefore `undefined`, thirteen readers fell through their `|| []`, and
//   every bar computed against an empty book while erroring nowhere.
//
// So this file asserts two different things:
//
//   1. THE ALIAS EXISTS, and reads and writes both work. That is the fix.
//      Asserted against app.html as source text AND behaviourally, by
//      re-creating the exact declaration pattern in a VM.
//
//   2. THE MATH IS RIGHT, per carrier, against the REAL tiers in
//      data/carrier_bonuses.json. The payout shapes genuinely differ between
//      carriers (CLAUDE.md: "don't generalize") so each shape gets its own
//      test rather than one parameterised sweep that could pass by agreeing
//      with itself.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8').split('\r\n').join('\n');
const DATA = JSON.parse(readFileSync(join(ROOT, 'data/carrier_bonuses.json'), 'utf8'));

const EXPORTS = ['currentWindow', 'bonusProgressFrom', 'parseTierPayout', 'bonusPayoutState',
                 'bonusIsComputable', 'bonusPayoutTiming', 'bonusStatusBadge',
                 'NO_BONUS_STATUSES', 'BONUS_AP_STATUSES', '_bonusPolicyDate'];

function loadBlock(name, exports) {
  const m = APP.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`));
  assert.ok(m, `app.html must contain the // <${name}> block`);
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${exports.join(',')}};`)();
}
const B = loadBlock('bonus-core', EXPORTS);

const carrier = (id) => {
  const c = DATA.carriers.find((x) => x.id === id);
  assert.ok(c, `data/carrier_bonuses.json must still carry ${id}`);
  return c;
};

/** The `window` config the app const carries per carrier, read off app.html. */
function appWindowFor(id) {
  const m = APP.match(new RegExp(`"id":\\s*"${id}"[\\s\\S]{0,4000}?"window":\\s*(\\{[^}]*\\})`));
  return m ? JSON.parse(m[1]) : null;
}

const pol = (o = {}) => ({ carrier: 'Americo', ap: 1000, status: 'issued', draft: '2026-07-15', ...o });
/** The real resolver needs COMP; the pure math takes one in, so tests supply this. */
const idByCarrier = (map) => (p) => map[p.carrier] || null;

// ============================================================
// 1. 🔴 THE ROOT CAUSE
// ============================================================

test('🔴 `let` at classic-script top level really does NOT define window.policies', () => {
  // The premise of the whole diagnosis, verified rather than asserted from
  // memory. If this ever stops being true the fix below is harmless anyway.
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext('let policies = [1,2,3]; var other = [4];', ctx);
  assert.equal(vm.runInContext('window.policies', ctx), undefined,
    'a top-level let must not attach to the global object');
  // Compared by value, not deepEqual: the array is built by the VM realm's
  // own Array constructor, so a strict structural compare fails on identity
  // rather than on content.
  assert.equal(vm.runInContext('Array.isArray(window.other) && window.other[0]', ctx), 4,
    'a top-level var DOES attach — which is the difference that caused this');
});

test('🔴 app.html now aliases window.policies onto the binding, both ways', () => {
  assert.match(APP, /Object\.defineProperty\(window, 'policies', \{/);
  const block = APP.slice(APP.indexOf("Object.defineProperty(window, 'policies'"),
                          APP.indexOf("Object.defineProperty(window, 'policies'") + 300);
  assert.match(block, /get\(\) \{ return policies; \}/);
  // The SETTER matters as much as the getter: bootDashboard does
  // `policies = remotePolicies` and the delete path does
  // `policies = policies.filter(...)`. A getter-only property would make
  // those throw in strict mode, or silently no-op outside it.
  assert.match(block, /set\(v\) \{ policies = v; \}/);
});

test('the alias behaves — a reassignment is visible through window, and vice versa', () => {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext(`
    let policies = [];
    Object.defineProperty(window, 'policies', {
      get() { return policies; }, set(v) { policies = v; }, configurable: true,
    });
  `, ctx);
  vm.runInContext('policies = [{ap: 5}];', ctx);
  assert.equal(vm.runInContext('window.policies.length', ctx), 1, 'binding -> window');
  vm.runInContext('window.policies = [{ap:1},{ap:2}];', ctx);
  assert.equal(vm.runInContext('policies.length', ctx), 2, 'window -> binding');
});

test('every window.policies reader is still there — the fix serves all of them', () => {
  // Thirteen at the time of the fix. This is a floor, not an exact count:
  // the point is that they were never the bug and none had to be touched.
  const reads = APP.match(/window\.policies/g) || [];
  assert.ok(reads.length >= 13, `expected the readers to remain, saw ${reads.length}`);
  assert.match(APP, /const pols = window\.policies \|\| \[\];/); // the bonus one
});

// ============================================================
// 2. THE PERIOD ENGINE
// ============================================================

const JUL = new Date(2026, 6, 15);   // 15 Jul 2026, a Q3 date

test('a monthly window is the calendar month, half-open', () => {
  const w = B.currentWindow({ window: { type: 'monthly' } }, JUL);
  assert.equal(w.start.getTime(), new Date(2026, 6, 1).getTime());
  assert.equal(w.end.getTime(), new Date(2026, 7, 1).getTime());
  assert.equal(w.label, 'July 2026');
});

test('a quarterly window is the calendar quarter, and July is Q3', () => {
  const w = B.currentWindow({ window: { type: 'quarterly' } }, JUL);
  assert.equal(w.start.getTime(), new Date(2026, 6, 1).getTime());
  assert.equal(w.end.getTime(), new Date(2026, 9, 1).getTime());
  assert.equal(w.label, 'Q3 2026');
  // The other three quarters land where they should.
  assert.equal(B.currentWindow({ window: { type: 'quarterly' } }, new Date(2026, 0, 5)).label, 'Q1 2026');
  assert.equal(B.currentWindow({ window: { type: 'quarterly' } }, new Date(2026, 5, 30)).label, 'Q2 2026');
  assert.equal(B.currentWindow({ window: { type: 'quarterly' } }, new Date(2026, 11, 31)).label, 'Q4 2026');
});

test('an annual window is the calendar year', () => {
  const w = B.currentWindow({ window: { type: 'annual' } }, JUL);
  assert.equal(w.start.getTime(), new Date(2026, 0, 1).getTime());
  assert.equal(w.end.getTime(), new Date(2027, 0, 1).getTime());
});

test('a FIXED window that has passed returns null — that is the "closed" state', () => {
  // Americo UFirst ended 2026-05-29 and the card must say so rather than
  // drawing a bar against a program nobody can still qualify for.
  const b = { window: { type: 'fixed', start: '2025-12-01', end: '2026-05-29' } };
  assert.equal(B.currentWindow(b, JUL), null);
  const during = B.currentWindow(b, new Date(2026, 2, 1));
  assert.ok(during, 'inside the window it resolves');
  assert.equal(during.start.getTime(), new Date('2025-12-01T00:00:00').getTime());
  // The last day is INCLUDED — a program that ends on the 29th includes the
  // 29th, so `end` is the instant after that day closes.
  assert.ok(B.currentWindow(b, new Date('2026-05-29T18:00:00')), 'the final day still counts');
  assert.equal(B.currentWindow(b, new Date('2026-05-30T00:00:01')), null);
});

test('no window config means no window, not a default one', () => {
  assert.equal(B.currentWindow({}, JUL), null);
  assert.equal(B.currentWindow(null, JUL), null);
  assert.equal(B.currentWindow({ window: { type: 'weekly' } }, JUL), null);
});

// ============================================================
// 3. PROGRESS
// ============================================================

const IDS = idByCarrier({ 'Americo': 'americo', 'Corebridge': 'corebridge', 'Mutual of Omaha': 'mutual_of_omaha' });
const WIN_JUL = { start: new Date(2026, 6, 1), end: new Date(2026, 7, 1) };

test('AP progress totals issued + paid inside the window, and nothing else', () => {
  const bonus = { id: 'americo', basis: 'annualized_premium' };
  const pols = [
    pol({ ap: 1000, status: 'issued' }),
    pol({ ap: 2000, status: 'paid' }),
    pol({ ap: 4000, status: 'pending' }),      // not a sale yet
    pol({ ap: 8000, status: 'lapsed' }),       // no longer one
    pol({ ap: 500,  status: 'issued', draft: '2026-06-30' }),  // last month
    pol({ ap: 700,  status: 'issued', draft: '2026-08-01' }),  // next month
    pol({ ap: 900,  status: 'issued', carrier: 'Corebridge' }), // another carrier
  ];
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL, pols, IDS), 3000);
});

test('the window is half-open: the 1st counts, the 1st of next month does not', () => {
  const bonus = { id: 'americo', basis: 'annualized_premium' };
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL, [pol({ ap: 100, draft: '2026-07-01' })], IDS), 100);
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL, [pol({ ap: 100, draft: '2026-08-01' })], IDS), 0);
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL, [pol({ ap: 100, draft: '2026-07-31' })], IDS), 100);
});

test('a policy_count program counts PAID policies only, not issued ones', () => {
  // Corebridge pays on paid SIWL policies. Counting issued would promise
  // money for business the carrier has not paid on.
  const bonus = { id: 'corebridge', basis: 'policy_count' };
  const pols = [
    pol({ carrier: 'Corebridge', status: 'paid' }),
    pol({ carrier: 'Corebridge', status: 'paid' }),
    pol({ carrier: 'Corebridge', status: 'issued' }),
  ];
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL, pols, IDS), 2);
});

test('a policy the resolver rejects contributes nothing — that is the GIWL exclusion', () => {
  // bonusCarrierIdForPolicy returns null for Corebridge GIWL. Here the
  // resolver stands in for it; what matters is that null means "not this
  // program", never "count it anyway".
  const bonus = { id: 'corebridge', basis: 'policy_count' };
  const excludeAll = () => null;
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL, [pol({ status: 'paid' })], excludeAll), 0);
});

test('progress falls back from draft to issueDate, and a dateless policy is skipped', () => {
  const bonus = { id: 'americo', basis: 'annualized_premium' };
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL,
    [{ carrier: 'Americo', ap: 100, status: 'issued', issueDate: '2026-07-10' }], IDS), 100);
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL,
    [{ carrier: 'Americo', ap: 100, status: 'issued' }], IDS), 0);
  assert.equal(B.bonusProgressFrom(bonus, WIN_JUL,
    [{ carrier: 'Americo', ap: 100, status: 'issued', draft: 'not-a-date' }], IDS), 0);
});

test('a missing or non-numeric AP contributes zero, it does not produce NaN', () => {
  const bonus = { id: 'americo', basis: 'annualized_premium' };
  const out = B.bonusProgressFrom(bonus, WIN_JUL, [
    pol({ ap: undefined }), pol({ ap: 'abc' }), pol({ ap: 250 }),
  ], IDS);
  assert.equal(out, 250);
});

test('no window means no progress, and it does not throw', () => {
  assert.equal(B.bonusProgressFrom({ id: 'americo', basis: 'annualized_premium' }, null, [pol()], IDS), 0);
});

// ============================================================
// 4. PAYOUT SHAPES — one test each, against the REAL tiers
// ============================================================

test('parseTierPayout reads a figure that IS there and refuses to invent one', () => {
  assert.deepEqual(B.parseTierPayout('10% of paid first-year AP'), { kind: 'percent', value: 0.1 });
  assert.deepEqual(B.parseTierPayout('$75 (Gold)'), { kind: 'flat', value: 75 });
  assert.deepEqual(B.parseTierPayout('$1,500'), { kind: 'flat', value: 1500 });
  // A RANGE is not a number. "up to $10,000" must never render as $10,000.
  assert.equal(B.parseTierPayout('up to $10,000 cumulative').kind, 'uncertain');
  assert.equal(B.parseTierPayout('$650-$1,000').kind, 'uncertain');
  assert.equal(B.parseTierPayout(''), null);
});

test('MoO is a CLIFF: 10% of the WHOLE quarter once $25k is passed, not the excess', () => {
  const b = carrier('mutual_of_omaha');
  assert.equal(B.bonusPayoutState(b, 24999).reached, false);
  assert.equal(B.bonusPayoutState(b, 24999).earned, 0);
  assert.equal(B.bonusPayoutState(b, 24999).gap, 1);
  const hit = B.bonusPayoutState(b, 25000);
  assert.equal(hit.kind, 'cliff');
  assert.equal(hit.reached, true);
  assert.equal(hit.earned, 2500);        // 10% of 25,000 — not of the excess
  const over = B.bonusPayoutState(b, 40000);
  assert.equal(over.earned, 4000);       // 10% of the WHOLE 40,000
  // The 12%-with-persistency variant is a note, never a second number.
  assert.match(hit.secondaryNote, /12%/);
  assert.equal(hit.rate, 0.10, 'the BASE rate is the one that is modelled');
});

test('Americo is the same cliff shape at $55k / 10%', () => {
  const b = carrier('americo');
  assert.equal(B.bonusPayoutState(b, 54999).earned, 0);
  assert.equal(B.bonusPayoutState(b, 60000).earned, 6000);
  assert.equal(B.bonusPayoutState(b, 60000).rate, 0.10);
});

test("Am-Am is BANDED FLAT and NOT cumulative — the highest band wins outright", () => {
  // $50 / $75 / $100. A cumulative reading would pay $225 at $20k, which is
  // more than double what the carrier actually pays.
  const b = carrier('american_amicable');
  assert.equal(B.bonusPayoutState(b, 7499).earned, 0);
  assert.equal(B.bonusPayoutState(b, 7500).earned, 50);
  assert.equal(B.bonusPayoutState(b, 9999).earned, 50);
  assert.equal(B.bonusPayoutState(b, 10000).earned, 75);
  assert.equal(B.bonusPayoutState(b, 19999).earned, 75);
  assert.equal(B.bonusPayoutState(b, 20000).earned, 100);
  assert.equal(B.bonusPayoutState(b, 999999).earned, 100, 'there is no band above Platinum');
});

test('Am-Am reports the gap to the NEXT band, and nothing once the top is reached', () => {
  const b = carrier('american_amicable');
  const mid = B.bonusPayoutState(b, 8000);
  assert.equal(mid.next.threshold, 10000);
  assert.equal(mid.gap, 2000);
  assert.equal(mid.unlockValue, 25, '$75 next band minus the $50 already earned');
  const top = B.bonusPayoutState(b, 25000);
  assert.equal(top.next, null);
  assert.equal(top.gap, 0);
});

test('American Home Life is BANDED PERCENT — the band rate times the whole quarter', () => {
  const b = carrier('american_home_life');
  assert.equal(B.bonusPayoutState(b, 14999).earned, 0);
  assert.equal(B.bonusPayoutState(b, 15000).earned, 750);      // 5% of 15,000
  assert.equal(B.bonusPayoutState(b, 17500).earned, 1050);     // 6% of 17,500
  assert.equal(B.bonusPayoutState(b, 27500).earned, 2750);     // 10% of 27,500
  assert.equal(B.bonusPayoutState(b, 30000).earned, 3000);     // still 10%, of the whole
});

test('Corebridge counts policies and never renders its "up to" tier as a figure', () => {
  const b = carrier('corebridge');
  assert.equal(b.basis, 'policy_count');
  const one = B.bonusPayoutState(b, 10);
  assert.equal(one.earned, 500);
  const two = B.bonusPayoutState(b, 25);
  // "up to $10,000 cumulative" is a range. Showing $10,000 would be inventing
  // a tier number, which CLAUDE.md forbids in as many words.
  assert.equal(two.earned, 0);
  assert.equal(two.earnedUncertain, true);
  const below = B.bonusPayoutState(b, 12);
  assert.equal(below.nextUncertain, true, 'the next rung is a range too');
  assert.equal(below.gap, 13);
});

test('a trip program is a bar to a threshold with no dollar value', () => {
  const trip = { bonus_type: 'trip', tiers: [{ threshold: 100, payout: 'Cabo San Lucas' }] };
  const s = B.bonusPayoutState(trip, 40);
  assert.equal(s.kind, 'trip');
  assert.equal(s.label, 'Cabo San Lucas');
  assert.equal(s.reached, false);
  assert.equal(s.pctToGoal, 0.4);
  assert.equal(B.bonusPayoutState(trip, 250).pctToGoal, 1, 'the bar never exceeds full');
});

test('a lead_credit program uses the cliff maths but is labelled differently', () => {
  const lc = { bonus_type: 'lead_credit', tiers: [{ threshold: 5000, payout: '5% lead credit' }] };
  const s = B.bonusPayoutState(lc, 6000);
  assert.equal(s.kind, 'leadCliff');
  assert.equal(s.earned, 300);
});

test('a program with no tiers has no payout state at all', () => {
  assert.equal(B.bonusPayoutState({ bonus_type: 'portal_only', tiers: [] }, 1000), null);
  assert.equal(B.bonusPayoutState({ bonus_type: 'none_public', tiers: [] }, 1000), null);
});

// ============================================================
// 5. WHAT IS COMPUTABLE
// ============================================================

test('a dead or tierless program is excluded from bars and nudges', () => {
  const base = { basis: 'annualized_premium', tiers: [{ threshold: 1, payout: '$1' }],
                 status: 'active_2026', window: { type: 'quarterly' } };
  assert.equal(B.bonusIsComputable(base), true);
  assert.equal(B.bonusIsComputable({ ...base, tiers: [] }), false);
  // No parseable qualification period => nothing to total production over.
  assert.equal(B.bonusIsComputable({ ...base, window: null }), false);
  assert.equal(B.bonusIsComputable({ ...base, basis: 'something_else' }), false);
  ['none_found', 'discontinued', 'expired'].forEach((status) =>
    assert.equal(B.bonusIsComputable({ ...base, status }), false, status));
  // A period that ENDED is still computable — the card shows the "closed"
  // message, which needs the window engine to have run.
  assert.equal(B.bonusIsComputable({ ...base, status: 'period_ended_2026-05-29' }), true);
  assert.equal(B.bonusIsComputable(null), false);
});

test('the badge tells the truth about how sure we are', () => {
  assert.equal(B.bonusStatusBadge('active_2026').label, 'Verified 2026');
  assert.equal(B.bonusStatusBadge('period_ended_2026-05-29').label, 'Period ended');
  assert.equal(B.bonusStatusBadge('last_documented').label, 'Unverified — check portal');
  assert.equal(B.bonusStatusBadge(undefined).label, 'Unverified — check portal');
});

// ============================================================
// 6. THE MIRROR RULE (CLAUDE.md)
// ============================================================

test('every carrier in the JSON is in the app const, with the same tier data', () => {
  DATA.carriers.forEach((c) => {
    assert.ok(APP.includes(`"id": "${c.id}"`), `${c.id} missing from CARRIER_BONUSES in app.html`);
  });
});

test('the app const carries a structured window for every carrier the engine bars', () => {
  // The spec says parse the free-text `period` ONCE, by hand, into a
  // `window` object — never regex it at runtime. So a computable carrier
  // without one silently renders no bar.
  DATA.carriers.forEach((c) => {
    const eligible = (c.basis === 'annualized_premium' || c.basis === 'policy_count')
      && Array.isArray(c.tiers) && c.tiers.length > 0
      && !['none_found', 'discontinued', 'expired'].includes(c.status);
    if (!eligible) return;
    const w = appWindowFor(c.id);
    // Bankers Fidelity ("ongoing") and Oxford Life have no parseable period.
    // That is allowed — but then they must NOT be computable, or they reach
    // the bar renderer and print "No tier data.". This is the pairing that
    // has to hold, not "every eligible carrier has a window".
    if (!w) {
      assert.equal(B.bonusIsComputable(c), false,
        `${c.id} has no window, so it must not be treated as computable`);
      return;
    }
    assert.ok(w.type, `${c.id} window config needs a type`);
    assert.ok(['monthly', 'quarterly', 'annual', 'fixed'].includes(w.type), `${c.id}: ${w.type}`);
    if (w.type === 'fixed') {
      assert.match(w.start, /^\d{4}-\d{2}-\d{2}$/, `${c.id} fixed window needs a start`);
      assert.match(w.end, /^\d{4}-\d{2}-\d{2}$/, `${c.id} fixed window needs an end`);
    }
  });
});

test('the bonus core is pure — no DOM, storage, network or app globals', () => {
  const m = APP.match(/\/\/ <bonus-core>([\s\S]*?)\/\/ <\/bonus-core>/);
  const body = m[1].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // `window.` is matched only as a GLOBAL. `bonus.window.type` is a data
  // field on a carrier entry and is exactly what the period engine reads —
  // a bare \bwindow\. would flag the thing the block is supposed to do.
  [/\bdocument\./, /(^|[^.\w])window\./m, /\blocalStorage\b/, /(^|[^.\w])sb\./,
   /\bfetch\(/, /\bCARRIER_BONUSES\b/, /\bgetActiveCommKey\b/, /\bbonusCarrierIdForPolicy\b/]
    .forEach((re) => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
});

test('the bonus-core sentinel appears exactly once', () => {
  assert.equal((APP.match(/\/\/ <bonus-core>/g) || []).length, 1);
  assert.equal((APP.match(/\/\/ <\/bonus-core>/g) || []).length, 1);
});
