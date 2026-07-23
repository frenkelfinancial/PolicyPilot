// ============================================================
// ai-minute-billing.ts
// Tiered pricing math for AI Sales Agent voice minutes.
//
//   base rate:   billing_config.ai_minute_mills          ($0.075/min = 75 mills)
//   volume rate: billing_config.ai_minute_volume_mills   ($0.065/min = 65 mills)
//   threshold:   billing_config.ai_minute_volume_threshold (2,000 min / calendar month)
//
// "Volume rate applies to minutes BEYOND 2,000 in the month" — so the 2,000th
// AI minute of the month is still billed at the base rate, and the 2,001st is
// the first minute billed at the volume rate.
//
// MIRROR: this is the exact same split implemented in SQL by
// public.wallet_debit_ai_minutes (migration 20260723_wallet_ai_minutes.sql).
// The SQL RPC is the source of truth for what a wallet is actually charged;
// this module is the pure, unit-testable copy used for tests and any app-side
// cost estimate. Any change to the tier math must be applied to BOTH.
// ============================================================

export interface AiMinuteRates {
  /** Base per-minute rate in mills (1 mill = $0.001). */
  baseMills: number;
  /** Volume per-minute rate in mills, charged past the monthly threshold. */
  volumeMills: number;
  /** Minutes per calendar month billed at base before volume kicks in. */
  thresholdMinutes: number;
}

export interface AiMinuteSplit {
  /** Portion of the minutes billed at the base rate. */
  baseMinutes: number;
  /** Portion of the minutes billed at the volume rate. */
  volumeMinutes: number;
  /** Total cost of the minutes in mills. */
  amountMills: number;
}

/** billing_config defaults (July 2026 repricing). */
export const DEFAULT_AI_MINUTE_RATES: AiMinuteRates = {
  baseMills: 75,
  volumeMills: 65,
  thresholdMinutes: 2000,
};

/**
 * Split `minutes` (billed AFTER `mtdMinutes` already used this calendar month)
 * into base-rate and volume-rate portions, and total the cost in mills.
 *
 * @param mtdMinutes AI minutes already billed to this wallet this month.
 * @param minutes    Minutes being billed now (whole minutes; caller rounds up).
 */
export function splitAiMinutes(
  mtdMinutes: number,
  minutes: number,
  rates: AiMinuteRates = DEFAULT_AI_MINUTE_RATES,
): AiMinuteSplit {
  const mtd = Math.max(0, Math.floor(mtdMinutes));
  const mins = Math.max(0, Math.floor(minutes));

  // Minutes still available at the base rate before hitting the threshold.
  const remainingBase = Math.max(0, rates.thresholdMinutes - mtd);
  const baseMinutes = Math.min(mins, remainingBase);
  const volumeMinutes = mins - baseMinutes;
  const amountMills = baseMinutes * rates.baseMills + volumeMinutes * rates.volumeMills;

  return { baseMinutes, volumeMinutes, amountMills };
}

/** Convenience: total mills only. */
export function aiMinuteCostMills(
  mtdMinutes: number,
  minutes: number,
  rates: AiMinuteRates = DEFAULT_AI_MINUTE_RATES,
): number {
  return splitAiMinutes(mtdMinutes, minutes, rates).amountMills;
}
