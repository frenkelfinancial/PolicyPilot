// One-off audit: find phone numbers that exist on Telnyx but have no matching
// row in the Supabase phone_numbers table. These are orphans still billing.
//
// Usage (PowerShell):
//   $env:TELNYX_API_KEY="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; node scripts/audit-orphan-numbers.mjs
// Usage (bash):
//   TELNYX_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/audit-orphan-numbers.mjs
//
// Read-only. Does not delete or modify anything on Telnyx or in Supabase.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://cweiaibjigjwspmshcrj.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

if (!TELNYX_API_KEY) {
  console.error("Missing TELNYX_API_KEY in environment.");
  process.exit(1);
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

async function listTelnyxNumbers() {
  const numbers = [];
  let page = 1;
  const pageSize = 250;
  for (;;) {
    const params = new URLSearchParams({
      "page[number]": String(page),
      "page[size]": String(pageSize),
    });
    const res = await fetch(`https://api.telnyx.com/v2/phone_numbers?${params}`, {
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`Telnyx phone_numbers list failed (page ${page}): ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    const data = body.data || [];
    numbers.push(...data.map((n) => ({ id: n.id, phone_number: n.phone_number, status: n.status })));
    const totalPages = body.meta?.total_pages ?? 1;
    if (page >= totalPages || data.length === 0) break;
    page++;
  }
  return numbers;
}

async function listSupabaseE164s() {
  const e164s = new Set();
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/phone_numbers?select=e164&order=id.asc&offset=${from}&limit=${pageSize}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) {
      throw new Error(`Supabase phone_numbers select failed (offset ${from}): ${res.status} ${await res.text()}`);
    }
    const rows = await res.json();
    for (const row of rows) if (row.e164) e164s.add(row.e164);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return e164s;
}

const [telnyxNumbers, dbE164s] = await Promise.all([listTelnyxNumbers(), listSupabaseE164s()]);

console.log(`Telnyx account numbers: ${telnyxNumbers.length}`);
console.log(`Supabase phone_numbers rows: ${dbE164s.size}`);

const orphans = telnyxNumbers.filter((n) => !dbE164s.has(n.phone_number));

if (orphans.length === 0) {
  console.log("\nNo orphans found — every Telnyx number has a matching Supabase row.");
} else {
  console.log(`\nORPHANS (on Telnyx, not in DB) — ${orphans.length} found:\n`);
  for (const o of orphans) {
    console.log(`  ${o.phone_number}  telnyx_id=${o.id}  status=${o.status}`);
  }
  console.log("\nNothing was deleted. Review and release manually in the Telnyx portal or via the API.");
}
