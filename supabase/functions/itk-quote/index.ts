// ============================================================
// supabase/functions/itk-quote/index.ts
//
// Proxy for Insurance Toolkits (ITK) quote + underwriting calls.
// The dashboard's verify panel (FE/Term/IUL) and the Quote +
// Underwriting tab call this instead of embedding the ITK iframe.
// ITK requires API keys server-side only.
//
// Quota: 250 ITK calls per agent per rolling 30 days (configurable
// per agent via `public.agents.monthly_quote_limit`). Enforced here
// because the anon key is public — a client-only check is bypassable.
//
// Required secret (set in Supabase dashboard or via `supabase secrets set`):
//   - ITK_API_KEY   API key from Insurance Toolkits platform team
// SUPABASE_URL and SUPABASE_ANON_KEY are injected by the runtime.
//
// Auth: Edge Function platform verifies the caller's JWT before this
// runs (verify_jwt = true is the default). Anonymous calls return 401
// before our code executes — we re-decode here only to recover the
// user id for the quota count + insert.
//
// Request (POST, JSON body, forwarded to ITK /quoter/):
//   { toolkit: 'FEX'|'TERM'|'IUL', sex, age|month+day+year, state, tobacco,
//     faceAmount?, paymentType?, term?, coverageType?, underwritingItems?, ... }
//
// Response (200): { ok: true, quotes, excluded, meta, quota: { used, limit, resetAt: null } }
// Response (429): { ok: false, error: 'quota_exceeded', used, limit, resetAt }
// Response (4xx/5xx): { ok: false, error: string, itk?, meta, quota? }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ITK_BASE = "https://api.insurancetoolkits.com";
const ALLOWED_TOOLKITS = new Set(["FEX", "TERM", "IUL"]);
const QUOTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // rolling 30 days
const QUOTA_DEFAULT   = 250;

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

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";

  // Authenticated client — forwards the caller's JWT so RLS applies and
  // auth.uid() resolves to the calling agent on every read/write.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Recover the user id from the JWT. Platform-level verify_jwt has already
  // rejected anonymous callers, so a null user here only happens if the
  // SUPABASE_URL/ANON_KEY env are missing — surface as 401 for the client.
  let userId: string;
  try {
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user?.id) {
      return json({ ok: false, error: "unauthenticated" }, 401);
    }
    userId = data.user.id;
  } catch {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }

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

  // ---- Quota gate ------------------------------------------------------
  // Read the per-agent limit (default 250 if the agents row hasn't been
  // hydrated yet — handle_new_user trigger creates it on signup, but a
  // pre-trigger account could lack the row).
  let limit = QUOTA_DEFAULT;
  try {
    const { data: agent } = await userClient
      .from("agents")
      .select("monthly_quote_limit")
      .eq("id", userId)
      .maybeSingle();
    if (agent && typeof agent.monthly_quote_limit === "number") {
      limit = agent.monthly_quote_limit;
    }
  } catch (e) {
    console.warn(`[itk-quote] limit lookup failed for ${userId}:`, (e as Error)?.message);
  }

  const sinceIso = new Date(Date.now() - QUOTA_WINDOW_MS).toISOString();
  let used = 0;
  try {
    const { count, error } = await userClient
      .from("quote_usage")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", userId)
      .gte("created_at", sinceIso);
    if (error) throw error;
    used = count ?? 0;
  } catch (e) {
    // Fail-closed on a quota lookup error: better to surface a brief
    // outage than to silently disable the cap on a paid API.
    console.error(`[itk-quote] usage count failed for ${userId}:`, (e as Error)?.message);
    return json({
      ok: false,
      error: "Couldn't verify your quote allowance. Please retry.",
    }, 503);
  }

  if (used >= limit) {
    // Compute resetAt = (oldest in-window row).created_at + 30 days, so the
    // counter can show "rolls off in N days" rather than just "you're stuck".
    let resetAt: string | null = null;
    try {
      const { data: oldest } = await userClient
        .from("quote_usage")
        .select("created_at")
        .eq("agent_id", userId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (oldest?.created_at) {
        resetAt = new Date(new Date(oldest.created_at).getTime() + QUOTA_WINDOW_MS).toISOString();
      }
    } catch (e) {
      console.warn(`[itk-quote] resetAt lookup failed for ${userId}:`, (e as Error)?.message);
    }
    console.log(`[itk-quote] quota_exceeded agent=${userId} used=${used} limit=${limit}`);
    return json({
      ok: false,
      error: "quota_exceeded",
      used,
      limit,
      resetAt,
    }, 429);
  }

  // ---- Call ITK --------------------------------------------------------
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
    // Per "1 click = 1 quote" decision: still log the attempt so chronic
    // ITK outages don't let an agent burn through the cap silently.
    void logUsage(userClient, userId, toolkit, false);
    return json({
      ok: false,
      error: "Upstream provider unreachable",
      meta: { ms: Date.now() - start, status: 0 },
      quota: { used: used + 1, limit, resetAt: null },
    }, 502);
  }

  const ms = Date.now() - start;
  const text = await itkRes.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  console.log(`[itk-quote] toolkit=${toolkit} status=${itkRes.status} ms=${ms} used=${used + 1}/${limit}`);

  // Log usage now — both success and failure count toward the cap.
  // Fire-and-forget: don't block the response on the insert.
  void logUsage(userClient, userId, toolkit, itkRes.ok);

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
      quota: { used: used + 1, limit, resetAt: null },
    }, browserStatus);
  }

  // Harvest carrier logos from the quote response into the shared
  // `itk_carrier_logos` table so every agent's Settings → Carriers tab
  // gets them without having to run quotes on their own device first.
  // Fire-and-forget — never blocks the response.
  if (SUPABASE_SERVICE_ROLE_KEY) {
    void upsertCarrierLogos(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, data?.quotes);
  }

  return json({
    ok: true,
    quotes: data?.quotes || [],
    excluded: data?.excluded || [],
    meta: { ms, status: itkRes.status },
    quota: { used: used + 1, limit, resetAt: null },
  });
});

