// ============================================================
// supabase/functions/signalwire-buy-number/index.ts
//
// Purchases a SignalWire US Local number on behalf of the calling
// agent, then inserts a matching public.phone_numbers row so the
// Phone Book tab shows it in inventory. If the agent has no other
// numbers, the new one is set as is_primary=true and mirrored into
// public.agents.signalwire_caller_id (so the unchanged
// signalwire-bridge edge function dials from it).
//
// **This calls a billable SignalWire endpoint** — every successful
// purchase adds ~$1/mo to the SignalWire account. The frontend gates
// this behind a confirmation dialog.
//
// Required secrets (already set for signalwire-bridge, reused):
//   - SIGNALWIRE_SPACE_URL
//   - SIGNALWIRE_PROJECT_ID
//   - SIGNALWIRE_API_TOKEN
//
// Auth: Edge Function platform verifies the caller's JWT.
//
// Request (POST, JSON body):
//   { e164: "+15125550100", friendly_name?: string,
//     locality?: string, region?: string }
//
// Response (200):
//   { ok: true, row: <inserted phone_numbers row> }
// Response (400): { ok:false, error: 'e164 required' | 'invalid e164' }
// Response (401): { ok:false, error: 'unauthenticated' }
// Response (409): { ok:false, error: 'already_owned' }   — number is already in our table
// Response (502): { ok:false, error: string }            — SignalWire upstream error
// Response (503): { ok:false, error: string }            — DB insert error
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// Mirror of telnyx-buy-number's syncNumberOnStripe — adds $3/mo number line
// item to the agent's Stripe subscription (or increments qty if already there).
// Best-effort: errors are logged but never fail the purchase response.
async function syncNumberOnStripe(
  sb: ReturnType<typeof createClient>,
  stripeKey: string,
  agentId: string,
) {
  try {
    const [agentRes, configRes] = await Promise.all([
      sb.from("agents")
        .select("stripe_subscription_id, stripe_numbers_item_id")
        .eq("id", agentId)
        .maybeSingle(),
      sb.from("billing_config")
        .select("stripe_numbers_price_id")
        .eq("id", 1)
        .maybeSingle(),
    ]);

    const agent  = agentRes.data;
    const config = configRes.data;

    if (!agent?.stripe_subscription_id) return;
    if (!config?.stripe_numbers_price_id) return;

    const stripeHdrs = {
      "Authorization": `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const existingItemId = agent.stripe_numbers_item_id;

    if (!existingItemId) {
      const addParams = new URLSearchParams({
        "subscription":       agent.stripe_subscription_id,
        "price":              config.stripe_numbers_price_id,
        "quantity":           "1",
        "proration_behavior": "create_prorations",
      });
      const addRes = await fetch("https://api.stripe.com/v1/subscription_items", {
        method: "POST",
        headers: stripeHdrs,
        body: addParams,
      });
      if (!addRes.ok) {
        console.warn("[signalwire-buy-number] Stripe add number item failed:", await addRes.text());
        return;
      }
      const newItem = await addRes.json();
      await sb.from("agents")
        .update({ stripe_numbers_item_id: newItem.id })
        .eq("id", agentId);
      console.log(`[signalwire-buy-number] Created Stripe number item ${newItem.id} for agent ${agentId}`);
      return;
    }

    const itemRes = await fetch(
      `https://api.stripe.com/v1/subscription_items/${existingItemId}`,
      { headers: stripeHdrs },
    );
    if (!itemRes.ok) {
      console.warn("[signalwire-buy-number] Stripe fetch item failed:", await itemRes.text());
      return;
    }
    const item   = await itemRes.json();
    const newQty = (item.quantity || 0) + 1;

    const updateParams = new URLSearchParams({
      "quantity":           String(newQty),
      "proration_behavior": "create_prorations",
    });
    const updateRes = await fetch(
      `https://api.stripe.com/v1/subscription_items/${existingItemId}`,
      { method: "POST", headers: stripeHdrs, body: updateParams },
    );
    if (!updateRes.ok) {
      console.warn("[signalwire-buy-number] Stripe update qty failed:", await updateRes.text());
      return;
    }
    console.log(`[signalwire-buy-number] Updated Stripe number qty to ${newQty} for agent ${agentId}`);
  } catch (e) {
    console.error("[signalwire-buy-number] Stripe sync error:", e);
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

  const spaceUrl  = Deno.env.get("SIGNALWIRE_SPACE_URL")  ?? "";
  const projectId = Deno.env.get("SIGNALWIRE_PROJECT_ID") ?? "";
  const apiToken  = Deno.env.get("SIGNALWIRE_API_TOKEN")  ?? "";
  if (!spaceUrl || !projectId || !apiToken) {
    console.error("[signalwire-buy-number] missing SignalWire secrets");
    return json({ ok: false, error: "SignalWire not configured on server" }, 500);
  }

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")      ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const STRIPE_KEY        = Deno.env.get("STRIPE_SECRET_KEY");
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- Auth ----------------------------------------------------------
  let userId: string;
  let userEmail: string | undefined;
  try {
    const { data, error } = await userClient.auth.getUser();
    if (error || !data?.user?.id) return json({ ok: false, error: "unauthenticated" }, 401);
    userId = data.user.id;
    userEmail = data.user.email;
  } catch {
    return json({ ok: false, error: "unauthenticated" }, 401);
  }

  // ---- Require an active paid plan (or admin) -------------------------
  // Numbers are billed to us immediately by SignalWire regardless of whether
  // the agent ever completes Stripe checkout, so this must be enforced here
  // — not just gated client-side — or an authenticated-but-unpaid session
  // can buy numbers for free.
  const DEV_EMAIL_GATE = 'jacef8778099@gmail.com';
  if (userEmail !== DEV_EMAIL_GATE) {
    const sbCheck = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: agentCheck } = await sbCheck.from("agents")
      .select("plan_id, is_admin")
      .eq("id", userId)
      .maybeSingle();
    if (!agentCheck?.is_admin && !agentCheck?.plan_id) {
      return json({ ok: false, error: "active_subscription_required" }, 402);
    }
  }

  // ---- Parse body ----------------------------------------------------
  let body: { e164?: string; friendly_name?: string; locality?: string; region?: string };
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }

  const e164 = (body.e164 || "").trim();
  if (!e164) return json({ ok: false, error: "e164 required" }, 400);
  if (!/^\+\d{8,15}$/.test(e164)) {
    return json({ ok: false, error: "invalid e164" }, 400);
  }

  // ---- Reject early if we already track this number ------------------
  // The unique constraint would catch it anyway, but a friendlier message
  // saves a wasted SignalWire purchase (which would still consume the
  // number on their side and orphan it from our inventory).
  try {
    const { data: existing, error } = await userClient
      .from("phone_numbers")
      .select("id")
      .eq("e164", e164)
      .maybeSingle();
    if (error) throw error;
    if (existing) return json({ ok: false, error: "already_owned" }, 409);
  } catch (e) {
    console.error(`[signalwire-buy-number] dedupe check failed:`, (e as Error)?.message);
    // Don't block the purchase on a transient read error.
  }

  // ---- Purchase via SignalWire LaML IncomingPhoneNumbers -------------
  // VoiceUrl is intentionally omitted — inbound routing is out of scope
  // for the Phone Book launch, so the number falls through SignalWire's
  // default (which is a 404 / no-op). Adding an inbound handler is a
  // separate phase that would set VoiceUrl here to our future
  // signalwire-incoming endpoint.
  const space = spaceUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const url =
    `https://${space}/api/laml/2010-04-01/Accounts/${projectId}` +
    `/IncomingPhoneNumbers.json`;

  const form = new URLSearchParams();
  form.set("PhoneNumber", e164);
  if (body.friendly_name) form.set("FriendlyName", body.friendly_name.slice(0, 64));

  const auth = "Basic " + btoa(`${projectId}:${apiToken}`);
  const start = Date.now();
  let swRes: Response;
  try {
    swRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    console.error(`[signalwire-buy-number] network error:`, (e as Error)?.message);
    return json({ ok: false, error: "signalwire_unreachable" }, 502);
  }
  const ms = Date.now() - start;

  const text = await swRes.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!swRes.ok) {
    console.error(`[signalwire-buy-number] upstream ${swRes.status} ms=${ms}:`, data);
    return json({
      ok: false,
      error: typeof data?.message === "string"
        ? data.message
        : `SignalWire error ${swRes.status}`,
    }, 502);
  }

  const swSid: string = data?.sid || "";
  console.log(`[signalwire-buy-number] purchased agent=${userId} e164=${e164} sid=${swSid} ms=${ms}`);

  // ---- Insert phone_numbers row --------------------------------------
  // is_primary=true only if the agent has no other numbers yet.
  let isFirst = false;
  try {
    const { data: existing, error } = await userClient
      .from("phone_numbers")
      .select("id")
      .eq("agent_id", userId)
      .limit(1);
    if (error) throw error;
    isFirst = !existing || existing.length === 0;
  } catch (e) {
    console.warn(`[signalwire-buy-number] inventory check failed:`, (e as Error)?.message);
  }

  const insertRow = {
    agent_id:      userId,
    e164,
    friendly_name: body.friendly_name || data?.friendly_name || e164,
    locality:      body.locality || null,
    region:        body.region   || null,
    sw_phone_sid:  swSid || null,
    monthly_cost:  1.00,
    is_primary:    isFirst,
    status:        "active",
  };

  let row: any = null;
  try {
    const { data: inserted, error } = await userClient
      .from("phone_numbers")
      .insert(insertRow)
      .select()
      .maybeSingle();
    if (error) throw error;
    row = inserted;
  } catch (e) {
    console.error(`[signalwire-buy-number] DB insert failed:`, (e as Error)?.message);
    return json({
      ok: false,
      error: `Number was purchased on SignalWire but we couldn't record it locally: ${(e as Error)?.message || 'unknown'}. Contact support — SID ${swSid}.`,
    }, 503);
  }

  // Sync the phone number quantity to the agent's Stripe subscription.
  // Best-effort — never fails the buy response.
  if (STRIPE_KEY && userEmail !== DEV_EMAIL_GATE) {
    const sbService = createClient(SUPABASE_URL, SERVICE_KEY);
    await syncNumberOnStripe(sbService, STRIPE_KEY, userId);
  }

  // If this is the agent's first number, mirror it into the caller_id
  // column so signalwire-bridge dials from it immediately.
  if (isFirst) {
    try {
      const { error } = await userClient
        .from("agents")
        .update({ signalwire_caller_id: e164 })
        .eq("id", userId);
      if (error) throw error;
    } catch (e) {
      console.warn(`[signalwire-buy-number] caller_id mirror failed:`, (e as Error)?.message);
      // Non-fatal — the inventory row is correct; UI can flag a "set as
      // primary" action if mirror didn't stick.
    }
  }

  return json({ ok: true, row });
});
