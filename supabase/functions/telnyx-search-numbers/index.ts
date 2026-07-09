import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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

serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  let body: { area_code?: string; limit?: number; number_type?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const numberType = body.number_type === "tollfree" ? "tollfree" : "local";
  const limit = Math.min(body.limit || 20, 20);

  const params = new URLSearchParams({
    "filter[phone_number_type]": numberType === "tollfree" ? "toll_free" : "local",
    "filter[country_code]":     "US",
    "filter[limit]":            String(limit),
  });

  // Local numbers are searched by 3-digit area code. Toll-free numbers
  // aren't tied to a geographic area code, but Telnyx still accepts the
  // toll-free prefix (800/888/877/866/855/844/833) as national_destination_code
  // if the agent wants to narrow their search; otherwise search all toll-free.
  if (numberType === "local") {
    const areaCode = (body.area_code || "").replace(/\D/g, "").slice(0, 3);
    if (!/^\d{3}$/.test(areaCode)) return json({ error: "invalid_area_code" }, 400);
    params.set("filter[national_destination_code]", areaCode);
  } else if (body.area_code) {
    const prefix = (body.area_code || "").replace(/\D/g, "").slice(0, 3);
    if (/^\d{3}$/.test(prefix)) params.set("filter[national_destination_code]", prefix);
  }

  const res = await fetch(`https://api.telnyx.com/v2/available_phone_numbers?${params}`, {
    headers: { "Authorization": `Bearer ${TELNYX_API_KEY}` },
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: "telnyx_error", detail: err }, 502);
  }

  const data = await res.json();

  // Normalize Telnyx response to the shape the frontend expects:
  // { numbers: [{ phone_number, friendly_name, locality, region }] }
  const numbers = (data.data || []).map((n: {
    phone_number: string;
    region_information?: { region_name: string; region_type: string }[];
  }) => {
    const locality = n.region_information?.find((r) => r.region_type === "locality")?.region_name ?? null;
    const region   = n.region_information?.find((r) => r.region_type === "state")?.region_name ?? null;
    return {
      phone_number:  n.phone_number,
      friendly_name: n.phone_number,
      locality,
      region,
    };
  });

  return json({ numbers });
});
