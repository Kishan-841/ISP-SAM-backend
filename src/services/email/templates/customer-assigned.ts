import type { Account } from '@prisma/client';
import { renderCallout, renderHeader, renderRow, wrapEmailShell } from './_helpers.js';

export type CustomerAssignedInput = {
  account: Pick<
    Account,
    'clientName' | 'companyName' | 'customerCode' | 'circuitId' | 'currentArc' | 'bandwidthMbps'
  >;
  newOwnerName: string;
  assignedByName: string;
};

export function buildCustomerAssignedEmail(input: CustomerAssignedInput) {
  const subject = `New customer assigned: ${input.account.clientName}`;
  const arcLabel = `₹${Number(input.account.currentArc).toLocaleString('en-IN')} per year`;
  const bw = input.account.bandwidthMbps != null ? `${input.account.bandwidthMbps} Mbps` : '—';

  const bodyHtml = `
    ${renderHeader({
      kicker: 'Customer Assigned',
      title: input.account.clientName,
      subtitle: input.account.companyName ?? undefined,
      bg: '#eff6ff',
      border: '#bfdbfe',
      kickerColor: '#1d4ed8',
    })}
    <tr>
      <td style="padding:20px 24px 8px;">
        <p style="margin:0;font-size:14px;color:#374151;">
          Hi ${input.newOwnerName.split(/\s+/)[0]}, you have a new customer to manage.
          ${input.assignedByName} just handed this account to you.
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
          ${renderRow('Assigned by', input.assignedByName, true)}
        </table>
      </td>
    </tr>
    ${renderCallout({
      title: 'Next Step',
      body: 'Schedule a kickoff meeting and log it within the platform — first MOM is your onboarding signal.',
      bg: '#f0fdf4',
      border: '#bbf7d0',
      titleColor: '#15803d',
      bodyColor: '#166534',
    })}
  `;

  const text = [
    `Subject: ${subject}`,
    '',
    `Hi ${input.newOwnerName.split(/\s+/)[0]},`,
    '',
    `You have a new customer to manage. ${input.assignedByName} just handed this account to you.`,
    '',
    `Client:        ${input.account.clientName}`,
    `Company:       ${input.account.companyName ?? '—'}`,
    `Customer Code: ${input.account.customerCode ?? '—'}`,
    `Circuit ID:    ${input.account.circuitId ?? '—'}`,
    `Bandwidth:     ${bw}`,
    `Current ARC:   ${arcLabel}`,
    `Assigned by:   ${input.assignedByName}`,
    '',
    'Next step: schedule a kickoff meeting and log it within the platform.',
  ].join('\n');

  return { subject, html: wrapEmailShell({ preheader: subject, bodyHtml }), text };
}
