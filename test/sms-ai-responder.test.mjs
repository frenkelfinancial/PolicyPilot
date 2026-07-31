// ============================================================
// sms-ai-responder.test.mjs — run with:  npm run test:smsai
//
// The browser half of the AI texting agent, and the structural rules that only
// exist in the edge functions and the migration. The decision logic itself is
// tested without any of this in _shared/sms-ai-core.test.ts.
//
//   1. PARITY. `// <smsai-core>` in app.html vs _shared/sms-ai-core.ts. The
//      editor has to refuse the same pair the server would drop and show the
//      same cap, or it displays a row that silently never fires.
//   2. STRUCTURE. What the functions and the schema actually contain — the
//      gate that must not be skipped, the STOP obligations, the fact that the
//      nudge sweeper is its own worker.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as SRV from '../supabase/functions/_shared/sms-ai-core.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').split('\r\n').join('\n');

const APP = read('app.html');
const MIG = read('supabase/migrations/20260806_sms_ai_responder.sql');
const RESPOND = read('supabase/functions/sms-ai-respond/index.ts');
const SWEEP = read('supabase/functions/sms-ai-nudge-sweep/index.ts');
const INBOUND = read('supabase/functions/messaging-inbound-webhook/index.ts');
const SENDSMS = read('supabase/functions/messaging-send-sms/index.ts');
const TIMEOUT = read('supabase/functions/messaging-timeout-sweep/index.ts');
const MANAGE = read('supabase/functions/sms-ai-manage/index.ts');

const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');

