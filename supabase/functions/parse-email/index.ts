// ============================================================
// supabase/functions/parse-email/index.ts
//
// Step 3 — extraction. Pulls `pending_parse` rows from email_ingest_log,
// fetches each email's body from Gmail, trims boilerplate, and runs ONE Haiku
// call per email (per-type schema, compact JSON) to produce structured
// `parsed_events`. The classifier already guaranteed these are carrier body
// emails — login-link/ignore/unclassified never reach here, so the API is only
// ever hit for mail that actually carries data.
//
// Cost guards (build plan task 14): per-invocation row cap + a global daily
// token budget; over budget => rows are left pending and marked skipped_cap.
// Tokens are logged per email on email_ingest_log.
//
// Invocation mirrors gmail-sync: a user's JWT scopes to their rows; the service
// role (cron, later) processes everyone. Body-only in v1 — content_type 'pdf'
// is routed to review (PDF text extraction is a later task).
//
// Required secrets: ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENC_KEY.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptString } from "../_shared/crypto.ts";
import { refreshAccessToken } from "../_shared/gmail-oauth.ts";
import { getMessageBody } from "../_shared/gmail-api.ts";
import { trimForExtraction } from "../_shared/email/cleaner.ts";
import { extractFields } from "../_shared/anthropic.ts";

const ALLOWED_ORIGINS = new Set(["https://producerstackcrm.com", "https://localhost"]);
function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://producerstackcrm.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const ROWS_PER_RUN = 12; // per-invocation cap
const CONFIDENCE_MIN = 0.5; // below this -> review instead of parsed
const DAILY_TOKEN_BUDGET = Number(Deno.env.get("PARSE_DAILY_TOKEN_BUDGET") ?? "400000");

