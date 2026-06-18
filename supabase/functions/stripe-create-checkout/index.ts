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

// Called by the authenticated browser to start or change a Stripe subscription.
//
// Body:
//   plan_id   — UUID of the desired plan from public.plans
//   area_code — (optional) 3-digit area code for auto-provisioned phone number
//
// Responses:
//   { url: "https://checkout.stripe.com/..." }  — redirect the user here (new subscriber)
//   { ok: true, upgraded: true }                 — plan switched via Stripe API (existing subscriber)
//
// REQUIRED Supabase secrets:
//   STRIPE_SECRET_KEY  — sk_live_... or sk_test_...
//   APP_URL            — e.g. https://producerstackcrm.com (for success/cancel redirects)
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const STRIPE_KEY   = Deno.env.get("STRIPE_SECRET_KEY");
  const APP_URL      = Deno.env.get("APP_URL") || "https://producerstackcrm.com";

  if (!STRIPE_KEY) return json({ error: "stripe_not_configured" }, 500);

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  const body     = await req.json().catch(() => ({}));
  const planId   = body.plan_id as string | undefined;
  const areaCode = (body.area_code as string | undefined) || "202";

  if (!planId) return json({ error: "plan_id_required" }, 400);

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(planId);

  // Developer account bypass — skip Stripe, apply plan directly in DB.
  const DEV_EMAIL = 'jacef8778099@gmail.com';
  if (user.email === DEV_EMAIL) {
    const { data: devPlan, error: devPlanErr } = await sb
      .from("plans").select("*").eq(isUuid ? "id" : "slug", planId).eq("active", true).maybeSingle();
    if (devPlanErr || !devPlan) return json({ error: "plan_not_found" }, 404);
    await sb.from("agents").update({
      plan_id:              devPlan.id,
      monthly_minute_limit: devPlan.monthly_minutes  ?? null,
      monthly_quote_limit:  devPlan.monthly_quote_limit ?? null,
    }).eq("id", user.id);
    return json({ ok: true, upgraded: true });
  }

  const { data: plan, error: planErr } = await sb
    .from("plans")
    .select("*")
    .eq(isUuid ? "id" : "slug", planId)
    .eq("active", true)
    .maybeSingle();

  if (planErr || !plan) return json({ error: "plan_not_found" }, 404);
  if (!plan.stripe_price_id) return json({ error: "plan_has_no_stripe_price" }, 400);

  const { data: agent } = await sb
    .from("agents")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", user.id)
    .maybeSingle();

  const stripeHdrs = {
    "Authorization": `Bearer ${STRIPE_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  // Existing subscriber: update price via Stripe API — no checkout redirect needed.
  if (agent?.stripe_subscription_id) {
    const subRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/${agent.stripe_subscription_id}`,
      { headers: stripeHdrs },
    );
    if (!subRes.ok) {
      const err = await subRes.text();
      return json({ error: "subscription_fetch_failed", detail: err }, 502);
    }
    const sub    = await subRes.json();
    const itemId = sub.items?.data?.[0]?.id as string | undefined;
    if (!itemId) return json({ error: "no_subscription_item" }, 500);

    const updateParams = new URLSearchParams({
      [`items[0][id]`]:                itemId,
      [`items[0][price]`]:            plan.stripe_price_id,
      "proration_behavior":           "create_prorations",
      [`metadata[supabase_user_id]`]: user.id,
      [`metadata[plan_id]`]:          plan.id,
      [`metadata[area_code]`]:        areaCode,
    });
    const updateRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/${agent.stripe_subscription_id}`,
      { method: "POST", headers: stripeHdrs, body: updateParams },
    );
    if (!updateRes.ok) {
      const err = await updateRes.text();
      return json({ error: "subscription_update_failed", detail: err }, 502);
    }

    // Optimistically apply plan caps; webhook confirms.
    await sb.from("agents").update({
      plan_id:              plan.id,
      monthly_minute_limit: plan.monthly_minutes,
      monthly_quote_limit:  plan.monthly_quote_limit,
    }).eq("id", user.id);

    return json({ ok: true, upgraded: true });
  }

  // New subscriber: create a hosted Stripe Checkout Session (opens in popup).
  const sessionParams = new URLSearchParams({
    "mode":                                             "subscription",
    [`line_items[0][price]`]:                          plan.stripe_price_id,
    [`line_items[0][quantity]`]:                       "1",
    "allow_promotion_codes":                           "true",
    "success_url":                                     `${APP_URL}/app.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    "cancel_url":                                      `${APP_URL}/app.html?checkout=cancelled`,
    [`metadata[supabase_user_id]`]:                    user.id,
    [`metadata[plan_id]`]:                             plan.id,
    [`metadata[area_code]`]:                           areaCode,
    [`subscription_data[metadata][supabase_user_id]`]: user.id,
    [`subscription_data[metadata][plan_id]`]:          plan.id,
    [`subscription_data[metadata][area_code]`]:        areaCode,
    "subscription_data[trial_period_days]":            "7",
  });

  if (agent?.stripe_customer_id) {
    sessionParams.set("customer", agent.stripe_customer_id);
  } else if (user.email) {
    sessionParams.set("customer_email", user.email);
  }

  const sessionRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: stripeHdrs,
    body: sessionParams,
  });

  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    let stripeMsg = errText;
    try {
      const parsed = JSON.parse(errText);
      stripeMsg = parsed?.error?.message || errText;
    } catch (_) {}
    console.error("Stripe checkout session error:", stripeMsg);
    return json({ error: "checkout_session_failed", detail: stripeMsg }, 502);
  }

  const session = await sessionRes.json();
  if (!session.url) {
    console.error("Stripe returned no URL. Session:", JSON.stringify(session));
    return json({ error: "checkout_session_no_url", detail: JSON.stringify(session) }, 502);
  }
  return json({ url: session.url });
});
