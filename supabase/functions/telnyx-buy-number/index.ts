import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://producerstackcrm.com",
  "https://localhost", // iOS/Android Capacitor (iosScheme/androidScheme: "https")
]);

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://producerstackcrm.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// Create a dedicated Stripe subscription for a single phone number.
// Each number gets its own subscription so billing is independent:
// - start date = day of purchase
// - recurring = same day each month
// - cancel = only that number is affected
async function createNumberSubscription(
  sb: ReturnType<typeof createClient>,
  stripeKey: string,
  agentId: string,
  phoneNumberRowId: string,
) {
  try {
    const [agentRes, configRes] = await Promise.all([
      sb.from("agents")
        .select("stripe_customer_id")
        .eq("id", agentId)
        .maybeSingle(),
      sb.from("billing_config")
        .select("stripe_numbers_price_id")
        .eq("id", 1)
        .maybeSingle(),
    ]);

    const customerId = agentRes.data?.stripe_customer_id;
    const priceId    = configRes.data?.stripe_numbers_price_id;

    if (!customerId || !priceId) return;

    const stripeHdrs = {
      "Authorization": `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const subRes = await fetch("https://api.stripe.com/v1/subscriptions", {
      method: "POST",
      headers: stripeHdrs,
      body: new URLSearchParams({
        "customer":        customerId,
        "items[0][price]": priceId,
      }),
    });

    if (!subRes.ok) {
      console.warn("[telnyx-buy-number] Stripe subscription create failed:", await subRes.text());
      return;
    }

    const sub = await subRes.json();
    await sb.from("phone_numbers").update({ stripe_sub_id: sub.id }).eq("id", phoneNumberRowId);
    console.log(`[telnyx-buy-number] Created Stripe subscription ${sub.id} for number row ${phoneNumberRowId}`);
  } catch (e) {
    console.error("[telnyx-buy-number] Stripe subscription create error:", e);
  }
}

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_CONN_ID = Deno.env.get("TELNYX_CONNECTION_ID");
  const STRIPE_KEY     = Deno.env.get("STRIPE_SECRET_KEY");
  const DEV_EMAIL      = "jacef8778099@gmail.com";

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  // Require an active paid plan (or admin) before allowing a purchase.
  // Numbers are billed to us immediately by Telnyx regardless of whether the
  // agent ever completes Stripe checkout, so this must be checked here — not
  // just gated client-side — or an authenticated-but-unpaid session can buy
  // numbers for free.
  if (user.email !== DEV_EMAIL) {
    const sbCheck = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: agentCheck } = await sbCheck.from("agents")
      .select("plan_id, is_admin")
      .eq("id", user.id)
      .maybeSingle();
    if (!agentCheck?.is_admin && !agentCheck?.plan_id) {
      return json({ error: "active_subscription_required" }, 402);
    }
  }

  let body: { e164?: string; friendly_name?: string | null; locality?: string | null; region?: string | null };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const e164 = body.e164;
  if (!e164 || !/^\+1\d{10}$/.test(e164)) {
    return json({ error: "invalid_number", detail: "Must be a US E.164 number like +14155551234" }, 400);
  }

  // Purchase the number from Telnyx and assign it to the connection
  const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      phone_numbers: [{ phone_number: e164 }],
      connection_id: TELNYX_CONN_ID,
    }),
  });

  if (!orderRes.ok) {
    const err = await orderRes.text();
    return json({ ok: false, error: `Telnyx purchase failed: ${err}` }, 502);
  }

  const orderData = await orderRes.json();
  // phone_numbers[0].id is the phone number resource ID; data.id is the order ID
  const telnyxPhoneSid: string = orderData?.data?.phone_numbers?.[0]?.id || orderData?.data?.id || "";

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Get current billing config to store the correct rate on the phone_numbers row
  const { data: billingConfig } = await sb.from("billing_config")
    .select("number_rate_cents")
    .eq("id", 1)
    .maybeSingle();
  const monthlyCostDollars = ((billingConfig?.number_rate_cents ?? 300) / 100).toFixed(2);

  // If this is the agent's first number, auto-set it as primary so they can
  // call immediately without a manual "Set as Primary" step.
  // Also read the agent's global CNAM setting to auto-apply to the new number.
  const { data: agentRow } = await sb.from("agents")
    .select("signalwire_caller_id, cnam_name")
    .eq("id", user.id)
    .maybeSingle();
  const isFirstNumber = !agentRow?.signalwire_caller_id;
  const cnamName: string | null = agentRow?.cnam_name || null;

  // Insert and get back the row ID so we can attach the Stripe subscription to it.
  const { data: insertedRow, error: insertErr } = await sb.from("phone_numbers").insert({
    agent_id:      user.id,
    e164,
    friendly_name: body.friendly_name || e164,
    locality:      body.locality  ?? null,
    region:        body.region    ?? null,
    sw_phone_sid:  telnyxPhoneSid,
    monthly_cost:  monthlyCostDollars,
    is_primary:    isFirstNumber,
    status:        "active",
    purchased_at:  new Date().toISOString(),
  }).select("id").single();

  // Best-effort: apply the agent's global CNAM to the new number on Telnyx.
  if (cnamName && telnyxPhoneSid) {
    try {
      const patchRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxPhoneSid}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${TELNYX_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({ caller_id: { name: cnamName } }),
      });
      if (!patchRes.ok) {
        console.warn("[telnyx-buy-number] CNAM PATCH failed:", await patchRes.text());
      } else {
        console.log(`[telnyx-buy-number] Auto-applied CNAM "${cnamName}" to ${e164}`);
      }
    } catch (e) {
      console.warn("[telnyx-buy-number] CNAM set error:", e);
    }
  }

  if (insertErr || !insertedRow) {
    console.warn("[telnyx-buy-number] DB insert failed:", insertErr?.message);
    return json({ ok: false, error: "Purchase succeeded at Telnyx but failed to save to database: " + insertErr?.message }, 500);
  }

  if (isFirstNumber) {
    await sb.from("agents")
      .update({ signalwire_caller_id: e164 })
      .eq("id", user.id);
    console.log(`[telnyx-buy-number] Auto-set ${e164} as primary caller ID for agent ${user.id}`);
  }

  // Create a dedicated Stripe subscription for this number.
  // Each number gets its own subscription: billing starts today and recurs on
  // this day of the month. Developer account skips Stripe billing entirely.
  if (STRIPE_KEY && user.email !== DEV_EMAIL) {
    await createNumberSubscription(sb, STRIPE_KEY, user.id, insertedRow.id);
  }

  return json({ ok: true, e164, set_as_primary: isFirstNumber });
});
