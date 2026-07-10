// ============================================================
// supabase/functions/_shared/messaging-shared.ts
//
// Shared by messaging-send-sms / messaging-send-mms / messaging-send-email:
// the compliance gate that MUST pass, at zero cost to the agent, before any
// wallet hold is placed or any provider send is attempted.
//
// Order matters: A2P approval -> consent -> DNC -> quiet hours. Each check
// short-circuits with a clear machine-readable `reason` the caller turns
// into a 403 with no charge.
// ============================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { knownTimezoneForPhone, isSendAllowedForPhone } from "./tcpa.ts";
import { toE164 } from "./phone.ts";

export type MessagingChannel = "sms" | "mms" | "email";

export type ComplianceResult =
  | { ok: true; consentId: string; normalizedAddress: string }
  | { ok: false; reason: string; detail: string };

const PHONE_CHANNELS = new Set<MessagingChannel>(["sms", "mms"]);

/**
 * TCPA marketing SMS/MMS requires EXPRESS WRITTEN consent specifically —
 * oral/implied ("express") is not enough — unless the operator has
 * explicitly relaxed that (billing_config.sms_require_written_consent =
 * false). Pulled out of runComplianceGate as a pure function so the CSV
 * import path's "never auto-write express_written" guardrail can be
 * tested directly against the exact rule the gate enforces, without a
 * database. Email has no such requirement (any consent_type <> 'none'
 * passes it, checked separately in the gate).
 */
export function isConsentTypeAcceptable(consentType: string, requireWritten: boolean): boolean {
  const acceptableTypes = requireWritten ? ["express_written"] : ["express_written", "express"];
  return acceptableTypes.includes(consentType);
}

/**
 * Runs every compliance check required before a billable send. Charges
 * nothing itself — the caller (messaging-send-*) must not call wallet_hold
 * unless this returns ok:true. On ok:true, `normalizedAddress` is the
 * canonical form (E.164 for phone channels, trimmed+lowercased for email)
 * the caller MUST use for every downstream write (messages.to_address,
 * etc.) — writing the raw input instead reintroduces the format-mismatch
 * bug this gate exists to close.
 */
export async function runComplianceGate(
  // deno-lint-ignore no-explicit-any
  sb: SupabaseClient<any, any, any>,
  agentId: string,
  channel: MessagingChannel,
  toAddress: string,
): Promise<ComplianceResult> {
  const isPhone = PHONE_CHANNELS.has(channel);

  // 0. Normalize the recipient address once, up front — every check below
  //    (and every downstream write) uses this canonical form. A phone
  //    number that doesn't normalize to E.164 fails closed: we never guess
  //    at a raw, unparseable number.
  const normalizedAddress = isPhone
    ? toE164(toAddress)
    : (toAddress || "").trim().toLowerCase();

  if (isPhone && !normalizedAddress) {
    return {
      ok: false,
      reason: "invalid_phone",
      detail: `"${toAddress}" does not normalize to a valid E.164 phone number.`,
    };
  }

  // 1. A2P 10DLC approval gate — SMS/MMS only. Deliberately an allowlist
  //    (status === 'approved'), not a denylist of bad statuses — this is
  //    what makes 'suspended'/'expired' (Telnyx revoking a previously
  //    approved campaign) correctly block sends with zero changes needed
  //    here whenever a2p_registrations.status transitions away from
  //    'approved', same as 'rejected' or 'pending' already do.
  if (isPhone) {
    const { data: a2p } = await sb.from("a2p_registrations")
      .select("status")
      .eq("agent_id", agentId)
      .maybeSingle();
    if (!a2p || a2p.status !== "approved") {
      return {
        ok: false,
        reason: "a2p_not_approved",
        detail: "SMS/MMS is blocked until your A2P 10DLC brand + campaign registration is approved.",
      };
    }
  }

  // 2. Consent — fetch the single MOST RECENT record regardless of
  //    revoked_at, THEN check it's unrevoked. Filtering revoked_at IS NULL
  //    before ordering would let a stale, older non-revoked grant win over
  //    a newer revocation — exactly the resurrection bug this avoids.
  const contactCol = isPhone ? "contact_phone" : "contact_email";
  const { data: consent } = await sb.from("consent_records")
    .select("id, consent_type, revoked_at")
    .eq("agent_id", agentId)
    .eq(contactCol, normalizedAddress)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!consent) {
    return {
      ok: false,
      reason: "no_consent",
      detail: "No consent on file for this recipient — never granted.",
    };
  }
  if (consent.revoked_at) {
    return {
      ok: false,
      reason: "no_consent",
      detail: "Consent for this recipient was revoked.",
    };
  }
  // SMS/MMS marketing texts require WRITTEN express consent under TCPA;
  // email has no such requirement. billing_config.sms_require_written_consent
  // is a compliance decision the operator owns — defaults to true (strict).
  if (isPhone) {
    const { data: billingConfig } = await sb.from("billing_config")
      .select("sms_require_written_consent")
      .eq("id", 1)
      .maybeSingle();
    const requireWritten = billingConfig?.sms_require_written_consent ?? true;
    if (!isConsentTypeAcceptable(consent.consent_type, requireWritten)) {
      return {
        ok: false,
        reason: "no_consent",
        detail: requireWritten
          ? "SMS/MMS requires express WRITTEN consent (consent_type='express_written') — this recipient only has oral/implied consent on file."
          : "No consent on file for this recipient.",
      };
    }
  } else if (consent.consent_type === "none") {
    return {
      ok: false,
      reason: "no_consent",
      detail: "No consent on file for this recipient.",
    };
  }

  // 3. Do-not-contact — agent-specific or global.
  const { data: dncRows } = await sb.from("dnc_list")
    .select("agent_id")
    .eq(contactCol, normalizedAddress);
  const onDnc = (dncRows || []).some((r: { agent_id: string | null }) => r.agent_id === null || r.agent_id === agentId);
  if (onDnc) {
    return {
      ok: false,
      reason: "on_dnc_list",
      detail: "Recipient is on the do-not-contact list.",
    };
  }

  // 4. TCPA quiet hours — phone channels only (SMS/MMS are what TCPA's
  //    time-of-day restriction governs; email has no such rule). Unmapped/
  //    toll-free numbers use the conservative NY/LA intersection window
  //    rather than silently defaulting to a single timezone.
  if (isPhone) {
    if (!isSendAllowedForPhone(normalizedAddress)) {
      const tz = knownTimezoneForPhone(normalizedAddress);
      return {
        ok: false,
        reason: "quiet_hours",
        detail: tz
          ? `Outside allowed contact hours (8am-9pm local) — recipient's inferred timezone is ${tz}.`
          : "Outside allowed contact hours — recipient's timezone is unknown (unmapped or toll-free area code), so the conservative nationwide window (~11am-9pm Eastern) applies.",
      };
    }
  }

  return { ok: true, consentId: consent.id as string, normalizedAddress };
}

/** Truncate a message body for the messages.body_preview column. */
export function bodyPreview(text: string, maxLen = 200): string {
  const t = (text || "").trim();
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}
