/** Shared helpers for the inline-styled HTML email templates. */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap a body fragment in the standard SAM email shell (header brand strip,
 *  footer signature). The fragment is inserted between header and footer. */
export function wrapEmailShell(opts: {
  preheader: string;
  bodyHtml: string;
}): string {
  return `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <span style="display:none;max-height:0;overflow:hidden;color:#f9fafb;">${escapeHtml(opts.preheader)}</span>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f9fafb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          ${opts.bodyHtml}
          <tr>
            <td style="padding:14px 24px;background:#f9fafb;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;">
              Sent automatically by SAM · Gazon Communications India Ltd.
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim();
}

/** Render a header strip ("kicker" + title + optional subtitle). */
export function renderHeader(opts: {
  kicker: string;
  kickerColor?: string;
  title: string;
  subtitle?: string;
  bg?: string;
  border?: string;
}): string {
  const bg = opts.bg ?? '#fff7ed';
  const border = opts.border ?? '#fed7aa';
  const kickerColor = opts.kickerColor ?? '#c2410c';
  return `
    <tr>
      <td style="padding:20px 24px;background:${bg};border-bottom:1px solid ${border};">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${kickerColor};">${escapeHtml(opts.kicker)}</div>
        <div style="margin-top:4px;font-size:18px;font-weight:600;color:#111827;">${escapeHtml(opts.title)}</div>
        ${opts.subtitle ? `<div style="margin-top:2px;font-size:13px;color:#6b7280;">${escapeHtml(opts.subtitle)}</div>` : ''}
      </td>
    </tr>`;
}

/** Render a 2-column key/value row inside a detail table. */
export function renderRow(label: string, value: string, alt = false): string {
  return `
    <tr>
      <td style="padding:8px 0;${alt ? '' : 'border-top:1px solid #f3f4f6;'}width:140px;color:#6b7280;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;${alt ? '' : 'border-top:1px solid #f3f4f6;'}color:#111827;font-weight:500;">${escapeHtml(value)}</td>
    </tr>`;
}

/** Render a CTA strip near the bottom of the email. */
export function renderCallout(opts: {
  title: string;
  body: string;
  bg?: string;
  border?: string;
  titleColor?: string;
  bodyColor?: string;
}): string {
  return `
    <tr>
      <td style="padding:16px 24px;background:${opts.bg ?? '#fef2f2'};border-top:1px solid ${opts.border ?? '#fecaca'};">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${opts.titleColor ?? '#b91c1c'};">${escapeHtml(opts.title)}</div>
        <div style="margin-top:4px;font-size:14px;color:${opts.bodyColor ?? '#7f1d1d'};">${escapeHtml(opts.body)}</div>
      </td>
    </tr>`;
}
