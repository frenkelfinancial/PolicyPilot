// ============================================================
// supabase/functions/_shared/email/carrier-senders.ts
//
// Code-side MIRROR of supabase/seed_carrier_senders.sql. The DB table
// `carrier_senders` is the runtime source of truth (edge functions will
// `select *` from it and pass the rows to classifyMessage). This constant
// exists so the PURE classifier can be unit-tested with no DB, and as an
// optional in-memory fallback.
//
// KEEP IN SYNC with seed_carrier_senders.sql. carrier-senders.test-sync
// cross-checks this list against docs/carrier_sender_map.json so drift fails
// CI. (Same "mirror + keep in sync" pattern as _shared/scoring.ts.)
//
// Matching semantics (see seed file header):
//   1. Lowercase the From address, match `from_pattern` as SQL-LIKE ('%' = any).
//   2. If several rows match the address, evaluate `subject_pattern`
//      (case-insensitive regex) in ascending `priority` order; first hit wins.
//   3. subject_pattern = null matches any subject (the sender's default row).
//   4. No row but a known carrier domain => 'unclassified' => review queue.
// ============================================================

import type { SenderRow } from "./types.ts";

export const CARRIER_SENDERS: SenderRow[] = [
  // ============ MUTUAL OF OMAHA ============
  { carrier: "mutual_of_omaha", from_pattern: "do_not_reply_igo_eapp@mutualofomaha.com", subject_pattern: null, email_type: "application_activity", content_type: "body", route: "policy_tracker", priority: 10, notes: "New e-app submitted; policy # in subject and body." },
  { carrier: "mutual_of_omaha", from_pattern: "noreply.login@login.mutualofomaha.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "One-time login codes." },
  { carrier: "mutual_of_omaha", from_pattern: "contractsandappointments@mutualofomaha.com", subject_pattern: null, email_type: "ignore", content_type: "pdf", route: "ignore", priority: 10, notes: "Contracting forms." },
  { carrier: "mutual_of_omaha", from_pattern: "mutualofomaha@secure.mutualofomaha.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Account setup." },
  { carrier: "mutual_of_omaha", from_pattern: "mutualofomaha@e.mutualofomaha.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Contracting docs." },
  // Personal underwriter addresses vary per case: domain-wide catch with subject filter. Higher priority so specific rows above win.
  { carrier: "mutual_of_omaha", from_pattern: "%@mutualofomaha.com", subject_pattern: "^(App Review|Withdrawn|Phone Interview|Approved|Declined)", email_type: "underwriting_status", content_type: "body", route: "policy_tracker", priority: 50, notes: "Personal underwriter senders (e.g. aubrey.street-mccarthy@). Body: File Number, Insured, Plan, Face Amount." },

  // ============ TRANSAMERICA ============
  { carrier: "transamerica", from_pattern: "mocasemanagement@transamerica.com", subject_pattern: null, email_type: "underwriting_status", content_type: "body", route: "policy_tracker", priority: 10, notes: "Requirements / approvals / closures. POLICY # MASKED as xxxxx76911 -> last-5 matching. Occasional PDF attachments." },
  { carrier: "transamerica", from_pattern: "newbusinesstlp@transamerica.com", subject_pattern: null, email_type: "application_activity", content_type: "body", route: "policy_tracker", priority: 10, notes: "Application received." },
  { carrier: "transamerica", from_pattern: "notifications@mylifeinsurance.transamerica.com", subject_pattern: "Application Results", email_type: "underwriting_status", content_type: "body", route: "policy_tracker", priority: 10, notes: "FE Express instant decisions (mostly declines, reason in body)." },
  { carrier: "transamerica", from_pattern: "notifications@mylifeinsurance.transamerica.com", subject_pattern: "(Payment Scheduled|Policy Purchase Is Processing|Incomplete Purchase)", email_type: "payment_result", content_type: "body", route: "policy_tracker", priority: 20, notes: "Payment lifecycle. May be To: client, agent cc'd -> parse client from body, not headers." },
  { carrier: "transamerica", from_pattern: "notifications@mylifeinsurance.transamerica.com", subject_pattern: "(Your Policy Documents Are Ready|Your Application Is Ready to Review)", email_type: "policy_active", content_type: "body", route: "policy_tracker", priority: 30, notes: "Policy in force / docs ready." },
  { carrier: "transamerica", from_pattern: "tlp-crcontractadmin@transamerica.com", subject_pattern: null, email_type: "commission_change", content_type: "body", route: "commission_summary", priority: 10, notes: "ZSecure contracting/commission-level changes; data in body, commission schedule PDF attached." },
  { carrier: "transamerica", from_pattern: "transamericacxinsights@transamerica.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Surveys." },
  { carrier: "transamerica", from_pattern: "webhelp@transamerica.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Login codes." },
  { carrier: "transamerica", from_pattern: "awdemailnotification@transamerica.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Auto-replies." },
  { carrier: "transamerica", from_pattern: "%@sales.transamerica.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Sales-rep marketing (personal addresses on the sales subdomain)." },

  // ============ COREBRIDGE ============
  { carrier: "corebridge", from_pattern: "sigiteam@corebridgefinancial.com", subject_pattern: null, email_type: "payment_result", content_type: "body", route: "policy_tracker", priority: 10, notes: "SIWL/GIWL new business: returned payments, reissue, beneficiary. Policy # + client in subject/body." },
  { carrier: "corebridge", from_pattern: "svc_ilcc_prod@corebridgefinancial.com", subject_pattern: null, email_type: "portal_notification", content_type: "login_link", route: "nudge", priority: 10, notes: "Cisco Secure Message: NO data in email. Never fetch the link." },
  { carrier: "corebridge", from_pattern: "donotreply@corebridgefinancial.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Activation codes." },
  { carrier: "corebridge", from_pattern: "customerexperience@feedback.corebridgefinancial.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Surveys." },

  // ============ AMERICO ============
  // NOTE: noreply@ and donotreply@ differ; Daily Update vs portal notification split is by sender AND subject.
  { carrier: "americo", from_pattern: "noreply@americo.com", subject_pattern: "^Americo Daily Update", email_type: "commission_summary", content_type: "body", route: "commission_summary", priority: 10, notes: "Daily digest: commission summary/balance, pending counts, issued-not-paid + lapse-pending COUNTS. Lapse count > 0 should also flag policy_tracker." },
  { carrier: "americo", from_pattern: "donotreply@americo.com", subject_pattern: "New Notification Regarding", email_type: "portal_notification", content_type: "login_link", route: "nudge", priority: 10, notes: "Per-client portal notification. Regex-capture client name + link label for nudge text; details need portal login." },
  { carrier: "americo", from_pattern: "noreply.collections@americo.com", subject_pattern: null, email_type: "commission_change", content_type: "body", route: "commission_summary", priority: 10, notes: "Agent debt/chargeback balance." },
  { carrier: "americo", from_pattern: "americo.marketing@americo.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Marketing." },
  { carrier: "americo", from_pattern: "lindsay.autry@americo.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Marketing (personal)." },
  { carrier: "americo", from_pattern: "andrew.kostus@americo.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Marketing (personal)." },
  { carrier: "americo", from_pattern: "brandon.wilson@americo.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Marketing (personal)." },

  // ============ AMERICAN-AMICABLE ============
  // Same address, two types (arrives as NOREPLY@ and noreply@ — match case-insensitively, split on subject).
  { carrier: "american_amicable", from_pattern: "noreply@aatx.com", subject_pattern: "^APPLICATION ACTIVITY", email_type: "application_activity", content_type: "body", route: "policy_tracker", priority: 10, notes: "Daily status digest: SUBMITTED/ISSUED/DECLINED/WITHDRAWN with policy # + client. MULTIPLE policies per email -> parser returns array." },
  { carrier: "american_amicable", from_pattern: "noreply@aatx.com", subject_pattern: "^Returned Payment", email_type: "payment_result", content_type: "body", route: "policy_tracker", priority: 20, notes: "Payment not honored: policy #, client, amount, reason." },
  { carrier: "american_amicable", from_pattern: "noreply@aatx.com", subject_pattern: "(Login Code|Verification Code)", email_type: "ignore", content_type: "body", route: "ignore", priority: 30, notes: "Agent portal login/verification codes." },
  { carrier: "american_amicable", from_pattern: "marketingassistants@americanamicable.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Welcome/admin." },
  { carrier: "american_amicable", from_pattern: "%@american-amicablegroup.ccsend.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Constant Contact marketing." },

  // ============ ETHOS ============
  // Portal-first carrier: one sender mixes marketing + transactional. Allowlist subjects; default ignore.
  { carrier: "ethos", from_pattern: "ethosforagent@mail.ethos-agents.com", subject_pattern: "(complete their insurance application|application is almost done)", email_type: "application_activity", content_type: "body", route: "policy_tracker", priority: 10, notes: "Incomplete-application nudges, client name in subject/body." },
  { carrier: "ethos", from_pattern: "ethosforagent@mail.ethos-agents.com", subject_pattern: "compensation", email_type: "commission_change", content_type: "body", route: "commission_summary", priority: 20, notes: "Compensation processing/delay notices; no per-policy data." },
  { carrier: "ethos", from_pattern: "ethosforagent@mail.ethos-agents.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 90, notes: "DEFAULT for this sender: marketing." },
  { carrier: "ethos", from_pattern: "agents@ethoslife.com", subject_pattern: null, email_type: "ignore", content_type: "body", route: "ignore", priority: 10, notes: "Login codes / device trusted." },
];

// Known carrier domains (from carrier_sender_map.json `fallback_domains`).
// A From address whose domain equals or is a subdomain of one of these, but
// matches no row above, is 'unclassified' -> review queue (not silently dropped).
export const KNOWN_CARRIER_DOMAINS: Record<string, string> = {
  "mutualofomaha.com": "mutual_of_omaha",
  "transamerica.com": "transamerica",
  "corebridgefinancial.com": "corebridge",
  "americo.com": "americo",
  "aatx.com": "american_amicable",
  "americanamicable.com": "american_amicable",
  "american-amicablegroup.ccsend.com": "american_amicable",
  "ethoslife.com": "ethos",
  "ethos-agents.com": "ethos",
};
