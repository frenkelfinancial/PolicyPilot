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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260739_back_office_ingestion.sql'), 'utf8');
const UPLOAD_FN = readFileSync(join(ROOT, 'supabase/functions/statement-upload/index.ts'), 'utf8');
const PARSE_FN = readFileSync(join(ROOT, 'supabase/functions/statement-parse/index.ts'), 'utf8');
const CORE_TS = readFileSync(join(ROOT, 'supabase/functions/_shared/statement-core.ts'), 'utf8');

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
