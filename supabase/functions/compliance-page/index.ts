import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type AgencyProfile,
  agencyDisplayName,
  buildOptInAutoResponse,
  buildOptInDisclosure,
  compliancePageUrls,
  DEFAULT_COMPLIANCE_BASE_URL,
  isValidSlug,
  maskPhoneLast4,
  type OptInFormValues,
  renderIndexPage,
  renderNotFoundPage,
  renderPrivacyPolicyPage,
  renderSmsOptInConfirmedPage,
  renderSmsOptInPage,
  renderTermsPage,
} from "../_shared/compliance-page.ts";
import { toE164 } from "../_shared/phone.ts";

// ============================================================
// compliance-page — the public, unauthenticated renderer for an agent's
// 10DLC compliance pages (PROMPT_16 Phase 3) and their hosted SMS opt-in
// form.
//
//   GET  /a/:slug                  agency overview + links to all pages
//   GET  /a/:slug/privacy-policy
//   GET  /a/:slug/terms
//   GET  /a/:slug/sms-opt-in       the opt-in form
//   POST /a/:slug/sms-opt-in       record consent -> 303 -> /confirmed
//   GET  /a/:slug/sms-opt-in/confirmed
//
// THIS FUNCTION MUST BE PUBLICLY REACHABLE WITH NO AUTHORIZATION HEADER.
// Carrier reviewers use ordinary browsers and simple fetchers; a 401 from
// the Supabase gateway means the brand/campaign registration fails review
// and the agent cannot text. [functions.compliance-page] verify_jwt = false
// is set in supabase/config.toml for exactly this reason — see that file's
// header for the 2026-07-09 incident where a redeploy without the flag took
// four functions dark for five hours. Deploy with:
//
//   supabase functions deploy compliance-page --no-verify-jwt
//
// and confirm with a bare `curl -i <url>` (no headers) that it returns 200.
//
// NO CORS HEADERS HERE, deliberately. These are top-level documents loaded
// by navigation and a form posted from the same origin, not XHR from our app
// origin, so _shared/cors.ts does not apply — its allowlist would be
// meaningless for a consumer's or a reviewer's browser.
//
// NO CLIENT-SIDE JAVASCRIPT is emitted, INCLUDING ON THE FORM. See the header
// of _shared/compliance-page.ts; the renderers are pure string builders and
// the unit tests assert no <script>, no inline handler, and no external
// asset. The form is a plain POST and every field is re-validated here —
// `required` in the markup is a courtesy to the consumer, never the check.
//
// ------------------------------------------------------------
// THE OPT-IN POST IS THE ONLY WRITE THIS FUNCTION MAKES
// ------------------------------------------------------------
// It exists because the 10DLC campaign was rejected: carrier review would not
// take a lead vendor's "…and its licensed agents" language as opt-in evidence
// for a campaign sending as the agency. So consent is collected here instead,
// on the agency's own page, and stored evidence-grade — the exact disclosure
// text displayed, the page URL, the IP, the user agent, the timestamp.
//
// It is a PUBLIC endpoint that writes consent for a phone number typed by
// whoever is at the keyboard. Four things bound that, in order:
//   1. the slug must resolve to a PUBLISHED agent page (same query as a GET);
//   2. a honeypot field that a human never sees and a bot fills;
//   3. a per-IP hourly cap, counted against consent_records.ip_address;
//   4. the consent row NEVER clears a dnc_list entry. A STOP came from the
//      handset; a web form did not. Recording the request is right, acting
//      on it over the top of a verified STOP is not.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");

// Public origin these pages are served from. Set as a function secret so the
// host can change without a code edit:
//   supabase secrets set COMPLIANCE_PAGE_BASE_URL=https://trust.producerstackcrm.com
// Used for <link rel="canonical">, for the URLs quoted inside the stored
// disclosure text, and for consent_records.page_url. In-page links stay
// prefix-relative so the pages work identically behind the subdomain rewrite
// and at the raw functions URL.
const BASE_URL = (Deno.env.get("COMPLIANCE_PAGE_BASE_URL") || DEFAULT_COMPLIANCE_BASE_URL)
  .replace(/\/+$/, "");

// How many opt-ins one IP may submit in an hour. Generous for a household or
// an office behind one NAT, useless for a script. A refusal here is rendered
// as a plain "try again later", never as a hint about the limit.
const OPTIN_IP_HOURLY_CAP = 8;

