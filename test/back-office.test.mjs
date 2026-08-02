// ============================================================
// back-office.test.mjs — run with:  npm run test:backoffice
//
// Two kinds of test, same split as test/team-roster.test.mjs.
//
//   1. BEHAVIOUR. The pure block between the // <backoffice-core> sentinels
//      in app.html is extracted and executed verbatim. app.html has no build
//      step and no module system, so a mirrored copy in a .mjs file would be a
//      second definition that drifts from the one that ships.
//
//   2. STRUCTURE. Assertions about app.html and the migration as source text.
//      These are the regression tests for the bug CLASSES this build is
//      exposed to — the browser writing commission data directly, a nav
//      highlight going back to positional indexes, an RLS write policy
//      appearing on a commission table — not for any individual number.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260739_back_office_ingestion.sql'), 'utf8');
const UPLOAD_FN = readFileSync(join(ROOT, 'supabase/functions/statement-upload/index.ts'), 'utf8');
const PARSE_FN = readFileSync(join(ROOT, 'supabase/functions/statement-parse/index.ts'), 'utf8');
const CORE_TS = readFileSync(join(ROOT, 'supabase/functions/_shared/statement-core.ts'), 'utf8');
const DELETE_FN = readFileSync(join(ROOT, 'supabase/functions/statement-delete/index.ts'), 'utf8');
const REVIEW_FN = readFileSync(join(ROOT, 'supabase/functions/statement-review/index.ts'), 'utf8');

// Both files describe their own rules in comments; counting those as
// violations would make documenting a rule break it. Strip whole-line
// comments before counting call sites.
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
  'BO_MAX_FILE_BYTES', 'BO_MAX_BATCH_BYTES', 'BO_ALLOWED_EXT', 'BO_STATES',
  'boIsActiveStatus', 'boPipelineCounts', 'boAnyActive', 'boValidateFiles',
  'boFmtBytes', 'boFmtMoney', 'boSummaryLine', 'boGroupStatements',
  'boStatusMeta', 'boHexToBytes', 'boFilenameHeader',
  'boDeleteSummaryLine', 'boDeleteStatusNote', 'boReplaceResultLine',
];

