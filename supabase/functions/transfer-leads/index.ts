import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  agencyPeers,
  planTransfer,
  sanitizeTransferredLead,
  summarizeTransfer,
  CLEARED_ON_TRANSFER,
  TRANSFER_MAX_PER_REQUEST,
  type AgencyInviteRow,
  type SenderLeadRow,
} from "../_shared/lead-transfer.ts";

// ============================================================
// transfer-leads — move leads from the caller to an agency colleague.
//
// WHY THIS IS AN EDGE FUNCTION AND NOT A POSTGREST CALL
// -----------------------------------------------------
// A transfer writes a row the caller does not own: it sets
// leads.agent_id to somebody else. The only RLS policy that could permit
// that from the browser is one that lets an agent write another agent's
// leads — which is exactly the thing we refuse to add, because a policy
// broad enough to allow this write is broad enough to allow every write
// we are defending against. So the move runs here, under the service
// role, and the authorization is re-derived server-side from the caller's
// JWT. The client is never trusted for anything except which lead ids it
// would like to send.
//
// AUTHORIZATION
// -------------
// Sender and recipient must share an agency through an ACCEPTED
// agency_invites row: leader->downline, downline->leader, or
// downline->downline under a shared leader. The rule lives in
// _shared/lead-transfer.ts (agencyPeers) so it is unit-tested, and
// public.get_agency_members() mirrors it for the picker. Sender identity
// comes from the JWT, never from the body.
//
// COMPLIANCE
// ----------
// consent_records rows are NOT copied, moved, or re-attributed. SMS
// consent names a specific sending agency and does not travel with the
// consumer. leadTextingState() in app.html reads consent_records scoped
// to the viewing agent, so a transferred lead lands on the recipient as
// needs_optin with no code change — verified, not assumed.
//
// dnc_list rows are never touched. The lead's own dnc/dnc_at columns move
// with the row and are never cleared; the tcpa_consent columns ARE
// cleared (see CLEARED_ON_TRANSFER) because consent to contact was given
// to a different entity.
//
// Nothing is sent to the consumer. A transfer is silent to the lead.
//
// IDEMPOTENCY
// -----------
// A retry finds the leads no longer owned by the sender and reports them
// as already_transferred rather than erroring. Nothing is written twice.
//
// Request:  { recipient_id: uuid, lead_client_ids: string[] }
// Response: { ok, sent, skipped, refused, summary, moved: [{from,to}] }
// ============================================================

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

  // --- who is calling (JWT only — the body never names the sender) ---
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const senderId = user.id;

  let body: { recipient_id?: unknown; lead_client_ids?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const recipientId = typeof body.recipient_id === "string" ? body.recipient_id.trim() : "";
  if (!recipientId) {
    return json({ error: "recipient_required", detail: "Pick who the leads are going to." }, 400);
  }
  if (recipientId === senderId) {
    return json({ error: "self_transfer", detail: "You already have these leads." }, 400);
  }

  const rawIds = Array.isArray(body.lead_client_ids) ? body.lead_client_ids : [];
  const requestedClientIds = [...new Set(
    rawIds.filter((v) => typeof v === "string" || typeof v === "number").map((v) => String(v)),
  )];
  if (!requestedClientIds.length) {
    return json({ error: "no_leads", detail: "Select at least one lead to send." }, 400);
  }
  // Bounded before any I/O so an absurd payload cannot make us do work.
  if (requestedClientIds.length > TRANSFER_MAX_PER_REQUEST * 4) {
    return json({
      error: "too_many",
      detail: `Send at most ${TRANSFER_MAX_PER_REQUEST} leads at a time.`,
    }, 400);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- authorization: re-derive the agency link, do not trust the client ---
  //
  // Two scoped reads rather than one unscoped one. The first gets every
  // accepted invite the caller is personally on (their uplines and their
  // downlines); the second gets the other invitees of those uplines, which
  // is what makes a sibling a peer. Selecting every accepted invite in the
  // system would work today — the table is small — and would quietly become
  // a full scan of every agency's roster on every send.
  const { data: ownRows, error: inviteErr } = await sb
    .from("agency_invites")
    .select("leader_id, invitee_id, status")
    .eq("status", "accepted")
    .or(`invitee_id.eq.${senderId},leader_id.eq.${senderId}`);
  if (inviteErr) {
    return json({ error: "agency_lookup_failed", detail: inviteErr.message }, 500);
  }

  const inviteRows: AgencyInviteRow[] = [...((ownRows || []) as AgencyInviteRow[])];
  const uplineIds = inviteRows
    .filter((r) => r.invitee_id === senderId)
    .map((r) => r.leader_id);
  if (uplineIds.length) {
    const { data: siblingRows, error: sibErr } = await sb
      .from("agency_invites")
      .select("leader_id, invitee_id, status")
      .eq("status", "accepted")
      .in("leader_id", uplineIds);
    if (sibErr) {
      return json({ error: "agency_lookup_failed", detail: sibErr.message }, 500);
    }
    inviteRows.push(...((siblingRows || []) as AgencyInviteRow[]));
  }

  const peers = agencyPeers(inviteRows, senderId);
  if (!peers.has(recipientId)) {
    // Deliberately the same answer whether the recipient does not exist, is
    // in another agency, or is a stranger — a probe learns nothing.
    return json({
      error: "not_in_your_agency",
      detail: "You can only send leads to agents connected to you through your agency.",
    }, 403);
  }

  // --- sender's side: only rows this caller actually owns ---
  const { data: senderLeads, error: senderErr } = await sb
    .from("leads")
    .select("id, client_id, data")
    .eq("agent_id", senderId)
    .in("client_id", requestedClientIds);
  if (senderErr) {
    return json({ error: "lead_lookup_failed", detail: senderErr.message }, 500);
  }

  // --- recipient's side: phones (dedupe) and client_ids (unique constraint) ---
  // `phone:data->>phone` keeps this to two scalars per row instead of
  // dragging the whole payload across for a book that can be thousands deep.
  const { data: recipientLeads, error: recipientErr } = await sb
    .from("leads")
    .select("client_id, phone:data->>phone")
    .eq("agent_id", recipientId);
  if (recipientErr) {
    return json({ error: "recipient_lookup_failed", detail: recipientErr.message }, 500);
  }

  const recipientPhones = new Set<string>();
  const recipientClientIds = new Set<string>();
  for (const row of (recipientLeads || []) as { client_id: string; phone: string | null }[]) {
    recipientClientIds.add(String(row.client_id));
    const e164 = normalize(row.phone);
    if (e164) recipientPhones.add(e164);
  }

  // Prior handoffs of these exact ids, so a retry reads as a no-op.
  const { data: priorRows } = await sb
    .from("lead_transfers")
    .select("sender_client_id")
    .eq("sender_id", senderId)
    .eq("recipient_id", recipientId)
    .in("sender_client_id", requestedClientIds);
  const previouslyTransferred = new Set(
    (priorRows || []).map((r: { sender_client_id: string }) => String(r.sender_client_id)),
  );

  const plan = planTransfer({
    requestedClientIds,
    senderLeads: (senderLeads || []) as SenderLeadRow[],
    recipientPhones,
    recipientClientIds,
    previouslyTransferred,
  });

  if (!plan.moves.length) {
    return json({
      ok: true,
      sent: 0,
      skipped: plan.skipped.length,
      refused: plan.refused.length,
      summary: summarizeTransfer(plan),
      moved: [],
    });
  }

  // --- sender display name, for the provenance stamp on each lead ---
  const { data: senderRow } = await sb
    .from("agents").select("display_name, email").eq("id", senderId).maybeSingle();
  const senderName =
    (senderRow?.display_name && String(senderRow.display_name).trim()) ||
    senderRow?.email || user.email || "a teammate";
  const at = new Date().toISOString();

  const byClientId = new Map<string, SenderLeadRow>();
  for (const row of (senderLeads || []) as SenderLeadRow[]) byClientId.set(String(row.client_id), row);

  // --- the move, one row at a time ---
  //
  // Sequential and per-row on purpose. There is no multi-row UPDATE that can
  // give each lead its own reassigned client_id, and a failure partway
  // through must leave every already-moved lead correctly moved and audited
  // rather than half-written. Each iteration is: update the lead, then append
  // the audit row. A lead whose update fails is reported, not retried blindly.
  const moved: { from: string; to: string }[] = [];
  const failed: { clientId: string; detail: string }[] = [];

  for (const move of plan.moves) {
    const source = byClientId.get(move.fromClientId);
    if (!source) continue;

    const nextData = sanitizeTransferredLead(
      source.data,
      { senderId, senderName, at },
      move.toClientId !== move.fromClientId ? move.toClientId : undefined,
    );

    const { error: updErr } = await sb
      .from("leads")
      .update({
        agent_id:  recipientId,
        client_id: move.toClientId,
        data:      nextData,
        // Consent does not cross the agency boundary. dnc / dnc_at are
        // deliberately absent — a suppression signal survives the handoff.
        ...CLEARED_ON_TRANSFER,
        updated_at: at,
      })
      .eq("id", move.leadId)
      .eq("agent_id", senderId);   // re-assert ownership at write time

    if (updErr) {
      failed.push({ clientId: move.fromClientId, detail: updErr.message });
      continue;
    }

    const { error: auditErr } = await sb.from("lead_transfers").insert({
      lead_id:             move.leadId,
      sender_id:           senderId,
      recipient_id:        recipientId,
      sender_client_id:    move.fromClientId,
      recipient_client_id: move.toClientId,
      lead_name:           move.name,
      lead_phone:          move.phone,
      transferred_at:      at,
    });
    if (auditErr) {
      // The lead has already moved. Log loudly rather than rolling back a
      // successful handoff over a missing audit row — but this should never
      // happen, and if it starts happening the log is the only trace.
      console.error("[transfer-leads] audit insert failed", {
        leadId: move.leadId, senderId, recipientId, detail: auditErr.message,
      });
    }

    moved.push({ from: move.fromClientId, to: move.toClientId });
  }

  return json({
    ok: true,
    sent: moved.length,
    skipped: plan.skipped.length,
    refused: plan.refused.length,
    failed: failed.length,
    summary: summarizeTransfer({ ...plan, moves: plan.moves.slice(0, moved.length) }),
    moved,
    detail: {
      skipped: plan.skipped,
      refused: plan.refused,
      ...(failed.length ? { failed } : {}),
    },
  });
});

/** Local E.164 normalizer — same rules as _shared/phone.ts toE164. */
function normalize(raw: string | null): string {
  if (!raw) return "";
  const d = String(raw).replace(/[^\d]/g, "");
  if (!d) return "";
  if (String(raw).trim().startsWith("+")) return "+" + d;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  return "";
}
