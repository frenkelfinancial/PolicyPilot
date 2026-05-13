// ============================================================
// shared/data.js — Carrier rate, comp, UW, and build tables
// Extracted from index.html (Phase 0a, 2026-05-07).
// Loaded by both the agent dashboard (index.html) and the
// client wizard (client.html). EAPP_URLS stays inline in
// index.html — agent-only, never ships to the public file.
// ============================================================

// Map contract level → commission % per product
// contract levels: 80,85,90,95,100,105,110,115,120,125,130,135,140,145
var COMP_LEVELS = [80,85,90,95,100,105,110,115,120,125,130,135,140,145];

// Commission table: rows = product, cols = contract level (80..145)
// All values from the compensation guide image provided
var COMP = {
  // AMERICO
  'americo_eagle':   [75,80,85,90,95,100,105,110,115,120,125,130,135,135],
  'americo_term':    [80,85,90,95,100,105,110,115,120,125,130,135,140,145],
  'americo_wl':      [70,70,77.5,85,92.5,100,107.5,115,120,125,130,137,144,144],
  // AETNA
  'aetna_senior':    [65,70,75,80,85,90,95,100,105,110,115,120,125,125],
  'aetna_iul':       [45,50,55,60,70,70,75,80,85,90,95,100,105,105],
  // AMERICAN AMICABLE
  'aa_senior':       [65,70,75,80,85,90,95,100,105,110,115,120,125,125],
  // TRANSAMERICA
  'trans_express':   [80,85,90,95,100,105,110,115,120,125,130,135,140,140],
  'trans_graded':    [40,45,50,55,60,65,70,75,80,85,90,95,100,100],
  'trans_ff':        [50,55,60,65,70,75,80,85,90,95,100,105,110,110],
  // COREBRIDGE
  'core_siwl':       [72,77,82,87,92,97,102,107,112,117,122,127,132,132],
  'core_graded':     [45,45,47.5,47.5,50,52.5,55,57.5,60,62.5,65,67.5,70,70],
  'core_giwl':       [55,55,57.5,57.5,60,62.5,65,67.5,70,72.5,75,77.5,80,80],
  // MUTUAL OF OMAHA
  'mutual_fe':       [70,74,78,82,86,90,95,100,105,110,115,120,125,125],
  'mutual_iule':     [70,75,80,85,90,95,100,105,110,115,120,125,130,130],
  'mutual_child':    [50,55,60,65,70,75,80,85,90,92,95,97,100,100],
  // ETHOS
  'ethos_tawl':      [72.5,75,77.5,80,82.5,85,90,95,100,105,110,115,120,120],
  // CHUBB (by health class, shown at contract 100 — need to interpolate)
  // Chubb Preferred Ages 0-75
  'chubb_pref':      [65,70,75,80,85,90,95,100,105,110,115,120,125,130],
  'chubb_std':       [56,60,65,69,73,78,82,86,91,95,99,104,108,112],
  'chubb_sub':       [52,56,60,64,68,72,76,80,84,88,92,96,100,104],
  'chubb_graded':    [32,35,37,40,43,45,48,50,53,55,58,60,63,65],
};

// ============================================================
// RATE ENGINE — Final Expense
// Monthly premium per $1,000 face amount
// Sourced from published FE rate structures (industry standard approximation)
// These match typical Americo Eagle Select, Transamerica Express, etc.
// ============================================================
var FE_RATES = {
  // [age_bracket, M_nt, M_tb, F_nt, F_tb] per $1000/mo
  // Ages 40-90 in 5yr bands. Rates are for SELECT/LEVEL class.
  // GRADED adds ~40-50%, GI/ROP adds ~65-80%
  americo_eagle: {
    //  age  M-NT    M-TB   F-NT   F-TB
    rates: [
      [40, 1.95, 2.78, 1.48, 2.11],
      [45, 2.47, 3.52, 1.87, 2.67],
      [50, 3.24, 4.62, 2.46, 3.51],
      [55, 4.28, 6.10, 3.24, 4.62],
      [60, 5.73, 8.16, 4.34, 6.18],
      [65, 7.89, 11.25, 5.97, 8.51],
      [70, 11.04, 15.73, 8.35, 11.90],
      [75, 15.87, 22.62, 12.00, 17.11],
      [80, 23.51, 33.52, 17.79, 25.35],
      [85, 34.83, 49.63, 26.36, 37.56],
      [90, 51.62, 73.55, 39.05, 55.65],
    ],
    products: ['eagle_select','standard']
  },
};

