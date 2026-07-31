// ============================================================
// lead-filters.test.mjs — run with:  npm run test:leadfilters
//
// The Leads screen's Status / Source / State filters are multi-selects:
// OR within one filter, AND across filters.
//
// Two kinds of assertion here.
//
//   1. BEHAVIOUR. The pure block between the // <leadfilter-core> sentinels
//      in app.html is extracted and executed verbatim, so these tests run
//      against the code that ships rather than a copy of it.
//
//   2. STRUCTURE. Assertions about app.html as source text. The bug this
//      round actually fixed was not a wrong filter — it was THREE hand-written
//      copies of the same predicate (filterLeads, filterLeads_silent,
//      updateLeadTabCounts) that had already drifted apart: one normalised
//      the phone number before searching it and two did not. So a test
//      asserts there is exactly one predicate and that every caller uses it.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(join(ROOT, 'app.html'), 'utf8').split('\r\n').join('\n');

const stripLineComments = (src, markers) => src
  .split('\n').filter(l => !markers.some(m => l.trim().startsWith(m))).join('\n');

const EXPORTS = ['LEAD_FILTER_FIELDS', 'leadFilterEmpty', 'leadFilterValue',
                 'leadMatchesField', 'leadMatchesQuery', 'leadMatchesFilters',
                 'leadFilterActiveCount'];

