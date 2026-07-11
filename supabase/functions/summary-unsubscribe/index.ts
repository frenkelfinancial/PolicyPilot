// ============================================================
// supabase/functions/summary-unsubscribe/index.ts       [DEPLOY PACKAGE]
//
// Token-based one-click unsubscribe for the account-summary emails.
// No login required. Sets agents.summary_emails_enabled = false for
// the agent encoded in the signed token. Idempotent.
//
//   GET  ?token=…  — human clicked the footer link → confirmation page
//   POST ?token=…  — RFC 8058 One-Click (Gmail/Apple native button)
//
// Token = base64url(agentId) + "." + base64url(HMAC-SHA256(agentId))
// keyed with SUMMARY_UNSUB_SECRET. Opaque and unforgeable — not a
// guessable agent id.
//
// Deploy with --no-verify-jwt (recipients are not logged in):
//   supabase functions deploy summary-unsubscribe --no-verify-jwt
//
// Secrets: SUMMARY_UNSUB_SECRET (same value as monthly-summary).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const unsubSecret = Deno.env.get("SUMMARY_UNSUB_SECRET") ?? "";

const dec = (s: string) => {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

async function verifyToken(token: string): Promise<string | null> {
  const [idPart, sigPart] = token.split(".");
  if (!idPart || !sigPart) return null;
  const agentId = new TextDecoder().decode(dec(idPart));
  if (!/^[0-9a-f-]{36}$/.test(agentId)) return null;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(unsubSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(agentId)));
  // constant-time-ish comparison
  if (expected.length !== sigPart.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigPart.charCodeAt(i);
  return diff === 0 ? agentId : null;
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#eef2f8;font-family:-apple-system,'Segoe UI',sans-serif;color:#1d2b45">
<div style="max-width:440px;margin:80px auto;background:#fff;border-radius:16px;padding:40px 36px;text-align:center;box-shadow:0 12px 40px -16px rgba(19,38,68,.25)">
<div style="font-size:18px;font-weight:800;color:#132644;margin-bottom:14px">Producer<span style="color:#5b9bd5">Stack</span></div>
<h1 style="font-size:20px;margin:0 0 10px;color:#132644">${title}</h1>
<p style="font-size:14px;line-height:1.6;color:#6b7890;margin:0">${body}</p>
</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  if (!unsubSecret) return page("Configuration error", "Unsubscribe is not configured.", 500);

  const token = new URL(req.url).searchParams.get("token") ?? "";
  const agentId = token ? await verifyToken(token) : null;
  if (!agentId) return page("Link not valid", "This unsubscribe link is invalid or incomplete. You can also turn summaries off in the Summary tab of your dashboard.", 400);

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { error } = await sb
    .from("agents")
    .update({ summary_emails_enabled: false })
    .eq("id", agentId);

  if (error) return page("Something went wrong", "We couldn't update your preferences. Please try again, or toggle summaries off in your dashboard.", 500);

  if (req.method === "POST") {
    // RFC 8058 one-click — mail clients expect a plain 200.
    return new Response("OK", { status: 200 });
  }
  return page(
    "You're unsubscribed",
    "You'll no longer receive account-summary emails. You can turn them back on any time from the Summary tab in Producer Stack.",
  );
});
