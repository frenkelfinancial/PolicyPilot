// ============================================================
// supabase/functions/promo-email/index.ts
//
// Weekly promotional email targeting agents who have signed up
// but have no active Stripe subscription. Sends every Thursday
// at 10am ET via pg_cron (see 014_promo_email_cron.sql).
//
// Required secrets:
//   RESEND_API_KEY  — Resend API key
//   DIGEST_FROM     — "ProducerStackCRM <noreply@producerstackcrm.com>"
//   DASHBOARD_URL   — "https://producerstackcrm.com/"
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPromoEmail } from "./email.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendKey   = Deno.env.get("RESEND_API_KEY")!;
const fromAddr    = Deno.env.get("DIGEST_FROM") ?? "ProducerStackCRM <noreply@producerstackcrm.com>";
const siteUrl     = Deno.env.get("DASHBOARD_URL") ?? "https://producerstackcrm.com/";

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

Deno.serve(async (_req) => {
  if (!resendKey) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500 });
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // All agents without an active subscription who have an email address.
  const { data: agents, error } = await sb
    .from("agents")
    .select("id, email, display_name")
    .is("stripe_subscription_id", null)
    .not("email", "is", null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  if (!agents?.length) {
    return new Response(JSON.stringify({ sent: 0, message: "No non-subscribed agents found." }));
  }

  const results: { agentId: string; ok: boolean; error?: string; sentTo?: string }[] = [];

  for (const agent of agents) {
    try {
      const firstName = (agent.display_name || "").split(" ")[0] || "";
      const { subject, html, text } = buildPromoEmail({ firstName, siteUrl });
      const res = await sendEmail(agent.email, subject, html, text);
      results.push({ agentId: agent.id, ok: res.ok, error: res.error, sentTo: agent.email });
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
