// ============================================================
// web-dialer.test.mjs — run with:  npm run test:dialer
//
// The floating dialer's window controls and its draggable launcher.
//
// Structural assertions against app.html as source text. There is no DOM
// here, so these pin the SHAPE of the thing rather than its behaviour — and
// the shape is what went wrong twice:
//
//   * one button whose icon was swapped in JS put a "–" on the minimized
//     bar, because an icon swap has exactly one failure mode and that is it.
//     Two elements toggled by CSS cannot express "both at once";
//   * the cluster sat in the strip ABOVE the phone rather than on it,
//     because .wd-header is a flow element and nothing took it out.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8').split('\r\n').join('\n');

// ============================================================
// 1. THE WINDOW CONTROLS
// ============================================================

test('minimize and expand are SEPARATE buttons, not one with a swapped icon', () => {
  assert.match(APP, /id="wd-floating-min"/);
  assert.match(APP, /id="wd-floating-expand"/);
  assert.match(APP, /id="wd-floating-close"/);
  // The swap is gone, along with the span it wrote into.
  assert.ok(!/wd-floating-min-ico/.test(APP),
    'the icon-swap span must be gone — it is what showed a dash while minimized');
  assert.ok(!/icon\(on \? 'arrows-out' : 'minus'/.test(APP),
    'nothing may swap the glyph at runtime');
});

test('🔴 exactly one of minimize/expand is visible in each state', () => {
  // Expanded: expand hidden. Minimized: minimize hidden, expand shown.
  assert.match(APP, /#sec-webdialer\.dialer-floating \.wd-floating-expand\{ display:none; \}/);
  assert.match(APP, /#sec-webdialer\.dialer-floating\.is-minimized \.wd-floating-min\{ display:none; \}/);
  assert.match(APP, /#sec-webdialer\.dialer-floating\.is-minimized \.wd-floating-expand\{ display:flex; \}/);
});

test('each button asks for the state it means, so a toggle cannot desync', () => {
  assert.match(APP, /floatMin\.addEventListener\('click', \(\) => setDialerMinimized\(true\)\)/);
  assert.match(APP, /floatExpand\.addEventListener\('click', \(\) => setDialerMinimized\(false\)\)/);
});

test('the .is-minimized class is the ONLY thing deciding which control shows', () => {
  const fn = APP.slice(APP.indexOf('function applyDialerMinimized()'),
                       APP.indexOf('function toggleDialerMinimized'));
  assert.match(fn, /sec\.classList\.toggle\('is-minimized', on\)/);
  // No per-button fiddling left in there.
  assert.ok(!/wd-floating-min'\)/.test(fn), 'applyDialerMinimized must not touch the buttons');
  assert.ok(!/innerHTML/.test(fn), 'applyDialerMinimized must not write any markup');
});

test('the cluster overlays the phone, in BOTH states', () => {
  // Expanded: the header is pulled out of flow so the dial card rises to the
  // top of the popup and the buttons land on its corner.
  assert.match(APP, /#sec-webdialer\.dialer-floating \.wd-header\{[\s\S]{0,200}position:absolute;\s*top:14px;\s*right:14px/);
  // Minimized: same mechanism, tighter inset for the bar.
  assert.match(APP, /#sec-webdialer\.dialer-floating\.is-minimized \.wd-header\{ top:4px; right:4px; \}/);
  // And the card makes room so they never crowd the Caller ID field.
  assert.match(APP, /#sec-webdialer\.dialer-floating \.wd-dial-card\{ padding-top:42px; \}/);
});

test('the header stays click-through except for the buttons themselves', () => {
  // It covers the card's corner; without this it would eat clicks on the
  // card underneath.
  assert.match(APP, /#sec-webdialer\.dialer-floating \.wd-header\{[\s\S]{0,220}pointer-events:none/);
  assert.match(APP, /#sec-webdialer\.dialer-floating \.wd-float-btns\{ pointer-events:auto; \}/);
});

test('no stray em dash on the docked bar', () => {
  // The idle timer used to render "—", which reads as a control sitting
  // next to two real ones.
  assert.match(APP, /<span class="wd-dock-timer" id="wd-dock-timer"><\/span>/);
  const fn = APP.slice(APP.indexOf('function _renderDock('), APP.indexOf('function _renderCallState('));
  assert.ok(!/live \? '—' : '—'/.test(fn), 'the idle timer must be blank, not a dash');
});

// ============================================================
// 2. CLOSE NEVER ORPHANS A CALL
// ============================================================

test('X hangs up through the ordinary path FIRST, then dismisses', () => {
  const at = APP.indexOf("const floatClose = _el('wd-floating-close');");
  assert.ok(at > 0);
  const block = APP.slice(at, at + 700);
  const hangupAt = block.indexOf('sp.hangup()');
  const closeAt  = block.indexOf('closeDialerWidget()');
  assert.ok(hangupAt > 0, 'a live call must be hung up');
  assert.ok(closeAt > hangupAt, 'the popup is dismissed AFTER the hangup');
  // Unconditional: the old version only closed on the idle branch, so
  // pressing X during a call hung up and left the popup sitting there.
  assert.match(block, /\n\s*if \(typeof closeDialerWidget === 'function'\) closeDialerWidget\(\);/);
});

// ============================================================
// 3. THE LAUNCHER
// ============================================================

test('six slots, four corners plus two centres, and the default is unchanged', () => {
  assert.match(APP, /const DFAB_SLOTS = \['tl', 'tc', 'tr', 'bl', 'bc', 'br'\];/);
  assert.match(APP, /const DFAB_DEFAULT_SLOT = 'br';/);
  assert.match(APP, /const DFAB_SLOT_KEY = 'pp_dialer_fab_slot';/);
});

test('the edge inset is READ off the stylesheet, never hard-coded', () => {
  // Hard-coding 24px would silently break the mobile media query's tighter
  // 16px + safe-area margins.
  assert.match(APP, /function _dfabInsets\(fab\)/);
  assert.match(APP, /const cs = getComputedStyle\(fab\);/);
});

test('centring uses a margin, not a transform', () => {
  // :hover and :active both animate `transform`; centring with one would
  // fling the button across the screen the moment the pointer touched it.
  const fn = APP.slice(APP.indexOf('function dfabApplySlot()'),
                       APP.indexOf('(function initDialerFabDrag()'));
  assert.match(fn, /s\.marginLeft = \(-\(fab\.offsetWidth \|\| 56\) \/ 2\) \+ 'px'/);
  // Comment-stripped: the code says in as many words WHY it does not use a
  // transform, and a naive grep matches that explanation.
  const code = fn.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/translateX/.test(code), 'no transform-based centring');
});

test('a drag is not a click', () => {
  assert.match(APP, /const MOVE_THRESHOLD = 5;/);
  assert.match(APP, /if \(!moved\) return;\s*\/\/ a plain click/);
  assert.match(APP, /fab\.addEventListener\('click', swallow, \{ capture: true, once: true \}\)/);
});

test('the launcher gets out of the docked bar\'s way by MEASURED overlap', () => {
  const fn = APP.slice(APP.indexOf('function dfabApplySlot()'),
                       APP.indexOf('(function initDialerFabDrag()'));
  assert.match(fn, /const overlaps = f\.left < d\.right && f\.right > d\.left && f\.top < d\.bottom && f\.bottom > d\.top;/);
  // The nudge is NOT persisted — the slot is, so the button drops back the
  // moment the bar goes away.
  assert.ok(!/dfabSetSlot/.test(fn), 'the collision nudge must not rewrite the stored slot');
});

test('touch drags do not scroll the page', () => {
  assert.match(APP, /\.dialer-fab\{ touch-action:none; user-select:none/);
});
