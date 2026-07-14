// ============================================================
// supabase/functions/support-ticket/index.ts
//
// Receives support / feedback submissions from the in-app widget
// (bottom-right button in app.html), stores them in
// public.support_tickets, and emails a notification to the founder.
//
// Flow:
//   1. Browser calls sb.functions.invoke('support-ticket', { body })
//      with the user's JWT attached automatically by supabase-js.
//   2. We verify the JWT with the anon client (getUser), so tickets
//      are always tied to a real authenticated agent.
//   3. Insert via service-role client (RLS allows no client writes).
//   4. Fire-and-forget a Resend email to SUPPORT_NOTIFY_TO. Email
//      failure does NOT fail the request — the ticket is already
//      saved; we log and move on.
//
// Body shape (validated server-side, mirrors the widget form):
//   {
//     type:    'bug' | 'feature' | 'feedback' | 'question',
//     subject: string (1..200),
//     message: string (1..5000),
//     context: { view?, url?, user_agent?, viewport?, app_version? }
//   }
//
// Required secrets (RESEND_API_KEY + DIGEST_FROM already exist and
// are live — reuse, don't rotate):
//   RESEND_API_KEY     — Resend API key
//   DIGEST_FROM        — verified from-address, e.g. "Producer Stack <digest@...>"
//   SUPPORT_NOTIFY_TO  — where ticket notifications go (founder inbox)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically.
//
// Deploy: supabase functions deploy support-ticket
// (JWT verification stays ON — this is only ever called by logged-in
// users from the app.)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendKey   = Deno.env.get("RESEND_API_KEY");
const fromAddr    = Deno.env.get("DIGEST_FROM");
const notifyTo    = Deno.env.get("SUPPORT_NOTIFY_TO");

const VALID_TYPES = new Set(["bug", "feature", "feedback", "question"]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, "Content-Type": "application/json" },
    });

  try {
    // ── 1. Who is calling? ─────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) return json({ error: "Not authenticated" }, 401);

    // ── 2. Validate the payload ────────────────────────────────
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Invalid JSON body" }, 400);

    const type    = String(body.type ?? "").trim();
    const subject = String(body.subject ?? "").trim().slice(0, 200);
    const message = String(body.message ?? "").trim().slice(0, 5000);
    const context = (body.context && typeof body.context === "object") ? body.context : {};

    if (!VALID_TYPES.has(type)) return json({ error: "Invalid type" }, 400);
    if (!subject)               return json({ error: "Subject is required" }, 400);
    if (!message)               return json({ error: "Message is required" }, 400);

    // Display name: agents.display_name if present, else email prefix.
    const svc = createClient(supabaseUrl, serviceKey);
    let name: string | null = null;
    try {
      const { data: agent } = await svc.from("agents")
        .select("display_name").eq("id", user.id).maybeSingle();
      name = agent?.display_name ?? null;
    } catch (_e) { /* non-fatal */ }

    // ── 3. Store the ticket ────────────────────────────────────
    const { data: ticket, error: insErr } = await svc
      .from("support_tickets")
      .insert({
        user_id: user.id,
        email:   user.email ?? null,
        name,
        type, subject, message,
        context: {
          view:        context.view ?? null,
          url:         context.url ?? null,
          user_agent:  context.user_agent ?? null,
          viewport:    context.viewport ?? null,
          app_version: context.app_version ?? null,
        },
      })
      .select("id, created_at")
      .single();
    if (insErr) {
      console.error("support-ticket insert failed:", insErr.message);
      return json({ error: "Could not save your ticket — please try again." }, 500);
    }

    // ── 4. Notify (best-effort; never fails the request) ───────
    if (resendKey && fromAddr && notifyTo) {
      const label = { bug: "🐞 Bug report", feature: "💡 Feature request",
                      feedback: "📣 Feedback", question: "❓ Question" }[type] ?? type;
      const html = `
        <div style="font-family:sans-serif;max-width:640px">
          <h2 style="margin:0 0 4px">${label}: ${esc(subject)}</h2>
          <p style="color:#666;margin:0 0 16px">
            From <strong>${esc(name ?? "—")}</strong> (${esc(user.email ?? "no email")})
            · ticket <code>${ticket.id}</code> · ${ticket.created_at}
          </p>
          <div style="white-space:pre-wrap;border-left:3px solid #5BA0E8;padding:8px 12px;background:#f6f9fd">${esc(message)}</div>
          <p style="color:#999;font-size:12px;margin-top:16px">
            view: ${esc(String(context.view ?? "—"))} · url: ${esc(String(context.url ?? "—"))}<br>
            ua: ${esc(String(context.user_agent ?? "—"))}
          </p>
        </div>`;
      const text = `${label}: ${subject}\nFrom: ${name ?? "—"} (${user.email ?? "no email"})\nTicket: ${ticket.id}\n\n${message}`;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromAddr, to: notifyTo,
            reply_to: user.email ?? undefined,
            subject: `[Support] ${label}: ${subject}`,
            html, text,
          }),
        });
        if (!res.ok) console.error("support-ticket email failed:", res.status, await res.text());
      } catch (e) {
        console.error("support-ticket email threw:", e);
      }
    } else {
      console.warn("support-ticket: notify email skipped (missing RESEND_API_KEY / DIGEST_FROM / SUPPORT_NOTIFY_TO)");
    }

    return json({ ok: true, ticket_id: ticket.id });
  } catch (e) {
    console.error("support-ticket unhandled:", e);
    return json({ error: "Unexpected error" }, 500);
  }
});
