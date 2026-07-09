// ============================================================
// supabase/functions/wallet-low-balance-notify/index.ts
//
// Sends "your balance is too low" emails. Two modes:
//
//   1. Ongoing (default, no body / { migration: false }): scans
//      wallet_accounts for agents who have crossed BELOW
//      billing_config.low_balance_threshold_mills and haven't been
//      notified yet (low_balance_notified_at is null), emails them, and
//      stamps low_balance_notified_at so it doesn't repeat-spam. Any
//      agent who has since topped back up above the threshold gets
//      low_balance_notified_at cleared, so a future dip re-triggers.
//      Trigger this on a schedule (e.g. hourly via pg_cron) — see the
//      cron.schedule(...) comment at the bottom of this file's deploy
//      notes.
//
//   2. One-time migration blast ({ migration: true }): ignores the
//      "already notified" debounce and emails EVERY agent currently
//      below threshold (used once, right when existing customers drop
//      to $0 during the wallet migration). Still stamps
//      low_balance_notified_at afterward so ongoing debounce continues
//      correctly from that point on.
//
// Required secrets (already configured on this project):
//   RESEND_API_KEY  — Resend API key
//   DIGEST_FROM     — from-address, e.g. "PolicyPilot <digest@yourdomain.com>"
//   APP_URL         — e.g. "https://producerstackcrm.com" (for the top-up link)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// This function performs REAL sends whenever RESEND_API_KEY is
// configured — there is no separate "dry run" flag. Don't invoke it
// against production data without confirming who it will email first
// (call with { migration:false, dry_run:true } to preview the recipient
// list with no sends).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendKey   = Deno.env.get("RESEND_API_KEY");
const fromAddr    = Deno.env.get("DIGEST_FROM") ?? "PolicyPilot <onboarding@resend.dev>";
const appUrl      = Deno.env.get("APP_URL") ?? "https://producerstackcrm.com";

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromAddr, to, subject, html, text }),
  });
  if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
  return { ok: true };
}

function buildEmail(firstName: string, balanceMills: number, topUpUrl: string) {
  const balanceStr = `$${(balanceMills / 1000).toFixed(2)}`;
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const subject = balanceMills <= 0
    ? "Your PolicyPilot wallet is empty — add funds to keep calling"
    : "Your PolicyPilot wallet balance is low";

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
      <p>${greeting}</p>
      <p>Your PolicyPilot wallet balance is <strong>${balanceStr}</strong>. Calls, texts, and phone number
      renewals all draw from this balance — once it runs out, those stop working until you add funds.</p>
      <p style="margin:24px 0">
        <a href="${topUpUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Add funds now</a>
      </p>
      <p style="font-size:13px;color:#666">Your balance never expires — add exactly what you need, whenever you need it.</p>
    </div>
  `;
  const text = `${greeting}\n\nYour PolicyPilot wallet balance is ${balanceStr}. Calls, texts, and phone number renewals all draw from this balance — add funds to keep them running: ${topUpUrl}`;

  return { subject, html, text };
}

Deno.serve(async (req) => {
  // Server-only — this sends real emails (and the dry_run mode reveals
  // which agents are low on funds), so it must never be callable with
  // just the public anon key. Authenticated with a dedicated
  // WALLET_CRON_SECRET (not the service role key) rather than requiring
  // the all-powerful service role credential in a cron job's header.
  const cronSecret = Deno.env.get("WALLET_CRON_SECRET");
  const authHeader  = req.headers.get("Authorization") || "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let body: { migration?: boolean; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* no body is fine, defaults apply */ }
  const isMigration = body.migration === true;
  const dryRun      = body.dry_run === true;

  const { data: config } = await sb.from("billing_config")
    .select("low_balance_threshold_mills")
    .eq("id", 1)
    .maybeSingle();
  const thresholdMills = config?.low_balance_threshold_mills ?? 5000;

  // Recovered agents: balance is healthy again but still flagged notified
  // — clear the flag so a future dip re-triggers a fresh email.
  if (!dryRun) {
    await sb.from("wallet_accounts")
      .update({ low_balance_notified_at: null })
      .gte("balance_mills", thresholdMills)
      .not("low_balance_notified_at", "is", null);
  }

  // Candidates: below threshold, and (migration blast OR never notified).
  let query = sb.from("wallet_accounts")
    .select("agent_id, balance_mills, low_balance_notified_at")
    .lt("balance_mills", thresholdMills);
  if (!isMigration) query = query.is("low_balance_notified_at", null);

  const { data: candidates, error: candErr } = await query;
  if (candErr) {
    return new Response(JSON.stringify({ error: candErr.message }), { status: 500 });
  }
  if (!candidates?.length) {
    return new Response(JSON.stringify({ sent: 0, message: "No agents below threshold need notifying." }));
  }

  const agentIds = candidates.map(c => c.agent_id);
  const { data: agents, error: agentsErr } = await sb.from("agents")
    .select("id, email, display_name")
    .in("id", agentIds)
    .not("email", "is", null);
  if (agentsErr) {
    return new Response(JSON.stringify({ error: agentsErr.message }), { status: 500 });
  }
  const agentById = new Map((agents || []).map(a => [a.id, a]));

  if (dryRun) {
    return new Response(JSON.stringify({
      dry_run: true,
      threshold_mills: thresholdMills,
      would_notify: candidates.map(c => ({
        agent_id: c.agent_id,
        email: agentById.get(c.agent_id)?.email ?? null,
        balance_mills: c.balance_mills,
      })),
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (!resendKey) {
    return new Response(JSON.stringify({
      error: "RESEND_API_KEY not configured",
      would_have_notified: candidates.length,
    }), { status: 500 });
  }

  const topUpUrl = `${appUrl}/app.html?tab=phonebook`;
  const results: { agentId: string; ok: boolean; error?: string; sentTo?: string }[] = [];

  for (const c of candidates) {
    const agent = agentById.get(c.agent_id);
    if (!agent?.email) continue;
    try {
      const firstName = (agent.display_name || "").split(" ")[0] || "";
      const { subject, html, text } = buildEmail(firstName, c.balance_mills, topUpUrl);
      const res = await sendEmail(agent.email, subject, html, text);
      results.push({ agentId: c.agent_id, ok: res.ok, error: res.error, sentTo: agent.email });
      if (res.ok) {
        await sb.from("wallet_accounts")
          .update({ low_balance_notified_at: new Date().toISOString() })
          .eq("agent_id", c.agent_id);
      }
      await new Promise(r => setTimeout(r, 300)); // stay under Resend's 5 req/s limit
    } catch (e) {
      results.push({ agentId: c.agent_id, ok: false, error: (e as Error)?.message || String(e) });
    }
  }

  const successCount = results.filter(r => r.ok).length;
  return new Response(
    JSON.stringify({ sent: successCount, total: candidates.length, migration: isMigration, results }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
