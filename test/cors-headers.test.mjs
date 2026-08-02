// ============================================================
// cors-headers.test.mjs — run with:  npm run test:cors
//
// ONE invariant, DERIVED, not hand-listed:
//
//   every custom request header the browser sends from app.html must appear
//   in Access-Control-Allow-Headers in supabase/functions/_shared/cors.ts.
//
// Why this test exists, in one paragraph: a custom header forces the browser
// to send a CORS preflight (OPTIONS) naming that header. If the reply does not
// list it, the browser blocks the request BEFORE SENDING IT. The fetch promise
// rejects with "Failed to fetch", the edge function is never invoked, and
// there is no server log, no error row and nothing to grep — the call is dead
// in every browser with no evidence anywhere on the server. `statement-upload`
// sends `x-filename-b64` and `x-content-type`, neither of which was on the
// list, so Back Office statement upload was blocked at the preflight from the
// day it shipped and no statement was ever ingested from a browser.
//
// The reason it drifted is that the allow-list and its callers were connected
// by nothing but memory. So this test does not restate the list — it EXTRACTS
// the callers' headers from app.html and checks them against the shipped
// string. A new custom header anywhere in the app fails here rather than in
// production.
//
// Scope of the extraction (deliberately over-inclusive, see the test below):
// every `headers: { ... }` object literal in app.html, keys only, filtered to
// /^x-/i. Matching every 'x-…' string in the file instead would sweep in icon
// names and CSS classes — `x-circle` is in there three times.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8');
const CORS = readFileSync(join(ROOT, 'supabase/functions/_shared/cors.ts'), 'utf8');

