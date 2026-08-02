// ============================================================
// contract-levels.test.mjs — run with:  npm run test:contractlevels
//
// PROMPT_OV1, Round 1 of 2. This round is backend only, so every test here is
// a STRUCTURE test: assertions about 20260810_contract_levels.sql and app.html
// as source text, in the pattern test/leaderboards.test.mjs established.
//
// There is no behaviour block to extract because this round ships no browser
// code. What it does ship is a cross-agent write path and a cross-agent read
// path, and the four things that keep those safe are all statable about the
// text: no parameter naming a leader, authorization anchored on auth.uid(),
// aggregates only in the RETURNS TABLE, and a sale predicate byte-identical to
// the one get_team_summary already uses.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP  = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIG  = readFileSync(join(ROOT, 'supabase/migrations/20260810_contract_levels.sql'), 'utf8');
// The two migrations that define get_team_summary. 20260751 is the most
// recent; 20260741 is the one test/leaderboards.test.mjs pins lb_agent_metrics
// against. Both are read so a drift between THEM is caught here too — the
// alternative is two "byte-identical" tests quietly anchored to two files.
const TEAM_LATEST = readFileSync(join(ROOT, 'supabase/migrations/20260751_display_names.sql'), 'utf8');
const TEAM_PRIOR  = readFileSync(join(ROOT, 'supabase/migrations/20260741_book_of_business.sql'), 'utf8');
const PROT = readFileSync(join(ROOT, 'supabase/migrations/20260703c_agents_column_protection.sql'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n')
  .filter(l => !markers.some(m => l.trim().startsWith(m)))
  .join('\n');
const MIG_CODE = stripLineComments(MIG, ['--']);
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);

/** The body of a `create or replace function public.<name>(` ... `$fn$;` block. */
function fnBody(src, name) {
  const i = src.toLowerCase().indexOf(`function public.${name}(`);
  assert.ok(i > 0, `migration must define ${name}`);
  const rest = src.slice(i);
  const end = rest.indexOf('\n$fn$;');
  assert.ok(end > 0, `${name} must be terminated with $fn$;`);
  return rest.slice(0, end);
}

/** The `returns table ( ... )` column list of a function, as [name, type] pairs. */
function returnsTable(src, name) {
  const body = fnBody(src, name);
  const m = body.match(/returns table \(([\s\S]*?)\)\s*\n\s*language/i);
  assert.ok(m, `${name} must declare a RETURNS TABLE`);
  return m[1].split(',')
    .map(s => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean)
    .map(s => s.split(/\s+/));
}

// ============================================================
// 1. THE CROSS-TENANT SHAPE — no parameter names a leader
// ============================================================

test('set_downline_contract_level TAKES NO PARAMETER NAMING A LEADER', () => {
  // A p_leader_id argument is how one agency writes another agency's book.
  // Every cross-agent function in this schema is anchored on auth.uid() and
  // has nothing to point somewhere else; get_team_summary,
  // apply_producer_codes and get_downline_commission_rollup all document it.
  const sig = MIG.slice(MIG.indexOf('function public.set_downline_contract_level('),
                        MIG.indexOf('returns numeric'));
  assert.ok(!/p_leader|leader_id\s+uuid|p_upline/i.test(sig),
    'a leader parameter would let a caller name somebody else\'s agency — the ' +
    'downline must come from auth.uid() alone. Signature was: ' + sig.trim());
  // p_agent_id names the SUBJECT, not the writer. That is the one uuid allowed.
  assert.match(sig, /p_agent_id uuid/);
  assert.equal((sig.match(/uuid/g) || []).length, 1, 'exactly one uuid parameter, and it is the subject');
});

test('get_downline_product_ap TAKES NO PARAMETER NAMING A LEADER OR AN AGENT', () => {
  const sig = MIG.slice(MIG.indexOf('function public.get_downline_product_ap('),
                        MIG.indexOf('returns table (\n  agent_id     uuid'));
  assert.ok(!/uuid/i.test(sig), 'both parameters must be date bounds. Signature was: ' + sig.trim());
  assert.match(sig, /p_start date/);
  assert.match(sig, /p_end   date/);
});

test('the authorization clause is leader_id = auth.uid() AND status = accepted', () => {
  const fn = fnBody(MIG, 'set_downline_contract_level');
  assert.match(fn, /ai\.leader_id\s*=\s*auth\.uid\(\)/,
    'the downline must be derived from the caller\'s own JWT');
  assert.match(fn, /ai\.invitee_id\s*=\s*p_agent_id/);
  assert.match(fn, /ai\.status\s*=\s*'accepted'/,
    'a pending or declined invite is not a downline relationship');
  assert.match(fn, /raise exception[\s\S]{0,120}not authorized/,
    'anything else must raise, not silently no-op');
  // And the same anchor on the read side.
  const ap = fnBody(MIG, 'get_downline_product_ap');
  assert.match(ap, /ai\.leader_id\s*=\s*auth\.uid\(\)/);
  assert.match(ap, /ai\.status\s*=\s*'accepted'/);
});

// ============================================================
// 2. AGGREGATES ONLY
// ============================================================

test('get_downline_product_ap DECLARES ONLY THE FOUR AGGREGATE COLUMNS', () => {
  const cols = returnsTable(MIG, 'get_downline_product_ap');
  assert.deepEqual(cols.map(c => c[0]), ['agent_id', 'product', 'policy_count', 'total_ap']);
  assert.deepEqual(cols.map(c => c[1]), ['uuid', 'text', 'bigint', 'numeric']);
  // Enforced by what the function DECLARES, not by what a UI renders — the
  // lesson docs/agency-team-screen.md records.
  const decl = cols.map(c => c.join(' ')).join(' ');
  [/client/i, /insured/i, /policy_number/i, /statement/i, /carrier_statement/i,
   /commission/i, /name/i, /email/i, /phone/i].forEach(re =>
    assert.ok(!re.test(decl), 'the rollup must not carry ' + re + ' — it is aggregates only'));
});

test('the function body selects no per-policy row and no identifying field', () => {
  const fn = fnBody(MIG, 'get_downline_product_ap');
  assert.match(fn, /group by p\.uid, p\.product_key/, 'the result must be grouped, never per policy');
  ["data->>'client'", "data->>'policyNumber'", "data->>'insured'", 'commission_rows',
   'statement_files', 'commission_statements'].forEach(s =>
    assert.ok(!fn.includes(s), 'get_downline_product_ap must not read ' + s));
});

// ============================================================
// 3. THE 8,610x GUARD — one definition of a sale
// ============================================================

test('THE SALE PREDICATE IS BYTE-IDENTICAL TO get_team_summary\'S', () => {
  // The boards, the team table and now the override estimator all report AP
  // for the same agents. Two definitions of "a sale" across those screens is
  // the 8,610x AP overstatement with a shorter fuse. If get_team_summary ever
  // changes its mind, this fails rather than the screens quietly disagreeing.
  const predicate = /COALESCE\(po\.data->>'status',''\) NOT IN \('lapsed','chargeback','denied','withdrawn'\)/;
  const latest = TEAM_LATEST.match(predicate);
  assert.ok(latest, 'get_team_summary\'s predicate moved in 20260751 — find it and update this test deliberately');
  assert.ok(TEAM_PRIOR.match(predicate), 'the two migrations defining get_team_summary have drifted from each other');
  assert.ok(MIG.includes(latest[0]),
    'get_downline_product_ap must use the IDENTICAL sale predicate, character for character');
  assert.equal((MIG.match(predicate) || []).length, 1, 'and exactly one copy of it');
});

test('THE AP GUARD AND THE SALE-DATE CHAIN ARE BYTE-IDENTICAL TOO', () => {
  const apGuard = /CASE WHEN COALESCE\(po\.data->>'ap',''\) ~ '\^-\?\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'\s*\n?\s*THEN \(po\.data->>'ap'\)::numeric ELSE 0 END/;
  const teamAp = TEAM_LATEST.match(apGuard);
  assert.ok(teamAp, 'get_team_summary\'s AP guard moved');
  const norm = s => s.replace(/\s+/g, ' ');
  assert.ok(norm(MIG).includes(norm(teamAp[0])),
    'a malformed AP must count as 0 here exactly as it does on the team table');

  const chain = "COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft',''))";
  assert.ok(TEAM_LATEST.includes(chain), 'get_team_summary\'s sale-date chain moved');
  assert.ok(MIG.includes(chain), 'the sale-date chain must be the same one');
});

test('the window is half-open and compared as DATEs, as get_team_summary compares it', () => {
  const fn = fnBody(MIG, 'get_downline_product_ap');
  assert.match(fn, /p_start is null or p\.sub_date >= p_start/);
  assert.match(fn, /p_end   is null or p\.sub_date <  p_end/);
  assert.ok(!/p\.sub_date <= p_end/.test(fn), 'an inclusive end double-counts a boundary day');
});

// ============================================================
// 4. `product` IS THE RAW TRIPLE, NOT A COMP KEY
// ============================================================

test('the product key is the VERBATIM carrier|product|cls triple, mapped nowhere', () => {
  // policies.data.product holds a display label ('Whole Life') for most of the
  // book and a legacy raw COMP key ('trans_express') for the rest — two key
  // spaces in one column — and only getActiveCommKey(carrier, product, cls)
  // can resolve either. This function must therefore map NOTHING and invent no
  // lookup table; Round 2 splits the key and calls the resolver that ships.
  const fn = fnBody(MIG, 'get_downline_product_ap');
  assert.match(fn, /COALESCE\(po\.data->>'carrier',''\) \|\| '\|' \|\|/);
  assert.match(fn, /COALESCE\(po\.data->>'product',''\) \|\| '\|' \|\|/);
  assert.match(fn, /COALESCE\(po\.data->>'cls',''\)\s+AS product_key/);
  ['americo_eagle', 'trans_express', 'aa_senior', 'Whole Life', 'CARRIER_PRODUCTS'].forEach(s =>
    assert.ok(!fn.includes(s), 'the SQL must not name a product or carrier — mapping is Round 2\'s job'));
});

test('the key shape is the one app.html already uses for a commission lookup', () => {
  // commPctOverrideKey(carrier, product, cls) === `${carrier}|${product}|${cls}`.
  // Round 2 splits on the same delimiter and feeds getActiveCommKey(), so the
  // two must keep agreeing about the order of the parts and the separator.
  const js = APP_CODE.slice(APP_CODE.indexOf('function commPctOverrideKey'),
                            APP_CODE.indexOf('function getCommPctOverrides'));
  assert.match(js, /return `\$\{carrier\}\|\$\{product\}\|\$\{cls\}`/,
    'commPctOverrideKey moved — the SQL key shape must move with it');
  assert.match(APP_CODE, /function getActiveCommKey\(carrier, product, cls\)/,
    'the resolver Round 2 depends on must still take all three parts');
});

// ============================================================
// 5. THE AUDIT TABLE
// ============================================================

test('contract_level_changes HAS RLS ON AND NO INSERT/UPDATE/DELETE POLICY', () => {
  assert.match(MIG_CODE, /alter table public\.contract_level_changes enable row level security/);
  const policies = MIG_CODE.match(/create policy[\s\S]*?;/gi) || [];
  assert.equal(policies.length, 1, 'one policy on this table, and it is SELECT');
  assert.match(policies[0], /for select/i);
  assert.ok(!/for (insert|update|delete|all)/i.test(MIG_CODE),
    'a policy wide enough to let a browser record "the agent raised their own level" is ' +
    'wide enough to let it record one that never happened');
  assert.match(MIG_CODE, /revoke insert, update, delete on public\.contract_level_changes from anon, authenticated/);
});

test('the SELECT policy admits SELF and ACCEPTED DOWNLINE OF THE CALLER, and nobody else', () => {
  const pol = MIG.slice(MIG.indexOf('create policy contract_level_changes_select'),
                        MIG.indexOf('revoke insert, update, delete'));
  assert.match(pol, /agent_id = auth\.uid\(\)/, 'an agent reads their own history');
  assert.match(pol, /ai\.leader_id\s*=\s*auth\.uid\(\)/, 'a leader reads their own downline only');
  assert.match(pol, /ai\.invitee_id = contract_level_changes\.agent_id/);
  assert.match(pol, /ai\.status\s*=\s*'accepted'/);
  assert.match(pol, /to authenticated/);
  assert.ok(!/to anon/.test(pol), 'nothing here is public');
  assert.ok(!/is_admin/.test(pol), 'this round adds no admin bypass');
});

test('the trigger is AFTER UPDATE, because seven BEFORE triggers sort ahead of it', () => {
  // Postgres fires BEFORE row triggers in ALPHABETICAL order, and
  // agents_log_contract_level sorts before every agents_protect_* guard. Those
  // guards work by silently reverting NEW.col := OLD.col, so a BEFORE logger
  // would record changes a later trigger then undid. AFTER reads the row that
  // actually landed.
  assert.match(MIG_CODE, /create trigger agents_log_contract_level\s*\n\s*after update of contract_level on public\.agents/);
  assert.ok(!/before update[\s\S]{0,80}agents_log_contract_level/i.test(MIG_CODE));
  // The guard it has to compose with is a DENYLIST that never names
  // contract_level, so a self-update passes through it and IS logged.
  assert.match(PROT, /BEFORE UPDATE ON public\.agents/);
  assert.ok(!/NEW\.contract_level\s*:=/.test(PROT),
    '20260703c must not have started reverting contract_level — if it has, this round\'s premise changed');
});

test('the trigger logs a real change only, and cannot abort the caller\'s save', () => {
  const fn = fnBody(MIG, 'agents_log_contract_level');
  assert.match(fn, /new\.contract_level is distinct from old\.contract_level/,
    '`<>` is null-blind: a level moving to or from NULL is still a change');
  assert.match(fn, /new\.contract_level is not null/,
    'new_level is NOT NULL, so a cleared level must not be offered to the insert — ' +
    'a constraint violation raised inside an AFTER trigger takes the whole save with it');
  assert.match(fn, /values \(new\.id, auth\.uid\(\), old\.contract_level, new\.contract_level\)/);
  assert.match(fn, /security definer/, 'the table has no INSERT policy, so the trigger must own the write');
});

test('changed_by is nullable and set-null on delete — an audit row outlives its author', () => {
  const tbl = MIG.slice(MIG.indexOf('create table if not exists public.contract_level_changes'),
                        MIG.indexOf('comment on table public.contract_level_changes'));
  assert.match(tbl, /changed_by uuid\s+references auth\.users\(id\) on delete set null/);
  assert.ok(!/changed_by uuid not null/.test(tbl),
    'auth.uid() is NULL for every trusted context; NOT NULL there means a failed insert or a lie');
  assert.match(tbl, /agent_id   uuid not null references auth\.users\(id\) on delete cascade/);
  assert.match(tbl, /new_level  numeric not null/);
  assert.match(MIG_CODE, /create index if not exists contract_level_changes_agent_idx\s*\n\s*on public\.contract_level_changes \(agent_id, changed_at desc\)/);
});

// ============================================================
// 6. THE VALIDATION RANGE MATCHES THE BROWSER'S CLAMP
// ============================================================

test('THE LEVEL BOUNDS ARE setContractValue()\'S OWN, EXTRACTED FROM BOTH SIDES', () => {
  // Two copies of a rule is this repo's recurring bug class (pcNormalizeCode,
  // the ai-meter parity test, the password rule). Extract both and compare so
  // they cannot drift: a server that accepts 150 while the input box clamps to
  // 145 stores a level the UI can never show.
  const js = APP_CODE.match(
    /Math\.max\((\d+),\s*Math\.min\((\d+),\s*Math\.round\(\(parseInt\(v\) \|\| \d+\) \/ (\d+)\) \* (\d+)\)\)/);
  assert.ok(js, 'setContractValue()\'s clamp moved — find it and update both sides deliberately');
  const [, lo, hi, step, step2] = js;
  assert.equal(step, step2, 'the browser rounds and multiplies by the same step');

  const sql = MIG.match(/v_min   constant numeric := (\d+);[\s\S]*?v_max   constant numeric := (\d+);[\s\S]*?v_step  constant numeric := (\d+);/);
  assert.ok(sql, 'set_downline_contract_level must declare its bounds as named constants a test can read');
  assert.equal(sql[1], lo,   `SQL minimum ${sql[1]} != app.html clamp ${lo}`);
  assert.equal(sql[2], hi,   `SQL maximum ${sql[2]} != app.html clamp ${hi}`);
  assert.equal(sql[3], step, `SQL step ${sql[3]} != app.html step ${step}`);
  // Sanity: the values this round actually shipped against.
  assert.deepEqual([lo, hi, step], ['70', '145', '5']);
});

test('out of range RAISES; inside the range it rounds exactly as the browser does', () => {
  const fn = fnBody(MIG, 'set_downline_contract_level');
  assert.match(fn, /p_level is null or p_level < v_min or p_level > v_max/);
  assert.match(fn, /raise exception 'contract level must be between/,
    'a leader who types 200 should be told, not silently handed the ceiling');
  assert.match(fn, /v_level := round\(p_level \/ v_step\) \* v_step/);
  assert.match(fn, /return v_level/, 'the caller must be able to render what was actually stored');
});

test('the leader\'s write goes through the function, and it logs nothing itself', () => {
  const fn = fnBody(MIG, 'set_downline_contract_level');
  assert.match(fn, /security definer/);
  assert.match(fn, /set search_path = public/);
  assert.match(fn, /update public\.agents\s*\n\s*set contract_level = v_level\s*\n\s*where id = p_agent_id/);
  assert.ok(!/insert into public\.contract_level_changes/.test(fn),
    'one rule, one place: the trigger logs both write paths or it logs neither');
  assert.match(MIG_CODE, /grant execute on function public\.set_downline_contract_level\(uuid, numeric\) to authenticated/);
  assert.match(MIG_CODE, /revoke all on function public\.set_downline_contract_level\(uuid, numeric\) from public/);
});

// ============================================================
// 7. THE ROSTER READ — a level for a downline row only
// ============================================================

test('get_agency_members gained exactly three columns, and the old five are unmoved', () => {
  const cols = returnsTable(MIG, 'get_agency_members');
  assert.deepEqual(cols.map(c => c[0]), [
    'agent_id', 'agent_name', 'agent_email', 'agent_plan', 'relationship',
    'contract_level', 'level_changed_by_self', 'level_changed_at',
  ]);
  // Both callers in app.html read by name, so appending is inert until Round 2.
  assert.equal((APP_CODE.match(/sb\.rpc\('get_agency_members'\)/g) || []).length, 2);
});

test('🔴 A CONTRACT LEVEL IS RETURNED FOR A DOWNLINE ROW ONLY', () => {
  // This function also returns UPLINES and SIBLINGS — it feeds the transfer
  // picker. An ungated column would show an agent their sibling's contract and
  // their leader's, which is not the decision that was made.
  const fn = fnBody(MIG, 'get_agency_members');
  assert.match(fn, /case when r\.rel = 'downline' then ag\.contract_level::numeric end\s+as contract_level/);
  assert.match(fn, /case when r\.rel = 'downline' then lc\.changed_at end\s+as level_changed_at/);
  assert.match(fn, /case when r\.rel = 'downline' and lc\.agent_id is not null/);
  assert.equal((fn.match(/r\.rel = 'downline'/g) || []).length, 3,
    'all three new columns must be gated, not just the level');
  assert.match(fn, /uid <> auth\.uid\(\)/, 'the caller\'s own row is not in this result at all');
});

test('THE CHANGER IS A BOOLEAN, NEVER A NAME OR AN EMAIL', () => {
  const fn = fnBody(MIG, 'get_agency_members');
  assert.match(fn, /\(lc\.changed_by is not distinct from r\.uid\)/,
    '"did the agent do this themselves" answers the owner\'s question without publishing who else did');
  assert.ok(!/changed_by\)\s+as|pp_display_name\(lc\.changed_by\)|lc\.changed_by\s+as/.test(fn),
    'the changer\'s identity must never leave this function');
  const cols = returnsTable(MIG, 'get_agency_members');
  assert.equal(cols.find(c => c[0] === 'level_changed_by_self')[1], 'boolean');
});

