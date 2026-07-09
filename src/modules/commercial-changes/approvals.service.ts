import type { ApprovalStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import {
  PROBABLE_CHURN_WINDOW_DAYS,
  addDays,
  quickApprovalAccountScope,
  startOfDayUTC,
  type Requester,
} from './commercial-changes.service.js';

/**
 * Internal approval chain for BASE (existing-base) commercial changes.
 *
 * The chain depends on the change type:
 *   UPGRADE / DOWNGRADE / RATE_REVISION → PENDING_ACCOUNTS
 *   DISCONNECTION (normal)              → PENDING_SUPER_ADMIN_2 → PENDING_ACCOUNTS
 *   DISCONNECTION (quick)               → PENDING_SUPER_ADMIN_2 → PENDING_SAM_HEAD → PENDING_ACCOUNTS
 *
 * Only the TERMINAL approval (leaving PENDING_ACCOUNTS) produces a side effect:
 *   non-disconnection → apply new ARC/bandwidth, account back to ACTIVE
 *   normal disconnect → enter the 21-day retention window (PROBABLE_CHURN)
 *   quick disconnect  → account DISCONNECTING, terminate in quickRequestedDays
 *
 * Intermediate stages are pure sign-offs. Any stage may reject with a mandatory
 * reason → terminal REJECTED, account restored to ACTIVE, raising SAM notified.
 */

const PENDING_STAGES = [
  'PENDING_SUPER_ADMIN_2',
  'PENDING_SAM_HEAD',
  'PENDING_ACCOUNTS',
] as const satisfies readonly ApprovalStatus[];

type PendingStage = (typeof PENDING_STAGES)[number];

function isPendingStage(s: ApprovalStatus): s is PendingStage {
  return (PENDING_STAGES as readonly string[]).includes(s);
}

/** The role that owns (can act on) each pending stage. ADMIN overrides all. */
const STAGE_ROLE: Record<PendingStage, UserRole> = {
  PENDING_SUPER_ADMIN_2: 'SUPER_ADMIN_2',
  PENDING_SAM_HEAD: 'SAM_HEAD',
  PENDING_ACCOUNTS: 'ACCOUNTS',
};

/** Next stage on approve; null = terminal (apply the real effect). */
function nextStage(current: PendingStage, isQuickDisc: boolean): PendingStage | null {
  switch (current) {
    case 'PENDING_SUPER_ADMIN_2':
      return isQuickDisc ? 'PENDING_SAM_HEAD' : 'PENDING_ACCOUNTS';
    case 'PENDING_SAM_HEAD':
      return 'PENDING_ACCOUNTS';
    case 'PENDING_ACCOUNTS':
      return null;
  }
}

const QUEUE_INCLUDE = {
  account: {
    select: {
      id: true,
      clientName: true,
      companyName: true,
      customerCode: true,
      circuitId: true,
      kittyType: true,
      currentArc: true,
      bandwidthMbps: true,
      contractStatus: true,
      samOwner: { select: { id: true, name: true, email: true } },
    },
  },
} satisfies Prisma.CommercialChangeInclude;

/**
 * The `where` clause for "changes awaiting the requester's approval stage".
 * Shared by the approvals queue (listPending) and the sidebar badge count
 * so the two can never disagree. Returns null for roles with no stage.
 *
 * Role-scoping:
 *   ADMIN         → every pending stage (the whole pipeline)
 *   ACCOUNTS      → PENDING_ACCOUNTS (org-wide)
 *   SUPER_ADMIN_2 → PENDING_SUPER_ADMIN_2 (org-wide)
 *   SAM_HEAD      → PENDING_SAM_HEAD, scoped to their team
 *   others        → nothing
 */
export async function pendingApprovalsWhere(
  requester: Requester,
): Promise<Prisma.CommercialChangeWhereInput | null> {
  switch (requester.role) {
    case 'ADMIN':
      return { approvalStatus: { in: [...PENDING_STAGES] } };
    case 'ACCOUNTS':
      return { approvalStatus: 'PENDING_ACCOUNTS' };
    case 'SUPER_ADMIN_2':
      return { approvalStatus: 'PENDING_SUPER_ADMIN_2' };
    case 'SAM_HEAD': {
      const scope = await quickApprovalAccountScope(requester);
      return {
        approvalStatus: 'PENDING_SAM_HEAD',
        ...(scope ? { account: scope } : {}),
      };
    }
    default:
      return null;
  }
}

export const approvalsService = {
  /**
   * Queue of changes awaiting the requester's stage.
   */
  async listPending(requester: Requester) {
    const where = await pendingApprovalsWhere(requester);
    if (!where) return [];

    const rows = await prisma.commercialChange.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }],
      include: QUEUE_INCLUDE,
    });
    return rows.map(serializeQueueRow);
  },

  /**
   * How many changes are awaiting the requester's stage — the sidebar badge.
   * Same scoping as listPending; 0 for roles with no queue (e.g. SAM).
   */
  async countPending(requester: Requester): Promise<number> {
    const where = await pendingApprovalsWhere(requester);
    if (!where) return 0;
    return prisma.commercialChange.count({ where });
  },

  /**
   * Approve or reject the change at its current stage. Returns the updated row
   * (with the account's resulting contractStatus). Throws on:
   *   - not found / not pending
   *   - wrong role for the stage (unless ADMIN)
   *   - SAM_HEAD acting outside their team
   *   - reject without a reason
   */
  async decide(opts: {
    commercialChangeId: string;
    action: 'APPROVE' | 'REJECT';
    reason: string | null;
    performedByUserId: string;
    requesterRole: UserRole;
    ipAddress: string | null;
    userAgent: string | null;
  }) {
    const change = await prisma.commercialChange.findUnique({
      where: { id: opts.commercialChangeId },
      include: { account: true },
    });
    if (!change) throw new Error('Commercial change not found');

    const stage = change.approvalStatus;
    if (!isPendingStage(stage)) {
      throw new Error(
        `NOT_PENDING: This change is not awaiting approval (status ${stage}).`,
      );
    }

    await assertCanAct({
      stage,
      accountSamOwnerId: change.account.samOwnerId,
      requesterRole: opts.requesterRole,
      performedByUserId: opts.performedByUserId,
    });

    if (opts.action === 'REJECT') {
      const reason = (opts.reason ?? '').trim();
      if (reason.length < 3) {
        throw new Error(
          'REJECTION_REASON_REQUIRED: A reason is mandatory when rejecting a commercial change.',
        );
      }
      return rejectChange({
        change,
        stage,
        reason,
        performedByUserId: opts.performedByUserId,
        ipAddress: opts.ipAddress,
        userAgent: opts.userAgent,
      });
    }
    return approveChange({ change, stage, ...opts });
  },
};

