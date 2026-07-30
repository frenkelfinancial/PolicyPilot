// ============================================================
// identity-periods.test.mjs — run with:  npm run test:identity
//
// Two features that shipped together and share one property: they are both
// about a SINGLE definition being read everywhere rather than copied.
//
//   1. IDENTITY. An agent has a name. An email address is not a name, and no
//      peer-visible surface may render one. The sweep at the bottom is the
//      real test — it reads app.html as source text and fails on any identity
//      render that reaches for an email.
//
//   2. PERIODS. One key grammar ('month:2026-04', 'custom:a:b') parsed by one
//      parser and consumed by BOTH period engines, so the Summary screen and
//      the Agency screen cannot disagree about what a window means.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP  = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIG  = readFileSync(join(ROOT, 'supabase/migrations/20260751_display_names.sql'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);
const MIG_CODE = stripLineComments(MIG, ['--']);

const EXPORTS = [
  'ppAgentName', 'ppInitials', 'ppParsePeriodKey', 'ppDay', 'ppIsDynamicPeriod',
  'ppDynamicRange', 'ppPeriodLabel', 'teamPeriodRange', 'TEAM_PERIODS',
];
function loadCore() {
  const m = APP.match(/\/\/ <team-core>([\s\S]*?)\/\/ <\/team-core>/);
  assert.ok(m, 'app.html must contain the // <team-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const T = loadCore();
const D = (y, mo, d) => new Date(y, mo - 1, d, 12);

// ============================================================
// 1. IDENTITY — the resolver
// ============================================================

test('a name is used when there is one', () => {
  assert.equal(T.ppAgentName({ agent_name: 'Jace Frenkel' }), 'Jace Frenkel');
  assert.equal(T.ppAgentName({ name: 'Preston Guyette' }), 'Preston Guyette');
  assert.equal(T.ppAgentName({ holder_name: 'Dana Reyes' }), 'Dana Reyes');
  assert.equal(T.ppAgentName({ leader_name: 'Marcus T' }), 'Marcus T');
});

test('AN EMAIL IS NEVER RENDERED, even when it arrives in a NAME field', () => {
  // The belt-and-braces case: a stale cache, an unmigrated RPC, a hand-built
  // row. The browser refuses the address and derives a name instead.
  assert.equal(T.ppAgentName({ agent_name: 'jacef8778099@gmail.com' }), 'Jacef8778099');
  assert.equal(T.ppAgentName({ name: 'owenclark.2831@gmail.com' }), 'Owenclark 2831');
  assert.equal(T.ppAgentName({ holder_name: 'a.b@c.com' }), 'A B');
});

test('the fallback is the LOCAL PART only — no domain, no @, ever', () => {
  const cases = [
    [{ agent_email: 'riker.blahnik@gmail.com' }, 'Riker Blahnik'],
    [{ email: 'tannertrustem+pptest@gmail.com' }, 'Tannertrustem Pptest'],
    [{ invitee_email: 'first_last@example.co.uk' }, 'First Last'],
    [{ leader_email: 'solo@x.io' }, 'Solo'],
  ];
  cases.forEach(([row, want]) => {
    const got = T.ppAgentName(row);
    assert.equal(got, want);
    assert.ok(!got.includes('@'), got);
    assert.ok(!/\.(com|io|co|net|org)/i.test(got), got);
  });
});

test('a name wins over an email on the same row', () => {
  assert.equal(T.ppAgentName({ agent_name: 'Jace Frenkel', agent_email: 'jacef@gmail.com' }), 'Jace Frenkel');
});

test('nothing at all is "Agent", never a blank cell', () => {
  assert.equal(T.ppAgentName(null), 'Agent');
  assert.equal(T.ppAgentName({}), 'Agent');
  assert.equal(T.ppAgentName({ agent_name: '   ' }), 'Agent');
  assert.equal(T.ppAgentName({ agent_email: '' }), 'Agent');
});

test('initials come from the NAME, so an avatar never spells an address', () => {
  assert.equal(T.ppInitials({ agent_name: 'Jace Frenkel' }), 'JF');
  assert.equal(T.ppInitials({ agent_email: 'owenclark.2831@gmail.com' }), 'O2');
  assert.equal(T.ppInitials({ agent_name: 'Cher' }), 'CH');
  assert.equal(T.ppInitials({}), 'AG');
});

// ============================================================
// 2. IDENTITY — the SQL resolver
// ============================================================

test('there is ONE SQL resolver and lb_agent_name delegates to it', () => {
  assert.match(MIG_CODE, /CREATE OR REPLACE FUNCTION public\.pp_display_name\(p_agent uuid\)/);
  const lb = MIG.slice(MIG.indexOf('FUNCTION public.lb_agent_name'), MIG.indexOf('-- 3. get_team_summary'));
  assert.match(lb, /SELECT public\.pp_display_name\(p_agent\);/);
  assert.ok(!/raw_user_meta_data/.test(lb), 'lb_agent_name must not carry a second copy of the chain');
});

test('the identity-provider name outranks the business profile', () => {
  const fn = MIG.slice(MIG.indexOf('FUNCTION public.pp_display_name'), MIG.indexOf('COMMENT ON FUNCTION public.pp_display_name'));
  const at = s => fn.indexOf(s);
  assert.ok(at("ag.display_name") < at("'full_name'"), 'the typed name comes first');
  assert.ok(at("'full_name'") < at('ag.dba_name'), 'a person outranks their company on a leaderboard');
  assert.ok(at('ag.dba_name') < at('split_part(au.email'), 'the business profile outranks the email');
});

test('THE SQL FALLBACK CANNOT EMIT AN ADDRESS — it splits on @ and keeps the left', () => {
  const fn = MIG.slice(MIG.indexOf('FUNCTION public.pp_display_name'), MIG.indexOf('COMMENT ON FUNCTION public.pp_display_name'));
  assert.match(fn, /split_part\(au\.email, '@', 1\)/);
  // au.email must appear ONLY inside that split — never as a bare fallback.
  const bare = fn.split('\n').filter(l => /au\.email/.test(l) && !/split_part/.test(l));
  assert.deepEqual(bare, [], 'au.email may only be reached through split_part');
});

test('get_team_summary and get_agency_members call the resolver, not a COALESCE', () => {
  assert.match(MIG_CODE, /public\.pp_display_name\(t\.uid\)\s+AS agent_name,/);
  assert.match(MIG_CODE, /public\.pp_display_name\(r\.uid\)\s+as agent_name,/);
  // The old shape, pinned out.
  assert.ok(!/NULLIF\(au\.raw_user_meta_data->>'display_name',''\),\s*\n?\s*au\.email\)/.test(MIG_CODE));
  assert.ok(!/coalesce\(nullif\(ag\.display_name, ''\), au\.email\)/.test(MIG_CODE));
});

test('the migration is additive and re-runnable', () => {
  assert.ok(!/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i.test(MIG_CODE));
  // Every UPDATE only ever fills a blank or corrects a stale stored name.
  assert.match(MIG_CODE, /AND COALESCE\(btrim\(ag\.display_name\), ''\) = ''/);
  assert.equal((MIG_CODE.match(/IS DISTINCT FROM public\.pp_display_name/g) || []).length, 3,
    'all three denormalized name columns are corrected, and only where stale');
});

test('the resolver is not reachable from a browser session', () => {
  assert.match(MIG_CODE, /REVOKE ALL ON FUNCTION public\.pp_display_name\(uuid\) FROM anon, authenticated/);
});

// ============================================================
// 3. THE EMAIL SWEEP — app.html as source text
// ============================================================

test('NO PEER-VISIBLE SURFACE FALLS BACK TO AN EMAIL FOR AN IDENTITY', () => {
  // The bug class: `x.agent_name || x.agent_email`. display_name was NULL for
  // every agent in production, so this was not a fallback, it was the answer.
  const offenders = [];
  const patterns = [
    /agent_name\s*\|\|\s*[\w.]*agent_email/g,
    /display_name\s*\|\|\s*[\w.]*\.email/g,
    /leader_name\s*\|\|\s*[\w.]*leader_email/g,
    /\bname\s*\|\|\s*[\w.]*invitee_email/g,
  ];
  APP_CODE.split('\n').forEach((line, i) => {
    patterns.forEach(re => { re.lastIndex = 0; if (re.test(line)) offenders.push((i + 1) + ': ' + line.trim().slice(0, 110)); });
  });
  assert.deepEqual(offenders, [], 'identity must resolve through ppAgentName()');
});

// A region helper that finds the CLOSING anchor AFTER the opening one. The
// first version searched from position 0 and happily produced empty slices,
// which pass every assertion you put on them.
const region = (from, to) => {
  const i = APP_CODE.indexOf(from);
  assert.ok(i >= 0, 'region start not found: ' + from);
  const j = APP_CODE.indexOf(to, i + from.length);
  assert.ok(j > i, 'region end not found after start: ' + to);
  return APP_CODE.slice(i, j);
};

test('the agency and leaderboard surfaces render no raw email at all', () => {
  // Scoped to the functions that draw peer-facing UI. An email is still
  // legitimately shown on a PENDING or DECLINED invite card, where it is the
  // invitation's identifier and no account exists yet — asserted separately.
  const surfaces = [
    ['function lbBoardHTML', 'function lbVisibilityHTML'],
    ['async function lbRenderRecords', 'async function lbRenderBadges'],
    ['async function lbRenderFame', '  host.innerHTML = h;'],
    ['function teamTableHTML', 'function teamPeriodChipsHTML'],
    ['function _agJoinRequestsHTML', 'async function agAcceptJoinRequest'],
    ['function sltRenderMembers', 'async function sltPick'],
  ];
  surfaces.forEach(([a, b]) => {
    const src = region(a, b);
    assert.ok(src.length > 80, 'region too small: ' + a);
    // The rule is about what is RENDERED, not about what is matched. A leader
    // typing an email into the recipient search to find the person they
    // invited is legitimate and stays; interpolating that address into the
    // markup is the thing that leaks it.
    const rendered = src.split('\n').filter(l =>
      /email/i.test(l) && /(\$\{|escapeHTML\(|escHTML\(|innerHTML)/.test(l));
    assert.deepEqual(rendered.map(l => a + ' -> ' + l.trim().slice(0, 100)), [],
      'no address may be interpolated into peer-facing markup');
  });
});

test('a connected agent is named, and their address is not printed beside it', () => {
  const roster = region('Connected Agents (', 'ag-empty-state');
  assert.match(roster, /ppAgentName\(/);
  assert.match(roster, /ppInitials\(/);
  assert.ok(!/escapeHTML\(inv\.invitee_email\)/.test(roster),
    'a connected agent is a person, not an invitation');
});

test('a PENDING invite still shows the address — it is the only identifier there is', () => {
  const pending = region('Pending Invites (', 'Declined');
  assert.match(pending, /invitee_email/, 'no account exists yet; the email IS the row');
});

test('Settings persists the name to the column every peer reads', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function saveAccountProfile'), APP_CODE.indexOf('async function saveAccountProfile') + 2200);
  assert.match(fn, /\.from\('agents'\)/);
  assert.match(fn, /display_name: name \|\| null/);
  assert.match(fn, /\.eq\('id', currentAgent\.id\)/);
  // and the caches that hold the old name are dropped
  assert.match(fn, /teamInvalidate\(\);\s*lbInvalidate\(\);/);
});

test('the boot fetch carries display_name so YOUR name resolves too', () => {
  assert.match(APP_CODE, /\.select\('contract_level, display_name'\)/);
  assert.match(APP_CODE, /function ppMyName\(\)/);
});

// ============================================================
// 4. PERIODS — the shared grammar
// ============================================================

test('the key grammar parses months, ranges and plain keys', () => {
  assert.deepEqual(T.ppParsePeriodKey('month:2026-04'), { kind: 'month', year: 2026, month: 3 });
  assert.deepEqual(T.ppParsePeriodKey('custom:2026-04-01:2026-04-17'),
    { kind: 'custom', from: '2026-04-01', to: '2026-04-17' });
  assert.equal(T.ppParsePeriodKey('month').kind, 'simple');
  assert.equal(T.ppParsePeriodKey('lifetime').kind, 'simple');
  assert.equal(T.ppParsePeriodKey('').kind, 'simple');
  assert.equal(T.ppParsePeriodKey(null).kind, 'simple');
});

test("'month:2026-04' is never mistaken for the plain 'monthly'", () => {
  assert.ok(T.ppIsDynamicPeriod('month:2026-04'));
  assert.ok(!T.ppIsDynamicPeriod('monthly'));
  assert.ok(!T.ppIsDynamicPeriod('month'));
});

test('rubbish keys are simple, not crashes', () => {
  ['month:2026-13', 'month:26-04', 'custom:2026-04-01', 'custom:x:y', 'month:'].forEach(k => {
    assert.equal(T.ppParsePeriodKey(k).kind, 'simple', k);
    assert.equal(T.ppDynamicRange(k), null, k);
  });
});

test('a picked month is that calendar month, and its prior is the month before', () => {
  const r = T.ppDynamicRange('month:2026-04');
  assert.equal(+r.start, +new Date(2026, 3, 1));
  assert.equal(+r.end, +new Date(2026, 4, 1));
  assert.equal(+r.prevStart, +new Date(2026, 2, 1));
  assert.equal(+r.prevEnd, +r.start);
  assert.match(r.label, /April 2026/);
});

test('a custom range is INCLUSIVE of its end date', () => {
  const r = T.ppDynamicRange('custom:2026-04-01:2026-04-17');
  assert.equal(+r.start, +new Date(2026, 3, 1));
  assert.equal(+r.end, +new Date(2026, 3, 18), 'end is the day AFTER the 17th');
  assert.equal(r.days, 17);
});

test("MOST IMPROVED'S BASELINE FOR A CUSTOM RANGE IS THE PRECEDING RANGE OF EQUAL LENGTH", () => {
  const r = T.ppDynamicRange('custom:2026-04-01:2026-04-17');   // 17 days
  assert.equal(+r.prevEnd, +r.start, 'the prior window ends where this one starts');
  assert.equal(+r.prevStart, +new Date(2026, 2, 15), '17 days before 1 April');
  assert.equal(Math.round((r.prevEnd - r.prevStart) / 86400000), r.days,
    'both windows are the same length, or "improved" compares unlike things');
});

test('a single-day range is one day, not zero', () => {
  const r = T.ppDynamicRange('custom:2026-04-09:2026-04-09');
  assert.equal(r.days, 1);
  assert.equal(+r.end, +new Date(2026, 3, 10));
  assert.equal(+r.prevStart, +new Date(2026, 3, 8));
});

test('an inverted range resolves to nothing rather than to a negative window', () => {
  assert.equal(T.ppDynamicRange('custom:2026-04-17:2026-04-01'), null);
});

test('a range spanning a DST change keeps its day count', () => {
  // US DST starts 2026-03-08. Local-midnight Dates make this an arithmetic
  // question, not a timezone one — which is exactly why both engines build
  // bounds this way.
  const r = T.ppDynamicRange('custom:2026-03-01:2026-03-31');
  assert.equal(r.days, 31);
  assert.equal(+r.prevStart, +new Date(2026, 0, 29));
});

// ============================================================
// 5. PERIODS — both engines read the grammar
// ============================================================

test('teamPeriodRange honours a picked month', () => {
  const r = T.teamPeriodRange('month:2026-04', D(2026, 7, 30));
  assert.equal(r.key, 'month:2026-04');
  assert.ok(r.dynamic);
  assert.equal(+r.start, +new Date(2026, 3, 1));
  assert.equal(+r.end, +new Date(2026, 4, 1));
});

test('THE AT-RISK WINDOW DOES NOT MOVE WHEN A LEADER LOOKS AT LAST APRIL', () => {
  // The badge means one fixed thing: this calendar month vs last. A leader
  // browsing history must not see agents flagged for April's numbers.
  const today = D(2026, 7, 30);
  const fixed = ['week', 'month', 'quarter', 'lifetime', 'month:2026-04', 'custom:2026-01-01:2026-01-31']
    .map(k => T.teamPeriodRange(k, today))
    .map(r => [+r.monthStart, +r.monthEnd, +r.prevMonthStart, +r.prevMonthEnd].join('|'));
  assert.equal(new Set(fixed).size, 1, 'the at-risk pair is identical for every period key');
});

test('a rubbish key still yields the default window, never a broken one', () => {
  const r = T.teamPeriodRange('custom:nope', D(2026, 7, 30));
  assert.equal(r.key, 'month');
  assert.ok(r.start instanceof Date);
});

test('the label for any key is the same one both screens show', () => {
  assert.match(T.ppPeriodLabel('month:2026-04', T.TEAM_PERIODS), /April 2026/);
  assert.equal(T.ppPeriodLabel('month', T.TEAM_PERIODS), 'This month');
  assert.equal(T.ppPeriodLabel('lifetime', T.TEAM_PERIODS), 'Lifetime');
});

test('BOTH ENGINES READ ONE PARSER — neither grew its own', () => {
  assert.match(APP_CODE, /function summaryPeriodRange[\s\S]{0,600}ppDynamicRange\(period\)/);
  assert.match(APP_CODE, /function teamPeriodRange[\s\S]{0,200}ppDynamicRange\(key\)/);
  // exactly one definition of each shared helper
  ['function ppParsePeriodKey', 'function ppDynamicRange', 'function ppDay'].forEach(f =>
    assert.equal((APP_CODE.match(new RegExp(f.replace(/[()]/g, '\\$&'), 'g')) || []).length, 1, f));
});

test('Summary gained Lifetime, and its range helpers survive null bounds', () => {
  assert.match(APP_CODE, /const LG_PERIODS = \['daily','weekly','monthly','lifetime'\]/);
  assert.match(APP_CODE, /if \(period === 'lifetime'\) return \{ start: null, end: null/);
  // The two helpers that used to dereference range.start unconditionally.
  const inR = APP_CODE.slice(APP_CODE.indexOf('function _lgInRange'), APP_CODE.indexOf('function _lgAdvComm'));
  assert.match(inR, /if\(range\.start && d<range\.start\)/);
  assert.match(inR, /if\(range\.start && t<range\.start\.getTime\(\)\)/);
});

test('the calls query drops its bounds for Lifetime instead of sending "null"', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function _lgFetchCalls'), APP_CODE.indexOf('async function _lgFetchCalls') + 1400);
  assert.match(fn, /if \(range\.start\) q = q\.gte\('started_at'/);
  assert.match(fn, /if \(range\.end\)   q = q\.lt\('started_at'/);
  assert.ok(!/\.gte\('started_at', range\.start\.toISOString\(\)\)\s*\n?\s*\.lt/.test(fn));
});

test('both setters refuse a key that does not resolve', () => {
  const setL = APP_CODE.slice(APP_CODE.indexOf('function setLedgerPeriod'), APP_CODE.indexOf('function ppMonthOptions'));
  assert.match(setL, /if\(ppIsDynamicPeriod\(p\) && !ppDynamicRange\(p\)\) return;/);
  const setT = APP_CODE.slice(APP_CODE.indexOf('function teamSetPeriod'), APP_CODE.indexOf('function teamSetSort'));
  assert.match(setT, /if \(dyn && !ppDynamicRange\(key\)\) return;/);
  assert.match(setT, /teamInvalidate\(\);/, 'a new window must not render the old window\'s cache');
});

test('a stored key that no longer resolves cannot brick the screen on load', () => {
  const init = APP_CODE.slice(APP_CODE.indexOf("localStorage.getItem('pp_team_period')"), APP_CODE.indexOf("localStorage.getItem('pp_team_period')") + 420);
  assert.match(init, /ppIsDynamicPeriod\(v\) && ppDynamicRange\(v\)/);
});

test('ONE picker builder serves both screens', () => {
  assert.equal((APP_CODE.match(/function ppPeriodPickerHTML/g) || []).length, 1);
  assert.match(APP_CODE, /ppPeriodPickerHTML\(period, 'setLedgerPeriod'/);
  assert.match(APP_CODE, /ppPeriodPickerHTML\(_teamPeriod, 'teamSetPeriod', surface/);
});

test('Most Improved states what it compared a picked window against', () => {
  const r = APP_CODE.slice(APP_CODE.indexOf("if (board === 'improved' && ppIsDynamicPeriod"), APP_CODE.indexOf("if (board === 'improved' && ppIsDynamicPeriod") + 600);
  assert.match(r, /the month before this one/);
  assert.match(r, /days immediately before this range/);
});

test('the drill-down profile names an agent and prints no address', () => {
  const prof = region('async function agOpenAgentProfile', 'Back to Agency');
  assert.match(prof, /ppAgentName\(member\)/);
  assert.ok(!/escapeHTML\(email\)/.test(prof), 'the profile header must not print an address');
  assert.ok(!/agent_email/.test(prof), 'and must not reach for one');
});

test('A STORED DYNAMIC KEY SURVIVES A RELOAD ON BOTH SCREENS', () => {
  // Both initialisers read localStorage at load. Teaching only the SETTER
  // about month:/custom: made a picked window silently revert to the default
  // on the next page load — which is worse than not offering it.
  const sum = region("let ledgerPeriod = (function()", "const _lgCalls");
  assert.match(sum, /ppIsDynamicPeriod\(v\) && ppDynamicRange\(v\)/);
  const team = region("let _teamPeriod = (function ()", "let _teamCardOpen");
  assert.match(team, /ppIsDynamicPeriod\(v\) && ppDynamicRange\(v\)/);
});
