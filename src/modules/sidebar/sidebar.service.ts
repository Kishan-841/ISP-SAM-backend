import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { approvalsService } from '../commercial-changes/approvals.service.js';
import { startOfDayUTC } from '../commercial-changes/commercial-changes.service.js';

export type Requester = { id: string; role: UserRole };

export type SidebarCounts = {
  /** Changes awaiting the requester's approval stage. */
  approvals: number;
  /** Disconnections whose 21-day retention prompt is due and undecided. */
  probableChurn: number;
  /** Newly-activated customers still in the triage queue (no SAM owner). */
  unassignedCustomers: number;
};

export const sidebarService = {
  /**
   * Badge counts for the sidebar. Each is scoped so a role only sees what's
   * actionable for it — irrelevant roles get 0 and the UI hides the badge.
   * Runs the three counts concurrently; each is a single COUNT query.
   */
  async getCounts(requester: Requester): Promise<SidebarCounts> {
    const [approvals, probableChurn, unassignedCustomers] = await Promise.all([
      approvalsService.countPending(requester),
      countProbableChurnDue(requester),
      countUnassignedCustomers(requester),
    ]);
    return { approvals, probableChurn, unassignedCustomers };
  },
};

/**
 * Disconnections sitting in the retention window whose day-21 prompt has come
 * due and hasn't been answered — i.e. the SAM must pick RETAIN or PROCEED.
 * SAM sees their own; everyone else (SAM_HEAD / ADMIN / org-wide roles) sees
 * all, matching the /probable-churn page which only scopes SAM.
 */
async function countProbableChurnDue(requester: Requester): Promise<number> {
  const today = startOfDayUTC(new Date());
  const where: Prisma.CommercialChangeWhereInput = {
    changeType: 'DISCONNECTION',
    retentionDecision: null,
    retentionPromptDueAt: { lte: today },
    account: {
      contractStatus: 'PROBABLE_CHURN',
      ...(requester.role === 'SAM' ? { samOwnerId: requester.id } : {}),
    },
  };
  return prisma.commercialChange.count({ where });
}

/**
 * Customers in the triage queue (no SAM owner). Only SAM_HEAD and ADMIN
 * assign, so the badge is meaningful only for them — everyone else gets 0.
 */
async function countUnassignedCustomers(requester: Requester): Promise<number> {
  if (requester.role !== 'SAM_HEAD' && requester.role !== 'ADMIN') return 0;
  return prisma.account.count({
    where: {
      samOwnerId: null,
      contractStatus: { not: 'TERMINATED' },
    },
  });
}
