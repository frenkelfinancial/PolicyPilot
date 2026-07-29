// ============================================================
// lead-vendors.ts — PROMPT_16 Phase 5.
//
// Lead SOURCE CATEGORIES, and the ONE opt-in workflow description we submit
// to every carrier review.
//
// ------------------------------------------------------------------
// 🔴 NO LEAD COMPANY IS NAMED ANYWHERE IN THIS FILE, ON PURPOSE.
// ------------------------------------------------------------------
// Until 2026-07-28 this held a list of named vendors (GoatLeads, Built Leads)
// which were rendered into BOTH the generated privacy policy and the campaign
// opt-in description. Three things were wrong with that:
//
//   1. THE NAMES WERE WRONG. The carrier's review file for campaign CD2166Q,
//      and the live campaign's own messageFlow, name a different company
//      entirely. Nothing called GoatLeads or Built Leads appears anywhere on
//      the carrier side. We were about to resubmit a description naming two
//      companies the reviewer has never seen.
//   2. NAMING ANY OF THEM POINTS THE REVIEWER AT THE WRONG DISCLOSURE. Review
//      item 1 on CD2166Q was, verbatim, that "the live opt-in disclosure and
//      SMS Terms are for [the lead company] and its licensed agents, while
//      this campaign sends as Frenkel Financial Agency". Naming a lead company
//      in a field about SMS consent invites the reviewer to go and read that
//      company's disclosure — which is the exact document that got us the
//      rejection. The remedy is not a better name, it is no name.
//   3. IT DOES NOT SCALE AND IT DECAYS. Every agent buys from someone
//      different, and they switch. A privacy policy that names companies is
//      wrong the first time an agent changes supplier, and a privacy policy
//      that is wrong is worse than one that is general.
//
// So the categories below describe lead sources by KIND. They are true for
// every agent, they stay true when an agent switches supplier, and they never
// point a carrier reviewer at a third party's consent language.
//
// The categories drive the "Where your information comes from" section of the
// generated privacy policy (_shared/compliance-page.ts) and NOTHING ELSE. The
// campaign opt-in description below names no source at all — see
// buildOptinDescription.
// ============================================================

import { buildOptInAutoResponse, buildOptInDisclosure } from "./sms-optin.ts";

export interface LeadSourceCategory {
  /** Stable key stored in agents.lead_vendors[]. Never rename — it's persisted. */
  key: string;
  /**
   * How the category reads inside the privacy policy sentence
   * "…when you ask for life insurance information — through ${…}."
   *
   * Deliberately free of internal commas so two or three of them compose into
   * a readable "A, B, or C" list.
   */
  label: string;
  /** Short label for the Settings checkbox. */
  short: string;
}

export const LEAD_SOURCE_CATEGORIES: LeadSourceCategory[] = [
  {
    key: "lead_partners",
    label: "a web form operated by a third-party lead generation company",
    short: "Third-party lead vendors",
  },
  {
    key: "own_forms",
    label: "a form on our own website or landing pages",
    short: "Our own website or forms",
  },
  {
    key: "referrals",
    label: "a referral from a client or business partner",
    short: "Referrals",
  },
];

/**
 * Resolve the stored `agents.lead_vendors[]` array into policy-ready labels.
 *
 * STRICT WHITELIST, and that is the point. Anything that is not a known
 * category key is dropped — including the legacy `goatleads` / `builtleads`
 * keys and the legacy `other:<free text>` path, which is how a company name
 * used to get into the privacy policy. A row still carrying old values renders
 * the generic sentence rather than a stale company name, so no data migration
 * has to run before this is safe.
 *
 * There is deliberately no free-text path back in. A box an agent can type
 * into is a box a company name ends up in, and that is the defect this file
 * exists to prevent.
 */
export function resolveLeadSourceLabels(keys: string[] | null | undefined): string[] {
  if (!Array.isArray(keys)) return [];
  const labels: string[] = [];
  for (const raw of keys) {
    if (typeof raw !== "string") continue;
    const known = LEAD_SOURCE_CATEGORIES.find((c) => c.key === raw.trim().toLowerCase());
    if (known) labels.push(known.label);
  }
  // De-dupe, preserving the order the categories are declared in.
  return labels.filter((n, i) => labels.indexOf(n) === i);
}

/**
 * Join labels into prose: "A", "A or B", "A, B, or C".
 *
 * "or" rather than "and": these are alternative routes by which one consumer
 * reached us, not a list of things that all happened to them.
 *
 * The empty fallback still has to be TRUE for an agent who has ticked nothing,
 * so it names the two routes every agent in this business actually has.
 */
export function joinLeadSourceLabels(labels: string[]): string {
  if (labels.length === 0) return "a web form you completed or a referral";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
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
 * It describes what is now actually true: TEXT consent is collected on the
 * agency's OWN page at /a/<slug>/sms-opt-in, and nowhere else.
 *
 * 🔴 IT NAMES NO LEAD COMPANY, AND TAKES NO PARAMETER THAT COULD MAKE IT.
 * The vendorKeys argument was removed on 2026-07-28 rather than left unused,
 * so reintroducing a company name here is a signature change somebody has to
 * mean. Review item 1 was that our opt-in evidence pointed at a third party's
 * disclosure; a lead company named in this field points the reviewer straight
 * back at it. See the file header.
 *
 * THREE RULES FOR ANYONE EDITING THIS:
 *
 *   1. The disclosure is QUOTED VERBATIM from sms-optin.ts, never retyped
 *      here. A reviewer opens the live page and compares. Identical text is
 *      not a nicety, it is the evidence.
 *   2. Do not reintroduce any third party's consent language as the basis for
 *      SMS, named or unnamed. It is the exact wording that was rejected.
 *   3. Every sentence must survive being checked. If the page stops asking
 *      for a last name, or stops storing the IP, this text becomes false and
 *      a reviewer who tests it will find that out before we do.
 */
export function buildOptinDescription(
  agencyName: string,
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
    `Consumers request life insurance information through web forms and referrals, and consent there to ` +
    `be contacted by telephone and email. Those forms are NOT the basis for text messages. Consent to ` +
    `receive text messages is collected only on ${agency}'s own opt-in page ${pageRef}, which the agency ` +
    `sends to the consumer by email or reads to them by phone. It is the sole way a mobile number enters ` +
    `this campaign.`;

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
