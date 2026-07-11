// ============================================================
// supabase/functions/monthly-summary/email.ts
//
// RENDER stage: SummaryData object → email subject/html/text.
// Reads ONLY from the object — never the database.
// Every optional section is conditional: absent/empty field ⇒
// the section does not render at all (no blank boxes).
//
// Visual source of truth: docs/summary-emails/design-refs/email-summary-ref.html
// (Jace's uploaded template — Producer Stack light theme).
// Email-safe adaptations: table layout, inline styles; the ref's
// conic-gradient "goal rings" become rounded progress bars (Gmail
// strips conic-gradient); CSS grid stat strip becomes a 3-col table.
// ============================================================

import type { SummaryData, PeriodMetrics } from "./gather.ts";

export interface RenderOpts {
  dashboardUrl: string;
  unsubscribeUrl: string;   // token-based one-click URL, unique per agent
  prefsUrl: string;         // dashboard Settings/Summary tab
  brandName?: string;       // default "Producer Stack"
}

// ---- palette (from design ref) ----------------------------------------------
const C = {
  navy: "#132644", navy2: "#0e1d36", blue: "#5b9bd5", blueLight: "#7cb7ec",
  ink: "#1d2b45", muted: "#6b7890", line: "#e8edf5", bg: "#eef2f8",
  card: "#ffffff", up: "#1f9d6b", down: "#d16060",
  footText: "#8698b8", footLink: "#cdd9ee",
};
const FONT = `'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;

// ---- formatting helpers -----------------------------------------------------
const $ = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const $k = (n: number) => n >= 10_000 ? "$" + Math.round(n / 1000) + "K" : $(n);
const pct1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US") + "%";

function delta(cur: number, pri: number, fmt: (n: number) => string, priorLabel: string): string {
  const diff = cur - pri;
  if (pri === 0 && cur === 0) return "";
  const up = diff >= 0;
  const color = up ? C.up : C.down;
  const arrow = up ? "▲" : "▼";
  return `<div style="font-size:12px;font-weight:600;margin-top:8px;color:${color}">${arrow} ${fmt(Math.abs(diff))} vs ${priorLabel}</div>`;
}

// ---- building blocks --------------------------------------------------------

function statCell(label: string, value: string, deltaHtml: string, width: string): string {
  return `<td width="${width}" valign="top" style="background:${C.card};padding:22px 20px;border-right:1px solid ${C.line}">
    <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${C.muted}">${label}</p>
    <div style="font-size:24px;font-weight:800;letter-spacing:-.02em;color:${C.navy};line-height:1">${value}</div>
    ${deltaHtml}
  </td>`;
}

function progressBar(pctVal: number): string {
  const w = Math.max(0, Math.min(100, Math.round(pctVal)));
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
    <td style="background:${C.line};border-radius:99px;height:10px;font-size:0;line-height:0">
      <div style="width:${w}%;max-width:100%;height:10px;border-radius:99px;background:linear-gradient(135deg,${C.blueLight} 0%,${C.blue} 100%);font-size:0;line-height:0">&nbsp;</div>
    </td></tr></table>`;
}

function row(label: string, sub: string, amount: string): string {
  return `<tr>
    <td style="padding:15px 0;border-bottom:1px solid ${C.line}">
      <div style="font-size:14px;font-weight:600;color:${C.ink}">${label}${sub ? `<span style="display:block;font-size:12px;font-weight:500;color:${C.muted};margin-top:2px">${sub}</span>` : ""}</div>
    </td>
    <td align="right" style="padding:15px 0;border-bottom:1px solid ${C.line}">
      <div style="font-size:15px;font-weight:800;color:${C.navy};letter-spacing:-.01em">${amount}</div>
    </td>
  </tr>`;
}

function sectionHead(title: string, sub: string): string {
  return `<h2 style="margin:0 0 4px;font-size:17px;font-weight:800;letter-spacing:-.01em;color:${C.navy}">${title}</h2>
    <p style="margin:0 0 20px;font-size:13px;color:${C.muted}">${sub}</p>`;
}

// ---- grading (1st-of-month report card) --------------------------------------
function grade(goalPct: number): { letter: string; line: string } {
  if (goalPct >= 1)    return { letter: "A+", line: "Goal hit. Outstanding month." };
  if (goalPct >= 0.85) return { letter: "A",  line: "Right at the line — a very strong month." };
  if (goalPct >= 0.70) return { letter: "B",  line: "Solid production with room to push." };
  if (goalPct >= 0.50) return { letter: "C",  line: "A real base to build on this month." };
  return { letter: "—", line: "A fresh month starts now." };
}

