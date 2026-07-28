// ============================================================
// supabase/functions/_shared/a2p-assign.ts
//
// The one place that attaches an agent's owned number to their approved
// 10DLC campaign and writes the resulting state to the DB. Shared by:
//   - a2p-assign-number    (explicit agent-initiated assign)
//   - telnyx-buy-number    (best-effort auto-assign right after purchase)
// so both produce identical behavior, the same way messaging-send-core is
// shared across the send functions.
//
// Return-shape contract (callers depend on this, never the adapter's raw
// result):
//   { ok:true,  status:"assigned", ... }  Telnyx confirmed ASSIGNED now —
//        phone_numbers.a2p_campaign_id + sms_capable set.
//   { ok:true,  status:"pending",  ... }  submitted, PENDING_ASSIGNMENT —
//        a2p_campaign_id is deliberately NOT set yet; a2p-status-poll flips
//        it to assigned once the carrier confirms. Carrier propagation then
//        takes a further 24-72h before delivery is fully reliable.
//   { ok:false, status:"failed"|"precondition", reason, httpStatus }  a
//        precondition (not approved / not active / number cap) or a Telnyx
//        FAILED_ASSIGNMENT — reason is human-readable and surfaced to the UI.
// ============================================================
import { assignNumberToCampaign, ensureNumberOnMessagingProfile } from "./telnyx-10dlc-adapter.ts";

// deno-lint-ignore no-explicit-any
type Sb = { from: (t: string) => any };

export type AssignAgentNumberOutcome =
  | { ok: true; status: "assigned"; campaignId: string; alreadyAssigned: boolean }
  | { ok: true; status: "pending"; campaignId: string }
  | { ok: false; status: "failed" | "precondition"; reason: string; httpStatus: number };

async function recordFailure(sb: Sb, agentId: string, phoneNumberId: string, reason: string): Promise<void> {
  await sb.from("phone_numbers").update({
    a2p_assignment_status: "FAILED_ASSIGNMENT",
    sms_capable: false,
  }).eq("id", phoneNumberId);
  await sb.from("a2p_registrations").update({
    assignment_status: "FAILED_ASSIGNMENT",
    assignment_failure_reason: reason,
  }).eq("agent_id", agentId);
}

export async function assignAgentNumberToCampaign(
  sb: Sb,
  apiKey: string,
  messagingProfileId: string | undefined,
  agentId: string,
  phoneNumberId: string,
): Promise<AssignAgentNumberOutcome> {
  // 1. The number must exist, belong to this agent, and be active.
  const { data: pn } = await sb.from("phone_numbers")
    .select("id, e164, status, a2p_campaign_id, a2p_assignment_status")
    .eq("id", phoneNumberId)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (!pn) return { ok: false, status: "precondition", reason: "phone_number_not_found", httpStatus: 404 };
  if (pn.status !== "active") {
    return { ok: false, status: "precondition", reason: `phone_number_not_active: status is ${pn.status}`, httpStatus: 400 };
  }

  // 2. The agent's 10DLC campaign must be carrier-approved.
  const { data: reg } = await sb.from("a2p_registrations")
    .select("campaign_id, status, max_numbers, brand_type")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (!reg || reg.status !== "approved" || !reg.campaign_id) {
    return {
      ok: false,
      status: "precondition",
      reason: "a2p_not_approved: SMS/MMS is blocked until your A2P 10DLC brand + campaign registration is approved.",
      httpStatus: 400,
    };
  }
  const campaignId = reg.campaign_id as string;

  // 3. Idempotent: already assigned to this campaign -> return ok with no
  //    second Telnyx call.
  if (pn.a2p_campaign_id === campaignId) {
    return { ok: true, status: "assigned", campaignId, alreadyAssigned: true };
  }

  // 4. Per-brand number cap. Sole prop = 1 texting number per campaign
  //    (Telnyx hard limit); standard = 49. Counts numbers already ASSIGNED
  //    to this campaign (a2p_campaign_id set). TODO(PROMPT_15 Phase 2):
  //    also count PENDING_ASSIGNMENT numbers so two can't be submitted at
  //    once for a sole-prop brand.
  const isSoleProp = reg.brand_type === "sole_proprietor";
  const maxNumbers = typeof reg.max_numbers === "number" ? reg.max_numbers : (isSoleProp ? 1 : 49);
  const { count } = await sb.from("phone_numbers")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("a2p_campaign_id", campaignId);
  if ((count ?? 0) >= maxNumbers) {
    return {
      ok: false,
      status: "precondition",
      httpStatus: 409,
      reason: isSoleProp
        ? "sole_prop_one_number_limit: A Sole Proprietor 10DLC campaign can carry only ONE texting number. Unassign the current texting number before assigning a different one."
        : `campaign_number_limit_reached: this campaign already has its maximum of ${maxNumbers} assigned numbers.`,
    };
  }

  // 5. Make sure the number is on the account Messaging Profile before
  //    assigning — assignment fails otherwise. Self-heals legacy numbers
  //    bought before telnyx-buy-number attached the profile at purchase.
  if (messagingProfileId) {
    const ensured = await ensureNumberOnMessagingProfile(apiKey, pn.e164 as string, messagingProfileId);
    if (!ensured.ok) {
      await recordFailure(sb, agentId, pn.id as string, ensured.error ?? "messaging_profile_attach_failed");
      return { ok: false, status: "failed", reason: ensured.error ?? "messaging_profile_attach_failed", httpStatus: 502 };
    }
  }

  // 6. Assign.
  const result = await assignNumberToCampaign(apiKey, campaignId, pn.e164 as string);
  if (!result.ok) {
    await recordFailure(sb, agentId, pn.id as string, result.error ?? "assignment_failed");
    return { ok: false, status: "failed", reason: result.error ?? "assignment_failed", httpStatus: 502 };
  }

  const st = result.assignmentStatus;

  if (st === "ASSIGNED") {
    await sb.from("phone_numbers").update({
      a2p_campaign_id: campaignId,
      a2p_assignment_status: "ASSIGNED",
      a2p_assigned_at: new Date().toISOString(),
      sms_capable: true,
    }).eq("id", pn.id);
    await sb.from("a2p_registrations").update({
      assignment_status: "ASSIGNED",
      assignment_failure_reason: null,
    }).eq("agent_id", agentId);
    return { ok: true, status: "assigned", campaignId, alreadyAssigned: false };
  }

  if (st === "FAILED_ASSIGNMENT" || st === "FAILED_UNASSIGNMENT") {
    const reason = result.failureReasons ?? "Telnyx reported FAILED_ASSIGNMENT with no reason given.";
    await recordFailure(sb, agentId, pn.id as string, reason);
    return { ok: false, status: "failed", reason, httpStatus: 502 };
  }

  // PENDING_ASSIGNMENT (or any other non-terminal status): record the
  // pending state but do NOT set a2p_campaign_id / sms_capable yet — the
  // poller confirms it.
  await sb.from("phone_numbers").update({
    a2p_assignment_status: st ?? "PENDING_ASSIGNMENT",
  }).eq("id", pn.id);
  await sb.from("a2p_registrations").update({
    assignment_status: st ?? "PENDING_ASSIGNMENT",
    assignment_failure_reason: null,
  }).eq("agent_id", agentId);
  return { ok: true, status: "pending", campaignId };
}
