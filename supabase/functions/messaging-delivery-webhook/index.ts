import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyTelnyxSignature, verifyResendSignature } from "../_shared/webhook-verify.ts";

// Delivery webhook for BOTH providers this project sends messages through:
//   - Telnyx (SMS/MMS): `telnyx-signature-ed25519` + `telnyx-timestamp` headers.
//   - Resend (email):   `svix-id` + `svix-timestamp` + `svix-signature` headers.
// Routes on which signature headers are present, verifies accordingly, then
// resolves the pending wallet_hold placed at send time:
//   delivered            -> wallet_settle (charge stands)
//   failed/undelivered   -> wallet_void   (net $0 — the headline promise)
// wallet_settle/wallet_void both raise 'not_a_pending_hold' if the ledger row
// already resolved — caught below and treated as an idempotent no-op, so a
// retried webhook delivery (either provider retries on non-2xx) can never
// double-settle or double-void the same hold.
//
// verify_jwt = false for this function (see supabase/config.toml) — neither
// Telnyx nor Resend can supply a Supabase-signed JWT; this function does its
// own signature verification instead.
Deno.serve(async (req) => {
  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_PUBLIC_KEY   = Deno.env.get("TELNYX_PUBLIC_KEY");
  const RESEND_WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");

  const rawBody = await req.text();
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const telnyxSig = req.headers.get("telnyx-signature-ed25519");
  const svixSig    = req.headers.get("svix-signature");

  async function resolveHold(
    messageId: string,
    outcome: "delivered" | "failed" | "undelivered",
    failedReason?: string,
  ) {
    const { data: msg } = await sb.from("messages")
      .select("id, hold_ledger_id, status")
      .eq("id", messageId)
      .maybeSingle();
    if (!msg) return { found: false };

    if (msg.hold_ledger_id) {
      const rpcName = outcome === "delivered" ? "wallet_settle" : "wallet_void";
      const { error } = await sb.rpc(rpcName, { p_ledger_id: msg.hold_ledger_id });
      if (error && !error.message?.includes("not_a_pending_hold")) {
        console.error(`[messaging-delivery-webhook] ${rpcName} failed:`, error.message);
        return { found: true, resolved: false, error: error.message };
      }
    }

    await sb.from("messages").update({
      status: outcome,
      delivered_at: outcome === "delivered" ? new Date().toISOString() : null,
      failed_reason: failedReason ?? null,
    }).eq("id", msg.id);

    return { found: true, resolved: true };
  }

  // ---------------- Telnyx (SMS/MMS) ----------------
  if (telnyxSig) {
    if (!TELNYX_PUBLIC_KEY) return new Response(JSON.stringify({ error: "telnyx_not_configured" }), { status: 500 });

    const ts = req.headers.get("telnyx-timestamp");
    if (!await verifyTelnyxSignature(rawBody, telnyxSig, ts, TELNYX_PUBLIC_KEY)) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
    }

    let payload: { data?: { event_type?: string; payload?: { id?: string; to?: { status?: string }[]; errors?: { detail?: string }[] } } };
    try { payload = JSON.parse(rawBody); } catch { return new Response(JSON.stringify({ ok: true }), { status: 200 }); }

    const eventType = payload?.data?.event_type;
    const p = payload?.data?.payload;
    if (!p?.id || eventType !== "message.finalized") {
      return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
    }

    const { data: msg } = await sb.from("messages")
      .select("id")
      .eq("provider_message_id", p.id)
      .maybeSingle();
    if (!msg) return new Response(JSON.stringify({ ok: true, ignored: "unknown_message" }), { status: 200 });

    const legStatus = p.to?.[0]?.status;
    if (legStatus === "delivered") {
      await resolveHold(msg.id, "delivered");
    } else if (legStatus === "delivery_failed" || legStatus === "sending_failed") {
      const reason = p.errors?.[0]?.detail || legStatus;
      await resolveHold(msg.id, "failed", reason);
    }
    // Any other in-flight status (queued/sending/sent) — no-op, wait for a
    // later message.finalized event or the timeout sweep.

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  // ---------------- Resend (email) ----------------
  if (svixSig) {
    if (!RESEND_WEBHOOK_SECRET) return new Response(JSON.stringify({ error: "resend_webhook_not_configured" }), { status: 500 });

    const svixId  = req.headers.get("svix-id");
    const svixTs  = req.headers.get("svix-timestamp");
    if (!await verifyResendSignature(rawBody, svixId, svixTs, svixSig, RESEND_WEBHOOK_SECRET)) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
    }

    let payload: { type?: string; data?: { email_id?: string; bounce?: { message?: string } } };
    try { payload = JSON.parse(rawBody); } catch { return new Response(JSON.stringify({ ok: true }), { status: 200 }); }

    const eventType = payload?.type;
    const emailId   = payload?.data?.email_id;
    if (!emailId) return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });

    const { data: msg } = await sb.from("messages")
      .select("id")
      .eq("provider_message_id", emailId)
      .maybeSingle();
    if (!msg) return new Response(JSON.stringify({ ok: true, ignored: "unknown_message" }), { status: 200 });

    if (eventType === "email.delivered" || eventType === "email.complained") {
      // A complaint still means the email reached the inbox — the delivery
      // promise (and the charge) stands; a spam complaint is not the same
      // as an undelivered send.
      await resolveHold(msg.id, "delivered");
    } else if (eventType === "email.bounced") {
      await resolveHold(msg.id, "failed", payload?.data?.bounce?.message || "bounced");
    }
    // email.sent / email.delivery_delayed — intermediate, no-op; the
    // timeout sweep voids it if no terminal event ever arrives.

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: "unknown_provider" }), { status: 400 });
});
