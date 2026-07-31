// ============================================================
// embedded-checkout.test.mjs — run with:  npm run test:embedded
//
// Stripe Embedded Checkout: the agent pays without leaving app.html.
//
// The flow now has TWO response shapes off one endpoint — `{ url }` for the
// native shell's hosted popup and `{ client_secret }` for the web modal — and
// a flag deciding between them. That is a drift surface, so the things that
// keep the two honest are pinned here:
//
//   * the flag is compared STRICTLY, so the string "false" cannot enable it;
//   * an embedded session carries ui_mode + redirect_on_completion:'never'
//     and NEITHER hosted URL — Stripe rejects a session with both;
//   * a request with no `ui` produces exactly what it produced before;
//   * every call site checks client_secret BEFORE url, so a stale server
//     lands on the working hosted path instead of a blank modal;
//   * 🔴 nothing in the completion path grants anything. stripe-webhook is
//     100% of fulfillment, and onComplete fires on a client that can lie.
//
// House pattern: the source is read as TEXT, and the one block that decides
// the session shape is EXTRACTED AND EXECUTED, so the rule is tested against
// the code that ships rather than a copy of it.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').split('\r\n').join('\n');

const APP = read('app.html');
const FN = read('supabase/functions/stripe-create-checkout/index.ts');

// Several of the things grepped for below are named in as many words by the
// comments explaining them; strip comments before searching for the code.
const stripJs = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const FN_CODE = stripJs(FN);
const APP_CODE = stripJs(APP);

// ============================================================
// 1. THE RULE, EXECUTED
// ============================================================

