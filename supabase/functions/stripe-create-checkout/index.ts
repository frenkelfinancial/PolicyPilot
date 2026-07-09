import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// Reusable coupon backing the agency downline discount. Created lazily on
// first use so no manual Stripe Dashboard setup is required.
const AGENCY_DISCOUNT_COUPON_ID = "agency-downline-20";

async function ensureAgencyDiscountCoupon(stripeHdrs: Record<string, string>) {
  const getRes = await fetch(`https://api.stripe.com/v1/coupons/${AGENCY_DISCOUNT_COUPON_ID}`, { headers: stripeHdrs });
  if (getRes.ok) return;
  await fetch("https://api.stripe.com/v1/coupons", {
    method: "POST",
    headers: stripeHdrs,
    body: new URLSearchParams({
      id: AGENCY_DISCOUNT_COUPON_ID,
      percent_off: "20",
      duration: "forever",
      name: "Agency Downline 20% Off",
    }),
  }).catch(() => {});
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
  const mode     = body.mode as string | undefined;
  const areaCode = (body.area_code as string | undefined) || "202";

  if (!planId && mode !== "numbers" && mode !== "topup") return json({ error: "plan_id_required" }, 400);

  const DEV_EMAIL = 'jacef8778099@gmail.com';

  // ── Wallet top-up checkout ────────────────────────────────────────────────
  // One-time payment (NOT a subscription) that credits public.wallet_accounts
  // via stripe-webhook once Stripe confirms the charge. Amounts are never
  // hardcoded here — only the allow-list of presets (in mills) configured in
  // billing_config.topup_presets_mills may be purchased. That same row is
  // what the app.html "Add funds" buttons read, so there's one place to
  // change the preset amounts, not two.
  if (mode === "topup") {
    const amountMills = Number(body.amount_mills);
    if (!Number.isFinite(amountMills) || amountMills <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }

    const { data: billingConfig } = await sb
      .from("billing_config")
      .select("stripe_topup_product_id, topup_presets_mills")
      .eq("id", 1)
      .maybeSingle();

    const presets: number[] = Array.isArray(billingConfig?.topup_presets_mills)
      ? billingConfig.topup_presets_mills
      : [5000, 10000, 25000, 50000, 100000];
    if (!presets.includes(amountMills)) {
      return json({ error: "invalid_amount", detail: "amount_mills must be one of the configured top-up presets" }, 400);
    }

    // NOTE: deliberately no dev-account bypass here, unlike the plan/number
    // flows below. Those grant the owner free access to features they
    // already control the cost of; a wallet top-up mints real spendable
    // balance out of nothing, which must never happen without money
    // actually changing hands — including for the dev account. The wallet
    // is only ever credited by stripe-webhook on a confirmed Stripe event.
    if (!billingConfig?.stripe_topup_product_id) {
      return json({ error: "topup_not_configured" }, 400);
    }

    const { data: agent } = await sb
      .from("agents")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();

    const stripeHdrs = {
      "Authorization": `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // Stripe unit_amount is in cents; mills are thousandths of a dollar, so
    // cents = mills / 10 (presets are always round-dollar mills, so this is exact).
    const cents = Math.round(amountMills / 10);

    const sessionParams = new URLSearchParams({
      "mode":                                             "payment",
      "line_items[0][price_data][currency]":              "usd",
      "line_items[0][price_data][product]":               billingConfig.stripe_topup_product_id,
      "line_items[0][price_data][unit_amount]":           String(cents),
      "line_items[0][quantity]":                          "1",
      "success_url":                                      `${APP_URL}/app.html?checkout=topup_success&session_id={CHECKOUT_SESSION_ID}`,
      "cancel_url":                                       `${APP_URL}/app.html?checkout=cancelled`,
      "metadata[supabase_user_id]":                       user.id,
      "metadata[amount_mills]":                           String(amountMills),
      "payment_intent_data[metadata][supabase_user_id]":  user.id,
      "payment_intent_data[metadata][amount_mills]":      String(amountMills),
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
      try { stripeMsg = JSON.parse(errText)?.error?.message || errText; } catch (_) {}
      console.error("Stripe topup checkout error:", stripeMsg);
      return json({ error: "checkout_session_failed", detail: stripeMsg }, 502);
    }

    const session = await sessionRes.json();
    if (!session.url) return json({ error: "checkout_session_no_url" }, 502);
    return json({ url: session.url });
  }

  // ── Numbers-only checkout ─────────────────────────────────────────────────
  // Used when an agent has a plan but no Stripe subscription yet (e.g. given
  // access manually). Creates a subscription for the phone number + usage
  // products so billing is established before they buy their first number.
  if (mode === "numbers") {
    if (user.email === DEV_EMAIL) return json({ ok: true, dev: true });

    const { data: agent } = await sb
      .from("agents")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("id", user.id)
      .maybeSingle();

    if (agent?.stripe_subscription_id) return json({ ok: true, already_subscribed: true });

    const { data: billingConfig } = await sb
      .from("billing_config")
      .select("stripe_numbers_price_id, stripe_minutes_price_id")
      .eq("id", 1)
      .maybeSingle();

    if (!billingConfig?.stripe_numbers_price_id) {
      return json({ error: "numbers_price_not_configured" }, 400);
    }

    const stripeHdrs = {
      "Authorization": `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const sessionParams = new URLSearchParams({
      "mode":                                              "subscription",
      "line_items[0][price]":                             billingConfig.stripe_numbers_price_id,
      "line_items[0][quantity]":                          "1",
      "success_url":                                      `${APP_URL}/app.html?checkout=number_success&session_id={CHECKOUT_SESSION_ID}`,
      "cancel_url":                                       `${APP_URL}/app.html?checkout=cancelled`,
      "metadata[supabase_user_id]":                       user.id,
      "subscription_data[metadata][supabase_user_id]":    user.id,
    });
    // The minutes price (metered usage) is NOT included here — reportMinutesToStripe
    // adds it lazily as a subscription item when the agent's first call ends.

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
      try { stripeMsg = JSON.parse(errText)?.error?.message || errText; } catch (_) {}
      console.error("Stripe number checkout error:", stripeMsg);
      return json({ error: "checkout_session_failed", detail: stripeMsg }, 502);
    }

    const session = await sessionRes.json();
    if (!session.url) return json({ error: "checkout_session_no_url" }, 502);
    return json({ url: session.url });
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(planId!);

  // Developer account bypass — skip Stripe, apply plan directly in DB.
  if (user.email === DEV_EMAIL) {
    const { data: devPlan, error: devPlanErr } = await sb
      .from("plans").select("*").eq(isUuid ? "id" : "slug", planId!).eq("active", true).maybeSingle();
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
    .eq(isUuid ? "id" : "slug", planId!)
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

  // Downline agents on Basic/Pro get an ongoing 20% discount for as long as
  // they stay linked to a team leader via a valid agency code.
  const planTier = (plan.name || "").toLowerCase();
  let applyAgencyDiscount = false;
  if (planTier.includes("basic") || planTier.includes("pro")) {
    const { data: links } = await sb
      .from("agency_invites")
      .select("id")
      .eq("invitee_id", user.id)
      .eq("status", "accepted")
      .limit(1);
    applyAgencyDiscount = !!(links && links.length);
  }
  if (applyAgencyDiscount) await ensureAgencyDiscountCoupon(stripeHdrs);

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
    if (applyAgencyDiscount) updateParams.set(`discounts[0][coupon]`, AGENCY_DISCOUNT_COUPON_ID);
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
  // Note: Stripe disallows combining `discounts` with `allow_promotion_codes`,
  // so a downline agent gets their agency discount applied silently instead
  // of being able to type in a separate promo code.
  const sessionParams = new URLSearchParams({
    "mode":                                             "subscription",
    [`line_items[0][price]`]:                          plan.stripe_price_id,
    [`line_items[0][quantity]`]:                       "1",
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
  if (applyAgencyDiscount) {
    sessionParams.set(`discounts[0][coupon]`, AGENCY_DISCOUNT_COUPON_ID);
  } else {
    sessionParams.set("allow_promotion_codes", "true");
  }

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
