import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runComplianceGate, bodyPreview } from "../_shared/messaging-shared.ts";
import { corsHeaders } from "../_shared/cors.ts";

/** Parses "Name <local@domain>" or a bare "local@domain" into its parts. */
function parseFromAddress(raw: string): { display: string; local: string; domain: string } | null {
  const angleMatch = raw.match(/^(.*)<([^@>]+)@([^>]+)>\s*$/);
  if (angleMatch) {
    return { display: angleMatch[1].trim(), local: angleMatch[2], domain: angleMatch[3] };
  }
  const bareMatch = raw.match(/^([^@\s]+)@(\S+)$/);
  if (bareMatch) return { display: "", local: bareMatch[1], domain: bareMatch[2] };
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Authorize-then-capture outbound email — sends from the AGENT'S verified
// domain (agents.outbound_email_from, never hardcoded), appends their
// signature, and sets a Reply-To alias that plus-addressing encodes this
// messages.id into (agent+r-<id>@domain) so messaging-email-inbound-webhook
// can log a reply back to this exact conversation without depending on the
// recipient's mail client preserving In-Reply-To/References headers.
serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

  if (!RESEND_API_KEY) return json({ error: "resend_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { to?: unknown; subject?: unknown; body?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const toRaw   = typeof body.to === "string" ? body.to.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  const text     = typeof body.body === "string" ? body.body : "";
  if (!toRaw || !subject || !text) return json({ error: "to_subject_and_body_required" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- Phase 2 re-scope (PROMPT_07): email is built but deferred. This
  //     kill switch is checked before the compliance gate/wallet so a
  //     disabled agent never gets as far as a hold — see
  //     billing_config.email_enabled in 020_texting_broadcasts.sql. ---
  const { data: billingConfigGate } = await sb.from("billing_config")
    .select("email_enabled")
    .eq("id", 1)
    .maybeSingle();
  if (!billingConfigGate?.email_enabled) {
    return json({ error: "email_disabled", detail: "Outbound email is not enabled yet — mass texting is the current Phase 2 channel." }, 503);
  }

  // --- Compliance gate: charge nothing on any failure here. Normalizes
  //     toRaw (trim + lowercase) internally — `to` below is always that
  //     canonical form, agreeing with consent_records/dnc_list on what
  //     "this recipient" means. ---
  const gate = await runComplianceGate(sb, user.id, "email", toRaw);
  if (!gate.ok) return json({ error: gate.reason, detail: gate.detail }, 403);
  const to = gate.normalizedAddress;

  // --- Sender identity: config/secret-driven, never hardcoded. ---
  const { data: agent } = await sb.from("agents")
    .select("outbound_email_from, outbound_email_signature, display_name")
    .eq("id", user.id)
    .maybeSingle();

  const fromRaw = agent?.outbound_email_from;
  if (!fromRaw) {
    return json({ error: "sender_not_configured", detail: "No verified outbound email sender configured for this agent." }, 400);
  }
  const parsedFrom = parseFromAddress(fromRaw);
  if (!parsedFrom) {
    return json({ error: "sender_not_configured", detail: "agents.outbound_email_from is not a valid address." }, 400);
  }

  // --- Cost + hold (flat per-send rate). ---
  const { data: billingConfig } = await sb.from("billing_config")
    .select("email_mills")
    .eq("id", 1)
    .maybeSingle();
  const amountMills = billingConfig?.email_mills ?? 1;

  const { data: messageRow, error: insertErr } = await sb.from("messages").insert({
    agent_id:            user.id,
    channel:             "email",
    to_address:          to,
    from_email:          fromRaw,
    subject,
    body_preview:        bodyPreview(text),
    status:              "queued",
    consent_id:          gate.consentId,
  }).select("id").single();

  if (insertErr || !messageRow) {
    return json({ error: "db_insert_failed", detail: insertErr?.message }, 500);
  }

  const { data: holdLedgerId, error: holdErr } = await sb.rpc("wallet_hold", {
    p_agent:        user.id,
    p_category:     "email",
    p_units:        1,
    p_amount_mills: amountMills,
    p_ref_type:     "message",
    p_ref_id:       messageRow.id,
    p_desc:         `Email to ${to} — $${(amountMills / 1000).toFixed(3)}`,
  });

  if (holdErr) {
    const reason = holdErr.message?.includes("insufficient_balance") ? "insufficient_balance" : "hold_failed";
    await sb.from("messages").update({ status: "failed", failed_reason: reason }).eq("id", messageRow.id);
    if (reason === "insufficient_balance") {
      return json({ error: "insufficient_balance", detail: "Insufficient wallet balance — top up to send this email." }, 402);
    }
    return json({ error: "hold_failed", detail: holdErr.message }, 500);
  }

  await sb.from("messages").update({ hold_ledger_id: holdLedgerId }).eq("id", messageRow.id);

  const messageIdHeader = `<msg-${messageRow.id}@${parsedFrom.domain}>`;
  const replyToAddress  = `${parsedFrom.local}+r-${messageRow.id}@${parsedFrom.domain}`;
  await sb.from("messages").update({ message_id_header: messageIdHeader }).eq("id", messageRow.id);

  const signature = agent?.outbound_email_signature || "";
  const textWithSig = signature ? `${text}\n\n--\n${signature}` : text;
  const htmlWithSig = `<div>${escapeHtml(text).replace(/\n/g, "<br>")}</div>` +
    (signature ? `<div style="margin-top:16px;color:#555">${escapeHtml(signature).replace(/\n/g, "<br>")}</div>` : "");

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:     fromRaw,
      to,
      reply_to: replyToAddress,
      subject,
      html:     htmlWithSig,
      text:     textWithSig,
      headers: {
        "Message-ID": messageIdHeader,
      },
    }),
  });

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    await sb.rpc("wallet_void", { p_ledger_id: holdLedgerId });
    await sb.from("messages").update({
      status: "failed",
      failed_reason: `resend_rejected: ${resendRes.status} ${errText}`,
    }).eq("id", messageRow.id);
    return json({ error: "send_failed", detail: errText }, 502);
  }

  const resendData = await resendRes.json();
  const providerMessageId = resendData?.id ?? null;

  await sb.from("messages").update({
    status: "sent",
    provider_message_id: providerMessageId,
  }).eq("id", messageRow.id);

  return json({
    ok: true,
    message_id: messageRow.id,
    provider_message_id: providerMessageId,
    hold_id: holdLedgerId,
    amount_mills: amountMills,
  });
});
