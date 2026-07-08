// ============================================================
// supabase/functions/monthly-summary/index.ts          [DEPLOY PACKAGE]
//
// Wrapper for the 1st / 15th account-summary emails.
// Written by Cowork against TEST DATA — deploy via Claude Code.
//
// Trigger: pg_cron fires net.http_post at BOTH 14:00 and 15:00 UTC
// on the 1st and 15th (see data/sql/015_summary_emails.sql). This
// function only proceeds when it is exactly 9am America/Chicago —
// so one of the two firings runs and the other no-ops. True 9am
// Central year-round, DST-aware, no naive Date math.
//
// Skip logic (per agent, stated explicitly):
//   SKIP if summary_emails_enabled = false          (opt-out toggle)
//   SKIP if plan_id IS NULL                         (no granted access)
//   → gate is GRANTED ACCESS (plan_id set), never "a Stripe payment
//     exists" — $0 / 100%-discount agents with manually granted
//     plan_id ARE included. stripe_subscription_id is NOT checked.
//
// Required secrets:
//   RESEND_API_KEY        — NEW Resend account API key
//   DIGEST_FROM           — e.g. "PolicyPilot <REPLACE_ME@reports.frenkelfinancial.com>"
//                           (single config value; change any time, no code edits)
//   DASHBOARD_URL         — e.g. "https://yourapp.com/app.html"
//   SUMMARY_UNSUB_SECRET  — random 32+ char string for unsubscribe HMAC tokens
//   SUMMARY_UNSUB_URL     — public URL of the summary-unsubscribe function
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Manual testing:
//   POST {"force":true,"kind":"monthly","dry_run":true}   — bypass 9am guard,
//   render without sending. "to_override":"me@x.com" sends all mail to you.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { gatherSummary, chicagoParts, type AgentRow, type SummaryKind } from "./gather.ts";
import { buildSummaryEmail } from "./email.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendKey   = Deno.env.get("RESEND_API_KEY") ?? "";
const fromAddr    = Deno.env.get("DIGEST_FROM") ?? "";
const dashboard   = Deno.env.get("DASHBOARD_URL") ?? "https://example.com/app.html";
const unsubSecret = Deno.env.get("SUMMARY_UNSUB_SECRET") ?? "";
const unsubBase   = Deno.env.get("SUMMARY_UNSUB_URL") ?? "";

// ---- unsubscribe token (HMAC-SHA256, opaque, not a guessable id) -------------

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export async function makeUnsubToken(agentId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(agentId));
  return `${b64url(new TextEncoder().encode(agentId))}.${b64url(sig)}`;
}

// ---- Resend (same pattern as weekly-digest, + one-click unsubscribe headers) --

async function sendEmail(
  to: string, subject: string, html: string, text: string, unsubUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromAddr, to, subject, html, text,
      headers: {
        // RFC 8058 one-click unsubscribe — Gmail/Apple render a native link.
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
  return { ok: true };
}

// ---- main ---------------------------------------------------------------------

Deno.serve(async (req) => {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron posts empty body */ }
  const force      = body.force === true;
  const dryRun     = body.dry_run === true;
  const toOverride = typeof body.to_override === "string" ? body.to_override : null;

  if (!resendKey && !dryRun) {
    return json({ error: "RESEND_API_KEY not configured" }, 500);
  }
  if (!fromAddr && !dryRun) {
    return json({ error: "DIGEST_FROM not configured" }, 500);
  }
  if (!unsubSecret) {
    return json({ error: "SUMMARY_UNSUB_SECRET not configured" }, 500);
  }

  const now = new Date();
  const chi = chicagoParts(now);

  // DST guard: only run at true 9am Central (cron fires 14:00 & 15:00 UTC).
  if (!force && chi.hour !== 9) {
    return json({ skipped: true, reason: `Chicago hour is ${chi.hour}, not 9 — other cron slot will run.` });
  }

  // Which email? 1st → last month's report card; 15th → mid-month pace check.
  let kind: SummaryKind;
  if (body.kind === "monthly" || body.kind === "midmonth") {
    kind = body.kind;
  } else if (chi.d === 1) {
    kind = "monthly";
  } else if (chi.d === 15) {
    kind = "midmonth";
  } else {
    return json({ skipped: true, reason: `Chicago date is the ${chi.d}; runs only on the 1st and 15th.` });
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Recipients: summaries ON + granted plan access (plan_id set — includes
  // $0-discount agents; NEVER gated on Stripe payment/subscription columns).
  const { data: agents, error: agentsErr } = await sb
    .from("agents")
    .select("id, email, display_name, digest_email, monthly_goal, contract_level, plan_id, plans:plan_id ( slug )")
    .eq("summary_emails_enabled", true)
    .not("plan_id", "is", null);

  if (agentsErr) return json({ error: agentsErr.message }, 500);
  if (!agents?.length) return json({ sent: 0, message: "No eligible agents." });

  const results: { agentId: string; ok: boolean; error?: string; sentTo?: string; subject?: string }[] = [];

  for (const a of agents) {
    try {
      const recipient = toOverride || a.digest_email || a.email;
      if (!recipient) { results.push({ agentId: a.id, ok: false, error: "no recipient email" }); continue; }

      const slugRaw = (a as { plans?: { slug?: string } | { slug?: string }[] }).plans;
      const slug = (Array.isArray(slugRaw) ? slugRaw[0]?.slug : slugRaw?.slug) ?? "basic";
      const tier = (["basic", "pro", "max"].includes(slug) ? slug : "basic") as AgentRow["plan_slug"];

      const agentRow: AgentRow = {
        id: a.id, email: a.email, display_name: a.display_name,
        digest_email: a.digest_email, monthly_goal: a.monthly_goal,
        contract_level: a.contract_level, plan_slug: tier,
      };

      const data = await gatherSummary(sb, agentRow, kind, now);

      const token = await makeUnsubToken(a.id, unsubSecret);
      const unsubUrl = `${unsubBase}?token=${token}`;
      const { subject, html, text } = buildSummaryEmail(data, {
        dashboardUrl: dashboard,
        unsubscribeUrl: unsubUrl,
        prefsUrl: `${dashboard}#settings`,
      });

      if (dryRun) { results.push({ agentId: a.id, ok: true, sentTo: "(dry run)", subject }); continue; }

      const sendRes = await sendEmail(recipient, subject, html, text, unsubUrl);
      results.push({ agentId: a.id, ok: sendRes.ok, error: sendRes.error, sentTo: recipient, subject });
      await new Promise(r => setTimeout(r, 300)); // Resend 5 req/s limit
    } catch (e) {
      results.push({ agentId: a.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return json({ kind, sent: results.filter(r => r.ok).length, total: agents.length, results });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { "Content-Type": "application/json" },
  });
}
