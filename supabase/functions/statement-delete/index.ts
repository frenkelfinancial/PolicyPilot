// ============================================================
// supabase/functions/statement-delete/index.ts
//
// Back Office FIX3: the removal path for a statement.
//
// WHY AN EDGE FUNCTION AND NOT A SECURITY DEFINER RPC. `statement-review` is
// an edge function that takes the agent from the JWT, and this is the same
// class of operation on the same four tables. One pattern, not two. A
// SECURITY DEFINER RPC would work equally well on the security axis and is
// how `apply_producer_codes` is built — but then the Back Office would have
// two different doors onto commission data with two different sets of
// reasoning to keep in step, and the next person would have to work out which
// one a new action belongs in.
//
// `commission_statements`, `statement_files`, `statement_extractions` and
// `commission_rows` are SELECT-only for `authenticated` and STAY that way. A
// DELETE policy wide enough to let the browser remove its own commission row
// is wide enough to let it remove somebody else's, and none of the four tables
// gains a write policy in this round. Every write here is under the service
// role with the agent taken FROM THE JWT — there is no agent id in the
// request body, because a body-supplied one would be a way into another
// agent's book.
//
// Two actions, and they are THE SAME CALL WITH ONE FLAG:
//   preview  what would go, and which policies this statement moved
//   delete   the same plan, carried out
// Both build the impact with summarizeStatementDeletion(); only the second
// deletes. A preview computed by separate code is a preview that eventually
// lies, and this modal's whole job is to promise what the button will do —
// the same reasoning as voice-campaigns' preview_enroll / enroll_leads.
//
// 🔴 DELETING A STATEMENT NEVER REWRITES THE BOOK (decision 1). Policies keep
// whatever status they hold. `policy_status_history` is owner-APPENDABLE with
// no update and no delete policy — the trail cannot be rewritten, and a
// carrier having said "charged back" stays true after the paperwork proving it
// is removed. `source_ref_id` carries no foreign key, so those rows survive
// the delete intact and deliberately. What the agent is owed is the LIST of
// policies the statement moved, before and after, so they can check them.
//
// Callers: the browser with a user JWT. verify_jwt stays TRUE, so this
// function is deliberately ABSENT from supabase/config.toml. It sends no
// custom request headers, so it needs nothing added to ALLOW_HEADERS.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { summarizeStatementDeletion } from "../_shared/statement-core.ts";
import type { MovedPolicy } from "../_shared/statement-core.ts";

const ACTIONS = ["preview", "delete"] as const;
type Action = typeof ACTIONS[number];

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

  let body: { action?: string; statement_id?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const action = String(body.action || "preview") as Action;
  if (!ACTIONS.includes(action)) {
    return json({ error: "unknown_action", detail: `action must be one of ${ACTIONS.join(", ")}` }, 400);
  }
  const statementId = String(body.statement_id || "");
  if (!statementId) return json({ error: "no_statement" }, 400);

  // ---- the statement must be the caller's own ----
  //
  // Scoped by agent_id in the same query that fetches it, so a statement
  // belonging to somebody else is indistinguishable from one that does not
  // exist. Telling a caller "that id is real but not yours" is itself a
  // disclosure, the same reasoning statement-review applies to rows.
  const { data: st, error: stErr } = await sb
    .from("commission_statements")
    .select("id, agent_id, filename, status, row_count, total_amount_cents")
    .eq("id", statementId)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (stErr) return json({ error: "read_failed", detail: stErr.message }, 500);
  if (!st) return json({ error: "statement_not_found" }, 404);

  // ---- children: a ZIP's members cascade with it ----
  //
  // `commission_statements.parent_statement_id` references the same table
  // ON DELETE CASCADE, so removing an archive removes every statement that
  // came out of it and every row those produced. That is the right behaviour
  // — the archive IS the upload — but it is invisible from the row the agent
  // clicked, so the confirmation has to count them.
  const { data: kids } = await sb
    .from("commission_statements")
    .select("id, filename")
    .eq("parent_statement_id", st.id)
    .eq("agent_id", agentId);
  const children = kids ?? [];
  const allIds = [st.id, ...children.map((c) => c.id as string)];

  // ---- the money about to go ----
  const { data: rows, error: rowErr } = await sb
    .from("commission_rows")
    .select("amount_cents")
    .in("statement_id", allIds)
    .eq("agent_id", agentId);
  if (rowErr) return json({ error: "read_failed", detail: rowErr.message }, 500);

  // ---- what this statement did to the book ----
  //
  // `policy_status_history` is the record of it: statement-parse writes one row
  // per change with source='statement' and source_ref_id naming the statement.
  // Read for REPORTING only — nothing below rewrites or removes any of it.
  const { data: hist } = await sb
    .from("policy_status_history")
    .select("policy_id, policy_client_id, old_status, new_status, changed_at")
    .in("source_ref_id", allIds)
    .eq("source", "statement")
    .eq("agent_id", agentId)
    .order("changed_at", { ascending: true });

  const moved: MovedPolicy[] = [];
  const histRows = hist ?? [];
  if (histRows.length > 0) {
    const polIds = [...new Set(histRows.map((h) => h.policy_id).filter(Boolean))] as string[];
    const { data: pols } = polIds.length
      ? await sb.from("policies").select("id, data").in("id", polIds).eq("agent_id", agentId)
      : { data: [] as { id: string; data: Record<string, unknown> }[] };
    const byId = new Map((pols ?? []).map((p) => [p.id as string, (p.data ?? {}) as Record<string, unknown>]));
    for (const h of histRows) {
      const d = byId.get(h.policy_id as string) || {};
      moved.push({
        policy_id: (h.policy_id as string) ?? null,
        policy_client_id: (h.policy_client_id as number) ?? null,
        policy_number: (d.policyNumber as string) ?? null,
        insured_name: (d.client as string) ?? null,
        from_status: (h.old_status as string) ?? null,
        to_status: (h.new_status as string) ?? null,
        changed_at: (h.changed_at as string) ?? null,
      });
    }
  }

  const impact = summarizeStatementDeletion({
    statement: { id: st.id as string, filename: st.filename as string },
    children: children.map((c) => ({ id: c.id as string, filename: c.filename as string })),
    rows: rows ?? [],
    history: moved,
  });

  if (action === "preview") return json({ ok: true, action, deleted: false, impact });

  // ---- carry it out ----
  //
  // ONE delete. Every dependent table references commission_statements ON
  // DELETE CASCADE — commission_rows, statement_files, statement_extractions
  // and the table itself for ZIP members — so the parent row is sufficient and
  // deleting the children by hand first would only open a window where the
  // money is gone and the statement is not. Verified against the live
  // catalogue, not just the migration text: four foreign keys reference this
  // table and all four cascade.
  //
  // The eq("agent_id") is redundant after the ownership check above and is
  // here anyway: it is the last statement standing between a bug in this
  // function and another agent's book.
  const { error: delErr } = await sb
    .from("commission_statements")
    .delete()
    .eq("id", st.id)
    .eq("agent_id", agentId);
  if (delErr) return json({ error: "delete_failed", detail: delErr.message }, 500);

  return json({ ok: true, action, deleted: true, impact });
});
