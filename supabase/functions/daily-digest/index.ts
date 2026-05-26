// ============================================================
// supabase/functions/daily-digest/index.ts
//
// Book Intelligence #3 — Daily digest.
//
// Iterates every agent with `digest_enabled = true`, loads their policies,
// runs the scoring kernel, and emails them the top 3 OPEN/AWAITING
// opportunities via Resend.
//
// Trigger: pg_cron once per day (see ../../../data/sql/005_digest_cron.sql)
// or any external scheduler that hits the function URL.
//
// Required secrets (set with `supabase secrets set`):
//   - RESEND_API_KEY   API key from https://resend.com
//   - DIGEST_FROM      "PolicyPilot <digest@yourdomain.com>" (verified domain)
//   - DASHBOARD_URL    e.g. "https://your-deployment.example.com/index-3.html"
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scoreBook } from "../_shared/scoring.ts";
import { buildDigestEmail } from "./email.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendKey  = Deno.env.get("RESEND_API_KEY")!;
const fromAddr   = Deno.env.get("DIGEST_FROM") ?? "PolicyPilot <onboarding@resend.dev>";
const dashboard  = Deno.env.get("DASHBOARD_URL") ?? "https://your-deployment.example.com/index-3.html";

const TOP_N = 3;

async function sendViaResend(to: string, subject: string, html: string, text: string): Promise<{ ok: boolean; error?: string }> {
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

Deno.serve(async (_req) => {
  if (!resendKey) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500 });
  }
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // 1. Find every opted-in agent.
  const { data: agents, error: agentsErr } = await sb
    .from("agents")
    .select("id, email, display_name, digest_email")
    .eq("digest_enabled", true);
  if (agentsErr) {
    return new Response(JSON.stringify({ error: agentsErr.message }), { status: 500 });
  }
  if (!agents || !agents.length) {
    return new Response(JSON.stringify({ sent: 0, message: "No opted-in agents." }), { status: 200 });
  }

  const results: { agentId: string; ok: boolean; error?: string; sentTo?: string; count?: number }[] = [];

  // 2. For each agent, load policies → score → email.
  for (const agent of agents) {
    try {
      const recipient = agent.digest_email || agent.email;
      if (!recipient) { results.push({ agentId: agent.id, ok: false, error: "no recipient email" }); continue; }

      const { data: rows, error: polErr } = await sb
        .from("policies")
        .select("data")
        .eq("agent_id", agent.id);
      if (polErr) { results.push({ agentId: agent.id, ok: false, error: polErr.message }); continue; }

      const policies = (rows || []).map((r: any) => r.data || {});
      const scored = scoreBook(policies);

      // Top N filtered to OPEN / AWAITING (skip stalled/dismissed/won/lost
      // are already filtered out by scoreBook based on opportunity.status).
      const top = scored.slice(0, TOP_N);
      const totalAv = scored.reduce((s, o) => s + (o.estCommission || 0), 0);
      const totalOpen = scored.length;

      // No opportunities and no clean-book celebration? Skip to keep inbox empty.
      // (Send when there's something to say.)
      if (top.length === 0 && totalOpen === 0) {
        results.push({ agentId: agent.id, ok: true, sentTo: recipient, count: 0 });
        continue;
      }

      const { subject, html, text } = buildDigestEmail({
        agentName: (agent.display_name || "").split(" ")[0] || "",
        top, totalAv, totalOpen, dashboardUrl: dashboard,
      });
      const sendRes = await sendViaResend(recipient, subject, html, text);
      results.push({
        agentId: agent.id,
        ok: sendRes.ok,
        error: sendRes.error,
        sentTo: recipient,
        count: top.length,
      });
    } catch (e: any) {
      results.push({ agentId: agent.id, ok: false, error: e?.message || String(e) });
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  return new Response(JSON.stringify({ sent: successCount, total: agents.length, results }, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
