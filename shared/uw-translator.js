// ============================================================
// shared/uw-translator.js
// Translates structured client wizard health answers into the
// exact UW_CLASS condition strings consumed by quoteFE().
//
// Phase 1 Agent B output, per docs/client-build-b.md.
// Front-end only. Pure data + pure functions. No DOM, no fetch.
//
// Source-of-truth contract:
// ------------------------
// shared/health-questions.json is the canonical question tree.
// HEALTH_QUESTIONS below is an INLINE COPY of that JSON. We do
// not fetch the .json at runtime because client.html may be
// opened over file:// where fetch fails. When the JSON is
// updated, paste the new contents over the HEALTH_QUESTIONS
// literal below — that is the deliberate maintenance ritual.
//
// Validator: on script load we walk every uw_map and console.error
// any string that is not a key in UW_CLASS (loaded from
// shared/data.js, which must be included BEFORE this file).
// We log and continue — never throw — so a single drifted key
// does not take down the wizard while a developer fixes it.
//
// Answer-key convention (matches health-questions.json __convention):
//   "no"                  -> answered no, no follow-ups taken
//   "yes"                 -> answered yes, no follow-ups exist
//   "yes:<value>"         -> answered yes with one follow-up choice
//   "yes:<v1>+<v2>+...    -> multiple follow-ups joined with "+"
//                            in the order they were declared
// ============================================================

