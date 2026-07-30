// ============================================================
// referrals.test.mjs — run with:  npm run test:referrals
//
// Back Office Phase 7: auto-referral generation, the chargeback at-risk
// signal, and the Carriers screen.
//
// The bug class that matters most here is a compliance one: a referral lead is
// created for somebody who never asked to hear from anyone. It MUST carry no
// consent, so the send gate refuses. A test asserts every consent-shaped key
// is absent from what the generator produces — the one assertion in this file
// that protects a live 10DLC campaign rather than a number on a screen.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20260745_carriers.sql'), 'utf8');

const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');
const APP_CODE = stripLineComments(APP, ['//', '*', '/*']);
const SQL_CODE = stripLineComments(MIGRATION, ['--']);

const REF = ['REFERRAL_SOURCE', 'REFERRAL_ROLES', 'referralNormalizePhone', 'referralNormalizeName',
             'referralCandidates', 'referralsFromPolicy', 'referralSummary'];
const TEAM = ['teamChargebackSpike', 'teamChargebackPhrase', 'teamAtRisk',
              'AT_RISK_CB_MIN_CENTS', 'AT_RISK_CB_RATIO'];

function loadBlock(name, exports) {
  const m = APP.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`));
  assert.ok(m, `app.html must contain the // <${name}> block`);
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${exports.join(',')}};`)();
}
const R = loadBlock('referral-core', REF);
const T = loadBlock('team-core', TEAM);

const policy = (o = {}) => ({
  id: 1001, client: 'Jane Insured', phone: '555-000-1111',
  beneficiaryName: 'Bob Beneficiary', beneficiaryPhone: '(555) 222-3333',
  beneficiaryRelationship: 'Son', ...o,
});

// ============================================================
// 1. AUTO-REFERRAL
// ============================================================

test('the source label is the one the brief names', () => {
  assert.equal(R.REFERRAL_SOURCE, 'referral — auto');
});

test('both roles are captured', () => {
  assert.deepEqual(R.REFERRAL_ROLES.map(r => r.key), ['beneficiary', 'emergency']);
});

test('a contact needs BOTH a name and a phone to become a lead', () => {
  // A lead an agent cannot call is not a lead; it just inflates the book.
  assert.equal(R.referralCandidates(policy()).length, 1);
  assert.equal(R.referralCandidates(policy({ beneficiaryPhone: '' })).length, 0);
  assert.equal(R.referralCandidates(policy({ beneficiaryName: '' })).length, 0);
  assert.equal(R.referralCandidates(policy({ beneficiaryPhone: '555-12' })).length, 0);
  assert.equal(R.referralCandidates(null).length, 0);
});

test('phones normalise to the last ten digits, like everywhere else', () => {
  assert.equal(R.referralNormalizePhone('(555) 222-3333'), '5552223333');
  assert.equal(R.referralNormalizePhone('+1 555 222 3333'), '5552223333');
  assert.equal(R.referralNormalizePhone('555-222'), '');
  assert.equal(R.referralNormalizePhone(null), '');
});

test('A REFERRAL LEAD CARRIES NO CONSENT OF ANY KIND', () => {
  // This is the assertion that protects a live 10DLC campaign. A beneficiary
  // named on an application has not asked to hear from anyone; the lead must
  // land needing an opt-in, so leadTextingState() renders needs_optin and
  // runComplianceGate() refuses the send.
  const { created } = R.referralsFromPolicy(policy(), [], { idBase: 1 });
  assert.equal(created.length, 1);
  const lead = created[0];
  ['tcpa_consent', 'tcpaConsent', 'tcpa_consent_source', 'tcpa_consent_at',
   'consent', 'consent_type', 'consentType', 'consent_method', 'optIn', 'opt_in',
   'sms_consent', 'smsConsent']
    .forEach(k => assert.ok(!(k in lead), `a referral lead must not carry ${k}`));
  assert.equal(lead.source, 'referral — auto');
  assert.equal(lead.status, 'new');
});

test('the lead says in words that it has not opted in', () => {
  const { created } = R.referralsFromPolicy(policy(), [], { idBase: 1 });
  assert.match(created[0].notes, /has not opted in/i);
  assert.match(created[0].notes, /Beneficiary on Jane Insured/);
  assert.match(created[0].notes, /Son/);
});

test('a referral is traceable back to the policy it came from', () => {
  const { created } = R.referralsFromPolicy(policy(), [], { idBase: 1 });
  assert.equal(created[0].referredByPolicyId, 1001);
  assert.equal(created[0].referredByClient, 'Jane Insured');
  assert.equal(created[0].referralRole, 'beneficiary');
  assert.equal(created[0].referralRelationship, 'Son');
});

test('a contact already in the book is skipped, with a reason', () => {
  const existing = [{ id: 5, name: 'Bob B', phone: '+1 (555) 222-3333' }];
  const res = R.referralsFromPolicy(policy(), existing, { idBase: 1 });
  assert.equal(res.created.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].reason, 'already in your book');
});

test('the INSURED is never turned into a referral for their own policy', () => {
  const p = policy({ beneficiaryPhone: '555-000-1111' });   // same as the insured
  const res = R.referralsFromPolicy(p, [], { idBase: 1 });
  assert.equal(res.created.length, 0);
  assert.equal(res.skipped.length, 1);
});

test('a beneficiary who is ALSO the emergency contact is created once', () => {
  const p = policy({ emergencyName: 'Bob Beneficiary', emergencyPhone: '555-222-3333',
                     emergencyRelationship: 'Son' });
  const res = R.referralsFromPolicy(p, [], { idBase: 1 });
  assert.equal(res.created.length, 1, 'creating them twice is the first thing an agent notices');
  assert.equal(res.skipped.length, 1);
});

test('two different contacts both become leads, with distinct ids', () => {
  const p = policy({ emergencyName: 'Carol Emergency', emergencyPhone: '555-444-5555',
                     emergencyRelationship: 'Daughter' });
  const res = R.referralsFromPolicy(p, [], { idBase: 7000 });
  assert.equal(res.created.length, 2);
  assert.notEqual(res.created[0].id, res.created[1].id);
  assert.deepEqual(res.created.map(l => l.referralRole), ['beneficiary', 'emergency']);
});

test('a policy with no referral fields produces nothing at all', () => {
  const res = R.referralsFromPolicy({ id: 1, client: 'X' }, [], { idBase: 1 });
  assert.deepEqual(res.created, []);
  assert.deepEqual(res.skipped, []);
  assert.equal(R.referralSummary(res), '');
});

test('the summary says what happened, never a bare "Saved"', () => {
  assert.equal(R.referralSummary({ created: [1], skipped: [] }), '1 referral added');
  assert.equal(R.referralSummary({ created: [1, 2], skipped: [3] }),
    '2 referrals added · 1 was already in your book');
  assert.equal(R.referralSummary({ created: [], skipped: [1, 2] }),
    '2 were already in your book');
});

// ============================================================
// 2. THE CHARGEBACK AT-RISK SIGNAL
// ============================================================

test('a chargeback spike needs BOTH a floor and a ratio', () => {
  assert.equal(T.AT_RISK_CB_MIN_CENTS, 50000);
  assert.equal(T.AT_RISK_CB_RATIO, 0.30);
  // $600 back against $1,000 gross — 60%, over both bars.
  assert.equal(T.teamChargebackSpike(60000, 100000), true);
  // $400 back is under the floor however bad the ratio.
  assert.equal(T.teamChargebackSpike(40000, 50000), false);
  // $600 back against $10,000 gross is 6% — an ordinary clawback.
  assert.equal(T.teamChargebackSpike(60000, 1000000), false);
});

test('NO commission data is not a spike', () => {
  // An agent whose statements have never been ingested must not be flagged
  // for not having uploaded any.
  assert.equal(T.teamChargebackSpike(undefined, undefined), false);
  assert.equal(T.teamChargebackSpike(0, 0), false);
  assert.equal(T.teamChargebackSpike(100000, 0), false);
  assert.equal(T.teamChargebackSpike(null, null), false);
});

const riskRow = (o = {}) => ({
  you: false, monthAp: 1000, prevMonthAp: 10000,
  lastDialAt: new Date('2026-07-29T00:00:00Z'),
  joinedAt: new Date('2025-01-01T00:00:00Z'), ...o,
});
const NOW = new Date('2026-07-29T12:00:00Z');

test('the pre-Phase-7 rule is unchanged when there is no commission data', () => {
  // Production down + quiet still fires; production down + dialling does not.
  assert.equal(T.teamAtRisk(riskRow({ lastDialAt: new Date('2026-07-01T00:00:00Z') }), NOW).atRisk, true);
  assert.equal(T.teamAtRisk(riskRow(), NOW).atRisk, false);
});

test('a chargeback spike is a SECOND way to satisfy the second half', () => {
  // Still dialling today, but a third of the book is coming back.
  const r = T.teamAtRisk(riskRow({ monthChargebackCents: 60000, monthGrossCents: 100000 }), NOW);
  assert.equal(r.atRisk, true);
  assert.equal(r.cbSpike, true);
  assert.equal(r.quiet, false);
});

test('production down is STILL required — a spike alone never flags', () => {
  const r = T.teamAtRisk(riskRow({ monthAp: 12000, prevMonthAp: 10000,
    monthChargebackCents: 60000, monthGrossCents: 100000 }), NOW);
  assert.equal(r.productionDown, false);
  assert.equal(r.atRisk, false, 'a good month with chargebacks is not the flight-risk pattern');
});

test('both existing guards survive Phase 7', () => {
  // You cannot fall from zero…
  assert.equal(T.teamAtRisk(riskRow({ prevMonthAp: 0, monthAp: 0,
    monthChargebackCents: 60000, monthGrossCents: 100000 }), NOW).atRisk, false);
  // …a new joiner has no prior month…
  assert.equal(T.teamAtRisk(riskRow({ joinedAt: new Date('2026-07-20T00:00:00Z'),
    monthChargebackCents: 60000, monthGrossCents: 100000 }), NOW).atRisk, false);
  // …and you never flag yourself.
  assert.equal(T.teamAtRisk(riskRow({ you: true,
    monthChargebackCents: 60000, monthGrossCents: 100000 }), NOW).atRisk, false);
});

test('the reason names the half that ACTUALLY fired', () => {
  // Sending a leader into a "you have not been dialling" conversation with an
  // agent who dialled this morning is worse than no badge.
  const cb = T.teamAtRisk(riskRow({ monthChargebackCents: 60000, monthGrossCents: 100000 }), NOW);
  assert.match(cb.reason, /AP down 90% vs last month, chargebacks are 60% of commission this month/);
  const quiet = T.teamAtRisk(riskRow({ lastDialAt: new Date('2026-07-01T00:00:00Z') }), NOW);
  assert.match(quiet.reason, /no dials in 28 days/);
  assert.ok(!/chargeback/.test(quiet.reason));
});

test('a row that is not at risk has no reason at all', () => {
  assert.equal(T.teamAtRisk(riskRow(), NOW).reason, '');
});

// ============================================================
// 3. STRUCTURE
// ============================================================

test('the referral-core block is pure', () => {
  const m = APP.match(/\/\/ <referral-core>([\s\S]*?)\/\/ <\/referral-core>/);
  const body = stripLineComments(m[1], ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/, /\bcurrentAgent\b/,
   /\bescHTML\(/, /\bshowToast\(/, /\bsaveLeads\(/, /\bnav\(/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
});

test('every core sentinel still appears exactly once', () => {
  ['bob-core', 'comm-core', 'persist-core', 'recon-core', 'referral-core',
   'backoffice-core', 'team-core', 'producer-codes-core', 'ai-meter-core'].forEach(name => {
    assert.equal((APP.match(new RegExp(`// <${name}>`, 'g')) || []).length, 1, `// <${name}>`);
    assert.equal((APP.match(new RegExp(`// </${name}>`, 'g')) || []).length, 1, `// </${name}>`);
  });
});

