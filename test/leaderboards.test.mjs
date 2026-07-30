// ============================================================
// leaderboards.test.mjs — run with:  npm run test:leaderboards
//
// Two kinds of test, and the split is deliberate.
//
//   1. BEHAVIOUR. The pure block between the // <leaderboard-core> sentinels
//      in app.html is extracted and executed verbatim. app.html has no build
//      step and no module system, so a mirrored copy of the logic would be a
//      second definition that drifts. These tests run the exact text that
//      ships.
//
//   2. STRUCTURE. Assertions about app.html and the migration as source text:
//      one RPC call site, one period engine, the top-10 cutoff enforced by
//      the server, no parameter naming an agent, and — the important one —
//      that the leaderboard's AP definition is BYTE-IDENTICAL to the one
//      get_team_summary uses. That last test is the whole reason the boards
//      and the team table can sit on the same tab.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP  = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIG  = readFileSync(join(ROOT, 'supabase/migrations/20260750_agency_leaderboards.sql'), 'utf8');
const TEAM = readFileSync(join(ROOT, 'supabase/migrations/20260741_book_of_business.sql'), 'utf8');
const CRON = readFileSync(join(ROOT, 'supabase/schedule_leaderboards.sql'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n')
  .filter(l => !markers.some(m => l.trim().startsWith(m)))
  .join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);
const MIG_CODE = stripLineComments(MIG, ['--']);

// ------------------------------------------------------------
// Load the shipped core, plus the two team-core formatters it uses.
// ------------------------------------------------------------
const EXPORTS = [
  'LB_BOARDS', 'LB_BOARD_DEFAULT', 'LB_TOP_N', 'LB_MIN_DIALS', 'LB_IMPROVED_MIN_PRIOR',
  'LB_BASES', 'LB_BASIS_DEFAULT', 'LB_PERSONAL_RECORDS', 'LB_AGENCY_RECORDS', 'LB_FAMILIES',
  'LB_BANNER_MAX_AGE_MS',
  'lbBoardDef', 'lbBoardsFor', 'lbResolveBoard', 'lbBasisApplies', 'lbFormat', 'lbMedal',
  'lbSplitRows', 'lbGapText', 'lbInitials', 'lbGroupBoards', 'lbRecordDef', 'lbRecordFormat',
  'lbNudge', 'lbGroupBadges', 'lbEarnedCount', 'lbNewlyEarned', 'lbEarnedKeys', 'lbBannerEvent',
];

function loadCore() {
  const team = APP.match(/\/\/ <team-core>([\s\S]*?)\/\/ <\/team-core>/);
  const lb   = APP.match(/\/\/ <leaderboard-core>([\s\S]*?)\/\/ <\/leaderboard-core>/);
  assert.ok(team, 'app.html must contain the // <team-core> block');
  assert.ok(lb, 'app.html must contain the // <leaderboard-core> ... // </leaderboard-core> block');
  // leaderboard-core calls tmDur() for talk time — deliberately, so the board
  // and the team table's "Call time" column format the same seconds the same
  // way. Load team-core alongside it rather than stubbing that out.
  // eslint-disable-next-line no-new-func
  return new Function(`${team[1]}\n${lb[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const L = loadCore();

const row = (o) => Object.assign({
  board_key: 'ap', rank: 1, agent_id: 'a', agent_name: 'A', value: 100,
  secondary: null, is_you: false, in_top: true, top_value: 100, entrants: 1,
}, o);

// ============================================================
// 1. THE BOARDS
// ============================================================

test('the two boards the data could not support are absent, and stay absent', () => {
  const keys = L.LB_BOARDS.map(b => b.key);
  assert.ok(!keys.includes('appointments'), 'Most Appointments Set needs an appointment-set timestamp');
  assert.ok(!keys.includes('placement_rate'), 'Best Placement Rate needs denied/withdrawn to be in use');
  assert.equal(L.LB_BOARDS.length, 7);
});

test('Most Improved is offered on week/month/quarter and NOT on lifetime', () => {
  ['week', 'month', 'quarter'].forEach(p =>
    assert.ok(lbHas(L.lbBoardsFor(p), 'improved'), p + ' should offer Most Improved'));
  assert.ok(!lbHas(L.lbBoardsFor('lifetime'), 'improved'),
    'Lifetime has no comparable preceding period, so the board would be a lie');
});
const lbHas = (list, key) => list.some(b => b.key === key);

test('a board selected on a period that does not offer it falls back to AP', () => {
  assert.equal(L.lbResolveBoard('improved', 'lifetime'), 'ap');
  assert.equal(L.lbResolveBoard('improved', 'month'), 'improved');
  assert.equal(L.lbResolveBoard('nonsense', 'month'), 'ap');
});

test('the AP basis toggle applies only where AP is the metric', () => {
  assert.ok(L.lbBasisApplies('ap'));
  assert.ok(L.lbBasisApplies('ap_per_dial'));
  assert.ok(L.lbBasisApplies('improved'));
  assert.ok(!L.lbBasisApplies('dials'), 'a dial is a dial whichever AP basis you pick');
  assert.ok(!L.lbBasisApplies('talk'));
  assert.ok(!L.lbBasisApplies('policies'));
});

test('net is the default basis — the app\'s one definition of a sale', () => {
  assert.equal(L.LB_BASIS_DEFAULT, 'net');
  assert.equal(L.LB_BASES[0].key, 'net');
});

test('formatters: money loses the cents, rates keep one decimal, gains carry a sign', () => {
  assert.equal(L.lbFormat('money', 1234.56), '$1,235');
  assert.equal(L.lbFormat('money2', 18.333), '$18.33');
  assert.equal(L.lbFormat('int', 1234), '1,234');
  assert.equal(L.lbFormat('pct', 4.25), '4.3%');
  assert.equal(L.lbFormat('gain', 60), '+60%');
  assert.equal(L.lbFormat('dur', 5400), '1h 30m');
  assert.equal(L.lbFormat('money', 'nonsense'), '—');
});

test('only the first three ranks get an accent', () => {
  assert.equal(L.lbMedal(1), 'gold');
  assert.equal(L.lbMedal(2), 'silver');
  assert.equal(L.lbMedal(3), 'bronze');
  assert.equal(L.lbMedal(4), null);
  assert.equal(L.lbMedal(11), null);
});

// ============================================================
// 2. THE TOP-10 CUTOFF AND THE PRIVATE OWN-RANK ROW
// ============================================================

test('the public board is the in_top rows, in rank order', () => {
  const s = L.lbSplitRows([
    row({ rank: 3, agent_id: 'c', value: 30 }),
    row({ rank: 1, agent_id: 'a', value: 50 }),
    row({ rank: 2, agent_id: 'b', value: 40 }),
  ]);
  assert.deepEqual(s.top.map(r => r.agent_id), ['a', 'b', 'c']);
  assert.equal(s.you, null);
});

test('a viewer outside the top 10 gets exactly one private row, and it is theirs', () => {
  const s = L.lbSplitRows([
    row({ rank: 1, agent_id: 'a', value: 50 }),
    row({ rank: 14, agent_id: 'me', value: 5, in_top: false, is_you: true }),
  ]);
  assert.equal(s.top.length, 1);
  assert.equal(s.you.agent_id, 'me');
  assert.equal(s.you.rank, 14);
});

test('a viewer INSIDE the top 10 gets no pinned row — they are already on the board', () => {
  const s = L.lbSplitRows([row({ rank: 4, agent_id: 'me', is_you: true, in_top: true })]);
  assert.equal(s.you, null);
  assert.equal(s.top.length, 1);
  assert.ok(s.top[0].is_you);
});

test('the gap sentence names the distance, never the agent standing in the way', () => {
  const you = { rank: 14, value: 660 };
  const text = L.lbGapText(you, 1500, 'money');
  assert.match(text, /#14/);
  assert.match(text, /\$840/);
  assert.match(text, /top 10/);
  assert.ok(!/\bagent\b|\bname\b/i.test(text.replace('from the top 10', '')),
    'the sentence must not identify who holds tenth place');
});

test('a viewer who somehow ties the cutoff gets a sentence, not a negative gap', () => {
  assert.match(L.lbGapText({ rank: 10, value: 300 }, 300, 'money'), /#10 this period\./);
  assert.equal(L.lbGapText(null, 300, 'money'), '');
});

test('grouping keeps each board\'s cutoff and entrant count', () => {
  const g = L.lbGroupBoards([
    row({ board_key: 'ap', rank: 1, value: 900, top_value: 300, entrants: 12 }),
    row({ board_key: 'ap', rank: 2, value: 300, top_value: 300, entrants: 12 }),
    row({ board_key: 'dials', rank: 1, value: 50, top_value: 50, entrants: 3 }),
  ]);
  assert.equal(g.ap.rows.length, 2);
  assert.equal(g.ap.topValue, 300);
  assert.equal(g.ap.entrants, 12);
  assert.equal(g.dials.entrants, 3);
});

test('THE BROWSER NEVER FILTERS A RANK OUT OF THE PAYLOAD — the server sends the cutoff', () => {
  // lbSplitRows partitions on the in_top flag the server set. If it ever
  // started comparing rank to LB_TOP_N itself, that would mean the tail was
  // being sent to the browser and merely hidden, which is a different and
  // much worse thing.
  const src = APP.slice(APP.indexOf('function lbSplitRows'), APP.indexOf('function lbGapText'));
  assert.ok(!/LB_TOP_N/.test(src), 'lbSplitRows must trust in_top, not re-derive the cutoff');
  assert.match(src, /r\.in_top/);
});

// ============================================================
// 3. RECORDS
// ============================================================

test('the seven personal records and the seven agency records are the brief\'s', () => {
  assert.deepEqual(L.LB_PERSONAL_RECORDS.map(r => r.key), [
    'best_day_ap', 'best_day_policies', 'best_week_ap', 'best_month_ap',
    'biggest_policy_ap', 'longest_sale_streak', 'fastest_lead_to_sale',
  ]);
  assert.deepEqual(L.LB_AGENCY_RECORDS.map(r => r.key), [
    'team_day_ap', 'agent_day_ap', 'team_week_ap', 'team_month_ap',
    'biggest_policy_ap', 'agent_day_policies', 'fastest_lead_to_sale',
  ]);
});

test('every record key the browser renders is one the migration can write', () => {
  const inSql = k => MIG_CODE.includes(`'${k}'`);
  L.LB_PERSONAL_RECORDS.forEach(r => assert.ok(inSql(r.key), 'personal record missing in SQL: ' + r.key));
  L.LB_AGENCY_RECORDS.forEach(r => assert.ok(inSql(r.key), 'agency record missing in SQL: ' + r.key));
});

test('a day count reads as days, money reads as money', () => {
  assert.equal(L.lbRecordFormat('days', 5), '5 days');
  assert.equal(L.lbRecordFormat('days', 1), '1 day');
  assert.equal(L.lbRecordFormat('money', 4200), '$4,200');
  assert.equal(L.lbRecordFormat('int', 3), '3');
});

test('a nudge only fires when the agent is genuinely close AND genuinely behind', () => {
  assert.equal(L.lbNudge('money', 5000, 4200), '$800 away');
  assert.equal(L.lbNudge('int', 10, 8), '2 away');
  assert.equal(L.lbNudge('money', 5000, 1000), '', 'four fifths short is not a nudge, it is a scold');
  assert.equal(L.lbNudge('money', 5000, 5000), '', 'you cannot be nudged toward a record you hold');
  assert.equal(L.lbNudge('money', 5000, 6000), '', 'nor toward one you have already beaten');
  assert.equal(L.lbNudge('money', 0, 0), '');
  assert.equal(L.lbNudge('days', 9, 8), '', 'no nudge shape defined for durations');
});

// ============================================================
// 4. ACHIEVEMENTS
// ============================================================

test('the gallery groups by family and shows unearned badges too', () => {
  const list = [
    { key: 'a', family: 'sales',  sort_order: 2, earned_at: '2026-01-01' },
    { key: 'b', family: 'sales',  sort_order: 1, earned_at: null },
    { key: 'c', family: 'volume', sort_order: 1, earned_at: null },
  ];
  const g = L.lbGroupBadges(list);
  assert.equal(g.length, 2);
  assert.equal(g[0].key, 'sales');
  assert.deepEqual(g[0].badges.map(b => b.key), ['b', 'a'], 'ordered by sort_order, earned or not');
  assert.equal(L.lbEarnedCount(list), 1);
});

test('a family with no badges is not rendered as an empty heading', () => {
  assert.equal(L.lbGroupBadges([{ key: 'a', family: 'sales', sort_order: 1 }]).length, 1);
  assert.equal(L.lbGroupBadges([]).length, 0);
});

test('THE FIRST EVER LOAD TOASTS NOTHING — the backfill is history, not an event', () => {
  const list = [
    { key: 'first_sale', name: 'First Sale', earned_at: '2026-01-01' },
    { key: 'hat_trick',  name: 'Hat Trick',  earned_at: '2026-02-01' },
  ];
  assert.deepEqual(L.lbNewlyEarned(list, null), [],
    'null means this browser has never looked; twelve backfilled badges must not become twelve toasts');
  assert.deepEqual(L.lbNewlyEarned(list, ['first_sale']).map(b => b.key), ['hat_trick']);
  assert.deepEqual(L.lbNewlyEarned(list, ['first_sale', 'hat_trick']), []);
  assert.deepEqual(L.lbEarnedKeys(list), ['first_sale', 'hat_trick']);
});

test('an unearned badge is never announced', () => {
  const list = [{ key: 'ap_250k', name: '$250k Club', earned_at: null }];
  assert.deepEqual(L.lbNewlyEarned(list, []), []);
});

test('every achievement key the SQL seeds has a family the gallery renders', () => {
  const families = new Set(L.LB_FAMILIES.map(f => f.key));
  // Parsed line-wise rather than with one big regex: the seed contains
  // 'Producer''s Club 10', and an escaped quote defeats any [^']* pattern.
  const block = MIG.slice(MIG.indexOf('(key, name, description, criteria, family, metric'),
                          MIG.indexOf('ON CONFLICT (key) DO UPDATE'));
  const rows = block.split('\n').filter(l => /^\s*\('[a-z0-9_]+',/.test(l));
  assert.equal(rows.length, 18, `expected 18 seeded badges, parsed ${rows.length}`);
  rows.forEach(l => {
    const key = l.match(/^\s*\('([a-z0-9_]+)'/)[1];
    const fam = [...l.matchAll(/'(sales|volume|consistency|activity|quality)'/g)].map(m => m[1]);
    assert.equal(fam.length, 1, `${key} must name exactly one family`);
    assert.ok(families.has(fam[0]), `family ${fam[0]} on ${key} has no gallery section`);
  });
});

test('Early Bird and Closer are NOT seeded — there is no sale-time timestamp', () => {
  assert.ok(!/'early_bird'/.test(MIG), 'a badge for "before 10 AM" would reward data entry, not selling');
  assert.ok(!/'closer'/.test(MIG));
  // Weekend Warrior survives because a sale DATE genuinely is a Saturday.
  assert.match(MIG, /'weekend_warrior'/);
  assert.match(MIG_CODE, /EXTRACT\(dow FROM sub_date\) IN \(0,6\)/);
});

// ============================================================
// 5. MILESTONES AND BANNERS
// ============================================================

test('the banner shows the newest agency record from the last 48 hours', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const events = [
    { id: '1', kind: 'agency_record', occurred_at: '2026-07-30T09:00:00Z' },
    { id: '2', kind: 'agency_record', occurred_at: '2026-07-20T09:00:00Z' },
  ];
  assert.equal(L.lbBannerEvent(events, [], now).id, '1');
});

test('a dismissed banner stays dismissed, and only that one', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const events = [
    { id: '1', kind: 'agency_record', occurred_at: '2026-07-30T09:00:00Z' },
    { id: '2', kind: 'agency_record', occurred_at: '2026-07-29T09:00:00Z' },
  ];
  assert.equal(L.lbBannerEvent(events, ['1'], now).id, '2');
  assert.equal(L.lbBannerEvent(events, ['1', '2'], now), null);
});

test('an agency record older than 48 hours no longer banners', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  assert.equal(L.lbBannerEvent(
    [{ id: '1', kind: 'agency_record', occurred_at: '2026-07-27T09:00:00Z' }], [], now), null);
  assert.equal(L.LB_BANNER_MAX_AGE_MS, 48 * 3600 * 1000);
});

test('A PERSONAL BEST NEVER BANNERS ACROSS EVERYONE\'S SCREEN', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  ['personal_record', 'achievement', 'season'].forEach(kind =>
    assert.equal(L.lbBannerEvent([{ id: '1', kind, occurred_at: '2026-07-30T09:00:00Z' }], [], now), null,
      kind + ' belongs in the feed, not in a banner'));
});

// ============================================================
// 6. THE ONE-ENGINE INVARIANTS (app.html as source text)
// ============================================================

test('exactly ONE sb.rpc(\'get_agency_leaderboards\') call site', () => {
  const hits = APP_CODE.match(/sb\.rpc\(\s*['"]get_agency_leaderboards['"]/g) || [];
  assert.equal(hits.length, 1, 'two call sites is two sets of window arguments');
  assert.match(APP_CODE.slice(APP_CODE.indexOf('async function lbLoadBoards'), APP_CODE.indexOf('async function lbRefreshMe')),
    /sb\.rpc\('get_agency_leaderboards'/);
});

test('THE LEADERBOARD HAS NO PERIOD ENGINE OF ITS OWN — it reads teamPeriodRange', () => {
  // Every place the boards resolve a window.
  assert.match(APP_CODE, /async function lbLoadBoards[\s\S]{0,400}teamPeriodRange\(periodKey, new Date\(\)\)/);
  assert.match(APP_CODE, /function _lbCurrentTotals[\s\S]{0,400}teamPeriodRange\('week', now\)/);
  // And it must not have grown one.
  const lbBlock = APP.slice(APP.indexOf('// <leaderboard-core>'), APP.indexOf('async function lbRenderFame'));
  assert.ok(!/getDay\(\)/.test(lbBlock), 'week-start arithmetic belongs to teamPeriodRange alone');
  assert.ok(!/Math\.floor\(\s*\w+\.getMonth\(\)\s*\/\s*3\s*\)/.test(lbBlock.replace(/lbRenderFame[\s\S]*/, '')),
    'quarter arithmetic belongs to teamPeriodRange alone');
});

test('lbRpcArgs maps a range onto the RPC and computes no dates itself', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function lbRpcArgs'), APP_CODE.indexOf('function lbInvalidate'));
  ['range.start', 'range.end', 'range.prevStart', 'range.prevEnd'].forEach(k =>
    assert.ok(fn.includes(k), 'lbRpcArgs must read ' + k + ' from the shared range'));
  assert.ok(!/new Date\(/.test(fn), 'lbRpcArgs must not mint a date of its own');
});

test('the period selector is the SAME one the team table uses', () => {
  // ONE stored value across the whole Agency tab. The boards render the
  // team's period chips and the team table reads the same key, so the two
  // halves of one screen cannot show different windows.
  assert.match(APP_CODE, /lbLoadBoards\(_teamPeriod, _lbBasis\)/);
  assert.match(APP_CODE, /lbResolveBoard\(_lbBoard, _teamPeriod\)/);
  assert.match(APP_CODE, /teamPeriodChipsHTML\('agency'\)/);
  assert.ok(!/'pp_lb_period'/.test(APP_CODE), 'a second period key is a second answer to "this month"');
  assert.equal((APP_CODE.match(/localStorage\.getItem\('pp_team_period'\)/g) || []).length, 1);
});

test('the leaderboard-core block is pure', () => {
  const m = APP.match(/\/\/ <leaderboard-core>([\s\S]*?)\/\/ <\/leaderboard-core>/);
  const body = m[1];
  [/\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/, /\bcurrentAgent\b/, /\bshowToast\b/]
    .forEach(re => assert.ok(!re.test(body), 'leaderboard-core must stay pure: ' + re));
});

test('every core sentinel still appears exactly once, including the new one', () => {
  ['bob-core', 'comm-core', 'persist-core', 'recon-core', 'referral-core',
   'backoffice-core', 'team-core', 'producer-codes-core', 'leaderboard-core',
   'ai-meter-core'].forEach(name => {
    assert.equal((APP.match(new RegExp(`// <${name}>`, 'g')) || []).length, 1, `// <${name}>`);
    assert.equal((APP.match(new RegExp(`// </${name}>`, 'g')) || []).length, 1, `// </${name}>`);
  });
});

