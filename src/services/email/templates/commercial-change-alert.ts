import type { CommercialChangeType, Account } from '@prisma/client';
import { escapeHtml, renderCallout, renderHeader, renderRow, wrapEmailShell } from './_helpers.js';

const TYPE_LABEL: Record<CommercialChangeType, string> = {
  UPGRADE: 'Upgrade',
  DOWNGRADE: 'Downgrade',
  RATE_REVISION: 'Rate Revision',
  DISCONNECTION: 'Disconnection',
};

const TYPE_COLOR: Record<CommercialChangeType, string> = {
  UPGRADE: '#10b981',
  DOWNGRADE: '#f59e0b',
  RATE_REVISION: '#8b5cf6',
  DISCONNECTION: '#dc2626',
};

export type CommercialChangeAlertInput = {
  account: Pick<Account, 'clientName' | 'companyName' | 'customerCode' | 'circuitId'>;
  changeType: CommercialChangeType;
  oldArc: number;
  newArc: number;
  effectiveDate: Date;
  samOwnerName: string;
  reason: string | null;
};

export function buildCommercialChangeAlertEmail(input: CommercialChangeAlertInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Commercial Change Alert – ${input.account.clientName}`;
  const delta = input.newArc - input.oldArc;
  const sign = delta > 0 ? '+' : '';
  const typeColor = TYPE_COLOR[input.changeType];
  const deltaColor = delta > 0 ? '#10b981' : delta < 0 ? '#dc2626' : '#6b7280';

  const bodyHtml = `
    ${renderHeader({
      kicker: 'Commercial Change Alert',
      title: input.account.clientName,
      subtitle: input.account.companyName ?? undefined,
    })}
    <tr>
      <td style="padding:24px 24px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:6px 12px;background:${typeColor}15;border:1px solid ${typeColor}40;border-radius:999px;color:${typeColor};font-size:12px;font-weight:600;">
              ${TYPE_LABEL[input.changeType]}
            </td>
          </tr>
        </table>
        <div style="margin-top:18px;font-size:24px;font-weight:700;color:#111827;letter-spacing:-0.01em;">
          ₹${input.oldArc.toLocaleString('en-IN')}
          <span style="color:#9ca3af;font-weight:400;">→</span>
          ₹${input.newArc.toLocaleString('en-IN')}
        </div>
        <div style="margin-top:4px;font-size:14px;font-weight:600;color:${deltaColor};">
          ${sign}₹${delta.toLocaleString('en-IN')} per year
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 24px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
          ${renderRow('Customer Code', input.account.customerCode ?? '—', true)}
          ${renderRow('Circuit ID', input.account.circuitId ?? '—')}
          ${renderRow('Effective Date', input.effectiveDate.toISOString().slice(0, 10), true)}
          ${renderRow('SAM Owner', input.samOwnerName)}
          ${renderRow('Client Approval', '✓ Attached', true)}
          ${renderRow('Reason', input.reason ?? '—')}
        </table>
      </td>
    </tr>
    ${renderCallout({
      title: 'Action Required',
      body: 'Update billing system immediately.',
    })}
  `;

  return {
    subject,
    html: wrapEmailShell({ preheader: subject, bodyHtml }),
    text: renderText(input, subject),
  };
}

function renderText(input: CommercialChangeAlertInput, subject: string): string {
  const delta = input.newArc - input.oldArc;
  const sign = delta > 0 ? '+' : '';
  return [
    `Subject: ${subject}`,
    '',
    `Client Name:        ${input.account.clientName}`,
    `Customer Code:      ${input.account.customerCode ?? '—'}`,
    `Circuit ID:         ${input.account.circuitId ?? '—'}`,
    `Change Type:        ${TYPE_LABEL[input.changeType]}`,
    `Old ARC:            ₹${input.oldArc.toLocaleString('en-IN')}`,
    `New ARC:            ₹${input.newArc.toLocaleString('en-IN')}`,
    `Delta:              ${sign}₹${delta.toLocaleString('en-IN')}`,
    `Effective Date:     ${input.effectiveDate.toISOString().slice(0, 10)}`,
    `SAM Owner:          ${input.samOwnerName}`,
    `Client Approval:    [Attached]`,
    `Reason:             ${input.reason ?? '—'}`,
    '',
    'Action Required:',
    'Update billing system immediately.',
  ].join('\n');
}
// `escapeHtml` is unused in this file's hand-written strings (helpers escape
// internally), but keep the import shape so future inline edits don't trip.
void escapeHtml;
