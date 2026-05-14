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

const TYPE_CTA: Record<
  CommercialChangeType,
  { title: string; body: string; bg: string; border: string; titleColor: string; bodyColor: string }
> = {
  UPGRADE: {
    title: 'Action Required',
    body: 'Apply new ARC + bandwidth on the next bill cycle. Mark the CRM service-order COMPLETED once provisioning is done.',
    bg: '#ecfdf5',
    border: '#a7f3d0',
    titleColor: '#047857',
    bodyColor: '#065f46',
  },
  DOWNGRADE: {
    title: 'Action Required',
    body: 'Apply new (lower) ARC + bandwidth on the next bill cycle. Confirm reason matches the customer-supplied approval.',
    bg: '#fffbeb',
    border: '#fde68a',
    titleColor: '#b45309',
    bodyColor: '#78350f',
  },
  RATE_REVISION: {
    title: 'Action Required',
    body: 'Apply bandwidth uplift at the SAME ARC. No billing change — only the bandwidth field on the service-order needs updating.',
    bg: '#f5f3ff',
    border: '#ddd6fe',
    titleColor: '#6d28d9',
    bodyColor: '#4c1d95',
  },
  DISCONNECTION: {
    title: 'Disconnection Raised',
    body: 'Customer is now in the 21-day probable-churn retention window. No billing change until the day-21 decision + the 10-day notice expire.',
    bg: '#fef2f2',
    border: '#fecaca',
    titleColor: '#b91c1c',
    bodyColor: '#7f1d1d',
  },
};

export type CommercialChangeAlertInput = {
  account: Pick<Account, 'clientName' | 'companyName' | 'customerCode' | 'circuitId'>;
  changeType: CommercialChangeType;
  oldArc: number;
  newArc: number;
  oldBandwidthMbps: number | null;
  newBandwidthMbps: number | null;
  effectiveDate: Date;
  mailReceivedDate: Date | null;
  samOwnerName: string;
  /** SAM-XXXXXXXX cross-system reference. */
  samRef: string;
  reason: string | null;
  /** When true, no documents were attached — the change went through in test mode. */
  testMode?: boolean;
};

