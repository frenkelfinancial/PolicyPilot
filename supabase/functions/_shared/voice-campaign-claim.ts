// ============================================================
// voice-campaign-claim.ts
// The one write that makes a re-fired tick safe.
//
// voice-campaign-tick runs every minute. If it dies halfway through — a
// timeout, a deploy, an OOM — the next one fires sixty seconds later and sees
// the same due enrollments. Without this, both would dial the same lead.
//
// The claim is a single conditional UPDATE … RETURNING. Postgres re-evaluates
// the WHERE clause AFTER taking the row lock, so of two concurrent ticks
// exactly one gets a row back and the other gets nothing — no advisory lock, no
// queue table, no second round trip.
//
// It LEASES rather than latching. A tick that genuinely died leaves a claim
// behind, and a claim that never expired would be a lead nobody ever calls
// again; after VC_CLAIM_LEASE_SECS another tick may take it. That is why the
// predicate is `claimed_at IS NULL OR claimed_at < <stale>` and not just
// `IS NULL` — and it is still atomic, because the loser re-checks against the
// row the winner just wrote, where claimed_at is neither null nor stale.
//
// Lives in its own module so `node --test` can drive it against a fake client
// that models exactly that re-check. Two concurrent ticks, one winner: that is
// the test this file exists for.
// ============================================================

export interface ClaimedEnrollment {
  id: string;
  lead_id: string;
  current_step_position: number;
  step_attempts: number;
  calls_placed: number;
}

// Structural, so the test needs no supabase-js.
interface Db {
  from(table: string): any;
}

export const VC_CLAIM_COLS =
  "id, lead_id, current_step_position, step_attempts, calls_placed";

/**
 * Take exclusive ownership of one due enrollment.
 *
 * Returns the row on success and `null` when another tick got there first —
 * which is not an error and must not be logged as one.
 */
export async function vcClaimEnrollment(
  sb: Db,
  enrollmentId: string,
  nowIso: string,
  staleIso: string,
): Promise<ClaimedEnrollment | null> {
  const { data } = await sb.from("voice_campaign_enrollments")
    .update({ claimed_at: nowIso, updated_at: nowIso })
    .eq("id", enrollmentId)
    .eq("status", "active")
    .lte("next_action_at", nowIso)
    .or(`claimed_at.is.null,claimed_at.lt.${staleIso}`)
    .select(VC_CLAIM_COLS)
    .maybeSingle();
  return (data as ClaimedEnrollment | null) ?? null;
}