test('the Agency areas are resolved from a list, never by position', () => {
  assert.match(APP_CODE, /const LB_AREAS = \[/);
  assert.match(APP_CODE, /LB_AREAS\.some\(a => a\.key === _lbArea\)/);
  // The positional-index bug class this repo has paid for twice.
  assert.ok(!/LB_AREAS\[\s*\d+\s*\]/.test(APP_CODE), 'an area must never be selected by index');
});

test('Team stays the default area, so the invitee view is what a new member lands on', () => {
  assert.equal(APP_CODE.match(/localStorage\.getItem\('pp_ag_area'\);\s*return LB_AREAS\.some\(a => a\.key === v\) \? v : 'team'/) !== null, true);
  assert.match(APP_CODE, /LB_AREAS\.some\(a => a\.key === _lbArea\) \? _lbArea : 'team'/);
});

test('the invitee view is still reachable and still ungated', () => {
  // _agRenderAgentView is the ONLY place an invitee can accept an invite or
  // revoke a leader's access. A tier gate on nav('agency') made every emailed
  // invite unacceptable once already; the new tab strip must not re-do it.
  assert.match(APP_CODE, /else\s+await _agRenderAgentView\(host\)/);
  assert.ok(!/id === 'agency'[^\n]*_navTier !== 'leader'/.test(APP_CODE),
    'the nav() leader gate on Agency must not come back');
});

test('the visibility toggle writes the agent\'s own row and nothing else', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function lbToggleVisibility'), APP_CODE.indexOf('function lbDismissBanner'));
  assert.match(fn, /\.from\('agents'\)/);
  assert.match(fn, /\.eq\('id', currentAgent\.id\)/);
  assert.match(fn, /hide_from_leaderboards/);
  assert.ok(!/agency_records|agent_achievements|agent_records|leaderboard_snapshots|agency_milestones/.test(fn),
    'the browser must never write a leaderboard table directly');
});

