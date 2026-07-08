// ============================================================
// supabase/functions/_shared/email/types.ts
//
// Shared types for the carrier email-parsing pipeline. Kept
// dependency-free so this module runs unchanged in Deno (edge
// functions) and Node (local unit tests via `node --test`).
// ============================================================

// Mirrors the `carrier_senders` table (see supabase/seed_carrier_senders.sql
// and the build plan §4). The DB row is the runtime source of truth; the
// classifier is a PURE function over an injected list of these rows so it can
// be unit-tested and reused by any intake method.
export interface SenderRow {
  carrier: string; // 'mutual_of_omaha' | 'transamerica' | ...
  from_pattern: string; // lowercase address or SQL-LIKE pattern, e.g. '%@mutualofomaha.com'
  subject_pattern: string | null; // case-insensitive regex; required when one address sends multiple types
  email_type: string; // 'underwriting_status' | 'payment_result' | 'ignore' | ...
  content_type: "body" | "pdf" | "login_link";
  route: "policy_tracker" | "commission_summary" | "nudge" | "ignore";
  priority: number; // ascending; lower wins when several rows match the same address
  active?: boolean; // defaults to true
  notes?: string;
}

// Result of classifying one message.
//   - "matched"       → a carrier_senders row owns this message. Branch on
//                       route/content_type downstream (route === 'ignore' means
//                       count-and-drop; 'nudge' means portal_nudge, no LLM).
//   - "unclassified"  → sender is at a KNOWN carrier domain but no row matched
//                       (novel format / new sender) → send to review queue.
//   - null            → not a carrier email at all → ignore silently, don't log.
export type Classification =
  | {
      status: "matched";
      carrier: string;
      email_type: string;
      content_type: SenderRow["content_type"];
      route: SenderRow["route"];
      priority: number;
      from: string;
      subject: string;
      sender: SenderRow;
    }
  | {
      status: "unclassified";
      carrier: string | null;
      route: "review";
      from: string;
      subject: string;
    };