export function buildCommercialChangeAlertEmail(input: CommercialChangeAlertInput): {
  subject: string;
  html: string;
  text: string;
} {
  const customerLabel = input.account.companyName || input.account.clientName;
  const subject = `${TYPE_LABEL[input.changeType]} – ${customerLabel} (${input.samRef})`;
  const delta = input.newArc - input.oldArc;
  const arcSign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const typeColor = TYPE_COLOR[input.changeType];
  const deltaColor = delta > 0 ? '#10b981' : delta < 0 ? '#dc2626' : '#6b7280';
  const cta = TYPE_CTA[input.changeType];

  // Bandwidth display: only show the delta line when we know both values.
  const bwLine =
    input.oldBandwidthMbps != null && input.newBandwidthMbps != null
      ? `${input.oldBandwidthMbps} → ${input.newBandwidthMbps} Mbps`
      : input.newBandwidthMbps != null
        ? `${input.newBandwidthMbps} Mbps`
        : '—';
  const bwDelta =
    input.oldBandwidthMbps != null && input.newBandwidthMbps != null
      ? input.newBandwidthMbps - input.oldBandwidthMbps
      : null;

  const bodyHtml = `
    ${renderHeader({
      kicker: `${TYPE_LABEL[input.changeType]} · ${input.samRef}`,
      title: customerLabel,
      subtitle:
        input.account.companyName && input.account.clientName !== input.account.companyName
          ? input.account.clientName
          : undefined,
    })}
    <!-- Type badge + ARC headline -->
    <tr>
      <td style="padding:24px 24px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding:6px 12px;background:${typeColor}15;border:1px solid ${typeColor}40;border-radius:999px;color:${typeColor};font-size:12px;font-weight:600;">
              ${escapeHtml(TYPE_LABEL[input.changeType])}
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ARC + Bandwidth side by side -->
    <tr>
      <td style="padding:0 24px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td valign="top" width="50%" style="padding-right:8px;">
              <div style="padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                <div style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Annual Recurring Contribution</div>
                <div style="margin-top:6px;font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.01em;">
                  ₹${input.oldArc.toLocaleString('en-IN')}
                  <span style="color:#9ca3af;font-weight:400;"> → </span>
                  ₹${input.newArc.toLocaleString('en-IN')}
                </div>
                <div style="margin-top:4px;font-size:13px;font-weight:600;color:${deltaColor};">
                  ${arcSign}₹${Math.abs(delta).toLocaleString('en-IN')} / year
                </div>
              </div>
            </td>
            <td valign="top" width="50%" style="padding-left:8px;">
              <div style="padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                <div style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Bandwidth</div>
                <div style="margin-top:6px;font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.01em;">
                  ${escapeHtml(bwLine)}
                </div>
                ${
                  bwDelta !== null && bwDelta !== 0
                    ? `<div style="margin-top:4px;font-size:13px;font-weight:600;color:${bwDelta > 0 ? '#10b981' : '#dc2626'};">${bwDelta > 0 ? '+' : ''}${bwDelta} Mbps</div>`
                    : `<div style="margin-top:4px;font-size:13px;color:#9ca3af;">No bandwidth change</div>`
                }
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Detail rows -->
    <tr>
      <td style="padding:16px 24px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
          ${renderRow('Customer Code', input.account.customerCode ?? '—', true)}
          ${renderRow('Circuit ID', input.account.circuitId ?? '—')}
          ${renderRow('Effective Date', formatDate(input.effectiveDate), true)}
          ${renderRow('Mail Received', input.mailReceivedDate ? formatDate(input.mailReceivedDate) : '—')}
          ${renderRow('SAM Owner', input.samOwnerName, true)}
          ${renderRow('SAM Reference', input.samRef)}
          ${renderRow('Reason', input.reason ?? '—', true)}
          ${
            input.testMode
              ? renderRow('⚠ Test Mode', 'No supporting documents attached — committed under SAM_TEST_MODE.')
              : renderRow('Client Approval', '✓ Attached')
          }
        </table>
      </td>
    </tr>
    ${renderCallout(cta)}
  `;

  return {
    subject,
    html: wrapEmailShell({ preheader: subject, bodyHtml }),
    text: renderText(input, subject, bwLine, bwDelta),
  };
}

function renderText(
  input: CommercialChangeAlertInput,
  subject: string,
  bwLine: string,
  bwDelta: number | null,
): string {
  const delta = input.newArc - input.oldArc;
  const arcSign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  return [
    `Subject: ${subject}`,
    '',
    `Customer:           ${input.account.companyName || input.account.clientName}`,
    `Customer Code:      ${input.account.customerCode ?? '—'}`,
    `Circuit ID:         ${input.account.circuitId ?? '—'}`,
    `Change Type:        ${TYPE_LABEL[input.changeType]}`,
    `SAM Reference:      ${input.samRef}`,
    '',
    'ARC',
    `  Old:              ₹${input.oldArc.toLocaleString('en-IN')}`,
    `  New:              ₹${input.newArc.toLocaleString('en-IN')}`,
    `  Delta:            ${arcSign}₹${Math.abs(delta).toLocaleString('en-IN')}`,
    '',
    'Bandwidth',
    `  Current → New:    ${bwLine}`,
    bwDelta !== null && bwDelta !== 0
      ? `  Delta:            ${bwDelta > 0 ? '+' : ''}${bwDelta} Mbps`
      : '  Delta:            —',
    '',
    `Effective Date:     ${formatDate(input.effectiveDate)}`,
    `Mail Received:      ${input.mailReceivedDate ? formatDate(input.mailReceivedDate) : '—'}`,
    `SAM Owner:          ${input.samOwnerName}`,
    `Reason:             ${input.reason ?? '—'}`,
    input.testMode
      ? `Test Mode:          YES — no supporting documents attached`
      : `Client Approval:    [Attached]`,
    '',
    'Action Required:',
    ...input.testMode
      ? ['  Test commit — do not action.']
      : [TYPE_CTA[input.changeType].body].flatMap((s) => s.match(/.{1,72}(\s|$)/g) ?? [s]).map((l) => `  ${l.trim()}`),
  ].join('\n');
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
