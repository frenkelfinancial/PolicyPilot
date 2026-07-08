// ============================================================
// supabase/functions/gmail-oauth-callback/index.ts
//
// Google redirects the browser here (GET) after consent. This runs
// server-side, exchanges the auth code for tokens (client secret lives here),
// encrypts the refresh token, stores it, and bounces the browser back to the
// app. There is NO Supabase JWT on this request — the user identity comes from
// the encrypted `state` minted by gmail-oauth-start.
//
// >>> This function MUST have verify_jwt = false (see config.toml). <<<
//
// Redirect URI registered in Google Cloud MUST equal:
//   https://<project-ref>.supabase.co/functions/v1/gmail-oauth-callback
//
// REQUIRED Supabase secrets:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENC_KEY
//   APP_URL   — where to send the browser afterward (default producerstackcrm.com)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptString, openJson } from "../_shared/crypto.ts";
import { exchangeCode, fetchGmailProfile, gmailRedirectUri, GMAIL_SCOPE } from "../_shared/gmail-oauth.ts";

interface OAuthState {
  uid: string;
  exp: number;
  n: string;
}

serve(async (req) => {
  const url = new URL(req.url);
  const APP_URL = Deno.env.get("APP_URL") || "https://producerstackcrm.com";

  // Always return the user to the app; encode the outcome as a query param.
  const back = (status: string, reason?: string) => {
    const q = new URLSearchParams({ gmail: status });
    if (reason) q.set("reason", reason);
    return Response.redirect(`${APP_URL}/app.html?${q.toString()}`, 302);
  };

  try {
    const errParam = url.searchParams.get("error");
    if (errParam) return back("error", errParam); // user denied, etc.

    const code = url.searchParams.get("code");
    const stateRaw = url.searchParams.get("state");
    if (!code || !stateRaw) return back("error", "missing_code");

    let state: OAuthState;
    try {
      state = await openJson<OAuthState>(stateRaw);
    } catch (_) {
      return back("error", "bad_state"); // tampered / wrong key
    }
    if (!state?.uid || !state?.exp || state.exp < Math.floor(Date.now() / 1000)) {
      return back("error", "expired_state");
    }

    const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
    const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!CLIENT_ID || !CLIENT_SECRET) return back("error", "not_configured");

    // Exchange the one-time code for tokens.
    const tok = await exchangeCode({
      code,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: gmailRedirectUri(SUPABASE_URL),
    });
    if (tok.error || !tok.access_token) {
      console.error("token exchange failed:", tok.error, tok.error_description);
      return back("error", "token_exchange_failed");
    }
    // access_type=offline + prompt=consent should always yield a refresh token.
    if (!tok.refresh_token) return back("error", "no_refresh_token");

    // Confirm scope is what we asked for (defense in depth).
    if (tok.scope && !tok.scope.includes(GMAIL_SCOPE)) {
      console.error("unexpected scope:", tok.scope);
      return back("error", "wrong_scope");
    }

    // Read the connected address + starting sync cursor.
    const profile = await fetchGmailProfile(tok.access_token);
    const email = profile.emailAddress;
    if (!email) return back("error", "no_profile");

    const enc = await encryptString(tok.refresh_token);
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const nowIso = new Date().toISOString();

    // Upsert account metadata. On reconnect keep the existing history_id so we
    // don't reset the Phase-2 sync cursor.
    const { data: existing } = await sb
      .from("gmail_accounts")
      .select("id, history_id")
      .eq("user_id", state.uid)
      .eq("email_address", email)
      .maybeSingle();

    let accountId: string;
    if (existing) {
      accountId = existing.id;
      const { error: updErr } = await sb
        .from("gmail_accounts")
        .update({
          status: "active",
          scope: tok.scope ?? GMAIL_SCOPE,
          connected_at: nowIso,
          updated_at: nowIso,
          history_id: existing.history_id ?? profile.historyId ?? null,
        })
        .eq("id", accountId);
      if (updErr) {
        console.error("account update failed:", updErr);
        return back("error", "db_error");
      }
    } else {
      const { data: ins, error: insErr } = await sb
        .from("gmail_accounts")
        .insert({
          user_id: state.uid,
          email_address: email,
          status: "active",
          scope: tok.scope ?? GMAIL_SCOPE,
          history_id: profile.historyId ?? null,
        })
        .select("id")
        .single();
      if (insErr || !ins) {
        console.error("account insert failed:", insErr);
        return back("error", "db_error");
      }
      accountId = ins.id;
    }

    const { error: secErr } = await sb
      .from("gmail_account_secrets")
      .upsert({ gmail_account_id: accountId, refresh_token_enc: enc, updated_at: nowIso });
    if (secErr) {
      console.error("secret upsert failed:", secErr);
      return back("error", "db_error");
    }

    return back("connected");
  } catch (e) {
    console.error("callback error:", e);
    return back("error", "server_error");
  }
});
