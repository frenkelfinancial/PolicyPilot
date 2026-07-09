// ============================================================
// supabase/functions/gmail-disconnect/index.ts
//
// Authenticated browser calls this to disconnect Gmail. Revokes the refresh
// token at Google (best-effort), then purges the token + account rows. Deleting
// gmail_accounts cascades to gmail_account_secrets.
//
// Delete-on-disconnect is a privacy requirement (build plan §7): once a user
// disconnects, we hold neither their token nor their mailbox cursor.
//
// verify_jwt defaults ON. Request (POST): {}  → Response: { ok: true }
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptString } from "../_shared/crypto.ts";
import { revokeToken } from "../_shared/gmail-oauth.ts";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  // All of this user's connected accounts.
  const { data: accounts } = await sb
    .from("gmail_accounts")
    .select("id")
    .eq("user_id", user.id);

  for (const acct of accounts ?? []) {
    // Best-effort revoke using the stored refresh token, then delete.
    const { data: sec } = await sb
      .from("gmail_account_secrets")
      .select("refresh_token_enc")
      .eq("gmail_account_id", acct.id)
      .maybeSingle();
    if (sec?.refresh_token_enc) {
      try {
        await revokeToken(await decryptString(sec.refresh_token_enc));
      } catch (e) {
        console.error("revoke failed (continuing to purge):", e);
      }
    }
    // Cascade removes gmail_account_secrets.
    await sb.from("gmail_accounts").delete().eq("id", acct.id).eq("user_id", user.id);
  }

  return json({ ok: true });
});
