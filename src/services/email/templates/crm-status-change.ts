import type { Account, CommercialChangeType } from '@prisma/client';
import { renderCallout, renderHeader, renderRow, wrapEmailShell } from './_helpers.js';

export type CrmStatusChangeKind = 'PENDING_SAM_ACTIVATION' | 'COMPLETED';

export type CrmStatusChangeInput = {
  kind: CrmStatusChangeKind;
  account: Pick<Account, 'clientName' | 'companyName' | 'customerCode' | 'circuitId'>;
  changeType: CommercialChangeType;
  oldArc: number;
  newArc: number;
  crmOrderNumber: string | null;
  samOwnerName: string;
};

const TYPE_LABEL: Record<CommercialChangeType, string> = {
  UPGRADE: 'Upgrade',
  DOWNGRADE: 'Downgrade',
  RATE_REVISION: 'Rate Revision',
  DISCONNECTION: 'Disconnection',
};

export function buildCrmStatusChangeEmail(input: CrmStatusChangeInput) {
  const isActivationPending = input.kind === 'PENDING_SAM_ACTIVATION';
  const subject = isActivationPending
    ? `Action required — set activation date for ${input.account.clientName}`
    : `Order completed — ${input.account.clientName}`;

  const headerOpts = isActivationPending
    ? {
        kicker: 'CRM · Awaiting Activation Date',
        bg: '#fff7ed',
        border: '#fed7aa',
        kickerColor: '#c2410c',
      }
    : {
        kicker: 'CRM · Order Completed',
        bg: '#f0fdf4',
        border: '#bbf7d0',
        kickerColor: '#15803d',
      };

  const calloutOpts = isActivationPending
    ? {
        title: 'Action Required',
        body: 'Confirm the customer-agreed billing-start date and submit it via Transactions → Set Activation.',
        bg: '#fef2f2',
        border: '#fecaca',
        titleColor: '#b91c1c',
        bodyColor: '#7f1d1d',
      }
    : {
        title: 'Billing Live',
        body: 'CRM has finalised this order. The SAM-side account row now reflects the new ARC and bandwidth.',
        bg: '#ecfdf5',
        border: '#a7f3d0',
        titleColor: '#15803d',
        bodyColor: '#166534',
      };

  const bodyHtml = `
    ${renderHeader({
      ...headerOpts,
      title: input.account.clientName,
      subtitle: input.account.companyName ?? undefined,
    })}
    <tr>
      <td style="padding:20px 24px 8px;">
        <p style="margin:0;font-size:14px;color:#374151;">
          The CRM service-order linked to your <strong>${TYPE_LABEL[input.changeType]}</strong> has moved to
          <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:12px;">${input.kind}</code>.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 24px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
          ${renderRow('Customer Code', input.account.customerCode ?? '—', true)}
          ${renderRow('Circuit ID', input.account.circuitId ?? '—')}
          ${renderRow('CRM Order', input.crmOrderNumber ?? '—', true)}
          ${renderRow('Change', `${TYPE_LABEL[input.changeType]} · ₹${input.oldArc.toLocaleString('en-IN')} → ₹${input.newArc.toLocaleString('en-IN')}`)}
          ${renderRow('SAM Owner', input.samOwnerName, true)}
        </table>
      </td>
    </tr>
    ${renderCallout(calloutOpts)}
  `;

  const text = [
    `Subject: ${subject}`,
    '',
    `The CRM service-order linked to your ${TYPE_LABEL[input.changeType]} has moved to ${input.kind}.`,
    '',
    `Customer:      ${input.account.clientName}`,
    `Customer Code: ${input.account.customerCode ?? '—'}`,
    `Circuit ID:    ${input.account.circuitId ?? '—'}`,
    `CRM Order:     ${input.crmOrderNumber ?? '—'}`,
    `Change:        ${TYPE_LABEL[input.changeType]} · ₹${input.oldArc.toLocaleString('en-IN')} → ₹${input.newArc.toLocaleString('en-IN')}`,
    `SAM Owner:     ${input.samOwnerName}`,
    '',
    isActivationPending
      ? 'Action Required: confirm billing-start date with the customer and submit via Transactions → Set Activation.'
      : 'Billing live — CRM has finalised this order.',
  ].join('\n');

  return { subject, html: wrapEmailShell({ preheader: subject, bodyHtml }), text };
}
