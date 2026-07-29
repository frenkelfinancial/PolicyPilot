// ============================================================
// supabase/functions/_shared/lead-transfer.ts
//
// Pure core of "Send Leads" — the agency-peer authorization rule, the
// transfer plan (what moves, what is skipped, what is refused), and the
// lead-payload sanitizer that strips consent on the way across.
//
// Everything here is a pure function over plain data so the authorization
// matrix and the compliance rules are unit-testable without a database.
// The edge function (transfer-leads) does the I/O and nothing else.
//
// Plain Node/Deno module — no runtime-specific globals — so it runs under
// both `node --test` (lead-transfer.test.ts) and the Deno edge runtime.
// ============================================================
import { toE164 } from "./phone.ts";

/**
 * Hard ceiling on one transfer.
 *
 * Not a performance limit — the function handles more — but a blast-radius
 * limit. A misclick on "Select all" in a 5,000-lead book should not silently
 * empty someone's pipeline; at 250 the sender gets told there is a remainder
 * and has to mean it a second time.
 */
export const TRANSFER_MAX_PER_REQUEST = 250;

export type AgencyRelationship = "upline" | "downline" | "sibling";

/** The subset of an accepted public.agency_invites row this logic needs. */
export interface AgencyInviteRow {
  leader_id: string;
  invitee_id: string | null;
  status: string;
}

export interface SenderLeadRow {
  id: string;          // public.leads.id (uuid)
  client_id: string;   // browser-local lead.id, String()-ed
  data: Record<string, unknown> | null;
}

export type RefusalReason = "not_yours" | "already_transferred" | "over_cap";
export type SkipReason = "duplicate_phone";

export interface PlannedMove {
  leadId: string;
  fromClientId: string;
  toClientId: string;
  name: string | null;
  phone: string | null;   // E.164 when parseable, else null
}

export interface TransferPlan {
  moves: PlannedMove[];
  skipped: { clientId: string; reason: SkipReason; phone: string | null }[];
  refused: { clientId: string; reason: RefusalReason }[];
}

// ------------------------------------------------------------
// Authorization
// ------------------------------------------------------------

/**
 * Every agent the caller shares an agency with, derived only from ACCEPTED
 * invites. Mirrors public.get_agency_members() exactly — the RPC renders the
 * picker, this function guards the write, and they must not drift.
 *
 *   upline   — a leader who invited me
 *   downline — an agent I invited
 *   sibling  — another accepted invitee of one of my uplines
 *
 * Pending and declined invites confer nothing. Neither does a shared
 * agency_code that was never accepted: the link is the accepted row.
 */
export function agencyPeers(
  invites: AgencyInviteRow[],
  callerId: string,
): Map<string, AgencyRelationship> {
  const accepted = invites.filter((i) => i.status === "accepted" && i.invitee_id);
  const peers = new Map<string, AgencyRelationship>();

  const uplines = new Set<string>();
  for (const i of accepted) {
    if (i.invitee_id === callerId) uplines.add(i.leader_id);
  }
  // Rank order matters: upline beats downline beats sibling, so a
  // double-linked pair resolves to one stable label.
  for (const id of uplines) {
    if (id !== callerId) peers.set(id, "upline");
  }
  for (const i of accepted) {
    if (i.leader_id === callerId && i.invitee_id && i.invitee_id !== callerId) {
      if (!peers.has(i.invitee_id)) peers.set(i.invitee_id, "downline");
    }
  }
  for (const i of accepted) {
    if (uplines.has(i.leader_id) && i.invitee_id && i.invitee_id !== callerId) {
      if (!peers.has(i.invitee_id)) peers.set(i.invitee_id, "sibling");
    }
  }
  return peers;
}

/**
 * The single authorization question the edge function asks before it touches
 * a row. Deliberately symmetric: leader→downline, downline→leader, and
 * downline→downline under a shared leader are all allowed, and nothing else
 * is. Self-transfer is not a transfer.
 */
export function canTransferBetween(
  invites: AgencyInviteRow[],
  senderId: string,
  recipientId: string,
): boolean {
  if (!senderId || !recipientId || senderId === recipientId) return false;
  return agencyPeers(invites, senderId).has(recipientId);
}

// ------------------------------------------------------------
// Payload sanitizer
// ------------------------------------------------------------

/**
 * Lead-row COLUMNS that are reset when a lead changes hands.
 *
 * `tcpa_consent` is consent to contact the consumer, given to a named entity.
 * A downline agent is a different entity from their leader, so carrying the
 * flag across would let the recipient's dialer call someone under a consent
 * that was never given to them — the same defect as copying a consent_records
 * row, which this feature refuses outright. The recipient re-earns it.
 *
 * `dnc` / `dnc_at` are deliberately ABSENT from this list: a suppression
 * signal must survive the handoff. Clearing DNC on transfer would turn a lead
 * handoff into a DNC-laundering mechanism.
 */
export const CLEARED_ON_TRANSFER = {
  tcpa_consent: false,
  tcpa_consent_source: null,
  tcpa_consent_at: null,
} as const;

export interface Provenance {
  senderId: string;
  senderName: string;
  at: string;   // ISO
}

/**
 * Stamps "where did this come from" onto the lead payload and strips any
 * consent-ish field that may have been written into `data` by an importer.
 *
 * The lead's identity (`id`) is rewritten only when the caller supplies a
 * different toClientId — see the client_id collision note in the migration.
 */
