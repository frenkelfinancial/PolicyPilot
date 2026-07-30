#!/usr/bin/env node
// sync-ai-assistant.mjs — push docs/ai-assistant-script-v1.md to the live
// Telnyx AI Assistant.
//
// THE DOC IS THE SOURCE OF TRUTH. The assistant's instructions used to live
// only in Mission Control, with the doc as a copy someone was supposed to keep
// in step by hand. That is how you end up unable to say which prompt a
// transcript came from — and this prompt carries a TCPA disclosure, so "which
// version was live on the 14th" is a question that can actually get asked.
//
// This script extracts, verbatim:
//   • the fenced block under "## System instructions"   -> instructions
//   • the ```greeting block under "Stored fallback greeting" -> greeting
//   • the ```insight-schema block under "Structured insights" -> the custom
//     insight's json_schema
// …and PATCHes them, along with the latency settings pinned in the Mission
// Control settings table, onto /v2/ai/assistants/{id}.
//
// It ALSO owns the Phase 2 wiring, because all three parts have to agree and
// none of them is worth hand-keying into a console:
//   • the two webhook TOOLS (transfer_to_agent, book_appointment) that point
//     at the ai-call-tools edge function;
//   • the custom structured INSIGHT (json_schema) that makes Telnyx return
//     JSON instead of the prose paragraph which made every completed call
//     land outcome='error';
//   • a dedicated INSIGHT GROUP holding that insight plus the stock Summary
//     one, so the account-wide "Default" group is left exactly as it was.
//
// Usage:  node scripts/sync-ai-assistant.mjs [--dry-run] [--skip-tools]
//
// Reads TELNYX_API_KEY, SUPABASE_URL and AI_TOOLS_SECRET (and optionally
// TELNYX_AI_ASSISTANT_ID) from the environment or .env.local. With no
// assistant id set it resolves the account's only assistant, and refuses to
// guess if there is more than one. Prints no secret values — the tool URLs it
// reports are redacted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC  = path.join(ROOT, 'docs', 'ai-assistant-script-v1.md');
const DRY  = process.argv.includes('--dry-run');

// ---- Latency / turn-taking settings -----------------------------------------
// Mirrors the "Mission Control settings" table in the doc. Every value here is
// justified there; change both together.
const TUNING = {
  model: 'anthropic/claude-haiku-4-5',
  // The assistant's OWN voice. Normally overridden per call from
  // agents.ai_voice, but it is what rung 3 of startAssistant()'s degrade ladder
  // speaks with, so it should not be left on whatever was last poked in by
  // hand. Same value as AI_VOICE_DEFAULT in app.html.
  voice_settings: { voice: 'Telnyx.Ultra.2747b6cf-fa34-460c-97db-267566918881' },
  transcription: {
    model: 'deepgram/flux',
    language: 'en',
    settings: {
      eot_threshold: 0.7,        // was 0.8 — 0.7 is Deepgram's default
      eot_timeout_ms: 2500,      // was 5000 — worst-case reply gap, halved
      eager_eot_threshold: 0.55, // was 0.8 — equal to eot_threshold did nothing
    },
  },
  interruption_settings: {
    enable: true,                // barge-in: stop talking when talked over
    disable_greeting_interruption: false,
    interrupt_prediction_threshold: 0, // 0 = gating off = most permissive
    start_speaking_plan: {
      wait_seconds: 0.1,
      transcription_endpointing_plan: {
        on_punctuation_seconds: 0.1,
        on_no_punctuation_seconds: 0.1,
        on_number_seconds: 0.1,
      },
    },
  },
};

// ---- Phase 2: webhook tools + the structured insight -----------------------

const INSIGHT_NAME = 'PolicyPilot Call Outcome';
const INSIGHT_GROUP_NAME = 'PolicyPilot AI Sales Agent';

