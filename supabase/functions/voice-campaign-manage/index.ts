import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { toE164 } from "../_shared/phone.ts";
import {
  vcEnrollSummary,
  vcEvaluateEnrollment,
  vcFirstStep,
  vcMatchesTriggerGroups,
  vcStepDueAt,
  vcValidateTriggerGroups,
} from "../_shared/voice-campaign-core.ts";
import type { VcStep } from "../_shared/voice-campaign-core.ts";

// ============================================================
// voice-campaign-manage — the two enrollment actions a person can take.
//
//   reevaluate  "Re-evaluate leads now" — run this campaign's trigger rules
//               over the EXISTING book and enroll everyone who matches.
//               Without it a campaign only ever sees leads that arrive after
//               it was switched on, and an agent who just wrote twelve rules
//               has nothing to look at.
//   unenroll    take one lead out by hand.
//   resume      clear a pause the tick set (empty wallet, plan, kill switch).
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

  let body: { action?: unknown; campaign_id?: unknown; enrollment_id?: unknown; lead_id?: unknown };
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
  // reevaluate — run the rules over the existing book.
  // ------------------------------------------------------------
  if (action !== "reevaluate") return json({ error: "unknown_action" }, 400);

  const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : "";
  if (!campaignId) return json({ error: "missing_campaign_id" }, 400);

  const { data: campaign } = await sb.from("voice_campaigns")
    .select("id, agent_id, name, trigger_groups")
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
    .select("id, position, step_type, wait_value, wait_unit, drip_rate")
    .eq("campaign_id", campaignId)
    .order("position", { ascending: true });
  const first = vcFirstStep((stepRows || []) as VcStep[]);
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
    rows.push({
      campaign_id: campaignId,
      agent_id: user.id,
      lead_id: lead.id,
      status: "active",
      current_step_position: first.position,
      step_attempts: 0,
      next_action_at: vcStepDueAt(now, first).toISOString(),
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
