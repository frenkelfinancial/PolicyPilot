import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { toE164 } from "../_shared/phone.ts";
import {
  CODE_MAX_ATTEMPTS,
  attemptsRemaining,
  codeExpiry,
  codeUsable,
  generateCode,
  hashCode,
  isWellFormedCode,
  normalizeCode,
  resendAllowed,
  resendWaitSeconds,
  timingSafeEqual,
  verificationSmsText,
} from "../_shared/auth-verify.ts";

// ============================================================
// phone-verify — the in-app 6-digit SMS check that unlocks calling
// and texting for a new account.
//
// ---- Why an edge function --------------------------------------------------
//
// `public.agents` is owner-writable for profile fields, because the settings
// screen is a browser-side form. So if `phone_verified_at` were writable from
// a client, "verify your phone" would be one devtools UPDATE away from being
// optional — which is the entire thing it exists to prevent. Migration
// 20260804 adds `agents_protect_verification_columns`, and this function,
// running under the service role, is the only writer left.
//
// ---- What is stored --------------------------------------------------------
//
// A HASH and never the code. `phone_verifications` is a table support tooling
// can read and a backup can contain, and a plaintext 6-digit code sitting in
// a column next to the phone number it unlocks is a code that has already
// been shared. The salt is the row's own id — see hashCode().
//
// ---- The three bounds ------------------------------------------------------
//
//   * ~10 minutes to use it (codeExpiry)
//   * 5 wrong guesses and the code dies (CODE_MAX_ATTEMPTS)
//   * 45 seconds between sends (resendAllowed) — Resend is a button that
//     spends real money on a real carrier, and a hundred presses at one
//     handset is how a sending number gets reported.
//
// All three are enforced HERE, server-side. The browser mirrors them so it
// can say what is happening, and `auth-verify.test.ts` pins the two together.
//
// ---- The agent comes from the JWT -----------------------------------------
//
// There is no agent id in either request body. Same rule as leads-consent,
// statement-upload and voice-campaign-manage.
//
// Request:  { action: "send",  phone }
//           { action: "check", code }
//           { action: "status" }
// Response: { ok, … } or { error, detail }
// ============================================================

/**
 * Who the code is sent FROM.
 *
 * A verification code is transactional traffic to the ACCOUNT HOLDER, not
 * marketing to a consumer, and a brand-new signup has no number of their own
 * yet — so it cannot go out on the agent's 10DLC campaign. It goes from a
 * platform DID.
 *
 * 🔴 THE SENDER MUST BE ON A MESSAGING PROFILE. Telnyx refuses any other
 * `from` outright — 400, code 40305, "Invalid 'from' address" — and it does
 * so BEFORE queuing, so a wrong number here means every code silently fails
 * to send rather than arriving late. Of the nine DIDs on this account,
 * exactly one carries a messaging profile: +12029981783 (profile "Jarvis").
 * The shared caller ID +12029703699 does NOT, and was verified rejected.
 *
 * Override with PLATFORM_SMS_FROM when that changes — the env var is the
 * supported way to move this without a redeploy.
 *
 * NOTE FOR THE OWNER: this number has no 10DLC campaign attached
 * (messaging_campaign_id is null), so US carriers may filter A2P traffic
 * from it. Attaching it to a campaign is what makes delivery dependable.
 * Until then a send that Telnyx accepts can still be dropped downstream —
 * which is why the phone gate is a SOFT one with a "not now" escape, and why
 * every pre-existing account is grandfathered past it entirely.
 */
const PLATFORM_SMS_FROM_DEFAULT = "+12029981783";

