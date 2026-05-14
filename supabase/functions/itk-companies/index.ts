// ============================================================
// supabase/functions/itk-companies/index.ts
//
// Returns the union of carriers that Insurance Toolkits (ITK)
// supports across FEX / TERM / IUL toolkits, so the Settings →
// Carriers tab can show every carrier ITK might return — not
// just the ~28 we've hardcoded locally.
//
// Pure metadata read. Does NOT touch quote_usage; this endpoint
// is intentionally cheap so the client can refresh on demand
// without burning the 250-per-30-days quote cap.
//
// Required secret (shared with itk-quote):
//   - ITK_API_KEY
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
//   companies: [{ name: string, toolkits: ('FEX'|'TERM'|'IUL')[] }, ...],
//   fetchedAt: string  // ISO timestamp
// }
// Response (4xx/5xx): { ok: false, error, meta?: { status } }
// ============================================================

const ITK_BASE = "https://api.insurancetoolkits.com";
const ALLOWED_TOOLKITS = ["FEX", "TERM", "IUL"] as const;
type Toolkit = (typeof ALLOWED_TOOLKITS)[number];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Best-effort extraction of a company-name list from ITK's response.
// The /quoter/companies/ endpoint returns an array of objects; the
// shape isn't formally documented, so we accept anything with a
// recognizable name field. Falls back to string entries.
function extractNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const s = item.trim();
      if (s) names.push(s);
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const cand =
        rec.name ?? rec.company ?? rec.company_name ?? rec.label ?? rec.title;
      if (typeof cand === "string" && cand.trim()) names.push(cand.trim());
    }
  }
  return names;
}

async function fetchToolkitCompanies(
  toolkit: Toolkit,
  apiKey: string,
): Promise<{ toolkit: Toolkit; names: string[]; status: number; error?: string }> {
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
        names: [],
        status: res.status,
        error: typeof data === "object" && data && "error" in data
          ? String((data as Record<string, unknown>).error)
          : text.slice(0, 200),
      };
    }
    return { toolkit, names: extractNames(data), status: res.status };
  } catch (e) {
    return { toolkit, names: [], status: 0, error: (e as Error)?.message || String(e) };
  }
}

Deno.serve(async (req) => {
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

  // Merge: each unique company name carries the set of toolkits it appeared in.
  const byName = new Map<string, Set<Toolkit>>();
  for (const r of results) {
    for (const name of r.names) {
      const existing = byName.get(name) ?? new Set<Toolkit>();
      existing.add(r.toolkit);
      byName.set(name, existing);
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
    .map(([name, set]) => ({ name, toolkits: Array.from(set).sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

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
