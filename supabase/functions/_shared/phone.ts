// ============================================================
// supabase/functions/_shared/phone.ts
//
// Canonical US/CA phone-number normalization. Extracted from
// _shared/dialer-next-lead.ts (same logic, same behavior) so the power
// dialer, the messaging compliance gate, and the inbound webhooks all
// agree on one E.164 representation — a consent/DNC/message row written
// under one format and read back under another is exactly how an opt-out
// gets missed.
//
// Plain Node/Deno module — no runtime-specific globals — so it can run
// under both `node --test` (see phone.test.ts) and the Deno edge function
// runtime.
// ============================================================

/** Normalizes a US/CA phone number to E.164 ("+15551234567"). Returns "" if unparseable. */
export function toE164(raw: string | undefined | null): string {
  if (!raw) return "";
  const d = String(raw).replace(/[^\d]/g, "");
  if (!d) return "";
  if (String(raw).trim().startsWith("+")) return "+" + d;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  return "";
}

/** True if `raw` normalizes to a well-formed 11-digit (+1 + 10 digit) US/CA E.164 number. */
export function isValidE164(raw: string | undefined | null): boolean {
  const e164 = toE164(raw);
  return /^\+1\d{10}$/.test(e164);
}
