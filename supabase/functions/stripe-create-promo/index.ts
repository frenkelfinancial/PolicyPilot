import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://producerstackcrm.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Creates a single-use Stripe promotion code with a given % off.
//
// Body:
//   percent_off — integer 1–100
//
// Response:
//   { code: "ABCD1234", percent_off: 40, promo_id: "promo_xxx" }
//
// REQUIRED Supabase secrets:
//   STRIPE_SECRET_KEY
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const STRIPE_KEY   = Deno.env.get("STRIPE_SECRET_KEY");

  if (!STRIPE_KEY) return json({ error: "stripe_not_configured" }, 500);

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  // Only admins can generate codes.
  const { data: agent } = await sb
    .from("agents").select("is_admin").eq("id", user.id).maybeSingle();
  if (!agent?.is_admin) return json({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const percentOff = Number(body.percent_off);
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
    return json({ error: "percent_off must be an integer between 1 and 100" }, 400);
  }

  const stripeHdrs = {
    "Authorization": `Bearer ${STRIPE_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  // 1. Create a coupon (applies once to the first invoice).
  const couponParams = new URLSearchParams({
    percent_off: String(percentOff),
    duration: "once",
  });
  const couponRes = await fetch("https://api.stripe.com/v1/coupons", {
    method: "POST", headers: stripeHdrs, body: couponParams,
  });
  if (!couponRes.ok) {
    const err = await couponRes.text();
    return json({ error: "coupon_creation_failed", detail: err }, 502);
  }
  const coupon = await couponRes.json();

  // 2. Create a promotion code tied to that coupon — single use only.
  const promoParams = new URLSearchParams({
    coupon: coupon.id,
    max_redemptions: "1",
  });
  const promoRes = await fetch("https://api.stripe.com/v1/promotion_codes", {
    method: "POST", headers: stripeHdrs, body: promoParams,
  });
  if (!promoRes.ok) {
    const err = await promoRes.text();
    return json({ error: "promo_creation_failed", detail: err }, 502);
  }
  const promo = await promoRes.json();

  return json({
    code: promo.code,
    percent_off: percentOff,
    promo_id: promo.id,
  });
});
