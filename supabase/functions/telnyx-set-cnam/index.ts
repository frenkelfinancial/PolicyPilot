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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY       = Deno.env.get("SUPABASE_ANON_KEY")!;
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");

  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const sbAuth = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await sbAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { phone_number_id?: string; cnam_name?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const { phone_number_id } = body;
  if (!phone_number_id) return json({ error: "phone_number_id_required" }, 400);

  // NANPA CNAM: max 15 chars, uppercase letters, digits, spaces, hyphens
  const cleanCnam = (body.cnam_name || "").trim().slice(0, 15).toUpperCase() || null;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: numRecord, error: fetchErr } = await sb.from("phone_numbers")
    .select("e164")
    .eq("id", phone_number_id)
    .eq("agent_id", user.id)
    .maybeSingle();

  if (fetchErr || !numRecord) return json({ error: "not_found" }, 404);

  const e164 = numRecord.e164;

  // Look up Telnyx phone number resource ID by E.164
  const params = new URLSearchParams({ "filter[phone_number]": e164 });
  const listRes = await fetch(`https://api.telnyx.com/v2/phone_numbers?${params}`, {
    headers: { "Authorization": `Bearer ${TELNYX_API_KEY}` },
  });
  if (!listRes.ok) {
    return json({ error: "telnyx_lookup_failed", detail: await listRes.text() }, 502);
  }
  const listData = await listRes.json();
  const records = listData.data || [];
  if (!records.length) return json({ error: "number_not_on_telnyx" }, 404);

  const telnyxId = records[0].id;

  // Update caller ID name on Telnyx
  const patchBody: Record<string, unknown> = {
    caller_id: { name: cleanCnam ?? "" },
  };
  const patchRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patchBody),
  });

  if (!patchRes.ok) {
    const err = await patchRes.text();
    console.warn("[telnyx-set-cnam] Telnyx PATCH failed:", err);
    return json({ error: "telnyx_cnam_failed", detail: err }, 502);
  }

  const { error: updateErr } = await sb.from("phone_numbers")
    .update({ cnam_name: cleanCnam })
    .eq("id", phone_number_id)
    .eq("agent_id", user.id);

  if (updateErr) {
    return json({ error: "db_update_failed", detail: updateErr.message }, 500);
  }

  console.log(`[telnyx-set-cnam] Set CNAM "${cleanCnam}" on ${e164}`);
  return json({ ok: true, cnam_name: cleanCnam });
});
