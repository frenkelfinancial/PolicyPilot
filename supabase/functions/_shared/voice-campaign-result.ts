// ============================================================
// voice-campaign-result.ts
// What happens to a campaign enrollment when its call ends.
//
// This runs inside ai-call-webhook's finalize block, NOT inside
// voice-campaign-tick, and the reason is timing: an enrollment whose next step
// is "call again in two hours" must have that stamped the instant the call
// hangs up. Leaving it to the next tick would work, but it would also leave
// `claimed_at` set and `next_action_at` null for up to a minute — a window in
// which the campaign screen shows a lead as mid-call who is not on a call.
//
// The DECISION is not made here. vcAdvanceAfterCall() in voice-campaign-core.ts
// decides; this module reads the four facts it needs, calls it, and writes the
// answer down.
// ============================================================

import { vcAdvanceAfterCall, vcTalkSeconds } from "./voice-campaign-core.ts";
import type { VcStep } from "./voice-campaign-core.ts";

// A structural type, so this module can be unit-tested against a fake client
// without importing supabase-js.
interface Db {
  from(table: string): {
    select: (cols: string, opts?: unknown) => any;
    update: (patch: Record<string, unknown>) => any;
    insert: (row: Record<string, unknown>) => any;
  };
}

export interface CampaignCallRow {
  id: string;
  agent_id: string;
  lead_id: string | null;
  enrollment_id: string | null;
  outcome: string | null;
  answered_at: string | null;
  ended_at?: string | null;
  appointment_id?: string | null;
}

export interface CampaignResult {
  applied: boolean;
  reason?: string;
  decision?: string;
  status?: string;
  next_action_at?: string | null;
  stop_reason?: string | null;
  talk_secs?: number;
}

/**
 * Advance (or end) the enrollment this call belonged to.
 *
 * Returns `{applied:false}` and touches nothing for a call that no campaign
 * asked for — which is every manual and test-rig call, i.e. most of them.
 * Never throws: a campaign bookkeeping failure must not make Telnyx retry a
 * webhook that already billed and finalized the call.
 */
export async function recordCampaignCallResult(
  sb: Db,
  call: CampaignCallRow,
  endedAt: Date,
): Promise<CampaignResult> {
  if (!call || !call.enrollment_id) return { applied: false, reason: "not_a_campaign_call" };

  try {
    const { data: enr } = await sb.from("voice_campaign_enrollments")
      .select("id, campaign_id, agent_id, lead_id, status, current_step_position, step_attempts, answers, appointments, appointment_id")
      .eq("id", call.enrollment_id)
      .maybeSingle();
    // A stopped/completed enrollment does not come back to life because a call
    // that was already in the air finished. Whatever stopped it — an
    // appointment, a DNC, a hand on the Unenroll button — wins.
    if (!enr || enr.status !== "active") {
      return { applied: false, reason: enr ? `enrollment_${enr.status}` : "enrollment_missing" };
    }

    const [{ data: campaign }, { data: steps }, { data: lead }, { data: appt }] = await Promise.all([
      sb.from("voice_campaigns")
        .select("id, name, active, campaign_goal, stop_on_appointment_booked, stop_on_sold, stop_on_answered, stop_answer_talk_secs")
        .eq("id", enr.campaign_id).maybeSingle(),
      sb.from("voice_campaign_steps")
        .select("id, position, step_type, wait_value, wait_unit, drip_rate, anchor, offset_minutes")
        .eq("campaign_id", enr.campaign_id).order("position", { ascending: true }),
      call.lead_id
        ? sb.from("leads").select("id, data, dnc").eq("id", call.lead_id).maybeSingle()
        : Promise.resolve({ data: null }),
      // The appointment an anchored campaign is counting down to. Read here
      // rather than passed in, because the reminder that runs NEXT has to be
      // measured against the appointment as it stands now — somebody may have
      // moved it while this very call was in the air.
      enr.appointment_id
        ? sb.from("ai_appointments").select("id, starts_at").eq("id", enr.appointment_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    if (!campaign) return { applied: false, reason: "campaign_missing" };

    const leadData = (lead?.data || {}) as Record<string, unknown>;
    const leadSold = String(leadData.status || "").toLowerCase() === "sold";

    const facts = {
      outcome: call.outcome,
      answered_at: call.answered_at,
      ended_at: (call.ended_at || endedAt.toISOString()),
      appointment_booked: !!call.appointment_id,
      // The lead leg's own DNC flag, set by the webhook the moment a
      // dnc_request outcome lands. This is the belt to that braces.
      dnc: lead?.dnc === true,
    };

    const talk = vcTalkSeconds(facts);
    const answered = !!call.answered_at;

    const adv = vcAdvanceAfterCall({
      campaign,
      steps: (steps || []) as VcStep[],
      enrollment: {
        status: enr.status,
        current_step_position: enr.current_step_position,
        step_attempts: enr.step_attempts,
        next_action_at: null,
      },
      call: facts,
      leadSold,
      leadDnc: lead?.dnc === true,
      now: endedAt,
      appointmentAt: (appt as { starts_at?: string | null } | null)?.starts_at ?? null,
    });

    const patch: Record<string, unknown> = {
      status: adv.status,
      current_step_position: adv.current_step_position,
      step_attempts: adv.step_attempts,
      next_action_at: adv.next_action_at,
      stop_reason: adv.stop_reason,
      // Release the claim. Until this line runs, the tick will not pick this
      // enrollment up again — which is exactly what stops a second call going
      // out while the first is still connected.
      claimed_at: null,
      last_ai_call_id: call.id,
      answers: (enr.answers || 0) + (answered ? 1 : 0),
      appointments: (enr.appointments || 0) + (call.appointment_id ? 1 : 0),
      updated_at: endedAt.toISOString(),
    };
    if (adv.status !== "active") patch.completed_at = endedAt.toISOString();

    await sb.from("voice_campaign_enrollments").update(patch).eq("id", enr.id);

    return {
      applied: true,
      decision: adv.decision,
      status: adv.status,
      next_action_at: adv.next_action_at,
      stop_reason: adv.stop_reason,
      talk_secs: talk,
    };
  } catch (e) {
    // Deliberately swallowed. See the header: the call is already finalized and
    // debited, and a 500 here would have Telnyx replay the whole thing.
    console.error("[voice-campaign-result]", (e as Error)?.message || e);
    return { applied: false, reason: "error" };
  }
}