// The block is TypeScript; the annotations are simple enough to remove
// deterministically. A new annotation shape breaks the parse loudly, which is
// the correct failure — this test must keep running against the real block.
function loadCore() {
  const m = FN.match(/\/\/ <embedded-checkout-core>([\s\S]*?)\/\/ <\/embedded-checkout-core>/);
  assert.ok(m, 'stripe-create-checkout must carry an <embedded-checkout-core> block');
  const js = m[1]
    .replace(/\)\s*:\s*[A-Za-z_$][\w$]*\s*\{/g, ') {')          // return annotations
    .replace(/([(,]\s*[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*/g, '$1'); // parameter annotations
  // eslint-disable-next-line no-new-func
  return new Function(`${js}\nreturn { CHECKOUT_UI_EMBEDDED, isEmbeddedRequest, applyEmbeddedCheckout };`)();
}
const { CHECKOUT_UI_EMBEDDED, isEmbeddedRequest, applyEmbeddedCheckout } = loadCore();

test('"embedded" is the only recognised value', () => {
  assert.equal(CHECKOUT_UI_EMBEDDED, 'embedded');
  assert.equal(isEmbeddedRequest({ ui: 'embedded' }), true);
});

test('🔴 the flag is a strict compare, so nothing truthy turns it on', () => {
  // Same bug class leads-consent's sms_attestation already pins: a truthy
  // check means the STRING "false" enables the branch.
  for (const ui of ['false', 'true', 'Embedded', 'EMBEDDED', ' embedded', 'hosted', 1, true, {}, [], null]) {
    assert.equal(isEmbeddedRequest({ ui }), false, `ui: ${JSON.stringify(ui)} must not be embedded`);
  }
  assert.equal(isEmbeddedRequest({}), false, 'absent ui is hosted');
  assert.equal(isEmbeddedRequest(null), false);
  assert.equal(isEmbeddedRequest(undefined), false);
});

test('the strict compare is in the source, not just in behaviour', () => {
  assert.match(FN_CODE, /body\.ui === CHECKOUT_UI_EMBEDDED/);
  assert.ok(!/body\.ui ==[^=]/.test(FN_CODE), 'never a loose ==');
  assert.ok(!/!!\s*body\.ui\b/.test(FN_CODE), 'never a truthy coercion of body.ui');
  assert.ok(!/\bif\s*\(\s*body\.ui\s*\)/.test(FN_CODE), 'never a bare truthy check');
});

test('🔴 an embedded session sets both fields and carries NEITHER hosted URL', () => {
  // Stripe REJECTS the session outright if success_url/cancel_url survive
  // alongside redirect_on_completion:'never', so removing them is not tidying.
  const p = new URLSearchParams({
    'mode': 'subscription',
    'success_url': 'https://producerstackcrm.com/checkout-complete.html?type=subscription',
    'cancel_url': 'https://producerstackcrm.com/checkout-complete.html?type=cancelled',
    'metadata[supabase_user_id]': 'u1',
  });
  applyEmbeddedCheckout(p);
  assert.equal(p.get('ui_mode'), 'embedded');
  assert.equal(p.get('redirect_on_completion'), 'never');
  assert.equal(p.has('success_url'), false);
  assert.equal(p.has('cancel_url'), false);
  // Nothing else was disturbed.
  assert.equal(p.get('mode'), 'subscription');
  assert.equal(p.get('metadata[supabase_user_id]'), 'u1');
});

test("redirect_on_completion is 'never' — the top window must not navigate", () => {
  // 'always' (the default) navigates the TOP window to return_url, which is
  // the bug checkout-complete.html exists to fix, through a different door.
  assert.match(FN_CODE, /"redirect_on_completion",\s*"never"/);
  assert.ok(!/redirect_on_completion[^\n]*"(always|if_required)"/.test(FN_CODE));
  assert.ok(!/return_url/.test(FN_CODE), 'no return_url — there is nowhere to return to');
});

// ============================================================
// 2. EVERY SESSION-CREATING PATH, BOTH SHAPES
// ============================================================

// The three paths that actually create a Checkout Session. The
// existing-subscriber path creates none and is asserted separately below.
const SESSION_PATHS = ['topup', 'numbers', 'subscription'];

test('all three session paths apply the embedded shape, and only under the flag', () => {
  const applied = FN_CODE.match(/if \(embedded\) applyEmbeddedCheckout\(sessionParams\);/g) || [];
  assert.equal(applied.length, SESSION_PATHS.length,
    'topup, numbers and subscription must each apply it — exactly once each');
  // One definition of the shape, called three times. Three hand-written copies
  // is this repo's named bug class.
  const bodies = FN_CODE.match(/params\.set\("ui_mode"/g) || [];
  assert.equal(bodies.length, 1, 'the embedded shape is written in exactly one place');
});

test('all three session paths return client_secret when embedded', () => {
  const returns = FN_CODE.match(/return json\(\{ client_secret: session\.client_secret \}\);/g) || [];
  assert.equal(returns.length, SESSION_PATHS.length);
  // And each guards it, so a session with no secret is a named error rather
  // than a modal that mounts nothing.
  const guards = FN_CODE.match(/if \(!session\.client_secret\)/g) || [];
  assert.equal(guards.length, SESSION_PATHS.length, 'guarded on every path');
  const named = FN_CODE.match(/checkout_session_no_client_secret/g) || [];
  assert.equal(named.length, SESSION_PATHS.length, 'and named on every path');
});

test('🔴 the hosted path is untouched when `ui` is absent', () => {
  // Three success URLs, three cancel URLs, still written literally in the
  // params — this is what a native build and any older cached app.html get.
  const success = [...FN_CODE.matchAll(/"success_url":\s*`\$\{APP_URL\}([^`]+)`/g)].map((m) => m[1]);
  const cancel = [...FN_CODE.matchAll(/"cancel_url":\s*`\$\{APP_URL\}([^`]+)`/g)].map((m) => m[1]);
  assert.equal(success.length, SESSION_PATHS.length);
  assert.equal(cancel.length, SESSION_PATHS.length);
  const urlReturns = FN_CODE.match(/return json\(\{ url: session\.url \}\);/g) || [];
  assert.equal(urlReturns.length, SESSION_PATHS.length);
  // A params object that never met applyEmbeddedCheckout keeps its URLs and
  // gains nothing.
  const p = new URLSearchParams({ 'mode': 'payment', 'success_url': 'x', 'cancel_url': 'y' });
  assert.equal(p.has('success_url'), true);
  assert.equal(p.has('ui_mode'), false);
  assert.equal(p.has('redirect_on_completion'), false);
});

test('the existing-subscriber path still creates no session at all', () => {
  // It updates the subscription item through the Stripe API and answers
  // { ok: true, upgraded: true }. Embedded checkout has no business here.
  assert.match(FN_CODE, /return json\(\{ ok: true, upgraded: true \}\);/);
  const at = FN_CODE.indexOf('if (agent?.stripe_subscription_id) {');
  const body = FN_CODE.slice(at, FN_CODE.indexOf('return json({ ok: true, upgraded: true });', at));
  assert.ok(!/embedded/.test(body), 'the upgrade path must not branch on the UI mode');
  assert.ok(!/checkout\/sessions/.test(body));
});

test('nothing that decides what is actually sold moved', () => {
  for (const keep of [
    /subscription_data\[trial_period_days\]/,
    /DOWNLINE_DISCOUNT_COUPON_ID/,
    /allow_promotion_codes/,
    /presets\.includes\(amountMills\)/,
    /topup_presets_mills/,
    /stripe_topup_product_id/,
    /stripe_numbers_price_id/,
    /Math\.round\(amountMills \/ 10\)/,
    /payment_intent_data\[metadata\]\[amount_mills\]/,
    /subscription_data\[metadata\]\[supabase_user_id\]/,
    /agent_has_active_leader_link/,
  ]) {
    assert.match(FN_CODE, keep);
  }
  // The DEV_EMAIL bypass, including its deliberate absence on topup.
  assert.match(FN_CODE, /const DEV_EMAIL = 'jacef8778099@gmail\.com';/);
  const topup = FN_CODE.slice(FN_CODE.indexOf('if (mode === "topup") {'), FN_CODE.indexOf('if (mode === "numbers") {'));
  assert.ok(!/DEV_EMAIL/.test(topup), 'a top-up mints spendable balance — no dev bypass, ever');
});

test('no session id came back in through the embedded door', () => {
  assert.ok(!/CHECKOUT_SESSION_ID/.test(FN_CODE));
});

// ============================================================
// 3. THE CALL SITES
// ============================================================

// NOTE: FIVE, not four. Prompt 18's inventory listed four and missed
// pbApplyPlanChange(), which was doing a top-level `location.href =
// result.url` — the single worst offender for "the dashboard unloaded".
// It is wired like the rest. The count is pinned because this flow now has
// two response shapes, and a sixth call site is where they drift.
const CALL_SITE_COUNT = 5;

test('the call-site count is pinned', () => {
  const sites = APP.match(/functions\/v1\/stripe-create-checkout`/g) || [];
  assert.equal(sites.length, CALL_SITE_COUNT);
});

test('🔴 every call site checks client_secret BEFORE url', () => {
  const secretAt = [...APP_CODE.matchAll(/if \(result\.client_secret\) \{/g)].map((m) => m.index);
  const urlAt = [...APP_CODE.matchAll(/if \(result\.url\) \{/g)].map((m) => m.index);
  assert.equal(secretAt.length, CALL_SITE_COUNT);
  assert.equal(urlAt.length, CALL_SITE_COUNT);
  // Pairwise in file order: a stale server that ignores the flag must fall
  // through to the working hosted path, not to a blank modal.
  for (let i = 0; i < CALL_SITE_COUNT; i++) {
    assert.ok(secretAt[i] < urlAt[i], `call site ${i + 1}: client_secret must be tested first`);
  }
});

test('every call site sends the flag, and only on web', () => {
  const flags = APP_CODE.match(/\.\.\.\(embedded \? \{ ui: 'embedded' \} : \{\}\)/g) || [];
  assert.equal(flags.length, CALL_SITE_COUNT, 'spread so a native request carries no `ui` key at all');
  const decisions = APP_CODE.match(/const embedded = !_wizIsNative\(\);/g) || [];
  assert.equal(decisions.length, CALL_SITE_COUNT);
});

test('🔴 _wizIsNative() is the only platform predicate', () => {
  // A rule written out by hand in more than one place is this codebase's
  // named bug class, and a second answer to "are we in the shell" would put
  // the native build on a path nobody tested.
  assert.match(APP_CODE, /function _wizIsNative\(\)/);
  const defAt = APP_CODE.indexOf('function _wizIsNative()');
  const endAt = defAt + APP_CODE.slice(defAt).indexOf('\n}\n') + 3;
  const rest = APP_CODE.slice(0, defAt) + APP_CODE.slice(endAt);
  assert.ok(!/isNativePlatform/.test(rest),
    'isNativePlatform may only appear inside _wizIsNative()');
});

test('the native hosted path is still there, untouched', () => {
  // These are not dead code — they are the entire native purchase flow.
  assert.match(APP_CODE, /function _wizOpenStripePopup\(url\)/);
  assert.match(APP_CODE, /function _openStripeCheckoutPopup\(url, \{ onComplete, onCancel \}\)/);
  assert.match(APP_CODE, /stripe_checkout_complete/);
  assert.match(APP_CODE, /stripe_checkout_cancelled/);
  assert.match(APP_CODE, /Capacitor\.Plugins\.Browser/);
});

// ============================================================
// 4. 🔴 THE COMPLETION PATH GRANTS NOTHING
// ============================================================

test('🔴 onComplete is a UI signal — it fulfils nothing', () => {
  // stripe-webhook is 100% of fulfillment. onComplete fires on the client and
  // a client can be lied to; anything granted here is a paywall bypass.
  const at = APP_CODE.indexOf('async function _mountEmbeddedCheckout(');
  assert.ok(at > -1);
  const body = APP_CODE.slice(at, APP_CODE.indexOf('document.addEventListener(\'keydown\'', at));
  for (const bad of [
    /plan_id/, /monthly_minute_limit/, /monthly_quote_limit/, /wallet_/,
    /balance_mills/, /\bsb\./, /\.update\(/, /\.insert\(/, /\.rpc\(/, /currentPlanName/,
  ]) {
    assert.ok(!bad.test(body), `the embedded completion path must not contain ${bad}`);
  }
});

test('the subscription callers reuse the tested webhook-lag retry', () => {
  // _goToSuccessUrl() sets ?checkout=success and reloads specifically so
  // bootDashboard()'s retry-before-paywall runs. The webhook may not have
  // landed when onComplete fires — that retry is what covers the gap. A toast
  // would not.
  // Counted INSIDE the embedded mounts only — the two surviving hosted
  // _openStripeCheckoutPopup() calls reuse the same helper, as they should.
  const mounts = [...APP_CODE.matchAll(/_mountEmbeddedCheckout\(result\.client_secret, \{([\s\S]*?)\n\s*\}\);/g)]
    .map((m) => m[1]);
  assert.equal(mounts.length, CALL_SITE_COUNT);
  const toSuccess = mounts.filter((b) => /onComplete: _goToSuccessUrl,/.test(b));
  assert.equal(toSuccess.length, 4, 'wizard, paywall, auto-checkout and plan change');
  assert.match(APP_CODE, /function _goToSuccessUrl\(\)/);
  assert.match(APP_CODE, /url\.searchParams\.set\('checkout', 'success'\)/);
  // The top-up refreshes the thing it changed instead.
  const topup = mounts.filter((b) => /onComplete: \(\) => renderPhoneBook\(\),/.test(b));
  assert.equal(topup.length, 1);
});

// ============================================================
// 5. THE MODAL
// ============================================================

test('the instance is destroyed before the caller navigates', () => {
  const at = APP_CODE.indexOf('async function _mountEmbeddedCheckout(');
  const body = APP_CODE.slice(at, APP_CODE.indexOf('function _teardownStripeCheckout()'));
  const tearAt = body.indexOf('_teardownStripeCheckout();');
  const cbAt = body.indexOf('if (cb) cb();');
  assert.ok(tearAt > -1 && cbAt > -1);
  assert.ok(tearAt < cbAt, 'an undestroyed Stripe iframe mid-navigation floods the console');
});

test('closing is the cancel path, so no button is left stuck', () => {
  // planRequiredSubscribe() used to leave "Opening checkout…" on screen
  // forever if the flow died.
  assert.match(APP_CODE, /let _stripeCheckoutCallbacks = null;/);
  const at = APP_CODE.indexOf('function closeStripeCheckout()');
  const body = APP_CODE.slice(at, at + 300);
  assert.match(body, /_stripeCheckoutCallbacks\.onCancel/);
  assert.match(body, /_teardownStripeCheckout\(\);/);
  assert.match(body, /if \(cb\) cb\(\);/);
  // And the callbacks are cleared on teardown, so a later close fires nothing.
  const tear = APP_CODE.slice(APP_CODE.indexOf('function _teardownStripeCheckout()'), APP_CODE.indexOf('function closeStripeCheckout()'));
  assert.match(tear, /_stripeCheckoutCallbacks = null;/);
  assert.match(tear, /_stripeCheckoutInstance\.destroy\(\)/);
});

test('every caller that can leave a button disabled supplies an onCancel', () => {
  const mounts = APP_CODE.match(/_mountEmbeddedCheckout\(result\.client_secret, \{/g) || [];
  assert.equal(mounts.length, CALL_SITE_COUNT);
  const cancels = APP_CODE.match(/onCancel: /g) || [];
  // Four of the five; the top-up re-enables its grid in a finally block and
  // has nothing left to restore.
  assert.ok(cancels.length >= 4);
});

test('it can be dismissed without a mouse, and by clicking away', () => {
  assert.match(APP_CODE, /if \(e\.key !== 'Escape'\) return;/);
  assert.match(APP_CODE, /modal\.style\.display === 'flex'\) closeStripeCheckout\(\)/);
  assert.match(APP, /onclick="if\(event\.target===this\)closeStripeCheckout\(\)"/);
});

test('the modal announces itself and cannot clip on a laptop', () => {
  const m = APP.match(/<div id="stripe-checkout-modal"[^>]*>\s*\n\s*<div style="([^"]+)"/);
  assert.ok(m, 'the modal markup must still be there');
  assert.match(APP, /<div id="stripe-checkout-modal"[^>]*role="dialog"/);
  assert.match(APP, /<div id="stripe-checkout-modal"[^>]*aria-modal="true"/);
  assert.match(m[1], /max-height:90vh/);
  assert.match(m[1], /overflow:auto/);
  assert.match(APP, /id="stripe-checkout-container" style="min-height:420px"/);
});

test('Stripe.js and the publishable key are both present', () => {
  assert.match(APP, /<script src="https:\/\/js\.stripe\.com\/v3\/"><\/script>/);
  assert.match(APP_CODE, /const STRIPE_PUBLISHABLE_KEY = 'pk_live_/);
  assert.match(APP_CODE, /Stripe\(STRIPE_PUBLISHABLE_KEY\)/);
  assert.match(APP_CODE, /stripe\.initEmbeddedCheckout\(\{/);
  assert.match(APP_CODE, /_stripeCheckoutInstance\.mount\('#stripe-checkout-container'\)/);
});

// ============================================================
// 6. THE COMMENT THAT WAS A LIE
// ============================================================

test('the signup wizard no longer claims to do something it does not', () => {
  // The comment read "now mount Stripe embedded checkout inline on this same
  // page" directly above a call to _wizOpenStripePopup().
  assert.ok(!/now mount Stripe embedded checkout inline on this same page/.test(APP));
  // And it genuinely does it now.
  const at = APP.indexOf('async function wizSubmit()');
  const body = APP.slice(at, APP.indexOf('function _wizIsNative()'));
  assert.match(body, /_mountEmbeddedCheckout\(result\.client_secret/);
  assert.match(body, /_wizOpenStripePopup\(result\.url\)/);
});
