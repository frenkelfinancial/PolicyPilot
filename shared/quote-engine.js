// ============================================================
// shared/quote-engine.js — pure quote functions
// Extracted from index.html (Phase 0b, 2026-05-07).
//
// Inputs come in as plain objects, outputs are plain objects —
// no DOM, no alerts, no I/O. The agent dashboard and the client
// wizard both call these; rendering is each view's job.
//
// Result objects always include the agent-only fields (commPct,
// advComm). The render layer is responsible for stripping them
// before showing client cards. This keeps one engine for both
// surfaces and prevents drift.
// ============================================================

// ---- Helpers ----------------------------------------------------

function _interpFERate(age, gender, tobacco) {
  const tbl = FE_RATES.americo_eagle.rates;
  const gTob = gender==='M' ? (tobacco ? 1 : 0) : (tobacco ? 3 : 2);
  let lo=tbl[0], hi=tbl[tbl.length-1];
  for (let i=0; i<tbl.length-1; i++) {
    if (age>=tbl[i][0] && age<tbl[i+1][0]) { lo=tbl[i]; hi=tbl[i+1]; break; }
    if (age>=tbl[tbl.length-1][0]) { lo=hi=tbl[tbl.length-1]; break; }
  }
  const t = lo[0]===hi[0] ? 0 : (age-lo[0])/(hi[0]-lo[0]);
  return lo[gTob+1] + t*(hi[gTob+1]-lo[gTob+1]);
}

function _commPct(product, contractLevel, cut) {
  const tbl = COMP[product];
  if (!tbl) return contractLevel;
  let idx = COMP_LEVELS.indexOf(contractLevel);
  if (idx === -1) {
    idx = COMP_LEVELS.reduce((best,v,i) =>
      Math.abs(v-contractLevel) < Math.abs(COMP_LEVELS[best]-contractLevel) ? i : best, 0);
  }
  let pct = tbl[idx];
  if (cut) pct = +(pct * 0.6).toFixed(1);
  return pct;
}

function _checkBuildOk(heightIn, weightLb) {
  const lim = BUILD_LIMITS[heightIn];
  if (!lim || !weightLb) return true;
  return weightLb >= lim[0] && weightLb <= lim[1];
}

function _worstClass(classArr) {
  const rank = {decline:0,gi:1,oxygen:2,graded:2,rop:3,modified:4,check:4,stent:5,immediate:5,select2:6,standard:6,select1:7,preferred:7,level:7};
  return classArr.reduce((worst, c) => {
    const rw = rank[worst] ?? 7;
    const rc = rank[c] ?? 7;
    return rc < rw ? c : worst;
  }, 'level');
}

function classifyConditions(conditionKeys) {
  const carrierKeys = ['am','at','aa','tr','co'];
  const out = {};
  carrierKeys.forEach(k => {
    const classes = (conditionKeys || []).map(c => UW_CLASS[c]?.[k] || 'level');
    out[k] = _worstClass(classes);
  });
  return out;
}

function approvalFromClass(uwCls) {
  if (uwCls === 'decline') return 'declined';
  if (['gi','graded','rop','oxygen'].includes(uwCls)) return 'graded';
  if (['modified','check','stent','immediate'].includes(uwCls)) return 'non_instant';
  // 'select2' / 'standard' bump up to a higher rate band but the carrier
  // still issues — treat as instant-approved for the purpose of the badge.
  return 'approved';
}

// ---- FE quote ---------------------------------------------------

const _FE_CARRIERS = [
  { key:'americo',    uwKey:'am', label:'Americo',           dot:'#3b82f6', prodS1:'americo_eagle', prodGr:'americo_eagle', eapp:'Americo',           ccOk:false },
  { key:'aetna',      uwKey:'at', label:'Aetna / Accendo',   dot:'#10b981', prodS1:'aetna_senior',  prodGr:'aetna_senior',  eapp:'Aetna / Accendo',   ccOk:false },
  { key:'aamicable',  uwKey:'aa', label:'American-Amicable', dot:'#8b5cf6', prodS1:'aa_senior',     prodGr:'aa_senior',     eapp:'American-Amicable', ccOk:false },
  { key:'trans',      uwKey:'tr', label:'Transamerica',      dot:'#f59e0b', prodS1:'trans_express', prodGr:'trans_graded',  eapp:'Transamerica',      ccOk:true  },
  { key:'corebridge', uwKey:'co', label:'Corebridge',        dot:'#ec4899', prodS1:'core_siwl',     prodGr:'core_graded',   eapp:'Corebridge',        ccOk:true  },
  { key:'chubb',      uwKey:'am', label:'Chubb',             dot:'#14b8a6', prodS1:'chubb_pref',    prodGr:'chubb_graded',  eapp:'Chubb',             ccOk:false },
  { key:'mutual',     uwKey:'am', label:'Mutual of Omaha',   dot:'#06b6d4', prodS1:'mutual_fe',     prodGr:'mutual_fe',     eapp:'Mutual of Omaha',   ccOk:false },
];

