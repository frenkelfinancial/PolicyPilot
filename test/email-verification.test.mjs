// ============================================================
// email-verification.test.mjs — run with:  npm run test:emailverify
//
// The six-digit email check on step 1 of sign-up.
//
// This one differs from every other verification in the app in a way that is
// easy to lose: `email-verify`'s send/check actions are reachable WITHOUT A
// SESSION, because the whole point is to prove the address before the account
// exists. phone-verify takes its agent from the JWT and the JWT is the rate
// limit; this function has no caller identity at all and will send mail to
// whatever address it is handed.
//
// So what is pinned here is mostly the things that stop that being an open
// relay, plus the split between verifying an ADDRESS and verifying an ACCOUNT.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').split('\r\n').join('\n');

const APP = read('app.html');
const FN = read('supabase/functions/email-verify/index.ts');
const SHARED = read('supabase/functions/_shared/auth-verify.ts');
const MIG = read('supabase/migrations/20260809_email_verification.sql');
const CONFIG = read('supabase/config.toml');
const PHONE_FN = read('supabase/functions/phone-verify/index.ts');

const stripJs = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const stripSql = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const FN_CODE = stripJs(FN);
const APP_CODE = stripJs(APP);
const MIG_CODE = stripSql(MIG);

// ============================================================
// 1. THE SHARED RULES, EXECUTED
// ============================================================

