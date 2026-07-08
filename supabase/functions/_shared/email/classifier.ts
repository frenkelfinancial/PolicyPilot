// ============================================================
// supabase/functions/_shared/email/classifier.ts
//
// DETERMINISTIC message classifier — zero LLM tokens. Given a raw From
// header and Subject, decides which carrier_senders row (if any) owns the
// message. This is the pre-filter that keeps 95%+ of inbox volume away from
// Claude entirely, and the router that tells the pipeline what to do next.
//
// Pure + dependency-free: runs identically in Deno (edge functions) and Node
// (unit tests). The sender list is injected so this stays testable and the
// carrier knowledge lives in data (the carrier_senders DB table), not code.
// ============================================================

import type { Classification, SenderRow } from "./types.ts";
import { CARRIER_SENDERS, KNOWN_CARRIER_DOMAINS } from "./carrier-senders.ts";

// Pull the bare address out of a From header. Handles:
//   "Underwriter Name <a.b@carrier.com>"  -> a.b@carrier.com
//   a.b@carrier.com                        -> a.b@carrier.com
//   NOREPLY@AATX.COM                       -> noreply@aatx.com  (lowercased)
export function extractEmailAddress(from: string | null | undefined): string {
  if (!from) return "";
  let s = String(from).trim();
  const lt = s.lastIndexOf("<");
  const gt = s.lastIndexOf(">");
  if (lt !== -1 && gt !== -1 && gt > lt) {
    s = s.slice(lt + 1, gt);
  }
  // strip surrounding quotes/whitespace and any stray display text
  s = s.replace(/^["'\s]+|["'\s]+$/g, "");
  // if display text remains (e.g. "Name addr@x.com"), keep the token with '@'
  if (s.includes(" ") && s.includes("@")) {
    const tok = s.split(/\s+/).find((t) => t.includes("@"));
    if (tok) s = tok;
  }
  return s.toLowerCase().trim();
}

// Compile a SQL-LIKE pattern ('%' = any run, '_' = any single char) into an
// anchored, case-insensitive RegExp. Everything else is treated literally
// (dots etc. are escaped) so 'noreply@americo.com' can NOT match
// 'noreply.collections@americo.com'.
export function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else if (/[.*+?^${}()|[\]\\]/.test(ch)) out += "\\" + ch;
    else out += ch;
  }
  return new RegExp("^(?:" + out + ")$", "i");
}

function carrierForDomain(domain: string): string | null {
  for (const known of Object.keys(KNOWN_CARRIER_DOMAINS)) {
    if (domain === known || domain.endsWith("." + known)) {
      return KNOWN_CARRIER_DOMAINS[known];
    }
  }
  return null;
}

function toMatched(row: SenderRow, from: string, subject: string): Classification {
  return {
    status: "matched",
    carrier: row.carrier,
    email_type: row.email_type,
    content_type: row.content_type,
    route: row.route,
    priority: row.priority,
    from,
    subject,
    sender: row,
  };
}

/**
 * Classify a message against the carrier sender map.
 *
 * @returns
 *   - a "matched" Classification when a row owns the message,
 *   - an "unclassified" Classification (route: 'review') when the sender is at
 *     a known carrier domain but no row matched (novel format / new sender),
 *   - null when it isn't a carrier email at all (ignore silently).
 */
export function classifyMessage(
  fromRaw: string | null | undefined,
  subjectRaw: string | null | undefined,
  senders: SenderRow[] = CARRIER_SENDERS,
): Classification | null {
  const from = extractEmailAddress(fromRaw);
  const at = from.indexOf("@");
  if (at === -1) return null; // not an address at all
  const subject = (subjectRaw ?? "").trim();
  const domain = from.slice(at + 1);

  // 1. Address-level candidates.
  const candidates = senders.filter(
    (s) => s.active !== false && likeToRegExp(s.from_pattern.toLowerCase()).test(from),
  );

  if (candidates.length === 0) {
    // 4. Known carrier domain but no row => surface for review, don't drop.
    const carrier = carrierForDomain(domain);
    if (carrier) return { status: "unclassified", carrier, route: "review", from, subject };
    return null; // not a carrier email
  }

  // 2/3. Ascending priority; at equal priority prefer a subject-specific row
  // over a null-default so a default can't shadow a sibling. First hit wins.
  const sorted = [...candidates].sort(
    (a, b) => a.priority - b.priority || (a.subject_pattern ? 0 : 1) - (b.subject_pattern ? 0 : 1),
  );
  for (const row of sorted) {
    if (row.subject_pattern == null) return toMatched(row, from, subject);
    if (new RegExp(row.subject_pattern, "i").test(subject)) return toMatched(row, from, subject);
  }

  // Address matched carrier rows but no subject matched any of them.
  return { status: "unclassified", carrier: candidates[0].carrier, route: "review", from, subject };
}
