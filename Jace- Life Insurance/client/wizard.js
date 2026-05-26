/* ============================================================
 * client/wizard.js — Self-serve quote wizard state machine
 * Phase 2, 2026-05-07
 *
 * Drives the 6-step flow: about_you → coverage → health →
 * tobacco_build → contact → results. The DOM and styling come
 * from Phase 1A (client.html / client/client.css). The health
 * questions come from Phase 1B (HEALTH_QUESTIONS in
 * shared/uw-translator.js). The result cards come from Phase 1C
 * (renderClientCardSet in client/card-client.js).
 *
 * No DOM-spelunking outside this file — uses window.WizardSlots
 * to look up step sections + drive the progress bar.
 * ============================================================ */
(function () {
  'use strict';

  // -----------------------------------------------------------
  // submitLead — STUB. Build B-2 will replace the body with an
  // EmailJS or Supabase write. The signature, return shape, and
  // call sites do not change.
  // -----------------------------------------------------------
  async function submitLead(params) {
    console.log('[stub] submitLead', params);
    return { ok: true };
  }

  // -----------------------------------------------------------
  // Step order + state
  // -----------------------------------------------------------
  var STEPS = ['about-you', 'coverage', 'health', 'tobacco-build', 'contact', 'results'];

  var state = {
    stepIndex: 0,
    about: { age: null, gender: null },
    coverage: { amount: 15000, payment: 'bank' },
    health: {},          // { [questionId]: 'no' | 'yes' | 'yes:lt2' | ... }
    tobaccoBuild: { tobacco: null, heightIn: null, weightLb: null },
    contact: { name: '', email: '', phone: '', zip: '' },
    quoteResult: null,
    leadParams: null,
  };

  // -----------------------------------------------------------
  // Small DOM helpers
  // -----------------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v; // only used for our own static markup, never user data
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    if (children) children.forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function mountFields(stepId, builderFn) {
    var section = window.WizardSlots.step(stepId);
    if (!section) return;
    var slot = section.querySelector('[data-slot="fields"]');
    if (!slot) return;
    slot.innerHTML = '';
    builderFn(slot);
  }

  function showError(stepId, message) {
    var section = window.WizardSlots.step(stepId);
    if (!section) return;
    var slot = section.querySelector('[data-slot="fields"]');
    if (!slot) return;
    var existing = slot.querySelector('.wizard-form-error');
    if (existing) existing.remove();
    if (!message) return;
    var box = el('p', { class: 'wizard-form-error field-error', role: 'alert', text: message });
    slot.insertBefore(box, slot.firstChild);
  }

  // -----------------------------------------------------------
  // Step → validator + content builder
  // -----------------------------------------------------------
  function buildAboutYou(slot) {
    var ageInput = el('input', {
      type: 'number',
      id: 'fld-age',
      min: '40',
      max: '85',
      inputmode: 'numeric',
      autocomplete: 'off',
      value: state.about.age != null ? String(state.about.age) : '',
      oninput: function (e) {
        var v = parseInt(e.target.value, 10);
        state.about.age = isNaN(v) ? null : v;
      },
    });
    slot.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'fld-age', text: 'Your age' }),
      ageInput,
      el('p', { class: 'field-help', text: 'We can quote ages 40 through 85.' }),
    ]));

    var genderList = el('ul', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Gender' });
    [['M', 'Male'], ['F', 'Female']].forEach(function (pair, i) {
      var id = 'fld-gender-' + pair[0];
      var input = el('input', {
        type: 'radio',
        name: 'gender',
        id: id,
        value: pair[0],
        checked: state.about.gender === pair[0],
        onchange: function () { state.about.gender = pair[0]; },
      });
      var label = el('label', { class: 'choice', for: id }, [
        input,
        el('span', { class: 'choice-label', text: pair[1] }),
      ]);
      genderList.appendChild(el('li', null, [label]));
    });
    slot.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Gender' }),
      genderList,
    ]));

    slot.appendChild(buildTrust());
  }

  function validateAboutYou() {
    if (state.about.age == null || state.about.age < 40 || state.about.age > 85) {
      return 'Please enter an age between 40 and 85.';
    }
    if (state.about.gender !== 'M' && state.about.gender !== 'F') {
      return 'Please choose a gender so we can match the right rate band.';
    }
    return null;
  }

  function buildCoverage(slot) {
    var amountSelect = el('select', {
      id: 'fld-coverage',
      onchange: function (e) { state.coverage.amount = parseInt(e.target.value, 10); },
    });
    [5000, 10000, 15000, 20000, 25000, 35000, 50000].forEach(function (amt) {
      var opt = el('option', { value: String(amt), text: '$' + amt.toLocaleString() });
      if (state.coverage.amount === amt) opt.setAttribute('selected', '');
      amountSelect.appendChild(opt);
    });
    slot.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'fld-coverage', text: 'Coverage amount' }),
      amountSelect,
      el('p', { class: 'field-help', text: 'How much would you like your family to receive.' }),
    ]));

    var paymentList = el('ul', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'How would you like to pay' });
    [['bank', 'Bank draft (most carriers)'], ['cc', 'Credit or debit card']].forEach(function (pair) {
      var id = 'fld-pay-' + pair[0];
      var input = el('input', {
        type: 'radio',
        name: 'payment',
        id: id,
        value: pair[0],
        checked: state.coverage.payment === pair[0],
        onchange: function () { state.coverage.payment = pair[0]; },
      });
      paymentList.appendChild(el('li', null, [
        el('label', { class: 'choice', for: id }, [
          input,
          el('span', { class: 'choice-label', text: pair[1] }),
        ]),
      ]));
    });
    slot.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Payment method' }),
      paymentList,
      el('p', { class: 'field-help', text: 'Card payment is offered by a smaller set of carriers.' }),
    ]));

    slot.appendChild(buildTrust());
  }

  function validateCoverage() {
    var c = state.coverage.amount;
    if (!c || c < 1000 || c > 50000) return 'Please pick a coverage amount between $1,000 and $50,000.';
    if (state.coverage.payment !== 'bank' && state.coverage.payment !== 'cc') return 'Please choose how you would like to pay.';
    return null;
  }

  function buildHealth(slot) {
    if (typeof HEALTH_QUESTIONS === 'undefined' || !HEALTH_QUESTIONS.groups) {
      slot.appendChild(el('p', { class: 'field-error', text: 'Health questions failed to load. Please refresh.' }));
      return;
    }
    HEALTH_QUESTIONS.groups.forEach(function (group) {
      var groupBox = el('section', { class: 'health-group', 'aria-labelledby': 'hg-' + group.id });
      groupBox.appendChild(el('h3', { id: 'hg-' + group.id, text: group.label }));

      group.questions.forEach(function (q) {
        groupBox.appendChild(buildHealthQuestion(q));
      });
      slot.appendChild(groupBox);
    });
    slot.appendChild(buildTrust());
  }

  function buildHealthQuestion(q) {
    var current = state.health[q.id] || null;
    var box = el('div', { class: 'field health-q' });
    box.appendChild(el('p', { class: 'health-q-prompt', id: 'q-' + q.id, text: q.prompt }));

    var ynList = el('ul', { class: 'choice-list', role: 'radiogroup', 'aria-labelledby': 'q-' + q.id });
    [['no', 'No'], ['yes', 'Yes']].forEach(function (pair) {
      var id = 'q-' + q.id + '-' + pair[0];
      var input = el('input', {
        type: 'radio',
        name: 'q-' + q.id,
        id: id,
        value: pair[0],
        checked: current && current.indexOf(pair[0]) === 0,
        onchange: function () {
          // Reset to bare 'yes' / 'no'; follow-up handler will append ':<value>' if needed.
          state.health[q.id] = pair[0];
          renderFollowups();
        },
      });
      ynList.appendChild(el('li', null, [
        el('label', { class: 'choice', for: id }, [
          input,
          el('span', { class: 'choice-label', text: pair[1] }),
        ]),
      ]));
    });
    box.appendChild(ynList);

    var followupHost = el('div', { class: 'health-q-followups', 'data-followup-host': '' });
    box.appendChild(followupHost);

    function renderFollowups() {
      followupHost.innerHTML = '';
      var ans = state.health[q.id];
      if (!ans || ans.indexOf('yes') !== 0 || !q.followups_if_yes) return;
      q.followups_if_yes.forEach(function (fu, idx) {
        var fuBox = el('div', { class: 'field health-q-followup' });
        fuBox.appendChild(el('p', { class: 'health-q-followup-label', id: 'fu-' + q.id + '-' + idx, text: fu.prompt || 'When was this' }));
        var list = el('ul', { class: 'choice-list', role: 'radiogroup', 'aria-labelledby': 'fu-' + q.id + '-' + idx });
        (fu.options || []).forEach(function (opt) {
          var id = 'fu-' + q.id + '-' + idx + '-' + opt.value;
          var input = el('input', {
            type: 'radio',
            name: 'fu-' + q.id + '-' + idx,
            id: id,
            value: opt.value,
            checked: ans === 'yes:' + opt.value,
            onchange: function () { state.health[q.id] = 'yes:' + opt.value; },
          });
          list.appendChild(el('li', null, [
            el('label', { class: 'choice', for: id }, [
              input,
              el('span', { class: 'choice-label', text: opt.label }),
            ]),
          ]));
        });
        fuBox.appendChild(list);
        followupHost.appendChild(fuBox);
      });
    }
    renderFollowups();

    return box;
  }

  function validateHealth() {
    if (typeof HEALTH_QUESTIONS === 'undefined' || !HEALTH_QUESTIONS.groups) return 'Health questions did not load.';
    var unanswered = [];
    HEALTH_QUESTIONS.groups.forEach(function (g) {
      g.questions.forEach(function (q) {
        var ans = state.health[q.id];
        if (!ans) { unanswered.push(q.id); return; }
        if (ans.indexOf('yes') === 0 && q.followups_if_yes && q.followups_if_yes.length) {
          // Bare 'yes' with required follow-up = unanswered.
          if (ans === 'yes') unanswered.push(q.id);
        }
      });
    });
    if (unanswered.length) return 'Please answer every question. Missing: ' + unanswered.length + ' of them.';
    return null;
  }

  function buildTobaccoBuild(slot) {
    var tobList = el('ul', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Tobacco use' });
    [['no', 'No'], ['yes', 'Yes']].forEach(function (pair) {
      var id = 'fld-tob-' + pair[0];
      var input = el('input', {
        type: 'radio',
        name: 'tobacco',
        id: id,
        value: pair[0],
        checked: state.tobaccoBuild.tobacco === pair[0],
        onchange: function () { state.tobaccoBuild.tobacco = pair[0]; },
      });
      tobList.appendChild(el('li', null, [
        el('label', { class: 'choice', for: id }, [
          input,
          el('span', { class: 'choice-label', text: pair[1] }),
        ]),
      ]));
    });
    slot.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Have you used tobacco in the last 12 months' }),
      tobList,
    ]));

    var heightInput = el('input', {
      type: 'number',
      id: 'fld-height',
      min: '48',
      max: '84',
      inputmode: 'numeric',
      autocomplete: 'off',
      value: state.tobaccoBuild.heightIn != null ? String(state.tobaccoBuild.heightIn) : '',
      oninput: function (e) {
        var v = parseInt(e.target.value, 10);
        state.tobaccoBuild.heightIn = isNaN(v) ? null : v;
      },
    });
    slot.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'fld-height', text: 'Height (in inches)' }),
      heightInput,
      el('p', { class: 'field-help', text: '5\'8\" is 68 inches.' }),
    ]));

    var weightInput = el('input', {
      type: 'number',
      id: 'fld-weight',
      min: '70',
      max: '500',
      inputmode: 'numeric',
      autocomplete: 'off',
      value: state.tobaccoBuild.weightLb != null ? String(state.tobaccoBuild.weightLb) : '',
      oninput: function (e) {
        var v = parseInt(e.target.value, 10);
        state.tobaccoBuild.weightLb = isNaN(v) ? null : v;
      },
    });
    slot.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'fld-weight', text: 'Weight (in pounds)' }),
      weightInput,
    ]));

    slot.appendChild(buildTrust());
  }

  function validateTobaccoBuild() {
    if (state.tobaccoBuild.tobacco !== 'yes' && state.tobaccoBuild.tobacco !== 'no') {
      return 'Please tell us about tobacco use.';
    }
    // Height and weight are optional but if provided must be numeric and sane.
    if (state.tobaccoBuild.heightIn != null && (state.tobaccoBuild.heightIn < 48 || state.tobaccoBuild.heightIn > 84)) {
      return 'Please enter a height between 48 and 84 inches.';
    }
    if (state.tobaccoBuild.weightLb != null && (state.tobaccoBuild.weightLb < 70 || state.tobaccoBuild.weightLb > 500)) {
      return 'Please enter a weight between 70 and 500 pounds.';
    }
    return null;
  }

  function buildContact(form) {
    function field(id, label, type, opts) {
      opts = opts || {};
      var input = el('input', {
        type: type,
        id: id,
        name: id,
        autocomplete: opts.autocomplete || 'off',
        inputmode: opts.inputmode || null,
        maxlength: opts.maxlength || null,
        value: opts.value || '',
        oninput: opts.oninput,
      });
      return el('div', { class: 'field' }, [
        el('label', { class: 'field-label', for: id, text: label }),
        input,
        opts.help ? el('p', { class: 'field-help', text: opts.help }) : null,
      ]);
    }

    form.appendChild(field('fld-name', 'Full name', 'text', {
      autocomplete: 'name',
      value: state.contact.name,
      oninput: function (e) { state.contact.name = e.target.value.trim(); },
    }));
    form.appendChild(field('fld-email', 'Email', 'email', {
      autocomplete: 'email',
      value: state.contact.email,
      oninput: function (e) { state.contact.email = e.target.value.trim(); },
    }));
    form.appendChild(field('fld-phone', 'Phone', 'tel', {
      autocomplete: 'tel',
      inputmode: 'tel',
      maxlength: '20',
      value: state.contact.phone,
      help: '10 digits — we never sell your info.',
      oninput: function (e) { state.contact.phone = e.target.value.trim(); },
    }));
    form.appendChild(field('fld-zip', 'ZIP code', 'text', {
      autocomplete: 'postal-code',
      inputmode: 'numeric',
      maxlength: '5',
      value: state.contact.zip,
      oninput: function (e) { state.contact.zip = e.target.value.trim(); },
    }));
    form.appendChild(buildTrust());

    // Wire submit on the form itself; the visible "See my estimate" button
    // lives in .wizard-nav with form="contact-form" so it submits the form.
    if (!form.dataset.wizardWired) {
      form.dataset.wizardWired = '1';
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        handleContactSubmit();
      });
    }
  }

  function validateContact() {
    if (!state.contact.name || state.contact.name.length < 2) return 'Please enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.contact.email)) return 'Please enter a valid email address.';
    var digits = state.contact.phone.replace(/\D/g, '');
    if (digits.length !== 10) return 'Please enter a 10-digit phone number.';
    if (!/^\d{5}$/.test(state.contact.zip)) return 'Please enter a 5-digit ZIP code.';
    return null;
  }

  function buildTrust() {
    return el('p', { class: 'field-help wizard-trust', text: 'Estimates are illustrative — your actual rate is set by the carrier after underwriting. We never sell your info.' });
  }

  // -----------------------------------------------------------
  // Step transitions
  // -----------------------------------------------------------
  function showStep(idx) {
    state.stepIndex = idx;
    var stepId = STEPS[idx];

    STEPS.forEach(function (id, i) {
      var section = window.WizardSlots.step(id);
      if (!section) return;
      if (i === idx) {
        section.setAttribute('data-active', 'true');
      } else {
        section.removeAttribute('data-active');
      }
    });

    window.WizardSlots.progress(idx + 1, STEPS.length);

    // Re-render the step's fields fresh so state edits show.
    renderStepBody(stepId);

    // Move focus to the step heading for screen readers.
    var section = window.WizardSlots.step(stepId);
    if (section) {
      // tabindex="-1" is set in the HTML scaffold.
      try { section.focus({ preventScroll: false }); } catch (_) { section.focus(); }
      // Respect prefers-reduced-motion — 'smooth' would otherwise ignore the CSS
      // collapse and animate anyway. matchMedia is feature-detected for safety.
      var reduce = (typeof window !== 'undefined'
                    && window.matchMedia
                    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function renderStepBody(stepId) {
    if (stepId === 'about-you')      mountFields('about-you', buildAboutYou);
    else if (stepId === 'coverage')  mountFields('coverage',  buildCoverage);
    else if (stepId === 'health')    mountFields('health',    buildHealth);
    else if (stepId === 'tobacco-build') mountFields('tobacco-build', buildTobaccoBuild);
    else if (stepId === 'contact') {
      var section = window.WizardSlots.step('contact');
      if (!section) return;
      var form = section.querySelector('#contact-form');
      if (!form) return;
      form.innerHTML = '';
      buildContact(form);
    }
    // Results step is populated by handleContactSubmit().
  }

  function next() {
    var stepId = STEPS[state.stepIndex];
    var err = validateCurrentStep();
    if (err) { showError(stepId, err); return; }
    showError(stepId, null);

    if (state.stepIndex < STEPS.length - 1) {
      showStep(state.stepIndex + 1);
    }
  }

  function back() {
    if (state.stepIndex > 0) {
      showError(STEPS[state.stepIndex], null);
      showStep(state.stepIndex - 1);
    }
  }

  function restart() {
    // Soft reset — keeps health/contact values around for editing.
    showStep(0);
  }

  function validateCurrentStep() {
    var stepId = STEPS[state.stepIndex];
    if (stepId === 'about-you')      return validateAboutYou();
    if (stepId === 'coverage')       return validateCoverage();
    if (stepId === 'health')         return validateHealth();
    if (stepId === 'tobacco-build')  return validateTobaccoBuild();
    if (stepId === 'contact')        return validateContact();
    return null;
  }

  // -----------------------------------------------------------
  // Submit pipeline
  // -----------------------------------------------------------
  async function handleContactSubmit() {
    var err = validateContact();
    if (err) { showError('contact', err); return; }
    showError('contact', null);

    var conditions = (typeof answersToConditions === 'function')
      ? answersToConditions(state.health)
      : [];
    var summary = (typeof summarizeForLead === 'function')
      ? summarizeForLead(state.health)
      : '';

    var quoteResult = quoteFE({
      age: state.about.age,
      gender: state.about.gender,
      coverage: state.coverage.amount,
      tobacco: state.tobaccoBuild.tobacco === 'yes',
      payment: state.coverage.payment,
      conditions: conditions,
      heightIn: state.tobaccoBuild.heightIn || 0,
      weightLb: state.tobaccoBuild.weightLb || 0,
      contractLevel: 100,
    });
    state.quoteResult = quoteResult;

    // Top 3 by monthly asc among eligible non-declined; fall back to top 3
    // of the full set if every carrier is declined or filtered.
    var eligible = quoteResult.results
      .filter(function (r) { return r.eligible && r.approval !== 'declined'; })
      .sort(function (a, b) { return a.monthly - b.monthly; });
    var top = (eligible.length ? eligible : quoteResult.results.slice().sort(function (a, b) { return a.monthly - b.monthly; })).slice(0, 3);

    var monthlies = top.map(function (r) { return r.monthly; });
    var carriers = top.map(function (r) { return r.carrierLabel; });

    var leadParams = {
      lead_name:       state.contact.name,
      lead_age:        state.about.age,
      lead_zip:        state.contact.zip,
      lead_email:      state.contact.email,
      lead_phone:      state.contact.phone.replace(/\D/g, ''),
      coverage_amount: state.coverage.amount,
      tobacco:         state.tobaccoBuild.tobacco === 'yes',
      monthly_low:     monthlies.length ? Math.min.apply(null, monthlies) : null,
      monthly_high:    monthlies.length ? Math.max.apply(null, monthlies) : null,
      top_carrier_1:   carriers[0] || null,
      top_carrier_2:   carriers[1] || null,
      top_carrier_3:   carriers[2] || null,
      uw_summary:      summary,
      submitted_at:    new Date().toISOString(),
      source:          'client.html',
    };
    state.leadParams = leadParams;

    // Fire-and-render. The wizard always advances; Build B-2 will add real
    // error UX. The user must see their estimate even if the stub fails.
    submitLead(leadParams);

    // Render the cards into the results region using Phase 1C.
    var resultsRegion = document.getElementById('results-region');
    if (resultsRegion && typeof renderClientCardSet === 'function') {
      resultsRegion.innerHTML = '';
      renderClientCardSet(quoteResult, resultsRegion, { topN: 3 });
    }

    showStep(STEPS.indexOf('results'));
  }

  // -----------------------------------------------------------
  // Wire data-action buttons (back / next / restart)
  // -----------------------------------------------------------
  function wireNav() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('button[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'next')    { e.preventDefault(); next(); }
      else if (action === 'back')    { e.preventDefault(); back(); }
      else if (action === 'restart') { e.preventDefault(); restart(); }
      // 'submit' is handled via the form's submit event so Enter-to-submit
      // works inside the contact form fields.
    });

    // Enter-to-advance on non-form steps. The contact step is wrapped in
    // <form id="contact-form"> and submits natively; results has no inputs.
    // For about-you / coverage / health / tobacco-build, Enter inside a
    // numeric input or select calls next(). We skip textareas (preserve
    // newline) and let buttons keep their native Space/Enter behavior.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.isComposing) return; // IME composition
      var stepId = STEPS[state.stepIndex];
      if (stepId === 'contact' || stepId === 'results') return;
      var t = e.target;
      if (!t || !t.tagName) return;
      var tag = t.tagName.toUpperCase();
      if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA') return;
      if (tag !== 'INPUT' && tag !== 'SELECT') return;
      // Only act when the keypress originated inside the active step section.
      var section = window.WizardSlots.step(stepId);
      if (!section || !section.contains(t)) return;
      e.preventDefault();
      next();
    });
  }

  // -----------------------------------------------------------
  // Boot
  // -----------------------------------------------------------
  function boot() {
    if (!window.WizardSlots) {
      console.error('[wizard] WizardSlots missing — client.html scaffold did not load.');
      return;
    }
    wireNav();
    showStep(0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
