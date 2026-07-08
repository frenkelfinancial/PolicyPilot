// ============================================================
// supabase/functions/_shared/gmail-oauth.ts
//
// Google OAuth 2.0 authorization-code flow for Gmail READ access. Shared by
// gmail-oauth-start (builds the consent URL) and gmail-oauth-callback
// (exchanges the code, reads the profile, and can revoke on disconnect).
//
// Why the code flow and not the in-browser GIS token flow (used by the
// Calendar integration): background polling needs a long-lived REFRESH token,
// which only the server-side code flow returns. The client secret therefore
// stays in the edge function; the browser never sees it.
//
// Scope is EXACTLY gmail.readonly (a Google *restricted* scope). Adding scopes
// re-triggers Google review + CASA, so keep this list to one entry. The
// connected email + starting historyId come from gmail.readonly's getProfile —
// no extra scope needed.
// ============================================================

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

// The redirect URI MUST byte-for-byte match the one registered in Google Cloud:
//   https://<project-ref>.supabase.co/functions/v1/gmail-oauth-callback
// SUPABASE_URL already equals https://<project-ref>.supabase.co, so we derive
// it (overridable via GMAIL_OAUTH_REDIRECT_URI if the callback ever moves).
export function gmailRedirectUri(supabaseUrl: string): string {
  return Deno.env.get("GMAIL_OAUTH_REDIRECT_URI") ||
    `${supabaseUrl}/functions/v1/gmail-oauth-callback`;
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline", // ask for a refresh token
    // select_account => always show the account chooser (the mailbox being
    // connected is intentionally different from the ProducerStack login);
    // consent => force refresh-token issuance every time (test-mode reconnects).
    prompt: "select_account consent",
    include_granted_scopes: "false",
    state: opts.state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  return (await res.json()) as TokenResponse;
}

export interface GmailProfile {
  emailAddress: string;
  historyId?: string;
}

/** Read the connected address + starting historyId via gmail.readonly. */
export async function fetchGmailProfile(accessToken: string): Promise<GmailProfile> {
  const res = await fetch(PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`getProfile failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GmailProfile;
}

/** Best-effort revoke at Google on disconnect. Never throws. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: "POST" });
  } catch (_) {
    // ignore — local purge still proceeds
  }
}
