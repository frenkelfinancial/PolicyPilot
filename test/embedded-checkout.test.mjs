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
  return new Function(`${js}\nreturn { CHECKOUT_UI_EMBEDDED, STRIPE_UI_MODE_EMBEDDED, isEmbeddedRequest, applyEmbeddedCheckout };`)();
}
const { CHECKOUT_UI_EMBEDDED, STRIPE_UI_MODE_EMBEDDED, isEmbeddedRequest, applyEmbeddedCheckout } = loadCore();

test('"embedded" is the only recognised value', () => {
  assert.equal(CHECKOUT_UI_EMBEDDED, 'embedded');
  assert.equal(isEmbeddedRequest({ ui: 'embedded' }), true);
});

test('🔴 our request flag and Stripe\'s ui_mode are SEPARATE values', () => {
  // They shared a word, so they were written as one constant — and then Stripe
  // retired the value `embedded` and rejected every session outright:
  //   "The ui_mode value `embedded` is no longer supported.
  //    Use `embedded_page` instead."
  // Live checkout broke while our own request flag was perfectly fine. These
  // are two different vocabularies and must be able to move independently.
  assert.equal(STRIPE_UI_MODE_EMBEDDED, 'embedded_page');
  assert.notEqual(STRIPE_UI_MODE_EMBEDDED, CHECKOUT_UI_EMBEDDED);
  const p = new URLSearchParams({ success_url: 'x', cancel_url: 'y' });
  applyEmbeddedCheckout(p);
  assert.equal(p.get('ui_mode'), 'embedded_page', "the wire value is Stripe's, not ours");
  // The flag app.html sends must NOT follow a Stripe rename — an older cached
  // app.html goes on sending `ui: "embedded"` forever.
  assert.equal(isEmbeddedRequest({ ui: 'embedded' }), true);
  assert.equal(isEmbeddedRequest({ ui: 'embedded_page' }), false);
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
  assert.equal(p.get('ui_mode'), 'embedded_page');
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

// ============================================================
// 7. GETTING INTO CHECKOUT AT ALL
// ============================================================

test('🔴 the ?view=signup entry point does not run during script evaluation', () => {
  // #auth-gate is markup at ~line 4269, so it is ALREADY in the DOM when this
  // IIFE runs inside the script block starting at ~8424. A synchronous
  // tryShow() therefore reached authShowView('signup') -> authLoadSignupPlans()
  // while `let _signupPlansLoaded` — declared ~500 lines further down in the
  // SAME block — was still in its temporal dead zone. Because
  // authLoadSignupPlans is async the ReferenceError became an unhandled
  // rejection, so the script finished evaluating and nothing looked broken,
  // but no plan price and no card's dataset.planId ever loaded.
  const at = APP_CODE.indexOf("p.get('view') === 'signup'");
  assert.ok(at > -1, 'the ?view=signup auto-activate IIFE must still be there');
  const body = APP_CODE.slice(at, at + 420);
  assert.match(body, /setTimeout\(tryShow, 0\);/, 'the first attempt must be deferred a tick');
  assert.ok(!/\n\s*tryShow\(\);/.test(body), 'never call tryShow() synchronously');
});

test('the guard is real: the binding really is declared after the entry point', () => {
  // If this ever stops being true the deferral is merely harmless rather than
  // load-bearing — but it is true today, and it is why the bug existed.
  const entry = APP.indexOf("p.get('view') === 'signup'");
  const decl = APP.indexOf('let _signupPlansLoaded = false;');
  const gate = APP.indexOf('<div id="auth-gate">');
  const script = APP.indexOf('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
  assert.ok(entry > -1 && decl > -1 && gate > -1 && script > -1);
  assert.ok(decl > entry, '_signupPlansLoaded is declared AFTER the ?view=signup entry point');
  assert.ok(gate < script, '#auth-gate markup precedes the script, so it is found immediately');
});

test('🔴 a checkout error can never render a message that names nothing', () => {
  // "{}" was shown to a paying customer verbatim: unsearchable, unreportable,
  // and indistinguishable from a broken button.
  const m = APP.match(/function _checkoutFailureMessage\(e\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'app.html must define _checkoutFailureMessage');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`function _checkoutFailureMessage(e) {${m[1]}\n}; return _checkoutFailureMessage;`)();
  for (const useless of ['{}', '[object Object]', '', '   ', 'null', 'undefined']) {
    const out = fn(new Error(useless));
    assert.ok(/try again/i.test(out), `"${useless}" must not reach the user, got: ${out}`);
    assert.ok(!/^\{\}$/.test(out));
  }
  // No message at all, and a non-Error, are both handled.
  assert.match(fn(undefined), /try again/i);
  assert.match(fn({}), /try again/i);
  // A real message survives untouched.
  assert.equal(fn(new Error('plan_not_found')), 'plan_not_found');
  assert.equal(fn(new Error('checkout_session_failed — No such price')), 'checkout_session_failed — No such price');
  // The network case still gets its own actionable sentence.
  assert.match(fn(new TypeError('Failed to fetch')), /Couldn't reach the payment server/);
});

test('🔴 an auth error can never render a message that names nothing either', () => {
  // The reported "{}" was NOT the checkout catch — it was sb.auth.signUp().
  // supabase-js builds AuthApiError.message as
  //   data.msg || data.message || data.error_description || data.error || JSON.stringify(data)
  // and JSON.stringify({}) is "{}". wizSubmit then sees wiz-err-3 lit, returns
  // early, and never calls checkout at all — which is exactly why no Stripe
  // modal appeared.
  const m = APP.match(/function _authErrorMessage\(error, what\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'app.html must define _authErrorMessage');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`function _authErrorMessage(error, what) {${m[1]}\n}; return _authErrorMessage;`)();

  for (const useless of ['{}', '[object Object]', '', '  ', 'null', 'undefined']) {
    const out = fn({ message: useless }, 'signup');
    assert.ok(out && out.length > 12, `"${useless}" must be replaced, got: ${out}`);
    assert.ok(!/^(\{\}|\[object Object\]|null|undefined)$/.test(out));
  }
  assert.ok(fn(undefined, 'signup').length > 12);
  assert.ok(fn({}, 'signup').length > 12);

  // The EXACT body the live auth server returned while sign-up was broken.
  const real = { message: 'Error sending confirmation email', status: 500, code: 'unexpected_failure' };
  const said = fn(real, 'signup');
  assert.match(said, /confirmation email/i);
  assert.match(said, /wasn't created/i, 'it must say the account does not exist, so nobody retries forever');

  // ...and the SAME mail failure on a password reset must NOT claim an account
  // was not created. That would be a lie.
  const reset = fn({ message: 'Error sending recovery email', status: 500 }, 'email');
  assert.ok(!/account/i.test(reset), `reset wording must not mention an account: ${reset}`);
  assert.match(reset, /couldn't send/i);

  // A 500 with no usable message still says whose fault it is and keeps the
  // identifiers, so a screenshot is enough to debug from.
  const blind = fn({ message: '{}', status: 500, code: 'unexpected_failure' }, 'signup');
  assert.match(blind, /on our side/i);
  assert.match(blind, /HTTP 500/);
  assert.match(blind, /unexpected_failure/);

  // A real, useful message is passed through untouched.
  assert.equal(fn({ message: 'User already registered' }, 'signup'), 'User already registered');
  assert.match(fn({ message: 'Failed to fetch' }, 'signup'), /Couldn't reach the server/);
});

test('every auth error path actually uses it', () => {
  // sign-up, sign-in, Google OAuth, forgot-password, update-password.
  // authForgot() matters as much as sign-up here: resetPasswordForEmail also
  // sends mail, so the same broken SMTP surfaces there too.
  assert.ok(!/authMsg\(error\.message, 'err'\)/.test(APP_CODE),
    'no auth path may render a raw supabase error message');
  const uses = APP_CODE.match(/_authErrorMessage\(error, '[a-z]*'\)/g) || [];
  assert.equal(uses.length, 5);
});

test("🔴 every call site surfaces Stripe's `detail`, not just `error`", () => {
  // `detail` is the ONLY place Stripe's reason appears. Four sites threw
  // result.error alone, so a message naming both the bug AND its fix —
  // "The ui_mode value `embedded` is no longer supported. Use `embedded_page`
  // instead." — reached the user as the bare word "checkout_session_failed".
  const uses = APP_CODE.match(/await _checkoutParseResponse\(resp\)/g) || [];
  assert.equal(uses.length, CALL_SITE_COUNT, 'one shared parser, every call site');
  // Scoped to the checkout sites: other endpoints legitimately hand-roll their
  // own checks, and this rule is about Stripe's `detail` specifically.
  for (const m of APP_CODE.matchAll(/functions\/v1\/stripe-create-checkout`/g)) {
    const after = APP_CODE.slice(m.index, m.index + 700);
    assert.match(after, /await _checkoutParseResponse\(resp\)/);
    assert.ok(!/await resp\.json\(\)/.test(after),
      'a checkout site must not parse the body itself and drop detail');
  }

  const m = APP.match(/async function _checkoutParseResponse\(resp\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'app.html must define _checkoutParseResponse');
  const src = m[1];
  // Read as TEXT: resp.json() throws on an empty or non-JSON body BEFORE
  // resp.ok can be consulted, so a 502 HTML error page became a parse error.
  assert.match(src, /await resp\.text\(\)/);
  assert.ok(!/await resp\.json\(\)/.test(src));
  assert.match(src, /\[result\.error, result\.detail\]/);
  assert.match(src, /HTTP \$\{resp\.status\}/, 'an unnamed failure still carries its status');
});

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
