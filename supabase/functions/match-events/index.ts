// ============================================================
// supabase/functions/match-events/index.ts
//
// Step 4+5 — matching AND apply. Takes unapplied, policy-scoped parsed_events
// and tries to attach each to one of the user's existing policies:
//   - exact policy-number / TA masked last-5 (high confidence) -> auto-attach
//   - UNIQUE strong name+carrier match (high confidence)       -> auto-attach
//   - fuzzy/multiple candidate(s), ambiguity, or nothing       -> review_queue
//
// APPLY (build plan Phase 4 task 16 / §7): every auto-attached event is
// written back to the policy tracker —
//   - event_type maps to a tracker status (see STATUS_MAP); statuses only move
//     FORWARD (pending -> approved -> issued -> paid) or to 'lapsed'. A late
//     "submitted" email never downgrades an issued policy, and nothing ever
//     touches 'paid'/'chargeback' (those are money states the agent owns).
//   - unmasked policy numbers are backfilled onto the policy (data.policyNumber)
//     so future emails match exactly instead of by name.
//   - every applied event is appended to policy_events (audit trail the agent
//     can see/undo), and parsed_events.applied is set true.
// Informational events (requirement, payment_scheduled, payment_returned,
// lapse_pending, other) attach + log but do NOT change status.
//
// Commission/debt events are not policy-scoped and are skipped here.
// Idempotent: re-running only re-touches still-unapplied events, and
// review_queue is unique per event.
//
// Invocation mirrors the other functions: a user's JWT scopes to their rows,
// the service role processes everyone (cron).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { carrierKeyFromText, isMasked, isPolicyEvent, matchEvent } from "../_shared/email/matcher.ts";
import type { PolicyRef } from "../_shared/email/matcher.ts";
import { corsHeaders } from "../_shared/cors.ts";

const MAX_EVENTS = 300;

// event_type -> tracker status. Types absent here attach + log only.
// Tracker vocabulary (app.html PT_STATUS_ORDER): pending, approved, issued,
// paid, lapsed, chargeback. 'paid' and 'chargeback' are never set from email.
const STATUS_MAP: Record<string, string> = {
  submitted: "pending",
  approved: "approved",
  policy_active: "issued",
  declined: "lapsed",
  withdrawn: "lapsed",
  closed: "lapsed",
};

// Forward-only ordering; 'lapsed' reachable from any non-terminal status.
const STATUS_RANK: Record<string, number> = { pending: 0, approved: 1, issued: 2, paid: 3 };
const TERMINAL = new Set(["lapsed", "chargeback"]);

