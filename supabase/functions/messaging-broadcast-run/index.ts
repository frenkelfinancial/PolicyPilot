import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runComplianceGate } from "../_shared/messaging-shared.ts";
import { sendMessageCore } from "../_shared/messaging-send-core.ts";
import { classifyGateReason } from "../_shared/broadcast-gate.ts";
import { sendDelayMs } from "../_shared/broadcast-pacing.ts";

// Broadcast runner: drains PENDING public.broadcast_recipients rows for
// one or more `sending`/`queued` broadcasts in batches, calling the same
// shared send core as messaging-send-sms/mms (_shared/messaging-send-
// core.ts) so billing/never-charge behavior is identical to a single
// send. Every recipient goes through runComplianceGate — there is no
// bypass path.
//
//   pass          -> sendMessageCore (hold -> Telnyx -> messages row),
//                     mark broadcast_recipients 'sent', link message_id.
//   quiet_hours   -> DEFER: leave the row 'pending' untouched so a later
//                     run (cron or manual re-invoke) sends it once the
//                     recipient's local window opens. Never skipped.
//   other failure -> 'skipped' + skip_reason, zero holds placed.
//   a2p_not_approved -> HALT this broadcast entirely (campaign-wide
//                     block, not a per-recipient one) — every other
//                     pending recipient stays untouched for a later run.
//
// Cancel support: broadcast.status is re-read before each send; flipping
// it to 'canceled' (from anywhere) stops this run from processing any
// further pending recipients for that broadcast on its next check.
//
// Invocation: same secured pattern as the existing crons (bearer =
// WALLET_CRON_SECRET) — either a pg_cron sweep with no body (processes
// every queued/sending broadcast) or a targeted { broadcast_id } call
// from messaging-broadcast-create for small lists. Idempotent and
// resumable: a broadcast with pending recipients left after
// BATCH_SIZE_PER_BROADCAST is simply left 'queued' for the next run.
const BATCH_SIZE_PER_BROADCAST = 50;

Deno.serve(async (req) => {
  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET    = Deno.env.get("WALLET_CRON_SECRET");
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_MSG_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  const authHeader = req.headers.get("Authorization") || "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  let body: { broadcast_id?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine — cron sweep mode */ }
  const targetBroadcastId = typeof body.broadcast_id === "string" ? body.broadcast_id : null;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: billingConfig } = await sb.from("billing_config")
    .select("sms_max_tps")
    .eq("id", 1)
    .maybeSingle();
  const delayMs = sendDelayMs(billingConfig?.sms_max_tps ?? 1);

  let broadcastsQuery = sb.from("broadcasts")
    .select("id, agent_id, from_number, channel, body, media_url, status")
    .in("status", ["queued", "sending"])
    .order("created_at", { ascending: true });
  if (targetBroadcastId) broadcastsQuery = broadcastsQuery.eq("id", targetBroadcastId);
  const { data: broadcasts, error: broadcastsErr } = await broadcastsQuery;

  if (broadcastsErr) return json({ error: "fetch_broadcasts_failed", detail: broadcastsErr.message }, 500);

  const summary: Record<string, { sent: number; skipped: number; failed: number; deferred: number; halted: boolean; completed: boolean }> = {};

  for (const broadcast of broadcasts || []) {
    const stats = { sent: 0, skipped: 0, failed: 0, deferred: 0, halted: false, completed: false };
    summary[broadcast.id] = stats;

    if (broadcast.status === "queued") {
      await sb.from("broadcasts").update({ status: "sending", started_at: new Date().toISOString() }).eq("id", broadcast.id);
    }

    const { data: pending } = await sb.from("broadcast_recipients")
      .select("id, to_address")
      .eq("broadcast_id", broadcast.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE_PER_BROADCAST);

    for (const recipient of pending || []) {
      // Re-check cancellation before every send — a cancel flipped mid-run
      // must stop further processing immediately.
      const { data: fresh } = await sb.from("broadcasts").select("status").eq("id", broadcast.id).maybeSingle();
      if (fresh?.status === "canceled") break;

      const gate = await runComplianceGate(sb, broadcast.agent_id, broadcast.channel, recipient.to_address);

      if (!gate.ok) {
        const outcome = classifyGateReason(gate.reason);
        if (outcome.action === "defer") {
          stats.deferred++;
          continue;
        }
        if (outcome.action === "halt") {
          stats.halted = true;
          break;
        }
        await sb.from("broadcast_recipients").update({
          status: "skipped",
          skip_reason: outcome.skipReason,
        }).eq("id", recipient.id);
        stats.skipped++;
        continue;
      }

      const sendResult = await sendMessageCore(
        {
          agentId:    broadcast.agent_id,
          channel:    broadcast.channel,
          to:         gate.normalizedAddress,
          fromNumber: broadcast.from_number,
          text:       broadcast.body,
          mediaUrls:  broadcast.media_url ? [broadcast.media_url] : [],
          consentId:  gate.consentId,
        },
        { sb, supabaseUrl: SUPABASE_URL, telnyxApiKey: TELNYX_API_KEY, telnyxMessagingProfileId: TELNYX_MSG_PROFILE_ID },
      );

      if (!sendResult.ok) {
        await sb.from("broadcast_recipients").update({ status: "failed" }).eq("id", recipient.id);
        stats.failed++;
      } else {
        await sb.from("broadcast_recipients").update({
          status: "sent",
          message_id: sendResult.messageId,
        }).eq("id", recipient.id);
        stats.sent++;
      }

      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Roll the batch's outcome into the broadcast's running totals.
    const { data: current } = await sb.from("broadcasts")
      .select("sent_count, skipped_count, failed_count")
      .eq("id", broadcast.id)
      .maybeSingle();
    await sb.from("broadcasts").update({
      sent_count:    (current?.sent_count ?? 0) + stats.sent,
      skipped_count: (current?.skipped_count ?? 0) + stats.skipped,
      failed_count:  (current?.failed_count ?? 0) + stats.failed,
    }).eq("id", broadcast.id);

    const { count: pendingRemaining } = await sb.from("broadcast_recipients")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", broadcast.id)
      .eq("status", "pending");

    const { data: freshStatus } = await sb.from("broadcasts").select("status").eq("id", broadcast.id).maybeSingle();
    if (freshStatus?.status !== "canceled") {
      if ((pendingRemaining ?? 0) === 0) {
        await sb.from("broadcasts").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", broadcast.id);
        stats.completed = true;
      } else {
        // Batch limit reached, or a2p halt, or every remaining row is a
        // quiet-hours defer — leave 'queued' for the next run either way.
        await sb.from("broadcasts").update({ status: "queued" }).eq("id", broadcast.id);
      }
    }
  }

  return json({ ok: true, broadcasts_processed: (broadcasts || []).length, summary });
});
