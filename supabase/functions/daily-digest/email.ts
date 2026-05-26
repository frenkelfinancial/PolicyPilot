// ============================================================
// supabase/functions/daily-digest/email.ts
// HTML email template for the morning brief.
// ============================================================
import type { ScoredOpportunity } from "../_shared/scoring.ts";

const dollars = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

function urgencyTag(days: number): { label: string; color: string; bg: string } {
  if (days <= 90)  return { label: 'CRITICAL', color: '#dc2626', bg: '#fee2e2' };
  if (days <= 365) return { label: 'SOON',     color: '#d97706', bg: '#fef3c7' };
  return                  { label: 'WATCH',    color: '#059669', bg: '#d1fae5' };
}

export function buildDigestEmail(opts: {
  agentName: string;
  top: ScoredOpportunity[];
  totalAv: number;
  totalOpen: number;
  dashboardUrl: string;
}): { subject: string; html: string; text: string } {
  const { agentName, top, totalAv, totalOpen, dashboardUrl } = opts;
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = top.length > 0
    ? `${dateStr} — ${top.length} conversion opportunit${top.length === 1 ? 'y' : 'ies'} on your book (${dollars(totalAv)} AV)`
    : `${dateStr} — Your book is clean today`;

  const cardHtml = top.map((o) => {
    const u = urgencyTag(o.urgencyDays);
    return `
      <tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div style="flex:1">
            <div style="display:inline-block;background:${u.bg};color:${u.color};font-size:10px;font-weight:700;letter-spacing:.08em;padding:2px 7px;border-radius:10px;margin-bottom:6px">${u.label}</div>
            <div style="font-size:15px;font-weight:600;color:#0f172a;margin-bottom:2px">${o.client}</div>
            <div style="font-size:12px;color:#64748b;margin-bottom:6px">Term-${o.termLengthYears} · ${o.carrier} · ${dollars(o.faceAmount)} face · Issued ${o.issueDate.slice(0,4)}</div>
            <div style="font-size:13px;color:#334155">Conversion window closes in <strong>${o.urgencyDays} days</strong> (${o.deadline}).</div>
          </div>
          <div style="text-align:right;min-width:90px">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em">Est. comm.</div>
            <div style="font-size:18px;font-weight:700;color:#059669;font-family:'SF Mono',Menlo,monospace">${dollars(o.estCommission)}</div>
          </div>
        </div>
      </td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:14px;padding:28px 32px;box-shadow:0 1px 3px rgba(0,0,0,.05)">
        <tr><td>
          <div style="font-size:11px;font-weight:600;color:#3b82f6;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px">PolicyPilot · Book Intelligence</div>
          <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#0f172a">Good morning${agentName ? ', ' + agentName : ''}.</h1>
          <p style="margin:0 0 20px;font-size:14px;color:#64748b">Your top conversion opportunities for ${dateStr}.</p>

          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:8px;background:#f1f5f9;border-radius:10px;padding:14px 16px">
            <tr>
              <td><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em">Estimated AV</div><div style="font-size:22px;font-weight:700;color:#059669;font-family:'SF Mono',Menlo,monospace">${dollars(totalAv)}</div></td>
              <td><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em">Open</div><div style="font-size:22px;font-weight:700;color:#0f172a;font-family:'SF Mono',Menlo,monospace">${totalOpen}</div></td>
              <td><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em">Top 3</div><div style="font-size:22px;font-weight:700;color:#0f172a;font-family:'SF Mono',Menlo,monospace">${top.length}</div></td>
            </tr>
          </table>

          ${top.length > 0 ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:18px">${cardHtml}</table>` : `<p style="margin:24px 0;font-size:14px;color:#64748b">No conversion windows opening this week — your book is in good shape.</p>`}

          <div style="margin-top:24px;text-align:center">
            <a href="${dashboardUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 20px;border-radius:8px">Open the full radar →</a>
          </div>

          <p style="margin:28px 0 0;font-size:11px;color:#94a3b8;text-align:center">PolicyPilot · You're receiving this because Book Intelligence digest is on. Toggle it off any time in the Book Intelligence tab.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  // Plain-text fallback for clients that don't render HTML.
  const text = [
    `${dateStr} — Book Intelligence morning brief`,
    ``,
    `Estimated AV: ${dollars(totalAv)} across ${totalOpen} open opportunit${totalOpen === 1 ? 'y' : 'ies'}.`,
    ``,
    ...top.map((o, i) => {
      const u = urgencyTag(o.urgencyDays);
      return `${i + 1}. [${u.label}] ${o.client} — Term-${o.termLengthYears} ${o.carrier}\n   Conversion in ${o.urgencyDays} days (${o.deadline}). Est. ${dollars(o.estCommission)}.`;
    }),
    ``,
    `Open the radar: ${dashboardUrl}`,
  ].join('\n');

  return { subject, html, text };
}