function loadCore() {
  const m = APP.match(/\/\/ <backoffice-core>([\s\S]*?)\/\/ <\/backoffice-core>/);
  assert.ok(m, 'app.html must contain the // <backoffice-core> ... // </backoffice-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

const file = (name, size) => ({ name, size });

// ============================================================
// 1. BEHAVIOUR — the pure core
// ============================================================

test('the pipeline states are the six the schema allows, in pipeline order', () => {
  assert.deepEqual(B.BO_STATES.map(s => s.key),
    ['queued', 'parsing', 'persisting', 'matching', 'ingested', 'failed']);
  // The same six the check constraint enforces, so the UI can never render a
  // state the database would refuse to store.
  const constraint = /check \(status in \(([^)]*)\)\)/i.exec(SQL_CODE);
  assert.ok(constraint, 'the migration must constrain status');
  const allowed = constraint[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(allowed.slice().sort(), B.BO_STATES.map(s => s.key).sort());
});

test('only the four in-flight states count as active', () => {
  assert.equal(B.boIsActiveStatus('queued'), true);
  assert.equal(B.boIsActiveStatus('parsing'), true);
  assert.equal(B.boIsActiveStatus('persisting'), true);
  assert.equal(B.boIsActiveStatus('matching'), true);
  assert.equal(B.boIsActiveStatus('ingested'), false);
  assert.equal(B.boIsActiveStatus('failed'), false);
  assert.equal(B.boIsActiveStatus('nonsense'), false);
});

test('polling stops once nothing is moving', () => {
  assert.equal(B.boAnyActive([{ status: 'ingested' }, { status: 'failed' }]), false);
  assert.equal(B.boAnyActive([{ status: 'ingested' }, { status: 'parsing' }]), true);
  assert.equal(B.boAnyActive([]), false);
  assert.equal(B.boAnyActive(null), false);
});

test('pipeline counts are derived from the statements themselves', () => {
  const counts = B.boPipelineCounts([
    { status: 'queued' }, { status: 'queued' }, { status: 'parsing' },
    { status: 'ingested' }, { status: 'failed' }, { status: 'bogus' },
  ]);
  assert.equal(counts.queued, 2);
  assert.equal(counts.parsing, 1);
  assert.equal(counts.ingested, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.persisting, 0);
  assert.equal(counts.matching, 0);
  // An unrecognised status must not invent a counter key.
  assert.equal(counts.bogus, undefined);
});

test('every pipeline state renders, even at zero', () => {
  const counts = B.boPipelineCounts([]);
  B.BO_STATES.forEach(s => assert.equal(counts[s.key], 0, s.key + ' must be present at zero'));
});

// ---- file validation ----

test('validation accepts the five supported formats and nothing else', () => {
  const files = B.BO_ALLOWED_EXT.map(e => file('statement.' + e, 1000));
  const { accepted, rejected } = B.boValidateFiles(files);
  assert.equal(accepted.length, 5);
  assert.equal(rejected.length, 0);

  const bad = B.boValidateFiles([file('statement.docx', 1000), file('photo.png', 1000)]);
  assert.equal(bad.accepted.length, 0);
  assert.equal(bad.rejected.length, 2);
  bad.rejected.forEach(r => assert.match(r.reason, /PDF, Excel, CSV or ZIP/));
});

test('validation refuses an oversized file and names the real size', () => {
  const { accepted, rejected } = B.boValidateFiles([file('huge.pdf', B.BO_MAX_FILE_BYTES + 1)]);
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /10\.0 MB — the limit is 10\.0 MB per file/);
});

test('validation refuses an empty file', () => {
  const { rejected } = B.boValidateFiles([file('empty.csv', 0)]);
  assert.match(rejected[0].reason, /empty/);
});

test('validation caps the batch but keeps everything that still fits', () => {
  // Three 9 MB files are each under the 10 MB per-file cap, but the third
  // pushes the batch past 25 MB. The small fourth file still fits, and
  // dropping it just because an earlier file was too big would be wrong.
  const MB = 1024 * 1024;
  const { accepted, rejected } = B.boValidateFiles([
    file('a.csv', 9 * MB), file('b.csv', 9 * MB), file('big.csv', 9 * MB), file('tail.csv', 1024),
  ]);
  assert.deepEqual(accepted.map(f => f.name), ['a.csv', 'b.csv', 'tail.csv']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'big.csv');
  assert.match(rejected[0].reason, /two goes/);
});

test('a rejected file is always reported, never silently dropped', () => {
  const { accepted, rejected } = B.boValidateFiles([
    file('ok.csv', 100), file('bad.docx', 100), file('huge.pdf', B.BO_MAX_FILE_BYTES * 3),
  ]);
  assert.equal(accepted.length + rejected.length, 3);
  rejected.forEach(r => { assert.ok(r.name); assert.ok(r.reason && r.reason.length > 4); });
});

test('the browser caps mirror the server caps exactly', () => {
  const serverFile = /MAX_FILE_BYTES = (\d+) \* 1024 \* 1024/.exec(CORE_TS);
  const serverBatch = /MAX_BATCH_BYTES = (\d+) \* 1024 \* 1024/.exec(CORE_TS);
  assert.ok(serverFile && serverBatch, 'statement-core.ts must declare both caps');
  assert.equal(B.BO_MAX_FILE_BYTES, Number(serverFile[1]) * 1024 * 1024);
  assert.equal(B.BO_MAX_BATCH_BYTES, Number(serverBatch[1]) * 1024 * 1024);
});

// ---- formatters ----

test('money keeps the sign, because a negative line is real money going back', () => {
  assert.equal(B.boFmtMoney(123456), '$1,234.56');
  assert.equal(B.boFmtMoney(-7500), '-$75.00');
  assert.equal(B.boFmtMoney(0), '$0.00');
  assert.equal(B.boFmtMoney(null), '$0.00');
});

test('byte sizes read as a human would say them', () => {
  assert.equal(B.boFmtBytes(512), '512 B');
  assert.equal(B.boFmtBytes(2048), '2 KB');
  assert.equal(B.boFmtBytes(5 * 1024 * 1024), '5.0 MB');
});

test('the headline line reads as a sentence in the singular and the plural', () => {
  assert.equal(B.boSummaryLine({ ingested_7d: 1, rows_7d: 0, pending_review: 1 }),
    '1 statement ingested in the last 7 days · 1 line waiting for review');
  assert.match(B.boSummaryLine({ ingested_7d: 12, rows_7d: 3400, pending_review: 0 }),
    /^12 statements ingested in the last 7 days \(3,400 lines\) · 0 lines waiting for review$/);
  assert.match(B.boSummaryLine(null), /^0 statements/);
});

// ---- grouping ----

test('ZIP members nest under their archive rather than sitting beside it', () => {
  const groups = B.boGroupStatements([
    { id: 'zip', parent_statement_id: null, filename: 'july.zip' },
    { id: 'a', parent_statement_id: 'zip', filename: 'americo.csv' },
    { id: 'b', parent_statement_id: 'zip', filename: 'trans.xlsx' },
    { id: 'solo', parent_statement_id: null, filename: 'moo.pdf' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].statement.id, 'zip');
  assert.deepEqual(groups[0].members.map(m => m.id), ['a', 'b']);
  assert.equal(groups[1].statement.id, 'solo');
  assert.equal(groups[1].members.length, 0);
});

test('a member whose archive is off the page still renders, at the top level', () => {
  // The list is capped at 200 rows, so an old archive can fall off while a
  // member is still visible. Nesting it under nothing would hide it entirely.
  const groups = B.boGroupStatements([{ id: 'a', parent_statement_id: 'gone', filename: 'americo.csv' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].statement.id, 'a');
});

test('grouping preserves every statement exactly once', () => {
  const input = [
    { id: 'z1', parent_statement_id: null }, { id: 'm1', parent_statement_id: 'z1' },
    { id: 'm2', parent_statement_id: 'z1' }, { id: 's1', parent_statement_id: null },
  ];
  const groups = B.boGroupStatements(input);
  const seen = groups.flatMap(g => [g.statement.id, ...g.members.map(m => m.id)]);
  assert.equal(seen.length, input.length);
  assert.equal(new Set(seen).size, input.length);
});

// ---- status pill ----

test('only the in-flight states spin', () => {
  assert.equal(B.boStatusMeta('parsing').spin, true);
  assert.equal(B.boStatusMeta('matching').spin, true);
  assert.equal(B.boStatusMeta('queued').spin, false, 'queued is waiting, not working');
  assert.equal(B.boStatusMeta('ingested').spin, false);
  assert.equal(B.boStatusMeta('failed').spin, false);
});

test('an unknown status still renders something rather than blank', () => {
  const m = B.boStatusMeta('surprise');
  assert.equal(m.label, 'surprise');
  assert.ok(m.cls);
});

// ---- byte plumbing ----

test('the bytea hex decoder round-trips what Postgres returns', () => {
  assert.deepEqual([...B.boHexToBytes('\\x48656c6c6f')], [0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.deepEqual([...B.boHexToBytes('48656c6c6f')], [0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.equal(B.boHexToBytes('').length, 0);
});

test('a non-ASCII filename survives the header round trip', () => {
  const name = 'Résumé — Américo julho.csv';
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(B.boFilenameHeader(name)), c => c.charCodeAt(0)),
  );
  assert.equal(decoded, name);
});

// ============================================================
// 2. STRUCTURE — the invariants that keep the bug classes shut
// ============================================================

test('the browser never writes commission data directly', () => {
  // Every write goes through a service-role edge function. A single
  // .insert/.update/.upsert/.delete against one of these tables from app.html
  // would need an RLS write policy to work, and adding one is what would open
  // commission data to cross-tenant writes.
  const tables = ['commission_statements', 'commission_rows', 'statement_files', 'statement_extractions'];
  for (const t of tables) {
    const writes = APP_CODE.match(new RegExp(
      "from\\(['\"]" + t + "['\"]\\)[\\s\\S]{0,80}?\\.(insert|update|upsert|delete)\\(", 'g')) || [];
    assert.equal(writes.length, 0, `app.html must not write ${t} directly (found ${writes.length})`);
  }
});

test('the four commission tables are SELECT-only for authenticated', () => {
  const policies = SQL_CODE.match(/create policy[\s\S]*?;/g) || [];
  assert.ok(policies.length >= 4, 'expected a select policy per table');
  for (const p of policies) {
    assert.match(p, /for select/i, 'a commission table must not gain a write policy: ' + p.slice(0, 80));
  }
  assert.equal((SQL_CODE.match(/for (insert|update|delete)/gi) || []).length, 0);
});

test('🔴 NO WRITE POLICY ON ANY COMMISSION TABLE, IN ANY MIGRATION — the FIX3 regression test', () => {
  // FIX3 added a delete path. The obvious way to build one is a DELETE policy
  // on commission_statements, and CLAUDE.md is explicit about why that is
  // wrong. Widened to sweep EVERY migration, not just this feature's, because
  // the policy that opens this up will be added by whoever builds the next
  // Back Office screen and will not be in 20260739.
  const QUOTE =
    'CLAUDE.md: "a policy wide enough to let the browser record a commission row is broad enough to let it ' +
    'record one against another agent\'s book". The four commission tables are SELECT-only for `authenticated`; ' +
    'every write goes through an edge function or SECURITY DEFINER RPC that takes the agent FROM THE JWT.';
  const TABLES = ['commission_statements', 'statement_files', 'statement_extractions', 'commission_rows'];
  const dir = join(ROOT, 'supabase/migrations');
  for (const f of readdirSync(dir).filter(n => n.endsWith('.sql'))) {
    const sql = stripLineComments(readFileSync(join(dir, f), 'utf8'), ['--']);
    for (const stmt of sql.match(/create policy[\s\S]*?;/gi) || []) {
      const table = TABLES.find(t => new RegExp('on public\\.' + t + '\\b').test(stmt));
      if (!table) continue;
      assert.match(stmt, /for select/i, `${f} adds a non-SELECT policy to ${table}. ${QUOTE}`);
      assert.equal(/for (insert|update|delete)/i.test(stmt), false,
        `${f} adds a write policy to ${table}. ${QUOTE}`);
    }
  }
});

// ============================================================
// 3. FIX3 — removing a statement, and a re-read that replaces
// ============================================================

test('🔴 statement-delete takes the agent from the JWT and has NO parameter naming one', () => {
  // The same rule statement-review follows, for the same reason: a
  // body-supplied agent id is a way into somebody else's book.
  assert.equal(/body\.agent_id|agent_id:\s*body\.|body\.agent/.test(DELETE_FN), false,
    'nothing in the request body may name an agent');
  assert.match(DELETE_FN, /const \{ data: \{ user \} \} = await sb\.auth\.getUser\(token\)/);
  assert.match(DELETE_FN, /const agentId = user\.id;/);
  // The body carries exactly two things, and neither is an identity.
  const decl = /let body: \{([\s\S]*?)\} = \{\};/.exec(DELETE_FN);
  assert.ok(decl, 'statement-delete must declare its body shape');
  assert.deepEqual(
    decl[1].split(';').map(s => s.trim().split('?')[0].trim()).filter(Boolean).sort(),
    ['action', 'statement_id']);
});

test("🔴 statement-delete refuses a statement that is not the caller's own", () => {
  // Scoped by agent_id in the fetch itself, so somebody else's statement is
  // indistinguishable from one that does not exist — and the delete repeats
  // the scope rather than trusting the lookup above it.
  assert.match(DELETE_FN,
    /from\("commission_statements"\)\s*\n?\s*\.select\([\s\S]{0,200}?\.eq\("id", statementId\)\s*\n?\s*\.eq\("agent_id", agentId\)/);
  assert.match(DELETE_FN, /statement_not_found/);
  assert.match(DELETE_FN,
    /\.delete\(\)\s*\n?\s*\.eq\("id", st\.id\)\s*\n?\s*\.eq\("agent_id", agentId\)/,
    'the delete itself must be scoped to the caller, not just the lookup before it');
  // Every read it makes is scoped the same way.
  for (const t of ['commission_rows', 'policy_status_history']) {
    const q = new RegExp('from\\("' + t + '"\\)[\\s\\S]{0,400}?\\.eq\\("agent_id", agentId\\)');
    assert.match(DELETE_FN, q, `${t} must be read scoped to the caller`);
  }
});

test('deleting a parent statement removes its children and all their rows — by cascade', () => {
  // Verified against the live catalogue too (see the FIX3 report): four
  // foreign keys reference commission_statements and all four cascade. Here we
  // pin the declarations, and pin that the function RELIES on them rather than
  // deleting children by hand — which would open a window where the money is
  // gone and the statement is not.
  for (const ref of [
    /parent_statement_id uuid\s+references public\.commission_statements\(id\) on delete cascade/,
    /statement_id uuid\s+primary key references public\.commission_statements\(id\) on delete cascade/,
    /statement_id\s+uuid\s+not null references public\.commission_statements\(id\) on delete cascade/,
  ]) assert.match(SQL_CODE, ref, 'a dependent table without ON DELETE CASCADE orphans money rows');

  // Exactly one delete, and it names the parent.
  const deletes = DELETE_FN.match(/\.delete\(\)/g) || [];
  assert.equal(deletes.length, 1, 'one delete: the parent row, and the cascade does the rest');
  // The children are still counted, because they are invisible from the row
  // the agent clicked and the confirmation has to say what goes — and their
  // rows are counted into the net, or the money figure undercounts a ZIP.
  assert.match(DELETE_FN, /\.eq\("parent_statement_id", st\.id\)/);
  assert.match(DELETE_FN, /const allIds = \[st\.id, \.\.\.children\.map\(/);
  assert.match(DELETE_FN, /\.in\("statement_id", allIds\)/);
  assert.match(DELETE_FN, /children: children\.map\(/);
  assert.match(CORE_TS, /child_count: children\.length/);
});

test('🔴 DELETING A STATEMENT NEVER REWRITES THE BOOK — decision 1, pinned', () => {
  // It removes the statement. It does not revert a policy status and it does
  // not touch the history trail, which is append-only by design and stays true
  // after the paperwork proving it is removed.
  assert.equal(/from\("policies"\)[\s\S]{0,200}?\.(update|insert|upsert|delete)\(/.test(DELETE_FN), false,
    'statement-delete must never write public.policies');
  assert.equal(/from\("policy_status_history"\)[\s\S]{0,200}?\.(update|insert|upsert|delete)\(/.test(DELETE_FN), false,
    'statement-delete must never write policy_status_history — the trail cannot be rewritten');
  assert.equal(/from\("policy_events"\)[\s\S]{0,200}?\.(update|insert|upsert|delete)\(/.test(DELETE_FN), false);
  // policy_status_history is READ, and only read.
  assert.match(DELETE_FN, /from\("policy_status_history"\)\s*\n?\s*\.select\(/);
});

test('🔴 the delete result names the policies the statement moved, and the status each was set to', () => {
  // The compensation for not reverting: the agent is told exactly what to go
  // and check. Built by the same pure function the preview uses.
  assert.match(DELETE_FN, /summarizeStatementDeletion\(/);
  assert.match(DELETE_FN, /old_status/);
  assert.match(DELETE_FN, /new_status/);
  assert.match(DELETE_FN, /from_status:/);
  assert.match(DELETE_FN, /to_status:/);
  assert.match(DELETE_FN, /policy_number:/);
  assert.match(DELETE_FN, /insured_name:/);
  // …and the screen renders that list rather than a bare count.
  assert.match(APP_CODE, /function boMovedPoliciesHTML\(impact\)/);
  assert.match(APP_CODE, /boMovedPoliciesHTML\(i\)/);
});

test('🔴 preview and delete are THE SAME CALL WITH ONE FLAG', () => {
  // A preview computed by separate code is a preview that eventually lies, and
  // this modal's whole job is to promise what the button will do. Same rule
  // the voice-campaign manual door follows for preview_enroll / enroll_leads.
  // Comments stripped: the header describes this rule, and counting that as a
  // second call site would make documenting it break it.
  const code = stripLineComments(DELETE_FN, ['//', '*', '/*']);
  assert.equal((code.match(/summarizeStatementDeletion\(/g) || []).length, 1,
    'one planner, used by both actions');
  const planner = DELETE_FN.indexOf('const impact = summarizeStatementDeletion(');
  const split = DELETE_FN.indexOf('if (action === "preview")');
  assert.ok(planner > 0 && split > planner, 'the preview/delete split must come AFTER the plan is built');
});

test('statement-delete follows the statement-review pattern, not a second one', () => {
  // One pattern for the write path onto commission data: an edge function,
  // service-role client, agent from the JWT, CORS by origin, OPTIONS handled.
  for (const fn of [DELETE_FN, REVIEW_FN]) {
    assert.match(fn, /import \{ corsHeaders \} from "\.\.\/_shared\/cors\.ts"/);
    assert.match(fn, /const cors = corsHeaders\(req\.headers\.get\("origin"\)\)/);
    assert.match(fn, /if \(req\.method === "OPTIONS"\) return new Response\("ok", \{ headers: cors \}\)/);
    assert.match(fn, /Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  }
  // It sends no custom REQUEST header, so it needs nothing added to
  // ALLOW_HEADERS — the omission that made browser upload dead on arrival.
  const call = APP_CODE.slice(APP_CODE.indexOf("functions/v1/statement-delete"));
  const headers = /headers: \{([\s\S]*?)\}/.exec(call);
  assert.ok(headers, 'the call site must declare its headers');
  assert.equal(/x-/i.test(headers[1]), false,
    'a custom header here needs adding to ALLOW_HEADERS in _shared/cors.ts, or the browser blocks the request silently');
});

test('statement-delete is absent from config.toml, so it keeps verify_jwt = true', () => {
  const cfg = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');
  assert.equal(/\[functions\.statement-delete\]/.test(cfg), false);
});

test('exactly one statement-delete call site, and the browser still writes nothing directly', () => {
  assert.equal((APP_CODE.match(/functions\/v1\/statement-delete/g) || []).length, 1,
    'two ways to delete a statement is two places for the confirmation to drift');
  assert.match(APP_CODE, /async function boDeleteCall\(action, statementId\)/);
});

// ---- re-read replaces ----

test('🔴 RE-READ REPLACES: the rows are deleted before the new ones are inserted', () => {
  // Without this, a re-read after ANY parser fix that moves a date, an amount
  // or an ordinal lands a full second set of rows beside the first: the
  // owner's 9-line $262.45 statement becomes 18 lines and $524.90.
  assert.match(PARSE_FN, /const replaceMode = !!\(body\.replace && body\.statement_id\);/,
    'replace must require a NAMED statement — a sweep must not rewrite everybody\'s book');
  const del = PARSE_FN.indexOf('replace_delete_failed');
  const ins = PARSE_FN.indexOf('row_insert_failed');
  assert.ok(del > 0, 'the replace path must delete the statement\'s existing rows');
  assert.ok(del < ins, 'the delete must come before the insert, or the dedupe key blocks the new rows');
  assert.match(PARSE_FN,
    /from\("commission_rows"\)\.delete\(\)\s*\n?\s*\.eq\("statement_id", st\.id\)\.eq\("agent_id", st\.agent_id\)/,
    'the delete must be scoped to this statement AND this agent');
});

test('🔴 A FAILED RE-PARSE LEAVES THE ORIGINAL ROWS — never zero', () => {
  // Two guards, because there are two failure points.
  //
  // (1) The parse — the slow step, the network call, the one that realistically
  //     fails — finishes BEFORE anything is deleted. Everything up to and
  //     including `payload` is built first.
  const snap = PARSE_FN.indexOf('let priorRows');
  const payload = PARSE_FN.indexOf('const payload = rows.map(');
  const del = PARSE_FN.indexOf('replace_delete_failed');
  assert.ok(snap > 0 && payload > snap, 'the snapshot is taken before the parse');
  assert.ok(del > payload, 'nothing may be deleted until the new rows exist in memory');

  // (2) …and if the insert fails anyway, the snapshot goes back — ids and all.
  const restore = PARSE_FN.slice(PARSE_FN.indexOf('} catch (insErr) {'));
  assert.match(restore, /if \(replaceMode && priorRows\)/);
  assert.match(restore, /from\("commission_rows"\)\.delete\(\)/,
    'a half-written new set must be cleared, or the restore collides on the dedupe key');
  assert.match(restore, /from\("commission_rows"\)\.insert\(priorRows\)/);
  assert.match(restore, /throw insErr/, 'the failure must still be reported, not swallowed');
});

test('the hand-work carry-over lives in the tested core, not in the edge function', () => {
  assert.match(PARSE_FN, /carryStatementHandWork\(/);
  assert.match(CORE_TS, /export function carryStatementHandWork\(/);
  // The positional rule is the whole reason it is a function rather than a loop
  // in the worker: the owner's own ledger repeats two lines verbatim.
  assert.match(CORE_TS, /q\.shift\(\)/);
  // And it must not have been reimplemented beside it.
  assert.equal((PARSE_FN.match(/handWorkCarryKey|rowCarriesHandWork/g) || []).length, 0,
    'the worker consumes the core, it does not re-derive the rule');
});

test('the replace reports what it did to the agent\'s own work', () => {
  for (const k of ['lines_before', 'lines_after', 'hand_work_carried', 'hand_work_lost']) {
    assert.match(PARSE_FN, new RegExp(k + ':'), `the result must report ${k}`);
  }
  assert.match(APP_CODE, /boReplaceResultLine\(r\)/);
});

test('🔴 THE DEDUPE KEY AND ITS OCCURRENCE ORDINAL ARE UNCHANGED', () => {
  // This round moves rows around; it does not re-fingerprint them. Removing
  // the ordinal silently deletes real commission lines — the owner's ledger
  // repeats two lines verbatim and both are real money.
  const fn = /export function buildDedupeKeys\(([\s\S]*?)\n\}/.exec(CORE_TS);
  assert.ok(fn, 'buildDedupeKeys must still exist');
  assert.match(fn[1], /\(r\.carrier \|\| ""\)\.toLowerCase\(\)\.trim\(\)/);
  assert.match(fn[1], /normalizePolicyNumber\(r\.policyNumber\)/);
  assert.match(fn[1], /normalizeName\(r\.insuredName\)/);
  assert.match(fn[1], /r\.transactionDate \|\| r\.paidDate \|\| r\.effectiveDate \|\| ""/);
  assert.match(fn[1], /String\(r\.amountCents\)/);
  assert.match(fn[1], /r\.transactionType/);
  assert.match(fn[1], /hash\(n === 1 \? parts : `\$\{parts\}#\$\{n\}`\)/,
    'the occurrence ordinal is what keeps a carrier\'s two identical lines from collapsing into one');
  // The upsert it protects is unchanged too.
  assert.match(PARSE_FN, /onConflict: "agent_id,dedupe_key", ignoreDuplicates: true/);
});

// ---- the confirmation copy ----

test('the delete confirmation counts the lines, the money and the ZIP members', () => {
  assert.equal(
    B.boDeleteSummaryLine({ line_count: 9, net_amount_cents: 26245, child_count: 0 }),
    '9 commission lines totalling $262.45.');
  assert.equal(
    B.boDeleteSummaryLine({ line_count: 1, net_amount_cents: -4133, child_count: 1 }),
    '1 commission line totalling -$41.33, plus 1 statement that came out of this archive.');
  assert.match(
    B.boDeleteSummaryLine({ line_count: 0, net_amount_cents: 0, child_count: 3 }),
    /^0 commission lines totalling \$0\.00, plus 3 statements/);
});

test('🔴 the confirmation says the policies KEEP the status the statement set', () => {
  const note = B.boDeleteStatusNote({ moved_policies: [{ to_status: 'chargeback' }, { to_status: 'paid' }] });
  assert.match(note, /2 policies were moved/);
  assert.match(note, /KEEP the status it set/,
    'decision 1 is the thing this sentence exists to say — a delete does not rewind the book');
  assert.match(note, /worth checking/);
  assert.match(B.boDeleteStatusNote({ moved_policies: [{ to_status: 'paid' }] }), /^One policy was/);
  // Quiet when there is nothing to say.
  assert.equal(B.boDeleteStatusNote({ moved_policies: [] }), '');
  assert.equal(B.boDeleteStatusNote(null), '');
});

test('the replace result is reported in lines, and lost hand work is never absorbed', () => {
  assert.equal(
    B.boReplaceResultLine({ lines_before: 9, lines_after: 9, hand_work_carried: 2, hand_work_lost: 0 }),
    '9 lines replaced by 9. 2 approvals or manual matches carried over.');
  assert.equal(
    B.boReplaceResultLine({ lines_before: 9, lines_after: 9, hand_work_carried: 2, hand_work_lost: 1 }),
    '9 lines replaced by 9. 2 approvals or manual matches carried over, 1 could not be.');
  // Nothing to say about hand work when there was none.
  assert.equal(
    B.boReplaceResultLine({ lines_before: 1, lines_after: 3, hand_work_carried: 0, hand_work_lost: 0 }),
    '1 line replaced by 3.');
});

test('🔴 THE SCREEN SAYS RE-READ REPLACES, BEFORE THE CLICK', () => {
  // Not in a toast afterwards. The button label, the row-level tooltip, the
  // table footer and the confirmation all have to carry it.
  assert.match(APP, /Re-read \(replaces lines\)/, 'the button label must say what it does');
  assert.match(APP, /replaces this statement[\s\S]{0,40}lines/i);
  assert.match(APP, /<b>Re-read<\/b> reads the original file again and <b>replaces<\/b>/);
  assert.match(APP_CODE, /function boReReadConfirm\(statementId\)/);
  // And a re-read is never fired without passing through it.
  assert.match(APP_CODE, /boParseNow\(id, btn, true\)/);
  assert.equal(/onclick="boParseNow\([^)]*true\)/.test(APP), false,
    'nothing may call the replace path straight from a click — it goes through the confirmation');
});

test('neither irreversible action uses confirm()', () => {
  // A one-line browser dialog cannot show which policies a statement moved,
  // and that list is the point of the confirmation.
  const block = APP_CODE.slice(APP_CODE.indexOf('async function boConfirmDelete'),
                               APP_CODE.indexOf('async function boDoReRead'));
  assert.equal(/\bconfirm\(/.test(block), false, 'the delete/re-read flow must not fall back to confirm()');
  // The deliberate act is typing the filename.
  assert.match(APP_CODE, /function boDeleteTypedChanged\(\)/);
  assert.match(APP_CODE, /go\.disabled = input\.value\.trim\(\)\.toLowerCase\(\) !== want/);
  assert.match(APP, /id="bo-del-go" disabled/, 'the destructive button starts disabled');
});

test('every commission table has RLS enabled', () => {
  for (const t of ['commission_statements', 'statement_files', 'statement_extractions', 'commission_rows']) {
    assert.match(SQL_CODE, new RegExp('alter table public\\.' + t + ' enable row level security'), t);
  }
});

test('the migration is additive — no DROP of a table, column or data', () => {
  assert.equal(/drop\s+table/i.test(SQL_CODE), false);
  assert.equal(/drop\s+column/i.test(SQL_CODE), false);
  assert.equal(/\btruncate\b/i.test(SQL_CODE), false);
  assert.equal(/^\s*delete\s+from/im.test(SQL_CODE), false);
  // `drop policy if exists` / `drop trigger if exists` immediately before a
  // create are the repo's idempotency idiom, not a data change.
  const drops = SQL_CODE.match(/drop\s+\w+/gi) || [];
  drops.forEach(d => assert.match(d, /drop\s+(policy|trigger)/i, 'unexpected drop: ' + d));
});

test('the migration touches nothing in auth.* or storage.*', () => {
  // References TO auth.users(id) are foreign keys, which is how every table in
  // this schema keys a tenant. Writing INTO the auth schema is the banned thing.
  assert.equal(/(create|alter|drop)\s+\w*\s*(table|policy|function|trigger)?\s*(auth|storage)\./i.test(SQL_CODE), false);
  assert.equal(/\bstorage\./i.test(SQL_CODE), false);
});

test('idempotency is enforced at both grains', () => {
  assert.match(SQL_CODE, /create unique index if not exists commission_statements_agent_sha_uidx[\s\S]*?\(agent_id, sha256\)/);
  assert.match(SQL_CODE, /create unique index if not exists commission_rows_dedupe_uidx[\s\S]*?\(agent_id, dedupe_key\)/);
});

test('an unmatched row is stored for review, never dropped', () => {
  assert.match(PARSE_FN, /review_status: m\.policyId \? "auto" : "needs_review"/);
  assert.match(PARSE_FN, /review_reason: m\.policyId \? null : /);
  assert.match(SQL_CODE, /review_status\s+text\s+not null default 'auto'/);
});

test('the raw model output is stored before normalization', () => {
  // statement_extractions must be written in both parse paths.
  const inserts = PARSE_FN.match(/from\("statement_extractions"\)\.insert\(/g) || [];
  assert.equal(inserts.length, 2, 'both the PDF and the tabular path must record their extraction');
});

test('the uploading agent comes from the JWT, never from the request BODY', () => {
  // Unchanged and non-negotiable: nothing in the request body can name an
  // agent. That was the whole point of the original assertion and it still is.
  assert.equal(/body\.agent_id|agent_id:\s*body\./.test(UPLOAD_FN), false);
  assert.equal(/body\.agent_id/.test(PARSE_FN), false);
  // The default path still resolves the agent from the token.
  assert.match(UPLOAD_FN, /const \{ data: \{ user \} \} = await sb\.auth\.getUser\(token\)/);
  assert.match(UPLOAD_FN, /agentId = user\.id/);
});

test('x-agent-id is honoured ONLY for a service-role caller, and only if real', () => {
  // Phase 1b added exactly one exception: a statement forwarded to
  // <token>@commissions.… arrives at a webhook with no user session, so it
  // calls statement-upload with the SERVICE ROLE key and names the agent in a
  // header. Three things have to hold, or that header is a way into someone
  // else's book — which is the single worst outcome available in this schema.
  const gate = /const isService = token === SERVICE_KEY;/;
  assert.match(UPLOAD_FN, gate, 'the exception must be gated on the service-role key itself');

  // (1) the header is only read behind the service-role gate…
  assert.match(UPLOAD_FN, /if \(isService && headerAgent\)/);
  // (2) …its shape is validated…
  assert.match(UPLOAD_FN, /bad_agent_id/);
  // (3) …and the agent is confirmed to EXIST rather than merely well-formed.
  assert.match(UPLOAD_FN, /from\("agents"\)\.select\("id"\)\.eq\("id", headerAgent\)/);
  assert.match(UPLOAD_FN, /unknown_agent/);

  // A non-service caller sending the header must fall through to the JWT
  // path — the `else` branch — not be trusted and not be rejected.
  const block = UPLOAD_FN.slice(UPLOAD_FN.indexOf('const isService'),
                                UPLOAD_FN.indexOf('const filename'));
  assert.match(block, /\}\s*else\s*\{[\s\S]*getUser\(token\)/,
    'a browser sending x-agent-id must simply upload to its own book');
});

test('an emailed statement is recorded as source=email, and only from the service role', () => {
  assert.match(UPLOAD_FN, /const sourceLabel = \(isService && req\.headers\.get\("x-source"\) === "email"\)/);
  // The browser can never mark an upload as having arrived by email.
  assert.ok(!/source: "email"/.test(UPLOAD_FN),
    'the email source must come from the guarded sourceLabel, never a literal');
});

test('a statement row is never left without its bytes', () => {
  // The bytes are the evidence; a hollow statement row is worse than none.
  assert.match(UPLOAD_FN, /bytes_not_stored/);
  assert.match(UPLOAD_FN, /from\("commission_statements"\)\.delete\(\)\.eq\("id", ins\.data\.id\)/);
});

test('neither new function is in config.toml, so both keep verify_jwt = true', () => {
  const cfg = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');
  assert.equal(/\[functions\.statement-upload\]/.test(cfg), false);
  assert.equal(/\[functions\.statement-parse\]/.test(cfg), false);
});

test('the nav highlight is by section name, not by position', () => {
  // The positional idxMap was the last instance of the drift that
  // _applyPlanGating() already had to fix once; adding Back Office would have
  // silently shifted every index after Bonus Tracker.
  assert.equal(/const idxMap = \{/.test(APP_CODE), false, 'the positional idxMap must not come back');
  // …and by ALL matches, not just the first. The Front/Back Office split
  // renders Agency TWICE (#nav-agency-front, #nav-agency-back), so this became
  // querySelectorAll — a singular query would highlight the Front Office copy
  // when the agent clicked the Back Office one. The rule ("by name, never by
  // position") is unchanged; only the arity moved.
  // test/office-split.test.mjs holds the same line for all three call sites.
  assert.match(APP_CODE, /document\.querySelectorAll\('\.nav-item\[onclick\*="nav\(/);
});

test('Back Office is reachable: nav item, title and section all exist and agree', () => {
  assert.match(APP, /onclick="nav\('backoffice'\)"/);
  // The TAB is labelled "Statements" since the whole right-hand app became the
  // Back Office. The KEY is still `backoffice` and that is the half this file
  // cares about — sec-backoffice, renderBackOffice(), boArea() and the
  // bopanel-* prefixes all key off it.
  assert.match(APP, /backoffice:'Statements'/);
  assert.match(APP, /id="sec-backoffice"/);
  assert.match(APP_CODE, /if \(id === 'backoffice'\) renderBackOffice\(\);/);
});

test('exactly one upload call site and one parse call site', () => {
  // Two ways to upload is two places for the cap, the auth header and the
  // duplicate reporting to drift apart.
  assert.equal((APP_CODE.match(/functions\/v1\/statement-upload/g) || []).length, 1);
  assert.equal((APP_CODE.match(/functions\/v1\/statement-parse/g) || []).length, 1);
});

test('the core block is pure — no DOM, network, storage or app globals', () => {
  const m = APP.match(/\/\/ <backoffice-core>([\s\S]*?)\/\/ <\/backoffice-core>/);
  const code = stripLineComments(m[1], ['//', '*', '/*']);
  for (const forbidden of ['document.', 'window.', 'localStorage', 'fetch(', 'sb.', 'currentAgent', 'showToast']) {
    assert.equal(code.includes(forbidden), false, `the core must not reference ${forbidden}`);
  }
});
