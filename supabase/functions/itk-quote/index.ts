// ============================================================
// supabase/functions/itk-quote/index.ts
//
// Proxy for Insurance Toolkits (ITK) quote + underwriting calls.
// The dashboard's verify panel (FE/Term/IUL) calls this instead of
// embedding the ITK iframe. ITK requires API keys server-side only.
//
// Required secret (set in Supabase dashboard or via `supabase secrets set`):
//   - ITK_API_KEY   API key from Insurance Toolkits platform team
//
// Auth: Edge Function platform verifies the caller's JWT before this
// runs (verify_jwt = true is the default). Anonymous calls return 401
// before our code executes — we don't need to re-verify here.
//
// Request (POST, JSON body, forwarded to ITK /quoter/):
//   { toolkit: 'FEX'|'TERM'|'IUL', sex, age|month+day+year, state, tobacco,
//     faceAmount?, paymentType?, term?, coverageType?, underwritingItems?, ... }
//
// Response (200): { ok: true, quotes: [...], excluded: [...], meta: { ms, status } }
// Response (4xx/5xx): { ok: false, error: string, itk?: any, meta: { ms, status } }
// ============================================================

const ITK_BASE = "https://api.insurancetoolkits.com";
const ALLOWED_TOOLKITS = new Set(["FEX", "TERM", "IUL"]);

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const itkKey = Deno.env.get("ITK_API_KEY");
  if (!itkKey) return json({ ok: false, error: "ITK_API_KEY not configured on server" }, 500);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  // Whitelist toolkit. Defense against accidental MEDSUPP/HI usage.
  const toolkit = String(body?.toolkit || "").toUpperCase();
  if (!ALLOWED_TOOLKITS.has(toolkit)) {
    return json({
      ok: false,
      error: `toolkit must be one of ${[...ALLOWED_TOOLKITS].join(", ")}`,
    }, 400);
  }
  body.toolkit = toolkit;

  const start = Date.now();
  let itkRes: Response;
  try {
    itkRes = await fetch(`${ITK_BASE}/quoter/`, {
      method: "POST",
      headers: {
        "X-API-KEY": itkKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error(`[itk-quote] network error: ${msg}`);
    return json({
      ok: false,
      error: "Upstream provider unreachable",
      meta: { ms: Date.now() - start, status: 0 },
    }, 502);
  }

  const ms = Date.now() - start;
  const text = await itkRes.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  console.log(`[itk-quote] toolkit=${toolkit} status=${itkRes.status} ms=${ms}`);

  if (!itkRes.ok) {
    // Map upstream 401 -> 502 so the browser doesn't mistake an ITK-side
    // auth failure (our server key is wrong/revoked) for a Supabase session
    // failure (the caller's JWT is bad). They have very different fixes.
    const browserStatus = itkRes.status === 401 ? 502 : itkRes.status;
    console.error(`[itk-quote] upstream ${itkRes.status}:`, data);
    return json({
      ok: false,
      error: typeof data?.error === "string" ? data.error : `ITK error ${itkRes.status}`,
      meta: { ms, status: itkRes.status },
    }, browserStatus);
  }

  return json({
    ok: true,
    quotes: data?.quotes || [],
    excluded: data?.excluded || [],
    meta: { ms, status: itkRes.status },
  });
});
