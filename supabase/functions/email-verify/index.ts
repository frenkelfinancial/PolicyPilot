import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  CODE_MAX_ATTEMPTS,
  EMAIL_MAX_SENDS_PER_ADDRESS_HOUR,
  EMAIL_MAX_SENDS_PER_IP_HOUR,
  EMAIL_SEND_WINDOW_MS,
  attemptsRemaining,
  codeExpiry,
  codeUsable,
  generateCode,
  hashCode,
  isWellFormedCode,
  isWellFormedEmail,
  normalizeCode,
  normalizeEmail,
  resendAllowed,
  resendWaitSeconds,
  timingSafeEqual,
  verificationEmailHtml,
  verificationEmailSubject,
  verificationEmailText,
} from "../_shared/auth-verify.ts";

// ============================================================
// email-verify — the six-digit check on step 1 of sign-up.
//
// ---- 🔴 send AND check ARE UNAUTHENTICATED, AND THAT IS THE DESIGN ---------
//
// The address is verified BEFORE the account is created, so there is no
// session, no JWT and no agent to attribute anything to. `verify_jwt = false`
// in config.toml is therefore load-bearing, exactly as it is for
// ai-call-webhook — and it means this function will send mail to whatever
// address it is handed. That is an open relay unless it is bounded, so it is
// bounded twice:
//
//   * per ADDRESS — 45s between sends, 5 an hour. Nobody can be mail-bombed.
//   * per IP      — 20 an hour. Nobody can spray a list of addresses.
//   * per CODE    — ~10 minutes, 5 wrong guesses (shared with phone-verify).
//
// All of them are enforced HERE. The browser mirrors the cooldown so it can
// count down a button, and `email-verification.test.mjs` pins the two together.
//
// ---- 🔴 VERIFYING AN ADDRESS IS NOT VERIFYING AN ACCOUNT -------------------
//
// `check` proves somebody reading that mailbox typed the code. It stamps
// `verified_at` on a row keyed to the ADDRESS and stops there. The account does
// not exist yet.
//
// `claim` is the separate, AUTHENTICATED step that happens after sign-up. It
// takes the email FROM THE JWT — never from the body — finds a recent verified
// unclaimed row for exactly that address, and only then writes
// `agents.email_verified_at`. Reading the address from the body would let
// anybody with an account claim a verification somebody else earned, which is
// the entire attack this split exists to prevent.
//
// ---- Why the row is claimed, not deleted -----------------------------------
//
// `claimed_by` is set once and the row is kept. A verification that was used is
// evidence; deleting it would make "was this address ever proved, and by whom"
// unanswerable, and would let one verified row be spent twice.
//
// Request:  { action: "send",  email }
//           { action: "check", email, code }
//           { action: "claim" }            <- Authorization: Bearer <user JWT>
// Response: { ok, … } or { error, detail }
// ============================================================

const RESEND_ENDPOINT = "https://api.resend.com/emails";

