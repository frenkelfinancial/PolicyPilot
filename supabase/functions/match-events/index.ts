// ============================================================
// supabase/functions/match-events/index.ts
//
// Step 4 — matching. Takes unmatched, policy-scoped parsed_events and tries to
// attach each to one of the user's existing policies:
//   - exact policy-number / TA masked last-5 (high confidence) -> set matched_policy_id
//   - name+carrier candidate(s), ambiguity, or nothing          -> review_queue
// Commission/debt events are not policy-scoped and are skipped here (Step 5
// routes those to the commission page directly).
//
// Read-only against policies (never overwrites policy data — that's Step 5's
// apply step, gated by exact match + confidence). Idempotent: re-running only
// re-touches still-unmatched events, and review_queue is unique per event.
//
// Invocation mirrors the other functions: a user's JWT scopes to their rows,
// the service role processes everyone (cron).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { carrierKeyFromText, isPolicyEvent, matchEvent } from "../_shared/email/matcher.ts";
import type { PolicyRef } from "../_shared/email/matcher.ts";

const ALLOWED_ORIGINS = new Set(["https://producerstackcrm.com", "https://localhost"]);
function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://producerstackcrm.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const MAX_EVENTS = 300;

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

  // Unmatched extractions.
  let q = sb
    .from("parsed_events")
    .select("id, user_id, carrier, event_type, policy_number_raw, client_name, confidence")
    .is("matched_policy_id", null)
    .eq("applied", false)
    .limit(MAX_EVENTS);
  if (scopeUserId) q = q.eq("user_id", scopeUserId);
  const { data: events, error: evErr } = await q;
  if (evErr) return json({ error: "db_error", detail: evErr.message }, 500);

  const policyEvents = (events ?? []).filter((e) => isPolicyEvent(e.event_type));
  if (!policyEvents.length) return json({ ok: true, considered: 0, note: "nothing to match" });

  // Load each involved user's policies once (JSONB blob store).
  const userIds = [...new Set(policyEvents.map((e) => e.user_id))];
  const policiesByUser = new Map<string, PolicyRef[]>();
  for (const uid of userIds) {
    const { data: pols } = await sb.from("policies").select("id, data").eq("agent_id", uid);
    policiesByUser.set(uid, (pols ?? []).map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        policyNumber: (d.policyNumber as string) ?? (d.policy_number as string) ?? null,
        name: (d.name as string) ?? (d.client as string) ?? null,
        carrierKey: carrierKeyFromText(d.carrier as string),
      };
    }));
  }

  const totals = { considered: policyEvents.length, matched: 0, ambiguous_match: 0, no_policy_match: 0, low_confidence: 0 };

  for (const e of policyEvents) {
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
      await sb.from("parsed_events").update({ matched_policy_id: r.policyId }).eq("id", e.id);
      totals.matched++;
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