test('referral generation is wired into BOTH sale paths', () => {
  assert.match(APP_CODE, /referralReadFields\('p', policy\)/);
  assert.match(APP_CODE, /referralReadFields\('sold', policy\)/);
  assert.equal((APP_CODE.match(/await referralGenerate\(policy\)/g) || []).length, 2);
});

test('the sale forms warn that a referral has not opted in', () => {
  assert.match(APP, /They have <strong>not<\/strong> opted in/);
  assert.match(APP, /id="sold-benPhone"/);
  assert.match(APP, /id="p-emgPhone"/);
});

test('the roster feeds the chargeback figures in, best effort', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function loadTeamRoster'));
  const body = fn.slice(0, 2500);
  assert.match(body, /get_downline_commission_rollup/);
  // A failed rollup must not take down the roster.
  assert.match(body, /\(\) => \(\{ data: null, error: true \}\)/);
  assert.match(body, /buildTeamView\(Array\.isArray\(data\) \? data : \[\], new Date\(\), cbByAgent\)/);
});

test('the chargeback window is ALWAYS this calendar month', () => {
  // Same fixed window the AP half uses, so the badge cannot blink as a leader
  // clicks between period chips.
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function loadTeamRoster'));
  assert.match(fn.slice(0, 2500), /mStart\.setDate\(1\)/);
  assert.match(fn.slice(0, 2500), /mEnd\.setMonth\(mEnd\.getMonth\(\) \+ 1\)/);
});

