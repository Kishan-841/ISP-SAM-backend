import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { sweepDueTerminations } from '../commercial-changes/commercial-changes.service.js';

export type Requester = { id: string; role: UserRole };

export type ProbableChurnRow = {
  commercialChangeId: string;
  effectiveDate: string;
  retentionPromptDueAt: string | null;
  retentionDecision: 'RETAIN' | 'PROCEED' | null;
  retentionDecidedAt: string | null;
  scheduledTerminationAt: string | null;
  daysUntilPrompt: number | null;
  daysUntilTermination: number | null;
  disconnectionReason: string | null;
  customer: {
    id: string;
    clientName: string;
    companyName: string | null;
    customerCode: string | null;
  };
  samOwner: { id: string; name: string; email: string } | null;
  account: {
    id: string;
    contractStatus: 'PROBABLE_CHURN' | 'DISCONNECTING';
    /** Current ARC — kept on the account until day 31. Used for "at risk" totals. */
    currentArc: number;
    kittyType: 'BASE' | 'NEW';
  };
  /**
   * CRM hand-off info. Populated after SAM picks PROCEED on a CRM-synced
   * customer (externalCrmId present + CRM_SERVICE_ORDERS_ENABLED=true).
   * Lets the retention queue surface the CRM order number + workflow status
   * so SAM can see the disconnection has been picked up by the CRM team.
   */
  crmServiceOrderId: string | null;
  crmOrderNumber: string | null;
  crmStatus: string | null;
  crmStatusUpdatedAt: string | null;
};

/**
 * Retention queue — every account currently sitting in the 21-day probable-churn
 * window or the 10-day disconnecting window. Runs the lazy-termination sweep
 * first so accounts past their notice period drop off the list naturally.
 *
 * Role scoping: SAM sees their own only; SAM_HEAD/ADMIN see everything.
 */
export async function listProbableChurn(
  requester: Requester,
): Promise<{ rows: ProbableChurnRow[]; summary: { count: number; atRiskArc: number } }> {
  await sweepDueTerminations();

  const accountWhere: Prisma.AccountWhereInput = {
    contractStatus: { in: ['PROBABLE_CHURN', 'DISCONNECTING'] },
  };
  if (requester.role === 'SAM') accountWhere.samOwnerId = requester.id;

  const accounts = await prisma.account.findMany({
    where: accountWhere,
    select: {
      id: true,
      clientName: true,
      companyName: true,
      customerCode: true,
      contractStatus: true,
      currentArc: true,
      kittyType: true,
      samOwner: { select: { id: true, name: true, email: true } },
    },
  });

  if (accounts.length === 0) {
    return { rows: [], summary: { count: 0, atRiskArc: 0 } };
  }

  // The pending disconnection is the most-recent DISCONNECTION row with no
  // `accountAppliedAt` (still active). One per account by construction —
  // a new disconnection commit can't be raised while another is in flight.
  const changes = await prisma.commercialChange.findMany({
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      changeType: 'DISCONNECTION',
      accountAppliedAt: null,
    },
    orderBy: [{ accountId: 'asc' }, { createdAt: 'desc' }],
  });
  const byAccount = new Map<string, (typeof changes)[number]>();
  for (const c of changes) {
    if (!byAccount.has(c.accountId)) byAccount.set(c.accountId, c);
  }

  const today = startOfDayUTC(new Date());
  const rows: ProbableChurnRow[] = accounts
    .map((a) => {
      const c = byAccount.get(a.id);
      if (!c) return null;
      return {
        commercialChangeId: c.id,
        effectiveDate: c.effectiveDate.toISOString(),
        retentionPromptDueAt: c.retentionPromptDueAt?.toISOString() ?? null,
        retentionDecision: c.retentionDecision,
        retentionDecidedAt: c.retentionDecidedAt?.toISOString() ?? null,
        scheduledTerminationAt: c.scheduledTerminationAt?.toISOString() ?? null,
        daysUntilPrompt: c.retentionPromptDueAt ? daysBetween(c.retentionPromptDueAt, today) : null,
        daysUntilTermination: c.scheduledTerminationAt
          ? daysBetween(c.scheduledTerminationAt, today)
          : null,
        disconnectionReason: c.disconnectionReason,
        customer: {
          id: a.id,
          clientName: a.clientName,
          companyName: a.companyName,
          customerCode: a.customerCode,
        },
        samOwner: a.samOwner
          ? { id: a.samOwner.id, name: a.samOwner.name, email: a.samOwner.email }
          : null,
        account: {
          id: a.id,
          contractStatus: a.contractStatus as 'PROBABLE_CHURN' | 'DISCONNECTING',
          currentArc: Number(a.currentArc),
          kittyType: a.kittyType,
        },
        crmServiceOrderId: c.crmServiceOrderId,
        crmOrderNumber: c.crmOrderNumber,
        crmStatus: c.crmStatus,
        crmStatusUpdatedAt: c.crmStatusUpdatedAt?.toISOString() ?? null,
      };
    })
    .filter((r): r is ProbableChurnRow => r !== null)
    .sort((a, b) => {
      // Promptable rows (decision still null) bubble to the top.
      const aPending = a.retentionDecision === null ? 0 : 1;
      const bPending = b.retentionDecision === null ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
      const aDate = a.retentionPromptDueAt ?? '';
      const bDate = b.retentionPromptDueAt ?? '';
      return aDate.localeCompare(bDate);
    });

  const atRiskArc = rows.reduce((sum, r) => sum + r.account.currentArc, 0);
  return { rows, summary: { count: rows.length, atRiskArc } };
}

function startOfDayUTC(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function daysBetween(target: Date, from: Date): number {
  return Math.round((target.getTime() - from.getTime()) / 86_400_000);
}
