// ============================================================
// supabase/functions/lead-ingest/index.ts
//
// Public webhook endpoint for lead vendors (Goat Leads, etc.).
// Vendors POST a lead to this URL using their unique token.
// JWT auth is DISABLED — vendor token is the only auth mechanism.
//
// Webhook URL:
//   https://cweiaibjigjwspmshcrj.supabase.co/functions/v1/lead-ingest?token=<vendor_token>
//
// Supports JSON body or application/x-www-form-urlencoded body.
// Field mapping is stored per-vendor in the lead_vendors table.
//
// Required: run supabase-setup-lead-vendors.sql first.
// Required secrets (auto-available): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-vendor-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Matches the dashboard's genLeadId() — webhook prefix so agents can filter later
function genLeadId(): string {
  return `wh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Normalize any US phone to E164 (+1XXXXXXXXXX)
function toE164(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return null;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

// Common vendor field name aliases → internal field name.
// Checked after the vendor's explicit field_map, case-insensitive on the key.
const FIELD_ALIASES: Record<string, string> = {
  // Phone
  phone_number: "phone", phone1: "phone", mobile: "phone",
  cell: "phone", cell_phone: "phone", telephone: "phone",
  primary_phone: "phone", home_phone: "phone", work_phone: "phone",
  mobile_phone: "phone",
  // Email
  email_address: "email", email1: "email",
  // Name
  firstname: "first_name", first: "first_name",
  lastname: "last_name", last: "last_name", surname: "last_name",
  full_name: "name", fullname: "name",
  // State
  st: "state", province: "state", state_code: "state",
  // DOB
  date_of_birth: "dob", birth_date: "dob", birthdate: "dob",
  birthday: "dob",
  // Gender
  sex: "gender",
  // Zip
  zip_code: "zip", postal_code: "zip", zipcode: "zip",
  zip5: "zip",
  // City
  town: "city",
  // Address
  address1: "address", street: "address", street_address: "address",
  addr: "address",
  // Coverage
  coverage: "coverage_wanted", coverage_amount: "coverage_wanted",
  face_amount: "coverage_wanted", policy_amount: "coverage_wanted",
  life_insurance_amount: "coverage_wanted", requested_coverage: "coverage_wanted",
  // Military
  veteran: "military_status",
  // Beneficiary
  beneficiary_name: "beneficiary",
  // Notes / comments
  comments: "notes", comment: "notes",
  // Marital status
  marital: "marital_status",
};

// All internal field names the frontend renders — used to detect "known" fields
// so everything else gets collected into customFields.
const INTERNAL_FIELDS = new Set([
  "name", "first_name", "last_name", "phone", "email",
  "state", "dob", "age", "gender", "address", "city", "zip",
  "military_status", "military_branch", "coverage_wanted",
  "beneficiary", "marital_status", "notes",
  // Metadata — don't bucket into customFields
  "source", "status", "importedAt", "id", "received_at",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  // Extract vendor token from query param or header
  const url = new URL(req.url);
  const token =
    url.searchParams.get("token") || req.headers.get("x-vendor-token");

  if (!token) return json({ ok: false, error: "Missing vendor token" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Look up the vendor — token identifies both the vendor and the agent
  const { data: vendor, error: vErr } = await supabase
    .from("lead_vendors")
    .select("id, agent_id, name, field_map")
    .eq("token", token)
    .eq("active", true)
    .maybeSingle();

  if (vErr || !vendor) {
    console.error("[lead-ingest] bad token:", token, vErr?.message);
    return json({ ok: false, error: "Invalid vendor token" }, 401);
  }

  // Parse body — JSON or form-encoded
  let payload: Record<string, unknown> = {};
  const ct = req.headers.get("content-type") || "";
  try {
    if (
      ct.includes("application/x-www-form-urlencoded") ||
      ct.includes("multipart/form-data")
    ) {
      const form = await req.formData();
      for (const [k, v] of form.entries()) {
        payload[k] = str(v);
      }
    } else {
      payload = await req.json();
    }
  } catch {
    return json({ ok: false, error: "Invalid request body" }, 400);
  }

  // Apply field map: vendor field name → our internal field name.
  // Priority: 1) vendor's explicit field_map, 2) alias table, 3) pass through as-is.
  // Fields explicitly mapped to "skip" are dropped.
  const fieldMap: Record<string, string> = vendor.field_map || {};
  const mapped: Record<string, string> = {};

  for (const [vendorKey, rawValue] of Object.entries(payload)) {
    let ourKey: string;
    if (Object.prototype.hasOwnProperty.call(fieldMap, vendorKey)) {
      ourKey = fieldMap[vendorKey];
    } else {
      ourKey = FIELD_ALIASES[vendorKey.toLowerCase()] ?? vendorKey;
    }
    if (ourKey && ourKey !== "skip") {
      mapped[ourKey] = str(rawValue);
    }
  }

  // Build name from parts
  const firstName = mapped.first_name || "";
  const lastName = mapped.last_name || "";
  const name =
    [firstName, lastName].filter(Boolean).join(" ") ||
    mapped.name ||
    "Unknown";

  // Normalize phone
  const phoneRaw = mapped.phone || "";
  const phone = toE164(phoneRaw) || phoneRaw || null;

  // Duplicate check — skip if same phone already exists for this agent
  if (phone) {
    const { count } = await supabase
      .from("leads")
      .select("client_id", { count: "exact", head: true })
      .eq("agent_id", vendor.agent_id)
      .eq("data->>phone", phone);

    if ((count ?? 0) > 0) {
      console.log(`[lead-ingest] duplicate skipped: ${phone}`);
      return json({ ok: true, skipped: true, reason: "Duplicate phone" });
    }
  }

  // Collect any vendor fields that aren't recognized internal fields into
  // customFields, so they show up in the lead card just like CSV custom fields.
  const customFields: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(mapped)) {
    if (!INTERNAL_FIELDS.has(k) && v) {
      const label = k
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      customFields.push({ label, value: v });
    }
  }

  // Build lead object — matches saveManualLead / importCSVLeads format exactly
  const lead: Record<string, unknown> = {
    id: genLeadId(),
    name,
    phone,
    email:            mapped.email            || undefined,
    state:            (mapped.state || "").toUpperCase() || undefined,
    dob:              mapped.dob              || undefined,
    age:              mapped.age ? parseInt(mapped.age) || undefined : undefined,
    gender:           mapped.gender           || undefined,
    address:          mapped.address          || undefined,
    city:             mapped.city             || undefined,
    zip:              mapped.zip              || undefined,
    military_status:  mapped.military_status  || undefined,
    military_branch:  mapped.military_branch  || undefined,
    coverage_wanted:  mapped.coverage_wanted  || undefined,
    beneficiary:      mapped.beneficiary      || undefined,
    marital_status:   mapped.marital_status   || undefined,
    notes:            mapped.notes            || "",
    source:           vendor.name,
    status:           "new",
    importedAt:       mapped.received_at
      ? new Date(mapped.received_at).toISOString()
      : new Date().toISOString(),
    customFields:     customFields.length ? customFields : undefined,
  };

  // Include split name only when available (for display in lead card)
  if (firstName) lead.first_name = firstName;
  if (lastName)  lead.last_name  = lastName;

  // Strip undefined keys to keep the blob clean
  for (const k of Object.keys(lead)) {
    if (lead[k] === undefined) delete lead[k];
  }

  // Insert into leads table (same schema as upsertAllLeads uses)
  const { error: insertErr } = await supabase.from("leads").insert({
    agent_id:  vendor.agent_id,
    client_id: String(lead.id),
    data:      lead,
  });

  if (insertErr) {
    console.error("[lead-ingest] insert error:", insertErr.message);
    return json({ ok: false, error: "Failed to save lead" }, 500);
  }

  console.log(
    `[lead-ingest] ✓ ${vendor.name} → ${name} | ${phone} | agent ${vendor.agent_id}`,
  );
  return json({ ok: true, lead_id: String(lead.id) });
});
