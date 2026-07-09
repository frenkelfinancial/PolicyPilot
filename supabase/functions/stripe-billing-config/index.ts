import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// GET  → returns the billing_config row (any authenticated agent)
// PUT  → updates billing_config (admin only)
//
// Body for PUT:
//   {
//     number_rate_cents?:       number,   // e.g. 300 = $3.00
//     minute_rate_cents?:       number,   // e.g. 2 = $0.02
//     stripe_numbers_price_id?: string,   // price_XXXX from Stripe Dashboard
//     stripe_minutes_price_id?: string,   // price_XXXX from Stripe Dashboard
//   }
//
// REQUIRED Supabase secrets: none beyond the standard ones.

serve(async (req) => {
  const CORS = corsHeaders(req.headers.get("origin"));
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await sbAuth.auth.getUser();
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // GET — return current config (any authenticated agent)
  if (req.method === "GET") {
    const { data, error } = await sb
      .from("billing_config")
      .select("number_rate_cents, minute_rate_cents, stripe_numbers_price_id, stripe_minutes_price_id, updated_at")
      .eq("id", 1)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json(data || { number_rate_cents: 300, minute_rate_cents: 2 });
  }

  // PUT — admin only
  if (req.method === "PUT" || req.method === "POST") {
    const { data: agentRow } = await sb
      .from("agents")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle();

    if (!agentRow?.is_admin) return json({ error: "forbidden" }, 403);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (typeof body.number_rate_cents === "number" && body.number_rate_cents > 0) {
      update.number_rate_cents = Math.round(body.number_rate_cents);
    }
    if (typeof body.minute_rate_cents === "number" && body.minute_rate_cents > 0) {
      update.minute_rate_cents = Math.round(body.minute_rate_cents);
    }
    if (typeof body.stripe_numbers_price_id === "string") {
      update.stripe_numbers_price_id = body.stripe_numbers_price_id.trim() || null;
    }
    if (typeof body.stripe_minutes_price_id === "string") {
      update.stripe_minutes_price_id = body.stripe_minutes_price_id.trim() || null;
    }

    if (Object.keys(update).length <= 1) {
      return json({ error: "no_valid_fields" }, 400);
    }

    const { error: updateErr } = await sb
      .from("billing_config")
      .update(update)
      .eq("id", 1);

    if (updateErr) return json({ error: updateErr.message }, 500);

    const { data: fresh } = await sb
      .from("billing_config")
      .select("number_rate_cents, minute_rate_cents, stripe_numbers_price_id, stripe_minutes_price_id, updated_at")
      .eq("id", 1)
      .maybeSingle();

    return json({ ok: true, config: fresh });
  }

  return json({ error: "method_not_allowed" }, 405);
});
