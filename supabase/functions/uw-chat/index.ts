import { corsHeaders } from "../_shared/cors.ts";

// ============================================================
// supabase/functions/uw-chat/index.ts
//
// Multi-turn "Underwriting Copilot" for the Quote + Underwriting tab.
// The dashboard streams the full conversation plus quote context; this
// function asks the model to (a) reply conversationally and (b) return the
// cumulative list of standardized condition names that map to UW_CLASS in
// the dashboard. The dashboard then drives its existing per-carrier
// approval badges + a "best for approval" recommendation off those
// conditions, so the bot's prose and the badges can never disagree.
//
// Runs on DeepSeek (OpenAI-compatible API) reusing the project's existing
// DEEPSEEK_API_KEY. Structured output via JSON mode (response_format
// json_object) — DeepSeek's function-calling is less reliable than plain
// JSON mode, so we ask for a JSON object and validate it ourselves.
//
// Required secret:
//   - DEEPSEEK_API_KEY    API key from platform.deepseek.com
//
// Auth: Edge Function platform verifies the caller's JWT before this runs.
//
// Request (POST, JSON body):
//   {
//     messages: [{ role: 'user'|'assistant', content: string }],
//     context?: { product?, age?, sex?, state?, face?, tobacco?, carriers?: string[] }
//   }
//
// Response (200): { ok: true, reply: string, conditions: string[] }
// Response (4xx/5xx): { ok: false, error: string }
// ============================================================

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";
const MAX_TOKENS = 900;
const MAX_TURNS = 40;
const MAX_MSG_LEN = 4000;

// Canonical condition vocabulary — must stay in sync with UW_CLASS in app.html
// and the list in anthropic-parse/index.ts.
const CONDITIONS = [
  "AFIB / Irregular Heartbeat", "Angina (Chest Pain)", "Angioplasty", "Aneurysm",
  "Blood Clots", "Congestive Heart Failure", "Coronary Artery Disease",
  "Heart Attack (within 2 yrs)", "Heart Attack (2+ yrs ago)",
  "Heart Surgery (within 2 yrs)", "Heart Surgery (2+ yrs ago)",
  "Heart Valve Replacement", "Irregular Heartbeat",
  "Pacemaker / Defibrillator (within 2 yrs)", "Pacemaker / Defibrillator (2+ yrs ago)",
  "Stent (within 2 yrs)", "Stent (2+ yrs ago)", "Asthma (Chronic)",
  "Bronchitis (Chronic)", "COPD (Inhaler — no oxygen)", "COPD (On Oxygen)",
  "Emphysema (Chronic)", "Pulmonary Fibrosis", "Sleep Apnea (CPAP OK)",
  "Oxygen Use (not CPAP)", "Diabetes Type 2 — Controlled (A1C ≤ 8.6, no insulin)",
  "Diabetes Type 2 — Uncontrolled or A1C > 8.6", "Diabetes Type 1 / On Insulin",
  "Diabetic Complications (neuropathy/retinopathy)", "Dialysis",
  "Cancer — Basal Cell Skin Only", "Cancer — Active or Treatment within 2 yrs",
  "Cancer — Last Treatment 2–4 yrs ago", "Cancer — 4+ yrs cancer free",
  "Melanoma (within 3 yrs)", "Melanoma (3+ yrs ago)",
  "Alzheimer's / Dementia / Memory Loss", "ALS (Lou Gehrig's)", "Autism",
  "Bipolar Disorder", "Cerebral Palsy", "Depression", "Down's Syndrome",
  "Epilepsy / Seizures (within 3 yrs)", "Epilepsy / Seizures (3+ yrs)",
  "Huntington's Disease", "Mental Incapacity / Cognitive Impairment",
  "Multiple Sclerosis (MS)", "Parkinson's Disease", "PTSD", "Schizophrenia",
  "Cirrhosis", "Crohn's Disease", "Cystic Fibrosis", "Hepatitis A", "Hepatitis B",
  "Hepatitis C", "Kidney Disease / Kidney Failure", "Liver Disease / Liver Failure",
  "Pancreatitis", "Ulcerative Colitis", "Amputation (due to diabetes or disease)",
  "Amputation (trauma)", "Arthritis", "Assisted Living / Long-Term Care Facility",
  "Rheumatoid Arthritis", "Sarcoidosis", "Walker Use",
  "Wheelchair / Scooter / Electric Cart",
  "Blood Disorder (Hemophilia / Thrombocytopenia)", "Bone Marrow Transplant",
  "HIV / AIDS / ARC", "Lupus (SLE)", "Sickle Cell Anemia",
  "Alcohol or Drug Abuse (within 2 yrs)", "Alcohol or Drug Abuse (2+ yrs clean)",
  "DUI (within 2 yrs)", "DUI (2+ yrs ago)", "Felony (within 6 months)",
  "Felony (6+ months ago)", "Illegal Drug Use (within 2 yrs)",
  "Illegal Drug Use (2+ yrs clean)", "Incarcerated / Jail",
  "Parole or Probation (currently)",
  "Terminal Illness (death expected within 12 months)", "Organ Transplant",
  "Chronic Narcotic Pain Medications (6+ fills/month)", "Neuropathy (not diabetic)",
  "Stroke/TIA (within 2 yrs)", "Stroke/TIA (2+ yrs ago)",
];

