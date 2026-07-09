// Single source of truth for edge-function CORS.
//
// Every browser-facing edge function must build its response headers with
// corsHeaders(req.headers.get("origin")). Hand-rolling per-function allowlists
// is how we ended up with calling working on the apex domain but top-up
// (stripe-create-checkout) and the Capacitor mobile app silently failing the
// browser's preflight — see docs/audit-2026-07-09-calling-and-topup.md.
//
// Allowlist:
//   https://producerstackcrm.com      — apex (primary web app)
//   https://www.producerstackcrm.com  — www (users who land on the subdomain)
//   https://localhost                 — iOS/Android app (Capacitor, iosScheme/
//                                        androidScheme: "https")
//
// Requests from any other origin fall back to the apex value, so a stray
// origin is denied by the browser rather than being reflected back.
//
// Do NOT use this for webhook-only functions that browsers never call
// (stripe-webhook, lead-ingest, messaging-*-webhook, signalwire-swml-outbound,
// *-call-status) — those intentionally allow "*" or need no CORS at all.
export const ALLOWED_ORIGINS = new Set([
  "https://producerstackcrm.com",
  "https://www.producerstackcrm.com",
  "https://localhost",
]);

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin":
      origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://producerstackcrm.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