export function sanitizeTransferredLead(
  data: Record<string, unknown> | null,
  prov: Provenance,
  toClientId?: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(data || {}) };

  // Any consent-shaped key that an importer may have parked in the blob.
  // The authoritative columns are handled by CLEARED_ON_TRANSFER; this is
  // belt-and-braces for payloads we do not control.
  for (const key of ["tcpaConsent", "tcpa_consent", "consent", "consentType",
                     "consent_type", "trustedFormUrl", "trustedform_url",
                     "optIn", "opt_in"]) {
    if (key in next) delete next[key];
  }

  next.receivedFrom = prov.senderName;
  next.receivedFromId = prov.senderId;
  next.receivedAt = prov.at;

  if (toClientId !== undefined) next.id = toClientId;

  return next;
}

// ------------------------------------------------------------
// Planner
// ------------------------------------------------------------

export interface PlanInput {
  /** client_ids the caller asked to send, in the caller's order. */
  requestedClientIds: string[];
  /** Rows the sender ACTUALLY owns among those ids (service-role read). */
  senderLeads: SenderLeadRow[];
  /** E.164 phones already in the recipient's book. */
  recipientPhones: Set<string>;
  /** client_ids already in the recipient's book (UNIQUE (agent_id, client_id)). */
  recipientClientIds: Set<string>;
  /** client_ids this sender has already handed to this recipient before. */
  previouslyTransferred?: Set<string>;
  cap?: number;
  /** Injectable for deterministic tests. Must return an unused client_id. */
  newClientId?: (attempt: number) => string;
}

const defaultNewClientId = (attempt: number) => String(Date.now() + attempt);

/**
 * Decides the fate of every requested lead. No I/O, no mutation of inputs.
 *
 * Order of judgement per lead:
 *   1. not owned by the sender  -> refused (already_transferred if we have a
 *      record of this exact handoff, so a retry reads as a no-op rather than
 *      an error — this is what makes the endpoint idempotent)
 *   2. phone already in the recipient's book, or repeated within this batch
 *      -> skipped (duplicate_phone)
 *   3. beyond the cap -> refused (over_cap)
 *   4. otherwise -> moved, with a fresh client_id if the recipient already
 *      uses that one
 *
 * A lead with no parseable phone is NOT a duplicate — there is nothing to
 * compare — so it moves. Deduping those on name would merge distinct people.
 */
export function planTransfer(input: PlanInput): TransferPlan {
  const {
    requestedClientIds,
    senderLeads,
    recipientPhones,
    recipientClientIds,
    previouslyTransferred = new Set<string>(),
    cap = TRANSFER_MAX_PER_REQUEST,
    newClientId = defaultNewClientId,
  } = input;

  const owned = new Map<string, SenderLeadRow>();
  for (const row of senderLeads) owned.set(String(row.client_id), row);

  const plan: TransferPlan = { moves: [], skipped: [], refused: [] };

  // Working copies so we never mutate the caller's sets.
  const takenPhones = new Set(recipientPhones);
  const takenClientIds = new Set(recipientClientIds);
  const seenRequested = new Set<string>();
  let collisionAttempt = 0;

  for (const rawId of requestedClientIds) {
    const clientId = String(rawId);
    if (seenRequested.has(clientId)) continue;   // same id twice in one request
    seenRequested.add(clientId);

    const row = owned.get(clientId);
    if (!row) {
      plan.refused.push({
        clientId,
        reason: previouslyTransferred.has(clientId) ? "already_transferred" : "not_yours",
      });
      continue;
    }

    const phone = toE164(typeof row.data?.phone === "string" ? row.data.phone : "") || null;
    if (phone && takenPhones.has(phone)) {
      plan.skipped.push({ clientId, reason: "duplicate_phone", phone });
      continue;
    }

    if (plan.moves.length >= cap) {
      plan.refused.push({ clientId, reason: "over_cap" });
      continue;
    }

    let toClientId = clientId;
    while (takenClientIds.has(toClientId)) {
      toClientId = newClientId(++collisionAttempt);
    }
    takenClientIds.add(toClientId);
    if (phone) takenPhones.add(phone);

    plan.moves.push({
      leadId: row.id,
      fromClientId: clientId,
      toClientId,
      name: typeof row.data?.name === "string" ? row.data.name : null,
      phone,
    });
  }

  return plan;
}

/** Human-readable result line for the toast: "8 sent, 2 skipped — already in their book". */
export function summarizeTransfer(plan: TransferPlan): string {
  const sent = plan.moves.length;
  const dupes = plan.skipped.filter((s) => s.reason === "duplicate_phone").length;
  const overCap = plan.refused.filter((r) => r.reason === "over_cap").length;
  const gone = plan.refused.filter((r) => r.reason === "already_transferred").length;
  const notYours = plan.refused.filter((r) => r.reason === "not_yours").length;

  const parts = [`${sent} sent`];
  if (dupes) parts.push(`${dupes} skipped — already in their book`);
  if (gone) parts.push(`${gone} already sent earlier`);
  if (overCap) parts.push(`${overCap} over the ${TRANSFER_MAX_PER_REQUEST}-lead limit`);
  if (notYours) parts.push(`${notYours} no longer available`);
  return parts.join(", ");
}
