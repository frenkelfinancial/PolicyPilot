import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type AgencyProfile,
  DEFAULT_COMPLIANCE_BASE_URL,
  isValidSlug,
  renderIndexPage,
  renderNotFoundPage,
  renderPrivacyPolicyPage,
  renderTermsPage,
} from "../_shared/compliance-page.ts";

// ============================================================
// compliance-page — the public, unauthenticated renderer for an agent's
// 10DLC compliance pages (PROMPT_16 Phase 3).
//
//   /a/:slug                  agency overview + links to both policies
//   /a/:slug/privacy-policy
//   /a/:slug/terms
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
// by navigation, not XHR from our app origin, so _shared/cors.ts does not
// apply — its allowlist would be meaningless for a reviewer's browser.
//
// NO CLIENT-SIDE JAVASCRIPT is emitted. See the header of
// _shared/compliance-page.ts; the renderers are pure string builders and the
// unit tests assert no <script>, no inline handler, and no external asset.
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Public origin these pages are served from. Set as a function secret so the
// host can change without a code edit:
//   supabase secrets set COMPLIANCE_PAGE_BASE_URL=https://trust.producerstackcrm.com
// Used only for <link rel="canonical">; in-page links stay root-relative so
// the pages work identically behind the subdomain rewrite and at the raw
// functions URL.
const BASE_URL = (Deno.env.get("COMPLIANCE_PAGE_BASE_URL") || DEFAULT_COMPLIANCE_BASE_URL)
  .replace(/\/+$/, "");

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
      "Cache-Control": status === 200 ? "public, max-age=300" : "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
      // These pages carry no auth and no forms, but a reviewer's scanner may
      // flag a missing referrer policy on a page linked from a registration.
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

function notFound(): Response {
  return htmlResponse(renderNotFoundPage(), 404);
}

/**
 * Normalize the request path to `/a/:slug[/:page]`.
 *
 * The same deployment answers on two shapes and both must work:
 *   - behind the trust.producerstackcrm.com rewrite:  /a/:slug/privacy-policy
 *   - at the raw functions URL:  /functions/v1/compliance-page/a/:slug/privacy-policy
 * The second is what `curl` hits during verification and what we fall back to
 * if the subdomain is ever misconfigured, so it is a supported path, not a
 * debugging accident.
 */
function parseRoute(pathname: string): { slug: string; page: "index" | "privacy" | "terms" } | null {
  let path = decodeURIComponent(pathname);

  path = path.replace(/^\/functions\/v1\/compliance-page/, "");
  path = path.replace(/^\/compliance-page/, "");
  path = path.replace(/\/+$/, "");            // tolerate a trailing slash
  if (path === "") return null;

  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "a") return null;

  const slug = parts[1].toLowerCase();
  if (!isValidSlug(slug)) return null;

  if (parts.length === 2) return { slug, page: "index" };
  if (parts.length === 3) {
    if (parts[2] === "privacy-policy") return { slug, page: "privacy" };
    if (parts[2] === "terms") return { slug, page: "terms" };
  }
  return null;
}

serve(async (req) => {
  // Documents, not an API. HEAD is included because link checkers and some
  // carrier review tooling probe with it before issuing a GET.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { "Allow": "GET, HEAD" } });
  }

  const route = parseRoute(new URL(req.url).pathname);
  if (!route) return notFound();

  const { data: profile, error } = await sb
    .from("agents")
    .select(PROFILE_COLUMNS)
    .eq("compliance_slug", route.slug)
    .not("compliance_page_published_at", "is", null)
    .maybeSingle();

  if (error) {
    // Fail as a clean 404 rather than leaking a database error to a public
    // page — but log it, because a reviewer hitting this is a live incident.
    console.error("[compliance-page] lookup failed for slug", route.slug, error.message);
    return notFound();
  }
  if (!profile) return notFound();

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

  const opts = {
    profile: profile as unknown as AgencyProfile,
    lastUpdatedIso: revision?.rendered_at ?? null,
    baseUrl: BASE_URL,
  };

  const html = route.page === "privacy"
    ? renderPrivacyPolicyPage(opts)
    : route.page === "terms"
    ? renderTermsPage(opts)
    : renderIndexPage(opts);

  return htmlResponse(html, 200);
});
