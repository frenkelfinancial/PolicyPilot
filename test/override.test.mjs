// ============================================================
// override.test.mjs — run with:  npm run test:override
//
// Estimated advance override (PROMPT OV2, Round 2 of 2). Doc:
// docs/override-estimator.md. Round 1's schema: 20260810_contract_levels.sql.
//
// Two kinds of test, the same split as test/back-office.test.mjs:
//
//   1. BEHAVIOUR. The pure block between the // <override-core> sentinels in
//      app.html is extracted and executed VERBATIM, together with the things
//      it declares a dependency on — COMP / COMP_LEVELS / getCommPct() (the
//      app's one commission lookup) and CARRIER_PRODUCTS / LEGACY_CLASS_MAP /
//      getActiveCommKey() (its one COMP-key resolver). app.html has no build
//      step and no module system, so a mirrored copy here would be a second
//      definition that drifts from the one that ships — and this file's whole
//      subject is a number that must have exactly one definition.
//
//   2. STRUCTURE. Assertions about app.html as source text: the bug CLASSES
//      this feature is exposed to. A second advance rate. A second commission
//      lookup. The new box writing another screen's period key. A grid of $0
//      rendered over a roster nobody has set a level on.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const OV1_MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260810_contract_levels.sql'), 'utf8');

// app.html documents its own rules in comments; counting those as violations
// would make documenting a rule break it.
const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);

// ------------------------------------------------------------
// Load the shipped core, plus the two things it declares a dependency on
// ------------------------------------------------------------
const EXPORTS = [
  'ADVANCE_RATE', 'OV_ADVANCE_LABEL', 'OV_DEF', 'OV_UNSET_PROMPT', 'OV_LEVEL_NOT_SET',
  'OV_ABOVE_LEADER', 'ovSplitProductKey', 'ovResolveProductKey', 'ovSpreadPct',
  'ovEstAdvance', 'ovCount', 'ovLevelState', 'ovChangedPhrase', 'ovDownlineRows',
  'ovSetupPrompt', 'ovPriceRollup', 'ovCaveatLines',
  // The declared dependencies, lifted rather than re-typed.
  'COMP', 'COMP_LEVELS', 'getCommPct', 'getActiveCommKey', 'CARRIER_PRODUCTS', 'LEGACY_CLASS_MAP',
];

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

/** Lift a top-level `const NAME = ...;` by brace/bracket matching its initialiser. */
function topLevelConst(name) {
  const at = APP.indexOf(`\nconst ${name} = `);
  assert.ok(at > -1, `app.html must declare const ${name}`);
  const eq = APP.indexOf('=', at);
  let i = eq + 1;
  while (i < APP.length && /\s/.test(APP[i])) i++;
  const open = APP[i];
  if (open !== '{' && open !== '[') {
    const semi = APP.indexOf(';', i);
    return APP.slice(at + 1, semi + 1);
  }
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === open) depth++;
    else if (APP[j] === close) { depth--; if (depth === 0) return APP.slice(at + 1, j + 1) + ';'; }
  }
  assert.fail(`could not match ${name}`);
}

