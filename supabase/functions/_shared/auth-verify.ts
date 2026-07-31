// ============================================================
// supabase/functions/_shared/auth-verify.ts
//
// "Verify to activate" — the two rules that must have exactly ONE definition:
//
//   1. What counts as an acceptable password.
//   2. Whether a 6-digit phone code may still be tried, and whether it matches.
//
// Both are duplicated in the browser (app.html's `// <password-core>` block
// and the phone-verify UI) because the agent has to be told BEFORE they press
// anything. `test/auth-verify.test.ts` runs the same cases through both and
// compares — the same arrangement as pcNormalizeCode()/pc_normalize_code()
// and the AI call meter. Change one, change the other.
//
// Nothing in this file touches the network, the database or Deno.env, so it
// runs unchanged under `node --test`.
// ============================================================

// ------------------------------------------------------------
// 1. PASSWORDS
// ------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 8;

/**
 * "Special character" is defined as ANY printable non-alphanumeric.
 *
 * Deliberately wide. A whitelist of a dozen punctuation marks is the reason
 * people meet a password rule by appending "!" — and it rejects perfectly
 * good passphrases containing a character the author did not think of.
 * Whitespace counts too: a space inside a passphrase is a real character and
 * refusing it teaches nothing.
 */
export function hasSpecialChar(pw: string): boolean {
  return /[^A-Za-z0-9]/.test(pw || "");
}

export function hasNumber(pw: string): boolean {
  return /[0-9]/.test(pw || "");
}

export interface PasswordRuleResult {
  key: "length" | "number" | "special";
  label: string;
  met: boolean;
}

/**
 * Every rule, always all of them, each with its own met/not-met.
 *
 * Returning the FULL list rather than the first failure is what lets the UI
 * show a live checklist: an agent typing a password needs to see the two
 * rules they have satisfied, not be told about one at a time as they fix them.
 */
export function passwordRules(pw: string): PasswordRuleResult[] {
  const s = typeof pw === "string" ? pw : "";
  return [
    { key: "length",  label: `At least ${PASSWORD_MIN_LENGTH} characters`, met: s.length >= PASSWORD_MIN_LENGTH },
    { key: "number",  label: "At least one number",                        met: hasNumber(s) },
    { key: "special", label: "At least one special character",             met: hasSpecialChar(s) },
  ];
}

export function passwordOk(pw: string): boolean {
  return passwordRules(pw).every((r) => r.met);
}

/** One sentence naming everything still missing. Empty string when it passes. */
export function passwordProblem(pw: string): string {
  const missing = passwordRules(pw).filter((r) => !r.met);
  if (!missing.length) return "";
  const parts = missing.map((r) => {
    if (r.key === "length")  return `${PASSWORD_MIN_LENGTH} characters or more`;
    if (r.key === "number")  return "a number";
    return "a special character";
  });
  const list = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return `Your password needs ${list}.`;
}

// ------------------------------------------------------------
// 2. PHONE VERIFICATION CODES
// ------------------------------------------------------------

export const CODE_LENGTH       = 6;
export const CODE_TTL_MS       = 10 * 60 * 1000;   // ~10 minutes
export const CODE_MAX_ATTEMPTS = 5;
/** How long before another code may be requested for the same number. */
export const CODE_RESEND_COOLDOWN_MS = 45 * 1000;

/**
 * A uniformly-distributed 6-digit code.
 *
 * Rejection sampling, not `% 1000000`: a 32-bit value taken modulo a million
 * is measurably biased toward the low codes, and "guessable-er than it looks"
 * is the entire failure mode a 6-digit secret has. Leading zeros are kept —
 * 042317 is a valid code and padStart is what makes the space actually 10^6.
 */
export function generateCode(
  rand: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0],
): string {
  const LIMIT = 1_000_000;
  const CEIL = Math.floor(0x1_0000_0000 / LIMIT) * LIMIT;   // 4,294,000,000
  let v = rand() >>> 0;
  // Bounded so a pathological rand() cannot spin forever; after this many
  // draws the residual bias is far below anything that matters.
  for (let i = 0; i < 64 && v >= CEIL; i++) v = rand() >>> 0;
  return String(v % LIMIT).padStart(CODE_LENGTH, "0");
}

/** Only ever the digits. Strips the spaces and dashes people paste. */
export function normalizeCode(input: unknown): string {
  return String(input ?? "").replace(/\D/g, "").slice(0, CODE_LENGTH);
}

export function isWellFormedCode(input: unknown): boolean {
  return normalizeCode(input).length === CODE_LENGTH;
}

/**
 * sha256(code + ':' + salt), hex.
 *
 * The salt is the verification ROW'S id, so two agents who happen to be
 * issued the same code get different hashes and a stolen table cannot be
 * attacked with one precomputed set of a million digests.
 *
 * Not bcrypt/argon: this secret lives for ten minutes, allows five guesses,
 * and a deliberately slow hash on the send path would add latency to every
 * signup for no gain against an attacker who cannot make five guesses.
 */