test('THE BROWSER WRITES NO LEADERBOARD TABLE DIRECTLY', () => {
  ['agent_records', 'agent_achievements', 'agency_records', 'leaderboard_snapshots',
   'agency_milestones', 'achievement_definitions'].forEach(t => {
    const re = new RegExp(`from\\('${t}'\\)\\s*\\n?\\s*\\.(insert|update|upsert|delete)`, 'g');
    assert.equal((APP_CODE.match(re) || []).length, 0, `app.html must not write ${t}`);
  });
  assert.match(APP_CODE, /sb\.rpc\('lb_refresh_me'\)/);
});

// ============================================================
// 7. THE MIGRATION (SQL as source text)
// ============================================================

test('THE SALE PREDICATE IS BYTE-IDENTICAL TO get_team_summary\'s', () => {
  // 20260741 is the migration that most recently defines get_team_summary.
  // If either file changes its mind about what a sale is, this fails rather
  // than the two screens quietly reporting different AP for the same agent.
  const predicate = /COALESCE\(po\.data->>'status',''\) NOT IN \('lapsed','chargeback','denied','withdrawn'\)/;
  const teamHit = TEAM.match(predicate);
  assert.ok(teamHit, 'get_team_summary\'s predicate moved — find it and update this test deliberately');
  assert.ok(MIG.includes(teamHit[0]), 'the leaderboard must use the identical sale predicate');
});

