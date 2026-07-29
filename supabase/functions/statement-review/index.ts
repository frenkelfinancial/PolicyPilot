// ============================================================
// supabase/functions/statement-review/index.ts
//
// Back Office Phase 6: the write path for the Reconciliation screen.
//
// `commission_rows` is SELECT-only for `authenticated` and stays that way. An
// UPDATE policy wide enough to let the browser set `review_status` is wide
// enough to let it set `matched_policy_id`, and pointing a commission row at
// another agent's policy is precisely what this schema is built to prevent.
// So every resolution goes through here, under the service role, with the
// agent taken FROM THE JWT — there is no agent id in the request body, because
// a body-supplied one would be a way to write into somebody else's book.
//
// Four actions:
//   approve  accept the match the parser proposed (or an already-set one)
//   match    point the row at a policy the agent chose, by client_id
//   unmatch  detach a wrong match and put the row back in the queue
//   reject   this line is not mine / ignore it — never a delete
//
// NOTHING IS EVER DELETED. `reject` sets a status; the row, its amount, its
// raw source and its statement all stay. "Nothing is discarded" is the rule
// the whole Back Office is built on, and a reconciliation screen that could
// delete a commission line would be the one place it broke.
//
// Callers: the browser with a user JWT. verify_jwt stays TRUE, so this
// function is deliberately ABSENT from supabase/config.toml.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const ACTIONS = ["approve", "match", "unmatch", "reject"] as const;
type Action = typeof ACTIONS[number];

const MAX_NOTE = 500;

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // ---- the agent comes from the token, never from the body ----
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return json({ error: "unauthorized" }, 401);
  const agentId = user.id;

  let body: {
    action?: string;
    row_ids?: string[];
    row_id?: string;
    policy_client_id?: number | string;
    note?: string;
  } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const action = String(body.action || "") as Action;
  if (!ACTIONS.includes(action)) {
    return json({ error: "unknown_action", detail: `action must be one of ${ACTIONS.join(", ")}` }, 400);
  }

  // Bulk is the normal case on this screen — an agent clears twenty lines from
  // one statement in one go — so a single id is just a batch of one.
  const ids = (body.row_ids && Array.isArray(body.row_ids) ? body.row_ids : [])
    .concat(body.row_id ? [body.row_id] : [])
    .filter((v) => typeof v === "string" && v.length > 0);
  if (ids.length === 0) return json({ error: "no_rows" }, 400);
  if (ids.length > 500) return json({ error: "too_many_rows", detail: "500 at a time" }, 400);

  const note = typeof body.note === "string" ? body.note.slice(0, MAX_NOTE) : null;

  // ---- the rows must be the caller's own ----
  const { data: rows, error: rowErr } = await sb
    .from("commission_rows")
    .select("id, agent_id, matched_policy_id, review_status")
    .in("id", ids)
    .eq("agent_id", agentId);
  if (rowErr) return json({ error: "read_failed", detail: rowErr.message }, 500);
  const mine = (rows ?? []).map((r) => r.id as string);
  // A row that is not the caller's is silently absent from `mine` rather than
  // reported — telling a caller "that row exists but is not yours" is itself a
  // disclosure. The count they get back is of what actually changed.
  if (mine.length === 0) return json({ ok: true, updated: 0, skipped: ids.length });

  const patch: Record<string, unknown> = {
    reviewed_at: new Date().toISOString(),
    reviewed_by: agentId,
  };
  if (note !== null) patch.review_note = note;

  if (action === "approve") {
    // Approving a row that was never matched would claim a link that does not
    // exist. Say so rather than quietly marking it done.
    const unmatched = (rows ?? []).filter((r) => !r.matched_policy_id);
    if (unmatched.length > 0) {
      return json({
        error: "nothing_to_approve",
        detail: "These lines are not linked to a policy yet. Choose a policy first, or reject the line.",
        row_ids: unmatched.map((r) => r.id),
      }, 400);
    }
    patch.review_status = "approved";
  } else if (action === "reject") {
    patch.review_status = "rejected";
  } else if (action === "unmatch") {
    patch.matched_policy_id = null;
    patch.match_method = null;
    patch.match_confidence = null;
    patch.review_status = "needs_review";
    patch.review_reason = "Match removed by the agent";
  } else if (action === "match") {
    const clientId = Number(body.policy_client_id);
    if (!Number.isFinite(clientId)) return json({ error: "bad_policy" }, 400);
    // THE CHECK THAT MATTERS: the target policy must belong to the caller.
    // Without it, an agent could point their own commission row at somebody
    // else's policy id and learn that it exists.
    const { data: pol, error: polErr } = await sb
      .from("policies").select("id")
      .eq("agent_id", agentId).eq("client_id", clientId).maybeSingle();
    if (polErr) return json({ error: "policy_lookup_failed", detail: polErr.message }, 500);
    if (!pol) return json({ error: "policy_not_found" }, 404);
    patch.matched_policy_id = pol.id;
    patch.match_method = "manual";
    patch.match_confidence = 1;
    patch.review_status = "approved";
    patch.review_reason = null;
  }

  const { data: updated, error: upErr } = await sb
    .from("commission_rows").update(patch).in("id", mine).select("id");
  if (upErr) return json({ error: "update_failed", detail: upErr.message }, 500);

  // Keep the statement's review counter honest — it is what the Ingest screen
  // and the pipeline strip render, and a resolved row that still counts as
  // "pending review" is the screen telling the agent their work did nothing.
  const statementIds = new Set<string>();
  const { data: touched } = await sb
    .from("commission_rows").select("statement_id").in("id", mine);
  (touched ?? []).forEach((r) => statementIds.add(r.statement_id as string));
  for (const sid of statementIds) {
    const { count } = await sb
      .from("commission_rows")
      .select("id", { count: "exact", head: true })
      .eq("statement_id", sid).eq("review_status", "needs_review");
    const { count: matched } = await sb
      .from("commission_rows")
      .select("id", { count: "exact", head: true })
      .eq("statement_id", sid).not("matched_policy_id", "is", null);
    await sb.from("commission_statements")
      .update({ review_count: count ?? 0, matched_count: matched ?? 0 })
      .eq("id", sid).eq("agent_id", agentId);
  }

  return json({
    ok: true,
    action,
    updated: (updated ?? []).length,
    skipped: ids.length - mine.length,
    statements_recounted: statementIds.size,
  });
});
