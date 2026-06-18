// ============================================================
// supabase/functions/anthropic-parse/index.ts
//
// Proxy for the AI health-parser feature. The dashboard's quote panels
// send raw client health text; this function asks Claude to return a
// JSON array of standardized condition names that map to UW_CLASS in
// the dashboard.
//
// Required secret (set in Supabase dashboard or via `supabase secrets set`):
//   - ANTHROPIC_API_KEY   API key from console.anthropic.com
//
// Auth: Edge Function platform verifies the caller's JWT before this
// runs (verify_jwt = true is the default). Anonymous calls return 401
// before our code executes.
//
// Request (POST, JSON body):
//   { text: string }
//
// Response (200): { ok: true, conditions: string[] }
// Response (4xx/5xx): { ok: false, error: string }
// ============================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 500;
const MAX_INPUT_LEN = 4000;

const CORS = {
  "Access-Control-Allow-Origin": "https://producerstackcrm.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are a life insurance underwriting specialist helping insurance agents get a general estimate of carrier approval likelihood. Be LENIENT and realistic — insurers often approve clients with conditions at modified or graded levels that agents might expect to be declined. Many carriers have flexible underwriting and approve conditions that seem severe.

Key principle: Default to the MOST FAVORABLE realistic outcome. If a condition COULD be approved at select 2 or graded, say so. Only mark "decline" for conditions that are almost universally declined (active terminal illness, organ transplant, HIV/AIDS, ALS, current dialysis, current hospice care).

For COPD with oxygen — Transamerica and Corebridge can be GRADED (not decline). Americo may approve at select 2 in some cases.
For diabetes on metformin — nearly always select 1 or select 2, NEVER decline.
For diabetes + COPD combined — likely graded at some carriers, but NOT necessarily declined everywhere.
Oxygen use alone — graded at Corebridge/Trans, possible decline at others, but always show graded options.
High blood pressure controlled — always level/select 1, benign condition.
Mental health conditions (depression, anxiety, PTSD, bipolar) — nearly always approved level or select 1.
Past history (>2 years ago) — generally much more favorable than recent conditions.

Available conditions (use EXACT names):
AFIB / Irregular Heartbeat, Angina (Chest Pain), Angioplasty, Aneurysm, Blood Clots, Congestive Heart Failure, Coronary Artery Disease, Heart Attack (within 2 yrs), Heart Attack (2+ yrs ago), Heart Surgery (within 2 yrs), Heart Surgery (2+ yrs ago), Heart Valve Replacement, Pacemaker / Defibrillator (within 2 yrs), Pacemaker / Defibrillator (2+ yrs ago), Stent (within 2 yrs), Stent (2+ yrs ago), Asthma (Chronic), Bronchitis (Chronic), COPD (Inhaler — no oxygen), COPD (On Oxygen), Emphysema (Chronic), Pulmonary Fibrosis, Sleep Apnea (CPAP OK), Oxygen Use (not CPAP), Diabetes Type 2 — Controlled (A1C ≤ 8.6, no insulin), Diabetes Type 2 — Uncontrolled or A1C > 8.6, Diabetes Type 1 / On Insulin, Diabetic Complications (neuropathy/retinopathy), Dialysis, Cancer — Basal Cell Skin Only, Cancer — Active or Treatment within 2 yrs, Cancer — Last Treatment 2–4 yrs ago, Cancer — 4+ yrs cancer free, Melanoma (within 3 yrs), Melanoma (3+ yrs ago), Alzheimer's / Dementia / Memory Loss, ALS (Lou Gehrig's), Autism, Bipolar Disorder, Cerebral Palsy, Depression, Down's Syndrome, Epilepsy / Seizures (within 3 yrs), Epilepsy / Seizures (3+ yrs), Huntington's Disease, Mental Incapacity / Cognitive Impairment, Multiple Sclerosis (MS), Parkinson's Disease, PTSD, Schizophrenia, Cirrhosis, Crohn's Disease, Cystic Fibrosis, Hepatitis A, Hepatitis B, Hepatitis C, Kidney Disease / Kidney Failure, Liver Disease / Liver Failure, Pancreatitis, Ulcerative Colitis, Amputation (due to diabetes or disease), Amputation (trauma), Arthritis, Assisted Living / Long-Term Care Facility, Rheumatoid Arthritis, Sarcoidosis, Walker Use, Wheelchair / Scooter / Electric Cart, Blood Disorder (Hemophilia / Thrombocytopenia), Bone Marrow Transplant, HIV / AIDS / ARC, Lupus (SLE), Sickle Cell Anemia, Alcohol or Drug Abuse (within 2 yrs), Alcohol or Drug Abuse (2+ yrs clean), DUI (within 2 yrs), DUI (2+ yrs ago), Felony (within 6 months), Felony (6+ months ago), Illegal Drug Use (within 2 yrs), Illegal Drug Use (2+ yrs clean), Incarcerated / Jail, Parole or Probation (currently), Terminal Illness (death expected within 12 months), Organ Transplant, Chronic Narcotic Pain Medications (6+ fills/month), Neuropathy (not diabetic), Stroke/TIA (within 2 yrs), Stroke/TIA (2+ yrs ago)

