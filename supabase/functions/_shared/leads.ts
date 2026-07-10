// ============================================================
// supabase/functions/_shared/leads.ts
//
// Pure recipient-expansion logic for messaging-broadcast-create's lead
// source: turns a raw public.leads row set into deduped broadcast
// recipient candidates.
//
// Phone key is `data.phone` — confirmed against the real lead-creation
// paths (app.html saveManualLead() and supabase/functions/lead-ingest,
// both of which build `{ ..., phone: phoneE164, ..., status: 'new', ... }`
// before writing to leads.data), not guessed. See leads.test.ts.
//
// Plain Node/Deno module — no runtime-specific globals — so it can run
// under both `node --test` (see leads.test.ts) and the Deno edge
// function runtime.
// ============================================================
import { toE164 } from "./phone.ts";

export interface LeadRow {
  id: string;
  data: Record<string, unknown> | null;
}

export interface RecipientCandidate {
  leadId: string;
  toAddress: string; // E.164
  source: "lead";
}

export interface InvalidRecipient {
  leadId: string;
  rawPhone: string | null;
  skipReason: "invalid_phone";
}

export interface ExpandLeadsResult {
  recipients: RecipientCandidate[];
  invalid: InvalidRecipient[];
}

/**
 * Expands lead rows into deduped, E.164-normalized broadcast recipient
 * candidates. Leads with no/unparseable phone are reported separately
 * (invalid_phone) rather than silently dropped, so the caller can write
 * them as skipped broadcast_recipients rows for visibility. Dedupes by
 * normalized address — the first lead in the input array wins ties
 * (public.broadcast_recipients also has a unique(broadcast_id,
 * to_address) DB constraint as the second line of defense).
 */
export function expandLeadsToRecipients(leads: LeadRow[]): ExpandLeadsResult {
  const recipients: RecipientCandidate[] = [];
  const invalid: InvalidRecipient[] = [];
  const seen = new Set<string>();

  for (const lead of leads) {
    const rawPhone = typeof lead.data?.phone === "string" ? lead.data.phone : null;
    const e164 = toE164(rawPhone);
    if (!e164) {
      invalid.push({ leadId: lead.id, rawPhone, skipReason: "invalid_phone" });
      continue;
    }
    if (seen.has(e164)) continue;
    seen.add(e164);
    recipients.push({ leadId: lead.id, toAddress: e164, source: "lead" });
  }

  return { recipients, invalid };
}

/** True if a lead's `data.status` matches the given filter ('all' or empty matches everything). */
export function leadMatchesStatusFilter(lead: LeadRow, statusFilter: string): boolean {
  if (!statusFilter || statusFilter === "all") return true;
  const status = typeof lead.data?.status === "string" ? lead.data.status : "";
  return status === statusFilter;
}