// Decide the tracker's new status (or null for "leave it alone").
export function nextStatus(current: string | null | undefined, eventType: string): string | null {
  const target = STATUS_MAP[eventType];
  if (!target) return null;
  const cur = current || "pending";
  if (TERMINAL.has(cur)) return null; // never resurrect or re-kill automatically
  if (cur === "paid") return null; // money state — the agent decides lapsed vs chargeback
  if (target === "lapsed") return "lapsed";
  return (STATUS_RANK[target] ?? -1) > (STATUS_RANK[cur] ?? 0) ? target : null;
}

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  let scopeUserId: string | null = null;
  const { data: { user } } = await sb.auth.getUser(token);
  if (user) scopeUserId = user.id;
  else if (token !== SERVICE_KEY) return json({ error: "unauthorized" }, 401);

  // Unapplied extractions (newest first so a backlog never starves fresh mail).
  // Events matched by an earlier run but never applied are picked up here too.
  let q = sb
    .from("parsed_events")
    .select("id, user_id, carrier, event_type, policy_number_raw, client_name, confidence, event_date, details, matched_policy_id")
    .eq("applied", false)
    .order("created_at", { ascending: false })
    .limit(MAX_EVENTS);
  if (scopeUserId) q = q.eq("user_id", scopeUserId);
  const { data: events, error: evErr } = await q;
  if (evErr) return json({ error: "db_error", detail: evErr.message }, 500);

  const policyEvents = (events ?? []).filter((e) => isPolicyEvent(e.event_type));
  if (!policyEvents.length) return json({ ok: true, considered: 0, applied: 0, note: "nothing to match" });

  // Load each involved user's policies once (JSONB blob store). Keep the raw
  // rows so the apply step can read-modify-write the data blob.
  const userIds = [...new Set(policyEvents.map((e) => e.user_id))];
  const policiesByUser = new Map<string, PolicyRef[]>();
  const rawPolicyById = new Map<string, { id: string; data: Record<string, unknown> }>();
  for (const uid of userIds) {
    const { data: pols } = await sb.from("policies").select("id, data").eq("agent_id", uid);
    policiesByUser.set(uid, (pols ?? []).map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      rawPolicyById.set(r.id, { id: r.id, data: d });
      return {
        id: r.id,
        policyNumber: (d.policyNumber as string) ?? (d.policy_number as string) ?? null,
        name: (d.name as string) ?? (d.client as string) ?? null,
        carrierKey: carrierKeyFromText(d.carrier as string),
      };
    }));
  }

  const totals = {
    considered: policyEvents.length,
    matched: 0,
    applied: 0, // events written back to the tracker (status change or log)
    status_changed: 0, // subset that actually moved the tracker status
    ambiguous_match: 0,
    no_policy_match: 0,
    low_confidence: 0,
    apply_failed: 0,
  };

  // Attach + apply one event to one policy. Returns true on success.
  async function applyEvent(e: (typeof policyEvents)[number], policyId: string): Promise<boolean> {
    const raw = rawPolicyById.get(policyId);
    if (!raw) return false;
    const d = { ...raw.data };
    const oldStatus = (d.status as string) ?? null;
    const newStatus = nextStatus(oldStatus, e.event_type);
    const summary = (e.details && (e.details as Record<string, unknown>).summary as string) || null;

    if (newStatus) d.status = newStatus;
    // Backfill an unmasked policy number so future emails match exactly.
    if (e.policy_number_raw && !isMasked(e.policy_number_raw) && !d.policyNumber) {
      d.policyNumber = e.policy_number_raw;
    }
    d.lastCarrierUpdate = {
      at: new Date().toISOString(),
      event_type: e.event_type,
      event_date: e.event_date ?? null,
      summary,
    };

    const { error: upErr } = await sb.from("policies").update({ data: d }).eq("id", policyId);
    if (upErr) { console.error("policy update failed", policyId, upErr.message); return false; }
    raw.data = d; // keep in-memory copy current for multi-event emails

    const { error: logErr } = await sb.from("policy_events").insert({
      user_id: e.user_id,
      policy_id: policyId,
      parsed_event_id: e.id,
      carrier: e.carrier,
      event_type: e.event_type,
      client_name: e.client_name,
      old_status: oldStatus,
      new_status: newStatus, // null = informational, no status change
      summary,
      event_date: e.event_date ?? null,
    });
    if (logErr) console.error("policy_events insert failed", e.id, logErr.message);

    await sb.from("parsed_events").update({ matched_policy_id: policyId, applied: true }).eq("id", e.id);
    if (newStatus) totals.status_changed++;
    return true;
  }

  for (const e of policyEvents) {
    // Already matched by a previous run (or a human) but never applied.
    if (e.matched_policy_id) {
      if (await applyEvent(e, e.matched_policy_id)) totals.applied++;
      else totals.apply_failed++;
      continue;
    }

    const pols = policiesByUser.get(e.user_id) ?? [];
    const r = matchEvent(
      {
        policyNumber: e.policy_number_raw,
        clientName: e.client_name,
        carrier: e.carrier,
        eventType: e.event_type,
        confidence: Number(e.confidence) || 0,
      },
      pols,
    );

    if (r.status === "matched") {
      totals.matched++;
      if (await applyEvent(e, r.policyId)) totals.applied++;
      else totals.apply_failed++;
    } else {
      await sb.from("review_queue").upsert(
        { parsed_event_id: e.id, user_id: e.user_id, reason: r.reason, candidate_policy_ids: r.candidateIds },
        { onConflict: "parsed_event_id", ignoreDuplicates: true },
      );
      totals[r.reason]++;
    }
  }

  return json({ ok: true, ...totals });
});
