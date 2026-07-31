// ============================================================
// checkout-complete.test.mjs — run with:  npm run test:checkout
//
// The Stripe return page and everything that points at it.
//
// There is no DOM in this runner and no jsdom in the repo, so the page's
// behaviour is pinned two ways: the COPY table is EXTRACTED from the shipped
// file and executed, so the type → message mapping is tested against the real
// thing rather than a copy of it; everything else is asserted against the file
// as source text.
//
// What went wrong before, and what these therefore guard:
//   * success_url pointed at app.html, so a 540px popup redirected into the
//     whole dashboard;
//   * `checkout=topup_success` matched NO branch and was not in the
//     popup-close guard, so a wallet top-up did it and then just sat there;
//   * a page that is not in the GitHub Pages allowlist is not served at all,
//     which would turn a completed payment into a 404.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').split('\r\n').join('\n');

const PAGE = read('checkout-complete.html');
const APP = read('app.html');
const FN = read('supabase/functions/stripe-create-checkout/index.ts');
const PAGES_YML = read('.github/workflows/pages.yml');
const PREBUILD = read('scripts/prebuild.js');

// Comments explain, in as many words, several of the things being searched
// for below; strip them before grepping for the code.
const stripJs = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
// The page's header comment names supabase/functions/stripe-webhook while
// explaining that fulfillment stays there — an HTML comment, so it survives
// stripJs and would match a grep for the very thing it says the page avoids.
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const PAGE_CODE = stripJs(stripHtmlComments(PAGE));
const FN_CODE = stripJs(FN);
const APP_CODE = stripJs(APP);

// ============================================================
// 1. WHAT THE PAGE SAYS — the real table, executed
// ============================================================

function loadCopy() {
  const copy = PAGE.match(/var COPY = (\{[\s\S]*?\});/);
  const dflt = PAGE.match(/var DEFAULT = (\{[\s\S]*?\});/);
  assert.ok(copy, 'checkout-complete.html must define the COPY table');
  assert.ok(dflt, 'checkout-complete.html must define a DEFAULT');
  // eslint-disable-next-line no-new-func
  return new Function(`return { COPY: ${copy[1]}, DEFAULT: ${dflt[1]} };`)();
}
const { COPY, DEFAULT } = loadCopy();
const say = (type) => COPY[String(type || '').trim().toLowerCase()] || DEFAULT;

test('each checkout type gets its own sentence', () => {
  assert.equal(say('subscription').detail, 'Your plan is active.');
  assert.equal(say('topup').detail, 'Funds added to your wallet.');
  assert.equal(say('number').detail, 'Your new number is being set up.');
  assert.equal(say('cancelled').detail, 'No charge was made.');
});

test('a cancel does not say "Payment complete"', () => {
  assert.equal(say('cancelled').headline, 'Checkout canceled');
  for (const t of ['subscription', 'topup', 'number', '', 'wat']) {
    assert.equal(say(t).headline, 'Payment complete', `headline for "${t}"`);
  }
});

test('an unknown or missing type is vague, never wrong', () => {
  // Claiming a plan is active when somebody topped up their wallet is worse
  // than saying nothing specific.
  for (const t of ['', null, undefined, 'wat', 'SUBSCRIPTIONS', '  ']) {
    assert.equal(say(t).detail, "You're all set.", `detail for ${JSON.stringify(t)}`);
  }
  assert.equal(DEFAULT.headline, 'Payment complete');
});

test('the type is matched case- and space-insensitively', () => {
  assert.equal(say('  TOPUP '), COPY.topup);
  assert.equal(say('Number'), COPY.number);
});

test('every type the edge function can send has a sentence', () => {
  // The two lists have to agree or a live checkout lands on the vague default.
  const sent = [...FN.matchAll(/checkout-complete\.html\?type=([a-z]+)/g)].map((m) => m[1]);
  assert.ok(sent.length >= 6, 'expected 3 success + 3 cancel URLs');
  for (const t of new Set(sent)) {
    assert.ok(COPY[t], `the function sends type=${t} but the page has no copy for it`);
  }
});

// ============================================================
// 2. THE PAGE GRANTS NOTHING
// ============================================================

