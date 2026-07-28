import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getBrandStatus, getCampaignStatus, getNumberAssignmentStatus } from "../_shared/telnyx-10dlc-adapter.ts";

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
// It ALSO runs an assignment-confirmation pass (PROMPT_15 Phase 1.4):
// numbers left at PENDING_ASSIGNMENT by a2p-assign-number / the buy-time
// auto-assign are flipped to ASSIGNED (setting a2p_campaign_id + sms_capable)
// once Telnyx's per-number getNumberAssignmentStatus reports ASSIGNED.
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

  // ------------------------------------------------------------
  // Assignment-confirmation pass (PROMPT_15 Phase 1.4): for every number
  // sitting at PENDING_ASSIGNMENT, ask Telnyx for that number's campaign
  // assignment directly and flip to ASSIGNED once the carrier confirms it.
  // On confirm we set a2p_campaign_id + sms_capable (the send gate) — the
  // manual/auto assign path deliberately left them unset while pending.
  //
  // Uses the per-number GET /v2/10dlc/phone_number_campaigns/{e164}
  // (getNumberAssignmentStatus) — verified 2026-07-27 to be exact (404 when
  // not yet assigned), unlike the /10dlc list's unconfirmed filter[campaignId].
  // We need the campaign_id only to record it on confirm, from the agent's reg.
  // ------------------------------------------------------------
  const asg = { assignments_confirmed: 0, assignments_still_pending: 0, assignments_failed: 0, assignment_errors: 0 };
  const { data: pendingNums } = await sb.from("phone_numbers")
    .select("id, e164, agent_id")
    .eq("a2p_assignment_status", "PENDING_ASSIGNMENT");

  if (pendingNums && pendingNums.length) {
    const agentIds = [...new Set(pendingNums.map((n) => n.agent_id as string))];
    const { data: regs } = await sb.from("a2p_registrations")
      .select("agent_id, campaign_id, status")
      .in("agent_id", agentIds);
    const campaignForAgent = new Map<string, string>();
    for (const r of regs || []) {
      if (r.status === "approved" && r.campaign_id) campaignForAgent.set(r.agent_id as string, r.campaign_id as string);
    }

    for (const num of pendingNums) {
      try {
        const campaignId = campaignForAgent.get(num.agent_id as string);
        if (!campaignId) { asg.assignment_errors++; continue; }

        const st = await getNumberAssignmentStatus(TELNYX_API_KEY, num.e164 as string);
        if (!st.ok) { asg.assignment_errors++; continue; }

        if (st.found && st.assignmentStatus === "ASSIGNED") {
          await sb.from("phone_numbers").update({
            a2p_campaign_id: campaignId,
            a2p_assignment_status: "ASSIGNED",
            a2p_assigned_at: new Date().toISOString(),
            sms_capable: true,
          }).eq("id", num.id);
          await sb.from("a2p_registrations").update({
            assignment_status: "ASSIGNED",
            assignment_failure_reason: null,
          }).eq("agent_id", num.agent_id);
          asg.assignments_confirmed++;
        } else if (st.found && st.assignmentStatus === "FAILED_ASSIGNMENT") {
          await sb.from("phone_numbers").update({
            a2p_assignment_status: "FAILED_ASSIGNMENT",
            sms_capable: false,
          }).eq("id", num.id);
          await sb.from("a2p_registrations").update({
            assignment_status: "FAILED_ASSIGNMENT",
            assignment_failure_reason: st.failureReasons || "Telnyx reported FAILED_ASSIGNMENT for this number during status poll.",
          }).eq("agent_id", num.agent_id);
          asg.assignments_failed++;
        } else {
          // Not found yet (404) or still PENDING_ASSIGNMENT — leave pending
          // and re-check next run.
          asg.assignments_still_pending++;
        }
      } catch (err) {
        console.error(`[a2p-status-poll] assignment confirm failed for number ${num.id}:`, (err as Error)?.message || err);
        asg.assignment_errors++;
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, ...results, ...asg }), {
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
