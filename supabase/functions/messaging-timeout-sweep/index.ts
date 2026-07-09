import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Cron worker: voids any pending wallet_hold for a message that never got a
// final delivery receipt within billing_config.message_dlr_timeout_hours.
// This is the safety net behind never-charge-undelivered — a carrier or
// provider that silently drops a DLR must not leave money held forever
// (and never charged, since a timeout is exactly the "we don't know it
// delivered" case that undelivered = $0 covers).
//
// Idempotent: only ever selects messages whose status is still queued/sent
// (i.e. never resolved) and older than the timeout; wallet_void raises
// 'not_a_pending_hold' if the row already resolved between the select and
// the void call (e.g. a delivery webhook landed a moment later) — caught
// and skipped rather than erroring.
//
// Scheduled via pg_cron (e.g. hourly) — see the cron.schedule(...) note at
// the bottom of this file. Authenticated with WALLET_CRON_SECRET, same
// pattern as wallet-renew-numbers / wallet-low-balance-notify.
Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET  = Deno.env.get("WALLET_CRON_SECRET");

  const authHeader = req.headers.get("Authorization") || "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: billingConfig } = await sb.from("billing_config")
    .select("message_dlr_timeout_hours")
    .eq("id", 1)
    .maybeSingle();
  const timeoutHours = billingConfig?.message_dlr_timeout_hours ?? 24;
  const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000).toISOString();

  const { data: stale, error: fetchErr } = await sb.from("messages")
    .select("id, hold_ledger_id")
    .in("status", ["queued", "sent"])
    .not("hold_ledger_id", "is", null)
    .lt("created_at", cutoff);

  if (fetchErr) {
    return new Response(JSON.stringify({ error: "fetch_failed", detail: fetchErr.message }), { status: 500 });
  }

  const results = { voided: 0, already_resolved: 0, errors: 0 };

  for (const msg of stale || []) {
    const { error } = await sb.rpc("wallet_void", { p_ledger_id: msg.hold_ledger_id });
    if (error) {
      if (error.message?.includes("not_a_pending_hold")) {
        results.already_resolved++;
      } else {
        console.error(`[messaging-timeout-sweep] void failed for message ${msg.id}:`, error.message);
        results.errors++;
      }
      continue;
    }

    await sb.from("messages").update({
      status: "undelivered",
      failed_reason: `timeout_no_dlr (>${timeoutHours}h with no delivery receipt)`,
    }).eq("id", msg.id);
    results.voided++;
  }

  return new Response(JSON.stringify({ ok: true, ...results }), {
    headers: { "Content-Type": "application/json" },
  });
});

// ------------------------------------------------------------
// Deliverable for Cowork: schedule via pg_cron once deployed (same shape
// as the wallet-renew-numbers cron already running):
//
//   select cron.schedule(
//     'messaging-timeout-sweep',
//     '0 * * * *',  -- hourly; idempotent so any cadence is safe
//     $$
//     select net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/messaging-timeout-sweep',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer <WALLET_CRON_SECRET>',
//         'Content-Type',  'application/json'
//       )
//     );
//     $$
//   );
// ------------------------------------------------------------