test('the Carriers RPC is SECURITY INVOKER and takes only time bounds', () => {
  const m = /create or replace function public\.get_carrier_summary\(([^)]*)\)/i.exec(SQL_CODE);
  assert.ok(m);
  assert.ok(!/agent|leader|uid|user/i.test(m[1]), `no parameter may name an agent — got (${m[1]})`);
  assert.ok(!/security definer/i.test(SQL_CODE), 'a carrier list is per-agent, read through RLS');
});

test('the carriers migration adds no table, no column and no data', () => {
  [/create table/i, /alter table/i, /\binsert into\b/i, /create policy/i,
   /DROP\s+TABLE/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i]
    .forEach(re => assert.ok(!re.test(SQL_CODE), `${re} must not appear`));
});

test('the carrier list excludes rejected lines and counts unmatched ones', () => {
  assert.match(SQL_CODE, /review_status <> 'rejected'/);
  assert.match(SQL_CODE, /count\(\*\) filter \(where cr\.matched_policy_id is null\)/);
});

test('debt on the Carriers screen uses the SAME definition as the Debt tab', () => {
  assert.match(SQL_CODE, /transaction_type in \('chargeback','adjustment'\)/);
  assert.match(SQL_CODE, /greatest\(0, -coalesce\(sum/);
});

test('the Carriers area is registered like the others', () => {
  assert.match(APP, /data-boarea="carriers"/);
  assert.match(APP, /id="bopanel-carriers"/);
  assert.match(APP_CODE, /carriers: \(\) => crRender\(true\)/);
});

test('the Carriers screen is read-only — it writes nothing', () => {
  const fn = APP_CODE.slice(APP_CODE.indexOf('async function crRender'),
                            APP_CODE.indexOf('function crPaint'));
  assert.ok(!/\.(update|insert|delete|upsert)\(/.test(fn));
  assert.match(fn, /get_carrier_summary/);
});
