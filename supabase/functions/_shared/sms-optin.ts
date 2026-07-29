// ============================================================
// sms-optin.ts — the two consumer-facing strings of the hosted opt-in flow.
//
// WHY THIS IS ITS OWN MODULE
// --------------------------
// Both of these strings are read by TWO things that must never disagree:
//
//   compliance-page.ts   renders the disclosure above the checkbox, and the
//                        `compliance-page` function stores that same string
//                        in consent_records.disclosure_text;
//   lead-vendors.ts      quotes both of them VERBATIM inside the campaign's
//                        opt-in workflow description, which is the single
//                        field a carrier reviewer reads to decide whether our
//                        consent story is real.
//
// compliance-page.ts already imports lead-vendors.ts, so putting them in
// either of those files makes a cycle. They live here instead, depend on
// nothing, and are re-exported from compliance-page.ts so existing imports
// keep working.
//
// THE POINT OF THE ARRANGEMENT: a reviewer who opens the opt-in page and
// compares it against the description we submitted finds the disclosure
// word for word, because it is literally the same function call. A mismatch
// between those two is one of the fastest routes to a rejection, and the
// only way to guarantee there isn't one is to have a single string.
//
// CHANGING EITHER STRING CHANGES A SUBMITTED CAMPAIGN. The description on
// file with the carrier quotes them. Editing the wording here without
// resubmitting leaves the campaign describing a page that no longer says
// that — and resubmission is $15 (see docs/a2p-campaign-draft.md).
// ============================================================

/**
 * The exact consent disclosure shown above the opt-in checkbox — and stored
 * verbatim in consent_records.disclosure_text.
 *
 * Every element carrier review looks for is here on purpose, and none of it
 * is behind a link, a popup, or a "learn more": the whole paragraph renders
 * inline and visible, because a disclosure a reviewer has to click to find is
 * a disclosure they will score as absent.
 *
 *   - who is sending (the agency by name)
 *   - what the messages are (marketing, customer care, account notification)
 *   - what they are about (their quote, appointments, application status)
 *   - message frequency varies
 *   - message and data rates may apply
 *   - consent is not a condition of purchase
 *   - STOP to opt out, HELP for help
 *   - the agency's own privacy policy and terms, by full URL
 *
 * The URLs are spelled out in the text rather than hidden behind link labels
 * so the stored string is complete on its own — a regulator reading the
 * consent_records row does not have the HTML.
 */
export function buildOptInDisclosure(
  agencyName: string,
  urls: { privacy: string; terms: string },
): string {
  const agency = (agencyName || "").trim() || "this agency";
  return (
    `By checking this box, I agree to receive text messages from ${agency} at the mobile number I provide above. ` +
    `Messages may include marketing, customer care, and account notifications about my insurance quote, ` +
    `appointments, and application status. Message frequency varies. Message and data rates may apply. ` +
    `Consent is not a condition of purchase. I can reply STOP at any time to opt out, or HELP for help. ` +
    `See ${agency}'s privacy policy at ${urls.privacy} and text messaging terms at ${urls.terms}.`
  );
}

/**
 * TCR's cap on a campaign keyword-response field (`optinMessage`,
 * `optoutMessage`, `helpMessage`).
 *
 * The auto-response below is submitted as the campaign's `optinMessage` AND
 * texted to the consumer, and it grows with the agency name, so a long agency
 * name is the way it goes over. Exported so a unit test can prove the worst
 * realistic case still fits — the failure mode otherwise is a rejected
 * submission, and a rejected submission is $15 a try.
 */
export const TCR_KEYWORD_MESSAGE_MAX = 320;

/**
 * The auto-response texted to the number that just opted in.
 *
 * Kept in lockstep with the campaign's registered opt-in keyword response —
 * a consumer whose confirmation text does not match what the campaign told
 * the carrier it would say is a discrepancy a reviewer can see. Same string,
 * agency name substituted.
 *
 * ------------------------------------------------------------------
 * 🔴 REWRITTEN 2026-07-28 AFTER CARRIER REVIEW. READ BEFORE EDITING.
 * ------------------------------------------------------------------
 * Campaign CD2166Q came back with two items against the previous version of
 * this string, and they were the same defect stated twice:
 *
 *   "Subscriber/Auto-response Opt-in Message needs updating with information
 *    provided here - https://support.telnyx.com/en/articles/10645338-…"
 *   "Note: MARKETING is selected, but the START/opt-in auto-response does not
 *    explicitly mention marketing or promotional messages."
 *
 * The old text said only "messages about your life insurance quote,
 * appointments, and application status" while the campaign declares MARKETING,
 * CUSTOMER_CARE and ACCOUNT_NOTIFICATION. A confirmation that under-declares
 * what we will send is the consumer being told they signed up for less than
 * they did.
 *
 * Telnyx's article requires SEVEN elements. Every one is present below, and
 * removing any of them reopens the item:
 *
 *   1. brand name .................... `${agency}:`
 *   2. the use case(s) subscribed to . marketing and promotional messages,
 *                                      customer care, and account notifications
 *   3. message frequency ............. "Msg frequency varies."
 *   4. rates ......................... "Msg&data rates may apply."
 *   5. consent is not a condition .... "Consent is not a condition of purchase."
 *   6. HELP .......................... "Reply HELP for help"
 *   7. STOP .......................... "STOP to opt out."
 *
 * Element 2 must keep naming marketing/promotional for as long as the campaign
 * declares the MARKETING use case. If the use cases are ever narrowed, narrow
 * this sentence in the same commit — they are one statement, not two.
 */
export function buildOptInAutoResponse(agencyName: string): string {
  const agency = (agencyName || "").trim() || "Your insurance agency";
  return (
    `${agency}: You're subscribed to marketing and promotional messages, customer care, and account ` +
    `notifications about your insurance. Msg frequency varies. Msg&data rates may apply. Consent is ` +
    `not a condition of purchase. Reply HELP for help, STOP to opt out.`
  );
}
