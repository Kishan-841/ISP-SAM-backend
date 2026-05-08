import type { KittyType, UserRole, Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { sendCustomerAssignedAlert } from '../../services/email/notifications.service.js';

export type Requester = { id: string; role: UserRole };

/**
 * Owner filter:
 *  - 'mine'        → assigned to the requester (only meaningful for SAM/SAM_HEAD)
 *  - 'unassigned'  → samOwnerId IS NULL (the SAM_HEAD triage queue)
 *  - 'team'        → owned by anyone reporting to the requester (SAM_HEAD only)
 *  - 'all' / undef → no owner filter applied (subject to role scoping below)
 */
export type OwnerFilter = 'mine' | 'unassigned' | 'team' | 'all';

const ACCOUNT_INCLUDE = {
  samOwner: { select: { id: true, name: true, email: true, role: true } },
} as const;

// Note: `currentArc` is Prisma `Decimal` and JSON-serialises as a string.
// The frontend type at sam-frontend/services/accounts.ts mirrors this.
export const accountsService = {
  async list({
    kittyType,
    owner,
    requester,
  }: {
    kittyType?: KittyType;
    owner?: OwnerFilter;
    requester: Requester;
  }) {
    const where: Prisma.AccountWhereInput = {};
    if (kittyType) where.kittyType = kittyType;

    // Role-based scoping (always applied first).
    //  SAM       → only own customers
    //  SAM_HEAD  → own customers + their team's + unassigned (triage queue)
    //  ADMIN     → all
    if (requester.role === 'SAM') {
      where.samOwnerId = requester.id;
    } else if (requester.role === 'SAM_HEAD') {
      const reportIds = await listReportIds(requester.id);
      // SAM_HEAD sees: their own assignments + every SAM under them + unassigned.
      where.OR = [
        { samOwnerId: requester.id },
        { samOwnerId: { in: reportIds } },
        { samOwnerId: null },
      ];
    }

    // Owner-filter narrows further within the scope above.
    if (owner === 'mine') {
      where.samOwnerId = requester.id;
      delete where.OR;
    } else if (owner === 'unassigned') {
      where.samOwnerId = null;
      delete where.OR;
    } else if (owner === 'team' && requester.role === 'SAM_HEAD') {
      const reportIds = await listReportIds(requester.id);
      where.samOwnerId = { in: reportIds };
      delete where.OR;
    }

    return prisma.account.findMany({
      where,
      include: ACCOUNT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  async getById(id: string, requester: Requester) {
    const account = await prisma.account.findUnique({
      where: { id },
      include: ACCOUNT_INCLUDE,
    });
    if (!account) return null;
    if (requester.role === 'SAM' && account.samOwnerId !== requester.id) {
      return null; // Pretend it doesn't exist — don't leak existence to non-owners.
    }
    return account;
  },

  /**
   * Assign or unassign a customer. Returns the updated account.
   * Authorisation is enforced by the caller (controller); this layer just
   * runs the update + audit log inside one transaction.
   */
  async assign({
    accountId,
    samUserId,
    requester,
  }: {
    accountId: string;
    samUserId: string | null;
    requester: Requester;
  }) {
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true, samOwnerId: true },
      });
      if (!before) throw new Error('Account not found');

      const updated = await tx.account.update({
        where: { id: accountId },
        data: { samOwnerId: samUserId },
        include: ACCOUNT_INCLUDE,
      });

      await tx.auditLog.create({
        data: {
          entityType: 'Account',
          entityId: accountId,
          action: samUserId ? 'ASSIGN' : 'UNASSIGN',
          performedBy: requester.id,
          payload: {
            from: before.samOwnerId,
            to: samUserId,
          },
        },
      });

      return updated;
    });

    // Best-effort: notify the new owner that they have a customer to manage.
    // Skipped for unassigns and silent-on-failure (audit-logged).
    if (samUserId && updated.samOwner) {
      const performer = await prisma.user.findUnique({
        where: { id: requester.id },
        select: { id: true, name: true },
      });
      if (performer) {
        await sendCustomerAssignedAlert({
          accountId: updated.id,
          account: updated,
          newOwner: {
            id: updated.samOwner.id,
            name: updated.samOwner.name,
            email: updated.samOwner.email,
          },
          assignedBy: { id: performer.id, name: performer.name },
        });
      }
    }

    return updated;
  },
};

/** Direct reports of a SAM_HEAD (SAMs whose samHeadId === headId). */
async function listReportIds(headId: string): Promise<string[]> {
  const reports = await prisma.user.findMany({
    where: { samHeadId: headId },
    select: { id: true },
  });
  return reports.map((r) => r.id);
}