Medication mapping: insulin → Diabetes Type 1 / On Insulin; metformin/ozempic/januvia/jardiance/glipizide → Diabetes Type 2 — Controlled (A1C ≤ 8.6, no insulin); eliquis/xarelto/warfarin/plavix → Blood Clots; lisinopril/metoprolol/amlodipine/losartan/hydrochlorothiazide alone → Arthritis (benign, HBP); oxycodone/hydrocodone/morphine/fentanyl → Chronic Narcotic Pain Medications (6+ fills/month); albuterol/symbicort/advair/spiriva → Asthma (Chronic) or COPD (Inhaler — no oxygen); cpap/bipap → Sleep Apnea (CPAP OK); home oxygen/oxygen tank/supplemental oxygen → COPD (On Oxygen); humira/enbrel/methotrexate → Rheumatoid Arthritis; prozac/zoloft/lexapro/wellbutrin/sertraline → Depression; xanax/klonopin/ativan → Depression (benign); abilify/lithium/depakote → Bipolar Disorder

Return ONLY a JSON array of matching condition names. No explanation, no markdown. Example: ["Diabetes Type 2 — Controlled (A1C ≤ 8.6, no insulin)", "Sleep Apnea (CPAP OK)"]`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ ok: false, error: "ANTHROPIC_API_KEY not configured on server" }, 500);

  let body: { text?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return json({ ok: false, error: "text is required" }, 400);
  if (text.length > MAX_INPUT_LEN) {
    return json({ ok: false, error: `text exceeds ${MAX_INPUT_LEN} chars` }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Client health description: "${text}"` }],
      }),
    });
  } catch (e) {
    console.error(`[anthropic-parse] network error:`, (e as Error)?.message || e);
    return json({ ok: false, error: "Upstream provider unreachable" }, 502);
  }

  const raw = await upstream.text();
  if (!upstream.ok) {
    console.error(`[anthropic-parse] upstream ${upstream.status}:`, raw);
    const status = upstream.status === 401 ? 502 : upstream.status;
    return json({ ok: false, error: `Anthropic error ${upstream.status}` }, status);
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch {
    return json({ ok: false, error: "Invalid response from upstream" }, 502);
  }

  const reply = payload?.content?.[0]?.text || "[]";
  const cleaned = reply.replace(/```json|```/g, "").trim();
  let conditions: unknown;
  try { conditions = JSON.parse(cleaned); } catch {
    conditions = [];
  }
  const result = Array.isArray(conditions) ? conditions.filter((c) => typeof c === "string") : [];

  return json({ ok: true, conditions: result });
});
