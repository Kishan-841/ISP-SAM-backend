import type { CommercialChangeType, Account } from '@prisma/client';

export type EmailDraft = {
  subject: string;
  body: string;
};

const TYPE_LABEL: Record<CommercialChangeType, string> = {
  UPGRADE: 'Upgrade',
  DOWNGRADE: 'Downgrade',
  RATE_REVISION: 'Rate Revision',
  DISCONNECTION: 'Disconnection',
};

export function buildAccountsTeamDraft(opts: {
  account: Pick<Account, 'clientName' | 'customerCode' | 'circuitId' | 'samOwnerId'>;
  samOwnerName: string;
  changeType: CommercialChangeType;
  oldArc: number;
  newArc: number;
  effectiveDate: Date;
  reason: string | null;
}): EmailDraft {
  const delta = opts.newArc - opts.oldArc;
  const sign = delta > 0 ? '+' : '';
  const subject = `Commercial Change Alert – ${opts.account.clientName}`;
  const body = [
    `Subject: ${subject}`,
    '',
    `Client Name:        ${opts.account.clientName}`,
    `Customer Code:      ${opts.account.customerCode ?? '—'}`,
    `Circuit ID:         ${opts.account.circuitId ?? '—'}`,
    `Change Type:        ${TYPE_LABEL[opts.changeType]}`,
    `Old ARC:            ₹${opts.oldArc.toLocaleString('en-IN')}`,
    `New ARC:            ₹${opts.newArc.toLocaleString('en-IN')}`,
    `Delta:              ${sign}₹${delta.toLocaleString('en-IN')}`,
    `Effective Date:     ${opts.effectiveDate.toISOString().slice(0, 10)}`,
    `SAM Owner:          ${opts.samOwnerName}`,
    `Client Approval:    [Attached]`,
    `Reason:             ${opts.reason ?? '—'}`,
    '',
    'Action Required:',
    'Update billing system immediately.',
  ].join('\n');
  return { subject, body };
}
