import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// Cancel this number's dedicated Stripe subscription immediately.
async function cancelNumberSubscription(stripeKey: string, stripeSubId: string) {
  try {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${stripeKey}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // resource_missing = already cancelled; treat as success
      if (body?.error?.code !== "resource_missing") {
        console.warn("[telnyx-release-number] Stripe subscription cancel failed:", body);
      }
    } else {
      console.log(`[telnyx-release-number] Cancelled Stripe subscription ${stripeSubId}`);
    }
  } catch (e) {
    console.error("[telnyx-release-number] Stripe cancel error:", e);
  }
}

// Legacy fallback: decrement the shared quantity item for numbers that predate
// per-number subscriptions (no stripe_sub_id on the phone_numbers row).
async function decrementStripeNumber(
  sb: ReturnType<typeof createClient>,
  stripeKey: string,
  agentId: string,
) {
  try {
    const agentRes = await sb.from("agents")
      .select("stripe_subscription_id, stripe_numbers_item_id")
      .eq("id", agentId)
      .maybeSingle();

    const agent = agentRes.data;
    if (!agent?.stripe_subscription_id || !agent?.stripe_numbers_item_id) return;

    const stripeHdrs = {
      "Authorization": `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const itemRes = await fetch(
      `https://api.stripe.com/v1/subscription_items/${agent.stripe_numbers_item_id}`,
      { headers: stripeHdrs },
    );
    if (!itemRes.ok) {
      console.warn("[telnyx-release-number] Stripe fetch item failed:", await itemRes.text());
      return;
    }
    const item = await itemRes.json();
    const newQty = Math.max(0, (item.quantity || 1) - 1);

    if (newQty === 0) {
      await fetch(
        `https://api.stripe.com/v1/subscription_items/${agent.stripe_numbers_item_id}`,
        {
          method: "DELETE",
          headers: stripeHdrs,
          body: new URLSearchParams({ "proration_behavior": "create_prorations" }),
        },
      );
      await sb.from("agents").update({ stripe_numbers_item_id: null }).eq("id", agentId);
    } else {
      await fetch(
        `https://api.stripe.com/v1/subscription_items/${agent.stripe_numbers_item_id}`,
        {
          method: "POST",
          headers: stripeHdrs,
          body: new URLSearchParams({
            "quantity": String(newQty),
            "proration_behavior": "create_prorations",
          }),
        },
      );
    }
    console.log(`[telnyx-release-number] Legacy Stripe qty decremented to ${newQty} for agent ${agentId}`);
  } catch (e) {
    console.error("[telnyx-release-number] Stripe decrement error:", e);
  }
}

async function telnyxReleaseByE164(apiKey: string, e164: string): Promise<void> {
  const params = new URLSearchParams({ "filter[phone_number]": e164 });
  const listRes = await fetch(`https://api.telnyx.com/v2/phone_numbers?${params}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!listRes.ok) throw new Error(`Telnyx list failed: ${await listRes.text()}`);
  const listData = await listRes.json();
  const records = listData.data || [];
  if (!records.length) return; // already released — skip silently
  const telnyxId = records[0].id;
  const delRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!delRes.ok && delRes.status !== 404) {
    throw new Error(`Telnyx release failed: ${await delRes.text()}`);
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

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY    = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_DIALER_NUM = Deno.env.get("TELNYX_DIALER_NUMBER");
  const STRIPE_KEY        = Deno.env.get("STRIPE_SECRET_KEY");
  const DEV_EMAIL         = "jacef8778099@gmail.com";

  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { phone_number_id?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const { phone_number_id } = body;
  if (!phone_number_id) return json({ error: "phone_number_id_required" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: numRecord, error: fetchErr } = await sb.from("phone_numbers")
    .select("*")
    .eq("id", phone_number_id)
    .eq("agent_id", user.id)
    .maybeSingle();

  if (fetchErr || !numRecord) return json({ error: "not_found" }, 404);

  const e164 = numRecord.e164;

  // Guard: never allow deletion of the Power Dialer host number.
  if (TELNYX_DIALER_NUM && e164 === TELNYX_DIALER_NUM) {
    return json({
      error: "protected_number",
      detail: "The Power Dialer host number cannot be deleted. It is shared infrastructure for all agents.",
    }, 403);
  }

  try {
    await telnyxReleaseByE164(TELNYX_API_KEY, e164);
  } catch (e) {
    return json({ ok: false, error: `Telnyx release failed: ${e.message}` }, 502);
  }

  const { error: delErr } = await sb.from("phone_numbers")
    .delete()
    .eq("id", phone_number_id)
    .eq("agent_id", user.id);

  if (delErr) return json({ ok: false, error: `DB delete failed: ${delErr.message}` }, 500);

  if (numRecord.is_primary) {
    const { data: remaining } = await sb.from("phone_numbers")
      .select("e164")
      .eq("agent_id", user.id)
      .order("purchased_at", { ascending: true })
      .limit(1);
    const next = remaining?.[0];
    if (next) {
      await sb.from("phone_numbers").update({ is_primary: true }).eq("e164", next.e164).eq("agent_id", user.id);
      await sb.from("agents").update({ signalwire_caller_id: next.e164 }).eq("id", user.id);
    } else {
      await sb.from("agents").update({ signalwire_caller_id: null }).eq("id", user.id);
    }
  }

  // Cancel this number's Stripe billing. Developer account skips Stripe.
  if (STRIPE_KEY && user.email !== DEV_EMAIL) {
    if (numRecord.stripe_sub_id) {
      // Per-number subscription model: cancel just this number's subscription.
      await cancelNumberSubscription(STRIPE_KEY, numRecord.stripe_sub_id);
    } else {
      // Legacy: number was on the shared quantity item — decrement it.
      await decrementStripeNumber(sb, STRIPE_KEY, user.id);
    }
  }

  return json({ ok: true, e164 });
});