// The agents columns the renderer reads. Explicit rather than `*` so a future
// column addition can never widen what a public page can expose.
const PROFILE_COLUMNS = [
  "id", // needed to look up the newest revision for the "Last updated" date
  "dba_name",
  "business_legal_name",
  "business_entity_type",
  "formation_state",
  "business_street",
  "business_city",
  "business_state",
  "business_postal_code",
  "business_phone",
  "business_email",
  "lead_vendors",
  "compliance_slug",
  "compliance_page_published_at",
].join(",");

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 5 minutes: long enough to absorb a reviewer refreshing, short enough
      // that an agent who fixes a typo sees it without support intervention.
      // The opt-in form and its confirmation are no-store — a cached form is
      // a form that can be replayed, and a cached confirmation could show one
      // consumer the tail of another's phone number on a shared machine.
      "Cache-Control": status === 200 ? "public, max-age=300" : "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
      // These pages carry no auth, but a reviewer's scanner may flag a
      // missing referrer policy on a page linked from a registration.
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

/** Same shell as htmlResponse, but never cached. Used for every opt-in surface. */
function privateHtmlResponse(body: string, status: number): Response {
  const res = htmlResponse(body, status);
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "same-origin");
  return new Response(res.body, { status, headers });
}

function notFound(): Response {
  return htmlResponse(renderNotFoundPage(), 404);
}

type PageKind = "index" | "privacy" | "terms" | "optin" | "optin_confirmed";

/**
 * Normalize the request path to `/a/:slug[/:page]`, and report the prefix
 * that was stripped.
 *
 * The same deployment answers on two shapes and both must work:
 *   - behind the trust.producerstackcrm.com rewrite:  /a/:slug/privacy-policy
 *   - at the raw functions URL:  /functions/v1/compliance-page/a/:slug/...
 * The second is what `curl` hits during verification and what we fall back to
 * if the subdomain is ever misconfigured, so it is a supported path, not a
 * debugging accident. The prefix is handed to the renderers so the opt-in
 * form posts back to the URL it was actually served from — a hardcoded
 * root-relative action would post to a 404 on the raw functions host.
 */
function parseRoute(pathname: string): { slug: string; page: PageKind; prefix: string } | null {
  let path = decodeURIComponent(pathname);
  let prefix = "";

  for (const candidate of ["/functions/v1/compliance-page", "/compliance-page"]) {
    if (path.startsWith(candidate)) {
      prefix = candidate;
      path = path.slice(candidate.length);
      break;
    }
  }
  path = path.replace(/\/+$/, ""); // tolerate a trailing slash
  if (path === "") return null;

  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "a") return null;

  const slug = parts[1].toLowerCase();
  if (!isValidSlug(slug)) return null;

  if (parts.length === 2) return { slug, page: "index", prefix };
  if (parts.length === 3) {
    if (parts[2] === "privacy-policy") return { slug, page: "privacy", prefix };
    if (parts[2] === "terms") return { slug, page: "terms", prefix };
    if (parts[2] === "sms-opt-in") return { slug, page: "optin", prefix };
  }
  if (parts.length === 4 && parts[2] === "sms-opt-in" && parts[3] === "confirmed") {
    return { slug, page: "optin_confirmed", prefix };
  }
  return null;
}

/**
 * First hop of X-Forwarded-For. Two proxies sit in front of this function
 * (Vercel, then the Supabase gateway), so the header is a list and the
 * left-most entry is the client. Stored as text — see the ip_address note in
 * 20260733_sms_optin_consent.sql for why this is deliberately not INET.
 */
function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  if (first) return first.slice(0, 64);
  const real = (req.headers.get("x-real-ip") || "").trim();
  return real ? real.slice(0, 64) : null;
}

async function loadProfile(slug: string): Promise<{ profile: AgencyProfile; lastUpdatedIso: string | null } | null> {
  const { data: profile, error } = await sb
    .from("agents")
    .select(PROFILE_COLUMNS)
    .eq("compliance_slug", slug)
    .not("compliance_page_published_at", "is", null)
    .maybeSingle();

  if (error) {
    // Fail as a clean 404 rather than leaking a database error to a public
    // page — but log it, because a reviewer hitting this is a live incident.
    console.error("[compliance-page] lookup failed for slug", slug, error.message);
    return null;
  }
  if (!profile) return null;

  // "Last updated" comes from the newest audit revision, so the date on the
  // page always matches what compliance_page_revisions can prove was
  // rendered. Falls back to published_at if the trail is somehow empty.
  const agentId = (profile as unknown as { id: string }).id;
  const { data: revision } = await sb
    .from("compliance_page_revisions")
    .select("rendered_at")
    .eq("agent_id", agentId)
    .order("rendered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    profile: profile as unknown as AgencyProfile,
    lastUpdatedIso: revision?.rendered_at ?? null,
  };
}

/**
 * Send the one confirmation text the campaign promised.
 *
 * Unbilled and fire-and-forget, exactly like the STOP confirmation in
 * messaging-inbound-webhook: a keyword auto-response is a compliance
 * obligation to the consumer, not a message the agent chose to send, so it
 * places no wallet hold and writes no `messages` row. A failure here must
 * never fail the opt-in — the consent is recorded either way, and a consumer
 * seeing an error page after we already stored their consent is the worst of
 * both outcomes.
 */
