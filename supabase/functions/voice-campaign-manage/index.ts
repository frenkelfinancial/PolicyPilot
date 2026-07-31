import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { toE164 } from "../_shared/phone.ts";
import {
  vcEnrollPlanSentence,
  vcEnrollSummary,
  vcEvaluateEnrollment,
  vcFirstStep,
  vcMatchesTriggerGroups,
  vcPlanManualEnrollment,
  vcResolveNextDue,
  vcValidateTriggerGroups,
  VC_ENROLL_TAG_FIELD,
} from "../_shared/voice-campaign-core.ts";
import type { VcEnrollPlan, VcStep } from "../_shared/voice-campaign-core.ts";

// ============================================================
// voice-campaign-manage — the enrollment actions a person can take.
//
//   reevaluate  "Re-evaluate leads now" — run this campaign's trigger rules
//               over the EXISTING book and enroll everyone who matches.
//               Without it a campaign only ever sees leads that arrive after
//               it was switched on, and an agent who just wrote twelve rules
//               has nothing to look at.
//   preview_enroll  what "Add to campaign" would do to this selection.
//   enroll_leads    do it — an EXPLICIT list of leads, no rule involved.
//   unenroll    take one lead out by hand.
//   resume      clear a pause the tick set (empty wallet, plan, kill switch).
//
// ---- The manual door (Prompt I) -------------------------------------------
//
// `reevaluate` enrolls whoever the RULE catches. `enroll_leads` enrols whoever
// the AGENT picked. That is the entire difference: the gate is the same
// function, the enrollment row is the same shape, the tick paces both
// identically, and ai-call-start still runs its full chain on every resulting
// call. Nobody has to understand a trigger group to use the second one.
//
// preview_enroll and enroll_leads share ONE planner (vcPlanManualEnrollment)
// and differ by whether the result is written. A preview computed by separate
// code is a preview that eventually disagrees with the button.
//
// WHY AN EDGE FUNCTION AND NOT RLS. voice_campaign_enrollments is SELECT-only
// for `authenticated`, because an enrollment is a standing instruction to
// place phone calls to a consumer. A browser that could write one could enroll
// a lead with no consent — the compliance story would rest on the UI being
// polite. Here the agent comes FROM THE JWT and every row read or written is
// re-scoped to them; the campaign id in the body is a convenience, not a
// boundary.
//
// The enrollment gate itself (consent, DNC, suppression, one-active-campaign)
// is vcEvaluateEnrollment() — the same function the tick's sweep uses, so the
// button and the cron can never disagree about who is eligible. And it is
// still not the last word: ai-call-start's gate chain runs on every call.
// ============================================================

/** Leads one press of the button may enroll. */
const REEVALUATE_LIMIT = 500;
/** Book page the re-evaluation reads. */
const BOOK_PAGE = 5000;
/**
 * Leads one press of "Add to campaign" may enroll, and how many ids the
 * request may carry. The selection cap matches leads-consent's, because the
 * same selection goes through both buttons and behaving differently on one of
 * them is how an agent learns not to trust either.
 */
const MANUAL_ENROLL_LIMIT = 500;
const MANUAL_SELECTION_MAX = 2000;