export async function hashCode(code: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${normalizeCode(code)}:${salt}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time-ish comparison of two hex digests.
 *
 * `a === b` on strings short-circuits at the first differing character, which
 * over enough samples leaks how much of the digest was right. Both operands
 * here are already hashes so the leak is not directly exploitable, but this
 * costs nothing and removes the question.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = String(a ?? ""), y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export interface VerificationRow {
  id: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  max_attempts: number;
  consumed_at: string | null;
}

export type CheckVerdict =
  | { ok: true }
  | { ok: false; reason: "no_code" | "already_used" | "expired" | "too_many_attempts" | "wrong_code"; detail: string };

/**
 * May this code still be tried at all? Answered BEFORE the hash comparison.
 *
 * Order matters and this is it: a row that is used, expired or exhausted is
 * refused without looking at what the caller typed, so a burnt code cannot be
 * distinguished from a wrong one by how long the request takes.
 */
export function codeUsable(row: VerificationRow | null | undefined, nowMs: number): CheckVerdict {
  if (!row) {
    return { ok: false, reason: "no_code", detail: "No code has been sent to this number. Send one first." };
  }
  if (row.consumed_at) {
    return { ok: false, reason: "already_used", detail: "That code has already been used. Send a new one." };
  }
  if (new Date(row.expires_at).getTime() <= nowMs) {
    return { ok: false, reason: "expired", detail: "That code has expired. Send a new one." };
  }
  if ((row.attempts || 0) >= (row.max_attempts || CODE_MAX_ATTEMPTS)) {
    return { ok: false, reason: "too_many_attempts", detail: "Too many wrong tries. Send a new code." };
  }
  return { ok: true };
}

/** How many guesses are left, for the message under the input. */
export function attemptsRemaining(row: VerificationRow | null | undefined): number {
  if (!row) return 0;
  return Math.max(0, (row.max_attempts || CODE_MAX_ATTEMPTS) - (row.attempts || 0));
}

/** The expiry stamp for a code minted at `nowMs`. */
export function codeExpiry(nowMs: number): string {
  return new Date(nowMs + CODE_TTL_MS).toISOString();
}

/**
 * Is a resend allowed yet?
 *
 * Without this, "Resend" is a free SMS button: every press is a real message
 * on a real carrier, billed, and a hundred of them to one handset is how a
 * number gets reported. `lastSentMs` null means nothing has been sent.
 */
export function resendAllowed(lastSentMs: number | null, nowMs: number): boolean {
  if (lastSentMs === null || lastSentMs === undefined) return true;
  return nowMs - lastSentMs >= CODE_RESEND_COOLDOWN_MS;
}

/** Whole seconds an agent must still wait. 0 when they may resend now. */
export function resendWaitSeconds(lastSentMs: number | null, nowMs: number): number {
  if (resendAllowed(lastSentMs, nowMs)) return 0;
  return Math.ceil((CODE_RESEND_COOLDOWN_MS - (nowMs - (lastSentMs as number))) / 1000);
}

/** The message body. One definition, so the code and the copy cannot drift. */
export function verificationSmsText(code: string): string {
  return `${code} is your Producer Stack verification code. It expires in 10 minutes. ` +
    `We will never ask you for this code.`;
}

// ============================================================
// EMAIL verification — the same six-digit rules, a different channel.
//
// 🔴 THE EMAIL ENDPOINT IS REACHED WITHOUT A SESSION, AND THAT IS THE WHOLE
// DIFFERENCE. Phone verification happens inside the app, so `phone-verify`
// takes its agent from the JWT and the JWT is the rate limit — one account,
// one target. Email verification happens on the FIRST page of sign-up, before
// any account exists, so `email-verify` has no caller identity to trust and
// will send mail to whatever address it is handed.
//
// That makes it an open relay unless it is bounded, so it is bounded twice:
// per ADDRESS (nobody can be mail-bombed) and per IP (nobody can spray many
// addresses). The per-address cooldown is the shared 45s; these two hourly
// ceilings exist only for the unauthenticated path.
// ============================================================

/** Sends allowed to ONE address in a rolling hour. Protects the recipient. */
export const EMAIL_MAX_SENDS_PER_ADDRESS_HOUR = 5;

/** Sends allowed from ONE IP in a rolling hour. Protects everyone else. */
export const EMAIL_MAX_SENDS_PER_IP_HOUR = 20;

/** The rolling window both ceilings are measured over. */
export const EMAIL_SEND_WINDOW_MS = 60 * 60 * 1000;

/**
 * Lower-cased and trimmed. Stored and compared in this form ONLY, so that
 * `Jane@Example.com` cannot hold a second, separate quota from
 * `jane@example.com` — or, worse, verify one address and sign up with another
 * that differs only in case.
 */
export function normalizeEmail(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

/**
 * Deliberately permissive: one @, something either side, a dot in the domain,
 * no whitespace. This is a cheap shape check to avoid minting a code for
 * obvious rubbish — the real proof of an address is that a code sent to it
 * comes back, which is the entire point of the feature.
 */
export function isWellFormedEmail(input: unknown): boolean {
  const e = normalizeEmail(input);
  if (e.length < 6 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e);
}

/** Subject line. Carries the code so it is readable from a notification. */
export function verificationEmailSubject(code: string): string {
  return `${code} is your Producer Stack verification code`;
}

/** Plain-text body — one definition, shared with the HTML part below. */
export function verificationEmailText(code: string): string {
  return `${code} is your Producer Stack verification code.\n\n` +
    `Enter it on the sign-up page to confirm your email address. ` +
    `It expires in 10 minutes.\n\n` +
    `We will never ask you for this code. If you did not request it, ignore this email.`;
}

/**
 * The HTML part. `code` is injected into markup, so it is re-derived from the
 * digits rather than interpolated raw — the value is ours and always six
 * digits, and this keeps it that way if that ever stops being true.
 */
export function verificationEmailHtml(code: string): string {
  const safe = normalizeCode(code);
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <p style="font-size:15px;color:#0f172a;margin:0 0 18px">Confirm your email address to finish setting up your Producer Stack account.</p>
  <div style="font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;padding:18px;background:#f1f5f9;border-radius:12px;color:#0f172a">${safe}</div>
  <p style="font-size:13px;color:#475569;margin:18px 0 0">This code expires in 10 minutes. We will never ask you for it.</p>
  <p style="font-size:13px;color:#94a3b8;margin:10px 0 0">If you did not request this, you can ignore this email.</p>
</div>`;
}