// Upsert any `{ company_name, logo_url }` pairs found in a quotes array
// into public.itk_carrier_logos. Uses a service-role client because the
// table has no INSERT policy for the authenticated role — logos are
// shared across all agents and written only by trusted server code.
async function upsertCarrierLogos(
  supabaseUrl: string,
  serviceKey: string,
  quotes: unknown,
) {
  if (!Array.isArray(quotes) || !quotes.length) return;
  const seen = new Map<string, string>();
  for (const q of quotes) {
    if (!q || typeof q !== "object") continue;
    const rec = q as Record<string, unknown>;
    const company = typeof rec.company === "string" ? rec.company.trim() : "";
    const logo    = typeof rec.logo    === "string" ? rec.logo.trim()    : "";
    if (!company || !logo) continue;
    if (!seen.has(company)) seen.set(company, logo);
  }
  if (!seen.size) return;
  const rows = Array.from(seen.entries()).map(([company_name, logo_url]) => ({
    company_name,
    logo_url,
  }));
  try {
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await admin
      .from("itk_carrier_logos")
      .upsert(rows, { onConflict: "company_name" });
    if (error) console.warn(`[itk-quote] logo upsert failed:`, error.message);
  } catch (e) {
    console.warn(`[itk-quote] logo upsert threw:`, (e as Error)?.message);
  }
}

// Fire-and-forget usage write. RLS check is `auth.uid() = agent_id`, so the
// row only inserts when the JWT subject matches userId — defense in depth.
async function logUsage(
  client: ReturnType<typeof createClient>,
  agentId: string,
  product: string,
  ok: boolean,
) {
  try {
    const { error } = await client.from("quote_usage").insert({
      agent_id: agentId,
      product,
      ok,
    });
    if (error) console.error(`[itk-quote] usage insert failed:`, error.message);
  } catch (e) {
    console.error(`[itk-quote] usage insert threw:`, (e as Error)?.message);
  }
}
