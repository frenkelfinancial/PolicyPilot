// ============================================================
// supabase/functions/_shared/broadcast-gate.ts
//
// Pure translation of a runComplianceGate failure reason (see
// messaging-shared.ts) into what messaging-broadcast-run should DO with
// that recipient. Split out from the runner so the "quiet_hours defers,
// it does not skip" rule — the one behavior spec'd as easy to get wrong —
// is independently unit-testable without a database.
//
// Plain Node/Deno module — no runtime-specific globals — so it can run
// under both `node --test` (see broadcast-gate.test.ts) and the Deno
// edge function runtime.
// ============================================================

export type BroadcastSkipReason = "no_consent" | "on_dnc" | "invalid_phone";

export type GateOutcome =
  // Compliance passed — proceed to the shared send core.
  | { action: "send" }
  // Hard, per-recipient failure — mark broadcast_recipients skipped, charge nothing.
  | { action: "skip"; skipReason: BroadcastSkipReason }
  // Recipient's local quiet-hours window is closed right now — leave the
  // row `pending` (NOT skipped) so a later run sends it once the window
  // opens, per PROMPT_07 §4.
  | { action: "defer" }
  // Campaign-wide failure (A2P no longer approved) — stop processing this
  // broadcast entirely; every other pending recipient stays pending too,
  // since the block applies to the whole campaign, not this one number.
  | { action: "halt" };

/**
 * Maps a runComplianceGate `reason` string to the broadcast runner's
 * action. Any reason this function doesn't recognize fails closed to
 * `skip` (never `send`) so an unexpected/future gate reason can't
 * accidentally bypass compliance.
 */
export function classifyGateReason(reason: string): GateOutcome {
  switch (reason) {
    case "invalid_phone":
      return { action: "skip", skipReason: "invalid_phone" };
    case "no_consent":
      return { action: "skip", skipReason: "no_consent" };
    case "on_dnc_list":
      return { action: "skip", skipReason: "on_dnc" };
    case "quiet_hours":
      return { action: "defer" };
    case "a2p_not_approved":
      return { action: "halt" };
    default:
      return { action: "skip", skipReason: "no_consent" };
  }
}
