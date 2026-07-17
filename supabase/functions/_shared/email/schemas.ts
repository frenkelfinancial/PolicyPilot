// ============================================================
// supabase/functions/_shared/email/schemas.ts
//
// Per-email-type extraction schemas + prompt hints for the Haiku parser.
// Structured Outputs (output_config.format) constrains Haiku to emit exactly
// this JSON — no prose, no markdown, always parseable. Schemas obey the
// Structured Outputs limits: every object sets additionalProperties:false and
// lists all keys in `required` (nullability is expressed with a "null" type
// member, not by omission). No min/max/length constraints are allowed.
//
// Two shapes cover all routed types:
//   POLICY     — policy-tracker events; `events` is an array because one email
//                (e.g. aatx APPLICATION ACTIVITY) can carry several policies.
//   COMMISSION — commission summary / change / debt (single record).
// Each carries a plain-language `summary` — the whole point of the feature:
// re-express the carrier's shorthand in words an agent can read at a glance.
// ============================================================

const POLICY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    confidence: { type: "number" },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          policy_number: { type: ["string", "null"] }, // exactly as seen; masked OK ('xxxxx76911')
          client_name: { type: ["string", "null"] },
          event_type: {
            type: "string",
            enum: [
              "submitted", "approved", "declined", "withdrawn", "requirement",
              "payment_scheduled", "payment_returned", "lapse_pending",
              "policy_active", "closed", "other",
            ],
          },
          event_date: { type: ["string", "null"] }, // ISO YYYY-MM-DD if present
          premium: { type: ["number", "null"] },
          face_amount: { type: ["number", "null"] },
          summary: { type: "string" }, // 1-3 plain-English sentences, leads with the client's name
        },
        required: ["policy_number", "client_name", "event_type", "event_date", "premium", "face_amount", "summary"],
      },
    },
  },
  required: ["confidence", "events"],
} as const;

const COMMISSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    confidence: { type: "number" },
    kind: { type: "string", enum: ["commission_snapshot", "commission_change", "debt_notice", "other"] },
    commission_balance: { type: ["number", "null"] },
    amount: { type: ["number", "null"] }, // debt/chargeback or change amount
    counts: {
      type: "object",
      additionalProperties: false,
      properties: {
        pending_apps: { type: ["integer", "null"] },
        issued_not_paid: { type: ["integer", "null"] },
        lapse_pending: { type: ["integer", "null"] },
      },
      required: ["pending_apps", "issued_not_paid", "lapse_pending"],
    },
    event_date: { type: ["string", "null"] },
    summary: { type: "string" },
  },
  required: ["confidence", "kind", "commission_balance", "amount", "counts", "event_date", "summary"],
} as const;

export type SchemaCategory = "policy" | "commission";

interface SchemaEntry {
  category: SchemaCategory;
  schema: unknown;
  hint: string; // type-specific nudge appended to the user prompt
}

// Per-email-type routing. Anything not listed falls back to the policy shape.
const BY_TYPE: Record<string, SchemaEntry> = {
  underwriting_status: { category: "policy", schema: POLICY_SCHEMA, hint: "Underwriting status/requirements. Capture the file/policy number, insured name, decision or requirement, and any face amount." },
  application_activity: { category: "policy", schema: POLICY_SCHEMA, hint: "Application-activity digest. It MAY list MULTIPLE policies — return one event per policy. Map SUBMITTED/ISSUED/DECLINED/WITHDRAWN to the closest event_type." },
  payment_result: { category: "policy", schema: POLICY_SCHEMA, hint: "Payment lifecycle. Decode return reasons (e.g. 'BK DRFT RTN NSF' = bank draft returned, insufficient funds). Client may be in the body, not the To header — hunt for the insured's name and lead the summary with it." },
  policy_active: { category: "policy", schema: POLICY_SCHEMA, hint: "Policy in force / documents ready. Use event_type 'policy_active'." },
  policyholder_correspondence: { category: "policy", schema: POLICY_SCHEMA, hint: "Coded policyholder correspondence (e.g. 'Doc: ABDI2 BK DRFT RTN NSF W/AGT INFO'). Decipher the carrier code into a plain summary and pick the closest event_type." },
  commission_summary: { category: "commission", schema: COMMISSION_SCHEMA, hint: "Daily commission digest. Capture commission balance and the pending-apps / issued-not-paid / lapse-pending COUNTS. kind = 'commission_snapshot'." },
  commission_change: { category: "commission", schema: COMMISSION_SCHEMA, hint: "Commission-level change or debt/chargeback notice. Capture any dollar amount. kind = 'commission_change' or 'debt_notice'." },
};

export function schemaFor(emailType: string): SchemaEntry {
  return BY_TYPE[emailType] ?? BY_TYPE.underwriting_status;
}