// Per carrier, rates relative to Americo Eagle as 1.0 baseline
// Multipliers for: [select1, select2_or_std, graded_or_modified]
var CARRIER_MULTS = {
  americo:    { label:'Americo (Eagle Select)',    dot:'#3b82f6', s1:1.00, s2:1.14, gr:1.52, prod_s1:'americo_eagle', prod_gr:'americo_eagle', compS1:'americo_eagle', compGr:'americo_eagle', age_max:85 },
  aetna:      { label:'Aetna / Accendo',           dot:'#10b981', s1:0.97, s2:1.11, gr:1.48, prod_s1:'aetna_senior', prod_gr:'aetna_senior',   compS1:'aetna_senior',  compGr:'aetna_senior',  age_max:85 },
  aamicable:  { label:'American-Amicable',         dot:'#8b5cf6', s1:1.01, s2:1.16, gr:1.54, prod_s1:'aa_senior',    prod_gr:'aa_senior',     compS1:'aa_senior',     compGr:'aa_senior',     age_max:80 },
  trans:      { label:'Transamerica Express',      dot:'#f59e0b', s1:0.96, s2:1.10, gr:1.45, prod_s1:'trans_express',prod_gr:'trans_graded',  compS1:'trans_express', compGr:'trans_graded',  age_max:85 },
  corebridge: { label:'Corebridge (SIWL)',          dot:'#ec4899', s1:1.03, s2:1.18, gr:1.62, prod_s1:'core_siwl',   prod_gr:'core_graded',   compS1:'core_siwl',     compGr:'core_graded',   age_max:85 },
  chubb:      { label:'Chubb',                     dot:'#14b8a6', s1:0.99, s2:1.13, gr:1.58, prod_s1:'chubb_pref',  prod_gr:'chubb_graded',  compS1:'chubb_pref',    compGr:'chubb_graded',  age_max:80 },
  mutual:     { label:'Mutual of Omaha (FE)',       dot:'#06b6d4', s1:1.00, s2:1.13, gr:1.50, prod_s1:'mutual_fe',   prod_gr:'mutual_fe',     compS1:'mutual_fe',     compGr:'mutual_fe',     age_max:85 },
};

