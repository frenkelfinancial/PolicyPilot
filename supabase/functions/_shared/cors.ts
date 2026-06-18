// ============================================================
// supabase/functions/_shared/cors.ts
//
// Centralized CORS policy for the browser-facing Edge Functions.
// Replaces the previous wildcard ("Access-Control-Allow-Origin": "*")
// with an allowlist + echo-back: the request's Origin is reflected back
// only when it is on the allowlist (or a local-dev origin), otherwise the
// canonical production origin is returned so disallowed sites are blocked.
//
// NOTE: server-to-server functions are intentionally NOT wired to this:
//   - daily-digest          (cron-triggered, no browser caller)
//   - signalwire-call-status (SignalWire webhook, server-to-server)
//
// All browser-facing functions still independently require a valid
// Supabase JWT; this is defense-in-depth on top of that.
// ============================================================

// Production is GitHub Pages on the custom domain producerstackcrm.com.
const ALLOWED_ORIGINS = new Set([
  "https://producerstackcrm.com",        // production (custom domain)
  "https://www.producerstackcrm.com",    // www variant
  "https://frenkelfinancial.github.io",  // GitHub Pages default domain (pre-redirect)
]);

// Returned when the request Origin is absent or not allowed.
const PRIMARY_ORIGIN = "https://producerstackcrm.com";

// Local development: `supabase functions serve` + opening index.html on localhost.
function isLocalDev(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// Build the CORS header set for a given request, reflecting the Origin
// only when it is trusted.
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ALLOWED_ORIGINS.has(origin) || isLocalDev(origin) ? origin : PRIMARY_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