async function assertCanAct(opts: {
  stage: PendingStage;
  accountSamOwnerId: string | null;
  requesterRole: UserRole;
  performedByUserId: string;
}): Promise<void> {
  if (opts.requesterRole === 'ADMIN') return; // god-mode fallback
  if (opts.requesterRole !== STAGE_ROLE[opts.stage]) {
    throw new Error(
      `WRONG_STAGE: This change is awaiting ${STAGE_ROLE[opts.stage]}, not ${opts.requesterRole}.`,
    );
  }
  // The SAM_HEAD quick-disconnect stage is team-scoped, mirroring the old
  // /quick-approvals behaviour: a head only signs off on their own team's
  // customers.
  if (opts.stage === 'PENDING_SAM_HEAD') {
    const scope = await quickApprovalAccountScope({
      id: opts.performedByUserId,
      role: opts.requesterRole,
    });
    if (scope) {
      const allowed = (scope.samOwnerId as { in: string[] }).in;
      if (!opts.accountSamOwnerId || !allowed.includes(opts.accountSamOwnerId)) {
        throw new Error(
          'OUT_OF_SCOPE: This approval belongs to a customer outside your team.',
        );
      }
    }
  }
}

type ChangeWithAccount = Prisma.CommercialChangeGetPayload<{
  include: { account: true };
}>;