async function sendOptInConfirmation(agentId: string, toNumber: string, text: string): Promise<void> {
  if (!TELNYX_API_KEY) {
    console.warn("[compliance-page] TELNYX_API_KEY unset — opt-in confirmation not sent to", toNumber);
    return;
  }

  // Only a number attached to the agent's approved 10DLC campaign may carry
  // this traffic. resolveTextingNumber() is not reused here because it lives
  // in messaging-shared.ts alongside the full send path; this is the same
  // rule reduced to the single question that matters for an auto-response.
  const { data: capable } = await sb
    .from("phone_numbers")
    .select("e164, is_primary")
    .eq("agent_id", agentId)
    .eq("sms_capable", true)
    .eq("status", "active");

  const numbers = (capable || []) as Array<{ e164: string; is_primary: boolean | null }>;
  if (numbers.length === 0) {
    // Expected while an agent is still pending approval. Their consent is
    // recorded and usable the moment a number is attached; the consumer just
    // does not get the confirmation text yet.
    console.warn("[compliance-page] no sms_capable number for agent", agentId, "— opt-in confirmation skipped");
    return;
  }
  const from = (numbers.find((n) => n.is_primary) ?? numbers[0]).e164;

  try {
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: toNumber,
        text,
        ...(TELNYX_MSG_PROFILE_ID ? { messaging_profile_id: TELNYX_MSG_PROFILE_ID } : {}),
      }),
    });
    if (!res.ok) {
      console.error("[compliance-page] opt-in confirmation rejected by Telnyx:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[compliance-page] opt-in confirmation send failed:", err);
  }
}

/**
 * Handle a submitted opt-in form.
 *
 * Returns either a 303 to the confirmation page (success) or a re-rendered
 * form carrying a plain-English error and the values they already typed.
 * Never a JSON error and never a bare status code — the caller is a consumer
 * in a browser with no JavaScript to interpret one.
 */
