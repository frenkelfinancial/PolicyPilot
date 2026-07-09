import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getBrandStatus, getCampaignStatus } from "../_shared/telnyx-10dlc-adapter.ts";

// Cron worker: polls Telnyx for every agent's 10DLC brand/campaign status
// and keeps a2p_registrations.status in sync. Two groups are polled:
//   - status = 'pending'  -> initial review, flips to approved/rejected.
//   - status = 'approved' -> re-checked so a campaign Telnyx suspends or
//     lets expire AFTER approval is caught too, not just on first review.
//     (The compliance gate only allowlists status === 'approved', so this
//     is the only way a post-approval suspension/expiry ever reaches it —
//     see the comment on the a2p_registrations status CHECK in
//     019_messaging_compliance.sql.)
// approved requires BOTH brand and campaign approved; either side rejected
// -> rejected (with rejection_reason), which lets the agent re-register
// (a2p-register allows resubmission when status = 'rejected'). suspended/
// expired map through once _shared/telnyx-10dlc-adapter.ts's normalizeStatus
// TODO is filled in with Telnyx's real raw status strings — until then they
// surface as "pending" from the adapter and this poll takes no action,
// which is a safe (if inert) default, not a false "still approved".
//
// Authenticated with WALLET_CRON_SECRET, same pattern as the other wallet
// cron functions. Scheduled via pg_cron — see the cron.schedule(...) note
// at the bottom of this file.
Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET  = Deno.env.get("WALLET_CRON_SECRET");
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");

  const authHeader = req.headers.get("Authorization") || "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  if (!TELNYX_API_KEY) return new Response(JSON.stringify({ error: "telnyx_not_configured" }), { status: 500 });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: toCheck, error: fetchErr } = await sb.from("a2p_registrations")
    .select("agent_id, brand_id, campaign_id, status")
    .in("status", ["pending", "approved"])
    .not("brand_id", "is", null)
    .not("campaign_id", "is", null);

  if (fetchErr) {
    return new Response(JSON.stringify({ error: "fetch_failed", detail: fetchErr.message }), { status: 500 });
  }

  const results = { approved: 0, rejected: 0, suspended: 0, expired: 0, still_pending: 0, unchanged: 0, errors: 0 };

  for (const reg of toCheck || []) {
    try {
      const [brand, campaign] = await Promise.all([
        getBrandStatus(TELNYX_API_KEY, reg.brand_id as string),
        getCampaignStatus(TELNYX_API_KEY, reg.campaign_id as string),
      ]);

      const sideWith = (s: string) => (brand.status === s ? brand : campaign.status === s ? campaign : null);

      if (sideWith("rejected")) {
        await sb.from("a2p_registrations").update({
          status: "rejected",
          rejection_reason: brand.status === "rejected"
            ? `Brand rejected: ${brand.raw || "no reason given"}`
            : `Campaign rejected: ${campaign.raw || "no reason given"}`,
        }).eq("agent_id", reg.agent_id);
        results.rejected++;
      } else if (sideWith("suspended")) {
        await sb.from("a2p_registrations").update({
          status: "suspended",
          rejection_reason: `Suspended — brand:${brand.raw || brand.status} campaign:${campaign.raw || campaign.status}`,
        }).eq("agent_id", reg.agent_id);
        results.suspended++;
      } else if (sideWith("expired")) {
        await sb.from("a2p_registrations").update({
          status: "expired",
          rejection_reason: `Expired — brand:${brand.raw || brand.status} campaign:${campaign.raw || campaign.status}`,
        }).eq("agent_id", reg.agent_id);
        results.expired++;
      } else if (brand.status === "approved" && campaign.status === "approved") {
        if (reg.status !== "approved") {
          await sb.from("a2p_registrations").update({ status: "approved" }).eq("agent_id", reg.agent_id);
          results.approved++;
        } else {
          results.unchanged++;
        }
      } else {
        results.still_pending++;
      }
    } catch (err) {
      console.error(`[a2p-status-poll] poll failed for agent ${reg.agent_id}:`, (err as Error)?.message || err);
      results.errors++;
    }
  }

  return new Response(JSON.stringify({ ok: true, ...results }), {
    headers: { "Content-Type": "application/json" },
  });
});

// ------------------------------------------------------------
// Deliverable for Cowork: schedule via pg_cron once deployed:
//
//   select cron.schedule(
//     'a2p-status-poll',
//     '*/30 * * * *',  -- every 30 min; idempotent so any cadence is safe
//     $$
//     select net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/a2p-status-poll',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer <WALLET_CRON_SECRET>',
//         'Content-Type',  'application/json'
//       )
//     );
//     $$
//   );
// ------------------------------------------------------------
