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

// ------------------------------------------------------------
// Local development origins — OFF unless explicitly switched on.
//
// scripts/../serve.ps1 serves the app from http://localhost:8080, which is a
// different origin from every entry above, so the browser blocks the preflight
// and no edge function is callable while clicking through locally.
//
// These are NOT added to ALLOWED_ORIGINS, deliberately. That set is what ships;
// this one is gated behind an env var so allowing a dev origin is always a
// deliberate, visible, revocable act rather than a line of code nobody
// remembers is there. It FAILS CLOSED: absent or unparseable env => off.
//
//   supabase secrets set   ALLOW_DEV_ORIGINS=true    # enable for a local pass
//   supabase secrets unset ALLOW_DEV_ORIGINS         # turn it back off
//
// There is only ONE Supabase project (production), so switching this on does
// allow localhost against production data. Turn it off when you are done —
// the response header tells you whether it is on, see below.
// ------------------------------------------------------------
export const DEV_ORIGINS = new Set([
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

/** True only when ALLOW_DEV_ORIGINS is explicitly a truthy string. */
export function devOriginsEnabled(): boolean {
  try {
    // Guarded so this module stays importable outside Deno (node --test).
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    if (!d?.env?.get) return false;
    const v = String(d.env.get("ALLOW_DEV_ORIGINS") ?? "").trim().toLowerCase();
    return v === "true" || v === "1" || v === "on";
  } catch {
    // Deno throws on env access without --allow-env. Fail closed.
    return false;
  }
}

/**
 * Resolve the Access-Control-Allow-Origin value for a request.
 *
 * Exported separately from corsHeaders so it can be unit tested without a
 * Response object.
 */
export function resolveAllowedOrigin(origin: string | null, allowDev = devOriginsEnabled()): string {
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  if (allowDev && origin && DEV_ORIGINS.has(origin)) return origin;
  // Any other origin falls back to the apex, so a stray origin is denied by
  // the browser rather than being reflected back.
  return "https://producerstackcrm.com";
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowDev = devOriginsEnabled();
  return {
    "Access-Control-Allow-Origin": resolveAllowedOrigin(origin, allowDev),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    // Makes "is the dev allowlist still switched on in production?" answerable
    // with a curl instead of a guess. Only present while it IS on.
    ...(allowDev ? { "X-Dev-Origins-Allowed": "true" } : {}),
  };
}
