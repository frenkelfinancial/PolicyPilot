// ============================================================
// reconciliation.test.mjs — run with:  npm run test:recon
//
// Back Office Phase 6. The pure // <recon-core> block is extracted from
// app.html and executed verbatim, together with // <comm-core> (recon-core
// declares one dependency on its commMoney), then structural assertions.
//
// The bug classes here: a write path that could reach another agent's book, a
// "reject" that deletes a commission line, a queue that hides money, and a
// match-% sort that treats "never matched" as "matched badly".
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260744_reconciliation.sql'), 'utf8');
const FN = readFileSync(join(ROOT, 'supabase/functions/statement-review/index.ts'), 'utf8');
const CONFIG = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);
const SQL_CODE = stripLineComments(MIGRATION, ['--']);
const FN_CODE = stripLineComments(FN, ['//', '*', '/*']);

const EXPORTS = [
  'RECON_QUEUES', 'RECON_STATUSES', 'RECON_PRIORITIES',
  'reconRowPriority', 'reconUnlinkedPriority', 'reconStuckPriority', 'reconSort',
  'reconMatchItems', 'reconUnlinkedItems', 'reconStuckItems', 'reconPriorityCounts',
  'reconConfidencePct', 'reconHeadline', 'reconResultMessage',
];
function loadCore() {
  const comm = APP.match(/\/\/ <comm-core>([\s\S]*?)\/\/ <\/comm-core>/);
  const recon = APP.match(/\/\/ <recon-core>([\s\S]*?)\/\/ <\/recon-core>/);
  assert.ok(comm && recon, 'app.html must contain both the comm-core and recon-core blocks');
  // eslint-disable-next-line no-new-func
  return new Function(`${comm[1]}\n${recon[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const R = loadCore();

const NOW = new Date('2026-07-29T12:00:00Z');
const row = (o = {}) => ({
  id: o.id || 'r1', statement_id: 's1', amount_cents: 10000, transaction_type: 'advance',
  match_confidence: null, matched_policy_id: null, review_status: 'needs_review',
  review_reason: 'no matching policy', ...o,
});

// ============================================================
// 1. BEHAVIOUR
// ============================================================

test('the three queues are the ones the brief names', () => {
  assert.deepEqual(R.RECON_QUEUES.map(q => q.key), ['match', 'unlinked', 'stuck']);
  assert.deepEqual(R.RECON_QUEUES.map(q => q.label),
    ['Policy Match Review', 'Unlinked Policies', 'Stuck Uploads']);
});

test('priority follows the money, not the age', () => {
  assert.equal(R.reconRowPriority({ amount_cents: 120000 }), 'high');
  assert.equal(R.reconRowPriority({ amount_cents: 50000 }), 'high');
  assert.equal(R.reconRowPriority({ amount_cents: 20000 }), 'med');
  assert.equal(R.reconRowPriority({ amount_cents: 900 }), 'low');
});

test('a CHARGEBACK is never low priority, however small', () => {
  // It is money already taken back, and the one an agent gets asked about.
  assert.equal(R.reconRowPriority({ amount_cents: -500, transaction_type: 'chargeback' }), 'med');
  assert.equal(R.reconRowPriority({ amount_cents: -20000, transaction_type: 'chargeback' }), 'high');
  assert.equal(R.reconRowPriority({ amount_cents: -500, transaction_type: 'advance' }), 'low');
});

test('a negative amount is ranked by its magnitude', () => {
  assert.equal(R.reconRowPriority({ amount_cents: -120000, transaction_type: 'adjustment' }), 'high');
});

test('an unpaid policy is ranked by premium AND by how long it has waited', () => {
  assert.equal(R.reconUnlinkedPriority({ ap: 2400 }, 90), 'high');
  assert.equal(R.reconUnlinkedPriority({ ap: 2400 }, 10), 'med', 'big but early is not urgent');
  assert.equal(R.reconUnlinkedPriority({ ap: 300 }, 120), 'med', 'small but very late still matters');
  assert.equal(R.reconUnlinkedPriority({ ap: 300 }, 50), 'low');
});

test('a FAILED upload is always high — nothing was ingested at all', () => {
  assert.equal(R.reconStuckPriority({ status: 'failed' }), 'high');
  assert.equal(R.reconStuckPriority({ status: 'parsing' }), 'med');
});

test('commission rows become queue items with their reason intact', () => {
  const items = R.reconMatchItems([row({ review_reason: '2 policies share that insured name' })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'match');
  assert.equal(items[0].reason, '2 policies share that insured name');
  assert.equal(items[0].matched, false);
  assert.equal(items[0].confidence, null);
});

test('a match confidence of 0 is preserved, not turned into "no match"', () => {
  // 0 and null mean different things: a bad match and no match.
  const items = R.reconMatchItems([row({ match_confidence: 0, matched_policy_id: 'p1' })]);
  assert.equal(items[0].confidence, 0);
  assert.equal(items[0].matched, true);
  assert.equal(R.reconConfidencePct(0), 0);
  assert.equal(R.reconConfidencePct(null), null);
  assert.equal(R.reconConfidencePct(0.9), 90);
});

test('sorting by match % puts NEVER-MATCHED rows last, not first', () => {
  const items = R.reconMatchItems([
    row({ id: 'none', match_confidence: null }),
    row({ id: 'low', match_confidence: 0.4, matched_policy_id: 'p' }),
    row({ id: 'high', match_confidence: 0.95, matched_policy_id: 'p' }),
  ]);
  const sorted = R.reconSort(items, 'confidence', 'asc');
  assert.deepEqual(sorted.map(i => i.id), ['low', 'high', 'none'],
    'a row that never matched is not a zero-confidence match');
});

test('the default sort is priority, high first', () => {
  const items = R.reconMatchItems([
    row({ id: 'low', amount_cents: 100 }),
    row({ id: 'high', amount_cents: 200000 }),
    row({ id: 'med', amount_cents: 20000 }),
  ]);
  assert.deepEqual(R.reconSort(items, 'priority', 'desc').map(i => i.id), ['high', 'med', 'low']);
});

test('sorting by amount ranks by magnitude within a priority', () => {
  const items = R.reconMatchItems([
    row({ id: 'a', amount_cents: 60000 }),
    row({ id: 'b', amount_cents: -90000 }),
  ]);
  assert.deepEqual(R.reconSort(items, 'amount', 'desc').map(i => i.id), ['b', 'a']);
});

test('sorting survives an empty or absent list', () => {
  assert.deepEqual(R.reconSort([], 'priority', 'desc'), []);
  assert.deepEqual(R.reconSort(null, 'confidence', 'asc'), []);
});

test('an unpaid policy only appears once it is genuinely overdue', () => {
  const draft = d => { const x = new Date(NOW); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); };
  const p = (id, days, extra = {}) => ({ id, client: 'C' + id, status: 'paid', ap: 1200, draft: draft(days), ...extra });
  const items = R.reconUnlinkedItems(
    [p(1, 90), p(2, 10)], new Set(), new Map(), NOW, 45);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '1');
  assert.equal(items[0].daysWaiting, 90);
});

test('a policy a commission line already points at is NOT unpaid', () => {
  const draft = new Date(NOW); draft.setDate(draft.getDate() - 90);
  const p = { id: 7, client: 'C', status: 'paid', ap: 1200, draft: draft.toISOString().slice(0, 10) };
  const uuid = new Map([['7', 'uuid-7']]);
  assert.equal(R.reconUnlinkedItems([p], new Set(['uuid-7']), uuid, NOW, 45).length, 0);
  assert.equal(R.reconUnlinkedItems([p], new Set(['uuid-other']), uuid, NOW, 45).length, 1);
});

test('a LAPSED policy is not a reconciliation problem', () => {
  const draft = new Date(NOW); draft.setDate(draft.getDate() - 200);
  const iso = draft.toISOString().slice(0, 10);
  const mk = status => ({ id: 1, client: 'C', status, ap: 1200, draft: iso });
  ['lapsed', 'chargeback', 'denied', 'withdrawn', 'surrendered', 'pending', 'approved']
    .forEach(s => assert.equal(R.reconUnlinkedItems([mk(s)], new Set(), new Map(), NOW, 45).length, 0,
      `${s} must not appear in Unlinked Policies`));
  ['issued', 'paid'].forEach(s =>
    assert.equal(R.reconUnlinkedItems([mk(s)], new Set(), new Map(), NOW, 45).length, 1));
});

test('a policy with no draft date cannot be judged overdue', () => {
  assert.equal(R.reconUnlinkedItems([{ id: 1, status: 'paid', ap: 1200 }], new Set(), new Map(), NOW, 45).length, 0);
  assert.equal(R.reconUnlinkedItems([{ id: 1, status: 'paid', ap: 1200, draft: 'soon' }],
    new Set(), new Map(), NOW, 45).length, 0);
});

test('a failed statement is stuck, and so is one in flight for too long', () => {
  const ago = m => new Date(NOW.getTime() - m * 60000).toISOString();
  const items = R.reconStuckItems([
    { id: 'a', filename: 'f.csv', status: 'failed', error: 'boom', created_at: ago(5) },
    { id: 'b', filename: 'g.csv', status: 'parsing', created_at: ago(120) },
    { id: 'c', filename: 'h.csv', status: 'parsing', created_at: ago(5) },
    { id: 'd', filename: 'i.csv', status: 'ingested', created_at: ago(500) },
  ], NOW, 60);
  assert.deepEqual(items.map(i => i.id).sort(), ['a', 'b']);
  assert.equal(items.find(i => i.id === 'a').priority, 'high');
  assert.equal(items.find(i => i.id === 'a').error, 'boom');
});

test('priority counts add up to the list', () => {
  const items = [{ priority: 'high' }, { priority: 'high' }, { priority: 'low' }, { priority: 'nonsense' }];
  const c = R.reconPriorityCounts(items);
  assert.deepEqual(c, { high: 2, med: 0, low: 1 });
  assert.deepEqual(R.reconPriorityCounts(null), { high: 0, med: 0, low: 0 });
});

test('the headline LEADS WITH MONEY, because that is what opens the screen', () => {
  const h = R.reconHeadline({ match_review: 6, review_amount_cents: 431200, unlinked_policies: 2, stuck_uploads: 1 });
  assert.match(h, /^\$4,312\.00 across 6 lines to review/);
  assert.match(h, /2 policies never paid/);
  assert.match(h, /1 upload stuck/);
});

test('the headline is singular where it should be, and positive when clear', () => {
  assert.match(R.reconHeadline({ match_review: 1, review_amount_cents: 100, unlinked_policies: 1, stuck_uploads: 1 }),
    /1 line to review · 1 policy never paid · 1 upload stuck/);
  assert.equal(R.reconHeadline({}), 'Nothing needs your attention. Every ingested line is matched.');
  assert.equal(R.reconHeadline(null), 'Nothing needs your attention. Every ingested line is matched.');
});

test('a resolution says what it did, never a bare "Saved"', () => {
  assert.equal(R.reconResultMessage('approve', { updated: 3 }), '3 lines approved');
  assert.equal(R.reconResultMessage('reject', { updated: 1 }), '1 line rejected');
  assert.equal(R.reconResultMessage('match', { updated: 1 }), '1 line linked');
  assert.equal(R.reconResultMessage('unmatch', { updated: 1 }), '1 line unlinked');
  assert.equal(R.reconResultMessage('approve', { updated: 2, skipped: 1 }), '2 lines approved · 1 skipped');
});

// ============================================================
// 2. STRUCTURE
// ============================================================

test('the recon-core block is pure apart from its ONE declared dependency', () => {
  const m = APP.match(/\/\/ <recon-core>([\s\S]*?)\/\/ <\/recon-core>/);
  const body = stripLineComments(m[1], ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/, /\bcurrentAgent\b/,
   /\bescHTML\(/, /\bshowToast\(/, /\bnav\(/, /_rcCache/, /_bobPolicyUuid/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
  assert.ok(/commMoney\(/.test(body), 'the declared comm-core dependency should still be the only one');
});

test('every core sentinel still appears exactly once', () => {
  ['bob-core', 'comm-core', 'persist-core', 'recon-core', 'backoffice-core', 'team-core',
   'producer-codes-core', 'ai-meter-core']
    .forEach(name => {
      assert.equal((APP.match(new RegExp(`// <${name}>`, 'g')) || []).length, 1, `// <${name}>`);
      assert.equal((APP.match(new RegExp(`// </${name}>`, 'g')) || []).length, 1, `// </${name}>`);
    });
});

