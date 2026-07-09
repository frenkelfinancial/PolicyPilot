// ============================================================
// supabase/functions/gmail-sync/index.ts
//
// The ingestion engine. For each active Gmail account: mint an access token,
// find new/recent messages, run the DETERMINISTIC classifier against the
// carrier_senders map, and record only carrier mail:
//   - route policy_tracker / commission_summary -> email_ingest_log (pending_parse)
//   - route nudge (login_link)                   -> email_ingest_log (nudged) + portal_nudges
//   - unclassified (known carrier domain)        -> email_ingest_log (review)
//   - route ignore / non-carrier                 -> counted, not stored, never sent to Claude
//
// No message BODIES are fetched and no LLM is called here — that is Step 3.
// This is the cheap pre-filter that keeps 95%+ of the inbox away from Claude.
//
// Invocation:
//   - Authenticated user (sb.functions.invoke) -> syncs that user's accounts.
//       Optional body { full_scan_days: N } forces a date-bounded scan (used by
//       the "Sync now" button) instead of the incremental history cursor.
//   - Service role bearer (pg_cron via pg_net, later) -> syncs ALL active accounts.
//
// REQUIRED secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENC_KEY.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptString } from "../_shared/crypto.ts";
import { refreshAccessToken } from "../_shared/gmail-oauth.ts";
import { classifyMessage } from "../_shared/email/classifier.ts";
import { CARRIER_SENDERS } from "../_shared/email/carrier-senders.ts";
import type { SenderRow } from "../_shared/email/types.ts";
import { getMessageMeta, listHistory, listMessageIds } from "../_shared/gmail-api.ts";
import { corsHeaders } from "../_shared/cors.ts";

// Distinct sender domains from the map -> a tight Gmail `from:(...)` filter so a
// date scan only lists carrier mail instead of the whole inbox.
function carrierQuery(senders: SenderRow[], days: number): string {
  const domains = new Set<string>();
  for (const s of senders) {
    const at = s.from_pattern.indexOf("@");
    if (at !== -1) domains.add(s.from_pattern.slice(at + 1));
  }
  const from = [...domains].map((d) => `from:${d}`).join(" OR ");
  return `newer_than:${days}d${from ? ` (${from})` : ""}`;
}