Deno.serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY") || "";
  const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") || "";
  const PLATFORM_FROM = Deno.env.get("PLATFORM_SMS_FROM") || PLATFORM_SMS_FROM_DEFAULT;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  let body: { action?: unknown; phone?: unknown; code?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = typeof body.action === "string" ? body.action : "";

  /** The agent's row. Created lazily elsewhere, so a miss is not fatal. */
  const { data: agent } = await sb.from("agents")
    .select("id, phone_e164, phone_verified_at, email_verified_at")
    .eq("id", user.id)
    .maybeSingle();

  // ============================================================
  // status — what the gate should show, without sending anything
  // ============================================================
  if (action === "status") {
    const { data: last } = await sb.from("phone_verifications")
      .select("id, created_at, expires_at, attempts, max_attempts, consumed_at, phone_e164")
      .eq("agent_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastMs = last ? new Date(last.created_at).getTime() : null;
    return json({
      ok: true,
      phone_verified_at: agent?.phone_verified_at ?? null,
      phone_e164: agent?.phone_e164 ?? null,
      pending: last && !last.consumed_at && new Date(last.expires_at).getTime() > now
        ? { phone_e164: last.phone_e164, expires_at: last.expires_at, attempts_left: attemptsRemaining(last) }
        : null,
      resend_wait_seconds: resendWaitSeconds(lastMs, now),
    });
  }

  // ============================================================
  // send
  // ============================================================
  if (action === "send") {
    if (agent?.phone_verified_at) {
      return json({ ok: true, already_verified: true, phone_e164: agent.phone_e164 });
    }

    const raw = typeof body.phone === "string" ? body.phone : "";
    const phone = toE164(raw);
    if (!phone) {
      return json({
        error: "invalid_phone",
        detail: `"${raw}" is not a valid US mobile number. Enter the number of a phone you can read a text on.`,
      }, 400);
    }

    // Rate limit BEFORE minting anything, so a refused send does not also
    // burn the pending code the agent may still be about to type.
    const { data: prev } = await sb.from("phone_verifications")
      .select("created_at")
      .eq("agent_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastMs = prev ? new Date(prev.created_at).getTime() : null;
    if (!resendAllowed(lastMs, now)) {
      const wait = resendWaitSeconds(lastMs, now);
      return json({
        error: "too_soon",
        detail: `Wait ${wait} more second${wait === 1 ? "" : "s"} before sending another code.`,
        resend_wait_seconds: wait,
      }, 429);
    }

    if (!TELNYX_API_KEY) {
      return json({
        error: "sms_unavailable",
        detail: "Text messaging is not configured on this deployment, so a code cannot be sent. Contact support.",
      }, 503);
    }

    // The row is created FIRST, without a usable hash, because the hash is
    // salted with the row's own id and there is no id until it exists. It is
    // then filled in — and only then is the message sent, so a code can never
    // reach a handset before the thing that can check it exists.
    const { data: row, error: insErr } = await sb.from("phone_verifications")
      .insert({
        agent_id: user.id,
        phone_e164: phone,
        code_hash: "pending",
        expires_at: codeExpiry(now),
        max_attempts: CODE_MAX_ATTEMPTS,
      })
      .select("id")
      .maybeSingle();
    if (insErr || !row) {
      return json({ error: "verification_write_failed", detail: insErr?.message || "could not start verification" }, 500);
    }

    const code = generateCode();
    const digest = await hashCode(code, row.id);
    const { error: updErr } = await sb.from("phone_verifications")
      .update({ code_hash: digest }).eq("id", row.id);
    if (updErr) {
      return json({ error: "verification_write_failed", detail: updErr.message }, 500);
    }

    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { "Authorization": `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: PLATFORM_FROM,
        to: phone,
        text: verificationSmsText(code),
        ...(TELNYX_MSG_PROFILE_ID ? { messaging_profile_id: TELNYX_MSG_PROFILE_ID } : {}),
      }),
    });
    if (!res.ok) {
      const detailText = await res.text().catch(() => "");
      console.error("[phone-verify] Telnyx rejected the code send:", res.status, detailText);
      // Retire the row. Leaving a live code behind for a message that never
      // went out means the next legitimate send is blocked by the cooldown on
      // a code nobody can read.
      await sb.from("phone_verifications").update({ consumed_at: nowIso }).eq("id", row.id);
      return json({
        error: "send_failed",
        detail: "We could not send the code to that number. Check it is a mobile number that can receive texts, then try again.",
      }, 502);
    }

    // The number is recorded but NOT marked verified — that is what the code
    // is for. Written here so the gate can show which number is pending.
    await sb.from("agents").update({ phone_e164: phone }).eq("id", user.id);

    return json({
      ok: true, sent: true, phone_e164: phone,
      expires_at: codeExpiry(now), attempts_left: CODE_MAX_ATTEMPTS,
    });
  }

  // ============================================================
  // check
  // ============================================================
  if (action === "check") {
    if (agent?.phone_verified_at) {
      return json({ ok: true, already_verified: true, phone_e164: agent.phone_e164 });
    }

    const code = normalizeCode(body.code);
    if (!isWellFormedCode(code)) {
      // Not counted as an attempt: five typos should not cost a code.
      return json({ error: "bad_code_format", detail: "Enter the 6-digit code from the text." }, 400);
    }

    const { data: row } = await sb.from("phone_verifications")
      .select("id, code_hash, expires_at, attempts, max_attempts, consumed_at, phone_e164")
      .eq("agent_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Used / expired / exhausted is decided BEFORE the hash is computed, so
    // a dead code cannot be told apart from a wrong one by response timing.
    const usable = codeUsable(row, now);
    if (!usable.ok) return json({ error: usable.reason, detail: usable.detail }, 422);

    const digest = await hashCode(code, row!.id);
    if (!timingSafeEqual(digest, row!.code_hash)) {
      const attempts = (row!.attempts || 0) + 1;
      await sb.from("phone_verifications").update({ attempts }).eq("id", row!.id);
      const left = Math.max(0, (row!.max_attempts || CODE_MAX_ATTEMPTS) - attempts);
      return json({
        error: "wrong_code",
        detail: left > 0
          ? `That code is not right. ${left} tr${left === 1 ? "y" : "ies"} left.`
          : "That code is not right, and you are out of tries. Send a new code.",
        attempts_left: left,
      }, 422);
    }

    // Consume the code before granting, not after: if the grant fails the
    // agent retries with a fresh code, which is recoverable. A consumed flag
    // that never got written is a code that can be replayed, which is not.
    await sb.from("phone_verifications")
      .update({ consumed_at: nowIso, attempts: (row!.attempts || 0) + 1 })
      .eq("id", row!.id);

    const { error: grantErr } = await sb.from("agents")
      .update({ phone_verified_at: nowIso, phone_e164: row!.phone_e164 })
      .eq("id", user.id);
    if (grantErr) {
      return json({ error: "grant_failed", detail: grantErr.message }, 500);
    }

    return json({ ok: true, verified: true, phone_e164: row!.phone_e164, phone_verified_at: nowIso });
  }

  return json({ error: "unknown_action", detail: 'action must be "send", "check" or "status".' }, 400);
});
