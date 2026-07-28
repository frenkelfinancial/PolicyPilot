// ============================================================
// lead-vendors.ts — PROMPT_16 Phase 5.
//
// The lead vendors our agents buy from, and the ONE opt-in workflow
// description we submit to every carrier review.
//
// WHY THIS IS SHARED, NOT PER-AGENT FREE TEXT:
// The campaign's opt-in description is the single field a carrier reviewer
// reads to decide whether our agents' consent story is real. If every agent
// writes their own, every agent's registration is a fresh coin flip. One
// well-written description, reused verbatim with only the vendor + agency
// name substituted, has to survive review exactly once — and every
// subsequent agent inherits that outcome.
//
// The same vendor list drives the "Where your information comes from"
// section of the generated privacy policy (_shared/compliance-page.ts).
// THOSE TWO MUST AGREE: a reviewer comparing the campaign's opt-in
// description against the linked privacy policy and finding different
// vendors named is the fastest way to a rejection. Both read from here.
//
// DISCLOSURE WORDING: `disclosure` is null until we have the vendor's exact
// on-form consent language in hand (screenshot or TrustedForm certificate
// replay). When we get it, paste it verbatim into that field — the
// description builder will quote it, which is materially stronger evidence
// than our paraphrase of it. Do NOT invent or approximate this text.
// ============================================================

export interface LeadVendor {
  /** Stable key stored in agents.lead_vendors[]. Never rename — it's persisted. */
  key: string;
  /** Display name, as it appears in the privacy policy and opt-in description. */
  name: string;
  /** Public URL of the vendor's consumer-facing lead form, when we know it. */
  formUrl: string | null;
  /**
   * The vendor's EXACT on-form consent disclosure, verbatim, once we have it.
   * null = not yet captured. Never fill this with an approximation.
   */
  disclosure: string | null;
}

export const LEAD_VENDORS: LeadVendor[] = [
  {
    key: "goatleads",
    name: "GoatLeads",
    formUrl: "https://goatleads.com",
    disclosure: null,
  },
  {
    key: "builtleads",
    name: "Built Leads",
    formUrl: "https://builtleads.com",
    disclosure: null,
  },
];

/** "other" is a free-text path: the agent names their vendor, we store it as `other:<name>`. */
export const OTHER_VENDOR_PREFIX = "other:";

/**
 * Resolve the stored `agents.lead_vendors[]` array into display names.
 * Unknown keys are dropped; `other:Acme Leads` becomes "Acme Leads".
 */
export function resolveVendorNames(keys: string[] | null | undefined): string[] {
  if (!Array.isArray(keys)) return [];
  const names: string[] = [];
  for (const raw of keys) {
    if (typeof raw !== "string") continue;
    const key = raw.trim();
    if (!key) continue;
    if (key.toLowerCase().startsWith(OTHER_VENDOR_PREFIX)) {
      const custom = key.slice(OTHER_VENDOR_PREFIX.length).trim();
      if (custom) names.push(custom);
      continue;
    }
    const known = LEAD_VENDORS.find((v) => v.key === key.toLowerCase());
    if (known) names.push(known.name);
  }
  // De-dupe, preserving order.
  return names.filter((n, i) => names.indexOf(n) === i);
}

/**
 * Join names into prose: "A", "A and B", "A, B, and C".
 * Used in both the privacy policy and the opt-in description, so the two
 * read identically.
 */
export function joinVendorNames(names: string[]): string {
  if (names.length === 0) return "our licensed lead partners";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Look up captured verbatim disclosures for the given vendor keys.
 * Returns [] until we've recorded at least one — see the file header.
 */
export function vendorDisclosures(keys: string[] | null | undefined): Array<{ name: string; disclosure: string }> {
  if (!Array.isArray(keys)) return [];
  const out: Array<{ name: string; disclosure: string }> = [];
  for (const raw of keys) {
    if (typeof raw !== "string") continue;
    const v = LEAD_VENDORS.find((x) => x.key === raw.trim().toLowerCase());
    if (v?.disclosure) out.push({ name: v.name, disclosure: v.disclosure });
  }
  return out;
}

/**
 * Build the campaign opt-in workflow description submitted to Telnyx/TCR.
 *
 * The body is fixed prose — only [VENDOR] and [AGENCY NAME] are substituted.
 * When a vendor's verbatim disclosure has been captured, it is appended as a
 * direct quote, because quoting the actual consumer-facing language is
 * stronger evidence than describing it.
 */
export function buildOptinDescription(agencyName: string, vendorKeys: string[] | null | undefined): string {
  const vendors = joinVendorNames(resolveVendorNames(vendorKeys));
  const agency = agencyName.trim() || "the agency";

  let text =
    `Consumers request life insurance information by completing a web form operated by ${vendors}, ` +
    `a licensed lead provider. Before submitting, the consumer provides prior express written consent ` +
    `to be contacted by telephone and SMS by licensed insurance agents, including ${agency}. ` +
    `Consent is captured and certified by TrustedForm, which records the consumer's IP address, ` +
    `session activity, timestamp, and the exact disclosure language displayed. The TrustedForm ` +
    `certificate is delivered with each lead and retained by ${agency}. ${agency} does not send ` +
    `messages to any lead without a stored consent record. Consumers may reply STOP at any time to opt out.`;

  const quoted = vendorDisclosures(vendorKeys);
  if (quoted.length > 0) {
    const parts = quoted.map((q) => `${q.name} displays the following disclosure: "${q.disclosure}"`);
    text += ` ${parts.join(" ")}`;
  }

  return text;
}