test('commission_rows stays SELECT-only — no write policy is added', () => {
  assert.ok(!/create policy/i.test(SQL_CODE),
    'a policy letting the browser set review_status could also set matched_policy_id');
  assert.ok(!/row level security/i.test(SQL_CODE));
});

test('the migration is additive: three columns, two indexes, one function', () => {
  assert.match(SQL_CODE, /add column if not exists reviewed_at/);
  assert.match(SQL_CODE, /add column if not exists reviewed_by/);
  assert.match(SQL_CODE, /add column if not exists review_note/);
  [/create table/i, /DROP\s+TABLE/i, /DROP\s+COLUMN/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i]
    .forEach(re => assert.ok(!re.test(SQL_CODE), `${re} must not appear`));
  assert.ok(!/\b(auth|storage)\.\w+\s+(SET|DROP|ADD)/i.test(SQL_CODE));
});

test('reviewed_by survives the reviewer being deleted', () => {
  assert.match(SQL_CODE, /reviewed_by\s+uuid references auth\.users\(id\) on delete set null/i,
    'removing an account must not erase the record that a decision was made');
});

test('review_queue is neither used nor altered — the documented decision', () => {
  assert.ok(!/review_queue/.test(SQL_CODE.replace(/^--.*$/gm, '')),
    'the carrier-mail pipeline owns review_queue and it is left alone');
  assert.ok(!/review_queue/.test(FN_CODE));
});