const EXPORTS = [
  'SMS_AI_TYPES', 'SMS_AI_TYPE_LABELS', 'SMS_AI_TONES', 'SMS_AI_LENGTHS', 'SMS_AI_MAX_PAIRS',
  'smsaiDefaults', 'smsaiNormalizePairs', 'smsaiNormalize', 'smsaiNudgeSteps', 'smsaiNudgePhrase',
];
function loadCore() {
  const m = APP.match(/\/\/ <smsai-core>([\s\S]*?)\/\/ <\/smsai-core>/);
  assert.ok(m, 'app.html must contain the // <smsai-core> … // </smsai-core> block');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${EXPORTS.join(',')}};`)();
}
const B = loadCore();

// ============================================================
// 1. PARITY
// ============================================================

test('the sentinel appears exactly once and the block is pure', () => {
  assert.equal((APP.match(/\/\/ <smsai-core>/g) || []).length, 1);
  assert.equal((APP.match(/\/\/ <\/smsai-core>/g) || []).length, 1);
  const src = stripComments(APP.match(/\/\/ <smsai-core>([\s\S]*?)\/\/ <\/smsai-core>/)[1]);
  for (const bad of [/\bdocument\./, /(^|[^.\w])window\./, /localStorage/, /\bsb\./, /\bfetch\(/]) {
    assert.ok(!bad.test(src), `smsai-core must not contain ${bad}`);
  }
});

test('🔴 the twelve types and their labels are identical on both sides', () => {
  assert.deepEqual([...B.SMS_AI_TYPES], [...SRV.SMS_AI_TYPES]);
  assert.equal(B.SMS_AI_TYPES.length, 13, 'twelve campaign types plus default');
  for (const t of SRV.SMS_AI_TYPES) {
    assert.equal(B.SMS_AI_TYPE_LABELS[t], SRV.SMS_AI_TYPE_LABELS[t], `label for ${t}`);
  }
});

test('the option lists and the cap agree', () => {
  assert.deepEqual([...B.SMS_AI_TONES], [...SRV.SMS_AI_TONES]);
  assert.deepEqual([...B.SMS_AI_LENGTHS], [...SRV.SMS_AI_LENGTHS]);
  assert.equal(B.SMS_AI_MAX_PAIRS, SRV.SMS_AI_MAX_PAIRS);
});

test('the defaults are identical — zero setup means the same thing everywhere', () => {
  for (const t of ['default', 'veteran_lead']) {
    assert.deepEqual(B.smsaiDefaults(t), SRV.defaultSmsAiSettings(t));
  }
});

test('🔴 the editor drops exactly the pairs the server drops', () => {
  const cases = [
    [],
    [{ trigger: 'price', answer: 'x' }],
    [{ trigger: '', answer: 'would match everything' }],
    [{ trigger: '   ', answer: 'so would this' }],
    [{ trigger: 'price', answer: '' }],
    [{ trigger: '  spaced  ', answer: '  padded  ' }],
    Array.from({ length: 30 }, (_, i) => ({ trigger: `t${i}`, answer: `a${i}` })),
    [{ trigger: 'x'.repeat(200), answer: 'y'.repeat(900) }],
    null,
    undefined,
  ];
  for (const c of cases) {
    assert.deepEqual(B.smsaiNormalizePairs(c), SRV.normalizePairs(c), JSON.stringify(c)?.slice(0, 60));
  }
});

test('a whole settings row normalizes identically', () => {
  const rows = [
    null,
    {},
    { tone: 'shouty', reply_length: 'epic', appointment_minutes: 9999, custom_pairs: 'nope' },
    { enabled: false, tone: 'casual', reply_length: 'medium', emojis: true, appointment_minutes: 45,
      appointment_label: 'Policy Review', nudge_8h: false, nudge_24h: false, nudge_48h: true, nudge_7d: true,
      custom_pairs: [{ trigger: 'price', answer: 'x' }, { trigger: '', answer: 'drop me' }] },
    { appointment_minutes: 1 },
    { appointment_minutes: '60' },
    { appointment_label: '   ' },
  ];
  for (const r of rows) {
    const b = B.smsaiNormalize(r);
    const s = SRV.normalizeSmsAiSettings(r);
    assert.deepEqual(b, s, JSON.stringify(r)?.slice(0, 80));
  }
});

test('🔴 a step that is off is skipped on both sides, not a stop', () => {
  const combos = [];
  for (let i = 0; i < 16; i++) {
    combos.push({
      ...SRV.defaultSmsAiSettings(),
      nudge_8h: !!(i & 1), nudge_24h: !!(i & 2), nudge_48h: !!(i & 4), nudge_7d: !!(i & 8),
    });
  }
  for (const s of combos) {
    assert.deepEqual(B.smsaiNudgeSteps(s), SRV.nudgeStepsFor(s), JSON.stringify(s).slice(0, 60));
  }
  // The one that mattered: 8h off, 24h on.
  assert.deepEqual(B.smsaiNudgeSteps({ nudge_8h: false, nudge_24h: true, nudge_48h: false, nudge_7d: false }), [2]);
});

test('the screen says plainly when it will never chase', () => {
  const off = { nudge_8h: false, nudge_24h: false, nudge_48h: false, nudge_7d: false };
  assert.match(B.smsaiNudgePhrase(off), /never chases/);
  assert.match(B.smsaiNudgePhrase({ ...off, nudge_8h: true }), /once, after 8 hours/);
  assert.match(B.smsaiNudgePhrase({ nudge_8h: true, nudge_24h: true, nudge_48h: false, nudge_7d: false }),
    /after 8 hours and 24 hours/);
});

// ============================================================
// 2. THE RESPONDER
// ============================================================

test('🔴 the responder is service-role only — a browser cannot reach it', () => {
  assert.match(RESPOND, /auth !== SERVICE_KEY\) return json\(\{ error: "forbidden" \}, 403, CORS\)/);
  // Not listed in config.toml, so it stays verify_jwt = true. The service key
  // is itself a valid Supabase JWT — the same arrangement voice-campaign-tick
  // uses to call ai-call-start.
  const cfg = read('supabase/config.toml');
  assert.ok(!/\[functions\.sms-ai-respond\]/.test(cfg),
    'sms-ai-respond must NOT be pinned verify_jwt = false');
});

test('🔴 the send gate still runs — the AI gate is not a replacement', () => {
  assert.match(RESPOND, /runComplianceGate\(sb, agentId, "sms", conv\.contact_phone\)/);
  assert.match(RESPOND, /resolveTextingNumber\(/);
  assert.match(RESPOND, /sendMessageCore\(/);
  // And billing is not reimplemented: no wallet call of its own.
  const code = stripComments(RESPOND);
  assert.ok(!/wallet_hold|wallet_settle|wallet_void|balance_mills/.test(code),
    'the responder must not touch the wallet — sendMessageCore does that');
});

test('🔴 an unambiguous custom-pair hit skips the model entirely', () => {
  const code = stripComments(RESPOND);
  const at = code.indexOf('const pair = matchCustomPair(');
  assert.ok(at > 0);
  const after = code.slice(at, at + 900);
  assert.match(after, /if \(pair\.reason === "hit" && pair\.answer\) \{\s*\n\s*replyText = pair\.answer;/);
  // The model branch is the ELSE, so a hit cannot fall through into it.
  assert.match(after, /\} else \{\s*\n\s*usedModel = true;/);
});

test('the booking reuses the voice machinery rather than reimplementing time', () => {
  assert.match(RESPOND, /import \{ parseAppointmentTime, buildConfirmSms \} from "\.\.\/_shared\/ai-appointment\.ts"/);
  assert.match(RESPOND, /parseAppointmentTime\(bookingText, leadTz, new Date\(\)\)/);
  assert.match(RESPOND, /from\("ai_appointments"\)/);
  assert.match(RESPOND, /source: "ai_text"/);
  // Never null on success or failure — the same rule the voice path keeps.
  assert.match(RESPOND, /sms_confirm_status: c\.ok \? "sent" : `failed:\$\{c\.error\}`/);
  const code = stripComments(RESPOND);
  assert.ok(!/new Date\(.*datetime/.test(code), 'the model must not supply a parsed instant');
});

test('the hot alert throttle is stamped only on an actual send', () => {
  // A failed alert must not consume the four-hour window.
  assert.match(RESPOND, /hotAlertAllowed\(conv\.hot_alerted_at, new Date\(\)\)/);
  const at = RESPOND.indexOf('if (alerted) {');
  assert.ok(at > 0, 'hot_alerted_at is written inside an `if (alerted)`');
  assert.match(RESPOND.slice(at, at + 260), /hot_alerted_at: new Date\(\)\.toISOString\(\)/);
});

test('a model failure hands the thread over instead of guessing', () => {
  const at = RESPOND.indexOf('[sms-ai-respond] model call failed');
  assert.ok(at > 0);
  const block = RESPOND.slice(at, at + 700);
  assert.match(block, /hot: true/);
  assert.match(block, /replied: false, refusal: "model_error"/);
});

// ============================================================
// 3. THE STOP PATH — the two obligations that were missing
// ============================================================

test('🔴 a STOP now closes the conversation AND cancels scheduled sends', () => {
  // Before this round the path did two of the four: it suppressed (dnc_list,
  // including the global fallback) and it confirmed from the originating
  // number. It closed no conversation and cancelled nothing, because neither
  // existed.
  assert.match(INBOUND, /closeConversationForOptOut\(sb, conversationId\)/);
  const helper = read('supabase/functions/_shared/sms-thread.ts');
  const at = helper.indexOf('export async function closeConversationForOptOut');
  const body = helper.slice(at, at + 900);
  assert.match(body, /cancelNudges\(sb, conversationId, "opted_out"\)/);
  assert.match(body, /status: "closed"/);
  assert.match(body, /ai_muted: true/);
});

test('🔴 the suppression still happens FIRST, and is untouched', () => {
  const code = stripComments(INBOUND);
  const dncAt = code.indexOf('from("dnc_list").insert');
  // The CALL, not the import at the top of the file.
  const closeAt = code.indexOf('closeConversationForOptOut(sb, conversationId)');
  assert.ok(dncAt > 0 && closeAt > dncAt,
    'if the close throws, the legally-required suppression has already happened');
  // The global fallback for an unattributable STOP is still there.
  assert.match(INBOUND, /agent_id:\s+agentId, \/\/ null => global entry/);
});

test('the AI is never dispatched for an opt-out', () => {
  assert.match(INBOUND, /if \(!isOptOut && conversationId && agentId && text\)/);
});

test('the dispatch is fire-and-forget so Telnyx still gets a fast 200', () => {
  const at = INBOUND.indexOf('const url = `${SUPABASE_URL}/functions/v1/sms-ai-respond`');
  assert.ok(at > 0);
  const block = INBOUND.slice(at, at + 700);
  assert.ok(!/await fetch\(url/.test(block), 'the responder call must not be awaited');
  assert.match(block, /\.catch\(/);
  assert.match(block, /Authorization": `Bearer \$\{SERVICE_KEY\}`/);
});

test('any inbound at all cancels a pending follow-up, including a STOP', () => {
  assert.match(INBOUND, /cancelNudges\(sb, conversationId, isOptOut \? "opted_out" : "lead_replied"\)/);
});

test('one definition of what an opt-out keyword is', () => {
  assert.match(INBOUND, /import \{ isOptOutKeyword \} from "\.\.\/_shared\/sms-ai-core\.ts"/);
  assert.match(INBOUND, /const isOptOut = isOptOutKeyword\(text\);/);
  assert.ok(!/OPT_OUT_KEYWORDS = new Set/.test(INBOUND), 'the local copy is gone');
});

// ============================================================
// 4. THE NUDGE WORKER
// ============================================================

test('🔴 the nudge sweeper is its OWN worker, not bolted onto the wallet one', () => {
  // messaging-timeout-sweep is a wallet-hold voider: it finds messages whose
  // hold never got a DLR and calls wallet_void. It reads no conversation and
  // sends nothing. Extending it would put outbound messaging inside a billing
  // reconciler.
  assert.match(TIMEOUT, /wallet_void/);
  assert.ok(!/sms_nudges|sms_conversations|sendMessageCore/.test(TIMEOUT),
    'messaging-timeout-sweep must stay a pure wallet reconciler');
  assert.match(SWEEP, /from\("sms_nudges"\)/);
  assert.ok(!/wallet_void/.test(stripComments(SWEEP)),
    'the nudge sweeper must not touch wallet holds');
});

test('🔴 a nudge outside the window is deferred, never dropped', () => {
  assert.match(SWEEP, /if \(!nudgeAllowedAt\(now, tz\)\) \{[\s\S]{0,220}deferNudge\(now, tz\)/);
  // Even the LEGAL gate's quiet-hours refusal is a deferral here.
  assert.match(SWEEP, /if \(gate\.reason === "quiet_hours"\) \{[\s\S]{0,240}deferNudge\(/);
});

test('every cancellation reason is re-checked at send time', () => {
  for (const re of [
    /status === "closed"[\s\S]{0,120}"conversation_closed"/,
    /conv\.ai_muted[\s\S]{0,80}"ai_muted"/,
    /"on_dnc"/,
    /"lead_replied"/,
    /"booked"/,
  ]) assert.match(SWEEP, re);
});

test('a nudge carries no tools — it cannot book or alert', () => {
  const at = SWEEP.indexOf('const r = await chat(');
  assert.ok(at > 0);
  assert.ok(!/tools:/.test(SWEEP.slice(at, at + 300)), 'no tools on an unsolicited follow-up');
});

test('a nudge still goes through the ordinary gate and biller', () => {
  assert.match(SWEEP, /runComplianceGate\(sb, conv\.agent_id, "sms", conv\.contact_phone\)/);
  assert.match(SWEEP, /sendMessageCore\(/);
});

test('the sweeper needs a cron secret', () => {
  assert.match(SWEEP, /SMS_AI_CRON_SECRET/);
  assert.match(SWEEP, /authHeader !== `Bearer \$\{CRON_SECRET\}`/);
});

// ============================================================
// 5. TAKEOVER
// ============================================================

test('🔴 a person typing mutes the AI on that thread', () => {
  assert.match(SENDSMS, /autoMuteIfAgentWrote\(sb, conversationId, "agent"\)/);
  assert.match(SENDSMS, /sentBy: "agent"/);
  // ...and stops the robot follow-ups too.
  assert.match(SENDSMS, /cancelNudges\(sb, conversationId, "ai_muted"\)/);
});

test('the thread write cannot fail the send that already happened', () => {
  const at = SENDSMS.indexOf('let conversationId: string | null = null;');
  assert.ok(at > 0);
  const block = SENDSMS.slice(at, at + 900);
  assert.match(block, /try \{/);
  assert.match(block, /catch \(e\)/);
  // It sits after the send result is known to be ok.
  assert.ok(SENDSMS.indexOf('if (!result.ok) return json(') < at);
});

test('🔴 the toggle goes through an edge function, not a PATCH', () => {
  assert.match(APP, /invoke\('sms-ai-manage'/);
  // sms_conversations is SELECT-only; nothing in the browser may write it.
  const code = stripComments(APP);
  for (const verb of ['insert', 'update', 'upsert', 'delete']) {
    const re = new RegExp(`from\\('sms_(conversations|messages|nudges)'\\)[\\s\\S]{0,120}\\.${verb}\\(`);
    assert.ok(!re.test(code), `app.html must never .${verb}() an sms_ conversation table`);
  }
});

test('turning the AI back on cannot reopen a conversation an opt-out closed', () => {
  assert.match(MANAGE, /if \(conv\.status === "closed"\) \{[\s\S]{0,200}conversation_closed/);
});

test('resuming re-arms the follow-up schedule that muting cancelled', () => {
  assert.match(MANAGE, /scheduleNextNudge\(sb, \{/);
});

// ============================================================
// 6. SCHEMA
// ============================================================

test('🔴 no write policy on conversations, messages or nudges', () => {
  const policies = [...MIG.matchAll(/create policy "([a-z_]+)"\s*\n\s*on public\.([a-z_]+) for (\w+)/g)];
  assert.ok(policies.length >= 4);
  for (const [, name, table, cmd] of policies) {
    if (table === 'sms_ai_settings') continue; // owner-writable, see the table note
    assert.equal(cmd, 'select', `${name} on ${table} must be SELECT-only`);
  }
});

test('the settings table IS owner-writable, and derives its agent_id', () => {
  assert.match(MIG, /create policy "sms_ai_settings_insert_own"/);
  assert.match(MIG, /create policy "sms_ai_settings_update_own"/);
  // Derived by trigger, never accepted from the client.
  assert.match(MIG, /new\.agent_id := auth\.uid\(\);/);
});

test('one live nudge per conversation, enforced by the index not the caller', () => {
  assert.match(MIG, /create unique index if not exists sms_nudges_one_scheduled_uidx\s*\n\s*on public\.sms_nudges \(conversation_id\) where status = 'scheduled'/);
});

test('one thread per contact per agent', () => {
  assert.match(MIG, /create unique index if not exists sms_conversations_agent_contact_uidx\s*\n\s*on public\.sms_conversations \(agent_id, contact_phone\)/);
});

test('sent_by is constrained to the four kinds', () => {
  assert.match(MIG, /sent_by\s+text not null check \(sent_by in \('ai', 'agent', 'system', 'lead'\)\)/);
});

test('the 20-pair cap is in the database too, because the table is owner-writable', () => {
  assert.match(MIG, /jsonb_array_length\(custom_pairs\) <= 20/);
});

test('the account switch defaults ON, beside the voice one', () => {
  assert.match(MIG, /add column if not exists sms_ai_enabled boolean not null default true/);
});

test('a text booking lands in the SAME appointments table as a call', () => {
  assert.match(MIG, /alter table public\.ai_appointments\s*\n\s*add column if not exists sms_conversation_id uuid/);
  // No second appointments table anywhere in the migration.
  assert.ok(!/create table if not exists public\.sms_appointments/.test(MIG));
});

test('the legacy messaging tables are not replaced', () => {
  assert.ok(!/drop table[\s\S]{0,40}(messages|inbound_messages)/.test(MIG));
  assert.match(MIG, /message_id\s+uuid references public\.messages\(id\)/);
  assert.match(MIG, /inbound_message_id uuid references public\.inbound_messages\(id\)/);
});
