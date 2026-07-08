// ============================================================
// supabase/functions/monthly-summary/gather.ts
//
// GATHER stage of the monthly account-summary emails.
// For one agent + one period kind, queries the DB and returns a
// single structured SummaryData object. NO HTML here — rendering
// lives in email.ts (mirrors the weekly-digest gather/render split).
//
// All date math is America/Chicago. Policy dates (`data->>'draft'`)
// are YYYY-MM-DD strings compared lexicographically (same convention
// as weekly-digest). Call timestamps (timestamptz) are filtered with
// UTC instants of Chicago midnights computed by chicagoMidnightUtc().
// ============================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type SummaryKind = "monthly" | "midmonth";
export type PlanTier = "basic" | "pro" | "max";

export interface PeriodMetrics {
  ap: number;                 // total AP sold in period
  policies: number;           // policies written in period
  estCommission: number;      // stored advComm, fallback ap×commPct/100×0.75
  dials: number;              // calls row count
  talkHours: number;          // sum(duration_sec)/3600
  pickupPct: number | null;   // connected(answered_at not null)/dials ×100
  closePct: number | null;    // policies/dials ×100
  appointments: number;       // calls where outcome='appointment'
}

export interface TeamRollup {
  combinedAP: number;
  memberCount: number;
  topProducer: { name: string; ap: number } | null;
  idleAgents: string[];       // downline names with zero dials in last 7 days
}

export interface SummaryData {
  kind: SummaryKind;
  tier: PlanTier;
  firstName: string;
  periodLabel: string;        // "October 2026" | "November 1–14, 2026"
  monthName: string;          // month the email is about
  year: number;
  current: PeriodMetrics;
  prior: PeriodMetrics;       // equivalent previous period (streak/pace)
  goal: number;               // agents.monthly_goal
  goalPct: number;            // 0–1+, current.ap / goal
  // pace fields (used mainly by the 15th email)
  daysElapsed: number;
  daysTotal: number;
  daysLeft: number;
  needPerDay: number;         // $ per remaining day to hit goal
  projected: number;          // straight-line month-end projection
  aheadBy: number;            // current.ap - prior.ap (same point comparison)
  upcomingDrafts: { count: number; totalPremium: number } | null;
  // Future-parser seam: render shows "confirmed $Y" ONLY if present.
  // Always null today — the carrier-email parser is not wired in.
  actualCommission?: number | null;
  team?: TeamRollup | null;   // max tier only
}

// ---- Chicago date helpers ---------------------------------------------------

const CHI = "America/Chicago";

/** Y/M/D (and hour) of `instant` as seen in Chicago. */
export function chicagoParts(instant: Date): { y: number; m: number; d: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHI, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour === 24 ? 0 : +p.hour };
}

/** UTC instant of midnight in Chicago on the given local calendar date.
 *  DST-safe: guesses CST (UTC-6), then corrects against what Chicago
 *  actually shows for that instant. */