function loadShared() {
  const pick = (name, re) => {
    const m = SHARED.match(re);
    assert.ok(m, `auth-verify.ts must export ${name}`);
    return m;
  };
  const norm = pick('normalizeEmail', /export function normalizeEmail\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  const wellFormed = pick('isWellFormedEmail', /export function isWellFormedEmail\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  // eslint-disable-next-line no-new-func
  return new Function(`
    function normalizeEmail(input) {${norm[1]}}
    function isWellFormedEmail(input) {${wellFormed[1]}}
    return { normalizeEmail, isWellFormedEmail };
  `)();
}
const { normalizeEmail, isWellFormedEmail } = loadShared();

test('🔴 an address is normalised before it is stored or compared', () => {
  // Without this, Jane@Example.com holds a second quota from
  // jane@example.com — and worse, somebody verifies one casing and signs up
  // with another.
  assert.equal(normalizeEmail('  Jane@Example.COM '), 'jane@example.com');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('the shape check rejects obvious rubbish but is not clever about it', () => {
  for (const good of ['a@b.co', 'jane.smith+tag@sub.example.com', 'x_y@d.io']) {
    assert.equal(isWellFormedEmail(good), true, good);
  }
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '@b.co', 'a@.co', 'a@b.', 'a@@b.co']) {
    assert.equal(isWellFormedEmail(bad), false, JSON.stringify(bad));
  }
  // Length bounds, so a megabyte of text is not hashed and mailed.
  assert.equal(isWellFormedEmail('a@' + 'x'.repeat(300) + '.com'), false);
});

test('the code rules are SHARED with phone-verify, not a second copy', () => {
  // One definition of "10 minutes, 5 attempts, 45 seconds" for both channels.
  for (const sym of ['CODE_MAX_ATTEMPTS', 'codeExpiry', 'codeUsable', 'generateCode',
                     'hashCode', 'timingSafeEqual', 'resendAllowed', 'isWellFormedCode']) {
    assert.ok(FN.includes(sym), `email-verify must reuse ${sym}`);
    assert.ok(PHONE_FN.includes(sym), `phone-verify should also use ${sym}`);
  }
  assert.match(FN, /from "\.\.\/_shared\/auth-verify\.ts"/);
});

// ============================================================
// 2. 🔴 IT IS OPENLY REACHABLE, SO IT MUST BE BOUNDED
// ============================================================

test('🔴 verify_jwt is off, and the file says why', () => {
  assert.match(CONFIG, /\[functions\.email-verify\]\s*\nverify_jwt = false/);
  const at = CONFIG.indexOf('[functions.email-verify]');
  const why = CONFIG.slice(Math.max(0, at - 900), at);
  assert.match(why, /before the account exists/i);
});

test('🔴 there are THREE bounds and all three are server-side', () => {
  // Per address: a cooldown and an hourly ceiling, so nobody is mail-bombed.
  assert.match(FN_CODE, /resendAllowed\(lastMs, now\)/);
  assert.match(FN_CODE, /EMAIL_MAX_SENDS_PER_ADDRESS_HOUR/);
  // Per IP: so nobody sprays a list of addresses.
  assert.match(FN_CODE, /EMAIL_MAX_SENDS_PER_IP_HOUR/);
  assert.match(FN_CODE, /request_ip/);
  // Per code: expiry and attempts, via the shared verdict. Only the REASON is
  // sent — codeUsable's detail is SMS wording, and the whole object in `error`
  // is not a string, which every caller assumes it is.
  assert.match(FN_CODE, /codeUsable\(/);
  assert.match(FN_CODE, /if \(!verdict\.ok\) return json\(\{ error: verdict\.reason \}/);
  const nums = SHARED.match(/EMAIL_MAX_SENDS_PER_ADDRESS_HOUR = (\d+)/);
  const ipNums = SHARED.match(/EMAIL_MAX_SENDS_PER_IP_HOUR = (\d+)/);
  assert.ok(nums && Number(nums[1]) > 0 && Number(nums[1]) <= 10);
  assert.ok(ipNums && Number(ipNums[1]) >= Number(nums[1]),
    'the IP ceiling must not be tighter than the per-address one, or one office cannot sign up');
});

test('the per-IP ceiling is skipped when there is no IP, never counted as one bucket', () => {
  // Counting null IPs together would let one unresolvable client spend
  // everyone else's quota.
  assert.match(FN_CODE, /if \(ip\) \{/);
  assert.match(MIG_CODE, /where request_ip is not null/);
});

test('a code that could not be sent does not hold the address hostage', () => {
  // The row is inserted before the mail (the hash is salted with its id), so a
  // failed send must delete it — otherwise it shadows the next cooldown and
  // burns an hourly slot for a code nobody ever saw.
  const at = FN_CODE.indexOf('email_send_failed');
  const near = FN_CODE.slice(Math.max(0, at - 400), at + 120);
  assert.match(near, /\.delete\(\)\.eq\("id", inserted\.id\)/);
});

// ============================================================
// 3. 🔴 AN ADDRESS IS NOT AN ACCOUNT
// ============================================================

test('🔴 claim takes the email from the JWT and never from the body', () => {
  const at = FN_CODE.indexOf('if (action === "claim")');
  assert.ok(at > -1);
  const body = FN_CODE.slice(at, FN_CODE.indexOf('if (action === "send")'));
  assert.match(body, /sb\.auth\.getUser\(token\)/);
  assert.match(body, /normalizeEmail\(user\.email\)/);
  assert.ok(!/body\)\.email|body\.email/.test(body),
    'claim must not read an address from the request body');
  assert.match(body, /return json\(\{ error: "unauthorized" \}, 401\)/);
});

test('🔴 only claim writes agents.email_verified_at', () => {
  const writes = FN_CODE.match(/email_verified_at/g) || [];
  assert.equal(writes.length, 1, 'exactly one write, in claim');
  const at = FN_CODE.indexOf('email_verified_at');
  const claimAt = FN_CODE.indexOf('if (action === "claim")');
  const sendAt = FN_CODE.indexOf('if (action === "send")');
  assert.ok(at > claimAt && at < sendAt, 'the write lives inside claim');
  // check() proves an ADDRESS and must stop there.
  const check = FN_CODE.slice(FN_CODE.indexOf('if (action === "check")'));
  assert.ok(!/agents/.test(check), 'check must not touch the agents table');
});

test('a verification can be claimed exactly once', () => {
  const at = FN_CODE.indexOf('if (action === "claim")');
  const body = FN_CODE.slice(at, FN_CODE.indexOf('if (action === "send")'));
  // Conditional UPDATE: Postgres re-checks the WHERE after the row lock, so
  // two concurrent claims cannot both win.
  assert.match(body, /\.update\(\{ claimed_by[\s\S]*?\.is\("claimed_by", null\)/);
  assert.match(body, /already_claimed/);
  assert.ok(!/\.delete\(/.test(body), 'a used verification is evidence, not rubbish');
});

test('an account with nothing to claim is not an error', () => {
  // Google sign-in and pre-existing accounts never had a step-1 verification.
  assert.match(FN_CODE, /no_verified_address/);
  const at = FN_CODE.indexOf('no_verified_address');
  assert.match(FN_CODE.slice(at - 120, at + 60), /ok: true, claimed: false/);
});

// ============================================================
// 4. THE TABLE
// ============================================================

test('🔴 email_verifications has RLS on and NOT ONE policy', () => {
  assert.match(MIG_CODE, /alter table public\.email_verifications enable row level security/);
  assert.ok(!/create policy/i.test(MIG_CODE),
    'a browser that could read this table could read code hashes; one that could write it could forge a verification');
  assert.match(MIG_CODE, /revoke all on public\.email_verifications from anon, authenticated/);
});

test('it stores a hash, never the code', () => {
  assert.match(MIG_CODE, /code_hash\s+text not null/);
  assert.ok(!/\bcode\s+text\b/.test(MIG_CODE), 'no plaintext code column');
  assert.match(FN_CODE, /hashCode\(code, inserted\.id\)/, 'salted with the row id');
});

test('it is keyed on the address, because there is no agent yet', () => {
  assert.match(MIG_CODE, /email\s+text not null/);
  assert.ok(!/agent_id\s+uuid not null/.test(MIG_CODE),
    'keying on an agent is what phone_verifications does and is exactly what cannot work here');
  assert.match(MIG_CODE, /claimed_by\s+uuid references auth\.users\(id\)/);
});

// ============================================================
// 5. THE STEP-1 GATE
// ============================================================

test('🔴 Continue is blocked until the address in the box is the one proved', () => {
  const at = APP_CODE.indexOf('function wizStep1Next()');
  const body = APP_CODE.slice(at, at + 1400);
  assert.match(body, /evNormEmail\(email\) !== _evVerified/);
  assert.match(body, /return _wizErr\(1, 'Verify your email address to continue/);
  // The check must come BEFORE wizGoTo(2), or it blocks nothing.
  assert.ok(body.indexOf('_evVerified') < body.indexOf('wizGoTo(2)'));
});

test('🔴 _evVerified holds an ADDRESS, not a boolean', () => {
  // A flag stays true while the field says something else, which is how
  // somebody verifies one address and signs up with another.
  assert.match(APP_CODE, /let _evVerified = null;/);
  assert.ok(!/_evVerified = true/.test(APP_CODE), 'never a boolean');
  assert.match(APP_CODE, /_evVerified = email;/);
  // Editing the address revokes it.
  const at = APP_CODE.indexOf('function evEmailChanged()');
  const body = APP_CODE.slice(at, at + 500);
  assert.match(body, /_evVerified && cur !== _evVerified/);
  assert.match(body, /_evVerified = null;/);
});

test('the browser mirrors the cooldown but never decides it', () => {
  // The server owns every bound; the browser only counts down a button.
  assert.match(APP_CODE, /evStartCooldown\(detail\.retry_after \|\| 45\)/);
  assert.ok(!/EMAIL_MAX_SENDS/.test(APP_CODE), 'no ceiling is re-implemented in the browser');
});

test('every server code becomes a sentence, in one place', () => {
  const m = APP.match(/function evVerifyMessage\(d\) \{([\s\S]*?)\n\}/);
  assert.ok(m);
  // eslint-disable-next-line no-new-func
  const fn = new Function(`function evVerifyMessage(d) {${m[1]}\n} return evVerifyMessage;`)();
  // The four middle ones are codeUsable()'s OWN reason strings — the server
  // forwards `verdict.reason` verbatim, so this list must match that union or
  // a real refusal falls through to the generic sentence.
  const usable = SHARED.match(/reason: "([a-z_"| ]+)"/);
  assert.ok(usable, 'CheckVerdict must still declare its reasons');
  for (const r of ['no_code', 'already_used', 'expired', 'too_many_attempts']) {
    assert.ok(SHARED.includes(`"${r}"`), `CheckVerdict lost the reason ${r}`);
  }
  for (const code of ['invalid_email', 'too_many_requests', 'expired', 'already_used',
                      'too_many_attempts', 'no_code', 'incorrect_code', 'email_send_failed']) {
    const out = fn({ error: code });
    // Prose, not the raw token. ("expired" legitimately appears inside "That
    // code expired." — what must never appear is the snake_case identifier.)
    assert.ok(out && out.length > 8 && out !== code && !/_/.test(out),
      `${code} must become prose, got: ${out}`);
  }
  assert.match(fn({ error: 'incorrect_code', attempts_remaining: 3 }), /3 attempts left/);
  assert.match(fn({ error: 'incorrect_code', attempts_remaining: 1 }), /1 attempt left/);
  assert.ok(fn({}).length > 8, 'an unknown code still says something');
});

test('the claim is fired after sign-up and can never break it', () => {
  const at = APP_CODE.indexOf('currentAgent = signUpData.session.user;');
  const body = APP_CODE.slice(at, at + 400);
  assert.match(body, /try \{ await evClaimVerification\(\); \} catch \(_\) \{\}/);
  // And it sends no address — the server reads it from the token. Asserted on
  // the body object itself: the function NAME contains "email-verify", so a
  // loose grep for "email" here matches the call and proves nothing.
  const cl = APP_CODE.slice(APP_CODE.indexOf('async function evClaimVerification()'),
                            APP_CODE.indexOf('async function evClaimVerification()') + 600);
  const bodyArg = cl.match(/body: (\{[^}]*\})/);
  assert.ok(bodyArg, 'evClaimVerification must pass a body');
  assert.equal(bodyArg[1].trim(), "{ action: 'claim' }");
  assert.ok(!/email/.test(bodyArg[1]), 'no address may be sent with a claim');
});

test('the UI has one writer for its state', () => {
  assert.match(APP_CODE, /function evSetState\(state\)/);
  assert.match(APP, /id="ev-send-btn"/);
  assert.match(APP, /id="ev-code-wrap"[^>]*style="display:none"/);
  assert.match(APP, /id="ev-code"[^>]*maxlength="6"/);
  assert.match(APP, /autocomplete="one-time-code"/);
});