test('THE AP GUARD AND THE SALE-DATE CHAIN ARE BYTE-IDENTICAL TOO', () => {
  const apGuard = /CASE WHEN COALESCE\(po\.data->>'ap',''\) ~ '\^-\?\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'\s*\n?\s*THEN \(po\.data->>'ap'\)::numeric ELSE 0 END/;
  const teamAp = TEAM.match(apGuard);
  assert.ok(teamAp, 'get_team_summary\'s AP guard moved');
  const norm = s => s.replace(/\s+/g, ' ');
  assert.ok(norm(MIG).includes(norm(teamAp[0])), 'the leaderboard must guard AP identically');

  const chain = "COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft',''))";
  assert.ok(TEAM.includes(chain) && MIG.includes(chain), 'the sale-date chain must be the same one');
});

test('the Placed basis reuses PERSIST_KEPT rather than inventing a status list', () => {
  const persist = readFileSync(join(ROOT, 'supabase/migrations/20260743_persistency.sql'), 'utf8');
  assert.match(persist, /'issued','paid','placed','claim'/);
  assert.match(MIG_CODE, /IN \('issued','paid','placed','claim'\)/);
});

test('NO BROWSER-CALLABLE FUNCTION TAKES A PARAMETER NAMING AN AGENT OR A LEADER', () => {
  const browserFns = [
    'get_agency_leaderboards', 'lb_my_agency_state', 'get_agency_records',
    'get_agency_milestones', 'get_agency_hall_of_fame', 'get_my_achievements', 'lb_refresh_me',
  ];
  browserFns.forEach(fn => {
    const i = MIG.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    assert.ok(i > 0, 'missing function ' + fn);
    const sig = MIG.slice(i, MIG.indexOf('RETURNS', i));
    assert.ok(!/p_agent|p_leader|agent_id\s+uuid|leader_id\s+uuid|uuid/.test(sig),
      `${fn} must not accept anything naming an agent — signature was: ${sig.trim()}`);
  });
});