test('🔴 the page verifies nothing and calls nothing', () => {
  // Fulfillment is 100% the Stripe webhook's job. A return page that granted
  // anything would be a paywall bypass with a URL for a key.
  for (const bad of [/\bfetch\(/, /XMLHttpRequest/, /supabase/i, /session_id/, /CHECKOUT_SESSION_ID/]) {
    assert.ok(!bad.test(PAGE_CODE), `checkout-complete.html must not contain ${bad}`);
  }
});

test('the page is self-contained — nothing external to block or 404', () => {
  assert.ok(!/<link[^>]+stylesheet/i.test(PAGE), 'no external stylesheet');
  assert.ok(!/<script[^>]+src=/i.test(PAGE), 'no external script');
  assert.ok(!/<img/i.test(PAGE), 'no images — the tick is inline SVG');
  assert.ok(!/https?:\/\//.test(PAGE_CODE.replace(/^.*robots.*$/gim, '')), 'no absolute URLs in code');
});

test('it is never indexed', () => {
  assert.match(PAGE, /<meta name="robots" content="noindex,nofollow">/);
});

// ============================================================
// 3. TELLING THE OPENER
// ============================================================

test('all three notification channels are used', () => {
  assert.match(PAGE_CODE, /window\.opener\.postMessage\(payload, '\*'\)/);
  assert.match(PAGE_CODE, /new BroadcastChannel\('pp_checkout'\)/);
  assert.match(PAGE_CODE, /localStorage\.setItem\('pp_checkout_signal'/);
});

test('the payload carries the kind, the result and a nonce', () => {
  const m = PAGE.match(/var payload = \{([\s\S]*?)\};/);
  assert.ok(m, 'the page must build one payload object');
  assert.match(m[1], /type: 'pp_checkout_result'/);
  assert.match(m[1], /result: cancelled \? 'cancelled' : 'complete'/);
  assert.match(m[1], /checkout: type \|\| 'unknown'/);
  // Three channels means the same result can arrive three times.
  assert.match(m[1], /nonce:/);
});

test('🔴 only a SUBSCRIPTION may send the legacy completion message', () => {
  // `stripe_checkout_complete` drives _wizPaymentComplete() and
  // _goToSuccessUrl(). A wallet top-up firing it would finish the signup
  // wizard and walk somebody into the dashboard on a plan they never bought.
  assert.match(
    PAGE_CODE,
    /if \(!cancelled && \(type === 'subscription' \|\| type === ''\)\) \{\s*\n\s*window\.opener\.postMessage\(\{ type: 'stripe_checkout_complete' \}/,
  );
  // And a cancel sends the cancel string, whatever was being bought.
  assert.match(PAGE_CODE, /\} else if \(cancelled\) \{\s*\n\s*window\.opener\.postMessage\(\{ type: 'stripe_checkout_cancelled' \}/);
});

test('a dead opener is not an error', () => {
  assert.match(PAGE_CODE, /if \(window\.opener && !window\.opener\.closed\)/);
  // Every channel is individually wrapped: one unavailable API must not stop
  // the other two.
  assert.ok((PAGE_CODE.match(/try \{/g) || []).length >= 4);
});

// ============================================================
// 4. GETTING OUT OF THE WAY
// ============================================================

test('it auto-closes, and proves close was refused before offering a way back', () => {
  assert.match(PAGE_CODE, /var CLOSE_AFTER_MS = 2500;/);
  assert.match(PAGE_CODE, /window\.close\(\)/);
  // A window that actually closed stops running timers, so a timer that fires
  // after close() is the proof. There is no other portable signal.
  assert.match(PAGE_CODE, /setTimeout\(function \(\) \{\s*\n\s*document\.body\.setAttribute\('data-close', 'blocked'\);/);
});

test('the fallback is hidden until then, and replaces the close hint', () => {
  assert.match(PAGE, /\.fallback\{ display:none;/);
  assert.match(PAGE, /body\[data-close="blocked"\] \.fallback\{ display:block; \}/);
  // "You can close this window" is wrong once we know it will not close.
  assert.match(PAGE, /body\[data-close="blocked"\] \.small\{ display:none; \}/);
  assert.match(PAGE, /id="return-btn" href="\/app\.html"/);
});

test('🔴 the fallback state contains no app — that was the whole bug', () => {
  // Whatever happens, this page cannot become a dashboard in a popup: it has
  // no app in it to become one.
  assert.ok(!/bootDashboard|subscribeAuth|sec-summary|createClient/.test(PAGE));
});

test('theming follows applyTheme() exactly, including its default', () => {
  // applyTheme(): `const isLight = saved !== 'dark'`. A page that guessed
  // differently would flash the wrong theme on the way out of a payment.
  assert.match(APP_CODE, /const saved = localStorage\.getItem\('pp_theme'\);/);
  assert.match(APP_CODE, /const isLight = saved !== 'dark';/);
  assert.match(PAGE_CODE, /localStorage\.getItem\('pp_theme'\)/);
  assert.match(PAGE_CODE, /saved === 'dark' \? 'dark' : 'light'/);
});

test('reduced motion is honoured', () => {
  assert.match(PAGE, /@media \(prefers-reduced-motion: reduce\)/);
});

// ============================================================
// 5. EVERY CHECKOUT POINTS AT IT
// ============================================================

test('🔴 no checkout returns into app.html any more', () => {
  assert.ok(!/app\.html\?checkout=/.test(FN_CODE),
    'stripe-create-checkout must not send anyone back into the dashboard');
});

test('the inventory: three success URLs, three cancel URLs, right types', () => {
  const success = [...FN_CODE.matchAll(/"success_url":\s*`\$\{APP_URL\}([^`]+)`/g)].map((m) => m[1]);
  const cancel = [...FN_CODE.matchAll(/"cancel_url":\s*`\$\{APP_URL\}([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(success.sort(), [
    '/checkout-complete.html?type=number',
    '/checkout-complete.html?type=subscription',
    '/checkout-complete.html?type=topup',
  ]);
  assert.equal(cancel.length, 3);
  for (const c of cancel) assert.equal(c, '/checkout-complete.html?type=cancelled');
});

test('the session id is gone, because nothing reads it', () => {
  assert.ok(!/CHECKOUT_SESSION_ID/.test(FN_CODE),
    'no session id in a URL that buys nobody anything');
});

test('🔴 nothing else in the checkout function moved', () => {
  // Scope guardrail: cosmetic routing only. The things that decide what is
  // actually sold must all still be there.
  for (const keep of [
    /stripe_topup_product_id/, /stripe_numbers_price_id/,
    /payment_intent_data\[metadata\]\[amount_mills\]/,
    /metadata\[supabase_user_id\]/,
    /Math\.round\(amountMills \/ 10\)/,
  ]) {
    assert.match(FN_CODE, keep);
  }
});

// ============================================================
// 6. THE APP LISTENS, ONCE
// ============================================================

test('one listener handles all three channels', () => {
  assert.match(APP_CODE, /function _ppListenForCheckout\(\)/);
  assert.match(APP_CODE, /window\.addEventListener\('message'/);
  assert.match(APP_CODE, /new BroadcastChannel\('pp_checkout'\)\.onmessage/);
  assert.match(APP_CODE, /window\.addEventListener\('storage'/);
  assert.match(APP_CODE, /_ppListenForCheckout\(\);/);
});

test('three channels do not make three toasts', () => {
  assert.match(APP_CODE, /const _ppSeenCheckout = new Set\(\);/);
  assert.match(APP_CODE, /if \(_ppSeenCheckout\.has\(nonce\)\) return;/);
});

test('a foreign origin cannot fake a payment toast', () => {
  const at = APP_CODE.indexOf('function _ppListenForCheckout()');
  const body = APP_CODE.slice(at, at + 700);
  assert.match(body, /if \(e\.origin !== location\.origin\) return;/);
});

test('each kind refreshes the thing it changed', () => {
  const at = APP_CODE.indexOf('function _ppHandleCheckoutResult(');
  const body = APP_CODE.slice(at, APP_CODE.indexOf('function _ppListenForCheckout()'));
  // renderPhoneBook() re-reads wallet_accounts as well as the numbers, so one
  // call covers a top-up's balance and a purchase's list.
  assert.match(body, /if \(kind === 'topup' \|\| kind === 'number'\)/);
  assert.match(body, /renderPhoneBook\(\)/);
  assert.match(body, /softphone\.resetWebRTC\(\)/);
  assert.match(body, /_recheckSubscription\(\)/);
  assert.match(body, /showToast\('Payment received'/);
  // A cancel is the opener's business — it already knows it opened one.
  assert.match(body, /if \(payload\.result !== 'complete'\) return;/);
});

test('the listener does NOT re-handle the legacy subscription messages', () => {
  // Those resolve a pending signup or paywall through their own mounted
  // listeners; running the transition twice is how a wizard double-advances.
  const at = APP_CODE.indexOf('function _ppHandleCheckoutResult(');
  const body = APP_CODE.slice(at, APP_CODE.indexOf('function _ppListenForCheckout()'));
  assert.ok(!/stripe_checkout_complete/.test(body));
});

// ============================================================
// 7. THE LEGACY WINDOW
// ============================================================

test('🔴 an in-flight legacy top-up no longer boots the dashboard in a popup', () => {
  // Stripe sessions created before this shipped still carry the old URLs.
  // topup_success and number_success were missing from this guard, which is
  // exactly the reported bug.
  assert.match(
    APP_CODE,
    /\['success', 'cancelled', 'topup_success', 'number_success'\]\.includes\(_cpv\)/,
  );
});

test('the legacy guard keeps the same narrow rule about the legacy strings', () => {
  const at = APP_CODE.indexOf("const _cpv = _cp.get('checkout');");
  const body = APP_CODE.slice(at, at + 1200);
  assert.match(body, /_cpv === 'success' \? 'stripe_checkout_complete'/);
  assert.match(body, /_cpv === 'cancelled' \? 'stripe_checkout_cancelled' : null/);
  // topup / number report on the typed channel instead.
  assert.match(body, /checkout: _cpv === 'topup_success' \? 'topup' : 'number'/);
});

// ============================================================
// 8. IT ACTUALLY GETS SERVED
// ============================================================

test('🔴 the page is in the GitHub Pages allowlist', () => {
  // The workflow is default-deny. A page that is not listed is not served,
  // and a completed payment would land on a 404.
  const files = PAGES_YML.match(/FILES=\(([\s\S]*?)\n\s*\)/);
  assert.ok(files, 'pages.yml must still carry the FILES allowlist');
  assert.match(files[1], /^\s*checkout-complete\.html\s*$/m);
});

test('the page ships in the native bundle too', () => {
  // On native, hosted checkout opens in the system browser and returns here.
  const pages = PREBUILD.match(/const pages = \[([\s\S]*?)\];/);
  assert.ok(pages);
  assert.match(pages[1], /'checkout-complete\.html'/);
});
