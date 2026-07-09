import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

async function telnyxReleaseByE164(apiKey: string, e164: string): Promise<void> {
  const params = new URLSearchParams({ "filter[phone_number]": e164 });
  const listRes = await fetch(`https://api.telnyx.com/v2/phone_numbers?${params}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!listRes.ok) throw new Error(`Telnyx list failed: ${await listRes.text()}`);
  const listData = await listRes.json();
  const records = listData.data || [];
  if (!records.length) throw new Error(`Number ${e164} not found on Telnyx account`);

  const telnyxId = records[0].id;
  const delRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!delRes.ok && delRes.status !== 404) {
    throw new Error(`Telnyx release failed: ${await delRes.text()}`);
  }
}

// DEPRECATED (wallet migration): replacing a number used to cancel the old
// number's dedicated Stripe subscription and create a fresh one for the
// replacement (cancelNumberSubscription / decrementStripeNumber /
// createNumberSubscription). Replace is free and doesn't debit the wallet
// either — the new row just inherits the old number's number_type,
// next_renewal_at and renew_from_wallet below, so the existing paid period
// carries over untouched.

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

  if (!TELNYX_API_KEY || !TELNYX_CONN_ID) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: {
    old_phone_number_id?: string;
    new_e164?: string;
    new_friendly_name?: string | null;
    new_locality?: string | null;
    new_region?: string | null;
  };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const { old_phone_number_id, new_e164, new_friendly_name, new_locality, new_region } = body;
  if (!old_phone_number_id) return json({ error: "old_phone_number_id_required" }, 400);
  if (!new_e164 || !/^\+1\d{10}$/.test(new_e164)) {
    return json({ error: "invalid_new_number", detail: "Must be a US E.164 number like +14155551234" }, 400);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: oldRecord, error: fetchErr } = await sb.from("phone_numbers")
    .select("*")
    .eq("id", old_phone_number_id)
    .eq("agent_id", user.id)
    .maybeSingle();

  if (fetchErr || !oldRecord) return json({ error: "old_number_not_found" }, 404);

  // Step 1: Buy new number from Telnyx
  const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phone_numbers: [{ phone_number: new_e164 }],
      connection_id: TELNYX_CONN_ID,
    }),
  });

  if (!orderRes.ok) {
    const err = await orderRes.text();
    return json({ ok: false, error: `Telnyx purchase failed: ${err}` }, 502);
  }

  const orderData = await orderRes.json();
  const newTelnyxSid = orderData?.data?.phone_numbers?.[0]?.id || orderData?.data?.id || "";

  // Step 2: Insert new number in DB; inherit old number's primary status,
  // cost, and wallet renewal schedule (replace is free — the existing paid
  // period carries over, it doesn't reset).
  const { data: newRow, error: insertErr } = await sb.from("phone_numbers").insert({
    agent_id:          user.id,
    e164:              new_e164,
    friendly_name:     new_friendly_name || new_e164,
    locality:          new_locality ?? null,
    region:            new_region ?? null,
    sw_phone_sid:      newTelnyxSid,
    monthly_cost:      oldRecord.monthly_cost,
    number_type:       oldRecord.number_type || "local",
    next_renewal_at:   oldRecord.next_renewal_at,
    renew_from_wallet: oldRecord.renew_from_wallet ?? true,
    is_primary:        oldRecord.is_primary,
    status:            "active",
    purchased_at:      new Date().toISOString(),
  }).select("id").single();

  if (insertErr || !newRow) {
    return json({ ok: false, error: `DB insert failed: ${insertErr?.message}` }, 500);
  }

  // Step 3: If old was primary, point agents.signalwire_caller_id at new number
  if (oldRecord.is_primary) {
    await sb.from("agents")
      .update({ signalwire_caller_id: new_e164 })
      .eq("id", user.id);
  }

  // Step 4: Release old number from Telnyx (best-effort — new number already secured)
  try {
    await telnyxReleaseByE164(TELNYX_API_KEY, oldRecord.e164);
  } catch (e) {
    console.warn(`[telnyx-replace-number] Old number Telnyx release failed (continuing): ${e.message}`);
  }

  // Step 5: Delete old number from DB
  await sb.from("phone_numbers")
    .delete()
    .eq("id", old_phone_number_id)
    .eq("agent_id", user.id);

  return json({ ok: true, new_e164, old_e164: oldRecord.e164 });
});