async function approveChange(opts: {
  change: ChangeWithAccount;
  stage: PendingStage;
  performedByUserId: string;
  requesterRole: UserRole;
  ipAddress: string | null;
  userAgent: string | null;
}) {
  const { change, stage, performedByUserId, ipAddress, userAgent } = opts;
  const isQuickDisc =
    change.changeType === 'DISCONNECTION' && change.disconnectionMode === 'QUICK';
  const next = nextStage(stage, isQuickDisc);
  const decidedAt = new Date();

  if (next) {
    // Advance to the next stage — no side effect on the account yet.
    await prisma.$transaction([
      prisma.commercialChange.update({
        where: { id: change.id },
        data: { approvalStatus: next },
      }),
      prisma.auditLog.create({
        data: {
          entityType: 'CommercialChange',
          entityId: change.id,
          action: 'APPROVAL_ADVANCED',
          performedBy: performedByUserId,
          ipAddress,
          userAgent,
          payload: { from: stage, to: next, accountId: change.accountId },
        },
      }),
    ]);
  } else {
    // Terminal approval — mark APPROVED and apply the real effect atomically.
    await applyTerminalApproval({ change, stage, performedByUserId, ipAddress, userAgent, decidedAt });
  }

  return prisma.commercialChange.findUniqueOrThrow({
    where: { id: change.id },
    include: { account: { select: { id: true, contractStatus: true } } },
  });
}

/**
 * Final ACCOUNTS approval. Marks the change APPROVED and applies its effect in
 * a single transaction so the row can never be APPROVED-but-not-applied:
 *   non-disconnection → new ARC/bandwidth, account ACTIVE, accountAppliedAt set
 *   normal disconnect → PROBABLE_CHURN, retention window anchored at approval
 *   quick disconnect  → DISCONNECTING, terminate in quickRequestedDays
 */
async function applyTerminalApproval(opts: {
  change: ChangeWithAccount;
  stage: PendingStage;
  performedByUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
  decidedAt: Date;
}): Promise<void> {
  const { change, stage, performedByUserId, ipAddress, userAgent, decidedAt } = opts;

  const auditPayload: Prisma.InputJsonValue = {
    from: stage,
    changeType: change.changeType,
    accountId: change.accountId,
    disconnectionMode: change.disconnectionMode,
  };

  if (change.changeType !== 'DISCONNECTION') {
    await prisma.$transaction([
      prisma.commercialChange.update({
        where: { id: change.id },
        data: { approvalStatus: 'APPROVED', accountAppliedAt: decidedAt },
      }),
      prisma.account.update({
        where: { id: change.accountId },
        data: {
          currentArc: Number(change.newArc),
          ...(change.newBandwidthMbps != null
            ? { bandwidthMbps: change.newBandwidthMbps }
            : {}),
          contractStatus: 'ACTIVE',
        },
      }),
      prisma.auditLog.create({
        data: {
          entityType: 'CommercialChange',
          entityId: change.id,
          action: 'APPROVAL_APPROVED',
          performedBy: performedByUserId,
          ipAddress,
          userAgent,
          payload: auditPayload,
        },
      }),
    ]);
    return;
  }

  if (change.disconnectionMode === 'QUICK') {
    const days = change.quickRequestedDays ?? 1;
    const scheduledTerminationAt = startOfDayUTC(addDays(new Date(), days));
    await prisma.$transaction([
      prisma.commercialChange.update({
        where: { id: change.id },
        data: {
          approvalStatus: 'APPROVED',
          scheduledTerminationAt,
          retentionDecision: 'PROCEED',
          retentionDecidedAt: decidedAt,
        },
      }),
      prisma.account.update({
        where: { id: change.accountId },
        data: { contractStatus: 'DISCONNECTING' },
      }),
      prisma.auditLog.create({
        data: {
          entityType: 'CommercialChange',
          entityId: change.id,
          action: 'APPROVAL_APPROVED',
          performedBy: performedByUserId,
          ipAddress,
          userAgent,
          payload: {
            ...auditPayload,
            scheduledTerminationAt: scheduledTerminationAt.toISOString().slice(0, 10),
          },
        },
      }),
    ]);
    return;
  }

  // Normal disconnection → 21-day retention window, anchored at approval time.
  const prompt = startOfDayUTC(decidedAt);
  prompt.setUTCDate(prompt.getUTCDate() + PROBABLE_CHURN_WINDOW_DAYS);
  await prisma.$transaction([
    prisma.commercialChange.update({
      where: { id: change.id },
      data: { approvalStatus: 'APPROVED', retentionPromptDueAt: prompt },
    }),
    prisma.account.update({
      where: { id: change.accountId },
      data: { contractStatus: 'PROBABLE_CHURN' },
    }),
    prisma.auditLog.create({
      data: {
        entityType: 'CommercialChange',
        entityId: change.id,
        action: 'APPROVAL_APPROVED',
        performedBy: performedByUserId,
        ipAddress,
        userAgent,
        payload: {
          ...auditPayload,
          retentionPromptDueAt: prompt.toISOString().slice(0, 10),
        },
      },
    }),
  ]);
}

