import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { toE164 } from "../_shared/phone.ts";
import {
  type AgencyProfile,
  agencyDisplayName,
  compliancePageUrls,
  DEFAULT_COMPLIANCE_BASE_URL,
  escapeHtml,
  formatPhoneDisplay,
} from "../_shared/compliance-page.ts";

// ============================================================
// messaging-send-optin-invite — email a lead the link to their agent's
// hosted SMS opt-in page.
//
// WHY THIS IS A SEPARATE FUNCTION FROM messaging-send-email
// ---------------------------------------------------------
// messaging-send-email runs runComplianceGate(), which requires a
// consent_records row for the recipient. This email's entire purpose is to
// reach someone who does NOT have one yet — routing it through that function
// would be circular, and relaxing that gate to fit would punch a hole in the
// one thing standing between us and an unconsented send.
//
// It is also gated on billing_config.email_enabled, which is off (Phase 2
// re-scoped outbound email out), and it sends from the agent's own verified
// domain, which almost no agent has configured. Neither is true of this: the
// invite goes from the PLATFORM sender with the agency's details in the body
// and their business email as Reply-To, so it works for an agent who has
// nothing set up beyond a completed business profile.
//
// THE LEGAL BASIS IS EMAIL, AND ONLY EMAIL
// ----------------------------------------
// We may email these leads under the consent already captured on the lead
// vendor's form. We may not text them under it — that is precisely the
// finding that got the 10DLC campaign rejected and the reason the opt-in page
// exists. So this function sends an email and nothing else. It writes no
// consent record: the consumer does that themselves, by ticking a box on a
// page we do not control the outcome of.
//
// Request:  { contact_email, contact_phone?, first_name? }
// Response: { ok, opt_in_url, sent_to }
// ============================================================