function loadCore() {
  const src = [
    topLevelConst('COMP_LEVELS'),
    topLevelConst('COMP'),
    topLevelFn('getCommPct'),
    topLevelConst('CARRIER_PRODUCTS'),
    topLevelConst('LEGACY_CLASS_MAP'),
    topLevelFn('getActiveCommKey'),
    block('override-core'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

// ============================================================
// 1. BEHAVIOUR — the arithmetic, against the REAL comp table
// ============================================================

// The two errors this whole round exists to not make, stated once so every
// failure message below can point at them.
const WRONG_1 = 'An override is a percentage of AP, NOT of the agent\'s commission. ' +
  '5% of the agent\'s $500 advance is $25 and that is the WRONG answer: on Americo ' +
  'Eagle an agent at 80 earns 75%, so a $500 advance implies ~$889 of AP, and five ' +
  'points of spread advanced at 75% is $33.33.';
const WRONG_2 = 'The spread between two contract levels is NOT the difference between ' +
  'the levels. Only the COMP table knows, and it must be asked twice.';

test('🔴 THE WORKED EXAMPLE: Americo Eagle, leader 85, agent 80, $888.89 AP -> $33.33', () => {
  const spread = B.ovSpreadPct('americo_eagle', 85, 80);
  assert.equal(spread, 5, `${WRONG_2} americo_eagle pays 75 at 80 and 80 at 85, so the spread is 5 points.`);

  const ap = 888.89;
  const est = B.ovEstAdvance(ap, spread, B.ADVANCE_RATE);
  assert.ok(Math.abs(est - 33.33) <= 0.01,
    `${WRONG_1} Got ${est}, expected 33.33 (+/- a cent) from ${ap} x 5% x ${B.ADVANCE_RATE}.`);

  // And it is emphatically not $25 — the answer the original description gives.
  assert.ok(Math.abs(est - 25) > 1, WRONG_1);

  // The AP itself round-trips from the $500 advance the description started with,
  // so the example is one arithmetic chain and not two coincidences.
  const agentPct = B.getCommPct('americo_eagle', 80, false);
  assert.equal(agentPct, 75);
  assert.ok(Math.abs(ap * (agentPct / 100) * B.ADVANCE_RATE - 500) < 0.01,
    'a $500 advance at 75% comm and a 75% advance rate is $888.89 of AP');
});

test('🔴 THE ZERO-SPREAD PRODUCTS: four real COMP rows pay 80 and 85 identically', () => {
  // Each its own assertion, each naming its own product, because "the level gap
  // is the spread" is wrong per product and a merged assertion hides which one.
  [
    ['americo_wl',   'americo_wl pays 70 at both 80 and 85'],
    ['aetna_senior', 'aetna_senior pays 70 at both 80 and 85'],
    ['core_graded',  'core_graded pays 45 at both 80 and 85'],
    ['core_giwl',    'core_giwl pays 55 at both 80 and 85'],
  ].forEach(([product, why]) => {
    assert.equal(B.ovSpreadPct(product, 85, 80), 0,
      `${WRONG_2} ${product} must return spread 0 at leader 85 / agent 80 — ${why}. ` +
      'Five points of level gap buys nothing on this product and the screen must say so.');
  });
});

test('🔴 mutual_fe at 85/80 is FOUR points, not five', () => {
  assert.equal(B.ovSpreadPct('mutual_fe', 85, 80), 4,
    `${WRONG_2} mutual_fe pays 70 at 80 and 74 at 85 — four points, on the same ` +
    'five-point level gap that pays five on americo_eagle.');
});

test('the products that DO pay the full five points still pay five', () => {
  ['americo_eagle', 'trans_express', 'core_siwl', 'aa_senior'].forEach(p => {
    assert.equal(B.ovSpreadPct(p, 85, 80), 5, `${p} pays +5 from 80 to 85`);
  });
});

test('🔴 THE CLAMP: an agent above their leader is ZERO, never negative', () => {
  [[80, 85], [85, 100], [70, 145], [100, 105], [120, 145]].forEach(([leader, agent]) => {
    const s = B.ovSpreadPct('americo_eagle', leader, agent);
    assert.equal(s, 0,
      `leader ${leader} / agent ${agent} must clamp to 0, got ${s}. An agent contracted ` +
      'above their leader is a data state — both parties may set the level and the most ' +
      'recent wins — not a debt the leader owes.');
    assert.ok(s >= 0, 'never negative');
  });
  // Equal levels are also zero, and for the same reason.
  assert.equal(B.ovSpreadPct('americo_eagle', 100, 100), 0);
  // And the estimate on a clamped spread is zero dollars, not a negative figure.
  assert.equal(B.ovEstAdvance(10000, B.ovSpreadPct('americo_eagle', 80, 145)), 0);
});

test('🔴 AN UNKNOWN PRODUCT IS SPREAD 0 *AND* IS REPORTED, NEVER SWALLOWED', () => {
  // getCommPct returns the CONTRACT LEVEL ITSELF for a product it has no table
  // for, so a naive subtraction would hand back leaderLevel - agentLevel: a
  // confident, completely wrong number wearing the right answer's clothes.
  assert.equal(B.getCommPct('not_a_real_product', 85, false), 85, 'the trap this guards');
  assert.equal(B.ovSpreadPct('not_a_real_product', 85, 80), 0,
    'an unknown product must be 0, not the 5-point level gap getCommPct would imply');

  // And the count must SURFACE. A silent miss reads as "this business pays no
  // override", which is indistinguishable from a genuine zero spread.
  const priced = B.ovPriceRollup([
    { agent_id: 'a', product: 'Nowhere Mutual|Whole Life|std', policy_count: 3, total_ap: 6000 },
    { agent_id: 'a', product: 'Americo|Whole Life|std',        policy_count: 2, total_ap: 4000 },
  ], { leaderLevel: 85, levelOf: () => 80 });

  assert.equal(priced.unmapped.policies, 3, 'the unmapped policies are counted');
  assert.equal(priced.unmapped.ap, 6000, 'and so is their AP');
  assert.deepEqual(priced.unmapped.keys.map(k => k.key), ['Nowhere Mutual|Whole Life|std'],
    'and the key itself is named, so a report can list it');
  // The mapped half still priced: 4000 x 5% x 0.75 = 150.
  assert.equal(priced.total, 150, 'the unmapped row is excluded from the figure, not zeroed into it');

  const lines = B.ovCaveatLines(priced);
  assert.ok(lines.some(l => /3 policies/.test(l) && /no comp-table entry/.test(l)),
    'the screen must say the three policies were not included');
});

test('the unmapped line and the zero-spread line are TWO facts, never merged', () => {
  const priced = B.ovPriceRollup([
    { agent_id: 'a', product: 'Nowhere Mutual|Whole Life|std', policy_count: 1, total_ap: 1000 },
    { agent_id: 'a', product: 'Americo|Term|std',              policy_count: 4, total_ap: 2000 },
  ], { leaderLevel: 85, levelOf: () => 85 });   // same level -> genuine zero spread
  assert.equal(priced.unmapped.policies, 1);
  assert.equal(priced.zeroSpread.policies, 4);
  const lines = B.ovCaveatLines(priced);
  assert.equal(lines.length, 2, 'two separate sentences — one is a failed lookup, one is a real zero');
  assert.ok(/no comp-table entry/.test(lines[0]));
  assert.ok(/pay the same/.test(lines[1]));
});

test('🔴 THE `cut` ARGUMENT IS APPLIED: graded/GI spreads are SMALLER', () => {
  // Real COMP rows, not synthetic ones. Americo has no graded override key, so
  // getActiveCommKey falls back to the base product with the ~40% cut — which
  // is the exact case ignoring `cut` would overstate.
  const plain  = B.ovSpreadPct('americo_eagle', 85, 80, false);
  const gradedSpread = B.ovSpreadPct('americo_eagle', 85, 80, true);
  assert.equal(plain, 5);
  assert.equal(gradedSpread, 3, '80 x 0.6 = 48 and 75 x 0.6 = 45 — three points, not five');
  assert.ok(gradedSpread < plain,
    'the cut scales BOTH sides, so the spread scales with it. Dropping the third ' +
    'argument overstates the override on every graded and GI policy in the book.');

  // And the resolver sets the flag, so the caller cannot forget it.
  const g = B.ovResolveProductKey('Americo|Whole Life|graded');
  assert.equal(g.compKey, 'americo_eagle');
  assert.equal(g.cut, true);
  const s = B.ovResolveProductKey('Americo|Whole Life|std');
  assert.equal(s.cut, false);

  // End to end, through the pricer: the same AP on the same product pays less
  // graded than it does standard.
  const rows = ap => [{ agent_id: 'a', product: ap, policy_count: 1, total_ap: 10000 }];
  const std = B.ovPriceRollup(rows('Americo|Whole Life|std'),    { leaderLevel: 85, levelOf: () => 80 });
  const grd = B.ovPriceRollup(rows('Americo|Whole Life|graded'), { leaderLevel: 85, levelOf: () => 80 });
  assert.equal(std.total, 375);   // 10000 x 5% x 0.75
  assert.equal(grd.total, 225);   // 10000 x 3% x 0.75
  assert.ok(grd.total < std.total);
});

test('🔴 THE JOINED KEY ROUND-TRIPS — both key spaces Round 1 found in production', () => {
  // Shape 1: the display category, which is most of the book. `product` alone
  // cannot resolve this — CARRIER_PRODUCTS[carrier].products[product] is what
  // turns 'Whole Life' into 'americo_eagle'.
  const wl = B.ovSplitProductKey('Americo|Whole Life|std');
  assert.deepEqual(wl, { carrier: 'Americo', product: 'Whole Life', cls: 'std' });
  const wlKey = B.ovResolveProductKey('Americo|Whole Life|std');
  assert.equal(wlKey.compKey, 'americo_eagle');
  assert.equal(wlKey.mapped, true);

  // Shape 2: a legacy row storing a raw COMP key, with a legacy health class.
  // getActiveCommKey's `|| product` passthrough is what carries it, and
  // LEGACY_CLASS_MAP folds 'level' to 'std'.
  const legacy = B.ovSplitProductKey('American-Amicable|aa_senior|level');
  assert.deepEqual(legacy, { carrier: 'American-Amicable', product: 'aa_senior', cls: 'level' });
  const legacyKey = B.ovResolveProductKey('American-Amicable|aa_senior|level');
  assert.equal(legacyKey.compKey, 'aa_senior');
  assert.equal(legacyKey.cut, false, 'legacy `level` folds to std, which takes no cut');
  assert.equal(legacyKey.mapped, true);

  // The other three shapes live in the same book today (OV1 report §1).
  assert.equal(B.ovResolveProductKey('Transamerica|trans_express|level').compKey, 'trans_express');
  assert.equal(B.ovResolveProductKey('Corebridge|core_siwl|gi').compKey, 'core_giwl',
    'a GI health class resolves to the carrier GI product, not the stored key');
  assert.equal(B.ovResolveProductKey('Corebridge|Whole Life|gi').compKey, 'core_giwl');
  assert.equal(B.ovResolveProductKey('Ethos|Whole Life|std').compKey, 'ethos_tawl');

  // A malformed key is null, not a guess.
  assert.equal(B.ovSplitProductKey('Americo'), null);
  assert.equal(B.ovSplitProductKey(''), null);
  assert.equal(B.ovSplitProductKey(null), null);
  assert.equal(B.ovResolveProductKey('Americo'), null);
});

test('the leader is excluded — nobody earns an override on their own book', () => {
  const priced = B.ovPriceRollup([
    { agent_id: 'me',   product: 'Americo|Whole Life|std', policy_count: 5, total_ap: 50000 },
    { agent_id: 'them', product: 'Americo|Whole Life|std', policy_count: 1, total_ap: 10000 },
  ], { leaderLevel: 85, levelOf: () => 80, excludeAgentId: 'me' });
  assert.equal(priced.agents.length, 1);
  assert.equal(priced.agents[0].agentId, 'them');
  assert.equal(priced.total, 375);
});

// ------------------------------------------------------------
// The launch state — NULL is not false
// ------------------------------------------------------------

const dl = (id, level, o = {}) => ({
  agent_id: id, agent_name: 'Agent ' + id, relationship: 'downline',
  contract_level: level,
  level_changed_by_self: o.by === undefined ? null : o.by,
  level_changed_at: o.at === undefined ? null : o.at,
});

test('🔴 NULL IS NOT FALSE: an unrecorded change renders "not set"', () => {
  const never = dl('a', 100);                                   // the production state today
  assert.equal(B.ovLevelState(never), 'unset');
  assert.equal(B.ovChangedPhrase(never, () => '4 Aug 2026'), B.OV_LEVEL_NOT_SET);
  assert.ok(!/changed by/.test(B.ovChangedPhrase(never, () => '4 Aug 2026')),
    'a row with no recorded change must never claim one was made — not by the ' +
    'agent and not by the leader. NULL means the level predates the audit trail ' +
    'or has never moved.');

  // A stamp with no boolean, and a boolean with no stamp, are both still unset.
  assert.equal(B.ovLevelState(dl('a', 100, { at: '2026-08-01T12:00:00Z' })), 'unset');
  assert.equal(B.ovLevelState(dl('a', 100, { by: true })), 'unset');

  // A real change reads as one, on both sides.
  const bySelf = dl('b', 90, { by: true,  at: '2026-08-01T12:00:00Z' });
  const byLead = dl('c', 90, { by: false, at: '2026-08-01T12:00:00Z' });
  assert.equal(B.ovLevelState(bySelf), 'self');
  assert.equal(B.ovLevelState(byLead), 'leader');
  assert.equal(B.ovChangedPhrase(bySelf, () => '1 Aug'), 'changed by the agent on 1 Aug');
  assert.equal(B.ovChangedPhrase(byLead, () => '1 Aug'), 'changed by you on 1 Aug');
});

test('🔴 THE LAUNCH STATE: an all-unset roster prompts, it does NOT render a grid of $0', () => {
  const members = [dl('a', 100), dl('b', 100), dl('c', 100),
    { agent_id: 'u', relationship: 'upline', contract_level: null }];
  const prompt = B.ovSetupPrompt(members);
  assert.ok(prompt, 'THIS IS WHAT THE OWNER SEES ON DAY ONE. Round 1 measured seven ' +
    'downline agents at 100 against the owner\'s 85 — an unset default, not seven real ' +
    'contracts above him. Every override clamps to zero and the feature reads $0. A ' +
    'screen that silently shows nothing is indistinguishable from a broken one, so the ' +
    'prompt is required, not optional. Do not soften this assertion.');
  assert.equal(prompt.count, 3, 'the COUNT of unset agents is part of the prompt');
  assert.equal(prompt.total, 3);
  assert.equal(prompt.all, true, 'all unset -> the screen must not render the grid at all');
  assert.equal(prompt.text, B.OV_UNSET_PROMPT);
  assert.match(B.OV_UNSET_PROMPT, /[Ss]et your agents/);
  assert.match(prompt.detail, /3 agents have/);
  assert.deepEqual(prompt.agentIds.sort(), ['a', 'b', 'c'],
    'and the ids, so the pricer can refuse those rows specifically');

  // The upline row is not counted — only downlines carry a level at all.
  assert.equal(B.ovDownlineRows(members).length, 3);

  // Nothing is priced for an unset agent, and it is NOT reported as zero-spread.
  const priced = B.ovPriceRollup(
    [{ agent_id: 'a', product: 'Americo|Whole Life|std', policy_count: 2, total_ap: 20000 }],
    { leaderLevel: 85, levelOf: id => (prompt.agentIds.includes(id) ? null : 100) });
  assert.equal(priced.total, 0);
  assert.equal(priced.priceable, false, 'no agent can be priced, so the headline is a dash');
  assert.deepEqual(priced.unsetAgents, ['a']);
  assert.equal(priced.zeroSpread.policies, 0,
    '"this product pays the same" is a claim about the comp table. Nobody checked it ' +
    'for an agent whose level was never recorded.');
  assert.equal(priced.agents[0].unset, true);
});

test('a partly-set roster prompts AND prices the ones that are set', () => {
  const members = [dl('a', 80, { by: false, at: '2026-08-01T12:00:00Z' }), dl('b', 100)];
  const prompt = B.ovSetupPrompt(members);
  assert.equal(prompt.count, 1);
  assert.equal(prompt.all, false, 'a grid is still worth rendering for the agent who IS set');
  assert.match(prompt.detail, /1 agent has/);

  const priced = B.ovPriceRollup([
    { agent_id: 'a', product: 'Americo|Whole Life|std', policy_count: 1, total_ap: 10000 },
    { agent_id: 'b', product: 'Americo|Whole Life|std', policy_count: 1, total_ap: 10000 },
  ], { leaderLevel: 85, levelOf: id => (id === 'a' ? 80 : null) });
  assert.equal(priced.total, 375, 'only the set agent is priced');
  assert.equal(priced.priceable, true);
});

test('an agent above the leader is flagged, priced at zero, and NOT called zero-spread', () => {
  const priced = B.ovPriceRollup(
    [{ agent_id: 'hi', product: 'Americo|Whole Life|std', policy_count: 3, total_ap: 30000 }],
    { leaderLevel: 85, levelOf: () => 100 });
  assert.deepEqual(priced.aboveLeader, ['hi']);
  assert.equal(priced.total, 0);
  assert.equal(priced.agents[0].aboveLeader, true);
  assert.equal(priced.zeroSpread.policies, 0,
    'contracted above you is not "the table pays the same" — it pays them MORE');
  assert.equal(priced.agents[0].ap, 30000, 'their AP is still reported; only the override is zero');
  assert.match(B.OV_ABOVE_LEADER, /contracted above you/);
});

test('a whole rollup prices per product, not per agent-total', () => {
  // Two products, same agent, same level pair. One pays 5 points, one pays 0.
  const priced = B.ovPriceRollup([
    { agent_id: 'a', product: 'Americo|Whole Life|std',        policy_count: 2, total_ap: 10000 },
    { agent_id: 'a', product: 'Aetna / Accendo|Whole Life|std', policy_count: 3, total_ap: 10000 },
  ], { leaderLevel: 85, levelOf: () => 80 });
  assert.equal(priced.total, 375, 'americo_eagle pays 5 on its 10k; aetna_senior pays 0 on its');
  assert.equal(priced.totalAp, 20000);
  assert.equal(priced.zeroSpread.policies, 3);
  assert.equal(priced.agents[0].policies, 5);
  // Pricing the AGENT'S TOTAL at one blended rate would give 750 and be wrong.
  assert.notEqual(priced.total, 750);
});

test('counts and money survive the shapes an RPC actually returns', () => {
  assert.equal(B.ovCount('4'), 4);
  assert.equal(B.ovCount('x'), 0);
  assert.equal(B.ovCount(null), 0);
  assert.equal(B.ovCount(-2), 0);
  // total_ap comes back as a numeric STRING from PostgREST.
  const priced = B.ovPriceRollup(
    [{ agent_id: 'a', product: 'Americo|Whole Life|std', policy_count: '2', total_ap: '10000' }],
    { leaderLevel: 85, levelOf: () => 80 });
  assert.equal(priced.total, 375);
  assert.equal(priced.totalPolicies, 2);
  // And nothing at all is an empty answer, not a crash.
  const none = B.ovPriceRollup(null, {});
  assert.equal(none.total, 0);
  assert.deepEqual(none.agents, []);
  assert.deepEqual(B.ovCaveatLines(none), [], 'nothing is said for the sake of saying something');
  assert.deepEqual(B.ovCaveatLines(null), []);
});

test('a leader with no level of their own prices nothing rather than guessing', () => {
  const priced = B.ovPriceRollup(
    [{ agent_id: 'a', product: 'Americo|Whole Life|std', policy_count: 1, total_ap: 10000 }],
    { leaderLevel: null, levelOf: () => 80 });
  assert.equal(priced.total, 0);
  assert.equal(priced.leaderLevel, null);
  assert.equal(priced.zeroSpread.policies, 0);
});

// ============================================================
// 2. STRUCTURE — the bug classes
// ============================================================

test('🔴 ONE ADVANCE RATE: no second hard-coded 0.75 / 75% advance literal', () => {
  const decls = APP_CODE.match(/const ADVANCE_RATE = /g) || [];
  assert.equal(decls.length, 1, 'ADVANCE_RATE is declared exactly once');
  assert.equal(B.ADVANCE_RATE, 0.75);

  // The advance formula is AP x comm% x rate, and it appeared TEN times as a
  // bare literal before this round. Every one now names the constant.
  const literals = APP_CODE.match(/100\s*\*\s*0\.75/g) || [];
  assert.deepEqual(literals, [],
    'an advance rate written twice is an advance rate that moves once. Every ' +
    '`/ 100 * 0.75` must read `/ 100 * ADVANCE_RATE`.');

  // Including the one the brief names specifically.
  assert.match(APP_CODE, /function _lgAdvComm\(p\)\{[^}]*ADVANCE_RATE/,
    '_lgAdvComm is where the rate came from and must be the first to name it');
  // And the override core does not carry a second one. Comments are stripped
  // first: the block explains WHY the rate is named, and counting that prose as
  // a violation would make documenting the rule break it.
  const core = APP.match(/\/\/ <override-core>([\s\S]*?)\/\/ <\/override-core>/)[1];
  const bare = stripLineComments(core, ['//', '*', '/*']).match(/0\.75/g) || [];
  assert.equal(bare.length, 1, 'the only 0.75 in override-core is the constant itself');
});

test('🔴 ONE COMP LOOKUP: getCommPct is the only thing turning a level into a %', () => {
  const decls = APP_CODE.match(/function getCommPct\s*\(/g) || [];
  assert.equal(decls.length, 1, 'getCommPct is declared exactly once');

  // A second implementation would have to index a COMP row by a level index.
  // COMP_LEVELS is how you get that index, so nothing outside getCommPct may
  // reach for it in an arithmetic position.
  const core = APP.match(/\/\/ <override-core>([\s\S]*?)\/\/ <\/override-core>/)[1];
  const coreCode = stripLineComments(core, ['//', '*', '/*']);
  assert.ok(!/COMP_LEVELS/.test(coreCode),
    'the override core must not reach for the level index — that is getCommPct\'s job');
  assert.ok(!/COMP\s*\[[^\]]+\]\s*\[/.test(coreCode),
    'the override core must not index into a COMP row. It asks COMP whether a KEY ' +
    'EXISTS (hasOwnProperty), which is a different question and the reason is in ' +
    'ovSpreadPct: getCommPct hands back the contract level itself for a product it ' +
    'has no table for.');
  assert.match(coreCode, /getCommPct\(product, Number\(leaderLevel\)/);
  assert.match(coreCode, /getCommPct\(product, Number\(agentLevel\)/);

  // The whole app has exactly one COMP_LEVELS consumer that does index arithmetic.
  const indexers = (APP_CODE.match(/COMP_LEVELS\.(indexOf|reduce)/g) || []).length;
  assert.ok(indexers > 0);
  const fn = APP_CODE.slice(APP_CODE.indexOf('function getCommPct('),
    APP_CODE.indexOf('function getContract('));
  assert.equal((fn.match(/COMP_LEVELS\.(indexOf|reduce)/g) || []).length, indexers,
    'every COMP_LEVELS index lookup in app.html lives inside getCommPct()');
});

test('the core uses the SHIPPED key resolver, and does not grow a second one', () => {
  const core = APP.match(/\/\/ <override-core>([\s\S]*?)\/\/ <\/override-core>/)[1];
  const coreCode = stripLineComments(core, ['//', '*', '/*']);
  assert.match(coreCode, /getActiveCommKey\(parts\.carrier, parts\.product, parts\.cls\)/);
  // No hand-rolled CARRIER_PRODUCTS walk, no second legacy-class map.
  assert.ok(!/CARRIER_PRODUCTS/.test(coreCode));
  assert.ok(!/LEGACY_CLASS_MAP/.test(coreCode));
  // And the SQL side still maps nothing — the joined key is Round 1's contract.
  assert.match(OV1_MIGRATION, /\|\|\s*'\|'\s*\|\|/,
    'get_downline_product_ap must keep returning carrier|product|cls verbatim');
});

test('🔴 THE OVERRIDE BOX WRITES NEITHER pp_team_period NOR pp_summary_period', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosOverrideHTML()'),
    APP_CODE.indexOf('function bosAttentionHTML()'));
  assert.ok(fn.length > 0, 'bosOverrideHTML() must exist');
  assert.ok(!/pp_team_period/.test(fn),
    'the Agency tab owns pp_team_period; a chip on the Back Office Summary must ' +
    'not move another screen\'s window');
  assert.ok(!/pp_summary_period/.test(fn), 'the Front Office Summary owns pp_summary_period');
  assert.ok(!/setItem/.test(fn), 'this box stores nothing at all');
  assert.ok(!/setLedgerPeriod|setTeamPeriod|teamSetPeriod/.test(fn));

  // It rides the screen's OWN window, the one every other card there uses.
  assert.match(fn, /bosPeriodLabel\(\)/);
  const render = APP_CODE.slice(APP_CODE.indexOf('async function renderBackOfficeSummary('),
    APP_CODE.indexOf('function bosPaint('));
  assert.match(render, /jobs\.push\(\['prodap',\s*ovLoadProductAP\(range\)\]\)/,
    'the product rollup takes the Back Office Summary range, not a window of its own');
});

test('🔴 LEADER-ONLY, AND ABSENT — a non-leader produces no override markup at all', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosOverrideHTML()'),
    APP_CODE.indexOf('function bosAttentionHTML()'));
  // The gate is the first thing, before anything is built.
  const firstLine = fn.slice(fn.indexOf('{') + 1).trim().split('\n')[0].trim();
  assert.equal(firstLine, "if (!_bosCache.isLeader) return '';",
    'the gate must come before any markup is assembled');
  // Absent, not hidden and not an upsell — the Top Producers card's rule.
  assert.ok(!/display:\s*none/.test(fn), 'a hidden strip is still a strip in the DOM');
  assert.ok(!/showUpgradeGate|Upgrade|upsell|locked/i.test(fn));
  // No downline is also absent, and is decided before the figures.
  assert.match(fn, /if \(!downline\.length\) return '';/);

  // And the RPCs are only ever requested for a leader.
  const render = APP_CODE.slice(APP_CODE.indexOf('async function renderBackOfficeSummary('),
    APP_CODE.indexOf('function bosPaint('));
  const leaderBlock = render.slice(render.indexOf('if (isLeader) {'));
  assert.ok(leaderBlock.includes("ovLoadProductAP(range)"));
  assert.ok(leaderBlock.includes("ovLoadMembers()"));
});

test('🔴 NO NEW BACKEND: both new RPCs shipped with Round 1', () => {
  ['get_downline_product_ap', 'set_downline_contract_level', 'get_agency_members'].forEach(fn => {
    assert.ok(OV1_MIGRATION.includes('function public.' + fn),
      `${fn} must be defined in 20260810_contract_levels.sql — this round ships no migration`);
  });
  // And app.html reaches for nothing else new.
  assert.match(APP_CODE, /rpc\('get_downline_product_ap'/);
  assert.match(APP_CODE, /rpc\('set_downline_contract_level'/);
});

test('🔴 ONE ROSTER READ FOR BOTH SURFACES, AND IT MINTS NO QUERY', () => {
  // The level editor and the override box must not disagree about who is in
  // the downline or at what level, so they share one entry point...
  const loaders = APP_CODE.match(/async function ovLoadMembers\(/g) || [];
  assert.equal(loaders.length, 1);
  const inLoader = APP_CODE.slice(APP_CODE.indexOf('async function ovLoadMembers('),
    APP_CODE.indexOf('function ovInvalidateMembers('));
  // ...and that entry point delegates to the app's existing cached reader
  // rather than adding a second read of the same roster.
  assert.match(inLoader, /await loadAgencyMembers\(!!force\)/);
  assert.ok(!/sb\.rpc\(/.test(inLoader),
    'a second get_agency_members read is the shape of every bug this codebase ' +
    'has a rule about — loadAgencyMembers() already is that reader');

  // The census Round 1 left behind, unmoved: this round adds no call site.
  assert.equal((APP_CODE.match(/sb\.rpc\('get_agency_members'\)/g) || []).length, 2,
    'Round 1 pinned this at two (pcLoad, loadAgencyMembers) and Round 2 keeps it there');

  // Both surfaces go through the one entry point.
  assert.match(APP_CODE, /await ovLoadMembers\(force\)/);
  assert.match(APP_CODE, /jobs\.push\(\['members', ovLoadMembers\(\)\]\)/);
});

test('the level write goes through the RPC, never a direct agents update', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function ovSaveLevel('),
    APP_CODE.indexOf('async function _agRenderAgentView('));
  assert.ok(fn.length > 0, 'ovSaveLevel() must exist');
  assert.match(fn, /sb\.rpc\('set_downline_contract_level', \{ p_agent_id: agentId, p_level: raw \}\)/);
  assert.ok(!/from\('agents'\)/.test(fn),
    'a leader cannot update public.agents at all — RLS lets an agent write their own ' +
    'row only. The SECURITY DEFINER function re-derives the downline from auth.uid().');
  // No parameter naming a leader, on either side.
  assert.ok(!/p_leader_id|leader_id:/.test(fn));
  // The browser's own bounds match the RPC's, so the box and the database agree.
  assert.match(fn, /raw < 70 \|\| raw > 145/);
  assert.match(OV1_MIGRATION, /v_min\s+constant numeric := 70;/);
  assert.match(OV1_MIGRATION, /v_max\s+constant numeric := 145;/);
});

test('the audit trail is VISIBLE — a level that moved says who moved it', () => {
  const card = APP_CODE.slice(APP_CODE.indexOf('function ovLevelsCardHTML('),
    APP_CODE.indexOf('async function ovSaveLevel('));
  assert.ok(card.length > 0, 'ovLevelsCardHTML() must exist');
  assert.match(card, /ovChangedPhrase\(m, ovFmtDate\)/,
    'if the audit trail is not on screen, an agent can move the number that prices ' +
    'their upline\'s override and nothing says so');
  assert.match(card, /ovSetupPrompt\(res\.rows\)/, 'and the launch-state prompt leads');
  assert.match(card, /OV_ABOVE_LEADER/, 'and an agent above the leader is warned about, inline');
  // The changer is a boolean on the wire; no name and no email is ever rendered.
  assert.ok(!/changed_by\b/.test(card));
  assert.ok(!/agent_email/.test(card));
});

test('an agent (non-leader) sees nothing new — the editor is the leader view only', () => {
  const agentView = APP_CODE.slice(APP_CODE.indexOf('async function _agRenderAgentView('),
    APP_CODE.indexOf('async function _agRenderAgentView(') + 6000);
  assert.ok(!/ovLevelsCardHTML|ovPaintLevels|ov-levels/.test(agentView));
  // And the card is mounted from the leader view.
  const leaderView = APP_CODE.slice(APP_CODE.indexOf('async function _agRenderLeaderView('),
    APP_CODE.indexOf('async function ovLoadMembers('));
  assert.match(leaderView, /id="ov-levels"/);
  assert.match(leaderView, /ovPaintLevels\(\)/);
});

test('🔴 THE ONE TABLE RENDERER IS UNTOUCHED', () => {
  // teamTableHTML() is shared with the Summary mini-card. An editable contract
  // level belongs on the tab an owner manages the agency from, not on a
  // read-only strip inside another screen.
  const fn = APP_CODE.slice(APP_CODE.indexOf('function teamTableHTML('),
    APP_CODE.indexOf('function teamVsHTML('));
  assert.ok(fn.length > 0);
  assert.ok(!/contract|ovSaveLevel|ov-input|contract_level/i.test(fn));
  const renderers = APP_CODE.match(/function teamTableHTML\(/g) || [];
  assert.equal(renderers.length, 1);
});

test('the 8,610x family is intact — one call site each, still', () => {
  assert.equal((APP_CODE.match(/sb\.rpc\('get_team_summary'/g) || []).length, 1);
  assert.equal((APP_CODE.match(/sb\.rpc\('get_agency_leaderboards'/g) || []).length, 1);
  assert.equal((APP_CODE.match(/sb\.rpc\('get_agency_stats'/g) || []).length, 0);
  // And this round reads commission data only through the aggregates.
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosOverrideHTML()'),
    APP_CODE.indexOf('function bosAttentionHTML()'));
  assert.ok(!/from\('commission_rows'\)/.test(fn));
  assert.ok(!/from\('policies'\)/.test(fn));
});

test('the actual override figure keeps its existing definition', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function bosOverrideHTML()'),
    APP_CODE.indexOf('function bosAttentionHTML()'));
  // It comes off get_commission_buckets through commTotals(), the same
  // expression the money strip one row up already renders. This round places an
  // estimate BESIDE it; it does not redefine it.
  assert.match(fn, /commTotals\(Array\.isArray\(_bosCache\.buckets\)[^)]*\)\.override/);
  assert.match(fn, /COMM_CARD_DEFS\.override/);
  // A dash, never a zero, when there are no statements to have paid one.
  assert.match(fn, /if \(!hasStatements\) actual = '<div class="ov-fig-v ov-dash">&mdash;<\/div>'/);
});

test('the core is pure — no DOM, no network, no storage, no app globals', () => {
  const core = APP.match(/\/\/ <override-core>([\s\S]*?)\/\/ <\/override-core>/)[1];
  const code = stripLineComments(core, ['//', '*', '/*']);
  [/document\./, /window\./, /localStorage/, /sessionStorage/, /sb\./, /fetch\(/,
   /currentAgent/, /_bosCache/, /getElementById/, /innerHTML/].forEach(re => {
    assert.ok(!re.test(code), `override-core must not contain ${re} — the test harness ` +
      'executes this block standalone, and the moment it stops running the tests stop ' +
      'running against the code that ships');
  });
});

test('the core sentinel appears EXACTLY ONCE', () => {
  // The harness extracts by lazy match, so a comment mentioning the sentinel
  // above the real block swallows the file. Same rule as the other six cores.
  assert.equal((APP.match(/\/\/ <override-core>/g) || []).length, 1);
  assert.equal((APP.match(/\/\/ <\/override-core>/g) || []).length, 1);
});

test('the docs carry both of the original errors, so nobody implements 5% again', () => {
  const claudeMd = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const doc = readFileSync(join(ROOT, 'docs/override-estimator.md'), 'utf8');
  [claudeMd, doc].forEach(text => {
    assert.ok(/not a (percentage|share) of the agent|NOT of the agent/i.test(text) ||
      /percentage of AP, not/i.test(text),
      'the doc must say an override is a percentage of AP, not of the commission');
    assert.ok(/americo_wl/.test(text) && /aetna_senior/.test(text) &&
      /core_graded/.test(text) && /core_giwl/.test(text),
      'the doc must name the four zero-spread products by key');
    assert.ok(/override-core/.test(text), 'and point at the one definition');
  });
  assert.ok(/33\.33/.test(doc) && /\$25/.test(doc),
    'docs/override-estimator.md must carry the worked example AND the wrong answer');
});
