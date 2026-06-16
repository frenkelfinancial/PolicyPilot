import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
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

  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  if (!TELNYX_API_KEY) return json({ error: "telnyx_not_configured" }, 500);

  let body: { area_code?: string; limit?: number };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const areaCode = (body.area_code || "").replace(/\D/g, "").slice(0, 3);
  if (!/^\d{3}$/.test(areaCode)) return json({ error: "invalid_area_code" }, 400);

  const limit = Math.min(body.limit || 20, 20);

  const params = new URLSearchParams({
    "filter[national_destination_code]": areaCode,
    "filter[phone_number_type]":         "local",
    "filter[country_code]":              "US",
    "filter[limit]":                     String(limit),
  });

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
