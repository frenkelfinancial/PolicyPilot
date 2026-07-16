import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { associateNumbers } from "../_shared/telnyx-reputation.ts";

// Cron worker for Telnyx Number Reputation. Each run:
//   1. Syncs the two Telnyx approval gates (reputation status + LOA status)
//      into reputation_config so purchase-time hooks know when to register.
//   2. Backfills: associates every active local number that isn't registered
//      yet (covers numbers bought before setup finished, and any purchase-time
//      failures). Batched ≤100; a failed batch falls back to per-number so one
//      bad number can't block the rest (association is atomic per request).
//   3. Pulls cached reputation data (free) for all monitored numbers and
//      copies spam_risk / spam_category / scores onto phone_numbers for the UI.
//
// Telnyx re-checks numbers upstream on the check_frequency schedule set at
// enable time; this function only reads the cached results — it never forces
// fresh (billed) queries.
//
// Auth: dedicated REPUTATION_CRON_SECRET (same pattern as wallet-renew-numbers).
serve(async (req) => {
  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const CRON_SECRET    = Deno.env.get("REPUTATION_CRON_SECRET");

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization") || "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const telnyxHeaders = {
    "Authorization": `Bearer ${TELNYX_API_KEY}`,
    "Content-Type": "application/json",
  };

  // ---- 0. Load config; no-op until setup script has created the enterprise.
  const { data: cfg } = await sb.from("reputation_config")
    .select("enterprise_id, status, loa_status")
    .eq("id", 1)
    .maybeSingle();
  if (!cfg?.enterprise_id) {
    return json({ ok: true, skipped: "no_enterprise_configured" });
  }
  const entId = cfg.enterprise_id;

  // ---- 1. Sync approval gates from Telnyx.
  let status = cfg.status, loaStatus = cfg.loa_status;
  const settingsRes = await fetch(
    `https://api.telnyx.com/v2/enterprises/${entId}/reputation`,
    { headers: telnyxHeaders },
  );
  if (settingsRes.ok) {
    const settings = await settingsRes.json();
    status    = settings?.data?.status ?? status;
    loaStatus = settings?.data?.loa_status ?? loaStatus;
    await sb.from("reputation_config").update({
      status,
      loa_status: loaStatus,
      check_frequency: settings?.data?.check_frequency ?? null,
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
  } else {
    console.warn("[reputation-monitor] settings fetch failed:", await settingsRes.text());
  }

  const approved = status === "approved" && loaStatus === "approved";
  if (!approved) {
    return json({ ok: true, approved: false, status, loa_status: loaStatus });
  }

  // ---- 2. Backfill unregistered active local numbers.
  const { data: unregistered } = await sb.from("phone_numbers")
    .select("id, e164")
    .in("status", ["active", "past_due"])
    .eq("number_type", "local")
    .is("reputation_registered_at", null)
    .limit(500);

  let backfilled = 0, backfillErrors = 0;
  const rows = unregistered ?? [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const r = await associateNumbers(TELNYX_API_KEY, entId, chunk.map((n) => n.e164));
    if (r.ok) {
      await sb.from("phone_numbers")
        .update({ reputation_registered_at: new Date().toISOString() })
        .in("id", chunk.map((n) => n.id));
      backfilled += chunk.length;
    } else {
      // Atomic batch failed — retry one by one so a single bad number
      // (e.g. released at Telnyx but still in our DB) can't block the rest.
      console.warn("[reputation-monitor] batch associate failed, retrying singly:", r.error);
      for (const n of chunk) {
        const single = await associateNumbers(TELNYX_API_KEY, entId, [n.e164]);
        if (single.ok) {
          await sb.from("phone_numbers")
            .update({ reputation_registered_at: new Date().toISOString() })
            .eq("id", n.id);
          backfilled++;
        } else {
          backfillErrors++;
          console.warn(`[reputation-monitor] associate failed for ${n.e164}: ${single.error}`);
        }
      }
    }
  }

  // ---- 3. Copy cached reputation data onto phone_numbers.
  let updated = 0;
  const highRisk: string[] = [];
  for (let page = 1; page <= 40; page++) {
    const listRes = await fetch(
      `https://api.telnyx.com/v2/enterprises/${entId}/reputation/numbers?page[number]=${page}&page[size]=250`,
      { headers: telnyxHeaders },
    );
    if (!listRes.ok) {
      console.warn("[reputation-monitor] list failed:", await listRes.text());
      break;
    }
    const listData = await listRes.json();
    const entries = listData?.data ?? [];
    if (entries.length === 0) break;

    for (const entry of entries) {
      const rep = entry.reputation_data;
      if (!rep) continue; // no data yet — Telnyx hasn't completed first check
      const { error } = await sb.from("phone_numbers").update({
        spam_risk:     rep.spam_risk ?? null,
        spam_category: rep.spam_category ?? null,
        reputation_scores: {
          maturity:   rep.maturity_score ?? null,
          connection: rep.connection_score ?? null,
          engagement: rep.engagement_score ?? null,
          sentiment:  rep.sentiment_score ?? null,
        },
        reputation_checked_at: rep.last_refreshed_at ?? new Date().toISOString(),
      }).eq("e164", entry.phone_number);
      if (!error) updated++;
      if (rep.spam_risk === "high") highRisk.push(entry.phone_number);
    }
    if (entries.length < 250) break;
  }

  if (highRisk.length) {
    // Surfaced in the numbers UI via phone_numbers.spam_risk; logged here so
    // it also shows up in function logs for ops visibility.
    console.warn(`[reputation-monitor] HIGH spam risk numbers: ${highRisk.join(", ")}`);
  }

  return json({
    ok: true,
    approved: true,
    backfilled,
    backfill_errors: backfillErrors,
    scores_updated: updated,
    high_risk: highRisk,
  });
});