function clientHintFromSubject(subject: string): string | null {
  const m = subject.match(/Regarding\s+(.+?)\s*$/i);
  return m ? m[1].trim() : null;
}

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
  const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!CLIENT_ID || !CLIENT_SECRET || !Deno.env.get("TOKEN_ENC_KEY")) {
    return json({ error: "gmail_oauth_not_configured" }, 500);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({}));
  const fullScanDays: number | null = typeof body.full_scan_days === "number" ? body.full_scan_days : null;

  // ── Scope: a specific user (their JWT) or all accounts (service-role/cron) ──
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  let scopeUserId: string | null = null;
  const { data: { user } } = await sb.auth.getUser(token);
  if (user) {
    scopeUserId = user.id;
  } else if (token !== SERVICE_KEY) {
    return json({ error: "unauthorized" }, 401);
  }

  let acctQuery = sb.from("gmail_accounts").select("id, user_id, email_address, history_id, status").eq("status", "active");
  if (scopeUserId) acctQuery = acctQuery.eq("user_id", scopeUserId);
  const { data: accounts, error: acctErr } = await acctQuery;
  if (acctErr) return json({ error: "db_error", detail: acctErr.message }, 500);
  if (!accounts?.length) return json({ ok: true, accounts: 0, note: "no active accounts" });

  // Carrier map from DB; fall back to the code mirror if the table isn't seeded.
  const { data: dbSenders } = await sb
    .from("carrier_senders")
    .select("carrier, from_pattern, subject_pattern, email_type, content_type, route, priority, active");
  const senders: SenderRow[] = (dbSenders?.length ? dbSenders : CARRIER_SENDERS) as SenderRow[];

  const totals = {
    accounts: accounts.length, scanned: 0, matched: 0, pending: 0,
    nudges: 0, unclassified: 0, ignored: 0, skippedExisting: 0, reauthRequired: 0, errors: 0,
  };

  for (const acct of accounts) {
    try {
      // 1) Access token from the stored refresh token.
      const { data: sec } = await sb
        .from("gmail_account_secrets").select("refresh_token_enc").eq("gmail_account_id", acct.id).maybeSingle();
      if (!sec?.refresh_token_enc) { totals.errors++; continue; }

      const refreshToken = await decryptString(sec.refresh_token_enc);
      const tok = await refreshAccessToken({ refreshToken, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      if (tok.error || !tok.access_token) {
        if (tok.error === "invalid_grant") {
          await sb.from("gmail_accounts").update({ status: "reauth_required", updated_at: new Date().toISOString() }).eq("id", acct.id);
          totals.reauthRequired++;
        } else {
          console.error("token refresh failed:", acct.email_address, tok.error);
          totals.errors++;
        }
        continue;
      }
      const accessToken = tok.access_token;

      // 2) Candidate message ids: incremental history, or a date-bounded scan.
      let candidateIds: string[] = [];
      let newHistoryId: string | undefined;
      const doScan = fullScanDays != null || !acct.history_id;
      if (doScan) {
        candidateIds = await listMessageIds(accessToken, carrierQuery(senders, fullScanDays ?? 7));
      } else {
        const h = await listHistory(accessToken, acct.history_id);
        if (h.notFound) {
          candidateIds = await listMessageIds(accessToken, carrierQuery(senders, 7)); // stale cursor -> catch up
        } else {
          candidateIds = h.messageIds;
          newHistoryId = h.latestHistoryId;
        }
      }
      totals.scanned += candidateIds.length;

      // 3) Skip ids we already logged (idempotency + saves API calls).
      let fresh = candidateIds;
      if (candidateIds.length) {
        const { data: existing } = await sb
          .from("email_ingest_log").select("gmail_message_id")
          .eq("gmail_account_id", acct.id).in("gmail_message_id", candidateIds);
        const seen = new Set((existing ?? []).map((r) => r.gmail_message_id));
        const before = candidateIds.length;
        fresh = candidateIds.filter((id) => !seen.has(id));
        totals.skippedExisting += before - fresh.length;
      }

      // 4) Classify each fresh message and record carrier mail.
      for (const id of fresh) {
        const meta = await getMessageMeta(accessToken, id);
        const c = classifyMessage(meta.from, meta.subject, senders);
        if (!c) continue; // not a carrier email -> ignore silently

        if (c.status === "matched" && c.route === "ignore") { totals.ignored++; continue; }

        const isNudge = c.status === "matched" && c.route === "nudge";
        const parseStatus = c.status === "unclassified" ? "review" : (isNudge ? "nudged" : "pending_parse");

        const { data: inserted } = await sb
          .from("email_ingest_log")
          .upsert({
            user_id: acct.user_id,
            gmail_account_id: acct.id,
            gmail_message_id: id,
            carrier: c.carrier,
            email_type: c.status === "matched" ? c.email_type : "unclassified",
            content_type: c.status === "matched" ? c.content_type : null,
            route: c.route,
            from_address: meta.from,
            subject: meta.subject,
            received_at: meta.receivedAt,
            parse_status: parseStatus,
          }, { onConflict: "gmail_account_id,gmail_message_id", ignoreDuplicates: true })
          .select("id");

        const logRow = inserted?.[0];
        if (!logRow) { totals.skippedExisting++; continue; } // raced/duplicate

        totals.matched++;
        if (c.status === "unclassified") {
          totals.unclassified++;
        } else if (isNudge) {
          totals.nudges++;
          await sb.from("portal_nudges").insert({
            user_id: acct.user_id,
            carrier: c.carrier,
            subject: meta.subject,
            client_hint: clientHintFromSubject(meta.subject),
            received_at: meta.receivedAt,
            ingest_id: logRow.id,
          });
        } else {
          totals.pending++;
        }
      }

      // 5) Advance the cursor + stamp last sync.
      const patch: Record<string, unknown> = { last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      if (newHistoryId) patch.history_id = newHistoryId;
      await sb.from("gmail_accounts").update(patch).eq("id", acct.id);
    } catch (e) {
      console.error("sync error for", acct.email_address, e);
      totals.errors++;
    }
  }

  return json({ ok: true, ...totals });
});
