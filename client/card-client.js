// ============================================================
// client/card-client.js — Client-facing carrier card renderer
// Phase 1 Agent C, 2026-05-07
//
// Renders the customer-safe view of a quoteFE() result. The
// engine still computes agent-only fields (uwClass, commPct,
// advComm, eappName, per-class rates) — this renderer enforces
// the agent/client trust split by simply not surfacing them.
//
// Translation rules (locked, see docs/client-build-b.md):
//   approved     -> "Likely approved"        --c-ok    + check-circle
//   non_instant  -> "Approved with review"   --c-warn  + clock-counter-clockwise
//   graded       -> "Approved with conditions" --c-warn + info
//   declined     -> "Not a fit right now"    --c-text-2 + circle
//
// Anti-pattern reference: archive/index-2026-05-07-pre-pure-refactor.html
// runFEQuote (~line 1240) renders the AGENT card with comm box,
// "Select 1 / Level" jargon, and E-App link — none of that here.
//
// Classic script. Exposes window.renderClientCard and
// window.renderClientCardSet. No modules, no CDN, no innerHTML
// for engine-supplied strings.
// ============================================================

(function () {
  'use strict';

  // Phosphor regular line icons, inlined as SVG path data so the
  // file ships with no CDN dependency. 1.5px stroke per design system.
  // Set viewBox to Phosphor's native 256x256.
  var ICON_PATHS = {
    // check-circle (approved)
    'check-circle':
      'M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z',
    // clock-counter-clockwise (non_instant — under review)
    'clock-counter-clockwise':
      'M136,80v43.47l36.12,21.67a8,8,0,0,1-8.24,13.72l-40-24A8,8,0,0,1,120,128V80a8,8,0,0,1,16,0Zm-8-48A95.44,95.44,0,0,0,60.08,60.15C52.81,67.51,46.35,74.59,40,82V64a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H72a8,8,0,0,0,0-16H49.66c7.86-9.47,15.18-17.49,23.79-26.21a80,80,0,1,1,1.66,114.21,8,8,0,1,0-11,11.62A96,96,0,1,0,128,32Z',
    // info (graded — has conditions)
    info:
      'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z',
    // circle (declined — neutral, never red)
    circle:
      'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z',
  };

  // approval -> { label, statusClass, iconKey, ariaWord }
  // statusClass corresponds to existing .status-* classes in client.css
  // (status-ok = --c-ok, status-warn = --c-warn, status-neutral = --c-text-2).
  // NOTE: declined uses neutral grey, NEVER red — older audiences read
  // red as failure-blame. (See docs/client-build-b.md.)
  var APPROVAL_VIEW = {
    approved:    { label: 'Likely approved',        statusClass: 'status-ok',      iconKey: 'check-circle' },
    non_instant: { label: 'Approved with review',   statusClass: 'status-warn',    iconKey: 'clock-counter-clockwise' },
    graded:      { label: 'Approved with conditions', statusClass: 'status-warn',  iconKey: 'info' },
    declined:    { label: 'Not a fit right now',    statusClass: 'status-neutral', iconKey: 'circle' },
  };

  function _viewForApproval(approval) {
    return APPROVAL_VIEW[approval] || APPROVAL_VIEW.declined;
  }

  function _fmtMoney(n) {
    // Tabular money formatter. Treat NaN/null/undefined defensively;
    // engine should never hand us those for monthly, but if it does
    // we render an em-dash rather than "$NaN". Open question for
    // Phase 2: should an unparseable monthly drop the card entirely?
    if (n == null || isNaN(n)) return '—';
    var rounded = Math.round(Number(n) * 100) / 100;
    return '$' + rounded.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function _fmtCoverage(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Math.round(Number(n)).toLocaleString('en-US');
  }

  // Build a Phosphor SVG element with no innerHTML (so we never
  // accept attacker-controlled markup, even though icon keys are
  // internal constants).
  function _makeIcon(iconKey) {
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc) return null;
    // Use createElementNS in a real browser; the node-side test stub
    // only supports createElement, so fall back transparently.
    var svg = doc.createElementNS
      ? doc.createElementNS(SVG_NS, 'svg')
      : doc.createElement('svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = doc.createElementNS
      ? doc.createElementNS(SVG_NS, 'path')
      : doc.createElement('path');
    path.setAttribute('d', ICON_PATHS[iconKey] || ICON_PATHS.circle);
    svg.appendChild(path);
    return svg;
  }

  // Build the carrier dot — a small inline-block colored circle. The dot
  // is brand-coded (per-carrier hex from the engine's _FE_CARRIERS table),
  // NOT a status icon, so it lives separately from the status pairing.
  function _makeDot(color) {
    var dot = document.createElement('span');
    dot.className = 'carrier-dot';
    // Inline style: the dot color is engine-provided per carrier.
    // It's a brand swatch, not a token — this is the one acceptable
    // place to set a color outside of tokens.css.
    dot.setAttribute('style',
      'display:inline-block;width:10px;height:10px;border-radius:50%;'
      + 'background:' + (color || 'transparent') + ';'
      + 'margin-right:var(--space-2);flex-shrink:0;'
    );
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  // ----------------------------------------------------------------
  // renderClientCard(result, mountEl)
  //
  // Replaces the contents of mountEl with a single <article> for the
  // given quote result. All engine fields are dropped except those
  // whitelisted by the translation rules.
  //
  // DROPPED at render (still in result, never displayed):
  //   uwClass, commPct, advComm, eappName, rates.s1/s2/graded
  // ----------------------------------------------------------------
  function renderClientCard(result, mountEl) {
    if (!result || !mountEl) return;

    var view = _viewForApproval(result.approval);
    var monthlyStr = _fmtMoney(result.monthly);
    var coverageStr = _fmtCoverage(result.coverageAmount || (result.summary && result.summary.coverage));

    // Clear mount.
    mountEl.innerHTML = '';

    // <article class="client-card card">
    var article = document.createElement('article');
    article.className = 'client-card card';
    article.setAttribute('role', 'article');
    article.setAttribute(
      'aria-label',
      (result.carrierLabel || 'Carrier') + ' — ' + view.label
        + ', ' + monthlyStr + ' per month'
    );

    // 1) Carrier row: dot + carrier name (textContent — never innerHTML)
    var carrierRow = document.createElement('div');
    carrierRow.className = 'client-card-carrier';
    carrierRow.setAttribute('style',
      'display:flex;align-items:center;margin-bottom:var(--space-3);'
    );
    carrierRow.appendChild(_makeDot(result.dot));
    var carrierName = document.createElement('span');
    carrierName.className = 'client-card-carrier-name';
    carrierName.textContent = result.carrierLabel || '';
    carrierRow.appendChild(carrierName);
    article.appendChild(carrierRow);

    // 2) Status badge: icon + plain-language text (never color alone)
    var status = document.createElement('div');
    status.className = 'status ' + view.statusClass;
    status.setAttribute('style', 'margin-bottom:var(--space-3);');
    var iconEl = _makeIcon(view.iconKey);
    if (iconEl) status.appendChild(iconEl);
    var statusLabel = document.createElement('span');
    statusLabel.className = 'status-label';
    statusLabel.textContent = view.label;
    status.appendChild(statusLabel);
    article.appendChild(status);

    // 3) Monthly premium: numeric hero + " / month" caption
    var priceRow = document.createElement('div');
    priceRow.className = 'client-card-price';
    priceRow.setAttribute('style',
      'display:flex;align-items:baseline;gap:var(--space-2);'
      + 'margin-bottom:var(--space-2);'
    );
    var priceValue = document.createElement('span');
    priceValue.className = 'numeric';
    priceValue.textContent = monthlyStr;
    priceRow.appendChild(priceValue);
    var priceCaption = document.createElement('span');
    priceCaption.setAttribute('style',
      'font-size:var(--fs-caption);color:var(--c-text-2);'
    );
    priceCaption.textContent = '/ month';
    priceRow.appendChild(priceCaption);
    article.appendChild(priceRow);

    // 4) Coverage line (Caption-sized, secondary ink)
    if (coverageStr !== '—') {
      var coverageLine = document.createElement('div');
      coverageLine.className = 'client-card-coverage';
      coverageLine.setAttribute('style',
        'font-size:var(--fs-caption);color:var(--c-text-2);'
        + 'margin-bottom:var(--space-3);'
      );
      coverageLine.textContent = 'Coverage: ' + coverageStr;
      article.appendChild(coverageLine);
    }

    // 5) "Estimate only" footnote
    var footnote = document.createElement('div');
    footnote.className = 'client-card-footnote';
    footnote.setAttribute('style',
      'font-size:var(--fs-caption);color:var(--c-text-2);'
    );
    footnote.textContent = 'Estimate only';
    article.appendChild(footnote);

    mountEl.appendChild(article);
  }

  // ----------------------------------------------------------------
  // renderClientCardSet(quoteResult, mountEl, options)
  //
  // quoteResult = { summary, results } from quoteFE().
  // options = { topN: 3 } default.
  //
  // Sort: monthly ascending.
  // Filter: eligible && approval !== 'declined'.
  // If filtered list is empty (every carrier declined or ineligible),
  // FALL BACK to top N by monthly anyway with the "Not a fit right now"
  // status — never strand the user with an empty results screen.
  //
  // Mounts each card into a fresh <div> appended to mountEl.
  // ----------------------------------------------------------------
  function renderClientCardSet(quoteResult, mountEl, options) {
    if (!quoteResult || !mountEl) return;
    var opts = options || {};
    var topN = (typeof opts.topN === 'number' && opts.topN > 0) ? opts.topN : 3;

    var allResults = (quoteResult.results || []).slice();
    var coverage = quoteResult.summary && quoteResult.summary.coverage;

    // Primary path: eligible + non-declined, sorted by monthly asc.
    var primary = allResults
      .filter(function (r) { return r && r.eligible && r.approval !== 'declined'; })
      .sort(function (a, b) { return (a.monthly || 0) - (b.monthly || 0); })
      .slice(0, topN);

    // Fallback: nothing made the cut — show top N by monthly anyway
    // with whatever approval the engine assigned (likely "declined").
    var picks = primary;
    if (picks.length === 0) {
      picks = allResults
        .slice()
        .sort(function (a, b) { return (a.monthly || 0) - (b.monthly || 0); })
        .slice(0, topN);
    }

    // Clear and mount.
    mountEl.innerHTML = '';
    picks.forEach(function (r) {
      var slot = document.createElement('div');
      slot.className = 'client-card-slot';
      // Pass coverage down via a transient property so the card can
      // render the "Coverage: $X" line. We avoid mutating the engine
      // result object — copy first.
      var enriched = {};
      for (var k in r) {
        if (Object.prototype.hasOwnProperty.call(r, k)) enriched[k] = r[k];
      }
      enriched.coverageAmount = coverage;
      renderClientCard(enriched, slot);
      mountEl.appendChild(slot);
    });
  }

  // Expose as classic-script globals (no modules).
  if (typeof window !== 'undefined') {
    window.renderClientCard = renderClientCard;
    window.renderClientCardSet = renderClientCardSet;
  } else if (typeof globalThis !== 'undefined') {
    // Node-side test harness path.
    globalThis.renderClientCard = renderClientCard;
    globalThis.renderClientCardSet = renderClientCardSet;
  }
})();