function loadBlock(name, exports) {
  const m = APP.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`));
  assert.ok(m, `app.html must contain the // <${name}> block`);
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn {${exports.join(',')}};`)();
}
const F = loadBlock('leadfilter-core', EXPORTS);

/** A selection object from a plain spec, so the tests read like the UI. */
const sel = (spec = {}) => {
  const out = F.leadFilterEmpty();
  Object.entries(spec).forEach(([k, vals]) => { out[k] = new Set(vals); });
  return out;
};

const lead = (o = {}) => ({
  id: 1, name: 'Jane Doe', phone: '(512) 555-0134', email: 'jane@example.com',
  state: 'TX', city: 'Austin', status: 'new', source: 'facebook', ...o,
});

// ============================================================
// 1. THE EMPTY SET IS "ALL", NOT "NONE"
// ============================================================

test('an empty selection admits everybody — it is "All", not a filter to zero', () => {
  const s = F.leadFilterEmpty();
  assert.equal(F.leadFilterActiveCount(s), 0);
  assert.equal(F.leadMatchesFilters(lead(), s, '', null), true);
  assert.equal(F.leadMatchesFilters(lead({ status: 'sold', source: 'aged', state: 'FL' }), s, '', null), true);
});

test('a missing selection object is also "All" — the predicate never throws on one', () => {
  assert.equal(F.leadMatchesFilters(lead(), undefined, '', null), true);
  assert.equal(F.leadMatchesFilters(lead(), null, '', null), true);
  assert.equal(F.leadMatchesField(lead(), 'status', undefined), true);
});

// ============================================================
// 2. OR WITHIN A FILTER
// ============================================================

test('two values in one filter are an OR', () => {
  const s = sel({ status: ['new', 'no_answer'] });
  assert.equal(F.leadMatchesFilters(lead({ status: 'new' }), s, '', null), true);
  assert.equal(F.leadMatchesFilters(lead({ status: 'no_answer' }), s, '', null), true);
  assert.equal(F.leadMatchesFilters(lead({ status: 'sold' }), s, '', null), false);
});

test('the OR widens as values are added, it does not narrow', () => {
  const one = sel({ state: ['TX'] });
  const two = sel({ state: ['TX', 'FL'] });
  const fl = lead({ state: 'FL' });
  assert.equal(F.leadMatchesFilters(fl, one, '', null), false);
  assert.equal(F.leadMatchesFilters(fl, two, '', null), true);
});

// ============================================================
// 3. AND ACROSS FILTERS
// ============================================================

test('status IN (a,b) AND source IN (x,y) — the brief\'s exact example', () => {
  const s = sel({ status: ['new', 'no_answer'], source: ['facebook', 'google'] });
  assert.equal(F.leadMatchesFilters(lead({ status: 'new',       source: 'facebook' }), s, '', null), true);
  assert.equal(F.leadMatchesFilters(lead({ status: 'no_answer', source: 'google'   }), s, '', null), true);
  // Right status, wrong source → excluded. The AND is real.
  assert.equal(F.leadMatchesFilters(lead({ status: 'new',       source: 'aged'     }), s, '', null), false);
  // Right source, wrong status → excluded.
  assert.equal(F.leadMatchesFilters(lead({ status: 'sold',      source: 'facebook' }), s, '', null), false);
});

test('all three filters compose', () => {
  const s = sel({ status: ['sold'], source: ['referral'], state: ['TX'] });
  const hit = lead({ status: 'sold', source: 'referral', state: 'TX' });
  assert.equal(F.leadMatchesFilters(hit, s, '', null), true);
  assert.equal(F.leadMatchesFilters({ ...hit, state: 'FL' }, s, '', null), false);
});

// ============================================================
// 4. THE VALUES A LEAD PRESENTS
// ============================================================

test('a lead with no status is "new" — the same default the whole app uses', () => {
  assert.equal(F.leadFilterValue({}, 'status'), 'new');
  assert.equal(F.leadFilterValue({ status: '' }, 'status'), 'new');
  assert.equal(F.leadMatchesFilters({}, sel({ status: ['new'] }), '', null), true);
});

test('state matching is case-insensitive, because the book holds both', () => {
  assert.equal(F.leadFilterValue({ state: 'tx' }, 'state'), 'TX');
  assert.equal(F.leadMatchesFilters(lead({ state: 'tx' }), sel({ state: ['TX'] }), '', null), true);
});

test('a lead with no source is not swept up by a source filter', () => {
  assert.equal(F.leadFilterValue({}, 'source'), '');
  assert.equal(F.leadMatchesFilters(lead({ source: '' }), sel({ source: ['facebook'] }), '', null), false);
  // …but an empty source filter still admits it.
  assert.equal(F.leadMatchesFilters(lead({ source: '' }), F.leadFilterEmpty(), '', null), true);
});

// ============================================================
// 5. SEARCH — the drift that was actually there
// ============================================================

test('a typed phone number matches however either side is punctuated', () => {
  const l = lead({ phone: '(512) 555-0134' });
  ['5125550134', '512-555-0134', '(512) 555-0134', '512.555.0134']
    .forEach(q => assert.equal(F.leadMatchesQuery(l, q), true, `"${q}" should match`));
});

test('search still covers name, email, state and city', () => {
  const l = lead();
  ['jane', 'JANE', 'example.com', 'tx', 'austin']
    .forEach(q => assert.equal(F.leadMatchesQuery(l, q), true, `"${q}" should match`));
  assert.equal(F.leadMatchesQuery(l, 'nobody'), false);
});

test('an empty query matches everything and does not blow up on a bare lead', () => {
  assert.equal(F.leadMatchesQuery({}, ''), true);
  assert.equal(F.leadMatchesQuery({}, 'x'), false);
});

test('a non-numeric query does not accidentally match every phone via an empty digit string', () => {
  // digits === '' must not turn into "contains('')", which is always true.
  assert.equal(F.leadMatchesQuery({ phone: '5125550134' }, 'zzz'), false);
});

// ============================================================
// 6. THE TAB SET, AND skipFields
// ============================================================

test('the status sub-tab narrows on top of the filters', () => {
  const s = F.leadFilterEmpty();
  assert.equal(F.leadMatchesFilters(lead({ status: 'sold' }), s, '', ['social_obj', 'banking_obj']), false);
  assert.equal(F.leadMatchesFilters(lead({ status: 'social_obj' }), s, '', ['social_obj', 'banking_obj']), true);
});

test('skipFields lets the tab counters ignore the status filter', () => {
  // Without the skip, filtering to Sold would report 0 on every other tab —
  // the counters would be measuring the filter instead of the tab.
  const s = sel({ status: ['sold'] });
  const l = lead({ status: 'new' });
  assert.equal(F.leadMatchesFilters(l, s, '', null), false);
  assert.equal(F.leadMatchesFilters(l, s, '', null, ['status']), true);
  // …but the OTHER filters still apply while status is skipped.
  const s2 = sel({ status: ['sold'], state: ['FL'] });
  assert.equal(F.leadMatchesFilters(l, s2, '', null, ['status']), false);
});

// ============================================================
// 7. THE COUNT BEHIND THE CHIPS
// ============================================================

test('the active count is every chosen value across every filter', () => {
  assert.equal(F.leadFilterActiveCount(F.leadFilterEmpty()), 0);
  assert.equal(F.leadFilterActiveCount(sel({ status: ['new'] })), 1);
  assert.equal(F.leadFilterActiveCount(sel({ status: ['new', 'sold'], state: ['TX'] })), 3);
});

// ============================================================
// 8. STRUCTURE — one predicate, and everybody uses it
// ============================================================

test('there is exactly ONE filter predicate and all three callers go through it', () => {
  const defs = APP.match(/function leadMatchesFilters\(/g) || [];
  assert.equal(defs.length, 1, 'leadMatchesFilters must be defined once');
  ['function filterLeads()', 'function filterLeads_silent()', 'function updateLeadTabCounts()']
    .forEach(fnHead => {
      const at = APP.indexOf(fnHead);
      assert.ok(at > 0, `${fnHead} must exist`);
      const body = APP.slice(at, at + 900);
      assert.ok(/leadMatchesFilters\(/.test(body),
        `${fnHead} must filter through leadMatchesFilters, not its own copy`);
    });
});

test('the old single-value <select> filters are gone, ids and all', () => {
  // Their mere presence would mean two places to change, and the JS no
  // longer reads them — a stale one would look live and do nothing.
  ['lead-filter-status', 'lead-filter-source', 'lead-filter-state']
    .forEach(id => assert.ok(!APP.includes(`id="${id}"`), `#${id} must be gone`));
  ['msf-status', 'msf-source', 'msf-state']
    .forEach(id => assert.match(APP, new RegExp(`id="${id}"`)));
});