export function chicagoMidnightUtc(y: number, m: number, d: number): Date {
  let t = Date.UTC(y, m - 1, d, 6, 0, 0); // assume CST (UTC-6)
  for (let i = 0; i < 3; i++) {
    const seen = chicagoParts(new Date(t));
    if (seen.y === y && seen.m === m && seen.d === d && seen.hour === 0) break;
    // Shift by the error between what Chicago shows and what we want
    // (handles CDT = UTC-5 and DST-transition edges).
    const want = Date.UTC(y, m - 1, d, 0);
    const got  = Date.UTC(seen.y, seen.m - 1, seen.d, seen.hour);
    t += want - got;
  }
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function addDays(y: number, m: number, d: number, delta: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // date_trunc-equivalent: never hardcode
}

function monthName(m: number): string {
  return ["January","February","March","April","May","June","July",
          "August","September","October","November","December"][m - 1];
}

/** A half-open window [start, end) expressed both as date strings
 *  (for JSONB `draft` comparison) and UTC instants (for calls). */
export interface Window {
  startYmd: string; endYmd: string;      // draft >= startYmd AND draft < endYmd
  startUtc: string; endUtc: string;      // started_at >= startUtc AND < endUtc
}

function makeWindow(sy: number, sm: number, sd: number, ey: number, em: number, ed: number): Window {
  return {
    startYmd: ymd(sy, sm, sd), endYmd: ymd(ey, em, ed),
    startUtc: chicagoMidnightUtc(sy, sm, sd).toISOString(),
    endUtc:   chicagoMidnightUtc(ey, em, ed).toISOString(),
  };
}

/** Current + prior windows for a run "today" (Chicago date). */
export function periodWindows(kind: SummaryKind, today: { y: number; m: number; d: number }) {
  const { y, m } = today;
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const prev2M = prevM === 1 ? 12 : prevM - 1;
  const prev2Y = prevM === 1 ? prevY - 1 : prevY;

  if (kind === "monthly") {
    // Report card for the entire previous calendar month.
    return {
      current: makeWindow(prevY, prevM, 1, y, m, 1),
      prior:   makeWindow(prev2Y, prev2M, 1, prevY, prevM, 1),
      reportY: prevY, reportM: prevM,
      periodLabel: `${monthName(prevM)} ${prevY}`,
      daysTotal: daysInMonth(prevY, prevM),
      daysElapsed: daysInMonth(prevY, prevM),
    };
  }
  // Mid-month pace check: 1st through 14th of the current month.
  return {
    current: makeWindow(y, m, 1, y, m, 15),
    prior:   makeWindow(prevY, prevM, 1, prevY, prevM, 15),
    reportY: y, reportM: m,
    periodLabel: `${monthName(m)} 1–14, ${y}`,
    daysTotal: daysInMonth(y, m),
    daysElapsed: 14,
  };
}

// ---- policy helpers ---------------------------------------------------------

// Real JSONB keys, confirmed against app.html (~line 9454):
//   ap, draft, carrier, status, client, advComm, commPct, monthly, payDate, ...
interface PolicyData {
  ap?: number | string;
  draft?: string;
  advComm?: number | string;
  commPct?: number | string;
  client?: string;
  [k: string]: unknown;      // future parser adds keys here; we ignore unknowns
}

const num = (v: unknown) => Number(v) || 0;

function estComm(p: PolicyData): number {
  // Same rule as app.html lines 7958 / 9707: stored advComm, else derive.
  const stored = num(p.advComm);
  if (stored > 0) return stored;
  return +(num(p.ap) * num(p.commPct) / 100 * 0.75).toFixed(2);
}

function inWindow(p: PolicyData, w: Window): boolean {
  return !!p.draft && p.draft >= w.startYmd && p.draft < w.endYmd;
}

// ---- call helpers -----------------------------------------------------------

interface CallRow {
  started_at: string;
  duration_sec: number | null;
  answered_at: string | null;   // connected call = non-null (confirmed real column)
  outcome: string | null;
}

function callMetrics(calls: CallRow[]): Pick<PeriodMetrics, "dials" | "talkHours" | "pickupPct" | "appointments"> {
  const dials = calls.length;
  const talkSec = calls.reduce((s, c) => s + (c.duration_sec || 0), 0);
  const connected = calls.filter(c => c.answered_at != null).length;
  const appointments = calls.filter(c => c.outcome === "appointment").length;
  return {
    dials,
    talkHours: +(talkSec / 3600).toFixed(1),
    pickupPct: dials > 0 ? +((connected / dials) * 100).toFixed(1) : null,
    appointments,
  };
}

// ---- main gather ------------------------------------------------------------

export interface AgentRow {
  id: string;
  email: string | null;
  display_name: string | null;
  digest_email: string | null;
  monthly_goal: number | null;
  contract_level: number | null;
  plan_slug: PlanTier;
}

const DEFAULT_GOAL = 50_000;

export async function gatherSummary(
  sb: SupabaseClient,
  agent: AgentRow,
  kind: SummaryKind,
  now: Date = new Date(),
): Promise<SummaryData> {
  const today = chicagoParts(now);
  const win = periodWindows(kind, today);

  // 1. Policies (JSONB) — one fetch, filtered in memory like weekly-digest.
  const { data: polRows, error: polErr } = await sb
    .from("policies").select("data").eq("agent_id", agent.id);
  if (polErr) throw new Error(`policies: ${polErr.message}`);
  const policies: PolicyData[] = (polRows || []).map((r: { data: PolicyData }) => r.data || {});

  // 2. Calls for current + prior windows.
  const fetchCalls = async (w: Window): Promise<CallRow[]> => {
    const { data, error } = await sb
      .from("calls")
      .select("started_at, duration_sec, answered_at, outcome")
      .eq("agent_id", agent.id)
      .gte("started_at", w.startUtc)
      .lt("started_at", w.endUtc);
    if (error) throw new Error(`calls: ${error.message}`);
    return (data || []) as CallRow[];
  };
  const [curCalls, priCalls] = await Promise.all([fetchCalls(win.current), fetchCalls(win.prior)]);

  const buildPeriod = (w: Window, calls: CallRow[]): PeriodMetrics => {
    const pols = policies.filter(p => inWindow(p, w));
    const ap = pols.reduce((s, p) => s + num(p.ap), 0);
    const cm = callMetrics(calls);
    return {
      ap,
      policies: pols.length,
      estCommission: +pols.reduce((s, p) => s + estComm(p), 0).toFixed(2),
      ...cm,
      closePct: cm.dials > 0 ? +((pols.length / cm.dials) * 100).toFixed(1) : null,
    };
  };

  const current = buildPeriod(win.current, curCalls);
  const prior   = buildPeriod(win.prior, priCalls);

  // 3. Upcoming drafts: next 7 days from today (Chicago), key = data->>'draft'.
  const from = ymd(today.y, today.m, today.d);
  const toP = addDays(today.y, today.m, today.d, 8); // half-open, 7 full days
  const to = ymd(toP.y, toP.m, toP.d);
  const upcoming = policies.filter(p => !!p.draft && p.draft! >= from && p.draft! < to);
  const upcomingDrafts = upcoming.length
    ? { count: upcoming.length, totalPremium: upcoming.reduce((s, p) => s + num(p.ap), 0) }
    : null;

  // 4. Pace math.
  const goal = Number(agent.monthly_goal) || DEFAULT_GOAL;
  const daysLeft = Math.max(0, win.daysTotal - win.daysElapsed);
  const projected = win.daysElapsed > 0 ? (current.ap / win.daysElapsed) * win.daysTotal : 0;

  // 5. Team rollup (max tier only). Downline = agency_invites accepted.
  let team: TeamRollup | null = null;
  if (agent.plan_slug === "max") {
    team = await gatherTeam(sb, agent.id, win.current, now);
  }

  return {
    kind,
    tier: agent.plan_slug,
    firstName: (agent.display_name || "").split(" ")[0] || "",
    periodLabel: win.periodLabel,
    monthName: monthName(win.reportM),
    year: win.reportY,
    current,
    prior,
    goal,
    goalPct: goal > 0 ? current.ap / goal : 0,
    daysElapsed: win.daysElapsed,
    daysTotal: win.daysTotal,
    daysLeft,
    needPerDay: daysLeft > 0 ? Math.max(0, goal - current.ap) / daysLeft : 0,
    projected,
    aheadBy: current.ap - prior.ap,
    upcomingDrafts,
    actualCommission: null,   // parser seam — always null until the parser ships
    team,
  };
}

async function gatherTeam(
  sb: SupabaseClient,
  leaderId: string,
  w: Window,
  now: Date,
): Promise<TeamRollup | null> {
  const { data: invites, error } = await sb
    .from("agency_invites")
    .select("invitee_id, invitee_email")
    .eq("leader_id", leaderId)
    .eq("status", "accepted")
    .not("invitee_id", "is", null);
  if (error) throw new Error(`agency_invites: ${error.message}`);
  const ids = (invites || []).map((i: { invitee_id: string }) => i.invitee_id);
  if (!ids.length) return null;

  const { data: members } = await sb
    .from("agents").select("id, display_name, email").in("id", ids);
  const nameOf = (id: string) => {
    const m = (members || []).find((a: { id: string }) => a.id === id);
    return m?.display_name || m?.email || "Unknown agent";
  };

  // Period AP per member (policies JSONB, filtered in memory).
  const { data: polRows, error: pe } = await sb
    .from("policies").select("agent_id, data").in("agent_id", ids);
  if (pe) throw new Error(`team policies: ${pe.message}`);
  const apBy: Record<string, number> = {};
  for (const r of polRows || []) {
    const p: PolicyData = r.data || {};
    if (inWindow(p, w)) apBy[r.agent_id] = (apBy[r.agent_id] || 0) + num(p.ap);
  }
  const combinedAP = Object.values(apBy).reduce((s, v) => s + v, 0);
  const top = Object.entries(apBy).sort((a, b) => b[1] - a[1])[0];

  // Zero dials in the last 7 days (rolling, Chicago-anchored via instants).
  const sevenAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const { data: recent } = await sb
    .from("calls").select("agent_id").in("agent_id", ids).gte("started_at", sevenAgo);
  const dialed = new Set((recent || []).map((c: { agent_id: string }) => c.agent_id));
  const idleAgents = ids.filter((id: string) => !dialed.has(id)).map(nameOf);

  return {
    combinedAP,
    memberCount: ids.length,
    topProducer: top && top[1] > 0 ? { name: nameOf(top[0]), ap: top[1] } : null,
    idleAgents,
  };
}