function quoteFE(inputs) {
  const {
    age, gender, coverage, tobacco,
    payment = 'bank',
    conditions = [],
    heightIn = 0, weightLb = 0,
    contractLevel = 100,
  } = inputs || {};

  const buildFail = heightIn && weightLb ? !_checkBuildOk(heightIn, weightLb) : false;
  const baseRate = _interpFERate(age, gender, !!tobacco);
  const units = coverage / 1000;

  const carrierWorst = classifyConditions(conditions);
  if (buildFail) {
    // Push every carrier at least to select2 if the build chart fails.
    Object.keys(carrierWorst).forEach(k => {
      carrierWorst[k] = _worstClass([carrierWorst[k], 'select2']);
    });
  }

  const ccOnly = payment === 'cc';

  const results = _FE_CARRIERS.map(c => {
    const cm = CARRIER_MULTS[c.key] || CARRIER_MULTS.americo;
    const uwCls = carrierWorst[c.uwKey] || 'level';
    const approval = approvalFromClass(uwCls);

    const rateS1 = +(baseRate * cm.s1 * units).toFixed(2);
    const rateS2 = +(baseRate * cm.s2 * units).toFixed(2);
    const rateGr = +(baseRate * cm.gr * units).toFixed(2);

    let monthly = rateS1, isGraded = false;
    if (uwCls === 'select2' || uwCls === 'standard') monthly = rateS2;
    else if (['graded','rop','modified','gi','check','oxygen','immediate','stent'].includes(uwCls)) {
      monthly = rateGr; isGraded = true;
    }
    const annual = +(monthly * 12).toFixed(2);

    const commPct = isGraded
      ? _commPct(c.prodGr, contractLevel, true)
      : _commPct(c.prodS1, contractLevel, false);
    const advComm = +(annual * commPct / 100 * 0.75).toFixed(2);

    const ccOk = c.ccOk;
    const eligible = (!ccOnly || ccOk) && approval !== 'declined';

    return {
      carrierKey: c.key,
      carrierLabel: c.label,
      dot: c.dot,
      eappName: c.eapp,
      uwClass: uwCls,
      approval,
      monthly,
      annual,
      rates: { s1: rateS1, s2: rateS2, graded: rateGr },
      isGraded,
      eligible,
      ccOk,
      // AGENT-ONLY:
      commPct,
      advComm,
    };
  });

  const summary = {
    age, gender, coverage,
    tobacco: !!tobacco,
    payment,
    conditionsUsed: conditions.slice(),
    buildFail,
    carrierWorst,
  };

  return { summary, results };
}

// ---- Term quote -------------------------------------------------

const _TERM_CARRIERS = [
  { key:'americo',    label:'Americo',          dot:'#3b82f6', mult:1.00, prod:'americo_term', eapp:'Americo',           ccOk:false },
  { key:'aetna',      label:'Aetna / Accendo',  dot:'#10b981', mult:0.97, prod:'aetna_senior', eapp:'Aetna / Accendo',   ccOk:false },
  { key:'trans',      label:'Transamerica',     dot:'#f59e0b', mult:0.96, prod:'trans_express',eapp:'Transamerica',      ccOk:true  },
  { key:'chubb',      label:'Chubb',            dot:'#14b8a6', mult:0.99, prod:'chubb_pref',   eapp:'Chubb',             ccOk:false },
  { key:'ethos',      label:'Ethos',            dot:'#f97316', mult:1.02, prod:'ethos_tawl',   eapp:'Ethos',             ccOk:false },
  { key:'mutual',     label:'Mutual of Omaha',  dot:'#06b6d4', mult:1.01, prod:'mutual_fe',    eapp:'Mutual of Omaha',   ccOk:false },
  { key:'corebridge', label:'Corebridge',       dot:'#ec4899', mult:1.03, prod:'core_siwl',    eapp:'Corebridge',        ccOk:true  },
];