// Coerce a model-supplied date into a Postgres-safe YYYY-MM-DD or null.
function safeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
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
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 500);
  if (!CLIENT_ID || !CLIENT_SECRET || !Deno.env.get("TOKEN_ENC_KEY")) {
    return json({ error: "gmail_oauth_not_configured" }, 500);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Scope: a user's JWT or the service role (cron).
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  let scopeUserId: string | null = null;
  const { data: { user } } = await sb.auth.getUser(token);
  if (user) scopeUserId = user.id;
  else if (token !== SERVICE_KEY) return json({ error: "unauthorized" }, 401);

  // ── Daily token budget ──
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { data: todays } = await sb
    .from("email_ingest_log")
    .select("claude_input_tokens, claude_output_tokens")
    .gte("created_at", startOfDay.toISOString());
  let tokensToday = (todays ?? []).reduce(
    (n, r) => n + (r.claude_input_tokens ?? 0) + (r.claude_output_tokens ?? 0),
    0,
  );

  // ── Pending rows ──
  let q = sb
    .from("email_ingest_log")
    .select("id, user_id, gmail_account_id, gmail_message_id, carrier, email_type, content_type, subject")
    .eq("parse_status", "pending_parse")
    .order("received_at", { ascending: true })
    .limit(ROWS_PER_RUN);
  if (scopeUserId) q = q.eq("user_id", scopeUserId);
  const { data: rows, error: rowsErr } = await q;
  if (rowsErr) return json({ error: "db_error", detail: rowsErr.message }, 500);
  if (!rows?.length) return json({ ok: true, parsed: 0, note: "nothing pending" });

  // Access tokens per account (refresh once, reuse across that account's rows).
  const tokenByAccount = new Map<string, string | null>();
  async function accessTokenFor(accountId: string): Promise<string | null> {
    if (tokenByAccount.has(accountId)) return tokenByAccount.get(accountId)!;
    let access: string | null = null;
    const { data: sec } = await sb
      .from("gmail_account_secrets").select("refresh_token_enc").eq("gmail_account_id", accountId).maybeSingle();
    if (sec?.refresh_token_enc) {
      const refreshToken = await decryptString(sec.refresh_token_enc);
      const tok = await refreshAccessToken({ refreshToken, clientId: CLIENT_ID!, clientSecret: CLIENT_SECRET! });
      if (tok.access_token) access = tok.access_token;
      else if (tok.error === "invalid_grant") {
        await sb.from("gmail_accounts").update({ status: "reauth_required" }).eq("id", accountId);
      }
    }
    tokenByAccount.set(accountId, access);
    return access;
  }

  const totals = { considered: rows.length, parsed: 0, events: 0, review: 0, failed: 0, skippedCap: 0 };

  for (const row of rows) {
    if (tokensToday >= DAILY_TOKEN_BUDGET) {
      await sb.from("email_ingest_log").update({ parse_status: "skipped_cap" }).eq("id", row.id);
      totals.skippedCap++;
      continue;
    }

    // PDF path is deferred — send to review with the PDF still in Gmail.
    if (row.content_type === "pdf") {
      await sb.from("email_ingest_log").update({ parse_status: "review", error: "pdf_unreadable_v1" }).eq("id", row.id);
      totals.review++;
      continue;
    }

    try {
      const accessToken = await accessTokenFor(row.gmail_account_id);
      if (!accessToken) {
        await sb.from("email_ingest_log").update({ parse_status: "failed", error: "no_access_token" }).eq("id", row.id);
        totals.failed++;
        continue;
      }

      const body = await getMessageBody(accessToken, row.gmail_message_id);
      const trimmed = trimForExtraction(body.text || body.html);
      if (!trimmed) {
        await sb.from("email_ingest_log").update({ parse_status: "review", error: "empty_body" }).eq("id", row.id);
        totals.review++;
        continue;
      }

      const { parsed, category, inputTokens, outputTokens } = await extractFields({
        apiKey: ANTHROPIC_API_KEY,
        emailType: row.email_type ?? "",
        carrier: row.carrier ?? "",
        subject: row.subject ?? "",
        text: trimmed,
      });
      tokensToday += inputTokens + outputTokens;

      const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;

      // Build parsed_events rows from the extraction.
      const eventRows: Record<string, unknown>[] = [];
      if (category === "policy") {
        const events = Array.isArray(parsed.events) ? parsed.events : [];
        for (const ev of events as Record<string, unknown>[]) {
          eventRows.push({
            ingest_id: row.id,
            user_id: row.user_id,
            carrier: row.carrier,
            event_type: String(ev.event_type ?? "other"),
            policy_number_raw: (ev.policy_number as string) ?? null,
            client_name: (ev.client_name as string) ?? null,
            amounts: { premium: ev.premium ?? null, face_amount: ev.face_amount ?? null },
            event_date: safeDate(ev.event_date),
            details: { summary: ev.summary ?? null },
            confidence,
          });
        }
      } else {
        eventRows.push({
          ingest_id: row.id,
          user_id: row.user_id,
          carrier: row.carrier,
          event_type: String(parsed.kind ?? "commission_snapshot"),
          policy_number_raw: null,
          client_name: null,
          amounts: {
            commission_balance: parsed.commission_balance ?? null,
            amount: parsed.amount ?? null,
            counts: parsed.counts ?? null,
          },
          event_date: safeDate(parsed.event_date),
          details: { summary: parsed.summary ?? null },
          confidence,
        });
      }

      if (eventRows.length) {
        const { error: insErr } = await sb.from("parsed_events").insert(eventRows);
        if (insErr) throw new Error(`parsed_events_insert: ${insErr.message}`);
      }

      const status = confidence >= CONFIDENCE_MIN && eventRows.length ? "parsed" : "review";
      await sb.from("email_ingest_log").update({
        parse_status: status,
        claude_input_tokens: inputTokens,
        claude_output_tokens: outputTokens,
        error: null,
      }).eq("id", row.id);

      if (status === "parsed") { totals.parsed++; totals.events += eventRows.length; }
      else totals.review++;
    } catch (e) {
      console.error("parse failed for", row.gmail_message_id, e);
      await sb.from("email_ingest_log").update({
        parse_status: "failed",
        error: String(e).slice(0, 300),
      }).eq("id", row.id);
      totals.failed++;
    }
  }

  return json({ ok: true, ...totals, tokensToday });
});
