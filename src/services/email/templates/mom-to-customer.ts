import type { Account, MeetingType } from '@prisma/client';
import { escapeHtml, renderHeader, renderRow, wrapEmailShell } from './_helpers.js';

export type MomToCustomerInput = {
  account: Pick<Account, 'clientName' | 'companyName' | 'customerCode' | 'circuitId'>;
  samName: string;
  meetingScheduledAt: Date;
  meetingHeldAt: Date | null;
  meetingType: MeetingType;
  momContent: string;
};

const DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const DATETIME_FMT = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function formatDate(d: Date): string {
  return DATE_FMT.format(d);
}

function formatDateTime(d: Date): string {
  return DATETIME_FMT.format(d);
}

/** Convert plain text MOM (which may contain line breaks) to HTML paragraphs. */
function momContentToHtml(raw: string): string {
  const escaped = escapeHtml(raw.trim());
  // Double newline → paragraph break; single newline → <br>.
  const paragraphs = escaped.split(/\n\s*\n/);
  return paragraphs
    .map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#111827;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function buildMomToCustomerEmail(input: MomToCustomerInput): {
  subject: string;
  html: string;
  text: string;
} {
  const customerName = input.account.companyName || input.account.clientName;
  const heldOrScheduled = input.meetingHeldAt ?? input.meetingScheduledAt;
  const subject = `Minutes of Meeting — ${customerName} — ${formatDate(heldOrScheduled)}`;

  const detailRows: string[] = [];
  detailRows.push(renderRow('Meeting Date', formatDateTime(heldOrScheduled), true));
  detailRows.push(renderRow('Meeting Type', input.meetingType === 'PHYSICAL' ? 'Physical' : 'Online'));
  if (input.account.customerCode) {
    detailRows.push(renderRow('Customer Code', input.account.customerCode));
  }
  if (input.account.circuitId) {
    detailRows.push(renderRow('Circuit ID', input.account.circuitId));
  }

  const bodyHtml = `
    ${renderHeader({
      kicker: 'Minutes of Meeting',
      title: customerName,
      subtitle: `From ${escapeHtml(input.samName)}, Gazon Communications`,
    })}
    <tr>
      <td style="padding:24px;">
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#111827;">
          Hi ${escapeHtml(input.account.clientName)},
        </p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#374151;">
          Thank you for your time. Please find below the minutes of our recent meeting
          for your records. Reply to this email if anything needs correction.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:14px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
              <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;">Meeting Details</div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 16px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                ${detailRows.join('')}
              </table>
            </td>
          </tr>
        </table>

        <div style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#c2410c;">
          Minutes of Meeting
        </div>
        <div style="padding:16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;margin-bottom:20px;">
          ${momContentToHtml(input.momContent)}
        </div>

        <p style="margin:24px 0 4px;font-size:14px;color:#374151;">
          Best regards,
        </p>
        <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">
          ${escapeHtml(input.samName)}
        </p>
        <p style="margin:0;font-size:13px;color:#6b7280;">
          Gazon Communications India Ltd.
        </p>
      </td>
    </tr>`;

  const html = wrapEmailShell({
    preheader: `Minutes of meeting on ${formatDate(heldOrScheduled)} — ${customerName}`,
    bodyHtml,
  });

  // Plain-text fallback.
  const lines: string[] = [];
  lines.push(`Hi ${input.account.clientName},`);
  lines.push('');
  lines.push('Thank you for your time. Please find below the minutes of our recent meeting.');
  lines.push('');
  lines.push(`Meeting Date: ${formatDateTime(heldOrScheduled)}`);
  lines.push(`Type: ${input.meetingType === 'PHYSICAL' ? 'Physical' : 'Online'}`);
  if (input.account.customerCode) lines.push(`Customer Code: ${input.account.customerCode}`);
  if (input.account.circuitId) lines.push(`Circuit ID: ${input.account.circuitId}`);
  lines.push('');
  lines.push('--- Minutes of Meeting ---');
  lines.push(input.momContent.trim());
  lines.push('--- End ---');
  lines.push('');
  lines.push('Best regards,');
  lines.push(input.samName);
  lines.push('Gazon Communications India Ltd.');

  return { subject, html, text: lines.join('\n') };
}
