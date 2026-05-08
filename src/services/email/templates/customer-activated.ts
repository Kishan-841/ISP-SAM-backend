import type { Account } from '@prisma/client';
import { renderCallout, renderHeader, renderRow, wrapEmailShell } from './_helpers.js';

export type CustomerActivatedInput = {
  account: Pick<
    Account,
    'clientName' | 'companyName' | 'customerCode' | 'circuitId' | 'currentArc' | 'bandwidthMbps'
  >;
};

export function buildCustomerActivatedEmail(input: CustomerActivatedInput) {
  const subject = `New customer awaiting assignment: ${input.account.clientName}`;
  const arcLabel = `₹${Number(input.account.currentArc).toLocaleString('en-IN')} per year`;
  const bw = input.account.bandwidthMbps != null ? `${input.account.bandwidthMbps} Mbps` : '—';

  const bodyHtml = `
    ${renderHeader({
      kicker: 'New Customer · CRM Activation',
      title: input.account.clientName,
      subtitle: input.account.companyName ?? undefined,
      bg: '#fffbeb',
      border: '#fde68a',
      kickerColor: '#a16207',
    })}
    <tr>
      <td style="padding:20px 24px 8px;">
        <p style="margin:0;font-size:14px;color:#374151;">
          A new customer has been activated in CRM and synced into SAM. They are currently
          <strong>unassigned</strong> — assign a SAM from your team to take ownership.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 24px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
          ${renderRow('Customer Code', input.account.customerCode ?? '—', true)}
          ${renderRow('Circuit ID', input.account.circuitId ?? '—')}
          ${renderRow('Bandwidth', bw, true)}
          ${renderRow('Current ARC', arcLabel)}
        </table>
      </td>
    </tr>
    ${renderCallout({
      title: 'Action Required',
      body: 'Assign a SAM in your team via Customers → Unassigned filter.',
      bg: '#fef3c7',
      border: '#fde68a',
      titleColor: '#a16207',
      bodyColor: '#854d0e',
    })}
  `;

  const text = [
    `Subject: ${subject}`,
    '',
    `A new customer has been activated in CRM and synced into SAM. They are currently UNASSIGNED.`,
    '',
    `Client:        ${input.account.clientName}`,
    `Company:       ${input.account.companyName ?? '—'}`,
    `Customer Code: ${input.account.customerCode ?? '—'}`,
    `Circuit ID:    ${input.account.circuitId ?? '—'}`,
    `Bandwidth:     ${bw}`,
    `Current ARC:   ${arcLabel}`,
    '',
    'Action Required: Assign a SAM in your team via Customers → Unassigned filter.',
  ].join('\n');

  return { subject, html: wrapEmailShell({ preheader: subject, bodyHtml }), text };
}
