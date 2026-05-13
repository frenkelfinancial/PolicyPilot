// ============================================================
// supabase/functions/_shared/scoring.ts
//
// Server-side scoring kernel for the daily digest. Mirror of the
// browser-side logic in index-3.html (bookIntel.*) — kept deliberately
// minimal so it can run in Deno without dragging in shared/quote-engine.js.
//
// Commission estimate uses a flat face × 0.1% × 70% × 0.75 model — coarser
// than the dashboard's quoteIUL-driven number but produces identical
// RELATIVE ordering, which is all the "top 3" digest needs.
// ============================================================

// Mirror of CARRIER_CONVERSION_RULES from shared/data.js. Keep in sync
// when adding carriers. data/conversion-rules.json is the JSON mirror.
export const CARRIER_CONVERSION_RULES: Record<string, Record<string, { fullUntilYear: number; limitedUntilAge: number }>> = {
  prudential:  { TERM_10: { fullUntilYear: 7,  limitedUntilAge: 65 }, TERM_15: { fullUntilYear: 8,  limitedUntilAge: 65 }, TERM_20: { fullUntilYear: 10, limitedUntilAge: 65 }, TERM_30: { fullUntilYear: 10, limitedUntilAge: 65 } },
  lincoln:     { TERM_10: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_15: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_20: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_30: { fullUntilYear: 10, limitedUntilAge: 70 } },
  banner:      { TERM_10: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_15: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_20: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_30: { fullUntilYear: 5,  limitedUntilAge: 70 } },
  protective:  { TERM_10: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_15: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_20: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_30: { fullUntilYear: 10, limitedUntilAge: 70 } },
  johnHancock: { TERM_10: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_15: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_20: { fullUntilYear: 10, limitedUntilAge: 70 } },
  mutual:      { TERM_10: { fullUntilYear: 10, limitedUntilAge: 75 }, TERM_15: { fullUntilYear: 10, limitedUntilAge: 75 }, TERM_20: { fullUntilYear: 10, limitedUntilAge: 75 }, TERM_30: { fullUntilYear: 10, limitedUntilAge: 75 } },
  symetra:     { TERM_10: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_15: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_20: { fullUntilYear: 5,  limitedUntilAge: 70 } },
  aig:         { TERM_10: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_15: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_20: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_30: { fullUntilYear: 5,  limitedUntilAge: 70 } },
  trans:       { TERM_10: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_15: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_20: { fullUntilYear: 10, limitedUntilAge: 70 }, TERM_30: { fullUntilYear: 10, limitedUntilAge: 70 } },
  pacificLife: { TERM_10: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_15: { fullUntilYear: 5,  limitedUntilAge: 70 }, TERM_20: { fullUntilYear: 5,  limitedUntilAge: 70 } },
};

export function normalizeCarrierKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = String(name).toLowerCase();
  if (s.includes('prudential')) return 'prudential';
  if (s.includes('lincoln')) return 'lincoln';
  if (s.includes('banner')) return 'banner';
  if (s.includes('protective')) return 'protective';
  if (s.includes('john hancock') || s.includes('johnhancock')) return 'johnHancock';
  if (s.includes('mutual of omaha') || s.includes('omaha') || s === 'mutual') return 'mutual';
  if (s.includes('symetra')) return 'symetra';
  if (s.includes('aig') || s.includes('american general')) return 'aig';
  if (s.includes('transamerica') || s.startsWith('trans ') || s === 'trans') return 'trans';
  if (s.includes('pacific life') || s.includes('pacificlife')) return 'pacificLife';
  return null;
}

export function getConversionRule(carrier: string | null | undefined, term: number | null | undefined) {
  const key = normalizeCarrierKey(carrier);
  if (!key) return null;
  const rules = CARRIER_CONVERSION_RULES[key];
  if (!rules || !term) return null;
  return rules['TERM_' + term] || null;
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const str = String(s).trim();
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) return new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) return new Date(+usMatch[3], +usMatch[1] - 1, +usMatch[2]);
  const d = new Date(str);
  return isNaN(+d) ? null : d;
}
function addYears(d: Date, y: number): Date {
  const out = new Date(d.getTime());
  out.setFullYear(out.getFullYear() + y);
  return out;
}
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function ageFromDob(dob: string | null | undefined, asOf: Date): number | null {
  const d = parseDate(dob);
  if (!d) return null;
  let age = asOf.getFullYear() - d.getFullYear();
  const m = asOf.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && asOf.getDate() < d.getDate())) age--;
  return age;
}