test('the edge function takes the agent FROM THE JWT, never from the body', () => {
  assert.match(FN_CODE, /const agentId = user\.id/);
  assert.ok(!/body\.agent_id/.test(FN_CODE), 'a body-supplied agent id is a way into someone else\'s book');
  assert.ok(!/agent_id:\s*body\./.test(FN_CODE));
});

test('every read and write is scoped to that agent', () => {
  // The row fetch, the policy lookup and the statement recount must all be
  // filtered by the agent resolved from the token.
  const scoped = (FN_CODE.match(/\.eq\("agent_id", agentId\)/g) || []).length;
  assert.ok(scoped >= 3, `expected at least 3 agent_id scopes, found ${scoped}`);
});

test('a MATCH re-checks that the target policy belongs to the caller', () => {
  const block = FN_CODE.slice(FN_CODE.indexOf('action === "match"'));
  assert.match(block.slice(0, 900), /from\("policies"\)[\s\S]{0,200}\.eq\("agent_id", agentId\)/,
    'a picker is a convenience, not a security boundary');
  assert.match(block.slice(0, 900), /policy_not_found/);
});

test('REJECT NEVER DELETES — it records a decision', () => {
  assert.ok(!/\.delete\(/.test(FN_CODE),
    'a reconciliation screen that could delete a commission line is where "nothing is discarded" breaks');
  const block = FN_CODE.slice(FN_CODE.indexOf('action === "reject"'));
  assert.match(block.slice(0, 200), /review_status = "rejected"|review_status" \] = "rejected"|patch\.review_status = "rejected"/);
});

test('approving a line that was never matched is refused, not silently done', () => {
  assert.match(FN_CODE, /nothing_to_approve/);
  assert.match(FN_CODE, /not linked to a policy yet/);
});

test('a row belonging to someone else is skipped, not reported as existing', () => {
  // Telling a caller "that row exists but is not yours" is itself a disclosure.
  assert.match(FN_CODE, /skipped: ids\.length - mine\.length/);
});

test('the resolution keeps the statement counters honest', () => {
  assert.match(FN_CODE, /review_count: count \?\? 0/);
  assert.match(FN_CODE, /matched_count: matched \?\? 0/);
});

test('statement-review is verify_jwt=true, so it is absent from config.toml', () => {
  assert.ok(!/statement-review/.test(CONFIG),
    'listing it in config.toml would take it to verify_jwt=false');
});

test('the browser never writes commission_rows directly', () => {
  // Every resolution goes through the edge function.
  assert.ok(!/from\('commission_rows'\)[\s\S]{0,80}\.(update|insert|delete|upsert)\(/.test(APP_CODE),
    'the browser must not write commission data at all');
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function rcCall'));
  assert.match(fn.slice(0, 900), /functions\/v1\/statement-review/);
  assert.match(fn.slice(0, 900), /session\.access_token/);
});

test('the Reconciliation area is registered like the others', () => {
  assert.match(APP, /data-boarea="reconciliation"/);
  assert.match(APP, /id="bopanel-reconciliation"/);
  assert.match(APP_CODE, /reconciliation: \(\) => rcRender\(true\)/);
});

test('the queues carry counts, a status filter and a match-% sort', () => {
  assert.match(APP, /id="rc-status"/);
  assert.match(APP, /id="rc-sort"/);
  assert.match(APP, /<option value="confidence">Match %<\/option>/);
  assert.deepEqual(R.RECON_STATUSES.map(s => s.key), ['needs_review', 'approved', 'rejected']);
});

test('the empty states explain the rule rather than just saying "nothing here"', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('function rcEmptyText'));
  const body = fn.slice(0, 900);
  assert.match(body, /45 days after its draft date/);
  assert.match(body, /in flight for more than an hour/);
});
