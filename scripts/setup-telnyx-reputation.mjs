#!/usr/bin/env node
// One-time setup CLI for Telnyx Number Reputation (automated spam-score
// registration). Run from the repo root with TELNYX_API_KEY (and, to sync
// state into Supabase, SUPABASE_SERVICE_ROLE_KEY) in .env.local or the env.
//
// Order of operations:
//   1. Fill in scripts/telnyx-enterprise.json (copy the .template.json)
//   2. node scripts/setup-telnyx-reputation.mjs init      → accepts ToS, creates enterprise
//   3. node scripts/setup-telnyx-reputation.mjs loa       → renders telnyx-loa.pdf — SIGN IT
//   4. node scripts/setup-telnyx-reputation.mjs enable telnyx-loa-signed.pdf
//                                                         → uploads doc, enables reputation (BILLABLE)
//   5. node scripts/setup-telnyx-reputation.mjs status    → poll until BOTH gates approved;
//                                                           each run also syncs reputation_config in Supabase
//
// After both gates read "approved", the telnyx-reputation-monitor cron
// backfills every existing number and new purchases self-register.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env.local loader (no deps).
if (existsSync(resolve(ROOT, ".env.local"))) {
  for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://cweiaibjigjwspmshcrj.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!TELNYX_API_KEY) { console.error("TELNYX_API_KEY missing (env or .env.local)"); process.exit(1); }

const TELNYX = "https://api.telnyx.com/v2";
const AUTH = { "Authorization": `Bearer ${TELNYX_API_KEY}` };
const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" };
const STATE_FILE = resolve(ROOT, "scripts", ".telnyx-reputation-state.json");

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function telnyx(method, path, body, raw = false) {
  const res = await fetch(`${TELNYX}${path}`, {
    method,
    headers: body instanceof FormData ? AUTH : JSON_HEADERS,
    body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
  });
  if (raw) return res;
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    console.error(`Telnyx ${method} ${path} → HTTP ${res.status}`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

// Mirror gate status into public.reputation_config so the edge functions
// know when purchase-time registration can start. Best-effort.
async function syncConfigRow(fields) {
  if (!SERVICE_KEY) { console.log("(SUPABASE_SERVICE_ROLE_KEY not set — skipping reputation_config sync)"); return; }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/reputation_config?on_conflict=id`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ id: 1, updated_at: new Date().toISOString(), ...fields }]),
  });
  console.log(res.ok ? "✓ reputation_config synced in Supabase" : `reputation_config sync failed: ${await res.text()}`);
}

const cmd = process.argv[2];

if (cmd === "init") {
  const bizPath = resolve(ROOT, "scripts", "telnyx-enterprise.json");
  if (!existsSync(bizPath)) {
    console.error("Fill in scripts/telnyx-enterprise.json first (copy telnyx-enterprise.template.json).");
    process.exit(1);
  }
  const biz = JSON.parse(readFileSync(bizPath, "utf8"));

  console.log("Accepting Number Reputation Terms of Service…");
  await telnyx("POST", "/terms_of_service/number_reputation/agree");
  console.log("✓ ToS accepted");

  console.log("Creating enterprise…");
  const ent = await telnyx("POST", "/enterprises", biz);
  const entId = ent?.data?.id;
  console.log(`✓ Enterprise created: ${entId}`);
  saveState({ enterprise_id: entId });
  await syncConfigRow({ enterprise_id: entId });
  console.log("\nNext: node scripts/setup-telnyx-reputation.mjs loa");

} else if (cmd === "loa") {
  const entId = loadState().enterprise_id || process.argv[3];
  if (!entId) { console.error("No enterprise_id — run `init` first or pass it as an argument."); process.exit(1); }
  console.log("Rendering LOA PDF (free)…");
  const res = await telnyx("POST", `/enterprises/${entId}/reputation/loa`, {}, true);
  if (!res.ok) { console.error(`LOA render failed: HTTP ${res.status}`, await res.text()); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = resolve(ROOT, "telnyx-loa.pdf");
  writeFileSync(out, buf);
  console.log(`✓ Saved ${out}`);
  console.log("\nNext (MANUAL): sign the PDF, save as telnyx-loa-signed.pdf, then run:");
  console.log("  node scripts/setup-telnyx-reputation.mjs enable telnyx-loa-signed.pdf");

} else if (cmd === "enable") {
  const entId = loadState().enterprise_id;
  const pdfPath = process.argv[3];
  if (!entId) { console.error("No enterprise_id — run `init` first."); process.exit(1); }
  if (!pdfPath || !existsSync(resolve(ROOT, pdfPath))) {
    console.error("Pass the SIGNED LOA pdf path: enable telnyx-loa-signed.pdf"); process.exit(1);
  }

  console.log("Uploading signed LOA to Documents API…");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(resolve(ROOT, pdfPath))], { type: "application/pdf" }), "loa-signed.pdf");
  const doc = await telnyx("POST", "/documents", form);
  const docId = doc?.data?.id;
  console.log(`✓ Document uploaded: ${docId}`);

  console.log("Enabling Number Reputation (BILLABLE)…");
  await telnyx("POST", `/enterprises/${entId}/reputation`, {
    loa_document_id: docId,
    check_frequency: "business_daily",
  });
  console.log("✓ Reputation enabled — vetting + LOA review now pending.");
  saveState({ loa_document_id: docId });
  await syncConfigRow({ enterprise_id: entId, enabled_at: new Date().toISOString(), check_frequency: "business_daily" });
  console.log("\nNext: node scripts/setup-telnyx-reputation.mjs status  (repeat until both gates = approved)");

} else if (cmd === "status") {
  const entId = loadState().enterprise_id || process.argv[3];
  if (!entId) { console.error("No enterprise_id — run `init` first or pass it as an argument."); process.exit(1); }
  const settings = await telnyx("GET", `/enterprises/${entId}/reputation`);
  const s = settings?.data ?? {};
  console.log(`reputation status : ${s.status}`);
  console.log(`loa_status        : ${s.loa_status}`);
  console.log(`check_frequency   : ${s.check_frequency}`);
  await syncConfigRow({ enterprise_id: entId, status: s.status ?? null, loa_status: s.loa_status ?? null, check_frequency: s.check_frequency ?? null });
  if (s.status === "approved" && s.loa_status === "approved") {
    console.log("\n✓ BOTH GATES APPROVED — the reputation-monitor cron will now backfill all numbers,");
    console.log("  and every new purchase self-registers automatically.");
  } else {
    console.log("\nNot fully approved yet — re-run this command later.");
  }

} else {
  console.log("Usage: node scripts/setup-telnyx-reputation.mjs <init|loa|enable <signed.pdf>|status>");
  process.exit(1);
}
