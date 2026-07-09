// ============================================================
// supabase/functions/_shared/segments.ts
//
// SMS segment counting — the exact rules carriers bill on, so
// amount_mills = segments * billing_config.sms_segment_mills matches
// what the carrier actually charged for.
//
// GSM-7 (GSM 03.38 charset): 160 septets in a single segment, 153 per
// segment once concatenated (7 septets reserved for the UDH header).
// Any character outside the GSM-7 basic + extension set forces UCS-2:
// 70 UTF-16 code units single, 67 per segment once concatenated.
//
// Plain Node/Deno module — no runtime-specific globals — so it can run
// under both `node --test` (see segments.test.ts) and the Deno edge
// function runtime.
// ============================================================

// GSM 03.38 basic character set — one septet each.
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

// GSM 03.38 extension table — two septets each (escape char + code).
const GSM7_EXTENDED = "^{}\\[~]|€";

const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXT_SET = new Set(GSM7_EXTENDED);

export type SmsEncoding = "GSM7" | "UCS2";

export interface SegmentInfo {
  encoding: SmsEncoding;
  /** Septets for GSM7, UTF-16 code units for UCS2. */
  length: number;
  segments: number;
}

function isGsm7Compatible(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC_SET.has(ch) && !GSM7_EXT_SET.has(ch)) return false;
  }
  return true;
}

function gsm7SeptetLength(text: string): number {
  let len = 0;
  for (const ch of text) len += GSM7_EXT_SET.has(ch) ? 2 : 1;
  return len;
}

/** Count SMS segments for a message body using carrier billing rules. */
export function countSegments(text: string): SegmentInfo {
  const body = text ?? "";

  if (isGsm7Compatible(body)) {
    const length = gsm7SeptetLength(body);
    const segments = length <= 160 ? 1 : Math.ceil(length / 153);
    return { encoding: "GSM7", length, segments };
  }

  // UCS-2: JS string length already counts UTF-16 code units, so a
  // surrogate-pair emoji correctly counts as 2 — matching carrier billing.
  const length = body.length;
  const segments = length <= 70 ? 1 : Math.ceil(length / 67);
  return { encoding: "UCS2", length, segments };
}

/** segments * rate, plus the segment breakdown for the ledger description. */
export function smsAmountMills(
  text: string,
  segmentMills: number,
): { segments: number; amountMills: number; encoding: SmsEncoding } {
  const { segments, encoding } = countSegments(text);
  return { segments, amountMills: segments * segmentMills, encoding };
}
