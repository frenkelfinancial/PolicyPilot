// ============================================================
// supabase/functions/_shared/broadcast-pacing.ts
//
// Pure pacing math for messaging-broadcast-run: converts
// billing_config.sms_max_tps into the delay to sleep between consecutive
// sends within a broadcast, so a freshly-approved 10DLC campaign doesn't
// trip carrier filtering by bursting.
//
// Plain Node/Deno module — no runtime-specific globals — so it can run
// under both `node --test` (see broadcast-pacing.test.ts) and the Deno
// edge function runtime.
// ============================================================

/** Milliseconds to wait between sends to stay at or under `tps` sends/second. Non-positive/NaN tps falls back to 1/s (conservative). */
export function sendDelayMs(tps: number): number {
  const safeTps = Number.isFinite(tps) && tps > 0 ? tps : 1;
  return Math.round(1000 / safeTps);
}
