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
// replay). Do NOT invent or approximate this text.
//
// 🔴 IT IS NO LONGER THE SMS CONSENT BASIS. As of 2026-07-28 the campaign
// opt-in description does NOT quote it, because a vendor form's "…and its
// licensed agents" wording is precisely what carrier review rejected as
// evidence for a campaign sending as the agency. Filling `disclosure` in now
// improves the privacy policy's provenance story and nothing else — the SMS
// consent story is the hosted opt-in page. See buildOptinDescription below.
// ============================================================

import { buildOptInAutoResponse, buildOptInDisclosure } from "./sms-optin.ts";

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
 * ------------------------------------------------------------------
 * 🔴 REWRITTEN 2026-07-28 AFTER A REJECTION. READ THIS BEFORE EDITING.
 * ------------------------------------------------------------------
 * The previous version described the LEAD VENDOR's form as the point of
 * consent: the consumer ticked a box agreeing to be contacted by the vendor
 * "and its licensed agents", and we asserted that this covered the agency
 * whose name is on the campaign. Carrier review did not accept it. A generic
 * reference to unnamed downstream agents is not opt-in evidence for a
 * specific sender, and the vendor will not change their wording for us.
 *
 * So the description no longer claims the vendor's consent covers texting.
 * It describes what is now actually true: the vendor form is how we come to
 * have an email address, and TEXT consent is collected separately on the
 * agency's OWN page at /a/<slug>/sms-opt-in.
 *
 * THREE RULES FOR ANYONE EDITING THIS:
 *
 *   1. The disclosure and the confirmation message are QUOTED VERBATIM from
 *      sms-optin.ts, never retyped here. A reviewer opens the live page and
 *      compares. Identical text is not a nicety, it is the evidence.
 *   2. Do not reintroduce the vendor's consent language as the basis for
 *      SMS. `vendorDisclosures()` still exists and the privacy policy still
 *      names the vendors — because that IS where the lead came from — but
 *      putting the vendor's text back in this field puts the exact wording
 *      that was rejected back in front of the reviewer.
 *   3. Every sentence must survive being checked. If the page stops asking
 *      for a last name, or stops storing the IP, this text becomes false and
 *      a reviewer who tests it will find that out before we do.
 */
export function buildOptinDescription(
  agencyName: string,
  vendorKeys: string[] | null | undefined,
  /**
   * The agent's generated compliance pages. Appended as text because the
   * Telnyx campaign has NO compliance-link field — privacyPolicyLink and
   * termsAndConditionsLink were probed against live campaignBuilder on
   * 2026-07-28 and are silently discarded (see the field-name block in
   * telnyx-10dlc-adapter.ts). The opt-in workflow text is free-form and IS
   * read by the reviewer, so this is where the URLs actually land.
   */
  complianceUrls?: { privacy: string; terms: string; smsOptIn?: string } | null,
): string {
  const vendors = joinVendorNames(resolveVendorNames(vendorKeys));
  const agency = agencyName.trim() || "the agency";

  // The opt-in URL is what makes this description checkable. Without it the
  // text would assert a page the reviewer cannot open, which is worse than
  // the old version — so the fallback describes the page without pretending
  // to name it, and a2p-register always passes the real URL.
  const optInUrl = complianceUrls?.smsOptIn || "";
  const pageRef = optInUrl ? `at ${optInUrl}` : "hosted by the agency";

  const hasUrls = !!(complianceUrls?.privacy && complianceUrls?.terms);
  const disclosure = hasUrls
    ? buildOptInDisclosure(agency, { privacy: complianceUrls!.privacy, terms: complianceUrls!.terms })
    : "";

  let text =
    `Consumers request life insurance information through a web form operated by ${vendors}, a licensed ` +
    `lead provider, and consent there to be contacted by telephone and email. That form is NOT the basis ` +
    `for text messages. Consent to receive text messages is collected separately, on ${agency}'s own ` +
    `opt-in page ${pageRef}, which the agency sends to the consumer by email or reads to them by phone.`;

  text += ` On that page the consumer enters their first name, last name, and mobile number, and must ` +
    `tick a single checkbox that is never pre-checked. The full disclosure is displayed inline beside ` +
    `the checkbox, not behind a link or pop-up, and reads:`;

  if (disclosure) text += ` "${disclosure}"`;

  // The confirmation text is NOT quoted here. It is submitted on this same
  // campaign as `optinMessage`, which the reviewer reads in the keyword
  // responses section — quoting it again cost ~280 characters of the 2,048
  // budget to tell them something they are already looking at. Both come
  // from buildOptInAutoResponse(), so they cannot disagree.
  text += ` On submission the agency stores the consumer's name and mobile number, the exact disclosure ` +
    `text above, the date and time, the consumer's IP address, and the page URL. The consumer is then ` +
    `sent this campaign's registered opt-in confirmation message.`;

  text += ` The agency sends no text message to any number without a stored consent record of this kind. ` +
    `Consumers may reply STOP at any time to opt out, or HELP for help.`;

  // The privacy policy and terms URLs are ALREADY in this text — the quoted
  // disclosure names both in full, which is where a reviewer following the
  // consent story will look for them anyway. Repeating them in a closing
  // sentence cost ~230 characters against a 2,048 budget (see
  // TCR_MESSAGE_FLOW_MAX) and bought nothing. The sentence is only added
  // when there is no disclosure to carry them, so the URLs are never absent.
  if (hasUrls && !disclosure) {
    text += ` ${agency}'s privacy policy is published at ${complianceUrls!.privacy} ` +
      `and its text messaging terms at ${complianceUrls!.terms}.`;
  }

  return text;
}

/**
 * TCR's hard limit on the campaign `messageFlow` field.
 *
 * Not ours and not adjustable. The description above quotes two verbatim
 * strings and repeats the agency name, so it grows with the length of the
 * agency name — an agency called "The Extraordinarily Long Life Insurance
 * Agency Of Greater Milwaukee County" produces a materially longer one than
 * "Acme". Exported so the adapter can refuse to submit an over-long campaign
 * and the unit tests can prove the worst realistic case still fits, because
 * the failure mode otherwise is a rejected submission at $15 a try.
 */
export const TCR_MESSAGE_FLOW_MAX = 2048;
