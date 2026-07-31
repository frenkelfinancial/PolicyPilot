import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toE164 } from "../_shared/phone.ts";
import {
  isWithinAllowedHours,
  isWithinAllowedHoursUnknownTz,
  knownTimezoneForPhone,
} from "../_shared/tcpa.ts";
import { localDayWindow, resolveAgentTimezone } from "../_shared/ai-call-meter.ts";
import { vcClaimEnrollment } from "../_shared/voice-campaign-claim.ts";
import { isConsentTypeAcceptable } from "../_shared/messaging-shared.ts";
import { sendCampaignSms } from "../_shared/campaign-sms-send.ts";
import {
  VC_CLAIM_LEASE_SECS,
  VC_MAX_DIALS_PER_TICK,
  VC_MAX_SENDS_PER_TICK,
  vcAdvanceAfterCall,
  vcAdvanceAfterSend,
  vcCampaignVars,
  vcChannel,
  vcDripAllows,
  vcDripWindowStart,
  vcEvaluateEnrollment,
  vcEvaluateSmsHold,
  vcEvaluateSmsStop,
  vcFirstActionableStep,
  vcHandleGateRejection,
  vcHandleSmsRejection,
  vcMatchesTriggerGroups,
  vcNextAllowedInstant,
  vcPickCallerId,
  vcResolveNextDue,
  vcSlotsFree,
  vcSlotsInUse,
  vcSmsHoldWouldMissAnchor,
  vcStepAt,
  vcStepIsActionable,
  vcStepsSorted,
} from "../_shared/voice-campaign-core.ts";
import type { VcStep, VcSmsThreadFacts } from "../_shared/voice-campaign-core.ts";