const RESEND_ENDPOINT = "https://api.resend.com/emails";

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM_ADDR = Deno.env.get("DIGEST_FROM") ?? "ProducerStackCRM <noreply@producerstackcrm.com>";
  const BASE_URL = (Deno.env.get("COMPLIANCE_PAGE_BASE_URL") || DEFAULT_COMPLIANCE_BASE_URL)
    .replace(/\/+$/, "");

  if (!RESEND_API_KEY) return json({ error: "resend_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { contact_email?: unknown; contact_phone?: unknown; first_name?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const email = typeof body.contact_email === "string" ? body.contact_email.trim().toLowerCase() : "";
  if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return json({
      error: "invalid_email",
      detail: "This lead has no usable email address, so there is nowhere to send the opt-in link. " +
        "Add one on their row first, or read them the link over the phone.",
    }, 400);
  }

  const firstName = typeof body.first_name === "string" ? body.first_name.trim().slice(0, 60) : "";
  // Optional, and only used for the DNC check below — the consumer types
  // their own number on the page, and that is the one that gets recorded.
  const phone = toE164(typeof body.contact_phone === "string" ? body.contact_phone : "");

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- The agent's page has to exist before we can point anyone at it. ---
  const { data: agentRow } = await sb.from("agents")
    .select(
      "id, dba_name, business_legal_name, business_entity_type, formation_state, business_street, " +
        "business_city, business_state, business_postal_code, business_phone, business_email, " +
        "lead_vendors, compliance_slug, compliance_page_published_at",
    )
    .eq("id", user.id)
    .maybeSingle();

  if (!agentRow?.compliance_slug || !agentRow.compliance_page_published_at) {
    return json({
      error: "compliance_page_missing",
      detail: "Your compliance pages have not been generated yet, so there is no opt-in page to link to. " +
        "Complete your business profile in Settings and it publishes itself.",
    }, 409);
  }

  const profile = agentRow as unknown as AgencyProfile;
  const agency = agencyDisplayName(profile);
  const urls = compliancePageUrls(BASE_URL, agentRow.compliance_slug);

  // --- Do-not-contact, on BOTH addresses. ---
  //
  // The email one is the direct rule: someone who unsubscribed by email must
  // not get another email. The phone one is subtler and matters more — a
  // person who texted STOP has revoked at the carrier level, and emailing
  // them an invitation to opt back in is the same solicitation the STOP
  // refused, wearing a different channel. It is also a wasted send: the
  // opt-in page will record their consent and still refuse to text them.
  const [emailDnc, phoneDnc] = await Promise.all([
    sb.from("dnc_list").select("agent_id").eq("contact_email", email),
    phone
      ? sb.from("dnc_list").select("agent_id").eq("contact_phone", phone)
      : Promise.resolve({ data: [] as Array<{ agent_id: string | null }> }),
  ]);
  const blocked = (rows: Array<{ agent_id: string | null }> | null) =>
    (rows || []).some((r) => r.agent_id === null || r.agent_id === user.id);

  if (blocked(emailDnc.data as Array<{ agent_id: string | null }> | null)) {
    return json({
      error: "on_dnc_list",
      detail: "This email address is on your do-not-contact list, so we cannot send to it.",
    }, 409);
  }
  if (blocked(phoneDnc.data as Array<{ agent_id: string | null }> | null)) {
    return json({
      error: "on_dnc_list",
      detail: "This person replied STOP to a text, so they have opted out. Emailing them an invitation to " +
        "opt back in is the same message they already refused — they have to text START themselves.",
    }, 409);
  }

  // --- Already covered? Say so instead of sending. ---
  const { data: existing } = phone
    ? await sb.from("consent_records")
      .select("id, consent_type, revoked_at")
      .eq("agent_id", user.id)
      .eq("contact_phone", phone)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    : { data: null };

  if (existing && !existing.revoked_at && existing.consent_type === "express_written") {
    return json({
      ok: true,
      already_consented: true,
      opt_in_url: urls.smsOptIn,
      detail: "This person already has written consent on file — you can text them now, no invite needed.",
    });
  }

  // --- The email. Plain, short, and unmistakably from the agency. ---
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const agentPhone = (profile.business_phone || "").trim();
  const agentEmail = (profile.business_email || "").trim();

  // Signature lines are filtered for emptiness separately so an agent with no
  // phone or no email on file does not get a blank line in their sign-off.
  const signature = [agency, agentPhone ? formatPhoneDisplay(agentPhone) : "", agentEmail]
    .filter(Boolean)
    .join("\n");

  const text = [
    greeting,
    "",
    `You asked about life insurance, and ${agency} would like to be able to text you about your quote, ` +
    `your appointments, and the status of your application.`,
    "",
    `Text messages are usually the quickest way to reach us, but we need your say-so first. ` +
    `It takes about ten seconds:`,
    "",
    urls.smsOptIn,
    "",
    `You will see exactly what you are agreeing to before you agree to it. Message frequency varies, ` +
    `message and data rates may apply, and agreeing is not a condition of buying anything. You can ` +
    `reply STOP to any text to stop them.`,
    "",
    `If you would rather not, just ignore this email — we will keep working with you by phone and email.`,
    "",
    signature,
  ].join("\n");

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1c2024;max-width:560px">
<p>${escapeHtml(greeting)}</p>
<p>You asked about life insurance, and <strong>${escapeHtml(agency)}</strong> would like to be able to text
you about your quote, your appointments, and the status of your application.</p>
<p>Text messages are usually the quickest way to reach us, but we need your say-so first. It takes about
ten seconds:</p>
<p><a href="${escapeHtml(urls.smsOptIn)}"
 style="display:inline-block;padding:12px 22px;background:#1c2024;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Sign
 up for text messages</a></p>
<p style="font-size:13px;color:#5b636b">Or paste this into your browser:<br>
<a href="${escapeHtml(urls.smsOptIn)}">${escapeHtml(urls.smsOptIn)}</a></p>
<p style="font-size:13px;color:#5b636b">You will see exactly what you are agreeing to before you agree to
it. Message frequency varies, message and data rates may apply, and agreeing is not a condition of buying
anything. You can reply STOP to any text to stop them. See our
<a href="${escapeHtml(urls.privacy)}">privacy policy</a> and
<a href="${escapeHtml(urls.terms)}">text messaging terms</a>.</p>
<p style="font-size:13px;color:#5b636b">If you would rather not, just ignore this email — we will keep
working with you by phone and email.</p>
<p style="margin-top:22px">${escapeHtml(agency)}<br>
${agentPhone ? `${escapeHtml(formatPhoneDisplay(agentPhone))}<br>` : ""}
${agentEmail ? `<a href="mailto:${escapeHtml(agentEmail)}">${escapeHtml(agentEmail)}</a>` : ""}</p>
</div>`;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDR,
        to: email,
        // A reply goes to the AGENT, not to us. The consumer is answering
        // their agency, and a bounce into a platform mailbox nobody reads is
        // how "I replied and never heard back" happens.
        ...(agentEmail ? { reply_to: agentEmail } : {}),
        subject: `${agency}: can we text you about your quote?`,
        html,
        text,
      }),
    });

    if (!res.ok) {
      const detailText = await res.text();
      console.error("[messaging-send-optin-invite] Resend rejected:", res.status, detailText);
      return json({
        error: "email_send_failed",
        detail: "The email could not be sent just now. Try again in a moment.",
      }, 502);
    }
  } catch (e) {
    console.error("[messaging-send-optin-invite] Resend threw:", e);
    return json({
      error: "email_send_failed",
      detail: "The email could not be sent just now. Try again in a moment.",
    }, 502);
  }

  return json({ ok: true, sent_to: email, opt_in_url: urls.smsOptIn });
});
