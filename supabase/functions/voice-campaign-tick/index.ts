import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toE164 } from "../_shared/phone.ts";
import {
  isWithinAllowedHours,
  isWithinAllowedHoursUnknownTz,
  knownTimezoneForPhone,
} from "../_shared/tcpa.ts";
import { localDayWindow, resolveAgentTimezone } from "../_shared/ai-call-meter.ts";
import { vcClaimEnrollment } from "../_shared/voice-campaign-claim.ts";
import {
  VC_CLAIM_LEASE_SECS,
  VC_MAX_DIALS_PER_TICK,
  vcAdvanceAfterCall,
  vcCampaignVars,
  vcDripAllows,
  vcDripWindowStart,
  vcEvaluateEnrollment,
  vcFirstStep,
  vcHandleGateRejection,
  vcMatchesTriggerGroups,
  vcNextAllowedInstant,
  vcPickCallerId,
  vcSlotsFree,
  vcSlotsInUse,
  vcStepAt,
  vcStepDueAt,
  vcStepsSorted,
} from "../_shared/voice-campaign-core.ts";
import type { VcStep } from "../_shared/voice-campaign-core.ts";

// ============================================================
// voice-campaign-tick — the campaign scheduler. One minute at a time.
//
// Read docs/voice-campaigns.md first. The decisions are there; this is the
// loop that executes them.
//
// ---- The decision order, per agent -----------------------------------------
//
//   1. SWEEP    stop conditions that came from state, not from a call (sold,
//               booked, DNC'd, campaign deactivated); then enroll new matches.
//   2. SLOTS    how many of this agent's three campaign lines are free. Zero
//               free means the agent dials nothing this minute — everything
//               below is skipped and nothing is claimed.
//   3. DUE      active enrollments with next_action_at <= now, oldest first,
//               belonging to an active, unpaused campaign.
//   4. CLAIM    an atomic update…returning per enrollment. A tick that dies
//               after this and re-fires a minute later cannot re-dial the same
//               lead; the claim leases (VC_CLAIM_LEASE_SECS) so a genuinely
//               dead tick does not strand anyone.
//   5. DRIP     the step's own throttle, counted over a rolling window.
//   6. DIAL     ai-call-start, with an explicitly rotated caller ID.
//   7. REJECT   whatever the gate said, handled by code — reschedule, pause the
//               campaign, or stop the enrollment. See vcHandleGateRejection.
//
// ---- What this function does NOT do ----------------------------------------
//
// It does not check consent, DNC, suppression, quiet hours, the daily cap or
// the wallet floor. ai-call-start does, on every single call, and there is no
// second copy of any of them here. What this function owns is what to do when
// the answer is no.
//
// It also does not decide what happens AFTER a call — ai-call-webhook's
// finalize block calls recordCampaignCallResult() for that, because the
// enrollment has to advance the moment the call ends, not up to a minute later.
//
// ---- Auth ------------------------------------------------------------------
//
// Bearer VOICE_CAMPAIGN_CRON_SECRET, same pattern as email-pipeline's
// EMAIL_PIPELINE_CRON_SECRET and the wallet crons' WALLET_CRON_SECRET.
// verify_jwt = false in supabase/config.toml (pg_cron has no Supabase JWT).
// ============================================================

/** Enrollment sweep: how many leads one campaign may enroll per tick. */
const ENROLL_LIMIT_PER_CAMPAIGN = 200;

/** How far back the sweep looks for leads it has not seen. */
const BOOK_PAGE = 2000;

