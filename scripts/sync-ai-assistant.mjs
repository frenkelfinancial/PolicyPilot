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
// …and PATCHes them, along with the latency settings pinned in the Mission
// Control settings table, onto /v2/ai/assistants/{id}.
//
// Usage:  node scripts/sync-ai-assistant.mjs [--dry-run]
//
// Reads TELNYX_API_KEY (and optionally TELNYX_AI_ASSISTANT_ID) from the
// environment or .env.local. With no assistant id set it resolves the account's
// only assistant, and refuses to guess if there is more than one. Prints no
// secret values.

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

const id = await resolveAssistantId(KEY);
const before = await telnyx(KEY, 'GET', `/ai/assistants/${id}`);
const prev = before?.data || before;

const patch = { instructions, greeting, ...TUNING };

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
  if (bad.length) {
    console.error(`\nVERIFY FAILED — Telnyx did not store: ${bad.join(', ')}`);
    process.exitCode = 3;
  } else {
    console.log('verified: instructions, greeting, model, voice, endpointing and interruption all stored.');
  }
}