// What the insight is asked to produce. The SCHEMA lives in the doc (see
// extractInsightSchema); this is the prose that goes with it.
const INSIGHT_INSTRUCTIONS = [
  'You are reading a completed outbound life-insurance qualification call made by an AI assistant',
  'on behalf of a licensed agent. Return ONLY the JSON object described by the schema.',
  '',
  'outcome:',
  '  "transferred"        — the caller was connected to the human agent live.',
  '  "appointment_booked" — a specific callback time was agreed and booked.',
  '  "qualified"          — interested and the basics were gathered, but neither of the above.',
  '  "callback_requested" — wants a call back but named no specific time.',
  '  "not_interested"     — declined coverage and did NOT ask to be removed.',
  '  "dnc_request"        — asked to stop calling, be removed, or not be contacted again.',
  '                         If there is any doubt between this and not_interested, choose this.',
  '  "voicemail"          — an answering machine picked up.',
  '  "no_answer"          — no meaningful conversation took place.',
  '',
  'age: their age or age range, as discussed. coverage_interest: final expense, term, or',
  'mortgage protection. budget_text: the monthly budget in their own words.',
  'best_callback_text: when they said they could be reached. notes: anything the agent should',
  'know before calling — who the cover is for, health, urgency.',
  'summary: one or two sentences STARTING WITH THE PERSON\'S NAME, then the key facts and the',
  'next step.',
  '',
  'Use an empty string for anything that was not discussed. Never invent a fact, a budget or a',
  'time that was not said out loud.',
].join('\n');

/**
 * The two webhook tools.
 *
 * `url` carries the shared secret plus the two dynamic variables Telnyx merges
 * into EVERY assistant call automatically — telnyx_call_to and
 * telnyx_call_from. That pair is the whole of tool identity, on purpose: it
 * costs the ai_assistant_start hot path nothing.
 *
 * There is deliberately no `{{ai_call_id}}` here. It was tried, and delivering
 * it meant putting `assistant.dynamic_variables` on the greeting's critical
 * path; the first live call after that came back 503 and the lead heard
 * silence. The handler still reads an `ai_call_id` if one ever arrives, so
 * nothing has to change here if that becomes deliverable for free later.
 */
function buildTools(supabaseUrl, secret) {
  const base = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/ai-call-tools`;
  const url = (tool) =>
    `${base}?k=${encodeURIComponent(secret)}&tool=${tool}` +
    `&telnyx_call_to={{telnyx_call_to}}&telnyx_call_from={{telnyx_call_from}}`;

  const qualificationProps = {
    age:                { type: 'string', description: "The caller's age or age range as discussed, e.g. '58' or '50-59'. Empty if not discussed." },
    coverage_interest:  { type: 'string', description: "What coverage they want: 'final expense', 'term', or 'mortgage protection'. Empty if unclear." },
    budget_text:        { type: 'string', description: "Their monthly budget in their own words, e.g. 'about $85 a month'. Empty if not discussed." },
    best_callback_text: { type: 'string', description: 'When they said they can be reached. Empty if not discussed.' },
    notes:              { type: 'string', description: 'Anything the agent should know before calling — who it is for, health, urgency.' },
  };

  return [
    {
      type: 'webhook',
      webhook: {
        name: 'transfer_to_agent',
        description:
          'Connect the caller LIVE to the licensed agent. Call this as soon as the caller is ' +
          'interested and you have the basics. It answers "ringing" (the agent\'s phone is ringing — ' +
          'tell the caller to hold and stay with them) or "unavailable" (book an appointment instead). ' +
          'Never call it twice on one call.',
        url: url('transfer_to_agent'),
        method: 'POST',
        body_parameters: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: {
              type: 'string',
              description:
                'Twenty-five words or fewer, written to be SPOKEN ALOUD to the agent as a whisper ' +
                'before they take the call: name, rough age, what coverage they want, budget, and the ' +
                'one detail that matters most. No JSON, no labels, no punctuation the ear cannot hear.',
            },
            ...qualificationProps,
          },
        },
      },
    },
    {
      type: 'webhook',
      webhook: {
        name: 'book_appointment',
        description:
          'Book a specific time for the agent to call the caller back. Use this when the agent could ' +
          'not take the call live. It answers "booked" (say the time back to the caller and wrap up) ' +
          'or "needs_confirmation" (it tells you what was wrong — ask again and call it again).',
        url: url('book_appointment'),
        method: 'POST',
        body_parameters: {
          type: 'object',
          required: ['datetime_text'],
          properties: {
            datetime_text: {
              type: 'string',
              description:
                'EXACTLY what the caller said, verbatim — "Tuesday at two", "tomorrow after five", ' +
                '"the 5th at 10 in the morning". Do NOT convert it to a date, do not add a year, and ' +
                'do not guess: it is resolved in the caller\'s own timezone on our side.',
            },
            notes: { type: 'string', description: 'Anything the agent should know before that call.' },
            ...qualificationProps,
          },
        },
      },
    },
  ];
}

// ---- .env.local ------------------------------------------------------------
function loadEnvLocal() {
  const p = path.join(ROOT, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---- Doc extraction --------------------------------------------------------
// Anchored on the headings so a fence added elsewhere in the doc cannot be
// picked up by accident.
function extractInstructions(md) {
  const i = md.indexOf('## System instructions');
  if (i < 0) throw new Error('docs: no "## System instructions" heading');
  const open = md.indexOf('\n```\n', i);
  if (open < 0) throw new Error('docs: no fenced block under "## System instructions"');
  const start = open + 5;
  const close = md.indexOf('\n```', start);
  if (close < 0) throw new Error('docs: unterminated fenced block under "## System instructions"');
  return md.slice(start, close).trim();
}

