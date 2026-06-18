// ============================================================
// supabase/functions/weekly-digest/index.ts
//
// Sends each opted-in agent a weekly performance email every
// Monday covering last week's results and current-month pace
// toward their monthly AP goal.
//
// Trigger: pg_cron every Monday 09:00 UTC (see 013_weekly_digest.sql)
// or any HTTP POST to the function URL.
//
// Required secrets (set with `supabase secrets set`):
//   RESEND_API_KEY  — Resend API key
//   DIGEST_FROM     — "PolicyPilot <digest@yourdomain.com>"
//   DASHBOARD_URL   — e.g. "https://your-app.com/index-3.html"
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildWeeklyEmail } from "./email.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendKey   = Deno.env.get("RESEND_API_KEY")!;
const fromAddr    = Deno.env.get("DIGEST_FROM") ?? "PolicyPilot <onboarding@resend.dev>";
const dashboard   = Deno.env.get("DASHBOARD_URL") ?? "https://your-app.example.com/index-3.html";

const DEFAULT_GOAL = 50_000;

// ---- date helpers -----------------------------------------------------------

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Returns Monday and Sunday of the calendar week that just ended.
// Called on Monday mornings, so "last week" = the 7 days that ended yesterday.
function lastWeekRange(today: Date): { start: string; end: string } {
  const sun = new Date(today);
  sun.setDate(today.getDate() - 1);           // yesterday = last Sunday
  const mon = new Date(sun);
  mon.setDate(sun.getDate() - 6);             // six days before = last Monday
  return { start: ymd(mon), end: ymd(sun) };
}

// Returns the first and last day of the current calendar month.
function monthRange(today: Date): { start: string; end: string } {
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const last  = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return { start: ymd(first), end: ymd(last) };
}

// ---- stats ------------------------------------------------------------------

interface Policy {
  ap: number;
  draft: string;
  carrier: string;
  status: string;
  client: string;
}

function sumAP(policies: Policy[]): number {
  return policies.reduce((s, p) => s + (Number(p.ap) || 0), 0);
}

function inRange(p: Policy, start: string, end: string): boolean {
  return !!p.draft && p.draft >= start && p.draft <= end;
}

function topCarrier(policies: Policy[]): { name: string; ap: number; count: number } | null {
  const totals: Record<string, { ap: number; count: number }> = {};
  for (const p of policies) {
    const k = p.carrier || "—";
    if (!totals[k]) totals[k] = { ap: 0, count: 0 };
    totals[k].ap    += Number(p.ap) || 0;
    totals[k].count += 1;
  }
  const ranked = Object.entries(totals).sort((a, b) => b[1].ap - a[1].ap);
  if (!ranked.length) return null;
  return { name: ranked[0][0], ...ranked[0][1] };
}

// ---- Resend -----------------------------------------------------------------

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

// ---- main -------------------------------------------------------------------

Deno.serve(async (_req) => {
  if (!resendKey) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500 });
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const today = new Date();
  const week  = lastWeekRange(today);
  const month = monthRange(today);

  const daysElapsed = today.getDate();
  const daysTotal   = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysLeft    = Math.max(0, daysTotal - daysElapsed);

  // 1. All opted-in agents
  const { data: agents, error: agentsErr } = await sb
    .from("agents")
    .select("id, email, display_name, digest_email, monthly_goal")
    .eq("digest_enabled", true);

  if (agentsErr) {
    return new Response(JSON.stringify({ error: agentsErr.message }), { status: 500 });
  }
  if (!agents?.length) {
    return new Response(JSON.stringify({ sent: 0, message: "No opted-in agents." }));
  }

  const results: { agentId: string; ok: boolean; error?: string; sentTo?: string }[] = [];

  for (const agent of agents) {
    try {
      const recipient = agent.digest_email || agent.email;
      if (!recipient) {
        results.push({ agentId: agent.id, ok: false, error: "no recipient email" });
        continue;
      }

      // 2. Load this agent's policies
      const { data: rows, error: polErr } = await sb
        .from("policies")
        .select("data")
        .eq("agent_id", agent.id);

      if (polErr) {
        results.push({ agentId: agent.id, ok: false, error: polErr.message });
        continue;
      }

      const policies: Policy[] = (rows || []).map((r: any) => r.data || {});

      // 3. Compute stats
      const weekPols  = policies.filter(p => inRange(p, week.start, week.end));
      const monthPols = policies.filter(p => inRange(p, month.start, month.end));

      const weekCount  = weekPols.length;
      const weekAP     = sumAP(weekPols);
      const monthCount = monthPols.length;
      const monthAP    = sumAP(monthPols);

      const goal       = Number(agent.monthly_goal) || DEFAULT_GOAL;
      const goalPct    = goal > 0 ? Math.min(monthAP / goal, 1) : 0;
      const avgPerDay  = daysElapsed > 0 ? monthAP / daysElapsed : 0;
      const projected  = avgPerDay * daysTotal;
      const needPerDay = daysLeft > 0 ? Math.max(0, goal - monthAP) / daysLeft : 0;

      const paceStatus: "ahead" | "on" | "behind" =
        projected >= goal * 1.05 ? "ahead" :
        projected >= goal * 0.9  ? "on"    : "behind";

      const topCarrierWeek = topCarrier(weekPols);

      const firstName = (agent.display_name || "").split(" ")[0] || "";

      const { subject, html, text } = buildWeeklyEmail({
        firstName,
        weekStart:     week.start,
        weekEnd:       week.end,
        weekCount,
        weekAP,
        monthCount,
        monthAP,
        goal,
        goalPct,
        avgPerDay,
        projected,
        needPerDay,
        daysLeft,
        paceStatus,
        topCarrierWeek,
        dashboardUrl:  dashboard,
      });

      const sendRes = await sendEmail(recipient, subject, html, text);
      results.push({ agentId: agent.id, ok: sendRes.ok, error: sendRes.error, sentTo: recipient });
      await new Promise(r => setTimeout(r, 300)); // stay under Resend's 5 req/s limit
    } catch (e: any) {
      results.push({ agentId: agent.id, ok: false, error: e?.message || String(e) });
    }
  }

  const successCount = results.filter(r => r.ok).length;
  return new Response(
    JSON.stringify({ sent: successCount, total: agents.length, results }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
