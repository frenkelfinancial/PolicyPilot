// ============================================================
// supabase/functions/email-pipeline/index.ts
//
// Cron orchestrator — runs the whole carrier-mail pipeline unattended:
//   gmail-sync → parse-email (looped until drained) → match-events
//
// Scheduled twice daily by pg_cron (see supabase/schedule_email_pipeline.sql):
// 9:00 AM and 5:00 PM US Central. Each step is invoked as its own edge
// function via HTTP with the service-role key, so every step keeps its own
// time budget and processes ALL connected accounts.
//
// parse-email caps itself at ROWS_PER_RUN (12) emails per invocation, so this
// orchestrator loops it (bounded) until it reports nothing pending — a normal
// half-day of carrier mail drains in one or two passes. Anything left over is
// idempotently picked up by the next scheduled run or a manual Sync & parse.
//
// Auth: invoked only by pg_cron with a dedicated EMAIL_PIPELINE_CRON_SECRET
// bearer token (not a Supabase JWT), so it is deployed with verify_jwt = false
// (see supabase/config.toml) and checks the secret internally — same pattern as
// the wallet/messaging cron functions. It fans out across every user, so no
// user JWT is accepted (the in-app button calls the three functions directly).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const MAX_PARSE_PASSES = 4; // 4 × 12 = up to 48 emails per scheduled run

serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET = Deno.env.get("EMAIL_PIPELINE_CRON_SECRET")!;

  // Inbound: pg_cron sends `Authorization: Bearer <EMAIL_PIPELINE_CRON_SECRET>`.
  // verify_jwt is off for this function (config.toml), so this is the only guard.
  // SERVICE_KEY (below) is still what fans out to the per-step functions.
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!CRON_SECRET || token !== CRON_SECRET) return json({ error: "unauthorized" }, 401);

  async function call(fn: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }

  const report: Record<string, unknown> = { started_at: new Date().toISOString() };

  // 1. Ingest new mail (incremental via Gmail history where available).
  report.sync = await call("gmail-sync");

  // 2. Extract, looping until the pending queue is drained (or pass cap hit).
  const parsePasses: Record<string, unknown>[] = [];
  for (let i = 0; i < MAX_PARSE_PASSES; i++) {
    const r = await call("parse-email");
    parsePasses.push(r);
    const drained = r.note === "nothing pending" ||
      ((Number(r.parsed) || 0) + (Number(r.review) || 0) + (Number(r.failed) || 0) + (Number(r.skippedCap) || 0)) === 0;
    if (drained || r.status !== 200) break;
  }
  report.parse = parsePasses;

  // 3. Match + apply to the policy tracker.
  report.match = await call("match-events");

  report.finished_at = new Date().toISOString();
  return json({ ok: true, ...report });
});