export type Policy = {
  client?: string;
  carrier?: string;
  productType?: string;
  issueDate?: string;
  termLengthYears?: number;
  clientDob?: string;
  faceAmount?: number;
  cov?: number;
  knownConditions?: string[];
  opportunity?: { status?: string } | null;
  email?: string;
};

export function computeDeadline(p: Policy): string | null {
  if (!p || p.productType !== 'TERM' || !p.issueDate || !p.termLengthYears) return null;
  const rule = getConversionRule(p.carrier, p.termLengthYears);
  if (!rule) return null;
  const issue = parseDate(p.issueDate);
  if (!issue) return null;
  const candidates: Date[] = [];
  if (rule.fullUntilYear) candidates.push(addYears(issue, rule.fullUntilYear));
  if (rule.limitedUntilAge && p.clientDob) {
    const dob = parseDate(p.clientDob);
    if (dob) candidates.push(addYears(dob, rule.limitedUntilAge));
  }
  candidates.push(addYears(issue, p.termLengthYears));
  const min = candidates.reduce((a, b) => (a < b ? a : b));
  return fmtDate(min);
}

export function estCommission(p: Policy): number {
  const face = Number(p.faceAmount || p.cov || 0);
  if (!face) return 0;
  // Coarse but consistent: annual premium ≈ face × 0.1%, commission ≈ 70%,
  // first-year advance = 75%. Used only for ordering & a ballpark in the email.
  return Math.round(face * 0.001 * 0.70 * 0.75);
}

export type ScoredOpportunity = {
  client: string;
  carrier: string;
  faceAmount: number;
  termLengthYears: number;
  issueDate: string;
  deadline: string;
  urgencyDays: number;
  estCommission: number;
  priority: number;
  email: string | null;
};

export function scoreBook(policies: Policy[], today: Date = new Date()): ScoredOpportunity[] {
  const refToday = new Date(today); refToday.setHours(0, 0, 0, 0);
  let maxComm = 0;
  const interim: { p: Policy; deadline: string; days: number; est: number; }[] = [];
  for (const p of policies) {
    // Skip statuses that should never appear in a morning brief.
    const st = p.opportunity && p.opportunity.status;
    if (st && st !== 'OPEN' && st !== 'AWAITING_RESPONSE') continue;
    const deadline = computeDeadline(p);
    if (!deadline) continue;
    const dl = parseDate(deadline);
    if (!dl) continue;
    const days = Math.round((+dl - +refToday) / 86400000);
    if (days < 0) continue;
    const est = estCommission(p);
    if (est > maxComm) maxComm = est;
    interim.push({ p, deadline, days, est });
  }
  return interim.map(({ p, deadline, days, est }) => {
    const urgencyScore = days <= 90 ? 100 : days <= 180 ? 80 : days <= 365 ? 60 : days <= 730 ? 30 : 0;
    const revenueScore = maxComm > 0 ? Math.min(100, (est / maxComm) * 100) : 0;
    const age = ageFromDob(p.clientDob, refToday);
    const hasConds = Array.isArray(p.knownConditions) && p.knownConditions.length > 0;
    const insurabilityScore = hasConds ? 100 : (age && age >= 60 ? 70 : 20);
    const priority = +(urgencyScore * 0.5 + revenueScore * 0.3 + insurabilityScore * 0.2).toFixed(1);
    return {
      client: p.client || 'Unknown',
      carrier: p.carrier || '',
      faceAmount: Number(p.faceAmount || p.cov || 0),
      termLengthYears: Number(p.termLengthYears || 0),
      issueDate: p.issueDate || '',
      deadline,
      urgencyDays: days,
      estCommission: est,
      priority,
      email: p.email || null,
    };
  }).sort((a, b) => b.priority - a.priority);
}