// ============================================================
// UNDERWRITING CLASS LOOKUP
// condition string → { am, at, aa, tr, co } class per carrier
// Class codes: 'preferred','level','select1','select2','standard',
// 'modified','rop','graded','gi','oxygen','stent','immediate',
// 'check','decline','see_cancer'
// ============================================================
var UW_CLASS = {
  "AFIB / Irregular Heartbeat":              {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Angina (Chest Pain)":                     {am:'select1',at:'preferred',aa:'rop',tr:'select',co:'level'},
  "Angioplasty":                             {am:'select2',at:'standard',aa:'level',tr:'select',co:'level'},
  "Aneurysm":                                {am:'select1',at:'modified',aa:'rop',tr:'select',co:'level'},
  "Blood Clots":                             {am:'stent',at:'stent',aa:'stent',tr:'stent',co:'stent'},
  "Congestive Heart Failure":                {am:'select2',at:'decline',aa:'decline',tr:'select',co:'decline'},
  "Coronary Artery Disease":                 {am:'select2',at:'standard',aa:'rop',tr:'select',co:'graded'},
  "Heart Attack (within 2 yrs)":            {am:'select2',at:'modified',aa:'rop',tr:'select',co:'decline'},
  "Heart Attack (2+ yrs ago)":              {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Heart Surgery (within 2 yrs)":           {am:'select2',at:'modified',aa:'rop',tr:'select',co:'decline'},
  "Heart Surgery (2+ yrs ago)":             {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Heart Valve Replacement":                 {am:'select2',at:'modified',aa:'rop',tr:'select',co:'graded'},
  "Irregular Heartbeat":                     {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Pacemaker / Defibrillator (within 2 yrs)":{am:'select2',at:'modified',aa:'rop',tr:'select',co:'level'},
  "Pacemaker / Defibrillator (2+ yrs ago)": {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Stent (within 2 yrs)":                   {am:'select2',at:'preferred',aa:'rop',tr:'select',co:'graded'},
  "Stent (2+ yrs ago)":                     {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Asthma (Chronic)":                        {am:'select1',at:'standard',aa:'level',tr:'select',co:'graded'},
  "Bronchitis (Chronic)":                    {am:'select2',at:'standard',aa:'rop',tr:'select',co:'level'},
  "COPD (Inhaler — no oxygen)":              {am:'select2',at:'standard',aa:'level',tr:'select',co:'level'},
  "COPD (On Oxygen)":                        {am:'select2',at:'modified',aa:'graded',tr:'graded',co:'graded'},
  "Emphysema (Chronic)":                     {am:'select2',at:'standard',aa:'rop',tr:'select',co:'level'},
  "Pulmonary Fibrosis":                      {am:'oxygen',at:'decline',aa:'oxygen',tr:'decline',co:'oxygen'},
  "Sleep Apnea (CPAP OK)":                   {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Oxygen Use (not CPAP)":                   {am:'select2',at:'modified',aa:'graded',tr:'graded',co:'graded'},
  "Diabetes Type 2 — Controlled (A1C ≤ 8.6, no insulin)":{am:'select1',at:'preferred',aa:'immediate',tr:'select',co:'level'},
  "Diabetes Type 2 — Uncontrolled or A1C > 8.6":{am:'select2',at:'preferred',aa:'rop',tr:'select',co:'level'},
  "Diabetes Type 1 / On Insulin":            {am:'select2',at:'preferred',aa:'rop',tr:'select',co:'level'},
  "Diabetic Complications (neuropathy/retinopathy)":{am:'select2',at:'modified',aa:'rop',tr:'select',co:'level'},
  "Dialysis":                                {am:'decline',at:'decline',aa:'decline',tr:'graded',co:'decline'},
  "Cancer — Basal Cell Skin Only":           {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Cancer — Active or Treatment within 2 yrs":{am:'gi',at:'decline',aa:'decline',tr:'decline',co:'decline'},
  "Cancer — Last Treatment 2–4 yrs ago":     {am:'select2',at:'preferred',aa:'graded',tr:'graded',co:'level'},
  "Cancer — 4+ yrs cancer free":             {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Melanoma (within 3 yrs)":                 {am:'select2',at:'modified',aa:'see_cancer',tr:'select',co:'level'},
  "Melanoma (3+ yrs ago)":                   {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Alzheimer's / Dementia / Memory Loss":    {am:'select2',at:'decline',aa:'decline',tr:'decline',co:'decline'},
  "ALS (Lou Gehrig's)":                      {am:'decline',at:'decline',aa:'decline',tr:'decline',co:'decline'},
  "Autism":                                  {am:'select1',at:'standard',aa:'level',tr:'select',co:'level'},
  "Bipolar Disorder":                        {am:'select1',at:'preferred',aa:'level',tr:'select',co:'graded'},
  "Cerebral Palsy":                          {am:'select1',at:'decline',aa:'graded',tr:'decline',co:'level'},
  "Depression":                              {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Down's Syndrome":                         {am:'select1',at:'standard',aa:'level',tr:'decline',co:'level'},
  "Epilepsy / Seizures (within 3 yrs)":      {am:'select1',at:'preferred',aa:'graded',tr:'select',co:'level'},
  "Epilepsy / Seizures (3+ yrs)":            {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Huntington's Disease":                    {am:'select1',at:'decline',aa:'level',tr:'decline',co:'decline'},
  "Mental Incapacity / Cognitive Impairment":{am:'select2',at:'standard',aa:'decline',tr:'decline',co:'decline'},
  "Multiple Sclerosis (MS)":                 {am:'select1',at:'level',aa:'graded',tr:'select',co:'graded'},
  "Parkinson's Disease":                     {am:'select2',at:'standard',aa:'graded',tr:'select',co:'graded'},
  "PTSD":                                    {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Schizophrenia":                           {am:'select1',at:'preferred',aa:'level',tr:'select',co:'graded'},
  "Cirrhosis":                               {am:'decline',at:'modified',aa:'rop',tr:'graded',co:'decline'},
  "Crohn's Disease":                         {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Cystic Fibrosis":                         {am:'select2',at:'decline',aa:'level',tr:'decline',co:'level'},
  "Hepatitis A":                             {am:'select1',at:'modified',aa:'rop',tr:'select',co:'level'},
  "Hepatitis B":                             {am:'select2',at:'modified',aa:'rop',tr:'select',co:'graded'},
  "Hepatitis C":                             {am:'decline',at:'modified',aa:'rop',tr:'select',co:'graded'},
  "Kidney Disease / Kidney Failure":         {am:'decline',at:'standard',aa:'rop',tr:'decline',co:'graded'},
  "Liver Disease / Liver Failure":           {am:'decline',at:'standard',aa:'graded',tr:'decline',co:'graded'},
  "Pancreatitis":                            {am:'select1',at:'preferred',aa:'rop',tr:'graded',co:'level'},
  "Ulcerative Colitis":                      {am:'select1',at:'preferred',aa:'graded',tr:'select',co:'level'},
  "Amputation (due to diabetes or disease)": {am:'select2',at:'decline',aa:'decline',tr:'decline',co:'graded'},
  "Amputation (trauma)":                     {am:'select1',at:'modified',aa:'level',tr:'select',co:'level'},
  "Arthritis":                               {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Assisted Living / Long-Term Care Facility":{am:'select1',at:'decline',aa:'decline',tr:'decline',co:'decline'},
  "Rheumatoid Arthritis":                    {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Sarcoidosis":                             {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Walker Use":                              {am:'level',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Wheelchair / Scooter / Electric Cart":    {am:'decline',at:'decline',aa:'decline',tr:'graded',co:'graded'},
  "Blood Disorder (Hemophilia / Thrombocytopenia)":{am:'select1',at:'preferred',aa:'level',tr:'select',co:'decline'},
  "Bone Marrow Transplant":                  {am:'select1',at:'decline',aa:'level',tr:'decline',co:'decline'},
  "HIV / AIDS / ARC":                        {am:'decline',at:'decline',aa:'decline',tr:'decline',co:'decline'},
  "Lupus (SLE)":                             {am:'select1',at:'standard',aa:'rop',tr:'select',co:'graded'},
  "Sickle Cell Anemia":                      {am:'select1',at:'decline',aa:'level',tr:'decline',co:'decline'},
  "Alcohol or Drug Abuse (within 2 yrs)":    {am:'select2',at:'modified',aa:'rop',tr:'graded',co:'graded'},
  "Alcohol or Drug Abuse (2+ yrs clean)":    {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "DUI (within 2 yrs)":                      {am:'select1',at:'modified',aa:'level',tr:'decline',co:'decline'},
  "DUI (2+ yrs ago)":                        {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Felony (within 6 months)":               {am:'decline',at:'preferred',aa:'level',tr:'decline',co:'decline'},
  "Felony (6+ months ago)":                 {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Illegal Drug Use (within 2 yrs)":         {am:'decline',at:'modified',aa:'rop',tr:'graded',co:'graded'},
  "Illegal Drug Use (2+ yrs clean)":         {am:'select1',at:'preferred',aa:'level',tr:'select',co:'level'},
  "Incarcerated / Jail":                     {am:'decline',at:'preferred',aa:'decline',tr:'decline',co:'decline'},
  "Parole or Probation (currently)":         {am:'select2',at:'preferred',aa:'level',tr:'decline',co:'level'},
  "Terminal Illness (death expected within 12 months)":{am:'decline',at:'decline',aa:'decline',tr:'decline',co:'decline'},
  "Organ Transplant":                        {am:'decline',at:'decline',aa:'decline',tr:'decline',co:'decline'},
  "Chronic Narcotic Pain Medications (6+ fills/month)":{am:'check',at:'check',aa:'check',tr:'check',co:'check'},
  "Neuropathy (not diabetic)":               {am:'select2',at:'modified',aa:'immediate',tr:'select',co:'level'},
};

// ============================================================
// BUILD CHART — height (in) → [min lbs, max lbs]
// Used by checkBuildOk() in index.html and the client wizard.
// ============================================================
var BUILD_LIMITS = {
  56:[79,189],57:[81,196],58:[84,203],59:[87,210],60:[90,217],61:[93,224],
  62:[96,232],63:[99,239],64:[102,247],65:[106,255],66:[109,263],67:[112,271],
  68:[116,279],69:[119,287],70:[122,296],71:[126,304],72:[130,313],73:[133,322],
  74:[137,331],75:[141,340],76:[144,349],77:[148,358],78:[152,367],79:[156,377],
};

// ============================================================
// CARRIER CONVERSION RULES — Book Intelligence Phase 1
// Sourced from each carrier's public conversion endorsement summary.
// When a (carrier, term length) combo is unknown, leave the entry
// out — Book Intelligence falls back to a "Needs carrier setup"
// card instead of guessing. Never invent rules.
// Shape: rules[`TERM_${years}`] = { fullUntilYear, limitedUntilAge, allowedTargets[] }
//   fullUntilYear:    years from issue date for full conversion privilege
//   limitedUntilAge:  client age cutoff for any conversion (limited)
//   allowedTargets:   permanent products the agent can convert into
// ============================================================
var CARRIER_CONVERSION_RULES = {
  prudential:  {
    TERM_10: { fullUntilYear: 7,  limitedUntilAge: 65, allowedTargets: ['VUL Protector', 'PruLife UL Protector', 'PruLife SVUL'] },
    TERM_15: { fullUntilYear: 8,  limitedUntilAge: 65, allowedTargets: ['VUL Protector', 'PruLife UL Protector', 'PruLife SVUL'] },
    TERM_20: { fullUntilYear: 10, limitedUntilAge: 65, allowedTargets: ['VUL Protector', 'PruLife UL Protector', 'PruLife SVUL'] },
    TERM_30: { fullUntilYear: 10, limitedUntilAge: 65, allowedTargets: ['VUL Protector', 'PruLife UL Protector'] }
  },
  lincoln:     {
    TERM_10: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['LifeElements WL', 'WealthAccumulate IUL', 'Lincoln VUL'] },
    TERM_15: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['LifeElements WL', 'WealthAccumulate IUL', 'Lincoln VUL'] },
    TERM_20: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['LifeElements WL', 'WealthAccumulate IUL', 'Lincoln VUL'] },
    TERM_30: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['LifeElements WL', 'WealthAccumulate IUL'] }
  },
  banner:      {
    TERM_10: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Life Step UL'] },
    TERM_15: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Life Step UL'] },
    TERM_20: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Life Step UL'] },
    TERM_30: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Life Step UL'] }
  },
  protective:  {
    TERM_10: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Indexed Choice UL', 'Strategic Objectives VUL'] },
    TERM_15: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Indexed Choice UL', 'Strategic Objectives VUL'] },
    TERM_20: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Indexed Choice UL', 'Strategic Objectives VUL'] },
    TERM_30: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Indexed Choice UL'] }
  },
  johnHancock: {
    TERM_10: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Protection IUL', 'Protection UL', 'Accumulation IUL'] },
    TERM_15: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Protection IUL', 'Protection UL', 'Accumulation IUL'] },
    TERM_20: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Protection IUL', 'Protection UL', 'Accumulation IUL'] }
  },
  mutual:      {
    TERM_10: { fullUntilYear: 10, limitedUntilAge: 75, allowedTargets: ['Income Advantage IUL', 'Life Protection Advantage IUL'] },
    TERM_15: { fullUntilYear: 10, limitedUntilAge: 75, allowedTargets: ['Income Advantage IUL', 'Life Protection Advantage IUL'] },
    TERM_20: { fullUntilYear: 10, limitedUntilAge: 75, allowedTargets: ['Income Advantage IUL', 'Life Protection Advantage IUL'] },
    TERM_30: { fullUntilYear: 10, limitedUntilAge: 75, allowedTargets: ['Income Advantage IUL', 'Life Protection Advantage IUL'] }
  },
  symetra:     {
    TERM_10: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Symetra Accumulator IUL', 'Symetra UL-G'] },
    TERM_15: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Symetra Accumulator IUL', 'Symetra UL-G'] },
    TERM_20: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Symetra Accumulator IUL', 'Symetra UL-G'] }
  },
  aig:         {
    TERM_10: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Max Accumulator+ IUL', 'Secure Lifetime GUL'] },
    TERM_15: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Max Accumulator+ IUL', 'Secure Lifetime GUL'] },
    TERM_20: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Max Accumulator+ IUL', 'Secure Lifetime GUL'] },
    TERM_30: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Max Accumulator+ IUL', 'Secure Lifetime GUL'] }
  },
  trans:       {
    TERM_10: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Financial Foundation IUL', 'Trans IUL Express'] },
    TERM_15: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Financial Foundation IUL', 'Trans IUL Express'] },
    TERM_20: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Financial Foundation IUL', 'Trans IUL Express'] },
    TERM_30: { fullUntilYear: 10, limitedUntilAge: 70, allowedTargets: ['Financial Foundation IUL'] }
  },
  pacificLife: {
    TERM_10: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Pacific Discovery Xelerator IUL', 'Pacific Indexed Estate Preserver'] },
    TERM_15: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Pacific Discovery Xelerator IUL', 'Pacific Indexed Estate Preserver'] },
    TERM_20: { fullUntilYear: 5,  limitedUntilAge: 70, allowedTargets: ['Pacific Discovery Xelerator IUL'] }
  },
};

// Normalize a free-form carrier label to a CARRIER_CONVERSION_RULES key.
// Returns null when no rule is on file — caller should treat as
// "Needs carrier setup" and never guess a deadline.
function normalizeCarrierKey(name) {
  if (!name) return null;
  var s = String(name).toLowerCase();
  if (s.indexOf('prudential') !== -1) return 'prudential';
  if (s.indexOf('lincoln') !== -1) return 'lincoln';
  if (s.indexOf('banner') !== -1) return 'banner';
  if (s.indexOf('protective') !== -1) return 'protective';
  if (s.indexOf('john hancock') !== -1 || s.indexOf('johnhancock') !== -1) return 'johnHancock';
  if (s.indexOf('mutual of omaha') !== -1 || s === 'mutual' || s.indexOf('omaha') !== -1) return 'mutual';
  if (s.indexOf('symetra') !== -1) return 'symetra';
  if (s.indexOf('aig') !== -1 || s.indexOf('american general') !== -1) return 'aig';
  if (s.indexOf('transamerica') !== -1 || s.indexOf('trans ') === 0 || s === 'trans') return 'trans';
  if (s.indexOf('pacific life') !== -1 || s.indexOf('pacificlife') !== -1) return 'pacificLife';
  // Carriers PolicyPilot already quotes (FE side) but for which we don't have
  // public term-conversion rules on file. Returning null means BI will surface
  // a "Needs carrier setup" card — exactly what we want.
  return null;
}

function getConversionRule(carrierName, termLengthYears) {
  if (!carrierName || !termLengthYears) return null;
  // Local agent-defined override always wins. The dashboard writes to this
  // map when the agent uses the inline "Add carrier rule" form on a Needs-
  // Carrier-Setup row. Shape: { 'allstate': { TERM_20: { fullUntilYear, ...} } }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      var raw = window.localStorage.getItem('bi_carrier_overrides');
      if (raw) {
        var overrides = JSON.parse(raw);
        var oKey = String(carrierName).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        var ov = overrides[oKey] || overrides[String(carrierName).toLowerCase()];
        if (ov && ov['TERM_' + termLengthYears]) return ov['TERM_' + termLengthYears];
      }
    }
  } catch (e) { /* fall through to built-ins */ }
  var key = normalizeCarrierKey(carrierName);
  if (!key) return null;
  var rules = CARRIER_CONVERSION_RULES[key];
  if (!rules) return null;
  return rules['TERM_' + termLengthYears] || null;
}