async function rejectChange(opts: {
  change: ChangeWithAccount;
  stage: PendingStage;
  reason: string;
  performedByUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}) {
  const { change, stage, reason, performedByUserId, ipAddress, userAgent } = opts;
  const decidedAt = new Date();
  await prisma.$transaction([
    prisma.commercialChange.update({
      where: { id: change.id },
      data: {
        approvalStatus: 'REJECTED',
        rejectionReason: reason,
        rejectedBy: performedByUserId,
        rejectedAt: decidedAt,
      },
    }),
    // Restore the account to ACTIVE. Guard on PENDING_APPROVAL so a drifted
    // account (a separate flow moved it) rolls the whole reject back (P2025).
    prisma.account.update({
      where: { id: change.accountId, contractStatus: 'PENDING_APPROVAL' },
      data: { contractStatus: 'ACTIVE' },
    }),
    prisma.auditLog.create({
      data: {
        entityType: 'CommercialChange',
        entityId: change.id,
        action: 'APPROVAL_REJECTED',
        performedBy: performedByUserId,
        ipAddress,
        userAgent,
        payload: { stage, reason, accountId: change.accountId },
      },
    }),
  ]);
  return prisma.commercialChange.findUniqueOrThrow({
    where: { id: change.id },
    include: { account: { select: { id: true, contractStatus: true } } },
  });
}

function serializeQueueRow(
  c: Prisma.CommercialChangeGetPayload<{ include: typeof QUEUE_INCLUDE }>,
) {
  return {
    id: c.id,
    accountId: c.accountId,
    changeType: c.changeType,
    approvalStatus: c.approvalStatus,
    oldArc: Number(c.oldArc),
    newArc: Number(c.newArc),
    oldBandwidthMbps: c.oldBandwidthMbps,
    newBandwidthMbps: c.newBandwidthMbps,
    effectiveDate: c.effectiveDate.toISOString().slice(0, 10),
    mailReceivedDate: c.mailReceivedDate?.toISOString().slice(0, 10) ?? null,
    reason: c.reason,
    disconnectionMode: c.disconnectionMode,
    disconnectionReason: c.disconnectionReason,
    quickRequestedDays: c.quickRequestedDays,
    quickApprovalReason: c.quickApprovalReason,
    approvalFileUrl: c.approvalFileUrl,
    poFileUrl: c.poFileUrl,
    requestedAt: c.createdAt.toISOString(),
    account: {
      id: c.account.id,
      clientName: c.account.clientName,
      companyName: c.account.companyName,
      customerCode: c.account.customerCode,
      circuitId: c.account.circuitId,
      kittyType: c.account.kittyType,
      currentArc: Number(c.account.currentArc),
      bandwidthMbps: c.account.bandwidthMbps,
      contractStatus: c.account.contractStatus,
      samOwner: c.account.samOwner,
    },
  };
}