Deno.serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = new Date();
  const nowIso = now.toISOString();

  let body: {
    action?: unknown; campaign_id?: unknown; enrollment_id?: unknown; lead_id?: unknown;
    lead_ids?: unknown; on_conflict?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = typeof body.action === "string" ? body.action : "";

  // ------------------------------------------------------------
  // unenroll — one lead, by hand.
  // ------------------------------------------------------------
  if (action === "unenroll") {
    const enrollmentId = typeof body.enrollment_id === "string" ? body.enrollment_id : "";
    if (!enrollmentId) return json({ error: "missing_enrollment_id" }, 400);

    // Re-scoped to the caller. The picker is a convenience, not a boundary.
    const { data: enr } = await sb.from("voice_campaign_enrollments")
      .select("id, agent_id, status")
      .eq("id", enrollmentId)
      .eq("agent_id", user.id)
      .maybeSingle();
    if (!enr) return json({ error: "not_found" }, 404);
    if (enr.status !== "active") return json({ ok: true, already: enr.status });

    await sb.from("voice_campaign_enrollments").update({
      status: "stopped",
      stop_reason: "manual",
      next_action_at: null,
      claimed_at: null,
      completed_at: nowIso,
      updated_at: nowIso,
    }).eq("id", enrollmentId);

    return json({ ok: true, status: "stopped", stop_reason: "manual" });
  }

  // ------------------------------------------------------------
  // resume — clear a pause the tick set.
  // ------------------------------------------------------------
  if (action === "resume") {
    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : "";
    if (!campaignId) return json({ error: "missing_campaign_id" }, 400);
    const { data: camp } = await sb.from("voice_campaigns")
      .select("id").eq("id", campaignId).eq("agent_id", user.id).maybeSingle();
    if (!camp) return json({ error: "not_found" }, 404);

    await sb.from("voice_campaigns").update({
      paused_at: null, pause_reason: null, updated_at: nowIso,
    }).eq("id", campaignId);
    return json({ ok: true, resumed: true });
  }

  // ------------------------------------------------------------
  // preview_enroll / enroll_leads — the manual "Add to campaign" door.
  //
  // ONE code path, two endings. Everything up to and including the plan is
  // identical; `enroll_leads` then writes it. The preview the agent reads and
  // the work the button does are therefore the same decision, not two
  // implementations that agree today.
  // ------------------------------------------------------------
  if (action === "preview_enroll" || action === "enroll_leads") {
    const write = action === "enroll_leads";

    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : "";
    if (!campaignId) return json({ error: "missing_campaign_id" }, 400);

    const leadIds = Array.isArray(body.lead_ids)
      ? [...new Set(body.lead_ids.filter((v): v is string => typeof v === "string" && !!v))]
      : [];
    if (!leadIds.length) return json({ error: "no_leads", detail: "Select at least one lead." }, 400);
    if (leadIds.length > MANUAL_SELECTION_MAX) {
      return json({
        error: "too_many_leads",
        detail: `Up to ${MANUAL_SELECTION_MAX} leads at a time. Narrow the filter and do it in batches.`,
      }, 422);
    }

    // "skip" unless the agent explicitly asked to move. The default is the
    // conservative one: moving a lead ends a campaign somebody set up, and a
    // default that quietly does that is a default that loses work.
    const onConflict = body.on_conflict === "move" ? "move" : "skip";

    // The campaign, re-scoped to the caller. Same rule as everywhere else in
    // this function: the id in the body is a selection, not a boundary.
    const { data: campaign } = await sb.from("voice_campaigns")
      .select("id, agent_id, name, active, paused_at, pause_reason, trigger_groups, " +
              "auto_enroll_new_leads, trigger_on_sold, trigger_on_appointment_booked, " +
              "trigger_on_missed_appointment")
      .eq("id", campaignId)
      .eq("agent_id", user.id)
      .maybeSingle();
    if (!campaign) return json({ error: "not_found" }, 404);

    // NOTE what is deliberately NOT checked here: vcValidateTriggerGroups.
    // The tag rule exists to stop a RULE matching a whole book by accident.
    // This door has no rule — the agent named the leads one at a time — so
    // demanding a valid trigger group would block the exact case this feature
    // was built for: a campaign whose plumbing you never want to think about.
    const { data: stepRows } = await sb.from("voice_campaign_steps")
      .select("id, position, step_type, wait_value, wait_unit, drip_rate, anchor, offset_minutes")
      .eq("campaign_id", campaignId)
      .order("position", { ascending: true });
    const steps = (stepRows || []) as VcStep[];
    if (!vcFirstStep(steps)) {
      return json({ error: "no_steps", detail: "Add at least one step to this campaign before adding leads to it." }, 422);
    }

    const [{ data: leadRows }, { data: seenRows }, { data: activeRows }] = await Promise.all([
      sb.from("leads").select("id, data, tcpa_consent, dnc")
        .eq("agent_id", user.id).in("id", leadIds),
      sb.from("voice_campaign_enrollments").select("lead_id")
        .eq("campaign_id", campaignId).limit(20000),
      sb.from("voice_campaign_enrollments").select("id, lead_id, campaign_id")
        .eq("agent_id", user.id).eq("status", "active").limit(20000),
    ]);

    const leads = leadRows || [];
    const phoneByLead = new Map<string, string>();
    const hasPhone = new Set<string>();
    for (const l of leads) {
      const p = toE164(String(((l.data || {}) as Record<string, unknown>).phone || ""));
      if (p) { phoneByLead.set(l.id, p); hasPhone.add(l.id); }
    }

    const suppressed = new Set<string>();
    if (phoneByLead.size) {
      const { data: suppRows } = await sb.from("suppression_list")
        .select("phone_e164")
        .or(`agent_id.eq.${user.id},agent_id.is.null`)
        .in("phone_e164", [...new Set(phoneByLead.values())])
        .limit(20000);
      const supp = new Set((suppRows || []).map((r) => r.phone_e164));
      for (const [leadId, phone] of phoneByLead) if (supp.has(phone)) suppressed.add(leadId);
    }

    const seenInThisCampaign = new Set((seenRows || []).map((r) => r.lead_id));
    const activeElsewhere = new Map<string, { id: string; campaign_id: string }>();
    for (const r of activeRows || []) {
      // An active enrollment in THIS campaign is not "elsewhere" — it is
      // already covered by seenInThisCampaign, and calling it a conflict
      // would offer to move a lead out of the campaign into itself.
      if (r.campaign_id === campaignId) continue;
      if (!activeElsewhere.has(r.lead_id)) activeElsewhere.set(r.lead_id, { id: r.id, campaign_id: r.campaign_id });
    }

    // Only an appointment-anchored campaign needs these, and only for the
    // leads in hand — read exactly as the tick's sweep reads them (scheduled
    // and still ahead), so the two cannot disagree about who is eligible.
    const appointments = new Map<string, { id: string; starts_at: string }>();
    if (campaign.trigger_on_appointment_booked === true || steps.some((s) => s.anchor === "appointment")) {
      const { data: rows } = await sb.from("ai_appointments")
        .select("id, lead_id, starts_at")
        .eq("agent_id", user.id)
        .eq("status", "scheduled")
        .gt("starts_at", nowIso)
        .in("lead_id", leadIds)
        .order("starts_at", { ascending: true })
        .limit(2000);
      for (const r of rows || []) {
        if (!r.lead_id || !r.starts_at) continue;
        if (!appointments.has(r.lead_id)) appointments.set(r.lead_id, { id: r.id, starts_at: r.starts_at });
      }
    }

    const plan: VcEnrollPlan = vcPlanManualEnrollment({
      lead_ids: leadIds,
      leads,
      steps,
      now,
      seenInThisCampaign,
      activeElsewhere,
      suppressed,
      hasPhone,
      appointments,
      onConflict,
      campaign,
      limit: MANUAL_ENROLL_LIMIT,
    });

    const shape = {
      ok: true,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        active: campaign.active === true,
        paused: !!campaign.paused_at,
        pause_reason: campaign.pause_reason || null,
      },
      on_conflict: onConflict,
      would_enroll: plan.items.length - plan.moves,
      would_move: plan.moves,
      skipped: plan.skipped,
      truncated: plan.truncated,
      tag: plan.tag,
      would_tag: plan.tag_lead_ids.length,
      // The ids, so the modal's "Record consent first →" link can chain
      // straight into the consent tool with exactly the leads that need it.
      no_consent_lead_ids: plan.no_consent_lead_ids,
    };

    if (!write) {
      return json({ ...shape, preview: true, summary: vcEnrollPlanSentence(plan, "will") });
    }

    // ---- Write ------------------------------------------------------------
    // Moves first. Stopping the old enrollment before writing the new one is
    // what keeps the one-active-campaign rule true at every instant: the
    // opposite order leaves a window in which the lead is active twice, and
    // a tick firing inside that window dials them from both.
    let moved = 0;
    const moveIds = plan.items.filter((i) => i.action === "move" && i.from_enrollment_id)
      .map((i) => i.from_enrollment_id as string);
    if (moveIds.length) {
      const { data: stopped, error: mvErr } = await sb.from("voice_campaign_enrollments").update({
        status: "stopped",
        // A distinct reason, not "manual". "Unenrolled by hand" and "moved
        // into another campaign" look identical in a stats table otherwise,
        // and only one of them means the lead is still being worked.
        stop_reason: "moved_by_user",
        next_action_at: null,
        claimed_at: null,
        completed_at: nowIso,
        updated_at: nowIso,
      }).in("id", moveIds).eq("agent_id", user.id).eq("status", "active").select("id");
      if (mvErr) return json({ error: "move_failed", detail: mvErr.message }, 500);
      // What actually stopped, not what we asked to stop — a row the tick
      // ended a millisecond ago was never ours to move.
      moved = (stopped || []).length;
    }

    let enrolledTotal = 0;
    if (plan.items.length) {
      const rows = plan.items.map((i) => ({
        campaign_id: campaignId,
        agent_id: user.id,
        lead_id: i.lead_id,
        status: "active",
        current_step_position: i.current_step_position,
        step_attempts: 0,
        next_action_at: i.next_action_at,
        appointment_id: i.appointment_id,
        // 'manual' is an existing enrolled_by value with an existing CHECK
        // constraint, and it is the true one: a person picked this lead.
        enrolled_by: "manual",
        enrolled_at: nowIso,
        updated_at: nowIso,
      }));
      const { data: inserted, error } = await sb.from("voice_campaign_enrollments")
        .upsert(rows, { onConflict: "campaign_id,lead_id", ignoreDuplicates: true })
        .select("id");
      if (error) return json({ error: "enroll_failed", detail: error.message }, 500);
      enrolledTotal = (inserted || []).length;
    }

    // ---- The tag ----------------------------------------------------------
    // Keeps the data model coherent: a lead added by hand to Final Expense
    // now also matches Final Expense's rule, so the two ways in agree about
    // who belongs here and the assistant says the right lead type on the call.
    //
    // Written here AND by the browser, on purpose. sbUpsertAllLeads()
    // re-upserts the entire book from memory on every save, so a server-only
    // write to leads.data is erased the next time the agent edits anything
    // — the same trap that keeps appointments out of leads.data. This write
    // makes the tag true for the tick right now; the browser's makes it
    // survive. Both derive the value from vcCampaignTag(), so they cannot
    // write different things.
    let tagged = 0;
    if (plan.tag && plan.tag_lead_ids.length) {
      const enrolledIds = new Set(plan.items.map((i) => i.lead_id));
      const byId = new Map(leads.map((l) => [l.id, l]));
      for (const leadId of plan.tag_lead_ids) {
        if (!enrolledIds.has(leadId)) continue;
        const lead = byId.get(leadId);
        if (!lead) continue;
        const data = { ...((lead.data || {}) as Record<string, unknown>) };
        data[VC_ENROLL_TAG_FIELD] = plan.tag;
        const { error: tagErr } = await sb.from("leads")
          .update({ data, updated_at: nowIso })
          .eq("id", leadId).eq("agent_id", user.id);
        // A failed tag write must not fail an enrollment that already
        // happened — the tag is coherence, the enrollment is the request.
        if (!tagErr) tagged++;
      }
    }

    return json({
      ...shape,
      preview: false,
      // `enrolled` counts FRESH enrollments and excludes moves, so it lines
      // up with `would_enroll` from the preview the agent just read. Both
      // numbers together are what the toast says.
      enrolled: Math.max(0, enrolledTotal - moved),
      moved,
      enrolled_total: enrolledTotal,
      tagged,
      summary: vcEnrollPlanSentence(plan, "did"),
    });
  }

  // ------------------------------------------------------------
  // reevaluate — run the rules over the existing book.
  // ------------------------------------------------------------
  if (action !== "reevaluate") return json({ error: "unknown_action" }, 400);

  const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : "";
  if (!campaignId) return json({ error: "missing_campaign_id" }, 400);

  const { data: campaign } = await sb.from("voice_campaigns")
    .select("id, agent_id, name, trigger_groups, trigger_on_appointment_booked")
    .eq("id", campaignId)
    .eq("agent_id", user.id)
    .maybeSingle();
  if (!campaign) return json({ error: "not_found" }, 404);

  // The tag rule holds here too. Re-evaluating an unbounded rule over an entire
  // book is the single worst thing this endpoint could be asked to do, and
  // "the campaign was saved as a draft" is exactly how it would be asked.
  const validation = vcValidateTriggerGroups(campaign.trigger_groups);
  if (!validation.ok) {
    return json({ error: "invalid_trigger_groups", detail: validation.error }, 422);
  }

  const { data: stepRows } = await sb.from("voice_campaign_steps")
    .select("id, position, step_type, wait_value, wait_unit, drip_rate, anchor, offset_minutes")
    .eq("campaign_id", campaignId)
    .order("position", { ascending: true });
  const steps = (stepRows || []) as VcStep[];
  const first = vcFirstStep(steps);
  if (!first) {
    return json({ error: "no_steps", detail: "Add at least one step before enrolling anyone." }, 422);
  }

  const [{ data: seen }, { data: activeAnywhere }, { data: book }, { data: suppRows }] = await Promise.all([
    sb.from("voice_campaign_enrollments").select("lead_id").eq("campaign_id", campaignId).limit(20000),
    sb.from("voice_campaign_enrollments").select("lead_id").eq("agent_id", user.id).eq("status", "active").limit(20000),
    sb.from("leads").select("id, data, tcpa_consent, dnc").eq("agent_id", user.id)
      .order("created_at", { ascending: false }).limit(BOOK_PAGE),
    sb.from("suppression_list").select("phone_e164")
      .or(`agent_id.eq.${user.id},agent_id.is.null`).limit(20000),
  ]);

  const seenIds     = new Set((seen || []).map((r) => r.lead_id));
  const activeIds   = new Set((activeAnywhere || []).map((r) => r.lead_id));
  const suppressed  = new Set((suppRows || []).map((r) => r.phone_e164));

  // An appointment-anchored campaign counts down to a specific meeting, so
  // "re-evaluate the book" means "find everyone with one still ahead of them".
  // Read the same way the tick's sweep reads it — future and scheduled only —
  // so the button and the cron cannot disagree about who is eligible.
  const upcomingAppt = new Map<string, { id: string; starts_at: string }>();
  if (campaign.trigger_on_appointment_booked === true) {
    const { data: rows } = await sb.from("ai_appointments")
      .select("id, lead_id, starts_at")
      .eq("agent_id", user.id)
      .eq("status", "scheduled")
      .gt("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(2000);
    for (const r of rows || []) {
      if (!r.lead_id || !r.starts_at) continue;
      if (!upcomingAppt.has(r.lead_id)) upcomingAppt.set(r.lead_id, { id: r.id, starts_at: r.starts_at });
    }
  }

  let matched = 0;
  const skipped: Record<string, number> = {};
  const rows: Record<string, unknown>[] = [];

  for (const lead of book || []) {
    if (!vcMatchesTriggerGroups(lead, campaign.trigger_groups)) continue;
    matched++;
    if (seenIds.has(lead.id)) {
      skipped.already_enrolled = (skipped.already_enrolled || 0) + 1;
      continue;
    }
    if (rows.length >= REEVALUATE_LIMIT) {
      skipped.over_limit = (skipped.over_limit || 0) + 1;
      continue;
    }
    const d = (lead.data || {}) as Record<string, unknown>;
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
    const appt = upcomingAppt.get(lead.id) || null;
    // Anchored steps whose moment has already gone are skipped, never fired
    // late; a lead with nothing left to fire is not enrolled at all.
    const firstDue = vcResolveNextDue({
      steps, now, appointmentAt: appt ? appt.starts_at : null,
    });
    if (!firstDue.step || !firstDue.dueAt) {
      skipped.appointment_too_soon = (skipped.appointment_too_soon || 0) + 1;
      continue;
    }
    rows.push({
      campaign_id: campaignId,
      agent_id: user.id,
      lead_id: lead.id,
      status: "active",
      current_step_position: firstDue.step.position,
      step_attempts: 0,
      next_action_at: firstDue.dueAt,
      appointment_id: appt ? appt.id : null,
      enrolled_by: "reevaluate",
      enrolled_at: nowIso,
      updated_at: nowIso,
    });
    activeIds.add(lead.id);
  }

  let enrolled = 0;
  if (rows.length) {
    const { data: inserted, error } = await sb.from("voice_campaign_enrollments")
      .upsert(rows, { onConflict: "campaign_id,lead_id", ignoreDuplicates: true })
      .select("id");
    if (error) return json({ error: "enroll_failed", detail: error.message }, 500);
    enrolled = (inserted || []).length;
  }

  return json({
    ok: true,
    matched,
    enrolled,
    skipped,
    // The exact sentence the toast shows, built by the same function the
    // browser would use, so the two can never word it differently.
    summary: vcEnrollSummary(enrolled, skipped),
  });
});
