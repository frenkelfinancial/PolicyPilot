// ============================================================
// supabase/functions/_shared/email/matcher.ts
//
// Pure policy-matching core (build plan §6), dependency-free so it unit-tests
// in Node and runs in Deno. Given a parsed event and the user's existing
// policies, decide how to route it:
//   - exact policy-number match (incl. Transamerica masked last-5) → auto-attach
//   - single/multiple name+carrier candidates → review (never auto-applied)
//   - nothing → review as no_policy_match
//
// Reality of this codebase: existing policies are JSONB and carry NO carrier
// policy number, and the tracker keys on client name + carrier. So the
// name+carrier path is the workable primary today; the policy-number path is
// kept for forward-compatibility once emails start writing numbers onto
// policies. Carrier is free text on policies, so it's normalized to our keys.
// ============================================================

export interface PolicyRef {
  id: string;
  policyNumber?: string | null; // usually absent on existing policies
  name?: string | null; // client name (agent-typed)
  carrierKey: string | null; // normalized to our carrier keys
}

export interface EventRef {
  policyNumber?: string | null; // may be masked ('xxxxx76911')
  clientName?: string | null;
  carrier: string; // our carrier key
  eventType: string;
  confidence: number;
}

export type MatchResult =
  | { status: "matched"; method: "policy_number" | "masked_last5"; policyId: string }
  | { status: "review"; reason: "ambiguous_match"; candidateIds: string[] }
  | { status: "review"; reason: "no_policy_match"; candidateIds: [] }
  | { status: "review"; reason: "low_confidence"; candidateIds: string[] };

// Event types that describe a policy (get matched). Commission/debt events are
// not policy-scoped and are handled by commission routing, not here.
const POLICY_EVENT_TYPES = new Set([
  "submitted", "approved", "declined", "withdrawn", "requirement",
  "payment_scheduled", "payment_returned", "lapse_pending", "policy_active", "closed", "other",
]);
export function isPolicyEvent(eventType: string): boolean {
  return POLICY_EVENT_TYPES.has(eventType);
}

const AUTO_APPLY_CONFIDENCE = 0.9; // exact match still needs high parse confidence to auto-attach

export function normalizePolicyNumber(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");
}
export function isMasked(s: string | null | undefined): boolean {
  return /x{3,}/i.test(s ?? "");
}
export function last5Digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").slice(-5);
}

export function normalizeName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function nameTokens(s: string | null | undefined): Set<string> {
  return new Set(normalizeName(s).split(" ").filter(Boolean));
}
// Order-independent token overlap (handles "WINGLER, TERRY" vs "Terry Wingler").
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size, B.size);
}

// Map a free-text carrier on a policy to our carrier key.
export function carrierKeyFromText(s: string | null | undefined): string | null {
  const t = (s ?? "").toLowerCase();
  if (!t) return null;
  if (/transam/.test(t)) return "transamerica";
  if (/mutual.*omaha|\bmoo\b/.test(t)) return "mutual_of_omaha";
  if (/americo/.test(t)) return "americo";
  if (/american.?amic|occidental|aatx|\bamam\b/.test(t)) return "american_amicable";
  if (/corebridge|\baig\b/.test(t)) return "corebridge";
  if (/ethos/.test(t)) return "ethos";
  return t.replace(/[^a-z0-9]/g, "") || null;
}

const STRONG_NAME = 0.99; // effectively all tokens shared
const FUZZY_NAME = 0.6; // weak candidate worth surfacing for confirmation

export function matchEvent(event: EventRef, policies: PolicyRef[]): MatchResult {
  if (event.confidence < 0.5) {
    return { status: "review", reason: "low_confidence", candidateIds: [] };
  }

  // 1/2. Policy number (exact, then Transamerica masked last-5), scoped to carrier.
  const en = normalizePolicyNumber(event.policyNumber);
  if (event.policyNumber && isMasked(event.policyNumber)) {
    const suffix = last5Digits(event.policyNumber);
    if (suffix.length === 5) {
      const hits = policies.filter(
        (p) => p.carrierKey === event.carrier && last5Digits(p.policyNumber) === suffix,
      );
      if (hits.length === 1 && event.confidence >= AUTO_APPLY_CONFIDENCE) {
        return { status: "matched", method: "masked_last5", policyId: hits[0].id };
      }
      if (hits.length > 1) return { status: "review", reason: "ambiguous_match", candidateIds: hits.map((p) => p.id) };
    }
  } else if (en) {
    const hits = policies.filter((p) => normalizePolicyNumber(p.policyNumber) === en);
    if (hits.length === 1 && event.confidence >= AUTO_APPLY_CONFIDENCE) {
      return { status: "matched", method: "policy_number", policyId: hits[0].id };
    }
    if (hits.length > 1) return { status: "review", reason: "ambiguous_match", candidateIds: hits.map((p) => p.id) };
  }

  // 3. Client name + carrier. Never auto-applied — surfaced for one-click confirm.
  const sameCarrier = policies.filter((p) => p.carrierKey && p.carrierKey === event.carrier);
  const scored = sameCarrier
    .map((p) => ({ p, score: nameSimilarity(p.name, event.clientName) }))
    .filter((x) => x.score >= FUZZY_NAME)
    .sort((a, b) => b.score - a.score);

  const strong = scored.filter((x) => x.score >= STRONG_NAME);
  if (strong.length === 1) return { status: "review", reason: "ambiguous_match", candidateIds: [strong[0].p.id] };
  if (strong.length > 1) return { status: "review", reason: "ambiguous_match", candidateIds: strong.map((x) => x.p.id) };
  if (scored.length) return { status: "review", reason: "ambiguous_match", candidateIds: scored.slice(0, 5).map((x) => x.p.id) };

  // 4. Nothing.
  return { status: "review", reason: "no_policy_match", candidateIds: [] };
}
