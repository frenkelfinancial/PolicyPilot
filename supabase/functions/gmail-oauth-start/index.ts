// ============================================================
// supabase/functions/gmail-oauth-start/index.ts
//
// Called by the authenticated browser ("Connect Gmail"). Returns the Google
// consent URL to redirect to. The client secret never leaves the server; the
// only thing minted here is a signed+encrypted `state` that binds the OAuth
// flow to THIS user, so the (unauthenticated) callback can trust who it's for.
//
// verify_jwt defaults to ON for this function, so anonymous callers are
// rejected at the platform gate before this code runs.
//
// Request  (POST, Authorization: Bearer <supabase access_token>): {}
// Response (200): { url: "https://accounts.google.com/o/oauth2/v2/auth?..." }
//
// REQUIRED Supabase secrets:
//   GOOGLE_CLIENT_ID      — OAuth 2.0 Web client ID
//   TOKEN_ENC_KEY         — 32-byte key (base64/hex) for sealing `state`
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform)
// Optional:
//   GMAIL_OAUTH_REDIRECT_URI — override the derived callback URL
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sealJson } from "../_shared/crypto.ts";
import { buildAuthUrl, gmailRedirectUri } from "../_shared/gmail-oauth.ts";

const ALLOWED_ORIGINS = new Set([
  "https://producerstackcrm.com",
  "https://localhost", // Capacitor iOS/Android
]);

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://producerstackcrm.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");

  if (!CLIENT_ID || !Deno.env.get("TOKEN_ENC_KEY")) {
    return json({ error: "gmail_oauth_not_configured" }, 500);
  }

  // Identify the caller from their Supabase JWT.
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  // Encrypted, self-authenticating state: 10-minute TTL + nonce.
  const state = await sealJson({
    uid: user.id,
    exp: Math.floor(Date.now() / 1000) + 600,
    n: crypto.randomUUID(),
  });

  const url = buildAuthUrl({
    clientId: CLIENT_ID,
    redirectUri: gmailRedirectUri(SUPABASE_URL),
    state,
    loginHint: user.email ?? undefined,
  });

  return json({ url });
});