function quoteTerm(inputs) {
  const {
    age, gender, coverage, tobacco, term,
    payment = 'bank',
    conditions = [],
    contractLevel = 100,
  } = inputs || {};

  const carrierWorst = classifyConditions(conditions);
  const overallClass = _worstClass(Object.values(carrierWorst));

  let healthBand = 'preferred';
  if (['decline','gi','graded','rop','oxygen'].includes(overallClass)) healthBand = 'graded';
  else if (['select2','standard','modified','check','immediate','stent'].includes(overallClass)) healthBand = 'standard';

  const ageF  = Math.pow(1.048, Math.max(0, age - 30));
  const termF = {10:0.88, 15:1.0, 20:1.18, 25:1.36, 30:1.60}[term] || 1.0;
  const gF    = gender === 'M' ? 1.0 : 0.80;
  const tobF  = tobacco ? 2.60 : 1.0;
  const hF    = healthBand === 'preferred' ? 0.82 : healthBand === 'standard' ? 1.0 : 1.50;
  const baseAnnual = 1.10 * ageF * termF * gF * tobF * hF * (coverage / 1000);
  const isGraded = healthBand === 'graded';
  const ccOnly = payment === 'cc';

  const approval = isGraded ? 'graded'
    : (overallClass === 'modified' || overallClass === 'check') ? 'non_instant'
    : 'approved';

  const results = _TERM_CARRIERS.map(c => {
    const annual = +(baseAnnual * c.mult).toFixed(2);
    const monthly = +(annual / 12).toFixed(2);
    const commPct = _commPct(c.prod, contractLevel, isGraded);
    const advComm = +(annual * commPct / 100 * 0.75).toFixed(2);
    const ccOk = c.ccOk;
    const eligible = (!ccOnly || ccOk) && approval !== 'declined';
    return {
      carrierKey: c.key,
      carrierLabel: c.label,
      dot: c.dot,
      eappName: c.eapp,
      uwClass: overallClass,
      approval,
      monthly,
      annual,
      rates: { s1: monthly, s2: monthly, graded: monthly }, // term has no per-class rate split
      isGraded,
      eligible,
      ccOk,
      term,
      healthBand,
      commPct,
      advComm,
    };
  });

  const summary = {
    age, gender, coverage, term,
    tobacco: !!tobacco,
    payment,
    conditionsUsed: conditions.slice(),
    overallClass,
    healthBand,
  };

  return { summary, results };
}

// ---- IUL quote --------------------------------------------------

const _IUL_CARRIERS = [
  { key:'americo_iul', label:'Americo (Intelligent Health IUL)', dot:'#3b82f6', mult:1.00, prod:'aetna_iul',   eapp:'Americo' },
  { key:'mutual_iul',  label:'Mutual of Omaha (IULE)',           dot:'#06b6d4', mult:1.06, prod:'mutual_iule', eapp:'Mutual of Omaha' },
  { key:'ethos_iul',   label:'Ethos',                            dot:'#f97316', mult:0.98, prod:'ethos_tawl',  eapp:'Ethos' },
];

function quoteIUL(inputs) {
  const {
    age, gender, coverage, health = 'standard',
    contractLevel = 100,
  } = inputs || {};

  const hF   = {preferred:0.82, standard:1.0, substandard:1.35}[health] || 1.0;
  const gF   = gender === 'M' ? 1.0 : 0.84;
  const ageF = Math.pow(1.05, Math.max(0, age - 30));
  const base = 2.20 * ageF * gF * hF * (coverage / 1000);

  const approval = health === 'substandard' ? 'graded' : 'approved';

  const results = _IUL_CARRIERS.map(c => {
    const minMonthly = +(base * c.mult).toFixed(2);
    const recMonthly = +(minMonthly * 1.55).toFixed(2);
    const annual = +(recMonthly * 12).toFixed(2);
    const commPct = _commPct(c.prod, contractLevel, false);
    const advComm = +(annual * commPct / 100 * 0.75).toFixed(2);
    return {
      carrierKey: c.key,
      carrierLabel: c.label,
      dot: c.dot,
      eappName: c.eapp,
      approval,
      monthly: recMonthly,
      annual,
      rates: { min: minMonthly, recommended: recMonthly },
      eligible: true,
      ccOk: false,
      commPct,
      advComm,
    };
  });

  const summary = { age, gender, coverage, health };
  return { summary, results };
}