function extractGreeting(md) {
  const i = md.indexOf('### Stored fallback greeting');
  if (i < 0) throw new Error('docs: no "### Stored fallback greeting" heading');
  const open = md.indexOf('\n```greeting\n', i);
  if (open < 0) throw new Error('docs: no ```greeting block under "Stored fallback greeting"');
  const start = open + '\n```greeting\n'.length;
  const close = md.indexOf('\n```', start);
  if (close < 0) throw new Error('docs: unterminated ```greeting block');
  return md.slice(start, close).trim();
}

// The structured insight's json_schema. Tagged fence (```insight-schema) so
// extractInstructions', which matches a PLAIN '\n```\n', can never pick it up.
function extractInsightSchema(md) {
  const open = md.indexOf('\n```insight-schema\n');
  if (open < 0) throw new Error('docs: no ```insight-schema block');
  const start = open + '\n```insight-schema\n'.length;
  const close = md.indexOf('\n```', start);
  if (close < 0) throw new Error('docs: unterminated ```insight-schema block');
  const raw = md.slice(start, close).trim();
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`docs: the insight-schema block is not valid JSON — ${e.message}`); }
}

// ---- Telnyx ----------------------------------------------------------------
async function telnyx(key, method, url, body) {
  const res = await fetch(`https://api.telnyx.com/v2${url}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  if (!res.ok) throw new Error(`Telnyx ${method} ${url} -> ${res.status}: ${text.slice(0, 600)}`);
  return json;
}

/** A tool URL with the shared secret blanked, safe to print. */
function redactUrl(u) {
  return String(u).replace(/([?&]k=)[^&]*/, '$1<redacted>');
}

/**
 * Create-or-update the structured insight, and put it in its own group with
 * the stock Summary insight alongside.
 *
 * The account-wide "Default" group is deliberately LEFT ALONE: it is what any
 * future assistant on this account inherits, and quietly adding a
 * life-insurance qualification schema to it would apply this feature's rules
 * to somebody else's calls.
 *
 * Returns { insightId, groupId }.
 */
async function syncInsights(key, schema) {
  const insights = (await telnyx(key, 'GET', '/ai/conversations/insights'))?.data || [];
  const summary = insights.find((i) => i.name === 'Summary' && i.insight_type === 'default');
  const existing = insights.find((i) => i.name === INSIGHT_NAME);

  const payload = { name: INSIGHT_NAME, instructions: INSIGHT_INSTRUCTIONS, json_schema: schema };

  let insight;
  if (existing) {
    insight = (await telnyx(key, 'PUT', `/ai/conversations/insights/${existing.id}`, payload))?.data;
    insight = insight || { ...existing, ...payload };
    console.log(`insight        : updated "${INSIGHT_NAME}" (${existing.id})`);
  } else {
    insight = (await telnyx(key, 'POST', '/ai/conversations/insights', payload))?.data;
    console.log(`insight        : created "${INSIGHT_NAME}" (${insight?.id})`);
  }
  const insightId = insight?.id || existing?.id;
  if (!insightId) throw new Error('Telnyx returned no insight id.');

  // Keep the stock Summary insight in the group: its paragraph is a genuinely
  // good ai_calls.summary, and it is the fallback the parser reads when the
  // structured one comes back empty.
  const insightIds = [insightId, ...(summary ? [summary.id] : [])];

  const groups = (await telnyx(key, 'GET', '/ai/conversations/insight-groups'))?.data || [];
  const existingGroup = groups.find((g) => g.name === INSIGHT_GROUP_NAME);
  // MEMBERSHIP IS NOT A FIELD ON THE GROUP. Passing `insight_ids` here creates
  // the group and silently drops the list — Telnyx ignores fields it does not
  // recognise, which is exactly what the read-back below exists to catch (it
  // did, first run: "group holds: nothing"). Membership is set through the
  // dedicated .../insights/{id}/assign endpoint instead.
  const groupPayload = {
    name: INSIGHT_GROUP_NAME,
    description: 'Insights for the PolicyPilot AI Sales Agent. Structured outcome + stock summary.',
  };

  let group;
  if (existingGroup) {
    group = (await telnyx(key, 'PUT', `/ai/conversations/insight-groups/${existingGroup.id}`, groupPayload))?.data;
    group = group || existingGroup;
    console.log(`insight group  : updated "${INSIGHT_GROUP_NAME}" (${existingGroup.id})`);
  } else {
    group = (await telnyx(key, 'POST', '/ai/conversations/insight-groups', groupPayload))?.data;
    console.log(`insight group  : created "${INSIGHT_GROUP_NAME}" (${group?.id})`);
  }
  const groupId = group?.id || existingGroup?.id;
  if (!groupId) throw new Error('Telnyx returned no insight group id.');

  // Assign what is missing; leave anything already there alone. Additive on
  // purpose — this script owns which insights it needs, not which insights
  // somebody else may have added to this group.
  const current = (await telnyx(key, 'GET', `/ai/conversations/insight-groups/${groupId}`))?.data;
  const have = new Set((current?.insights || []).map((i) => i.id));
  for (const iid of insightIds) {
    if (have.has(iid)) continue;
    await telnyx(key, 'POST', `/ai/conversations/insight-groups/${groupId}/insights/${iid}/assign`);
    console.log(`               : assigned insight ${iid}`);
  }

  // Read back. A 200 on an assign is not proof of membership either.
  const check = (await telnyx(key, 'GET', `/ai/conversations/insight-groups/${groupId}`))?.data;
  const members = (check?.insights || []).map((i) => i.id);
  if (!members.includes(insightId)) {
    throw new Error(
      `insight ${insightId} is NOT in group ${groupId} after the write (group holds: ${members.join(', ') || 'nothing'}).`,
    );
  }
  console.log(`               : group holds ${members.length} insight(s)`);
  return { insightId, groupId };
}

async function resolveAssistantId(key) {
  if (process.env.TELNYX_AI_ASSISTANT_ID) return process.env.TELNYX_AI_ASSISTANT_ID;
  const list = (await telnyx(key, 'GET', '/ai/assistants'))?.data || [];
  if (list.length === 1) return list[0].id;
  throw new Error(
    `TELNYX_AI_ASSISTANT_ID is not set and the account has ${list.length} assistants ` +
    `(${list.map((a) => `${a.id} "${a.name}"`).join(', ')}). Set the env var and re-run.`,
  );
}

// ---- main ------------------------------------------------------------------
loadEnvLocal();
const KEY = process.env.TELNYX_API_KEY;
if (!KEY) {
  console.error('TELNYX_API_KEY is not set (env or .env.local).');
  process.exit(1);
}

const md = fs.readFileSync(DOC, 'utf8');
const instructions = extractInstructions(md);
const greeting = extractGreeting(md);
const insightSchema = extractInsightSchema(md);

const SKIP_TOOLS = process.argv.includes('--skip-tools');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const TOOLS_SECRET = (process.env.AI_TOOLS_SECRET || '').trim();
const wantTools = !SKIP_TOOLS && !!SUPABASE_URL && !!TOOLS_SECRET;

if (!SKIP_TOOLS && !wantTools) {
  // Loud, because a silent skip here means the assistant keeps whatever tools
  // it had — which after the first run is the RIGHT ones with a stale secret,
  // and after a secret rotation is a transfer that 401s mid-call.
  console.error(
    'REFUSING: SUPABASE_URL and AI_TOOLS_SECRET must both be set (env or .env.local) to sync the\n' +
    '          webhook tools. Pass --skip-tools to push only the prompt and settings.\n' +
    `          SUPABASE_URL: ${SUPABASE_URL ? 'set' : 'MISSING'}   AI_TOOLS_SECRET: ${TOOLS_SECRET ? 'set' : 'MISSING'}`,
  );
  process.exit(1);
}

const id = await resolveAssistantId(KEY);
const before = await telnyx(KEY, 'GET', `/ai/assistants/${id}`);
const prev = before?.data || before;

const tools = wantTools ? buildTools(SUPABASE_URL, TOOLS_SECRET) : null;

const patch = { instructions, greeting, ...TUNING };
if (tools) patch.tools = tools;

console.log(`assistant      : ${id} ("${prev.name}")`);
console.log(`version before : ${prev.version_id}`);
console.log(`instructions   : ${prev.instructions?.length ?? 0} -> ${instructions.length} chars` +
  (prev.instructions === instructions ? '  (unchanged)' : '  (CHANGED)'));
console.log(`greeting       : ${prev.greeting === greeting ? 'unchanged' : 'CHANGED'}`);
console.log(`               : ${JSON.stringify(greeting)}`);
console.log(`model          : ${prev.model} -> ${TUNING.model}`);
console.log(`voice (default): ${prev.voice_settings?.voice} -> ${TUNING.voice_settings.voice}`);
console.log(`transcription  : ${JSON.stringify(prev.transcription?.settings ?? null)}`);
console.log(`               -> ${JSON.stringify(TUNING.transcription.settings)}`);
console.log(`interruption   : ${JSON.stringify(prev.interruption_settings ?? null)}`);
console.log(`               -> ${JSON.stringify(TUNING.interruption_settings)}`);
console.log(`tools          : ${(prev.tools || []).map((t) => t?.webhook?.name || t?.type).join(', ') || '(none)'}` +
  (tools ? ` -> ${tools.map((t) => t.webhook.name).join(', ')}` : '  (--skip-tools)'));
if (tools) {
  // Never print the secret. The shape is what matters when this is being read
  // back in a terminal at 1am.
  for (const t of tools) console.log(`               : ${t.webhook.name} -> ${redactUrl(t.webhook.url)}`);
}

// The disclosure clause is the whole point of pushing this file. Refuse to ship
// a prompt that lost it, and refuse to ship one that still carries the string
// retired on 2026-07-30 (that would mean someone edited the doc backwards).
if (!/an assistant calling on behalf of/i.test(instructions)) {
  console.error('\nREFUSING: the instructions no longer contain the disclosure clause ' +
    '"an assistant calling on behalf of".');
  process.exit(2);
}
if (!/automated assistant/i.test(instructions)) {
  console.error('\nREFUSING: the instructions no longer require answering "automated assistant" ' +
    'when asked whether this is a real person. That answer is the disclosure.');
  process.exit(2);
}
if (!/an assistant calling on behalf of/i.test(greeting)) {
  console.error('\nREFUSING: the stored fallback greeting lost the disclosure clause.');
  process.exit(2);
}

if (DRY) {
  console.log('\n--dry-run: nothing sent.');
} else {
  // Insights first: the assistant PATCH points at the group, so the group has
  // to exist before it is named.
  const { insightId, groupId } = await syncInsights(KEY, insightSchema);
  patch.insight_settings = { insight_group_id: groupId };

  const after = await telnyx(KEY, 'PATCH', `/ai/assistants/${id}`, patch);
  const now = after?.data || after;
  console.log(`\nPATCH ok. version after: ${now.version_id ?? '(not returned)'}`);

  // Read back rather than trusting the PATCH response — Telnyx SILENTLY IGNORES
  // fields it does not recognise, so "200 OK" is not proof anything was stored.
  // GET on a single assistant returns the object unwrapped; the list endpoint
  // wraps in .data. Handle both.
  const raw = await telnyx(KEY, 'GET', `/ai/assistants/${id}`);
  const verify = raw?.data || raw;
  const bad = [];
  if (verify.instructions !== instructions) bad.push('instructions');
  if (verify.greeting !== greeting) bad.push('greeting');
  if (verify.model !== TUNING.model) bad.push('model');
  if (verify.voice_settings?.voice !== TUNING.voice_settings.voice) bad.push('voice_settings.voice');
  for (const [k, v] of Object.entries(TUNING.transcription.settings)) {
    if (verify.transcription?.settings?.[k] !== v) bad.push(`transcription.settings.${k}`);
  }
  if (verify.interruption_settings?.enable !== true) bad.push('interruption_settings.enable');
  if (verify.insight_settings?.insight_group_id !== groupId) bad.push('insight_settings.insight_group_id');

  // The tools are the part most likely to be silently dropped — they are the
  // newest fields and the most deeply nested. Check that BOTH exist by name
  // and that each URL still carries its secret and its mustache variables; a
  // tool stored without `k=` 401s on the first live transfer, and one stored
  // without {{telnyx_call_to}} cannot identify the call it is on.
  if (tools) {
    const stored = verify.tools || [];
    for (const t of tools) {
      const got = stored.find((s) => s?.webhook?.name === t.webhook.name);
      if (!got) { bad.push(`tools.${t.webhook.name}`); continue; }
      if (got.webhook.url !== t.webhook.url) bad.push(`tools.${t.webhook.name}.url`);
      if (!/[?&]k=/.test(got.webhook.url || '')) bad.push(`tools.${t.webhook.name}.url (secret missing)`);
      if (!/\{\{telnyx_call_to\}\}/.test(got.webhook.url || '')) bad.push(`tools.${t.webhook.name}.url (telnyx_call_to missing)`);
      const props = got.webhook.body_parameters?.properties || {};
      for (const k of Object.keys(t.webhook.body_parameters.properties)) {
        if (!(k in props)) bad.push(`tools.${t.webhook.name}.body_parameters.${k}`);
      }
    }
  }

  if (bad.length) {
    console.error(`\nVERIFY FAILED — Telnyx did not store: ${bad.join(', ')}`);
    process.exitCode = 3;
  } else {
    console.log('verified: instructions, greeting, model, voice, endpointing, interruption, ' +
      'insight group and both webhook tools all stored.');
    console.log(`\nSet this secret so the webhook prefers the structured insight over the prose one:\n` +
      `  npx supabase secrets set TELNYX_OUTCOME_INSIGHT_ID=${insightId}`);
  }
}
