// ============================================================
// auth-verify.test.ts — run with:  npm run test:auth
//
// "Verify to activate" (prompt H, part F).
//
// Three kinds of assertion:
//
//   1. BEHAVIOUR of _shared/auth-verify.ts — the password rule, the code
//      generator, the hash, and the expiry/attempt bounds.
//
//   2. PARITY. app.html's `// <password-core>` block is extracted and
//      executed, and several hundred passwords are run through BOTH copies
//      and compared. They are duplicated on purpose — the agent has to see
//      the rule live as they type, and the server has to be able to enforce
//      it — so a test has to be the thing that keeps them equal. Same
//      arrangement as pcNormalizeCode()/pc_normalize_code() and the AI meter.
//
//   3. STRUCTURE. The migration grandfathers every existing account, the
//      verification columns are client-immutable, and the code table has no
//      write policy. F4 is the assertion that matters most in this file: a
//      migration that failed to grandfather would lock the owner out of his
//      own product.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CODE_LENGTH,
  CODE_MAX_ATTEMPTS,
  CODE_RESEND_COOLDOWN_MS,
  CODE_TTL_MS,
  PASSWORD_MIN_LENGTH,
  attemptsRemaining,
  codeExpiry,
  codeUsable,
  generateCode,
  hasNumber,
  hasSpecialChar,
  hashCode,
  isWellFormedCode,
  normalizeCode,
  passwordOk,
  passwordProblem,
  passwordRules,
  resendAllowed,
  resendWaitSeconds,
  timingSafeEqual,
  verificationSmsText,
} from "./auth-verify.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8").split("\r\n").join("\n");
const APP = read("app.html");
const MIG = read("supabase/migrations/20260804_sms_attestation_and_verification.sql");
const FN  = read("supabase/functions/phone-verify/index.ts");

// ============================================================
// 1. PASSWORDS
// ============================================================

test("the rule is 8 characters, a number, and a special character", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.deepEqual(passwordRules("").map((r) => r.key), ["length", "number", "special"]);
});

test("a password must satisfy ALL three, not any of them", () => {
  assert.equal(passwordOk("Passw0rd!"), true);
  assert.equal(passwordOk("Password!"), false);   // no number
  assert.equal(passwordOk("Password1"), false);   // no special
  assert.equal(passwordOk("Pa1!"), false);        // too short
  assert.equal(passwordOk("Pass1!"), false);      // 6 chars
  assert.equal(passwordOk("Pass12!x"), true);     // exactly 8
});

test("every rule reports its own state, which is what a live checklist needs", () => {
  const rules = passwordRules("abcdefgh");
  assert.equal(rules.find((r) => r.key === "length").met, true);
  assert.equal(rules.find((r) => r.key === "number").met, false);
  assert.equal(rules.find((r) => r.key === "special").met, false);
});

test("\"special\" is any non-alphanumeric, not a whitelist of a dozen marks", () => {
  // A whitelist is exactly why every password on earth ends in "!".
  ["!", "@", "#", "$", "%", "^", "&", "*", "-", "_", "=", "+", "[", "]", "{", "}",
   "|", "\\", ":", ";", "\"", "'", "<", ">", ",", ".", "?", "/", "~", "`", "£", "€", " "]
    .forEach((ch) => assert.equal(hasSpecialChar(`abcdefg${ch}`), true, `${ch} should count`));
  assert.equal(hasSpecialChar("abcDEF123"), false);
});

test("a space inside a passphrase counts as a special character", () => {
  assert.equal(passwordOk("correct horse 9"), true);
});

test("hasNumber does not accept a written-out number", () => {
  assert.equal(hasNumber("seven"), false);
  assert.equal(hasNumber("s7ven"), true);
});

test("the problem sentence names everything missing at once, not one at a time", () => {
  assert.equal(passwordProblem("Passw0rd!"), "");
  assert.equal(passwordProblem("password"), "Your password needs a number and a special character.");
  assert.equal(passwordProblem("pass"), "Your password needs 8 characters or more, a number and a special character.");
  assert.equal(passwordProblem("password1"), "Your password needs a special character.");
});

test("nothing throws on a non-string", () => {
  [null, undefined, 0, {}, []].forEach((v) => {
    assert.equal(passwordOk(v as unknown as string), false);
    assert.equal(typeof passwordProblem(v as unknown as string), "string");
  });
});

// ============================================================
// 2. PARITY — the browser copy and the server copy agree
// ============================================================

