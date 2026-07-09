// ============================================================
// supabase/functions/itk-companies/index.ts
//
// Returns the union of carriers that Insurance Toolkits (ITK)
// supports across FEX / TERM / IUL toolkits, joined against the
// shared `itk_carrier_logos` table so every agent gets carrier
// logos without first running quotes on their own device.
//
// Pure metadata read. Does NOT touch quote_usage; this endpoint
// is intentionally cheap so the client can refresh on demand
// without burning the 250-per-30-days quote cap.
//
// Required secrets (shared with itk-quote):
//   - ITK_API_KEY
//   - SUPABASE_SERVICE_ROLE_KEY  (auto-injected by Edge runtime)
//
// Auth: platform verify_jwt = true rejects anon callers before
// this runs. We don't re-verify because we have no per-user
// writes to gate.
//
// Request (POST, JSON body):
//   { toolkits?: ('FEX'|'TERM'|'IUL')[] }   // defaults to all three
//
// Response (200): {
//   ok: true,
//   companies: [{ name: string, toolkits: ('FEX'|'TERM'|'IUL')[], logo?: string }, ...],
//   fetchedAt: string  // ISO timestamp
// }
// Response (4xx/5xx): { ok: false, error, meta?: { status } }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const ITK_BASE = "https://api.insurancetoolkits.com";
const ALLOWED_TOOLKITS = ["FEX", "TERM", "IUL"] as const;
type Toolkit = (typeof ALLOWED_TOOLKITS)[number];

type CompanyItem = { name: string; logo?: string };

// Best-effort extraction of `{ name, logo? }` items from ITK's response.
// The /quoter/companies/ endpoint returns an array; the shape isn't
// formally documented, so we accept anything with a recognizable name
// field. Falls back to string entries. Logo field, when present, is
// optional and may come under any of several common keys.
function extractCompanies(raw: unknown): CompanyItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CompanyItem[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const s = item.trim();
      if (s) out.push({ name: s });
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const cand =
        rec.name ?? rec.company ?? rec.company_name ?? rec.label ?? rec.title;
      if (typeof cand === "string" && cand.trim()) {
        const logoCand =
          rec.logo ?? rec.logo_url ?? rec.image ?? rec.image_url ?? rec.icon;
        const logo = typeof logoCand === "string" && logoCand.trim()
          ? logoCand.trim()
          : undefined;
        out.push(logo ? { name: cand.trim(), logo } : { name: cand.trim() });
      }
    }
  }
  return out;
}

async function fetchToolkitCompanies(
  toolkit: Toolkit,
  apiKey: string,
): Promise<{ toolkit: Toolkit; items: CompanyItem[]; status: number; error?: string }> {
  try {
    const res = await fetch(
      `${ITK_BASE}/quoter/companies/?toolkit=${encodeURIComponent(toolkit)}`,
      {
        method: "GET",
        headers: { "X-API-KEY": apiKey, "Accept": "application/json" },
      },
    );
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      return {
        toolkit,
        items: [],
        status: res.status,
        error: typeof data === "object" && data && "error" in data
          ? String((data as Record<string, unknown>).error)
          : text.slice(0, 200),
      };
    }
    return { toolkit, items: extractCompanies(data), status: res.status };
  } catch (e) {
    return { toolkit, items: [], status: 0, error: (e as Error)?.message || String(e) };
  }
}

Deno.serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const itkKey = Deno.env.get("ITK_API_KEY");
  if (!itkKey) return json({ ok: false, error: "ITK_API_KEY not configured on server" }, 500);

  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt.trim()) body = JSON.parse(txt);
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  let toolkits: Toolkit[] = [...ALLOWED_TOOLKITS];
  if (Array.isArray(body.toolkits) && body.toolkits.length) {
    const requested = body.toolkits
      .map((t) => String(t).toUpperCase())
      .filter((t): t is Toolkit => (ALLOWED_TOOLKITS as readonly string[]).includes(t));
    if (requested.length) toolkits = requested;
  }

  const start = Date.now();
  const results = await Promise.all(
    toolkits.map((tk) => fetchToolkitCompanies(tk, itkKey)),
  );
  const ms = Date.now() - start;

  // Merge: each unique company name carries the set of toolkits it appeared
  // in, plus the first non-empty logo URL we encounter (logos are stable
  // per-carrier across toolkits, so first-wins is fine).
  const byName = new Map<string, { toolkits: Set<Toolkit>; logo?: string }>();
  for (const r of results) {
    for (const it of r.items) {
      let existing = byName.get(it.name);
      if (!existing) {
        existing = { toolkits: new Set<Toolkit>() };
        byName.set(it.name, existing);
      }
      existing.toolkits.add(r.toolkit);
      if (!existing.logo && it.logo) existing.logo = it.logo;
    }
  }

  // If every upstream call failed, surface the error rather than returning
  // an empty list that would look like "ITK has no carriers".
  if (!byName.size) {
    const firstErr = results.find((r) => r.error);
    console.error("[itk-companies] all toolkit fetches returned empty", { results });
    return json({
      ok: false,
      error: firstErr?.error || "ITK returned no companies",
      meta: { ms, status: firstErr?.status ?? 0 },
    }, firstErr?.status && firstErr.status >= 500 ? 502 : 502);
  }

  const companies = Array.from(byName.entries())
    .map(([name, v]) => {
      const entry: { name: string; toolkits: Toolkit[]; logo?: string } = {
        name,
        toolkits: Array.from(v.toolkits).sort(),
      };
      if (v.logo) entry.logo = v.logo;
      return entry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Overlay logos from the shared `itk_carrier_logos` table. Lets every
  // agent's Carriers tab paint logos without first running quotes on
  // their own device. DB values win over whatever ITK returned (rare —
  // ITK's companies endpoint typically doesn't ship logos) because the
  // DB is sourced from actual quote responses where logos are reliable.
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && companies.length) {
    try {
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: logos, error } = await admin
        .from("itk_carrier_logos")
        .select("company_name, logo_url")
        .in("company_name", companies.map((c) => c.name));
      if (error) {
        console.warn("[itk-companies] logo join failed:", error.message);
      } else if (logos && logos.length) {
        const logoMap = new Map<string, string>();
        for (const row of logos) {
          if (row?.company_name && row?.logo_url) {
            logoMap.set(row.company_name, row.logo_url);
          }
        }
        for (const c of companies) {
          const dbLogo = logoMap.get(c.name);
          if (dbLogo) c.logo = dbLogo;
        }
      }
    } catch (e) {
      // Better to ship the carrier list with no logos than fail entirely.
      console.warn("[itk-companies] logo join threw:", (e as Error)?.message);
    }
  }

  // Partial failures: log them, but still return whatever succeeded so the
  // user gets the carriers from the toolkits that did work.
  const failures = results.filter((r) => r.error);
  if (failures.length) {
    console.warn("[itk-companies] partial failure", {
      failed: failures.map((f) => ({ toolkit: f.toolkit, status: f.status, error: f.error })),
      ms,
    });
  }

  return json({
    ok: true,
    companies,
    fetchedAt: new Date().toISOString(),
    meta: { ms, toolkitsFetched: toolkits, failures: failures.length },
  });
});