Deno.serve(async (req: Request) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM = Deno.env.get("AUTH_EMAIL_FROM") ||
    "Producer Stack <noreply@producerstackcrm.com>";

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = String((body as Record<string, unknown>).action ?? "");
  const now = Date.now();

  // The caller's IP. Behind Supabase's proxy the first x-forwarded-for hop is
  // the client; it is spoofable, which is why it is only ever a SECOND
  // ceiling on top of the per-address one and never the only bound.
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;

  // ── claim ────────────────────────────────────────────────────────────────
  // Authenticated. The address comes from the token, never the body.
  if (action === "claim") {
    const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return json({ error: "unauthorized" }, 401);

    const email = normalizeEmail(user.email);
    if (!email) return json({ error: "no_email_on_account" }, 400);

    const { data: row } = await sb
      .from("email_verifications")
      .select("id, verified_at, claimed_by")
      .eq("email", email)
      .not("verified_at", "is", null)
      .is("claimed_by", null)
      .order("verified_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row) {
      // Not an error the UI should shout about: an account can legitimately
      // exist without a pre-signup verification (Google sign-in, an account
      // made before this shipped). It simply has nothing to claim.
      return json({ ok: true, claimed: false, reason: "no_verified_address" });
    }

    // Bind the row to the account first. The unique-ish guard is the
    // `is("claimed_by", null)` filter re-applied on the UPDATE: Postgres
    // re-checks the WHERE after taking the row lock, so two concurrent claims
    // cannot both succeed. Same shape as the campaign enrollment claim.
    const { data: claimed } = await sb
      .from("email_verifications")
      .update({ claimed_by: user.id, claimed_at: new Date(now).toISOString() })
      .eq("id", row.id)
      .is("claimed_by", null)
      .select("id")
      .maybeSingle();

    if (!claimed) return json({ ok: true, claimed: false, reason: "already_claimed" });

    // Only now does an ACCOUNT become verified. agents_protect_verification_columns
    // lets the service role through; nothing else may write this column.
    const { error: upErr } = await sb
      .from("agents")
      .update({ email_verified_at: new Date(now).toISOString() })
      .eq("id", user.id);
    if (upErr) return json({ error: "stamp_failed", detail: upErr.message }, 500);

    return json({ ok: true, claimed: true });
  }

  // ── send ─────────────────────────────────────────────────────────────────
  if (action === "send") {
    const email = normalizeEmail((body as Record<string, unknown>).email);
    if (!isWellFormedEmail(email)) return json({ error: "invalid_email" }, 400);
    if (!RESEND_KEY) return json({ error: "email_not_configured" }, 500);

    const windowStart = new Date(now - EMAIL_SEND_WINDOW_MS).toISOString();

    // 1. Cooldown — the most recent send to this address, whatever its state.
    const { data: last } = await sb
      .from("email_verifications")
      .select("created_at")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastMs = last?.created_at ? Date.parse(last.created_at) : null;
    if (!resendAllowed(lastMs, now)) {
      return json({
        error: "resend_too_soon",
        retry_after: resendWaitSeconds(lastMs, now),
      }, 429);
    }

    // 2. Per-address hourly ceiling — protects the person receiving it.
    const { count: addrCount } = await sb
      .from("email_verifications")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", windowStart);

    if ((addrCount ?? 0) >= EMAIL_MAX_SENDS_PER_ADDRESS_HOUR) {
      return json({ error: "too_many_requests", detail: "Too many codes requested for this address. Try again in an hour." }, 429);
    }

    // 3. Per-IP hourly ceiling — protects everybody else.
    if (ip) {
      const { count: ipCount } = await sb
        .from("email_verifications")
        .select("id", { count: "exact", head: true })
        .eq("request_ip", ip)
        .gte("created_at", windowStart);
      if ((ipCount ?? 0) >= EMAIL_MAX_SENDS_PER_IP_HOUR) {
        return json({ error: "too_many_requests", detail: "Too many codes requested. Try again in an hour." }, 429);
      }
    }

    // The row is inserted BEFORE the mail goes out, because the hash is
    // salted with the row's own id — there is no code to send until the row
    // exists. A row whose send then fails is a spent quota slot and nothing
    // else; it can never verify anybody, because the code was never seen.
    const code = generateCode();
    const { data: inserted, error: insErr } = await sb
      .from("email_verifications")
      .insert({
        email,
        code_hash: "pending",
        expires_at: codeExpiry(now),
        max_attempts: CODE_MAX_ATTEMPTS,
        request_ip: ip,
      })
      .select("id")
      .single();
    if (insErr || !inserted) return json({ error: "verification_insert_failed", detail: insErr?.message }, 500);

    const hash = await hashCode(code, inserted.id);
    await sb.from("email_verifications").update({ code_hash: hash }).eq("id", inserted.id);

    const mailRes = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: verificationEmailSubject(code),
        text: verificationEmailText(code),
        html: verificationEmailHtml(code),
      }),
    });

    if (!mailRes.ok) {
      const detail = await mailRes.text();
      console.error("email-verify send failed:", detail);
      // Kill the row: a code nobody received must not sit there consuming
      // the address's hourly quota or shadowing the next send's cooldown.
      await sb.from("email_verifications").delete().eq("id", inserted.id);
      return json({ error: "email_send_failed", detail: detail.slice(0, 300) }, 502);
    }

    return json({ ok: true, sent: true, expires_in: 600 });
  }

  // ── check ────────────────────────────────────────────────────────────────
  if (action === "check") {
    const email = normalizeEmail((body as Record<string, unknown>).email);
    const code = normalizeCode((body as Record<string, unknown>).code);
    if (!isWellFormedEmail(email)) return json({ error: "invalid_email" }, 400);
    if (!isWellFormedCode(code)) return json({ error: "invalid_code" }, 400);

    const { data: row } = await sb
      .from("email_verifications")
      .select("id, code_hash, expires_at, attempts, max_attempts, consumed_at, verified_at")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Used / expired / exhausted is decided BEFORE the hash comparison, so a
    // dead code cannot be told apart from a wrong one by how long we take.
    //
    // Only the REASON crosses the wire. codeUsable's `detail` is written for
    // the SMS gate and says "this number" — correct there, wrong here — so the
    // email wording lives in evVerifyMessage() in the browser instead. Sending
    // the whole verdict object put `{"ok":false,"reason":…}` in the `error`
    // field, where every caller expects a string.
    const verdict = codeUsable(row as never, now);
    if (!verdict.ok) return json({ error: verdict.reason }, 400);

    const expected = await hashCode(code, (row as { id: string }).id);
    if (!timingSafeEqual(expected, (row as { code_hash: string }).code_hash)) {
      const attempts = ((row as { attempts: number }).attempts ?? 0) + 1;
      await sb.from("email_verifications")
        .update({
          attempts,
          consumed_at: attempts >= ((row as { max_attempts: number }).max_attempts ?? CODE_MAX_ATTEMPTS)
            ? new Date(now).toISOString()
            : null,
        })
        .eq("id", (row as { id: string }).id);
      return json({
        error: "incorrect_code",
        attempts_remaining: attemptsRemaining({
          ...(row as object),
          attempts,
        } as never),
      }, 400);
    }

    await sb.from("email_verifications")
      .update({
        verified_at: new Date(now).toISOString(),
        consumed_at: new Date(now).toISOString(),
      })
      .eq("id", (row as { id: string }).id);

    return json({ ok: true, verified: true });
  }

  return json({ error: "unknown_action" }, 400);
});