function loadPasswordCore() {
  const m = APP.match(/\/\/ <password-core>([\s\S]*?)\/\/ <\/password-core>/);
  assert.ok(m, "app.html must contain the // <password-core> block");
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn { passwordRules, passwordOk, passwordProblem, PASSWORD_MIN_LENGTH };`)();
}
const B = loadPasswordCore();

test("PARITY: the browser and the server agree on several hundred passwords", () => {
  const bits = ["", "a", "A", "9", "!", "  ", "abcdefgh", "ABCDEFGH12", "p@ss", "12345678",
                "correct horse", "£", "~`", "Passw0rd", "________", "9!"];
  const cases: string[] = [];
  for (const a of bits) for (const b of bits) { cases.push(a + b); cases.push(b + a + b); }
  assert.ok(cases.length >= 400, `expected a few hundred cases, got ${cases.length}`);
  for (const pw of cases) {
    assert.equal(B.passwordOk(pw), passwordOk(pw), `passwordOk disagreed on ${JSON.stringify(pw)}`);
    assert.equal(B.passwordProblem(pw), passwordProblem(pw), `passwordProblem disagreed on ${JSON.stringify(pw)}`);
    assert.deepEqual(
      B.passwordRules(pw).map((r) => [r.key, r.met]),
      passwordRules(pw).map((r) => [r.key, r.met]),
      `passwordRules disagreed on ${JSON.stringify(pw)}`,
    );
  }
});

test("PARITY: the minimum length is the same number in both copies", () => {
  assert.equal(B.PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH);
});