var HEALTH_QUESTIONS = {
  "version": 1,
  "__convention": "uw_map keys encode the answer path. 'no' = answered no (no follow-ups). 'yes' = answered yes with no follow-up question. 'yes:<value>' = answered yes plus single follow-up choice value. 'yes:<value1>+<value2>' = answered yes plus multiple follow-up choices joined with '+' in declared follow-up order. Every value in every uw_map array MUST be an exact key from UW_CLASS in shared/data.js — uw-translator.js validates on load and console.errors any drift.",
  "groups": [
    {
      "id": "heart",
      "label": "Heart and circulation",
      "questions": [
        {
          "id": "heart_event",
          "prompt": "Have you ever had a heart attack, heart surgery, bypass, stent, pacemaker, or defibrillator?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "heart_event_when",
              "type": "choice",
              "label": "When was the most recent one?",
              "options": [
                { "value": "lt2",  "label": "Less than 2 years ago" },
                { "value": "gte2", "label": "2 or more years ago" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:lt2":  ["Heart Attack (within 2 yrs)", "Heart Surgery (within 2 yrs)", "Stent (within 2 yrs)", "Pacemaker / Defibrillator (within 2 yrs)"],
            "yes:gte2": ["Heart Attack (2+ yrs ago)", "Heart Surgery (2+ yrs ago)", "Stent (2+ yrs ago)", "Pacemaker / Defibrillator (2+ yrs ago)"]
          }
        },
        {
          "id": "heart_other",
          "prompt": "Has a doctor told you that you have congestive heart failure, coronary artery disease, an aneurysm, or an irregular heartbeat?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "heart_other_which",
              "type": "choice",
              "label": "Which one fits best?",
              "options": [
                { "value": "chf",     "label": "Congestive heart failure" },
                { "value": "cad",     "label": "Coronary artery disease" },
                { "value": "aneur",   "label": "Aneurysm" },
                { "value": "afib",    "label": "Irregular heartbeat or AFib" },
                { "value": "clots",   "label": "Blood clots" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:chf":   ["Congestive Heart Failure"],
            "yes:cad":   ["Coronary Artery Disease"],
            "yes:aneur": ["Aneurysm"],
            "yes:afib":  ["AFIB / Irregular Heartbeat"],
            "yes:clots": ["Blood Clots"]
          }
        }
      ]
    },
    {
      "id": "lung",
      "label": "Lungs and breathing",
      "questions": [
        {
          "id": "lung_condition",
          "prompt": "Do you have a long-term lung condition like COPD, emphysema, chronic bronchitis, or pulmonary fibrosis?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "lung_which",
              "type": "choice",
              "label": "Which one is it?",
              "options": [
                { "value": "copd_inhaler", "label": "COPD or emphysema, inhaler only" },
                { "value": "copd_oxygen",  "label": "COPD or emphysema, on oxygen" },
                { "value": "bronchitis",   "label": "Chronic bronchitis" },
                { "value": "fibrosis",     "label": "Pulmonary fibrosis" },
                { "value": "asthma",       "label": "Chronic asthma" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:copd_inhaler": ["COPD (Inhaler — no oxygen)"],
            "yes:copd_oxygen":  ["COPD (On Oxygen)", "Oxygen Use (not CPAP)"],
            "yes:bronchitis":   ["Bronchitis (Chronic)"],
            "yes:fibrosis":     ["Pulmonary Fibrosis", "Oxygen Use (not CPAP)"],
            "yes:asthma":       ["Asthma (Chronic)"]
          }
        },
        {
          "id": "sleep_apnea",
          "prompt": "Do you use a CPAP machine for sleep apnea?",
          "type": "yes_no",
          "uw_map": {
            "no": [],
            "yes": ["Sleep Apnea (CPAP OK)"]
          }
        }
      ]
    },
    {
      "id": "diabetes",
      "label": "Diabetes",
      "questions": [
        {
          "id": "diabetes",
          "prompt": "Do you have diabetes?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "diabetes_type",
              "type": "choice",
              "label": "Which best describes it?",
              "options": [
                { "value": "t2_ctrl",   "label": "Type 2, well controlled, no insulin (A1C 8.6 or lower)" },
                { "value": "t2_unctrl", "label": "Type 2, not well controlled or A1C above 8.6" },
                { "value": "t1_ins",    "label": "Type 1, or take insulin" },
                { "value": "complic",   "label": "Has caused complications like nerve or eye damage" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:t2_ctrl":   ["Diabetes Type 2 — Controlled (A1C ≤ 8.6, no insulin)"],
            "yes:t2_unctrl": ["Diabetes Type 2 — Uncontrolled or A1C > 8.6"],
            "yes:t1_ins":    ["Diabetes Type 1 / On Insulin"],
            "yes:complic":   ["Diabetic Complications (neuropathy/retinopathy)"]
          }
        }
      ]
    },
    {
      "id": "cancer",
      "label": "Cancer",
      "questions": [
        {
          "id": "cancer",
          "prompt": "Have you ever been diagnosed with or treated for cancer (other than basal cell skin cancer)?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "cancer_when",
              "type": "choice",
              "label": "When was your most recent treatment?",
              "options": [
                { "value": "active",  "label": "Currently in treatment, or finished within the last 2 years" },
                { "value": "mid",     "label": "Last treatment was 2 to 4 years ago" },
                { "value": "long",    "label": "More than 4 years ago, cancer free since" },
                { "value": "basal",   "label": "Only basal cell skin cancer" },
                { "value": "mel_new", "label": "Melanoma within the last 3 years" },
                { "value": "mel_old", "label": "Melanoma more than 3 years ago" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:active":  ["Cancer — Active or Treatment within 2 yrs"],
            "yes:mid":     ["Cancer — Last Treatment 2–4 yrs ago"],
            "yes:long":    ["Cancer — 4+ yrs cancer free"],
            "yes:basal":   ["Cancer — Basal Cell Skin Only"],
            "yes:mel_new": ["Melanoma (within 3 yrs)"],
            "yes:mel_old": ["Melanoma (3+ yrs ago)"]
          }
        }
      ]
    },
    {
      "id": "neuro",
      "label": "Brain, memory, and nerves",
      "questions": [
        {
          "id": "neuro_serious",
          "prompt": "Have you been diagnosed with memory loss, dementia, Alzheimer's, ALS, Parkinson's, multiple sclerosis, Huntington's, or cerebral palsy?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "neuro_which",
              "type": "choice",
              "label": "Which one fits best?",
              "options": [
                { "value": "demen",   "label": "Memory loss, dementia, or Alzheimer's" },
                { "value": "als",     "label": "ALS (Lou Gehrig's)" },
                { "value": "park",    "label": "Parkinson's" },
                { "value": "ms",      "label": "Multiple sclerosis (MS)" },
                { "value": "hunt",    "label": "Huntington's disease" },
                { "value": "cp",      "label": "Cerebral palsy" },
                { "value": "cog",     "label": "Other cognitive impairment" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:demen": ["Alzheimer's / Dementia / Memory Loss"],
            "yes:als":   ["ALS (Lou Gehrig's)"],
            "yes:park":  ["Parkinson's Disease"],
            "yes:ms":    ["Multiple Sclerosis (MS)"],
            "yes:hunt":  ["Huntington's Disease"],
            "yes:cp":    ["Cerebral Palsy"],
            "yes:cog":   ["Mental Incapacity / Cognitive Impairment"]
          }
        },
        {
          "id": "seizures",
          "prompt": "Have you had a seizure or been treated for epilepsy?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "seizures_when",
              "type": "choice",
              "label": "When was the most recent one?",
              "options": [
                { "value": "lt3",  "label": "Within the last 3 years" },
                { "value": "gte3", "label": "More than 3 years ago" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:lt3":  ["Epilepsy / Seizures (within 3 yrs)"],
            "yes:gte3": ["Epilepsy / Seizures (3+ yrs)"]
          }
        }
      ]
    },
    {
      "id": "liver_kidney",
      "label": "Liver, kidney, and digestive",
      "questions": [
        {
          "id": "liver_kidney",
          "prompt": "Do you have liver disease, kidney disease, hepatitis, cirrhosis, or are you on dialysis?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "liver_kidney_which",
              "type": "choice",
              "label": "Which best fits?",
              "options": [
                { "value": "dialysis", "label": "On dialysis" },
                { "value": "kidney",   "label": "Kidney disease or kidney failure" },
                { "value": "liver",    "label": "Liver disease or liver failure" },
                { "value": "cirr",     "label": "Cirrhosis" },
                { "value": "hepa",     "label": "Hepatitis A" },
                { "value": "hepb",     "label": "Hepatitis B" },
                { "value": "hepc",     "label": "Hepatitis C" },
                { "value": "panc",     "label": "Pancreatitis" },
                { "value": "crohns",   "label": "Crohn's or ulcerative colitis" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:dialysis": ["Dialysis"],
            "yes:kidney":   ["Kidney Disease / Kidney Failure"],
            "yes:liver":    ["Liver Disease / Liver Failure"],
            "yes:cirr":     ["Cirrhosis"],
            "yes:hepa":     ["Hepatitis A"],
            "yes:hepb":     ["Hepatitis B"],
            "yes:hepc":     ["Hepatitis C"],
            "yes:panc":     ["Pancreatitis"],
            "yes:crohns":   ["Crohn's Disease", "Ulcerative Colitis"]
          }
        }
      ]
    },
    {
      "id": "mental",
      "label": "Mental health",
      "questions": [
        {
          "id": "mental",
          "prompt": "Are you currently being treated for depression, bipolar disorder, schizophrenia, or PTSD?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "mental_which",
              "type": "choice",
              "label": "Which one?",
              "options": [
                { "value": "dep",    "label": "Depression" },
                { "value": "bipo",   "label": "Bipolar disorder" },
                { "value": "schiz",  "label": "Schizophrenia" },
                { "value": "ptsd",   "label": "PTSD" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:dep":   ["Depression"],
            "yes:bipo":  ["Bipolar Disorder"],
            "yes:schiz": ["Schizophrenia"],
            "yes:ptsd":  ["PTSD"]
          }
        }
      ]
    },
    {
      "id": "mobility",
      "label": "Mobility and daily living",
      "questions": [
        {
          "id": "mobility",
          "prompt": "Do you use a wheelchair, scooter, walker, or live in a nursing home or assisted-living facility?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "mobility_which",
              "type": "choice",
              "label": "Which fits best?",
              "options": [
                { "value": "wheel",     "label": "Wheelchair, scooter, or electric cart" },
                { "value": "walker",    "label": "Walker" },
                { "value": "facility",  "label": "Nursing home or assisted living" },
                { "value": "amp_dis",   "label": "Amputation due to diabetes or disease" },
                { "value": "amp_traum", "label": "Amputation due to an accident" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:wheel":     ["Wheelchair / Scooter / Electric Cart"],
            "yes:walker":    ["Walker Use"],
            "yes:facility":  ["Assisted Living / Long-Term Care Facility"],
            "yes:amp_dis":   ["Amputation (due to diabetes or disease)"],
            "yes:amp_traum": ["Amputation (trauma)"]
          }
        }
      ]
    },
    {
      "id": "lifestyle",
      "label": "Tobacco, alcohol, and drug use",
      "questions": [
        {
          "id": "tobacco",
          "prompt": "Have you used tobacco, vapes, or nicotine products in the last 12 months?",
          "type": "yes_no",
          "uw_map": {
            "no": [],
            "yes": []
          }
        },
        {
          "id": "substance",
          "prompt": "In the last 2 years, have you been treated for alcohol or drug abuse, or used illegal drugs?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "substance_when",
              "type": "choice",
              "label": "When was the most recent?",
              "options": [
                { "value": "lt2",  "label": "Within the last 2 years" },
                { "value": "gte2", "label": "2 or more years clean" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:lt2":  ["Alcohol or Drug Abuse (within 2 yrs)", "Illegal Drug Use (within 2 yrs)"],
            "yes:gte2": ["Alcohol or Drug Abuse (2+ yrs clean)", "Illegal Drug Use (2+ yrs clean)"]
          }
        }
      ]
    },
    {
      "id": "hospital",
      "label": "Recent hospital and prescriptions",
      "questions": [
        {
          "id": "narcotics",
          "prompt": "Do you fill a narcotic pain medication 6 or more times per month?",
          "type": "yes_no",
          "uw_map": {
            "no": [],
            "yes": ["Chronic Narcotic Pain Medications (6+ fills/month)"]
          }
        }
      ]
    },
    {
      "id": "terminal",
      "label": "Terminal illness and transplant",
      "questions": [
        {
          "id": "terminal",
          "prompt": "Has a doctor told you that you have a terminal illness with a life expectancy of 12 months or less?",
          "type": "yes_no",
          "uw_map": {
            "no": [],
            "yes": ["Terminal Illness (death expected within 12 months)"]
          }
        },
        {
          "id": "transplant",
          "prompt": "Have you ever received an organ transplant or bone marrow transplant, or been diagnosed with HIV, AIDS, or sickle cell anemia?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "transplant_which",
              "type": "choice",
              "label": "Which fits best?",
              "options": [
                { "value": "organ",  "label": "Organ transplant" },
                { "value": "marrow", "label": "Bone marrow transplant" },
                { "value": "hiv",    "label": "HIV, AIDS, or ARC" },
                { "value": "sickle", "label": "Sickle cell anemia" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:organ":  ["Organ Transplant"],
            "yes:marrow": ["Bone Marrow Transplant"],
            "yes:hiv":    ["HIV / AIDS / ARC"],
            "yes:sickle": ["Sickle Cell Anemia"]
          }
        }
      ]
    },
    {
      "id": "other",
      "label": "Other conditions",
      "questions": [
        {
          "id": "other_chronic",
          "prompt": "Do you have any of these other long-term conditions: lupus, rheumatoid arthritis, a blood disorder like hemophilia, or sarcoidosis?",
          "type": "yes_no",
          "followups_if_yes": [
            {
              "id": "other_which",
              "type": "choice",
              "label": "Which fits best?",
              "options": [
                { "value": "lupus",  "label": "Lupus (SLE)" },
                { "value": "ra",     "label": "Rheumatoid arthritis" },
                { "value": "blood",  "label": "Blood disorder (hemophilia, low platelets)" },
                { "value": "sarc",   "label": "Sarcoidosis" }
              ]
            }
          ],
          "uw_map": {
            "no": [],
            "yes:lupus": ["Lupus (SLE)"],
            "yes:ra":    ["Rheumatoid Arthritis"],
            "yes:blood": ["Blood Disorder (Hemophilia / Thrombocytopenia)"],
            "yes:sarc":  ["Sarcoidosis"]
          }
        }
      ]
    }
  ]
};

// ------------------------------------------------------------
// Validator — runs once on script load.
// Walks every uw_map value and confirms each string is a key in
// UW_CLASS. Logs each offender with question id, answer key, and
// the offending UW string. Does NOT throw — wizard keeps running
// while the dev fixes the drift.
// ------------------------------------------------------------
(function validateHealthQuestions() {
  if (typeof UW_CLASS === 'undefined' || UW_CLASS === null) {
    console.error('[uw-translator] UW_CLASS not loaded. shared/data.js must be included before shared/uw-translator.js.');
    return;
  }
  var groups = (HEALTH_QUESTIONS && HEALTH_QUESTIONS.groups) || [];
  for (var gi = 0; gi < groups.length; gi++) {
    var qs = groups[gi].questions || [];
    for (var qi = 0; qi < qs.length; qi++) {
      var q = qs[qi];
      var map = q.uw_map || {};
      for (var ans in map) {
        if (!Object.prototype.hasOwnProperty.call(map, ans)) continue;
        var arr = map[ans] || [];
        for (var i = 0; i < arr.length; i++) {
          var s = arr[i];
          if (!Object.prototype.hasOwnProperty.call(UW_CLASS, s)) {
            console.error(
              '[uw-translator] uw_map drift: question="' + q.id +
              '" answer="' + ans +
              '" offending UW string="' + s +
              '" (not a key in UW_CLASS).'
            );
          }
        }
      }
    }
  }
})();

// ------------------------------------------------------------
// answersToConditions(answers)
// answers: { [questionId]: 'no' | 'yes' | 'yes:<value>' | 'yes:<v1>+<v2>' }
// returns: string[] of UW_CLASS keys, deduplicated, in encounter order
// Unknown question ids and unknown answer keys are silently skipped
// (the wizard treats missing answers as "no" — same effect).
// ------------------------------------------------------------
function answersToConditions(answers) {
  var out = [];
  var seen = {};
  if (!answers || typeof answers !== 'object') return out;
  var groups = (HEALTH_QUESTIONS && HEALTH_QUESTIONS.groups) || [];
  for (var gi = 0; gi < groups.length; gi++) {
    var qs = groups[gi].questions || [];
    for (var qi = 0; qi < qs.length; qi++) {
      var q = qs[qi];
      var ans = answers[q.id];
      if (ans == null) continue;
      var conds = (q.uw_map || {})[ans];
      if (!conds) continue;
      for (var i = 0; i < conds.length; i++) {
        var c = conds[i];
        if (!seen[c]) {
          seen[c] = true;
          out.push(c);
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// summarizeForLead(answers)
// returns: one-line plain-language summary string (used in the
// dev-console stub log now and in the EmailJS body in Build B-2).
// Tobacco status is reported even though it is not a UW_CLASS
// key — the lead reviewer needs it for context.
// ------------------------------------------------------------
function summarizeForLead(answers) {
  var conds = answersToConditions(answers);
  var parts = [];
  if (conds.length) {
    // Convert canonical strings to compact phrases for the summary.
    var phrases = conds.map(function (c) {
      return _summarizeCondition(c);
    });
    // Dedupe phrases (some carriers' condition pairs collapse to one phrase).
    var seenP = {};
    var uniq = [];
    for (var i = 0; i < phrases.length; i++) {
      if (!seenP[phrases[i]]) { seenP[phrases[i]] = true; uniq.push(phrases[i]); }
    }
    parts.push(uniq.join('; '));
  } else {
    parts.push('No flagged conditions');
  }
  // Tobacco rider — explicit because UW_CLASS does not encode it.
  if (answers && answers.tobacco === 'yes') {
    parts.push('tobacco user');
  } else if (answers && answers.tobacco === 'no') {
    parts.push('non-smoker');
  }
  return parts.join('; ');
}

// Internal: condense a canonical UW string into a short phrase.
// Keeps the summary readable in a single email-body line without
// stripping any underwriting meaning.
function _summarizeCondition(c) {
  switch (c) {
    // Heart
    case 'Heart Attack (within 2 yrs)':              return 'recent heart attack';
    case 'Heart Attack (2+ yrs ago)':                return 'past heart attack';
    case 'Heart Surgery (within 2 yrs)':             return 'recent heart surgery';
    case 'Heart Surgery (2+ yrs ago)':               return 'past heart surgery';
    case 'Stent (within 2 yrs)':                     return 'recent stent';
    case 'Stent (2+ yrs ago)':                       return 'past stent';
    case 'Pacemaker / Defibrillator (within 2 yrs)': return 'recent pacemaker';
    case 'Pacemaker / Defibrillator (2+ yrs ago)':   return 'past pacemaker';
    case 'Congestive Heart Failure':                 return 'CHF';
    case 'Coronary Artery Disease':                  return 'CAD';
    case 'Aneurysm':                                 return 'aneurysm';
    case 'AFIB / Irregular Heartbeat':               return 'AFib';
    case 'Blood Clots':                              return 'blood clots';
    // Lung
    case 'COPD (Inhaler — no oxygen)':               return 'COPD on inhaler';
    case 'COPD (On Oxygen)':                         return 'COPD on oxygen';
    case 'Bronchitis (Chronic)':                     return 'chronic bronchitis';
    case 'Pulmonary Fibrosis':                       return 'pulmonary fibrosis';
    case 'Asthma (Chronic)':                         return 'chronic asthma';
    case 'Sleep Apnea (CPAP OK)':                    return 'sleep apnea (CPAP)';
    case 'Oxygen Use (not CPAP)':                    return 'oxygen use';
    // Diabetes
    case 'Diabetes Type 2 — Controlled (A1C ≤ 8.6, no insulin)': return 'type-2 diabetes controlled';
    case 'Diabetes Type 2 — Uncontrolled or A1C > 8.6':           return 'type-2 diabetes uncontrolled';
    case 'Diabetes Type 1 / On Insulin':                          return 'type-1 / insulin-dependent diabetes';
    case 'Diabetic Complications (neuropathy/retinopathy)':       return 'diabetic complications';
    // Cancer
    case 'Cancer — Active or Treatment within 2 yrs':            return 'active cancer';
    case 'Cancer — Last Treatment 2–4 yrs ago':                  return 'cancer 2–4 yrs ago';
    case 'Cancer — 4+ yrs cancer free':                          return 'cancer 4+ yrs clear';
    case 'Cancer — Basal Cell Skin Only':                        return 'basal cell skin cancer';
    case 'Melanoma (within 3 yrs)':                              return 'recent melanoma';
    case 'Melanoma (3+ yrs ago)':                                return 'past melanoma';
    // Neuro
    case "Alzheimer's / Dementia / Memory Loss":                 return 'dementia';
    case "ALS (Lou Gehrig's)":                                    return 'ALS';
    case "Parkinson's Disease":                                   return "Parkinson's";
    case 'Multiple Sclerosis (MS)':                               return 'MS';
    case "Huntington's Disease":                                  return "Huntington's";
    case 'Cerebral Palsy':                                        return 'cerebral palsy';
    case 'Mental Incapacity / Cognitive Impairment':              return 'cognitive impairment';
    case 'Epilepsy / Seizures (within 3 yrs)':                    return 'recent seizures';
    case 'Epilepsy / Seizures (3+ yrs)':                          return 'past seizures';
    // Liver / kidney / digestive
    case 'Dialysis':                                              return 'dialysis';
    case 'Kidney Disease / Kidney Failure':                       return 'kidney disease';
    case 'Liver Disease / Liver Failure':                         return 'liver disease';
    case 'Cirrhosis':                                             return 'cirrhosis';
    case 'Hepatitis A':                                           return 'hep A';
    case 'Hepatitis B':                                           return 'hep B';
    case 'Hepatitis C':                                           return 'hep C';
    case 'Pancreatitis':                                          return 'pancreatitis';
    case "Crohn's Disease":                                       return "Crohn's";
    case 'Ulcerative Colitis':                                    return 'ulcerative colitis';
    // Mental
    case 'Depression':                                            return 'depression';
    case 'Bipolar Disorder':                                      return 'bipolar';
    case 'Schizophrenia':                                         return 'schizophrenia';
    case 'PTSD':                                                  return 'PTSD';
    // Mobility
    case 'Wheelchair / Scooter / Electric Cart':                  return 'wheelchair use';
    case 'Walker Use':                                            return 'walker use';
    case 'Assisted Living / Long-Term Care Facility':             return 'assisted living';
    case 'Amputation (due to diabetes or disease)':               return 'amputation (medical)';
    case 'Amputation (trauma)':                                   return 'amputation (trauma)';
    // Lifestyle
    case 'Alcohol or Drug Abuse (within 2 yrs)':                  return 'recent alcohol/drug abuse';
    case 'Alcohol or Drug Abuse (2+ yrs clean)':                  return 'alcohol/drug abuse (2+ yrs clean)';
    case 'Illegal Drug Use (within 2 yrs)':                       return 'recent illegal drug use';
    case 'Illegal Drug Use (2+ yrs clean)':                       return 'illegal drug use (2+ yrs clean)';
    // Terminal / transplant
    case 'Terminal Illness (death expected within 12 months)':    return 'terminal illness';
    case 'Organ Transplant':                                      return 'organ transplant';
    case 'Bone Marrow Transplant':                                return 'bone marrow transplant';
    case 'HIV / AIDS / ARC':                                      return 'HIV/AIDS';
    case 'Sickle Cell Anemia':                                    return 'sickle cell';
    // Other chronic
    case 'Lupus (SLE)':                                           return 'lupus';
    case 'Rheumatoid Arthritis':                                  return 'rheumatoid arthritis';
    case 'Blood Disorder (Hemophilia / Thrombocytopenia)':        return 'blood disorder';
    case 'Sarcoidosis':                                           return 'sarcoidosis';
    // Prescriptions
    case 'Chronic Narcotic Pain Medications (6+ fills/month)':    return 'chronic narcotics';
    default:
      return c;
  }
}