test('the roster still resolves names through pp_display_name, never an email', () => {
  const fn = fnBody(MIG, 'get_agency_members');
  assert.match(fn, /public\.pp_display_name\(r\.uid\)\s+as agent_name/,
    'no peer-visible surface may render an email address as a name');
  assert.ok(!/agent_name\s*\|\|\s*au\.email|coalesce\([^)]*au\.email\)\s*as agent_name/i.test(fn));
});

// ============================================================
// 8. THE MIGRATION IS ADDITIVE AND TRANSACTIONAL
// ============================================================

test('the file is one transaction — the DROP of get_agency_members has no window', () => {
  assert.match(MIG_CODE, /^\s*begin;/m);
  assert.match(MIG_CODE, /commit;\s*$/);
  // DROP + CREATE is required: RETURNS TABLE is widening and CREATE OR REPLACE
  // cannot change a return type. The grant is restated because DROP takes the
  // ACL with it.
  assert.match(MIG_CODE, /drop function if exists public\.get_agency_members\(\);/);
  assert.match(MIG_CODE, /grant execute on function public\.get_agency_members\(\) to authenticated, service_role;/);
});

test('additive — no DROP of a table, column or row, and nothing in auth.*', () => {
  assert.ok(!/DROP TABLE/i.test(MIG_CODE));
  assert.ok(!/DROP COLUMN/i.test(MIG_CODE));
  assert.ok(!/\bTRUNCATE\b/i.test(MIG_CODE));
  assert.ok(!/DELETE FROM/i.test(MIG_CODE));
  assert.ok(!/(insert|update|delete)\s+(into\s+)?auth\./i.test(MIG_CODE),
    'auth.users is referenced by foreign key and never written');
  // DROP POLICY / DROP TRIGGER immediately before CREATE is this repo's
  // idempotency idiom; DROP FUNCTION is the one widening above.
  const drops = (MIG_CODE.match(/DROP (?!POLICY|TRIGGER|FUNCTION)\w+/gi) || []);
  assert.deepEqual(drops, []);
});

test('this round adds no policy to any table it did not create', () => {
  // commission_rows, policies, agents and agency_invites all keep exactly the
  // permissions they had. The leader's write is a function, not a policy.
  ['commission_rows', 'policies', 'agents', 'agency_invites', 'statement_files',
   'commission_statements'].forEach(t =>
    assert.ok(!new RegExp(`create policy[^;]*on public\\.${t}\\b`, 'i').test(MIG_CODE),
      `${t} must not gain a policy this round`));
});

test('every new function is SECURITY DEFINER with a pinned search_path', () => {
  ['set_downline_contract_level', 'get_downline_product_ap', 'get_agency_members',
   'agents_log_contract_level'].forEach(fn => {
    const body = fnBody(MIG, fn);
    assert.match(body, /security definer/i, fn + ' must be SECURITY DEFINER');
    assert.match(body, /set search_path = public/i, fn + ' must pin search_path');
  });
});
