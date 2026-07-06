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

async function setCnamOnTelnyxNumber(apiKey: string, e164: string, cnamName: string): Promise<boolean> {
  // Look up Telnyx phone number resource ID by E.164
  const params = new URLSearchParams({ "filter[phone_number]": e164 });
  const listRes = await fetch(`https://api.telnyx.com/v2/phone_numbers?${params}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!listRes.ok) {
    console.warn(`[telnyx-update-all-cnam] Lookup failed for ${e164}:`, await listRes.text());
    return false;
  }
  const listData = await listRes.json();
  const records = listData.data || [];
  if (!records.length) {
    console.warn(`[telnyx-update-all-cnam] ${e164} not found on Telnyx account`);
    return false;
  }

  const telnyxId = records[0].id;
  const patchRes = await fetch(`https://api.telnyx.com/v2/phone_numbers/${telnyxId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ caller_id: { name: cnamName } }),
  });
  if (!patchRes.ok) {
    console.warn(`[telnyx-update-all-cnam] PATCH failed for ${e164}:`, await patchRes.text());
    return false;
  }
  return true;
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

  let body: { cnam_name?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  // NANPA CNAM: max 15 chars, uppercase. Empty string clears the name.
  const rawCnam = (body.cnam_name ?? "").trim();
  const cleanCnam = rawCnam.slice(0, 15).toUpperCase();

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Persist the CNAM name on the agent record
  const { error: agentErr } = await sb.from("agents")
    .update({ cnam_name: cleanCnam || null })
    .eq("id", user.id);

  if (agentErr) {
    return json({ error: "db_update_failed", detail: agentErr.message }, 500);
  }

  // Fetch all active phone numbers for this agent
  const { data: numbers } = await sb.from("phone_numbers")
    .select("e164")
    .eq("agent_id", user.id)
    .eq("status", "active");

  if (!numbers || numbers.length === 0) {
    return json({ ok: true, updated: 0, failed: 0, message: "No numbers to update." });
  }

  // Apply CNAM to each Telnyx number (best-effort, parallel)
  const results = await Promise.all(
    numbers.map(n => setCnamOnTelnyxNumber(TELNYX_API_KEY, n.e164, cleanCnam))
  );

  const updated = results.filter(Boolean).length;
  const failed  = results.length - updated;

  console.log(`[telnyx-update-all-cnam] Set CNAM "${cleanCnam}" — ${updated} succeeded, ${failed} failed for user ${user.id}`);
  return json({ ok: true, updated, failed });
});