// ---- main --------------------------------------------------------------------

export function buildSummaryEmail(data: SummaryData, opts: RenderOpts): { subject: string; html: string; text: string } {
  const brand = opts.brandName || "Producer Stack";
  const m = data.current;
  const isEmpty = m.policies === 0 && m.dials === 0 && m.ap === 0;
  const priorLabel = data.kind === "monthly"
    ? shortMonth(prevMonthName(data.monthName))
    : `same point in ${shortMonth(prevMonthName(data.monthName))}`;

  const subject = buildSubject(data, isEmpty);
  const heroHtml = buildHero(data, isEmpty);
  const statsHtml = isEmpty ? "" : buildStats(data, priorLabel);
  const goalHtml = buildGoal(data, isEmpty);
  const breakdownHtml = buildBreakdown(data);
  const teamHtml = data.team ? buildTeam(data) : "";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};color:${C.ink}">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.bg};padding:36px 16px"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:${C.card};border-radius:20px;overflow:hidden;box-shadow:0 24px 60px -24px rgba(19,38,68,.28),0 4px 12px -6px rgba(19,38,68,.12)">

  <!-- Header -->
  <tr><td style="padding:24px 32px;border-bottom:1px solid ${C.line}">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
      <td style="font-size:18px;font-weight:800;letter-spacing:-.02em;color:${C.navy}">Producer<span style="color:${C.blue}">Stack</span></td>
      <td align="right" style="font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};line-height:1.5">${data.kind === "monthly" ? "Monthly Summary" : "Mid-Month Check-In"}<b style="display:block;color:${C.ink};font-size:13px;letter-spacing:.06em">${data.kind === "monthly" ? `${data.monthName} ${data.year}` : data.periodLabel}</b></td>
    </tr></table>
  </td></tr>

  ${heroHtml}
  ${statsHtml}
  ${goalHtml}
  ${breakdownHtml}
  ${teamHtml}

  <!-- CTA -->
  <tr><td style="padding:32px;text-align:center">
    <a href="${opts.dashboardUrl}" style="display:inline-block;background:${C.navy};color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:.01em;padding:15px 34px;border-radius:12px">View full dashboard</a>
    <p style="margin:16px 0 0;font-size:12px;color:${C.muted}">Your complete book, pipeline, and call history are in ${brand}.</p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:26px 32px 30px;background:${C.navy};text-align:center">
    <div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#e6edf9;text-transform:uppercase;margin-bottom:10px">${brand}</div>
    <p style="margin:4px 0;font-size:11px;line-height:1.6;color:${C.footText}">This is your account statement — sent on the 1st and 15th while summaries are on for your account.</p>
    <p style="margin:4px 0;font-size:11px;line-height:1.6;color:${C.footText}"><a href="${opts.prefsUrl}" style="color:${C.footText};text-decoration:underline">Manage email preferences</a> &nbsp;·&nbsp; <a href="${opts.unsubscribeUrl}" style="color:${C.footText};text-decoration:underline">Unsubscribe</a></p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  return { subject, html, text: buildText(data, opts, subject) };
}

// ---- sections ----------------------------------------------------------------

function buildSubject(d: SummaryData, isEmpty: boolean): string {
  const m = d.current;
  if (d.kind === "monthly") {
    return isEmpty
      ? `Your ${d.monthName} Report — a fresh month ahead`
      : `Your ${d.monthName} Report — ${m.policies} ${m.policies === 1 ? "policy" : "policies"}, ${$k(m.ap)} AP`;
  }
  if (isEmpty) return `Halfway through ${d.monthName} — your goal is still in reach`;
  return d.aheadBy >= 0
    ? `Halfway through ${d.monthName} — you're ahead of pace`
    : `Halfway through ${d.monthName} — ${$k(Math.max(0, d.goal - m.ap))} to go`;
}

