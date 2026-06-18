// ============================================================
// supabase/functions/weekly-digest/email.ts
// HTML email template for the weekly performance digest.
// ============================================================

export interface WeeklyEmailOpts {
  firstName: string;
  weekStart: string;     // YYYY-MM-DD
  weekEnd: string;       // YYYY-MM-DD
  weekCount: number;
  weekAP: number;
  monthCount: number;
  monthAP: number;
  goal: number;
  goalPct: number;       // 0-1
  avgPerDay: number;
  projected: number;
  needPerDay: number;
  daysLeft: number;
  paceStatus: "ahead" | "on" | "behind";
  topCarrierWeek: { name: string; ap: number; count: number } | null;
  dashboardUrl: string;
}

const $ = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const pct = (n: number) => (n * 100).toFixed(n >= 1 ? 0 : 1) + "%";

function fmtDate(iso: string): string {
  // "2026-06-09" → "Jun 9"
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m - 1]} ${d}`;
}

function paceColor(status: "ahead" | "on" | "behind"): string {
  return status === "ahead"  ? "#34d399" :
         status === "on"     ? "#60a5fa" : "#f87171";
}

function paceBg(status: "ahead" | "on" | "behind"): string {
  return status === "ahead"  ? "rgba(52,211,153,.15)"  :
         status === "on"     ? "rgba(96,165,250,.15)"  :
                               "rgba(248,113,113,.15)";
}

function paceLabel(status: "ahead" | "on" | "behind"): string {
  return status === "ahead" ? "AHEAD OF PACE" :
         status === "on"    ? "ON PACE"       : "BEHIND PACE";
}

export function buildWeeklyEmail(opts: WeeklyEmailOpts): { subject: string; html: string; text: string } {
  const {
    firstName, weekStart, weekEnd, weekCount, weekAP,
    monthCount, monthAP, goal, goalPct, avgPerDay, projected,
    needPerDay, daysLeft, paceStatus, topCarrierWeek, dashboardUrl,
  } = opts;

  const weekLabel  = `${fmtDate(weekStart)} – ${fmtDate(weekEnd)}`;
  const monthLabel = new Date(weekEnd + "T12:00:00").toLocaleDateString("en-US", { month: "long" });
  const barWidth   = Math.round(goalPct * 100);
  const projColor  = projected >= goal ? "#34d399" : "#f87171";
  const color      = paceColor(paceStatus);
  const bg         = paceBg(paceStatus);
  const tag        = paceLabel(paceStatus);

  const subject = weekCount > 0
    ? `Week of ${weekLabel} — ${weekCount} ${weekCount === 1 ? "policy" : "policies"}, ${$(weekAP)} AP`
    : `Week of ${weekLabel} — your ${monthLabel} recap`;

  const topCarrierRow = topCarrierWeek
    ? `<tr><td style="padding:5px 0;font-size:13px;color:#64748b">Top carrier this week</td><td style="padding:5px 0;font-size:13px;font-weight:600;color:#0f172a;font-family:'SF Mono',Menlo,monospace;text-align:right">${topCarrierWeek.name} · ${$(topCarrierWeek.ap)}</td></tr>`
    : "";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">

        <!-- Header -->
        <tr><td style="background:#0b1f3a;padding:24px 32px">
          <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#60a5fa;margin-bottom:6px">PolicyPilot · Weekly Digest</div>
          <div style="font-size:22px;font-weight:700;color:#f1f5f9">Week of ${weekLabel}</div>
          ${firstName ? `<div style="font-size:14px;color:#94a3b8;margin-top:4px">Hi ${firstName} — here's how your week went.</div>` : ""}
        </td></tr>

        <!-- Last week hero -->
        <tr><td style="padding:28px 32px 0">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:#94a3b8;margin-bottom:14px">Last Week</div>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f1f5f9;border-radius:10px;padding:18px 20px">
            <tr>
              <td style="text-align:center;padding:0 16px 0 0;border-right:1px solid #e2e8f0">
                <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Policies</div>
                <div style="font-size:32px;font-weight:800;color:#0f172a;font-family:'SF Mono',Menlo,monospace;line-height:1">${weekCount}</div>
              </td>
              <td style="text-align:center;padding:0 0 0 16px">
                <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Annual Premium</div>
                <div style="font-size:32px;font-weight:800;color:#059669;font-family:'SF Mono',Menlo,monospace;line-height:1">${$(weekAP)}</div>
              </td>
            </tr>
          </table>
          ${topCarrierRow ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px">${topCarrierRow}</table>` : ""}
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:24px 32px 0"><hr style="border:none;border-top:1px solid #e2e8f0;margin:0"></td></tr>

        <!-- Month to date -->
        <tr><td style="padding:24px 32px 0">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:#94a3b8;margin-bottom:14px">${monthLabel} — Month to Date</div>

          <!-- Pace badge -->
          <div style="display:inline-block;background:${bg};color:${color};font-size:11px;font-weight:700;letter-spacing:.08em;padding:4px 10px;border-radius:6px;margin-bottom:14px">${tag}</div>

          <!-- Goal progress bar -->
          <div style="margin-bottom:6px;display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:13px;color:#64748b">Progress toward goal</span>
            <span style="font-size:13px;font-weight:700;color:#0f172a;font-family:'SF Mono',Menlo,monospace">${pct(goalPct)}</span>
          </div>
          <div style="height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;margin-bottom:18px">
            <div style="height:100%;width:${barWidth}%;background:#0b1f3a;border-radius:4px"></div>
          </div>

          <!-- Stats table -->
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">Policies written MTD</td>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;color:#0f172a;font-family:'SF Mono',Menlo,monospace;text-align:right">${monthCount}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">AP written MTD</td>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;color:#059669;font-family:'SF Mono',Menlo,monospace;text-align:right">${$(monthAP)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">Monthly goal</td>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;color:#0f172a;font-family:'SF Mono',Menlo,monospace;text-align:right">${$(goal)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">Avg AP / day so far</td>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;color:#0f172a;font-family:'SF Mono',Menlo,monospace;text-align:right">${$(avgPerDay)}/day</td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">Projected month-end AP</td>
              <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;color:${projColor};font-family:'SF Mono',Menlo,monospace;text-align:right">${$(projected)}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;font-size:13px;color:#64748b">${daysLeft > 0 ? `Needed to hit goal (${daysLeft} days left)` : "Days remaining"}</td>
              <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;font-family:'SF Mono',Menlo,monospace;text-align:right">
                ${monthAP >= goal ? "GOAL HIT 🎯" : daysLeft > 0 ? `${$(needPerDay)}/day` : "Month ended"}
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding:28px 32px 32px;text-align:center">
          <a href="${dashboardUrl}" style="display:inline-block;background:#0b1f3a;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:11px 24px;border-radius:8px">Open PolicyPilot →</a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0">
          <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center">PolicyPilot · Weekly Digest · Sent every Monday. Toggle off in the Book Intelligence tab.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `PolicyPilot — Week of ${weekLabel}`,
    ``,
    `LAST WEEK`,
    `Policies written: ${weekCount}`,
    `Annual premium:   ${$(weekAP)}`,
    topCarrierWeek ? `Top carrier:      ${topCarrierWeek.name} (${$(topCarrierWeek.ap)})` : "",
    ``,
    `${monthLabel.toUpperCase()} — MONTH TO DATE  [${tag}]`,
    `Policies MTD:       ${monthCount}`,
    `AP MTD:             ${$(monthAP)}`,
    `Monthly goal:       ${$(goal)}  (${pct(goalPct)} complete)`,
    `Avg AP/day:         ${$(avgPerDay)}/day`,
    `Projected month-end:${$(projected)}`,
    daysLeft > 0 && monthAP < goal
      ? `Needed to hit goal: ${$(needPerDay)}/day (${daysLeft} days left)`
      : monthAP >= goal ? `Goal hit!` : "",
    ``,
    `Open PolicyPilot: ${dashboardUrl}`,
  ].filter(l => l !== "").join("\n");

  return { subject, html, text };
}
