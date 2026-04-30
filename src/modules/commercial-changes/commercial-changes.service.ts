import path from 'node:path';
import fs from 'node:fs/promises';
import type { CommercialChangeType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { buildAccountsTeamDraft, type EmailDraft } from './notification-bridge.js';

export type Requester = { id: string; role: UserRole };

export type CommitInput = {
  accountId: string;
  changeType: CommercialChangeType;
  newMrr: number;
  newBandwidthMbps: number | null;
  effectiveDate: Date;
  reason: string | null;
  approvalFile: { buffer: Buffer; originalName: string };
  performedByUserId: string;
};

export type CommitResult = {
  commercialChange: {
    id: string;
    accountId: string;
    changeType: CommercialChangeType;
    oldMrr: number;
    newMrr: number;
    effectiveDate: string;
    approvalFileUrl: string;
  };
  emailDraft: EmailDraft;
};

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

export const commercialChangesService = {
  async commit(input: CommitInput): Promise<CommitResult> {
    const account = await prisma.account.findUnique({
      where: { id: input.accountId },
    });
    if (!account) {
      throw new Error('Account not found');
    }

    const performingUser = await prisma.user.findUnique({
      where: { id: input.performedByUserId },
    });
    if (!performingUser) {
      throw new Error('Authenticated user not found');
    }

    // 1. Persist the file to disk under uploads/<accountId>/
    const accountDir = path.join(UPLOADS_ROOT, input.accountId);
    await fs.mkdir(accountDir, { recursive: true });
    const safeName = input.approvalFile.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${Date.now()}-${safeName}`;
    const fullPath = path.join(accountDir, filename);
    await fs.writeFile(fullPath, input.approvalFile.buffer);
    const relativeUrl = path.posix.join('uploads', input.accountId, filename);

    const oldMrr = Number(account.currentMrr);
    const oldBandwidth = account.bandwidthMbps ?? null;
    const isTermination = input.changeType === 'TERMINATION';

    // 2. Transaction: create commercial_change, update account, write audit log
    const result = await prisma.$transaction(async (tx) => {
      const change = await tx.commercialChange.create({
        data: {
          accountId: input.accountId,
          changeType: input.changeType,
          oldMrr,
          newMrr: input.newMrr,
          effectiveDate: input.effectiveDate,
          clientApprovalAttached: true,
          approvalFileUrl: relativeUrl,
          createdBy: input.performedByUserId,
          reason: input.reason,
          oldBandwidthMbps: oldBandwidth,
          newBandwidthMbps: input.newBandwidthMbps,
        },
      });

      const accountUpdate: Prisma.AccountUpdateInput = {
        currentMrr: input.newMrr,
        bandwidthMbps: input.newBandwidthMbps ?? account.bandwidthMbps,
      };
      if (isTermination) {
        accountUpdate.contractStatus = 'TERMINATED';
        accountUpdate.currentMrr = 0;
      }
      await tx.account.update({ where: { id: input.accountId }, data: accountUpdate });

      await tx.auditLog.create({
        data: {
          entityType: 'CommercialChange',
          entityId: change.id,
          action: 'COMMIT',
          performedBy: input.performedByUserId,
          payload: {
            accountId: input.accountId,
            changeType: input.changeType,
            oldMrr,
            newMrr: input.newMrr,
            effectiveDate: input.effectiveDate.toISOString(),
            approvalFileUrl: relativeUrl,
          },
        },
      });

      return change;
    });

    const emailDraft = buildAccountsTeamDraft({
      account,
      samOwnerName: performingUser.name,
      changeType: input.changeType,
      oldMrr,
      newMrr: input.newMrr,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
    });

    return {
      commercialChange: {
        id: result.id,
        accountId: result.accountId,
        changeType: result.changeType,
        oldMrr: Number(result.oldMrr),
        newMrr: Number(result.newMrr),
        effectiveDate: result.effectiveDate.toISOString(),
        approvalFileUrl: relativeUrl,
      },
      emailDraft,
    };
  },

  async list(opts: { type?: CommercialChangeType; requester: Requester }) {
    // SAMs see only their own; SAM_HEAD/ADMIN see all
    const accountWhere =
      opts.requester.role === 'SAM' ? { samOwnerId: opts.requester.id } : undefined;

    return prisma.commercialChange.findMany({
      where: {
        ...(opts.type ? { changeType: opts.type } : {}),
        ...(accountWhere ? { account: accountWhere } : {}),
      },
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            customerCode: true,
            circuitId: true,
            kittyType: true,
          },
        },
      },
      orderBy: [{ effectiveDate: 'desc' }, { id: 'desc' }],
    });
  },
};