function buildHero(d: SummaryData, isEmpty: boolean): string {
  const hi = d.firstName ? `, ${d.firstName}` : "";
  let h1: string, p: string, tag: string;

  if (d.kind === "monthly") {
    tag = "Your performance report";
    if (isEmpty) {
      h1 = `A clean slate${hi}.`;
      p = `${d.monthName} was quiet on the board — and the new month is wide open. Your ${$(d.goal)} goal resets today, and every dial from here counts toward it.`;
    } else {
      const g = grade(d.goalPct);
      h1 = d.goalPct >= 0.85 ? `Strong month${hi}.` : d.goalPct >= 0.5 ? `Solid work${hi}.` : `Momentum building${hi}.`;
      p = `You closed ${d.monthName} at ${pct1(d.goalPct * 100)} of your ${$(d.goal)} goal${g.letter !== "—" ? ` — grade: <b style="color:${C.navy}">${g.letter}</b>` : ""}. ${g.line} Your new ${$(d.goal)} goal starts now.`;
    }
  } else {
    tag = "Mid-month pace check";
    if (isEmpty) {
      h1 = `Plenty of runway${hi}.`;
      p = `The first half of ${d.monthName} was a slow start — but ${d.daysLeft} days remain, and ${$(d.goal)} is still on the table. ${$(Math.round(d.needPerDay))}/day from here gets it done.`;
    } else if (d.aheadBy >= 0) {
      h1 = `You're ahead of your own pace${hi}.`;
      p = `${$(d.aheadBy)} ahead of where you stood at this point last month, with ${pct1(d.goalPct * 100)} of your goal already on the board and ${d.daysLeft} days to finish the job.`;
    } else {
      h1 = `Time to make a move${hi}.`;
      p = `You're at ${pct1(d.goalPct * 100)} of your ${$(d.goal)} goal with ${d.daysLeft} days left. ${$(Math.round(d.needPerDay))}/day from here closes the gap.`;
    }
  }

  return `<tr><td style="padding:38px 32px 30px;background:linear-gradient(180deg,#f7fafe 0%,#ffffff 100%)">
    <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${C.blue}">${tag}</p>
    <h1 style="margin:0 0 10px;font-size:27px;line-height:1.2;font-weight:800;letter-spacing:-.02em;color:${C.navy}">${h1}</h1>
    <p style="margin:0;font-size:15px;line-height:1.6;color:${C.muted};max-width:460px">${p}</p>
  </td></tr>`;
}

function buildStats(d: SummaryData, priorLabel: string): string {
  const m = d.current, p = d.prior;
  const cells = [
    statCell("AP Written", $k(m.ap), delta(m.ap, p.ap, $k, priorLabel), "34%"),
    statCell("Policies", String(m.policies), delta(m.policies, p.policies, n => String(n), priorLabel), "33%"),
    m.closePct != null
      ? statCell("Close Rate", pct1(m.closePct), p.closePct != null ? delta(m.closePct, p.closePct, n => pct1(n), priorLabel) : "", "33%")
      : statCell("Est. Commission", $k(m.estCommission), delta(m.estCommission, p.estCommission, $k, priorLabel), "33%"),
  ];
  return `<tr><td style="border-top:1px solid ${C.line};border-bottom:1px solid ${C.line}">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>${cells.join("")}</tr></table>
  </td></tr>`;
}

function buildGoal(d: SummaryData, isEmpty: boolean): string {
  const pctShown = Math.min(999, Math.round(d.goalPct * 100));
  const remaining = Math.max(0, d.goal - d.current.ap);
  const sub = d.kind === "monthly"
    ? `Where ${d.monthName} landed against your ${$(d.goal)} target.`
    : `${d.daysLeft} days left — filling as you close.`;
  const paceLine = d.kind === "midmonth" && !isEmpty
    ? `<p style="margin:14px 0 0;font-size:13px;color:${C.muted}">Projected finish at this pace: <b style="color:${d.projected >= d.goal ? C.up : C.navy}">${$(Math.round(d.projected))}</b>${remaining > 0 ? ` &nbsp;·&nbsp; Needed per day: <b style="color:${C.navy}">${$(Math.round(d.needPerDay))}</b>` : ""}</p>`
    : "";
  return `<tr><td style="padding:34px 32px 30px">
    ${sectionHead(d.kind === "monthly" ? "Goal report" : "Goal to date", sub)}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
      <td style="font-size:14px;font-weight:700;color:${C.ink};padding-bottom:8px">${$(d.current.ap)} <span style="font-weight:500;color:${C.muted}">of ${$(d.goal)}</span></td>
      <td align="right" style="font-size:14px;font-weight:800;color:${C.navy};padding-bottom:8px">${pctShown}%</td>
    </tr></table>
    ${progressBar(d.goalPct * 100)}
    ${remaining > 0 && !isEmpty ? `<p style="margin:10px 0 0;font-size:12px;color:${C.muted}">${$(remaining)} to target</p>` : ""}
    ${d.goalPct >= 1 ? `<p style="margin:10px 0 0;font-size:12px;font-weight:700;color:${C.up}">Goal complete 🎉</p>` : ""}
    ${paceLine}
  </td></tr>`;
}