interface TraceEntry {
  agent_id?: string;
  campaign_id?: string;
  enrollment_id?: string;
  lead_id?: string;
  event: string;
  detail?: unknown;
}

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET  = Deno.env.get("VOICE_CAMPAIGN_CRON_SECRET");

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const authHeader = req.headers.get("Authorization") || "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = new Date();
  const nowIso = now.toISOString();

  // A caller may scope one tick to one agent or one campaign. The cron sends
  // nothing and sweeps everybody; the dry-run trace uses the scoped form.
  let body: { agent_id?: unknown; campaign_id?: unknown; trace?: unknown } = {};
  try { body = await req.json(); } catch { /* cron sends no body */ }
  const scopeAgent    = typeof body.agent_id === "string" ? body.agent_id : null;
  const scopeCampaign = typeof body.campaign_id === "string" ? body.campaign_id : null;
  const wantTrace     = body.trace === true;

  const trace: TraceEntry[] = [];
  const say = (e: TraceEntry) => { if (wantTrace) trace.push(e); };

  // ------------------------------------------------------------
  // Every campaign that is running right now. A tick with none is a single
  // indexed query and nothing else — a cheap no-op, which matters when this
  // fires 1,440 times a day.
  // ------------------------------------------------------------
  let campQ = sb.from("voice_campaigns")
    .select(
      "id, agent_id, name, active, dry_run, trigger_groups, auto_enroll_new_leads, " +
      "trigger_on_missed_appointment, trigger_on_sold, stop_on_appointment_booked, " +
      "stop_on_sold, stop_on_answered, stop_answer_talk_secs, paused_at, pause_reason",
    )
    .eq("active", true)
    .is("paused_at", null);
  if (scopeAgent)    campQ = campQ.eq("agent_id", scopeAgent);
  if (scopeCampaign) campQ = campQ.eq("id", scopeCampaign);

  const { data: campaigns, error: campErr } = await campQ;
  if (campErr) return json({ error: "campaign_fetch_failed", detail: campErr.message }, 500);
  if (!campaigns || !campaigns.length) {
    return json({ ok: true, agents: 0, campaigns: 0, enrolled: 0, dialed: 0, note: "nothing active" });
  }

  // Group by agent — slots, the caller-ID pool and the daily meter are all
  // per-agent facts, and reading them once per campaign would be wasteful and
  // (for the rotation) wrong.
  const byAgent = new Map<string, typeof campaigns>();
  for (const c of campaigns) {
    const list = byAgent.get(c.agent_id) || [];
    list.push(c);
    byAgent.set(c.agent_id, list);
  }

  const totals = {
    agents: byAgent.size,
    campaigns: campaigns.length,
    enrolled: 0,
    stopped: 0,
    dialed: 0,
    dry_run: 0,
    deferred: 0,
    paused: 0,
    slot_blocked: 0,
    drip_blocked: 0,
    errors: 0,
  };

  for (const [agentId, agentCampaigns] of byAgent) {
    try {
      await runAgent(agentId, agentCampaigns);
    } catch (e) {
      totals.errors++;
      console.error("[voice-campaign-tick] agent", agentId, (e as Error)?.message || e);
      say({ agent_id: agentId, event: "agent_error", detail: (e as Error)?.message });
    }
  }

  return json({ ok: true, ...totals, ...(wantTrace ? { trace } : {}) });

  // ============================================================
  // One agent
  // ============================================================
  async function runAgent(agentId: string, agentCampaigns: typeof campaigns) {
    const campaignIds = agentCampaigns.map((c) => c.id);

    const [{ data: agent }, { data: numbers }, { data: inflight }] = await Promise.all([
      sb.from("agents").select("id, timezone, ai_dialer_enabled").eq("id", agentId).maybeSingle(),
      sb.from("phone_numbers").select("e164, ai_first_used_at")
        .eq("agent_id", agentId).eq("status", "active"),
      // Slot count: this agent's CAMPAIGN calls that are still in the air.
      // Manual test-rig calls deliberately do not consume a campaign slot —
      // the agent placing one by hand is a different queue.
      sb.from("ai_calls").select("id, status, created_at, ended_at")
        .eq("agent_id", agentId)
        .eq("status", "in_progress")
        .not("campaign_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    const tz = resolveAgentTimezone(agent as { timezone?: unknown } | null);

    // ---------- 1. Sweep ----------------------------------------------------
    for (const campaign of agentCampaigns) {
      await sweepStops(agentId, campaign);
      await sweepEnrollments(agentId, campaign, tz);
    }

    // ---------- 2. Slots ----------------------------------------------------
    const inUse = vcSlotsInUse(inflight || [], now);
    let free = vcSlotsFree(inUse);
    say({ agent_id: agentId, event: "slots", detail: { in_use: inUse, free } });
    if (free <= 0) {
      totals.slot_blocked++;
      return;
    }

    // ---------- 3. Due ------------------------------------------------------
    const staleIso = new Date(now.getTime() - VC_CLAIM_LEASE_SECS * 1000).toISOString();
    const { data: due } = await sb.from("voice_campaign_enrollments")
      .select("id, campaign_id, agent_id, lead_id, status, current_step_position, step_attempts, next_action_at, claimed_at")
      .eq("agent_id", agentId)
      .eq("status", "active")
      .in("campaign_id", campaignIds)
      .lte("next_action_at", nowIso)
      .or(`claimed_at.is.null,claimed_at.lt.${staleIso}`)
      .order("next_action_at", { ascending: true })
      .limit(VC_MAX_DIALS_PER_TICK * 2);

    if (!due || !due.length) return;

    // Steps, once, for every campaign this agent is running.
    const { data: allSteps } = await sb.from("voice_campaign_steps")
      .select("id, campaign_id, position, step_type, wait_value, wait_unit, drip_rate")
      .in("campaign_id", campaignIds)
      .order("position", { ascending: true });
    const stepsByCampaign = new Map<string, VcStep[]>();
    for (const s of allSteps || []) {
      const list = stepsByCampaign.get(s.campaign_id) || [];
      list.push(s as VcStep);
      stepsByCampaign.set(s.campaign_id, list);
    }

    // Per-number usage today, for the rotation. ONE query for the agent's whole
    // day, not one per call.
    const dayWin = localDayWindow(now, tz);
    const { data: todaysCalls } = await sb.from("ai_calls")
      .select("from_e164")
      .eq("agent_id", agentId)
      .eq("direction", "outbound")
      .gte("created_at", dayWin.startIso)
      .lt("created_at", dayWin.endIso);
    const usage: Record<string, number> = {};
    for (const c of todaysCalls || []) {
      const e = typeof c.from_e164 === "string" ? c.from_e164 : "";
      if (e) usage[e] = (usage[e] || 0) + 1;
    }

    // Campaigns paused mid-loop must stop being dialed within the same tick.
    const pausedThisTick = new Set<string>();
    let dialedThisAgent = 0;

    for (const enr of due) {
      if (free <= 0 || dialedThisAgent >= VC_MAX_DIALS_PER_TICK) break;
      if (pausedThisTick.has(enr.campaign_id)) continue;

      const campaign = agentCampaigns.find((c) => c.id === enr.campaign_id);
      if (!campaign) continue;

      const steps = vcStepsSorted(stepsByCampaign.get(campaign.id) || []);
      const step  = vcStepAt(steps, enr.current_step_position);
      if (!step) {
        // The step was deleted underneath a live enrollment. Completing is the
        // honest answer: there is nothing left to do to this lead, and leaving
        // the row active would re-ask this question every minute for ever.
        await finishEnrollment(enr.id, "completed", null);
        say({ agent_id: agentId, campaign_id: campaign.id, enrollment_id: enr.id, event: "step_missing_completed" });
        continue;
      }

      // ---------- 5. Drip ---------------------------------------------------
      const windowStart = vcDripWindowStart(now, step.drip_rate);
      if (windowStart) {
        const { count } = await sb.from("ai_calls")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", campaign.id)
          .eq("campaign_step", step.position)
          .gte("created_at", windowStart.toISOString());
        const verdict = vcDripAllows({ drip: step.drip_rate, placedInWindow: count || 0 });
        if (!verdict.allowed) {
          // NOT a failure and NOT rescheduled: the enrollment stays due and the
          // next tick tries again, which is how a 20-per-hour step drains over
          // the hour by itself.
          totals.drip_blocked++;
          say({
            agent_id: agentId, campaign_id: campaign.id, enrollment_id: enr.id,
            event: "drip_throttled", detail: { placed_in_window: count || 0, drip: step.drip_rate },
          });
          continue;
        }
      }

      // ---------- 4. Claim --------------------------------------------------
      // See _shared/voice-campaign-claim.ts — the one write that makes a
      // re-fired tick safe. Losing the claim is normal, not an error.
      const claimed = await vcClaimEnrollment(sb, enr.id, nowIso, staleIso);
      if (!claimed) {
        say({ agent_id: agentId, enrollment_id: enr.id, event: "claim_lost" });
        continue;
      }

      // ---------- 6. Dial ---------------------------------------------------
      const caller = vcPickCallerId(numbers || [], usage, now, tz);
      const vars   = vcCampaignVars(campaign, step);
      const isDry  = campaign.dry_run === true;

      const payload: Record<string, unknown> = {
        agent_id:      agentId,
        lead_id:       claimed.lead_id,
        enrollment_id: claimed.id,
        campaign_id:   campaign.id,
        campaign_step: step.position,
        campaign_name: vars.campaign_name,
      };
      if (caller) payload.caller_id = caller.e164;
      if (isDry)  payload.dry_run = true;

      let res: Response | null = null;
      let out: Record<string, unknown> = {};
      try {
        res = await fetch(`${SUPABASE_URL}/functions/v1/ai-call-start`, {
          method: "POST",
          headers: {
            // The service key is what identifies this as the internal caller.
            "Authorization": `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        out = await res.json().catch(() => ({}));
      } catch (e) {
        out = { error: "network_error", detail: (e as Error)?.message };
      }

      if (res && res.ok && out.ok) {
        // Count the number we actually went out on, not the one we asked for.
        const used = typeof out.from_e164 === "string" ? out.from_e164 : caller?.e164 || "";
        if (used) usage[used] = (usage[used] || 0) + 1;

        if (isDry) {
          // A dry run proves claim -> gate -> schedule. Advance the enrollment
          // exactly as a no-answer would, so the whole path is exercised and
          // the campaign does not sit on the same step for ever.
          totals.dry_run++;
          const adv = vcAdvanceAfterCall({
            campaign, steps,
            enrollment: {
              status: "active",
              current_step_position: claimed.current_step_position,
              // +1 because a real dial increments this before the webhook
              // reads it. Passing the un-incremented value would make a
              // double-dial step retry for ever on a dry run.
              step_attempts: (claimed.step_attempts || 0) + 1,
              next_action_at: null,
            },
            call: { outcome: "no_answer", answered_at: null, ended_at: null },
            now,
          });
          await applyAdvance(claimed.id, adv, { countCall: true });
          say({
            agent_id: agentId, campaign_id: campaign.id, enrollment_id: claimed.id,
            lead_id: claimed.lead_id, event: "dry_run_would_dial",
            detail: { would_dial: out.would_dial, gates_passed: out.gates_passed, advance: adv, caller },
          });
        } else {
          totals.dialed++;
          dialedThisAgent++;
          free--;
          // The claim stays SET until the call finishes. Clearing it here would
          // let the next tick pick the same enrollment up while its call is
          // still ringing; recordCampaignCallResult() releases it in the
          // webhook's finalize block, and the lease covers a call whose hangup
          // never arrives.
          await sb.from("voice_campaign_enrollments").update({
            calls_placed:    (claimed.calls_placed || 0) + 1,
            last_ai_call_id: typeof out.ai_call_id === "string" ? out.ai_call_id : null,
            last_call_at:    nowIso,
            step_attempts:   (claimed.step_attempts || 0) + 1,
            // Nothing is due while a call is in the air. The webhook's
            // finalize sets the next one.
            next_action_at:  null,
            updated_at:      nowIso,
          }).eq("id", claimed.id);
          say({
            agent_id: agentId, campaign_id: campaign.id, enrollment_id: claimed.id,
            lead_id: claimed.lead_id, event: "dialed",
            detail: { ai_call_id: out.ai_call_id, from: used, step: step.position },
          });
        }
        continue;
      }

      // ---------- 7. The gate said no ---------------------------------------
      const code = typeof out.error === "string" ? out.error : `http_${res?.status || 0}`;
      let quietUntil: string | null = null;
      if (code === "quiet_hours") {
        quietUntil = await computeQuietUntil(claimed.lead_id);
      }
      const plan = vcHandleGateRejection({
        code,
        now,
        resetsAt: typeof out.resets_at === "string" ? out.resets_at : null,
        quietUntil,
      });

      say({
        agent_id: agentId, campaign_id: campaign.id, enrollment_id: claimed.id,
        lead_id: claimed.lead_id, event: "gate_rejected",
        detail: { code, detail: out.detail, plan },
      });

      if (plan.action === "pause_campaign") {
        totals.paused++;
        pausedThisTick.add(campaign.id);
        await sb.from("voice_campaigns").update({
          paused_at: nowIso,
          pause_reason: plan.pause_reason,
          updated_at: nowIso,
        }).eq("id", campaign.id);
        // Leave the enrollment due and unclaimed: the moment the agent tops up
        // and unpauses, it is first in the queue.
        await sb.from("voice_campaign_enrollments")
          .update({ claimed_at: null, updated_at: nowIso })
          .eq("id", claimed.id);
        continue;
      }

      if (plan.action === "stop_enrollment") {
        totals.stopped++;
        await finishEnrollment(claimed.id, "stopped", plan.stop_reason);
        continue;
      }

      // reschedule / retry_soon
      totals.deferred++;
      await sb.from("voice_campaign_enrollments").update({
        next_action_at: plan.next_action_at,
        claimed_at: null,
        updated_at: nowIso,
      }).eq("id", claimed.id);
    }
  }

  // ============================================================
  // Sweep: stop conditions that did not come from a call
  // ============================================================
  async function sweepStops(agentId: string, campaign: Record<string, unknown>) {
    const { data: active } = await sb.from("voice_campaign_enrollments")
      .select("id, lead_id")
      .eq("campaign_id", campaign.id as string)
      .eq("status", "active")
      .limit(1000);
    if (!active || !active.length) return;

    const leadIds = active.map((e) => e.lead_id);
    const [{ data: leads }, { data: appts }] = await Promise.all([
      sb.from("leads").select("id, data, dnc, tcpa_consent").in("id", leadIds),
      campaign.stop_on_appointment_booked
        ? sb.from("ai_appointments").select("lead_id, status").in("lead_id", leadIds).eq("status", "scheduled")
        : Promise.resolve({ data: [] as Array<{ lead_id: string }> }),
    ]);

    const leadById = new Map((leads || []).map((l) => [l.id, l]));
    const booked   = new Set((appts || []).map((a) => a.lead_id));

    for (const enr of active) {
      const lead = leadById.get(enr.lead_id);
      let reason: string | null = null;

      // The lead was deleted. Nothing left to call.
      if (!lead) reason = "lead_missing";
      // ALWAYS, whatever the campaign's flags say.
      else if (lead.dnc === true) reason = "dnc";
      else if (campaign.stop_on_appointment_booked && booked.has(enr.lead_id)) reason = "appointment_booked";
      else if (campaign.stop_on_sold && String((lead.data as Record<string, unknown> | null)?.status || "").toLowerCase() === "sold") reason = "sold";

      if (reason) {
        totals.stopped++;
        await finishEnrollment(enr.id, "stopped", reason);
        say({ agent_id: agentId, campaign_id: campaign.id as string, enrollment_id: enr.id, event: "swept_stop", detail: { reason } });
      }
    }
  }

  // ============================================================
  // Sweep: enroll new matches
  // ============================================================
  async function sweepEnrollments(agentId: string, campaign: Record<string, unknown>, _tz: string) {
    const wantsAuto    = campaign.auto_enroll_new_leads === true;
    const wantsMissed  = campaign.trigger_on_missed_appointment === true;
    const wantsSold    = campaign.trigger_on_sold === true;
    if (!wantsAuto && !wantsMissed && !wantsSold) return;

    const steps = await stepsFor(campaign.id as string);
    const first = vcFirstStep(steps);
    if (!first) return; // a campaign with no steps enrolls nobody

    // Leads this campaign has already seen (any status) — enrolling somebody a
    // second time after they completed is a decision, not a side effect.
    const { data: seen } = await sb.from("voice_campaign_enrollments")
      .select("lead_id").eq("campaign_id", campaign.id as string).limit(20000);
    const seenIds = new Set((seen || []).map((r) => r.lead_id));

    // Leads active in ANY campaign — the one-active-campaign rule, checked
    // before we write rather than discovered by a unique-violation.
    const { data: activeAnywhere } = await sb.from("voice_campaign_enrollments")
      .select("lead_id").eq("agent_id", agentId).eq("status", "active").limit(20000);
    const activeIds = new Set((activeAnywhere || []).map((r) => r.lead_id));

    const { data: book } = await sb.from("leads")
      .select("id, data, tcpa_consent, dnc")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(BOOK_PAGE);
    if (!book || !book.length) return;

    // Missed-appointment / sold transitions, resolved once for the whole book.
    let noShowLeads = new Set<string>();
    if (wantsMissed) {
      const { data: rows } = await sb.from("ai_appointments")
        .select("lead_id").eq("agent_id", agentId).eq("status", "no_show").limit(2000);
      noShowLeads = new Set((rows || []).map((r) => r.lead_id).filter(Boolean) as string[]);
    }

    // The suppression list, once. It is small and global-or-mine.
    const { data: suppRows } = await sb.from("suppression_list")
      .select("phone_e164")
      .or(`agent_id.eq.${agentId},agent_id.is.null`)
      .limit(20000);
    const suppressed = new Set((suppRows || []).map((r) => r.phone_e164));

    let enrolled = 0;
    const skipped: Record<string, number> = {};
    const toInsert: Record<string, unknown>[] = [];

    for (const lead of book) {
      if (enrolled >= ENROLL_LIMIT_PER_CAMPAIGN) break;
      if (seenIds.has(lead.id)) continue;

      const d = (lead.data || {}) as Record<string, unknown>;
      const soldNow = String(d.status || "").toLowerCase() === "sold";

      // Which trigger, if any, admits this lead. The rule ALWAYS has to match:
      // "trigger when sold" narrows a campaign's audience, it does not replace
      // the audience with "everyone who was ever sold".
      const ruleMatches = vcMatchesTriggerGroups(lead, campaign.trigger_groups);
      if (!ruleMatches) continue;

      let by = "";
      if (wantsAuto) by = "auto";
      if (!by && wantsMissed && noShowLeads.has(lead.id)) by = "missed_appointment";
      if (!by && wantsSold && soldNow) by = "sold";
      if (!by) continue;

      const phone = toE164(String(d.phone || ""));
      const verdict = vcEvaluateEnrollment({
        lead,
        hasPhone: !!phone,
        suppressed: !!phone && suppressed.has(phone),
        activeElsewhere: activeIds.has(lead.id),
      });
      if (!verdict.ok) {
        skipped[verdict.reason || "skipped"] = (skipped[verdict.reason || "skipped"] || 0) + 1;
        continue;
      }

      toInsert.push({
        campaign_id: campaign.id,
        agent_id: agentId,
        lead_id: lead.id,
        status: "active",
        current_step_position: first.position,
        step_attempts: 0,
        next_action_at: vcStepDueAt(now, first).toISOString(),
        enrolled_by: by,
        enrolled_at: nowIso,
        updated_at: nowIso,
      });
      activeIds.add(lead.id);
      enrolled++;
    }

    if (toInsert.length) {
      // ignoreDuplicates: the partial unique index on lead_id is the real
      // enforcement of one-active-campaign, and a race with another tick must
      // lose quietly rather than fail the whole sweep.
      const { error } = await sb.from("voice_campaign_enrollments")
        .upsert(toInsert, { onConflict: "campaign_id,lead_id", ignoreDuplicates: true });
      if (error) {
        console.warn("[voice-campaign-tick] enroll insert:", error.message);
        say({ agent_id: agentId, campaign_id: campaign.id as string, event: "enroll_error", detail: error.message });
      } else {
        totals.enrolled += toInsert.length;
        say({
          agent_id: agentId, campaign_id: campaign.id as string,
          event: "enrolled", detail: { count: toInsert.length, skipped },
        });
      }
    }
  }

  // ============================================================
  // Helpers
  // ============================================================
  async function stepsFor(campaignId: string): Promise<VcStep[]> {
    const { data } = await sb.from("voice_campaign_steps")
      .select("id, campaign_id, position, step_type, wait_value, wait_unit, drip_rate")
      .eq("campaign_id", campaignId)
      .order("position", { ascending: true });
    return vcStepsSorted((data || []) as VcStep[]);
  }

  async function finishEnrollment(id: string, status: string, reason: string | null) {
    await sb.from("voice_campaign_enrollments").update({
      status,
      stop_reason: reason,
      next_action_at: null,
      claimed_at: null,
      completed_at: nowIso,
      updated_at: nowIso,
    }).eq("id", id);
  }

  async function applyAdvance(
    id: string,
    adv: { status: string; current_step_position: number; step_attempts: number; next_action_at: string | null; stop_reason: string | null },
    opts: { countCall?: boolean } = {},
  ) {
    const patch: Record<string, unknown> = {
      status: adv.status,
      current_step_position: adv.current_step_position,
      step_attempts: adv.step_attempts,
      next_action_at: adv.next_action_at,
      stop_reason: adv.stop_reason,
      claimed_at: null,
      updated_at: nowIso,
    };
    if (adv.status !== "active") patch.completed_at = nowIso;
    if (opts.countCall) {
      const { data: row } = await sb.from("voice_campaign_enrollments")
        .select("calls_placed").eq("id", id).maybeSingle();
      patch.calls_placed = ((row?.calls_placed as number) || 0) + 1;
      patch.last_call_at = nowIso;
    }
    await sb.from("voice_campaign_enrollments").update(patch).eq("id", id);
  }

  /**
   * When the lead's local calling window reopens.
   *
   * Uses the SAME predicate ai-call-start's gate 4 uses — quiet-hours bounds
   * from billing_config, the lead's stored zone or its area code, and the
   * most-restrictive interpretation when neither is known. Asking "when does
   * it open" with a second definition of "is it open" is how a scheduler ends
   * up knocking on a door it was just told is shut.
   */
  async function computeQuietUntil(leadId: string): Promise<string | null> {
    const [{ data: lead }, { data: cfg }] = await Promise.all([
      sb.from("leads").select("data, lead_timezone").eq("id", leadId).maybeSingle(),
      sb.from("billing_config").select("ai_quiet_start, ai_quiet_end").eq("id", 1).maybeSingle(),
    ]);
    if (!lead) return null;
    const quietStart = cfg?.ai_quiet_start ?? 8;
    const quietEnd   = cfg?.ai_quiet_end ?? 21;
    const phone = toE164(String((lead.data as Record<string, unknown> | null)?.phone || ""));
    const tz = (lead.lead_timezone || "").trim() || (phone ? knownTimezoneForPhone(phone) : null);
    const isAllowed = (at: Date) => tz
      ? isWithinAllowedHours(at, tz, quietStart, quietEnd)
      : isWithinAllowedHoursUnknownTz(at, quietStart, quietEnd);
    return vcNextAllowedInstant(now, isAllowed);
  }
});