test('the selection lives in JS, not in the DOM — which is what survives pagination', () => {
  assert.match(APP, /let _leadFilterSel = leadFilterEmpty\(\);/);
  // leadsPage() must not reset it, and nothing may rebuild it per render.
  const page = APP.slice(APP.indexOf('function leadsPage(dir)'), APP.indexOf('function leadsTab('));
  assert.ok(!/_leadFilterSel\s*=/.test(page), 'paging must never reassign the selection');
  // The select-all-across-pages path reads the multi-filtered set.
  const all = APP.slice(APP.indexOf('function selectAllPages()'), APP.indexOf('function toggleLeadSelect('));
  assert.match(all, /filterLeads_silent\(\)/);
  assert.match(all, /filteredLeads\.forEach/);
});

test('the leadfilter core is pure — no DOM, network, storage or app globals', () => {
  const m = APP.match(/\/\/ <leadfilter-core>([\s\S]*?)\/\/ <\/leadfilter-core>/);
  const body = stripLineComments(m[1], ['//', '*', '/*']);
  [/\bdocument\./, /\bwindow\./, /\blocalStorage\b/, /\bsb\./, /\bfetch\(/,
   /\bcurrentAgent\b/, /\bshowToast\(/, /\bleads\b\s*\./, /\bfilteredLeads\b/]
    .forEach(re => assert.ok(!re.test(body), `${re} must not appear in the extracted core`));
});

test('every core sentinel appears EXACTLY ONCE in app.html, including the new one', () => {
  ['bob-core', 'comm-core', 'persist-core', 'backoffice-core', 'team-core',
   'producer-codes-core', 'leaderboard-core', 'recon-core', 'referral-core',
   'ai-meter-core', 'vcamp-core', 'leadfilter-core']
    .forEach(name => {
      const opens  = (APP.match(new RegExp(`// <${name}>`, 'g')) || []).length;
      const closes = (APP.match(new RegExp(`// </${name}>`, 'g')) || []).length;
      assert.equal(opens, 1, `// <${name}> must appear exactly once, found ${opens}`);
      assert.equal(closes, 1, `// </${name}> must appear exactly once, found ${closes}`);
    });
});

// ============================================================
// 9. STRUCTURE — the selection highlight (A4)
// ============================================================

test('"selected" has ONE writer, and it derives both the box and the row', () => {
  assert.match(APP, /function syncLeadSelectionUI\(\)/);
  // The inline outline is gone; it is a class now.
  assert.ok(!/div\.style\.outline = '2px solid rgba\(59,130,246/.test(APP),
    'the row highlight must not be an inline style written at render time');
  assert.match(APP, /\.lead-row\.is-selected\{/);
  // Every path that mutates the Set ends at the one sync.
  ['function toggleSelectAll(checked)', 'function selectAllPages()',
   'function toggleLeadSelect(lid, checked)', 'function clearBulkSelection()']
    .forEach(fnHead => {
      const at = APP.indexOf(fnHead);
      assert.ok(at > 0, `${fnHead} must exist`);
      assert.match(APP.slice(at, at + 700), /syncLeadSelectionUI\(\)/,
        `${fnHead} must finish by syncing the UI from selectedLeadIds`);
    });
});

// ============================================================
// 10. STRUCTURE — the opt-in button is gone (D1), the page is not
// ============================================================

test('the per-lead "Opt-in link" button and its senders are gone from the app', () => {
  assert.ok(!/lead-optin-btn/.test(APP), 'the button class must be gone');
  assert.ok(!/smsSendOptInLink\(/.test(APP), 'the email sender must have no call sites');
  assert.ok(!/id="sms-optin-btn"/.test(APP), 'the thread modal button must be gone');
});

test('the hosted opt-in page itself is untouched and still linked', () => {
  // Only the in-app EMAIL action went away. The page is the carrier-facing
  // evidence and the registration points at it.
  assert.match(APP, /sms-opt-in/);
  assert.match(APP, /optInUrl/);
});

test('the leads header reports BOTH permissions, from two separate stores', () => {
  assert.match(APP, /id="lead-callable-count"/);
  assert.match(APP, /id="lead-textable-count"/);
  assert.match(APP, /function textableCount\(\)/);
  // Blank, not "0 textable", before the consent map has loaded — same rule
  // the callable chip already follows.
  const fn = APP.slice(APP.indexOf('function updateTextableCount()'),
                       APP.indexOf('function updateTextableCount()') + 700);
  assert.match(fn, /if \(ok === null\) \{ el\.textContent = ''; return; \}/);
  // And the two numbers come from different places on purpose.
  assert.match(APP, /function textableCount\(\)[\s\S]{0,400}leadSmsCapable\(l\)/);
  assert.match(APP, /function voiceCallableCount\(\)[\s\S]{0,300}_voiceConsent\.byClientId/);
});