test("every password field in app.html validates through the shared rule", () => {
  // Four of them, and before this round all four said only "8 characters".
  assert.ok(!/Password must be at least 8 characters/.test(APP),
    "no field may keep its own length-only message");
  const uses = APP.match(/passwordOk\(/g) || [];
  assert.ok(uses.length >= 5, `expected the four validators plus the core, saw ${uses.length}`);
  // And each one has a live checklist mounted under it.
  ["signup-pw-rules", "reset-pw-rules", "stg-pw-rules"]
    .forEach((id) => assert.ok(APP.includes(`id="${id}"`), `${id} checklist must exist`));
  assert.match(APP, /function pwBindChecklist\(inputId, listId\)/);
});

// ============================================================
// 3. THE CODE ITSELF
// ============================================================

test("a code is six digits, leading zeros included", () => {
  assert.equal(CODE_LENGTH, 6);
  // rand() = 42 → "000042". padStart is what keeps the space at 10^6.
  assert.equal(generateCode(() => 42), "000042");
  assert.equal(generateCode(() => 0), "000000");
  assert.equal(generateCode(() => 999999), "999999");
});

test("the generator is unbiased — it rejects above the modulo boundary", () => {
  // 4,294,000,000 is the last multiple of 1e6 that fits in a uint32. A draw
  // at or above it must be discarded, not folded in: folding is what makes
  // the low codes commoner than the high ones.
  const draws = [4_294_000_000, 4_294_967_295, 7];
  let i = 0;
  assert.equal(generateCode(() => draws[i++]), "000007");
  assert.equal(i, 3, "both out-of-range draws should have been rejected");
});

test("a pathological rand() cannot spin forever", () => {
  let calls = 0;
  const out = generateCode(() => { calls++; return 4_294_967_295; });
  assert.equal(out.length, 6);
  assert.ok(calls <= 70, `bounded retry, saw ${calls} draws`);
});

test("1000 codes are all six digits and reasonably spread", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const c = generateCode();
    assert.match(c, /^[0-9]{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 900, `expected near-unique codes, got ${seen.size}/1000`);
});

test("pasted codes with spaces or dashes still work", () => {
  assert.equal(normalizeCode("123 456"), "123456");
  assert.equal(normalizeCode("123-456"), "123456");
  assert.equal(normalizeCode(" 123456 "), "123456");
  assert.equal(isWellFormedCode("12 34 56"), true);
  assert.equal(isWellFormedCode("12345"), false);
  assert.equal(isWellFormedCode("1234567"), true, "seven digits truncate to six");
  assert.equal(isWellFormedCode(null), false);
});

// ============================================================
// 4. HASHING
// ============================================================

test("the same code and salt hash the same, a different salt does not", async () => {
  const a = await hashCode("123456", "row-a");
  const b = await hashCode("123456", "row-a");
  const c = await hashCode("123456", "row-b");
  assert.equal(a, b);
  assert.notEqual(a, c, "the row id salt must change the digest");
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("the code itself never appears in its own hash", async () => {
  const h = await hashCode("424242", "row-a");
  assert.ok(!h.includes("424242"));
});

test("a hash is comparison-stable through the punctuation normaliser", async () => {
  assert.equal(await hashCode("123 456", "r"), await hashCode("123456", "r"));
});

test("timingSafeEqual is a real equality, and length-safe", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
  assert.equal(timingSafeEqual(null as unknown as string, "a"), false);
});

// ============================================================
// 5. EXPIRY, ATTEMPTS, COOLDOWN
// ============================================================

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const row = (o: Record<string, unknown> = {}) => ({
  id: "r1",
  code_hash: "x",
  expires_at: new Date(NOW + 60_000).toISOString(),
  attempts: 0,
  max_attempts: CODE_MAX_ATTEMPTS,
  consumed_at: null,
  ...o,
});

test("the three bounds are ten minutes, five tries, and a 45-second cooldown", () => {
  assert.equal(CODE_TTL_MS, 10 * 60 * 1000);
  assert.equal(CODE_MAX_ATTEMPTS, 5);
  assert.equal(CODE_RESEND_COOLDOWN_MS, 45_000);
  assert.equal(codeExpiry(NOW), new Date(NOW + CODE_TTL_MS).toISOString());
});

test("a live code is usable", () => {
  assert.deepEqual(codeUsable(row(), NOW), { ok: true });
});

test("no code at all is its own reason, not a wrong code", () => {
  const v = codeUsable(null, NOW);
  assert.equal(v.ok, false);
  assert.equal((v as { reason: string }).reason, "no_code");
});

test("a consumed code cannot be replayed", () => {
  const v = codeUsable(row({ consumed_at: new Date(NOW).toISOString() }), NOW);
  assert.equal((v as { reason: string }).reason, "already_used");
});

test("expiry is exclusive — a code is dead AT its expiry instant, not after", () => {
  const exp = new Date(NOW).toISOString();
  assert.equal((codeUsable(row({ expires_at: exp }), NOW) as { reason: string }).reason, "expired");
  assert.equal(codeUsable(row({ expires_at: new Date(NOW + 1).toISOString() }), NOW).ok, true);
});

test("the fifth wrong guess is the last one", () => {
  assert.equal(codeUsable(row({ attempts: 4 }), NOW).ok, true);
  assert.equal((codeUsable(row({ attempts: 5 }), NOW) as { reason: string }).reason, "too_many_attempts");
  assert.equal(attemptsRemaining(row({ attempts: 4 })), 1);
  assert.equal(attemptsRemaining(row({ attempts: 5 })), 0);
  assert.equal(attemptsRemaining(row({ attempts: 99 })), 0, "never negative");
});

test("used / expired / exhausted are all decided BEFORE the code is compared", () => {
  // codeUsable never receives the typed code — it cannot leak whether the
  // code was right via how long the answer took.
  assert.equal(codeUsable.length, 2, "codeUsable(row, nowMs) — no code parameter");
});

test("the resend cooldown holds, and counts down honestly", () => {
  assert.equal(resendAllowed(null, NOW), true, "nothing sent yet");
  assert.equal(resendAllowed(NOW, NOW), false);
  assert.equal(resendAllowed(NOW - 44_000, NOW), false);
  assert.equal(resendAllowed(NOW - 45_000, NOW), true);
  assert.equal(resendWaitSeconds(NOW, NOW), 45);
  assert.equal(resendWaitSeconds(NOW - 44_500, NOW), 1);
  assert.equal(resendWaitSeconds(NOW - 60_000, NOW), 0);
});

test("the SMS says what the code is for, how long it lasts, and not to share it", () => {
  const t = verificationSmsText("123456");
  assert.match(t, /^123456 /);
  assert.match(t, /Producer Stack/);
  assert.match(t, /10 minutes/);
  assert.match(t, /never ask you for this code/);
});

// ============================================================
// 6. THE ENDPOINT
// ============================================================

test("the agent comes from the JWT — there is no agent id in any request body", () => {
  assert.match(FN, /const \{ data: \{ user \} \} = await sbAuth\.auth\.getUser\(\);/);
  assert.ok(!/body\.agent_id/.test(FN), "phone-verify must never read an agent id from the body");
  // Every write is scoped to the token's user.
  const updates = FN.match(/from\("agents"\)\s*\.update\([\s\S]*?\.eq\("id", user\.id\)/g) || [];
  assert.ok(updates.length >= 2, "both the phone write and the grant are scoped to user.id");
});

test("the code is hashed before it is stored, and the plaintext is never written", () => {
  assert.match(FN, /const digest = await hashCode\(code, row\.id\)/);
  assert.match(FN, /code_hash: digest/);
  // The only column that could hold it is code_hash, and it never gets `code`.
  assert.ok(!/code_hash:\s*code\b/.test(FN));
});

test("a send that Telnyx rejected retires its row instead of leaving a live code", () => {
  const at = FN.indexOf("if (!res.ok)");
  assert.ok(at > 0);
  const block = FN.slice(at, at + 900);
  assert.match(block, /consumed_at: nowIso/);
  assert.match(block, /return json\(\{[\s\S]*error: "send_failed"/);
});

test("the code is consumed BEFORE the grant, so it cannot be replayed if the grant fails", () => {
  const consumeAt = FN.indexOf("consumed_at: nowIso, attempts:");
  const grantAt   = FN.indexOf("phone_verified_at: nowIso");
  assert.ok(consumeAt > 0 && grantAt > 0);
  assert.ok(consumeAt < grantAt, "consume must precede the grant");
});

test("a malformed code does not burn an attempt", () => {
  const at = FN.indexOf('error: "bad_code_format"');
  assert.ok(at > 0);
  // The format check returns before the row is even read.
  assert.ok(at < FN.indexOf('.from("phone_verifications")\n      .select("id, code_hash'));
});

// ============================================================
// 7. 🔴 F4 — GRANDFATHERING
// ============================================================

test("🔴 every account that existed when the migration ran is BOTH email- and phone-verified", () => {
  // The single most important assertion in this file. Without it, applying
  // this migration locks nine live agents — the owner included — out of
  // calling, texting and the AI dialer, with no way back in.
  const block = MIG.slice(MIG.indexOf("3. 🔴 GRANDFATHER EVERY EXISTING ACCOUNT"));
  assert.match(block, /update public\.agents/);
  assert.match(block, /email_verified_at = coalesce\(email_verified_at, now\(\)\)/);
  assert.match(block, /phone_verified_at = coalesce\(phone_verified_at, now\(\)\)/);
  assert.match(block, /where email_verified_at is null or phone_verified_at is null/);
});

test("the columns are nullable timestamps, never a NOT NULL boolean default false", () => {
  // A `boolean not null default false` would have been the same migration
  // with every existing agent locked out.
  assert.match(MIG, /add column if not exists email_verified_at\s+timestamptz;/);
  assert.match(MIG, /add column if not exists phone_verified_at\s+timestamptz;/);
  assert.ok(!/verified\w*\s+boolean\s+not null\s+default\s+false/i.test(MIG));
});

test("a browser cannot mark itself verified, and an admin cannot either", () => {
  assert.match(MIG, /create trigger agents_protect_verification_columns\s+before insert or update on public\.agents/);
  const fn = MIG.slice(MIG.indexOf("function public.agents_protect_verification_columns"),
                       MIG.indexOf("drop trigger if exists agents_protect_verification_columns"));
  assert.match(fn, /new\.phone_verified_at := old\.phone_verified_at/);
  assert.match(fn, /new\.phone_verified_at := null/);   // the INSERT branch
  // NO ADMIN EXEMPTION. "An administrator marked this phone verified" is not
  // a verification — the point is that a human held the handset.
  assert.ok(!/is_admin/.test(fn),
    "the verification guard must not exempt admins");
});

test("the code table is SELECT-only — nothing may bump attempts from a browser", () => {
  const policies = MIG.match(/create policy "phone_verifications_[^"]*"[\s\S]*?;/g) || [];
  assert.equal(policies.length, 1, "exactly one policy on phone_verifications");
  assert.match(policies[0], /for select using \(auth\.uid\(\) = agent_id\)/);
  // A client that can move expires_at or reset attempts can brute-force six
  // digits at leisure.
  assert.ok(!/create policy "phone_verifications[^"]*"\s+on public\.phone_verifications for (insert|update|delete)/i.test(MIG));
});

// ============================================================
// 8. THE GATES IN THE APP
// ============================================================

test("email is a hard gate with a resend; phone is a soft one that locks features", () => {
  assert.match(APP, /id="verify-email-gate"/);
  assert.match(APP, /id="verify-phone-gate"/);
  assert.match(APP, /sb\.auth\.resend\(\{ type: 'signup', email \}\)/);
  assert.match(APP, /function vgRequirePhone\(featureLabel\)/);
  // Calling and texting all ask the same question.
  const uses = APP.match(/vgRequirePhone\(/g) || [];
  assert.ok(uses.length >= 6, `every calling/texting entry point must ask, saw ${uses.length}`);
});

test("a grandfathered or unreadable state never paints a lock", () => {
  // `_vgState.loaded` is false when the read failed. Painting a lock an agent
  // cannot clear, because we could not reach the server, is the wrong answer.
  assert.match(APP, /const locked = _vgState\.loaded && !vgPhoneVerified\(\);/);
  assert.match(APP, /if \(!_vgState\.loaded \|\| vgPhoneVerified\(\)\) return true;/);
});

test("the email gate accepts EITHER Supabase's own flag or the grandfather column", () => {
  const fn = APP.slice(APP.indexOf("function vgEmailVerified()"),
                       APP.indexOf("function vgPhoneVerified()"));
  assert.match(fn, /currentAgent\.email_confirmed_at/);
  assert.match(fn, /_vgState\.email_verified_at/);
});
