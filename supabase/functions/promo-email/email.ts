// ============================================================
// supabase/functions/promo-email/email.ts
// Promotional email template for non-subscribed agents.
// ============================================================

export interface PromoEmailOpts {
  firstName: string;
  siteUrl: string;
}

export function buildPromoEmail(opts: PromoEmailOpts): { subject: string; html: string; text: string } {
  const { firstName, siteUrl } = opts;
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";

  const subjects = [
    "The CRM built for life insurance agents — not generic sales teams",
    "Stop managing your book in spreadsheets",
    "Your competitors are tracking conversion windows. Are you?",
    "ProducerStackCRM: everything in one tab",
  ];
  // Rotate subject line based on day of month so repeat sends feel fresh.
  const subject = subjects[new Date().getDate() % subjects.length];

  const features = [
    {
      icon: "📋",
      title: "Smart Policy Tracker",
      body: "Every policy, status, and commission in one place. See pending, approved, issued, and paid at a glance — no spreadsheet required.",
    },
    {
      icon: "🎯",
      title: "Term Conversion Radar",
      body: "Automatically surfaces clients whose term policies are approaching conversion windows before the opportunity closes. Most agents miss these.",
    },
    {
      icon: "📞",
      title: "Built-in Power Dialer",
      body: "Call leads directly from the CRM with a click. No tab-switching, no copy-pasting numbers — just work your pipeline.",
    },
    {
      icon: "📈",
      title: "Weekly Performance Digest",
      body: "Every Monday morning you get a summary of last week's production, your month-to-date AP, and exactly how much you need to hit your goal.",
    },
  ];

  const featureRows = features.map(f => `
    <tr><td style="padding:16px 0;border-bottom:1px solid #e2e8f0">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="width:40px;vertical-align:top;padding-top:2px;font-size:22px">${f.icon}</td>
          <td style="padding-left:12px;vertical-align:top">
            <div style="font-size:14px;font-weight:700;color:#0b1f3a;margin-bottom:4px">${f.title}</div>
            <div style="font-size:13px;color:#475569;line-height:1.6">${f.body}</div>
          </td>
        </tr>
      </table>
    </td></tr>`).join("");

  const featureText = features.map(f => `• ${f.title}: ${f.body}`).join("\n\n");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f8fafc;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">

        <!-- Header -->
        <tr><td style="background:#0b1f3a;padding:28px 32px">
          <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#60a5fa;margin-bottom:8px">ProducerStackCRM</div>
          <div style="font-size:22px;font-weight:700;color:#f1f5f9;line-height:1.3">The CRM life insurance agents<br>actually want to use.</div>
        </td></tr>

        <!-- Intro -->
        <tr><td style="padding:28px 32px 0">
          <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.7">${greeting}</p>
          <p style="margin:0 0 20px;font-size:14px;color:#334155;line-height:1.7">
            You created an account on ProducerStackCRM — thanks for checking us out. We built this for one type of person: a life insurance agent who's tired of juggling spreadsheets, missed follow-ups, and generic CRMs that don't understand commission structures.
          </p>
          <p style="margin:0;font-size:14px;color:#334155;line-height:1.7">
            Here's what's waiting for you inside:
          </p>
        </td></tr>

        <!-- Features -->
        <tr><td style="padding:8px 32px 0">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${featureRows}
          </table>
        </td></tr>

        <!-- Social proof / closer -->
        <tr><td style="padding:24px 32px 0">
          <div style="background:#f1f5f9;border-radius:10px;padding:18px 20px">
            <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0b1f3a">Built by agents, for agents.</p>
            <p style="margin:0;font-size:13px;color:#475569;line-height:1.6">
              ProducerStackCRM was designed from the ground up for life insurance producers. Every feature — from the term conversion radar to the weekly digest — exists because real agents asked for it. No bloat, no features you'll never use.
            </p>
          </div>
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding:28px 32px 32px;text-align:center">
          <a href="${siteUrl}" style="display:inline-block;background:#0b1f3a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:13px 28px;border-radius:8px;letter-spacing:.01em">Get started free →</a>
          <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">Takes 2 minutes to set up. No credit card required to try it.</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0">
          <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center">
            ProducerStackCRM · You're receiving this because you signed up at producerstackcrm.com.<br>
            <a href="${siteUrl}" style="color:#94a3b8">Log in</a> · Reply to this email to reach us directly.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    subject,
    "",
    greeting,
    "",
    "You created an account on ProducerStackCRM — thanks for checking us out. Here's what's waiting for you inside:",
    "",
    featureText,
    "",
    "Built by agents, for agents. ProducerStackCRM was designed from the ground up for life insurance producers.",
    "",
    `Get started: ${siteUrl}`,
    "",
    "---",
    "ProducerStackCRM · Reply to this email to reach us directly.",
  ].join("\n");

  return { subject, html, text };
}