function buildBreakdown(d: SummaryData): string {
  const m = d.current;
  const rows: string[] = [];

  // Basic tier and up
  rows.push(row("Estimated commission", `COMP × your contract level`, $(m.estCommission)));
  // Parser seam: rendered ONLY if actual_commission is present (always null today).
  if (d.actualCommission != null) {
    rows.push(row("Confirmed commission", "from carrier statements", $(d.actualCommission)));
  }
  if (m.dials > 0) rows.push(row("Total dials", "", m.dials.toLocaleString("en-US")));
  if (m.closePct != null) rows.push(row("Close ratio", "policies ÷ dials", pct1(m.closePct)));

  // Pro + Max only
  if (d.tier !== "basic") {
    if (m.talkHours > 0) rows.push(row("Talk time", "", `${m.talkHours.toLocaleString("en-US")} hrs`));
    if (m.pickupPct != null) rows.push(row("Pickup ratio", "connected ÷ dials", pct1(m.pickupPct)));
    if (m.appointments > 0) rows.push(row("Appointments set", "", String(m.appointments)));
  }

  if (d.upcomingDrafts) {
    rows.push(row("Upcoming drafts", "next 7 days", `${d.upcomingDrafts.count} · ${$(d.upcomingDrafts.totalPremium)}`));
  }

  if (!rows.length) return "";
  return `<tr><td style="padding:0 32px 8px">
    ${sectionHead("The numbers", d.kind === "monthly" ? `Your full ${d.monthName} activity.` : `Activity through ${d.monthName} 14.`)}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table>
  </td></tr>`;
}

function buildTeam(d: SummaryData): string {
  const t = d.team!;
  const rows: string[] = [
    row("Team combined AP", `${t.memberCount} ${t.memberCount === 1 ? "agent" : "agents"} in your downline`, $(t.combinedAP)),
  ];
  if (t.topProducer) rows.push(row("Top producer", "this period", `${t.topProducer.name} · ${$(t.topProducer.ap)}`));
  if (t.idleAgents.length) {
    rows.push(row("No dials in 7 days", "may need a check-in", t.idleAgents.slice(0, 5).join(", ") + (t.idleAgents.length > 5 ? ` +${t.idleAgents.length - 5} more` : "")));
  }
  return `<tr><td style="padding:14px 32px 8px">
    ${sectionHead("Your team", "Downline rollup for the period.")}
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table>
  </td></tr>`;
}

// ---- plain text ----------------------------------------------------------------

function buildText(d: SummaryData, opts: RenderOpts, subject: string): string {
  const m = d.current;
  const lines = [
    subject, "",
    `${d.periodLabel}`,
    `AP written:            ${$(m.ap)}`,
    `Policies:              ${m.policies}`,
    `Estimated commission:  ${$(m.estCommission)}`,
    d.actualCommission != null ? `Confirmed commission:  ${$(d.actualCommission)}` : "",
    m.dials > 0 ? `Total dials:           ${m.dials}` : "",
    m.closePct != null ? `Close ratio:           ${pct1(m.closePct)}` : "",
    d.tier !== "basic" && m.talkHours > 0 ? `Talk time:             ${m.talkHours} hrs` : "",
    d.tier !== "basic" && m.pickupPct != null ? `Pickup ratio:          ${pct1(m.pickupPct)}` : "",
    d.tier !== "basic" && m.appointments > 0 ? `Appointments set:      ${m.appointments}` : "",
    d.upcomingDrafts ? `Upcoming drafts (7d):  ${d.upcomingDrafts.count} · ${$(d.upcomingDrafts.totalPremium)}` : "",
    "",
    `Goal: ${$(d.goal)} — ${Math.round(d.goalPct * 100)}% ${d.kind === "monthly" ? "reached" : "so far"}`,
    d.kind === "midmonth" && d.daysLeft > 0 ? `Needed per day: ${$(Math.round(d.needPerDay))} (${d.daysLeft} days left)` : "",
    d.team ? `\nTEAM — combined AP ${$(d.team.combinedAP)} across ${d.team.memberCount} agents` : "",
    d.team?.topProducer ? `Top producer: ${d.team.topProducer.name} (${$(d.team.topProducer.ap)})` : "",
    "",
    `Dashboard: ${opts.dashboardUrl}`,
    `Unsubscribe: ${opts.unsubscribeUrl}`,
  ];
  return lines.filter(l => l !== "").join("\n");
}

// ---- misc ----------------------------------------------------------------------

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function prevMonthName(name: string): string {
  const i = MONTHS.indexOf(name);
  return MONTHS[(i + 11) % 12];
}
function shortMonth(name: string): string { return name.slice(0, 3); }