test('every internal helper taking a uuid is REVOKEd from authenticated', () => {
  ['lb_leader_for', 'lb_members', 'lb_visible_members', 'lb_agent_name',
   'lb_agent_metrics', 'lb_board_rows', 'lb_evaluate', 'lb_evaluate_agency',
   'lb_evaluate_all', 'lb_snapshot_period', 'lb_rollover'].forEach(fn => {
    const re = new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)\\s+FROM anon, authenticated`);
    assert.match(MIG, re, fn + ' must be unreachable from a browser session');
  });
});

test('NO TABLE IN THIS MIGRATION GETS AN INSERT, UPDATE OR DELETE POLICY', () => {
  const policies = MIG_CODE.match(/CREATE POLICY[\s\S]*?USING/g) || [];
  assert.equal(policies.length, 3, 'three SELECT policies, no more');
  policies.forEach(p => assert.match(p, /FOR SELECT/, 'every policy must be SELECT-only'));
  assert.ok(!/FOR (INSERT|UPDATE|DELETE|ALL)/.test(MIG_CODE),
    'a policy wide enough to record an achievement is wide enough to record one you did not earn');
});

test('the snapshot uniqueness grain is the AGENT, because ties share a rank', () => {
  assert.match(MIG_CODE, /UNIQUE \(leader_id, period_kind, period_start, board_key, agent_id\)/);
  assert.ok(!/UNIQUE \(leader_id, period_kind, period_start, board_key, rank\)/.test(
    MIG_CODE.replace(/leaderboard_snapshots_leader_id_period_kind_period_start_bo_key/g, '')),
    'keying on rank silently drops the second row of every tie');
  assert.match(MIG_CODE, /ON CONFLICT \(leader_id, period_kind, period_start, board_key, agent_id\) DO NOTHING/);
});

test('ties share a rank — rank(), never dense_rank() or row_number()', () => {
  const fn = MIG.slice(MIG.indexOf('FUNCTION public.lb_board_rows'), MIG.indexOf('FUNCTION public.get_agency_leaderboards'));
  assert.match(fn, /RANK\(\) OVER \(PARTITION BY r\.bk ORDER BY r\.val DESC\)/);
  assert.ok(!/DENSE_RANK|ROW_NUMBER/i.test(fn), 'a scoreboard skips the rank after a tie');
});

test('the board RPC sends the top 10 plus the caller, and nothing else', () => {
  const fn = MIG.slice(MIG.indexOf('FUNCTION public.get_agency_leaderboards'), MIG.indexOf('FUNCTION public.lb_my_agency_state'));
  assert.match(fn, /WHERE b\.rank <= 10 OR b\.agent_id = \(SELECT uid FROM me\)/);
});

test('rate boards enforce their minimum volume in SQL, not in the UI', () => {
  const fn = MIG.slice(MIG.indexOf('FUNCTION public.lb_board_rows'), MIG.indexOf('FUNCTION public.get_agency_leaderboards'));
  assert.equal((fn.match(/c\.dials >= 50/g) || []).length, 2, 'close_rate and ap_per_dial both gated');
  assert.equal(L.LB_MIN_DIALS, 50, 'and the UI states the same number');
  assert.match(fn, /p\.ap >= 500/);
  assert.equal(L.LB_IMPROVED_MIN_PRIOR, 500);
  assert.match(fn, /p_prev_start IS NOT NULL/, 'Most Improved needs a prior period to exist');
});

test('THE HIDDEN-AGENT FILTER SITS BELOW EVERY PEER-VISIBLE READ', () => {
  assert.match(MIG, /FUNCTION public\.lb_visible_members\(p_leader uuid\)[\s\S]*?COALESCE\(a\.hide_from_leaderboards, false\) = false/);
  // The board RPC and the agency-record evaluator both go through it.
  const board = MIG.slice(MIG.indexOf('FUNCTION public.get_agency_leaderboards'), MIG.indexOf('FUNCTION public.lb_my_agency_state'));
  assert.match(board, /lb_visible_members/);
  const agency = MIG.slice(MIG.indexOf('FUNCTION public.lb_evaluate_agency'), MIG.indexOf('FUNCTION public.lb_refresh_me'));
  assert.match(agency, /lb_visible_members/, 'a hidden agent must not hold or lift an agency record');
  // A hidden agent writes no milestone.
  const evalFn = MIG.slice(MIG.indexOf('FUNCTION public.lb_evaluate(') , MIG.indexOf('FUNCTION public.lb_evaluate_agency'));
  assert.equal((evalFn.match(/NOT v_hidden/g) || []).length, 2, 'both feed writes must check it');
});

test('the backfill is feed-silent and idempotent by construction', () => {
  assert.match(MIG, /FUNCTION public\.lb_evaluate_all\(p_silent boolean DEFAULT true\)/,
    'the sweep defaults to silent — the launch backfill is the common case');
  assert.match(MIG_CODE, /ON CONFLICT \(agent_id, achievement_key\) DO NOTHING/);
  assert.match(MIG_CODE, /ON CONFLICT \(leader_id, dedupe_key\) DO NOTHING/);
  assert.match(MIG_CODE, /lb_record_is_better/);
});

test('a backfilled unlock is stamped at NOON, never midnight', () => {
  // changed_at/earned_at is a timestamptz rendered in the reader's local
  // zone; midnight shows the previous day for every agent west of UTC. This
  // schema has paid for that once already (20260741, all 23 rows).
  assert.match(MIG_CODE, /\(v_rec\.on_date \+ TIME '12:00'\) AT TIME ZONE 'UTC'/);
  assert.ok(!/TIME '00:00'/.test(MIG_CODE));
});

test('day buckets for calls are America/Chicago, not the server\'s UTC', () => {
  // A 7 PM Central dial is tomorrow in UTC, which would break a dial streak.
  assert.match(MIG_CODE, /\(c\.started_at AT TIME ZONE 'America\/Chicago'\)::date/);
  assert.match(MIG_CODE, /\(now\(\) AT TIME ZONE 'America\/Chicago'\)::date/);
});

test('the business-day index folds the weekend onto the following Monday', () => {
  assert.match(MIG_CODE, /FUNCTION public\.lb_biz_index/);
  assert.match(MIG_CODE, /LEAST\(\(d - DATE '1970-01-05'\) % 7, 5\)/);
  // 1970-01-05 is a Monday, so the modulo can never go negative for any date
  // this app can hold.
  assert.equal(new Date(Date.UTC(1970, 0, 5)).getUTCDay(), 1);
});

test('Placed & Paid ignores policies that have not resolved yet', () => {
  const evalFn = MIG.slice(MIG.indexOf('resolved AS ('), MIG.indexOf('placed_run AS ('));
  assert.match(evalFn, /WHERE status IN \('issued','paid','placed','claim','lapsed','chargeback','denied','withdrawn'\)/);
  assert.ok(!/'pending'/.test(evalFn), 'a pending application has not fallen off, it has just not landed');
  assert.ok(!/'approved'/.test(evalFn));
});

test('no agency record carries a client name, a policy number or a carrier', () => {
  const tbl = MIG.slice(MIG.indexOf('CREATE TABLE IF NOT EXISTS public.agency_records'),
                        MIG.indexOf('CREATE INDEX IF NOT EXISTS agency_records_leader_idx'));
  [/client/i, /policy_number/i, /insured/i, /carrier/i, /commission/i].forEach(re =>
    assert.ok(!re.test(tbl), 'agency_records must not carry ' + re));
  const snap = MIG.slice(MIG.indexOf('CREATE TABLE IF NOT EXISTS public.leaderboard_snapshots'),
                         MIG.indexOf('CREATE INDEX IF NOT EXISTS leaderboard_snapshots_lookup_idx'));
  [/client/i, /policy_number/i, /carrier/i, /commission/i].forEach(re =>
    assert.ok(!re.test(snap), 'leaderboard_snapshots must not carry ' + re));
});

test('the migration is additive — no DROP of a table, column or row', () => {
  // MIG_CODE, not MIG: the file's own header says "no DROP, no DELETE, no
  // TRUNCATE" in prose, and a test that fails because the file documents the
  // rule would be a test that punishes documenting the rule.
  assert.ok(!/DROP TABLE/i.test(MIG_CODE));
  assert.ok(!/DROP COLUMN/i.test(MIG_CODE));
  assert.ok(!/\bTRUNCATE\b/i.test(MIG_CODE));
  assert.ok(!/DELETE FROM/i.test(MIG_CODE));
  // DROP POLICY immediately before CREATE POLICY is this repo's standard
  // idempotency idiom. The single DROP CONSTRAINT is the guarded tie fix, and
  // it is guarded on the auto-generated name so it is a no-op everywhere the
  // first version of this file never ran.
  const drops = (MIG_CODE.match(/DROP (?!POLICY|CONSTRAINT|TRIGGER)\w+/gi) || []);
  assert.deepEqual(drops, []);
  assert.equal((MIG_CODE.match(/DROP CONSTRAINT/gi) || []).length, 1);
  assert.match(MIG_CODE, /IF EXISTS \(SELECT 1 FROM pg_constraint[\s\S]{0,400}DROP CONSTRAINT/);
});

// ============================================================
// 8. THE CRON JOBS
// ============================================================

test('both jobs call SQL directly — there is no edge function and no secret', () => {
  const CRON_CODE = stripLineComments(CRON, ['--']);
  assert.match(CRON_CODE, /select public\.lb_evaluate_all\(false\);/);
  assert.match(CRON_CODE, /select public\.lb_rollover\(\);/);
  assert.ok(!/net\.http_post|CRON_SECRET|Authorization/i.test(CRON_CODE),
    'no HTTP call means no verify_jwt flag to get wrong and no secret to leak');
  assert.ok(!/pg_net/.test(CRON_CODE), 'and no reason to enable pg_net for this feature');
});

test('the rollover reasons in Chicago time, so there is no CDT/CST job pair', () => {
  const jobs = CRON.match(/cron\.schedule\(/g) || [];
  assert.equal(jobs.length, 2);
  assert.match(MIG_CODE, /v_today\s+date := COALESCE\(p_today, \(now\(\) AT TIME ZONE 'America\/Chicago'\)::date\)/);
});

test('the nightly sweep is NOT silent — a record broken overnight is announced', () => {
  assert.match(CRON, /lb_evaluate_all\(false\)/);
  assert.ok(!/lb_evaluate_all\(true\)/.test(CRON), 'the cron is the safety net, not a second backfill');
});