// ============================================================
// voice-campaign-tick — the campaign scheduler. One minute at a time.
//
// Read docs/voice-campaigns.md first, then docs/sms-campaigns.md. The
// decisions are there; this is the loop that executes them.
//
// ---- IT RUNS BOTH CHANNELS -------------------------------------------------
//
// The function is still called voice-campaign-tick and that is HISTORICAL. A
// `voice_campaigns` row with `channel = 'sms'` is a texting campaign and this
// same loop runs it: same trigger sweep, same enrollment model, same claim,
// same drip arithmetic, same rejection behaviours. ONE tick, because two would
// be two schedulers racing the same minute over the same table, with two
// definitions of "due" and two claims that do not know about each other.
//
// Where the channels diverge is exactly three places, and they are marked:
//
//   * SLOTS are voice-only. Three concurrent calls is a limit on a human's
//     ability to take a warm transfer; a text occupies nothing. A full voice
//     queue must not stop a text campaign, and a text must not consume a slot
//     a call is waiting for.
//   * The ACTION is `ai-call-start` or `sendCampaignSms`.
//   * SMS has a HOLD that voice has no equivalent of — see the live-
//     conversation rule in sms-campaigns.md.
//
// ---- The decision order, per agent -----------------------------------------
//
//   1. SWEEP    stop conditions that came from state, not from a call or a
//               send (sold, booked, DNC'd, replied, opted out, campaign
//               deactivated); then enroll new matches.
//   2. SLOTS    how many of this agent's three campaign lines are free. Zero
//               free means the agent dials nothing this minute — but TEXT
//               campaigns carry on, because a text occupies no line.
//   3. DUE      active enrollments with next_action_at <= now, oldest first,
//               belonging to an active, unpaused campaign.
//   3b. HOLD    (text only) somebody is mid-conversation with this lead. Defer
//               to when that window closes; do not advance the step.
//   4. CLAIM    an atomic update…returning per enrollment. A tick that dies
//               after this and re-fires a minute later cannot re-contact the
//               same lead; the claim leases (VC_CLAIM_LEASE_SECS) so a
//               genuinely dead tick does not strand anyone.
//   5. DRIP     the step's own throttle, counted over a rolling window —
//               ai_calls for a call, sms_messages for a text, same arithmetic.
//   6. ACT      ai-call-start with a rotated caller ID, or sendCampaignSms.
//   7. REJECT   whatever the gate said, handled by code — reschedule, pause the
//               campaign, or stop the enrollment. See vcHandleGateRejection
//               and vcHandleSmsRejection, which are the same three behaviours
//               over two different sets of refusal codes.
//
// ---- What this function does NOT do ----------------------------------------
//
// It does not check consent, DNC, suppression, quiet hours, the daily cap or
// the wallet floor. ai-call-start does, on every single call, and
// _shared/campaign-sms-send.ts does (through runComplianceGate) on every
// single text. There is no second copy of any of them here. What this function
// owns is what to do when the answer is no.
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
      "id, agent_id, name, active, dry_run, sort_order, campaign_goal, trigger_groups, channel, " +
      "auto_enroll_new_leads, trigger_on_missed_appointment, trigger_on_sold, " +
      "trigger_on_appointment_booked, stop_on_appointment_booked, " +
      "stop_on_sold, stop_on_answered, stop_answer_talk_secs, " +
      "stop_on_reply, pause_on_active_conversation, seed_key, paused_at, pause_reason",
    )
    .eq("active", true)
    .is("paused_at", null)
    // DETERMINISTIC ORDER, and it is load-bearing rather than cosmetic. Three
    // of the twelve shipped campaigns trigger on the same event (a client was
    // sold) while a lead may be ACTIVE in only one voice campaign at a time —
    // so without an order, WHICH of the three enrols a newly-sold client is
    // whatever PostgreSQL returned first, and it could differ minute to
    // minute. With one, they form a stated queue.
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
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
    texted: 0,
    held: 0,
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
      sb.from("agents").select("id, timezone, ai_dialer_enabled, display_name, agency_name, signalwire_caller_id").eq("id", agentId).maybeSingle(),
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

    // ---------- 2. Slots — VOICE ONLY ---------------------------------------
    //
    // Three concurrent campaign calls is a bound on a human being's ability to
    // take a warm transfer. A text occupies nothing and rings nobody, so it
    // neither consumes a slot nor waits for one. Returning early here — which
    // is what this did before there were two channels — would have meant three
    // calls in the air silently stopping every text campaign on the account.
    const hasSms   = agentCampaigns.some((c) => vcChannel(c) === "sms");
    const hasVoice = agentCampaigns.some((c) => vcChannel(c) !== "sms");
    const inUse = vcSlotsInUse(inflight || [], now);
    let free = vcSlotsFree(inUse);
    say({ agent_id: agentId, event: "slots", detail: { in_use: inUse, free, has_sms: hasSms } });
    if (free <= 0) {
      if (hasVoice) totals.slot_blocked++;
      // Only give up entirely when there is nothing a text campaign could do
      // either.
      if (!hasSms) return;
    }

    // ---------- 3. Due ------------------------------------------------------
    const staleIso = new Date(now.getTime() - VC_CLAIM_LEASE_SECS * 1000).toISOString();
    const { data: due } = await sb.from("voice_campaign_enrollments")
      .select("id, campaign_id, agent_id, lead_id, status, channel, current_step_position, step_attempts, next_action_at, claimed_at, appointment_id, enrolled_at, messages_sent, conversation_id")
      .eq("agent_id", agentId)
      .eq("status", "active")
      .in("campaign_id", campaignIds)
      .lte("next_action_at", nowIso)
      .or(`claimed_at.is.null,claimed_at.lt.${staleIso}`)
      .order("next_action_at", { ascending: true })
      .limit(VC_MAX_DIALS_PER_TICK * 2 + VC_MAX_SENDS_PER_TICK);

    if (!due || !due.length) return;

    // Steps, once, for every campaign this agent is running.
    const { data: allSteps } = await sb.from("voice_campaign_steps")
      .select("id, campaign_id, position, step_type, wait_value, wait_unit, drip_rate, anchor, offset_minutes, body, media_url")
      .in("campaign_id", campaignIds)
      .order("position", { ascending: true });
    const stepsByCampaign = new Map<string, VcStep[]>();
    for (const s of allSteps || []) {
      const list = stepsByCampaign.get(s.campaign_id) || [];
      list.push(s as VcStep);
      stepsByCampaign.set(s.campaign_id, list);
    }

    // The conversation threads behind the TEXT enrollments in this batch, in
    // one query. Both the live-conversation hold and the stop-on-reply check
    // read them, and reading them per enrollment would be one round trip per
    // lead to answer a question the same query already answered.
    const smsDue = (due || []).filter((e) => e.channel === "sms");
    const threads = smsDue.length ? await loadThreads(agentId, smsDue) : new Map();

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

    // Appointment times for the appointment-anchored enrollments in this
    // batch, in one query. vcResolveNextDue needs them to decide whether the
    // next reminder still has a moment left, or has been overtaken.
    const apptIds = [...new Set((due || []).map((e) => e.appointment_id).filter(Boolean))] as string[];
    const apptAt = new Map<string, string>();
    if (apptIds.length) {
      const { data: appts } = await sb.from("ai_appointments")
        .select("id, starts_at").in("id", apptIds);
      for (const a of appts || []) if (a.starts_at) apptAt.set(a.id, a.starts_at);
    }

    // Campaigns paused mid-loop must stop being dialed within the same tick.
    const pausedThisTick = new Set<string>();
    let dialedThisAgent = 0;
    let sentThisAgent = 0;

    for (const enr of due) {
      // Two budgets, because the two channels are bounded by different things
      // — see VC_MAX_SENDS_PER_TICK. A tick that has used up its dials can
      // still finish its texts, and vice versa.
      if (dialedThisAgent >= VC_MAX_DIALS_PER_TICK && sentThisAgent >= VC_MAX_SENDS_PER_TICK) break;
      if (pausedThisTick.has(enr.campaign_id)) continue;

      const campaign = agentCampaigns.find((c) => c.id === enr.campaign_id);
      if (!campaign) continue;

      const channel = vcChannel(campaign);
      const steps = vcStepsSorted(stepsByCampaign.get(campaign.id) || []);
      const step  = vcStepAt(steps, enr.current_step_position);
      // A `wait` step is never a current position — vcResolveNextDue folds it
      // into the next real step — so landing on one means the Steps tab was
      // re-saved underneath this enrollment and the positions renumbered.
      // Treated exactly like a deleted step, below.
      if (!step || !vcStepIsActionable(step)) {
        // The step was deleted underneath a live enrollment. Completing is the
        // honest answer: there is nothing left to do to this lead, and leaving
        // the row active would re-ask this question every minute for ever.
        await finishEnrollment(enr.id, "completed", null);
        say({ agent_id: agentId, campaign_id: campaign.id, enrollment_id: enr.id, event: "step_missing_completed" });
        continue;
      }

      // ---------- The text branch -------------------------------------------
      if (channel === "sms") {
        if (sentThisAgent >= VC_MAX_SENDS_PER_TICK) continue;
        const acted = await runSmsEnrollment({
          agentId, campaign, enr, step, steps,
          thread: threads.get(String(enr.id)) || null,
          agent: agent as Record<string, unknown> | null,
          // Only the Appointment Reminder has one. It is what stops the
          // live-conversation hold from deferring "your call is in an hour"
          // past the call.
          appointmentAt: enr.appointment_id ? apptAt.get(enr.appointment_id) || null : null,
          pausedThisTick, staleIso,
        });
        if (acted) sentThisAgent++;
        continue;
      }

      // ---------- The call branch -------------------------------------------
      // Slots gate here and only here.
      if (free <= 0 || dialedThisAgent >= VC_MAX_DIALS_PER_TICK) continue;

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
        // WHY this call is happening. Picks the reason clause of the spoken
        // greeting and a branch of the assistant's instructions — a reminder
        // call and a referral ask cannot open with the same sentence.
        campaign_goal: vars.campaign_goal,
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
            appointmentAt: claimed.appointment_id ? apptAt.get(claimed.appointment_id) || null : null,
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
            // The phone is ringing, so no gate is holding this lead back any
            // more. Cleared here rather than on the next reschedule, because
            // between the two the screen would still be explaining a wait
            // that ended the moment we dialled.
            last_gate_code:  null,
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
        // WHY this lead is waiting, kept for the campaign screen. The engine
        // branches on `plan`, never on this column — a deferral that says
        // "quiet hours" and one that says nothing behave identically here, and
        // the difference is entirely in whether the agent can tell a working
        // campaign from a broken one. `retry_soon` covers the catch-all rung
        // (a Telnyx 5xx, a network blip) because "a hiccup, retrying" is the
        // true and complete answer for it.
        last_gate_code: (code === "quiet_hours" || code === "daily_cap_reached") ? code : "retry_soon",
        updated_at: nowIso,
      }).eq("id", claimed.id);
    }
  }

  // ============================================================
  // Sweep: stop conditions that did not come from a call
  // ============================================================
  async function sweepStops(agentId: string, campaign: Record<string, unknown>) {
    const { data: active } = await sb.from("voice_campaign_enrollments")
      .select("id, lead_id, appointment_id, enrolled_at")
      .eq("campaign_id", campaign.id as string)
      .eq("status", "active")
      .limit(1000);
    if (!active || !active.length) return;

    const isSms = vcChannel(campaign as Record<string, unknown>) === "sms";
    const leadIds = active.map((e) => e.lead_id);
    const [{ data: leads }, { data: appts }] = await Promise.all([
      sb.from("leads").select("id, data, dnc, tcpa_consent").in("id", leadIds),
      campaign.stop_on_appointment_booked
        ? sb.from("ai_appointments").select("lead_id, status").in("lead_id", leadIds).eq("status", "scheduled")
        : Promise.resolve({ data: [] as Array<{ lead_id: string }> }),
    ]);

    // The appointments an ANCHORED campaign is counting down to. A reminder
    // whose meeting was cancelled — or has already happened — is a robot
    // phoning somebody about something that is not going to happen, or has
    // already been and gone. Both stop the enrollment by name rather than
    // leaving it queued against an instant that will never arrive.
    const anchorIds = [...new Set(active.map((e) => e.appointment_id).filter(Boolean))] as string[];
    const anchorRows = new Map<string, { status: string | null; starts_at: string | null }>();
    if (anchorIds.length) {
      const { data: rows } = await sb.from("ai_appointments")
        .select("id, status, starts_at").in("id", anchorIds);
      for (const r of rows || []) anchorRows.set(r.id, { status: r.status, starts_at: r.starts_at });
    }

    const leadById = new Map((leads || []).map((l) => [l.id, l]));
    const booked   = new Set((appts || []).map((a) => a.lead_id));

    // ---- The text-only facts -------------------------------------------------
    //
    // 🔴 STOP-ON-REPLY IS SWEPT, NOT ONLY CHECKED AT SEND TIME. A lead who
    // writes back at 2pm must see the campaign end at 2pm, not whenever their
    // next step happened to fall due — which could be three days later, and
    // which would leave the campaign screen saying "next text Thursday" about
    // somebody the campaign has already finished with. The send-time re-check
    // below is a second line of defence, not the mechanism.
    const threadByLead = new Map<string, VcSmsThreadFacts>();
    const dncByLead = new Set<string>();
    const dncPhones = new Set<string>();
    if (isSms) {
      const phones: string[] = [];
      const phoneByLead = new Map<string, string>();
      for (const l of leads || []) {
        const p = toE164(String(((l.data || {}) as Record<string, unknown>).phone || ""));
        if (!p) continue;
        phones.push(p);
        phoneByLead.set(l.id, p);
      }
      if (phones.length) {
        const uniq = [...new Set(phones)];
        const [{ data: convs }, { data: dncRows }] = await Promise.all([
          sb.from("sms_conversations")
            .select("contact_phone, status, closed_reason, ai_muted, ai_muted_reason, last_inbound_at")
            .eq("agent_id", agentId).in("contact_phone", uniq),
          sb.from("dnc_list").select("agent_id, contact_phone").in("contact_phone", uniq),
        ]);
        const convByPhone = new Map((convs || []).map((c) => [c.contact_phone, c as VcSmsThreadFacts]));
        for (const [leadId, phone] of phoneByLead) {
          const c = convByPhone.get(phone);
          if (c) threadByLead.set(leadId, c);
        }
        // Agent-scoped OR global, the same predicate runComplianceGate uses.
        for (const r of dncRows || []) {
          if (r.agent_id === null || r.agent_id === agentId) dncPhones.add(r.contact_phone);
        }
        for (const [leadId, phone] of phoneByLead) {
          if (dncPhones.has(phone)) dncByLead.add(leadId);
        }
      }
    }

    for (const enr of active) {
      const lead = leadById.get(enr.lead_id);
      let reason: string | null = null;

      // The lead was deleted. Nothing left to reach.
      if (!lead) reason = "lead_missing";
      // ALWAYS, whatever the campaign's flags say.
      else if (lead.dnc === true) reason = "dnc";
      else if (campaign.stop_on_appointment_booked && booked.has(enr.lead_id)) reason = "appointment_booked";
      else if (campaign.stop_on_sold && String((lead.data as Record<string, unknown> | null)?.status || "").toLowerCase() === "sold") reason = "sold";
      else if (enr.appointment_id) {
        const appt = anchorRows.get(enr.appointment_id);
        if (!appt || String(appt.status || "").toLowerCase() !== "scheduled") {
          reason = "appointment_cancelled";
        } else if (appt.starts_at && new Date(appt.starts_at).getTime() <= now.getTime()) {
          reason = "appointment_passed";
        }
      }

      // The text-only reasons, evaluated by the SAME function the send-time
      // re-check calls — an opt-out, a closed thread, or a reply.
      if (!reason && isSms && lead) {
        const verdict = vcEvaluateSmsStop({
          campaign,
          thread: threadByLead.get(enr.lead_id) || null,
          enrolledAt: enr.enrolled_at,
          leadDnc: lead.dnc === true,
          onDncList: dncByLead.has(enr.lead_id),
          leadSold: String((lead.data as Record<string, unknown> | null)?.status || "").toLowerCase() === "sold",
          leadBooked: booked.has(enr.lead_id),
        });
        if (verdict.stop) reason = verdict.reason;
      }

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
    const wantsBooked  = campaign.trigger_on_appointment_booked === true;
    if (!wantsAuto && !wantsMissed && !wantsSold && !wantsBooked) return;

    const channel = vcChannel(campaign as Record<string, unknown>);
    const steps = await stepsFor(campaign.id as string);
    // vcFirstActionableStep, not vcFirstStep: a text campaign made of nothing
    // but `wait` steps HAS steps and would pass a count check, then enrol
    // people and message none of them for ever while showing green.
    const first = vcFirstActionableStep(steps);
    if (!first) return; // a campaign with nothing to do enrolls nobody

    // Leads this campaign has already seen (any status) — enrolling somebody a
    // second time after they completed is a decision, not a side effect.
    // (The one exception is the appointment re-arm below, which is that
    // decision, taken deliberately and for one campaign shape only.)
    const { data: seen } = await sb.from("voice_campaign_enrollments")
      .select("id, lead_id, status, appointment_id")
      .eq("campaign_id", campaign.id as string).limit(20000);
    const seenByLead = new Map((seen || []).map((r) => [r.lead_id, r]));

    // Leads active in another campaign OF THIS CHANNEL — the one-active rule,
    // checked before we write rather than discovered by a unique-violation.
    // Scoped by channel because that is what the partial unique index is now
    // keyed on: a lead in a calling campaign is perfectly eligible for a
    // texting one, and vice versa.
    const { data: activeAnywhere } = await sb.from("voice_campaign_enrollments")
      .select("lead_id").eq("agent_id", agentId).eq("status", "active")
      .eq("channel", channel).limit(20000);
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

    // The next SCHEDULED appointment per lead, for an anchored campaign. Only
    // future ones: a reminder for a meeting that already happened is the one
    // thing this campaign shape must never produce, and filtering here means
    // the skip rule in vcResolveNextDue is a second line of defence rather
    // than the only one.
    const upcomingAppt = new Map<string, { id: string; starts_at: string }>();
    if (wantsBooked) {
      const { data: rows } = await sb.from("ai_appointments")
        .select("id, lead_id, starts_at")
        .eq("agent_id", agentId)
        .eq("status", "scheduled")
        .gt("starts_at", nowIso)
        .order("starts_at", { ascending: true })
        .limit(2000);
      for (const r of rows || []) {
        if (!r.lead_id || !r.starts_at) continue;
        // Ascending, so the FIRST one seen for a lead is the soonest.
        if (!upcomingAppt.has(r.lead_id)) upcomingAppt.set(r.lead_id, { id: r.id, starts_at: r.starts_at });
      }
    }

    // THE SUPPRESSION LIST IS PER CHANNEL, and mixing the two up would be the
    // worst available bug in this function. `suppression_list` is the voice
    // AI's; `dnc_list` is what a texting STOP writes and what
    // runComplianceGate reads. Reading the voice list for a text campaign
    // would enrol people who have already replied STOP — they would then be
    // refused one at a time by the send gate, but the campaign screen would
    // have spent the intervening days claiming it was about to text them.
    const suppressed = new Set<string>();
    if (channel === "sms") {
      const { data: rows } = await sb.from("dnc_list")
        .select("agent_id, contact_phone")
        .not("contact_phone", "is", null)
        .limit(20000);
      for (const r of rows || []) {
        if (r.agent_id === null || r.agent_id === agentId) suppressed.add(r.contact_phone);
      }
    } else {
      const { data: suppRows } = await sb.from("suppression_list")
        .select("phone_e164")
        .or(`agent_id.eq.${agentId},agent_id.is.null`)
        .limit(20000);
      for (const r of suppRows || []) suppressed.add(r.phone_e164);
    }

    // Recorded TEXT consent, for a text campaign only.
    //
    // A DIFFERENT FACT from `leads.tcpa_consent`, which is what a voice
    // campaign reads. Calling consent is not texting consent — this app keeps
    // them apart on the leads screen, in the composer and in the consent tool,
    // and a campaign that collapsed them would message people who agreed only
    // to a phone call.
    const smsConsent = channel === "sms" ? await loadSmsConsent(agentId) : null;

    let enrolled = 0;
    const skipped: Record<string, number> = {};
    const toInsert: Record<string, unknown>[] = [];

    let rearmed = 0;

    for (const lead of book) {
      if (enrolled >= ENROLL_LIMIT_PER_CAMPAIGN) break;

      const d = (lead.data || {}) as Record<string, unknown>;
      const soldNow = String(d.status || "").toLowerCase() === "sold";
      const appt = upcomingAppt.get(lead.id) || null;

      // Which trigger, if any, admits this lead. The rule ALWAYS has to match:
      // "trigger when sold" narrows a campaign's audience, it does not replace
      // the audience with "everyone who was ever sold".
      const ruleMatches = vcMatchesTriggerGroups(lead, campaign.trigger_groups);
      if (!ruleMatches) continue;

      let by = "";
      if (wantsAuto) by = "auto";
      if (!by && wantsMissed && noShowLeads.has(lead.id)) by = "missed_appointment";
      if (!by && wantsSold && soldNow) by = "sold";
      if (!by && wantsBooked && appt) by = "appointment_booked";
      if (!by) continue;

      // ---- Already seen? ---------------------------------------------------
      //
      // Normally that is the end of it. The ONE exception is an appointment-
      // anchored campaign whose previous run counted down to a DIFFERENT
      // appointment: a client who booked in March, was reminded, and books
      // again in June should be reminded again. Re-enrolling is not possible —
      // (campaign_id, lead_id) is unique — so the finished row is RESET in
      // place, against the new appointment.
      const prior = seenByLead.get(lead.id);
      if (prior) {
        const canRearm =
          wantsBooked && appt &&
          prior.status !== "active" &&
          prior.appointment_id !== appt.id;
        if (!canRearm) continue;
        if (activeIds.has(lead.id)) {
          skipped.already_enrolled = (skipped.already_enrolled || 0) + 1;
          continue;
        }
        const reFirst = vcResolveNextDue({ steps, now, appointmentAt: appt.starts_at });
        if (!reFirst.step || !reFirst.dueAt) {
          skipped.appointment_too_soon = (skipped.appointment_too_soon || 0) + 1;
          continue;
        }
        await sb.from("voice_campaign_enrollments").update({
          status: "active",
          current_step_position: reFirst.step.position,
          step_attempts: 0,
          next_action_at: reFirst.dueAt,
          claimed_at: null,
          stop_reason: null,
          completed_at: null,
          appointment_id: appt.id,
          enrolled_by: "appointment_booked",
          updated_at: nowIso,
        }).eq("id", prior.id);
        activeIds.add(lead.id);
        rearmed++;
        continue;
      }

      const phone = toE164(String(d.phone || ""));
      const verdict = vcEvaluateEnrollment({
        lead,
        channel,
        hasPhone: !!phone,
        suppressed: !!phone && suppressed.has(phone),
        hasSmsConsent: !!phone && !!smsConsent && smsConsent.has(phone),
        activeElsewhere: activeIds.has(lead.id),
      });
      if (!verdict.ok) {
        skipped[verdict.reason || "skipped"] = (skipped[verdict.reason || "skipped"] || 0) + 1;
        continue;
      }

      // When the first step runs. For an ordinary campaign this is "now plus
      // the step's wait". For an appointment-anchored one it is computed
      // backwards from the appointment, and a lead enrolled after every
      // reminder's moment has passed is NOT enrolled at all — a dead
      // enrollment on the Enrollments tab reads as a promise the product is
      // not going to keep.
      const firstDue = vcResolveNextDue({
        steps, now, appointmentAt: appt ? appt.starts_at : null,
      });
      if (!firstDue.step || !firstDue.dueAt) {
        skipped.appointment_too_soon = (skipped.appointment_too_soon || 0) + 1;
        continue;
      }

      toInsert.push({
        campaign_id: campaign.id,
        agent_id: agentId,
        lead_id: lead.id,
        status: "active",
        current_step_position: firstDue.step.position,
        step_attempts: 0,
        next_action_at: firstDue.dueAt,
        appointment_id: appt ? appt.id : null,
        enrolled_by: by,
        enrolled_at: nowIso,
        updated_at: nowIso,
      });
      activeIds.add(lead.id);
      enrolled++;
    }

    if (rearmed) {
      totals.enrolled += rearmed;
      say({
        agent_id: agentId, campaign_id: campaign.id as string,
        event: "rearmed", detail: { count: rearmed },
      });
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
  // One text enrollment
  //
  // Returns true when it did something that counts against the tick's send
  // budget — a send, real or dry. A hold, a stop and a throttle all return
  // false, because none of them consumed the thing the budget is bounding.
  //
  // 🔴 THIS FUNCTION SENDS NOTHING ITSELF. It decides WHEN, and hands the
  // message to sendCampaignSms(), which is the only place a campaign text goes
  // out and the only place consent, DNC, suppression and quiet hours are
  // checked. There is no copy of any of them here and a test greps for that.
  // ============================================================
  async function runSmsEnrollment(ctx: {
    agentId: string;
    campaign: Record<string, unknown>;
    enr: Record<string, unknown>;
    step: VcStep;
    steps: VcStep[];
    thread: VcSmsThreadFacts | null;
    agent: Record<string, unknown> | null;
    /** The appointment an anchored reminder is counting down to, if any. */
    appointmentAt?: string | null;
    pausedThisTick: Set<string>;
    staleIso: string;
  }): Promise<boolean> {
    const { agentId, campaign, enr, step, steps, thread } = ctx;
    const enrId = String(enr.id);
    const campaignId = String(campaign.id);

    // ---- The lead, and whether they may still be texted ------------------
    const { data: lead } = await sb.from("leads")
      .select("id, data, tcpa_consent, dnc")
      .eq("id", enr.lead_id as string).maybeSingle();
    if (!lead) {
      await finishEnrollment(enrId, "stopped", "lead_missing");
      totals.stopped++;
      return false;
    }
    const phone = toE164(String(((lead.data || {}) as Record<string, unknown>).phone || ""));

    // ---- STOP, re-checked ------------------------------------------------
    //
    // The sweep at the top of this tick already ran this, from the same
    // function. Running it again costs one map lookup and covers the window in
    // between — during which, on a busy account, a lead can genuinely have
    // replied. A text that goes out into a conversation that started ninety
    // seconds ago is exactly the failure this campaign type is judged on.
    const stop = vcEvaluateSmsStop({
      campaign,
      thread,
      enrolledAt: enr.enrolled_at as string,
      leadDnc: lead.dnc === true,
      leadSold: String(((lead.data || {}) as Record<string, unknown>).status || "").toLowerCase() === "sold",
    });
    if (stop.stop) {
      await finishEnrollment(enrId, "stopped", stop.reason);
      totals.stopped++;
      say({
        agent_id: agentId, campaign_id: campaignId, enrollment_id: enrId,
        event: "sms_stopped", detail: { reason: stop.reason },
      });
      return false;
    }

    // ---- HOLD ------------------------------------------------------------
    //
    // NOT a stop and NOT a pause: the enrollment stays active on this same
    // step and the due time moves to when the conversation window closes. The
    // reason is stored so the screen can say "They're mid-conversation —
    // holding" instead of a bare future timestamp, which reads as broken.
    const hold = vcEvaluateSmsHold({ campaign, thread, now });
    if (hold.hold) {
      // 🔴 …EXCEPT WHEN HOLDING WOULD MAKE AN ANCHORED STEP ARRIVE LATE.
      //
      // "Your call is in about an hour", deferred 24 hours because they texted
      // us, is a reminder for something that already happened. An anchored step
      // whose moment falls inside the hold is SKIPPED instead — the same rule
      // vcResolveNextDue() applies at enrollment, reached here by the other
      // door. The enrollment stays alive on whatever step still has a moment
      // left, and the conversation is still not talked over, because the step
      // that would have talked over it is the one being dropped.
      if (vcSmsHoldWouldMissAnchor({
        step, holdUntil: hold.until, appointmentAt: ctx.appointmentAt || null,
      })) {
        const next = vcResolveNextDue({
          steps, fromPosition: step.position, now, appointmentAt: ctx.appointmentAt || null,
        });
        if (!next.step || !next.dueAt) {
          await finishEnrollment(enrId, "completed", null);
        } else {
          await sb.from("voice_campaign_enrollments").update({
            current_step_position: next.step.position,
            step_attempts: 0,
            next_action_at: next.dueAt,
            claimed_at: null,
            last_gate_code: hold.reason,
            updated_at: nowIso,
          }).eq("id", enrId);
        }
        say({
          agent_id: agentId, campaign_id: campaignId, enrollment_id: enrId,
          event: "sms_anchor_skipped_not_held",
          detail: { reason: hold.reason, skipped: step.position, next: next.step ? next.step.position : null },
        });
        return false;
      }

      totals.held++;
      await sb.from("voice_campaign_enrollments").update({
        next_action_at: hold.until,
        claimed_at: null,
        last_gate_code: hold.reason,
        updated_at: nowIso,
      }).eq("id", enrId);
      say({
        agent_id: agentId, campaign_id: campaignId, enrollment_id: enrId,
        event: "sms_held", detail: { reason: hold.reason, until: hold.until },
      });
      return false;
    }

    // ---- DRIP ------------------------------------------------------------
    //
    // The identical arithmetic the call path uses (vcDripAllows over a rolling
    // window); only the table counted differs — sms_messages instead of
    // ai_calls. Being throttled is NOT a rescheduling: the enrollment stays
    // due and the next tick tries again, so a 20-per-hour step drains across
    // the hour by itself.
    const windowStart = vcDripWindowStart(now, step.drip_rate);
    if (windowStart) {
      const { count } = await sb.from("sms_messages")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .eq("campaign_step", step.position)
        .gte("created_at", windowStart.toISOString());
      const verdict = vcDripAllows({ drip: step.drip_rate, placedInWindow: count || 0 });
      if (!verdict.allowed) {
        totals.drip_blocked++;
        say({
          agent_id: agentId, campaign_id: campaignId, enrollment_id: enrId,
          event: "drip_throttled", detail: { placed_in_window: count || 0, drip: step.drip_rate },
        });
        return false;
      }
    }

    // ---- CLAIM -----------------------------------------------------------
    // The same conditional UPDATE … RETURNING the call path uses. Postgres
    // re-checks the WHERE after the row lock, so of two concurrent ticks
    // exactly one sends.
    const claimed = await vcClaimEnrollment(sb, enrId, nowIso, ctx.staleIso);
    if (!claimed) {
      say({ agent_id: agentId, enrollment_id: enrId, event: "claim_lost" });
      return false;
    }

    // ---- SEND ------------------------------------------------------------
    const isDry = campaign.dry_run === true;
    const agent = ctx.agent || {};
    let result;
    try {
      result = await sendCampaignSms(sb, {
        agentId,
        toRaw: phone,
        body: String(step.body || ""),
        mediaUrl: step.media_url || null,
        lead,
        leadId: lead.id,
        agentName: (agent.display_name as string) || null,
        agencyName: (agent.agency_name as string) || null,
        preferredFrom: (agent.signalwire_caller_id as string) || null,
        campaignId,
        campaignStep: step.position,
        enrollmentId: enrId,
        // The twelve default campaigns' seed_keys ARE the twelve SMS AI
        // campaign types, so a lead this campaign opens a conversation with
        // gets answered in the matching voice — with no mapping table and no
        // third place for those two lists to drift apart.
        campaignType: (campaign.seed_key as string) || null,
        dryRun: isDry,
      });
    } catch (e) {
      result = { ok: false as const, code: "send_threw", detail: (e as Error)?.message };
    }

    if (result.ok) {
      const adv = vcAdvanceAfterSend({
        steps,
        enrollment: {
          status: "active",
          current_step_position: claimed.current_step_position,
          step_attempts: (claimed.step_attempts || 0) + 1,
          next_action_at: null,
        },
        now,
      });

      const patch: Record<string, unknown> = {
        status: adv.status,
        current_step_position: adv.current_step_position,
        step_attempts: adv.step_attempts,
        next_action_at: adv.next_action_at,
        stop_reason: adv.stop_reason,
        claimed_at: null,
        // The text has gone, so whatever the last refusal was, its wait is
        // over. A stale reason outliving its wait is how a screen ends up
        // explaining a hold that is not happening.
        last_gate_code: null,
        updated_at: nowIso,
      };
      // A dry run proves claim → stop → hold → drip → gate → schedule without
      // sending, so it must not claim a message went out. The counters are
      // LEFT ALONE rather than written back unchanged: `last_message_at` is
      // not in the due select, so writing it here would set it to null and
      // erase the stamp of a real send this enrollment made yesterday.
      if (!isDry) {
        patch.messages_sent = ((enr.messages_sent as number) || 0) + 1;
        patch.last_message_at = nowIso;
        if (result.conversationId) patch.conversation_id = result.conversationId;
      }
      if (adv.status !== "active") patch.completed_at = nowIso;
      await sb.from("voice_campaign_enrollments").update(patch).eq("id", enrId);

      if (isDry) {
        totals.dry_run++;
        say({
          agent_id: agentId, campaign_id: campaignId, enrollment_id: enrId,
          lead_id: String(lead.id), event: "dry_run_would_text",
          detail: {
            to: phone, from: result.fromNumber, step: step.position,
            channel: result.channel, segments: result.segments,
            rendered: result.rendered,
            gates_passed: result.gatesPassed,
            advance: adv,
          },
        });
      } else {
        totals.texted++;
        say({
          agent_id: agentId, campaign_id: campaignId, enrollment_id: enrId,
          lead_id: String(lead.id), event: "texted",
          detail: {
            message_id: result.messageId, from: result.fromNumber,
            step: step.position, channel: result.channel, segments: result.segments,
          },
        });
      }
      return true;
    }

    // ---- The gate said no ------------------------------------------------
    let quietUntil: string | null = null;
    if (result.code === "quiet_hours") quietUntil = await computeQuietUntil(String(enr.lead_id));
    const plan = vcHandleSmsRejection({ code: result.code, now, quietUntil });

    say({
      agent_id: agentId, campaign_id: campaignId, enrollment_id: enrId,
      lead_id: String(lead.id), event: "sms_gate_rejected",
      detail: { code: result.code, detail: result.detail, plan },
    });

    if (plan.action === "pause_campaign") {
      totals.paused++;
      ctx.pausedThisTick.add(campaignId);
      await sb.from("voice_campaigns").update({
        paused_at: nowIso, pause_reason: plan.pause_reason, updated_at: nowIso,
      }).eq("id", campaignId);
      // Left due and unclaimed: the moment the agent fixes it and presses
      // Resume, this lead is first in the queue.
      await sb.from("voice_campaign_enrollments")
        .update({ claimed_at: null, updated_at: nowIso }).eq("id", enrId);
      return false;
    }

    if (plan.action === "stop_enrollment") {
      totals.stopped++;
      await finishEnrollment(enrId, "stopped", plan.stop_reason);
      return false;
    }

    totals.deferred++;
    await sb.from("voice_campaign_enrollments").update({
      next_action_at: plan.next_action_at,
      claimed_at: null,
      last_gate_code:
        (result.code === "quiet_hours" || result.code === "daily_limit_reached" ||
         result.code === "a2p_not_approved")
          ? result.code
          : "retry_soon",
      updated_at: nowIso,
    }).eq("id", enrId);
    return false;
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * The conversation thread behind each text enrollment in this batch.
   *
   * Keyed by ENROLLMENT id rather than phone, so the caller does not have to
   * re-derive a lead's phone number to look one up. `conversation_id` is set
   * on an enrollment's first send, so a lead who has never been texted has no
   * thread and no hold — which is correct: there is no conversation to talk
   * over.
   */
  async function loadThreads(
    agentId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<Map<string, VcSmsThreadFacts>> {
    const out = new Map<string, VcSmsThreadFacts>();
    const convIds = [...new Set(rows.map((r) => r.conversation_id).filter(Boolean))] as string[];
    const byConv = new Map<string, VcSmsThreadFacts>();

    if (convIds.length) {
      const { data } = await sb.from("sms_conversations")
        .select("id, status, closed_reason, ai_muted, ai_muted_reason, last_inbound_at, last_outbound_at")
        .eq("agent_id", agentId).in("id", convIds);
      for (const c of data || []) byConv.set(c.id, c as VcSmsThreadFacts);
    }

    // A lead may have a thread this enrollment has never written to — they
    // texted in first, or an earlier campaign opened it. Resolve those by
    // phone so the hold is honoured on the very first step, which is the step
    // most likely to land on somebody already mid-conversation.
    const needPhone = rows.filter((r) => !r.conversation_id);
    if (needPhone.length) {
      const { data: leads } = await sb.from("leads")
        .select("id, data").in("id", needPhone.map((r) => r.lead_id as string));
      const phoneByLead = new Map<string, string>();
      for (const l of leads || []) {
        const p = toE164(String(((l.data || {}) as Record<string, unknown>).phone || ""));
        if (p) phoneByLead.set(l.id, p);
      }
      const phones = [...new Set(phoneByLead.values())];
      const byPhone = new Map<string, VcSmsThreadFacts>();
      if (phones.length) {
        const { data } = await sb.from("sms_conversations")
          .select("contact_phone, status, closed_reason, ai_muted, ai_muted_reason, last_inbound_at, last_outbound_at")
          .eq("agent_id", agentId).in("contact_phone", phones);
        for (const c of data || []) byPhone.set(c.contact_phone, c as VcSmsThreadFacts);
      }
      for (const r of needPhone) {
        const p = phoneByLead.get(String(r.lead_id));
        const t = p ? byPhone.get(p) : null;
        if (t) out.set(String(r.id), t);
      }
    }

    for (const r of rows) {
      if (out.has(String(r.id))) continue;
      const t = r.conversation_id ? byConv.get(String(r.conversation_id)) : null;
      if (t) out.set(String(r.id), t);
    }
    return out;
  }

  /**
   * Every phone number of this agent's with acceptable TEXT consent on file.
   *
   * The same rule runComplianceGate enforces, read the same way: the MOST
   * RECENT record per number regardless of `revoked_at`, and only then checked
   * — filtering revoked rows out first would let a stale older grant win over
   * a newer revocation, which is the resurrection bug that ordering exists to
   * avoid. `express` counts only when the operator has relaxed the written
   * requirement, exactly as the gate decides it.
   *
   * This is a PRE-FILTER for the enrollment sweep, not an enforcement point.
   * The gate still runs on every send.
   */
  async function loadSmsConsent(agentId: string): Promise<Set<string>> {
    const [{ data: rows }, { data: cfg }] = await Promise.all([
      sb.from("consent_records")
        .select("contact_phone, consent_type, revoked_at, captured_at")
        .eq("agent_id", agentId)
        .not("contact_phone", "is", null)
        .order("captured_at", { ascending: false })
        .limit(20000),
      sb.from("billing_config").select("sms_require_written_consent").eq("id", 1).maybeSingle(),
    ]);
    const requireWritten = cfg?.sms_require_written_consent ?? true;
    const seen = new Set<string>();
    const ok = new Set<string>();
    for (const r of rows || []) {
      const p = r.contact_phone as string;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      if (r.revoked_at) continue;
      if (isConsentTypeAcceptable(String(r.consent_type || ""), requireWritten)) ok.add(p);
    }
    return ok;
  }

  async function stepsFor(campaignId: string): Promise<VcStep[]> {
    const { data } = await sb.from("voice_campaign_steps")
      .select("id, campaign_id, position, step_type, wait_value, wait_unit, drip_rate, anchor, offset_minutes, body, media_url")
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
      // A call has just been decided about, so whatever the last gate refusal
      // was, its wait is over. A stale reason outliving its wait is how a
      // screen ends up explaining a pause that is not happening.
      last_gate_code: null,
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