const SYSTEM_PROMPT = `You are the Underwriting Copilot — a warm, sharp life-insurance underwriting specialist embedded in an FFL agent's quoting tool. You hold a continuous conversation with the AGENT (not the client) to figure out the client's health picture and which carrier gives the best shot at approval.

You only have detailed underwriting data for these five carriers: Americo, Aetna, American-Amicable, Transamerica, Corebridge. Recommend the best carrier for APPROVAL from the agent's licensed set (given in the context); if the licensed set is empty, tell them to set their licensed carriers in Settings.

Be LENIENT and realistic — insurers often approve at modified/graded levels that agents expect to be declined. Default to the MOST FAVORABLE realistic outcome. Only treat as a likely decline the near-universally-declined conditions (active terminal illness, organ transplant, HIV/AIDS, ALS, current dialysis, current hospice).
- COPD on oxygen -> Transamerica/Corebridge can be GRADED, not decline; Americo may be select 2.
- Diabetes on metformin -> select 1/2, never decline.
- High blood pressure controlled -> benign, level/select 1.
- Mental health (depression, anxiety, PTSD, bipolar) -> nearly always level/select 1.
- History >2 yrs ago -> much more favorable than recent.

Medication mapping: insulin -> Diabetes Type 1 / On Insulin; metformin/ozempic/januvia/jardiance/glipizide -> Diabetes Type 2 — Controlled (A1C ≤ 8.6, no insulin); eliquis/xarelto/warfarin/plavix -> Blood Clots; oxycodone/hydrocodone/morphine/fentanyl -> Chronic Narcotic Pain Medications (6+ fills/month); albuterol/symbicort/advair/spiriva -> Asthma (Chronic) or COPD (Inhaler — no oxygen); cpap/bipap -> Sleep Apnea (CPAP OK); home oxygen/oxygen tank -> COPD (On Oxygen); humira/enbrel/methotrexate -> Rheumatoid Arthritis; prozac/zoloft/lexapro/wellbutrin/sertraline -> Depression; xanax/klonopin/ativan -> Depression; abilify/lithium/depakote -> Bipolar Disorder.

Conversation style:
- Keep replies short (2-4 sentences). Acknowledge what they told you, then either ask ONE clarifying question if something material is ambiguous, or state your carrier recommendation with a one-line reason.
- When you have enough, end with a clear recommendation like: "Best shot for approval: American-Amicable — controlled diabetes + HBP underwrite cleanly there."
- Never invent client facts. If health is light, ask for meds/conditions.

OUTPUT FORMAT — respond with a single JSON object and nothing else:
{
  "reply": "<your conversational message to the agent>",
  "conditions": ["<exact condition names detected across the whole conversation so far>"]
}
The "conditions" array MUST use EXACT names from this allowed list (omit anything not detected; empty array if none):
${CONDITIONS.map((c) => `- ${c}`).join("\n")}`;

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

  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) return json({ ok: false, error: "DEEPSEEK_API_KEY not configured on server" }, 500);

  let body: { messages?: unknown; context?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  // Validate + clamp the conversation.
  const rawMsgs = Array.isArray(body?.messages) ? body!.messages : [];
  const messages = (rawMsgs as Array<Record<string, unknown>>)
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role as string, content: String(m.content).slice(0, MAX_MSG_LEN) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ ok: false, error: "messages must end with a user turn" }, 400);
  }

  // Build the context preamble prepended to the latest user turn.
  const ctx = (body?.context && typeof body.context === "object") ? body.context : {};
  const carriers = Array.isArray(ctx.carriers)
    ? (ctx.carriers as unknown[]).filter((c) => typeof c === "string").join(", ")
    : "";
  const ctxLine =
    `[Quote context — product: ${ctx.product ?? "?"}, age: ${ctx.age ?? "?"}, sex: ${ctx.sex ?? "?"}, ` +
    `state: ${ctx.state ?? "?"}, face: ${ctx.face ?? "?"}, tobacco: ${ctx.tobacco ?? "?"}. ` +
    `Agent licensed carriers (recommend only from these): ${carriers || "none configured"}]`;

  const chatMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.map((m, i) =>
      i === messages.length - 1 && m.role === "user"
        ? { role: "user", content: `${ctxLine}\n\n${m.content}` }
        : m
    ),
  ];

  let upstream: Response;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: chatMessages,
      }),
    });
  } catch (e) {
    console.error(`[uw-chat] network error:`, (e as Error)?.message || e);
    return json({ ok: false, error: "Upstream provider unreachable" }, 502);
  }

  const raw = await upstream.text();
  if (!upstream.ok) {
    console.error(`[uw-chat] upstream ${upstream.status}:`, raw);
    const status = upstream.status === 401 ? 502 : upstream.status;
    return json({ ok: false, error: `DeepSeek error ${upstream.status}` }, status);
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch {
    return json({ ok: false, error: "Invalid response from upstream" }, 502);
  }

  const content = payload?.choices?.[0]?.message?.content || "{}";
  let parsed: any = {};
  try { parsed = JSON.parse(content); } catch {
    // Defensive: strip code fences if the model wrapped the JSON.
    try { parsed = JSON.parse(String(content).replace(/```json|```/g, "").trim()); } catch { parsed = {}; }
  }

  const reply = typeof parsed.reply === "string" && parsed.reply.trim()
    ? parsed.reply.trim()
    : "Tell me about the client's health conditions and medications and I'll find the best carrier for approval.";
  const allowed = new Set(CONDITIONS);
  const conditions = Array.isArray(parsed.conditions)
    ? parsed.conditions.filter((c: unknown) => typeof c === "string" && allowed.has(c))
    : [];

  return json({ ok: true, reply, conditions });
});