async function handleOptInPost(
  req: Request,
  route: { slug: string; prefix: string },
  loaded: { profile: AgencyProfile; lastUpdatedIso: string | null },
): Promise<Response> {
  const { profile, lastUpdatedIso } = loaded;
  const agentId = (profile as unknown as { id: string }).id;
  const agency = agencyDisplayName(profile);
  const urls = compliancePageUrls(BASE_URL, route.slug);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return privateHtmlResponse(
      renderSmsOptInPage({
        profile,
        lastUpdatedIso,
        baseUrl: BASE_URL,
        pathPrefix: route.prefix,
        error: "We could not read that submission. Please fill the form in again.",
      }),
      400,
    );
  }

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };

  const values: OptInFormValues = {
    first_name: str("first_name").slice(0, 60),
    last_name: str("last_name").slice(0, 60),
    phone: str("phone").slice(0, 24),
  };

  const bounce = (error: string, status = 400) =>
    privateHtmlResponse(
      renderSmsOptInPage({
        profile,
        lastUpdatedIso,
        baseUrl: BASE_URL,
        pathPrefix: route.prefix,
        error,
        values,
      }),
      status,
    );

  // Honeypot. A human never sees this field; a form-filling bot fills every
  // input it finds. Answer 200 with the plain form and no error, so a scripted
  // submitter learns nothing about why nothing happened.
  if (str("company_website")) {
    console.warn("[compliance-page] opt-in honeypot tripped for slug", route.slug, "ip", clientIp(req));
    return privateHtmlResponse(
      renderSmsOptInPage({ profile, lastUpdatedIso, baseUrl: BASE_URL, pathPrefix: route.prefix }),
      200,
    );
  }

  if (!values.first_name) return bounce("Please enter your first name.");
  if (!values.last_name) return bounce("Please enter your last name.");

  const phone = toE164(values.phone || "");
  if (!phone || !/^\+1\d{10}$/.test(phone)) {
    return bounce(
      "That does not look like a US mobile number. Please enter 10 digits, for example (555) 123-4567.",
    );
  }

  // THE CONSENT CHECK. Unticked means no consent, full stop — there is no
  // path here that records a row without it, and the re-rendered form comes
  // back with the box empty so they have to tick it themselves.
  if (form.get("consent") !== "yes") {
    return bounce(
      "Please tick the box to agree to receive text messages. We cannot sign you up without it.",
    );
  }

  const ip = clientIp(req);

  // Per-IP hourly cap. Deliberately vague in the message: a submitter who
  // learns the exact limit learns how to sit just under it.
  if (ip) {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await sb
      .from("consent_records")
      .select("id", { count: "exact", head: true })
      .eq("ip_address", ip)
      .gte("captured_at", since);
    if ((count ?? 0) >= OPTIN_IP_HOURLY_CAP) {
      console.warn("[compliance-page] opt-in rate limit hit for ip", ip, "slug", route.slug);
      return bounce("We have had too many sign-ups from your connection just now. Please try again later.", 429);
    }
  }

  // THE disclosure — the same call the page rendered, so what we store is
  // provably the text that was on screen above the box they ticked.
  const disclosure = buildOptInDisclosure(agency, urls);

  // A do-not-contact entry outranks this form. The consumer asking again is
  // worth recording — it is evidence, and it is what they intended — but a
  // web form is unverified and a STOP came from the handset itself, so the
  // dnc_list row stays exactly where it is and we send no confirmation text.
  // The confirmation page tells them to reply START, which is the one path
  // that can actually clear it (messaging-inbound-webhook).
  const { data: dncRows } = await sb
    .from("dnc_list")
    .select("agent_id")
    .eq("contact_phone", phone);
  const onDnc = (dncRows || []).some(
    (r: { agent_id: string | null }) => r.agent_id === null || r.agent_id === agentId,
  );

  const { error: insertErr } = await sb.from("consent_records").insert({
    agent_id: agentId,
    contact_phone: phone,
    // The TCPA basis, which is what runComplianceGate reads. A named consumer
    // ticking an unticked box under a disclosure they can see IS prior
    // express written consent — this is the strongest form of it we have.
    // `consent_method` below is the separate column that records HOW; the two
    // answer different questions and collapsing them would either break the
    // send gate or throw the provenance away.
    consent_type: "express_written",
    consent_method: "web_form",
    source: `web_form: ${urls.smsOptIn}`,
    disclosure_text: disclosure,
    page_url: urls.smsOptIn,
    ip_address: ip,
    user_agent: (req.headers.get("user-agent") || "").slice(0, 400) || null,
    contact_first_name: values.first_name,
    contact_last_name: values.last_name,
    captured_at: new Date().toISOString(),
  });

  if (insertErr) {
    console.error("[compliance-page] opt-in consent write FAILED for slug", route.slug, insertErr.message);
    return bounce(
      "Something went wrong on our end and we could not record your sign-up. Please try again in a moment.",
      500,
    );
  }

  if (!onDnc) {
    await sendOptInConfirmation(agentId, phone, buildOptInAutoResponse(agency));
  } else {
    console.warn("[compliance-page] opt-in recorded for a number on dnc_list — no confirmation sent:", phone);
  }

  // Post/Redirect/Get: a refresh on the confirmation page must not write a
  // second consent row. The name and masked number ride in the query string
  // rather than a cookie so the page stays stateless and JS-free; neither is
  // trusted for anything, they are only echoed back after escaping.
  const params = new URLSearchParams({ n: values.first_name || "", p: phone.slice(-4) });
  if (onDnc) params.set("s", "1");
  return new Response(null, {
    status: 303,
    headers: {
      "Location": `${route.prefix}/a/${route.slug}/sms-opt-in/confirmed?${params.toString()}`,
      "Cache-Control": "no-store",
    },
  });
}

serve(async (req) => {
  const url = new URL(req.url);
  const route = parseRoute(url.pathname);

  // Documents, not an API. HEAD is included because link checkers and some
  // carrier review tooling probe with it before issuing a GET. POST is
  // accepted on exactly one route.
  const isOptInPost = req.method === "POST" && route?.page === "optin";
  if (req.method !== "GET" && req.method !== "HEAD" && !isOptInPost) {
    return new Response("Method Not Allowed", { status: 405, headers: { "Allow": "GET, HEAD, POST" } });
  }

  if (!route) return notFound();

  const loaded = await loadProfile(route.slug);
  if (!loaded) return notFound();

  if (isOptInPost) return await handleOptInPost(req, route, loaded);

  const opts = {
    profile: loaded.profile,
    lastUpdatedIso: loaded.lastUpdatedIso,
    baseUrl: BASE_URL,
    pathPrefix: route.prefix,
  };

  if (route.page === "optin") {
    return privateHtmlResponse(renderSmsOptInPage(opts), 200);
  }
  if (route.page === "optin_confirmed") {
    const last4 = (url.searchParams.get("p") || "").replace(/\D/g, "").slice(-4);
    return privateHtmlResponse(
      renderSmsOptInConfirmedPage({
        ...opts,
        firstName: (url.searchParams.get("n") || "").slice(0, 60),
        maskedPhone: maskPhoneLast4(last4) || null,
        stopWarning: url.searchParams.get("s") === "1",
      }),
      200,
    );
  }

  const html = route.page === "privacy"
    ? renderPrivacyPolicyPage(opts)
    : route.page === "terms"
    ? renderTermsPage(opts)
    : renderIndexPage(opts);

  return htmlResponse(html, 200);
});