// ------------------------------------------------------------
// Extract the shipped allow-list from cors.ts as source text.
//
// Read as text rather than imported so the test is checking the file that
// deploys, and so it keeps working if the module ever grows a Deno-only
// import. `devOriginsEnabled()` already guards for a non-Deno runtime, but
// the value we care about is a literal and there is no reason to execute
// anything to read a literal.
// ------------------------------------------------------------
function shippedAllowHeaders() {
  const m = CORS.match(/ALLOW_HEADERS\s*=\s*(["'`])([^"'`]+)\1/);
  assert.ok(m, 'cors.ts must declare ALLOW_HEADERS as a single string literal');
  return m[2];
}

/** The allow-list as a lowercase Set, which is how a browser compares them. */
function allowedSet() {
  return new Set(shippedAllowHeaders().split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

// ------------------------------------------------------------
// Extract every custom header app.html sends.
//
// Walks each `headers:` occurrence and takes the balanced { … } that follows,
// then pulls the KEYS out of it. Keys appear in three shapes in this file —
// 'quoted', "quoted" and bare (Authorization, apikey) — so all three are
// matched. Values are ignored entirely: `'Authorization': 'Bearer ' + token`
// must not be read as a header called Bearer.
// ------------------------------------------------------------
function headerObjectLiterals(src) {
  const out = [];
  const re = /\bheaders\s*:\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > open, 'unbalanced headers object literal near index ' + m.index);
    out.push({ index: m.index, body: src.slice(open + 1, end) });
  }
  return out;
}

/** Header names used as KEYS inside one object literal body. */
function keysOf(body) {
  const keys = [];
  // 'x-foo': …   |   "x-foo": …   |   xFoo: …
  const re = /(?:^|[{,])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:/g;
  let m;
  while ((m = re.exec(body)) !== null) keys.push(m[1] || m[2] || m[3]);
  return keys;
}

/** Every custom (x-*) request header app.html sends, lowercased, deduped. */
function customHeadersSentByApp() {
  const found = new Map(); // lowercased name -> first source index, for the message
  for (const obj of headerObjectLiterals(APP)) {
    for (const k of keysOf(obj.body)) {
      if (/^x-/i.test(k) && !found.has(k.toLowerCase())) found.set(k.toLowerCase(), obj.index);
    }
  }
  return found;
}

const lineOf = (idx) => APP.slice(0, idx).split('\n').length;

// ============================================================
// THE INVARIANT
// ============================================================

test('🔴 EVERY CUSTOM HEADER app.html SENDS IS ALLOWED BY THE PREFLIGHT', () => {
  const sent = customHeadersSentByApp();
  const allowed = allowedSet();

  assert.ok(sent.size > 0,
    'extracted zero custom headers from app.html — the extraction broke, not the app. ' +
    'This test is worthless if it silently matches nothing; fix the scan before trusting a pass.');

  const missing = [...sent.keys()].filter(h => !allowed.has(h));
  assert.deepEqual(missing, [],
    'These custom request headers are sent by app.html but are NOT in ' +
    'Access-Control-Allow-Headers in supabase/functions/_shared/cors.ts:\n\n' +
    missing.map(h => `    ${h}   (app.html:${lineOf(sent.get(h))})`).join('\n') +
    '\n\n' +
    'A custom header the browser sends but CORS does not allow means that call ' +
    'is DEAD IN EVERY BROWSER, WITH NO SERVER LOG, BECAUSE THE REQUEST IS NEVER ' +
    'SENT. The browser blocks it at the preflight; the fetch rejects with ' +
    '"Failed to fetch"; the edge function is never invoked, so nothing is ' +
    'logged, nothing errors server-side and there is nothing to grep. This is ' +
    'exactly how statement-upload shipped broken and stayed broken.\n\n' +
    'Fix: add the header to ALLOW_HEADERS in cors.ts and REDEPLOY the function ' +
    'that receives it — the commit alone changes nothing, the running bundle ' +
    'is what answers the preflight. Do not widen the list to "*".\n' +
    'If the call goes to a third party rather than one of our edge functions, ' +
    'that is a deliberate decision to record here, not a reason to add the ' +
    'header to our CORS list.');
});

test('the extraction is scoped to header objects, not every x-* string', () => {
  // The naive scan (`grep -oE "'x-[a-z0-9-]+'"`) also finds the `x-circle`
  // icon name. If it ever leaks into the header set the scan has stopped
  // being scoped and the invariant above would start demanding CORS entries
  // for icons.
  assert.ok(/'x-circle'|"x-circle"/.test(APP),
    'x-circle is the decoy this test is calibrated against; if it is gone, ' +
    're-pick a decoy rather than deleting the check');
  const sent = customHeadersSentByApp();
  assert.ok(!sent.has('x-circle'), 'x-circle is an icon name, not a request header');
});

test('the two statement-upload headers are what the scan finds, and the function reads them', () => {
  const sent = customHeadersSentByApp();
  // Pinning the CURRENT contents, so adding a third header is a visible,
  // deliberate diff here as well as a pass/fail above.
  assert.deepEqual([...sent.keys()].sort(), ['x-content-type', 'x-filename-b64']);

  // The other end of the wire: the function actually reads both names.
  const fn = readFileSync(join(ROOT, 'supabase/functions/statement-upload/index.ts'), 'utf8');
  assert.match(fn, /req\.headers\.get\("x-filename-b64"\)/);
  assert.match(fn, /req\.headers\.get\("x-content-type"\)/);
});

test('🔴 the allow-list is not widened to a wildcard, and the origin rules are untouched', () => {
  const list = shippedAllowHeaders();
  assert.ok(!list.includes('*'),
    'Access-Control-Allow-Headers must name headers, never "*" — a wildcard ' +
    'would make this test vacuous and allow headers nothing sends');

  // The four originals must survive: supabase-js sends x-client-info and
  // apikey on every invoke(), and dropping either breaks all 58 of them.
  for (const h of ['authorization', 'x-client-info', 'apikey', 'content-type']) {
    assert.ok(allowedSet().has(h), `${h} must stay in the allow-list`);
  }

  // The origin allowlist is a separate decision from the header list; this
  // round changed neither it nor the dev-origin gate.
  assert.match(CORS, /"https:\/\/producerstackcrm\.com"/);
  assert.match(CORS, /"https:\/\/www\.producerstackcrm\.com"/);
  assert.match(CORS, /"https:\/\/localhost"/);
  assert.match(CORS, /ALLOW_DEV_ORIGINS/);
});

test('corsHeaders serves the derived constant, so the test and the wire cannot diverge', () => {
  // If someone re-inlines the string into corsHeaders(), ALLOW_HEADERS could
  // sit there passing this file while the function ships something else.
  assert.match(CORS, /"Access-Control-Allow-Headers":\s*ALLOW_HEADERS/,
    'corsHeaders() must return the ALLOW_HEADERS constant, not its own copy of the string');
});

test('statement-upload stays verify_jwt = true — it is absent from config.toml', () => {
  // Not a CORS property, but it is the thing a redeploy of this function can
  // silently change (docs/audit-2026-07-09-calling-and-topup.md: a five-hour
  // outage caused by exactly that), and this round redeploys it.
  const cfg = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');
  assert.ok(!/\[functions\.statement-upload\]/.test(cfg),
    'statement-upload must NOT be pinned in config.toml — it is browser-called ' +
    'with a real session JWT and wants the platform default verify_jwt = true');
});
