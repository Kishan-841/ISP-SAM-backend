import { prisma } from '../../prisma.js';

export type LogInput = {
  accountId: string;
  scheduledAt: Date;
  agenda: string | null;
  performedByUserId: string;
};

export type MarkHeldInput = {
  meetingId: string;
  heldAt: Date;
  performedByUserId: string;
};

export type SubmitMomInput = {
  meetingId: string;
  momContent: string;
  sentAt: Date;
  performedByUserId: string;
};

export const meetingsService = {
  async log(input: LogInput) {
    const account = await prisma.account.findUnique({ where: { id: input.accountId } });
    if (!account) throw new Error('Account not found');

    return prisma.$transaction(async (tx) => {
      const meeting = await tx.meeting.create({
        data: {
          accountId: input.accountId,
          scheduledAt: input.scheduledAt,
          agenda: input.agenda,
          createdBy: input.performedByUserId,
        },
      });
      await tx.auditLog.create({
        data: {
          entityType: 'Meeting',
          entityId: meeting.id,
          action: 'LOG',
          performedBy: input.performedByUserId,
          payload: {
            accountId: input.accountId,
            scheduledAt: input.scheduledAt.toISOString(),
          },
        },
      });
      return meeting;
    });
  },

  async list(opts: { recentLimit?: number; accountId?: string } = {}) {
    return prisma.meeting.findMany({
      where: opts.accountId ? { accountId: opts.accountId } : undefined,
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      take: opts.recentLimit ?? 100,
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            kittyType: true,
            samOwnerId: true,
            samOwner: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
  },

  async getById(id: string) {
    return prisma.meeting.findUnique({
      where: { id },
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            customerCode: true,
            circuitId: true,
            kittyType: true,
            samOwner: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
  },

  async markHeld(input: MarkHeldInput) {
    return prisma.$transaction(async (tx) => {
      const meeting = await tx.meeting.update({
        where: { id: input.meetingId },
        data: { heldAt: input.heldAt },
      });
      // Maintain Account.lastMeetingDate denorm.
      await tx.account.update({
        where: { id: meeting.accountId },
        data: { lastMeetingDate: input.heldAt },
      });
      await tx.auditLog.create({
        data: {
          entityType: 'Meeting',
          entityId: meeting.id,
          action: 'HELD',
          performedBy: input.performedByUserId,
          payload: { heldAt: input.heldAt.toISOString() },
        },
      });
      return meeting;
    });
  },

  async submitMom(input: SubmitMomInput) {
    return prisma.$transaction(async (tx) => {
      const meeting = await tx.meeting.update({
        where: { id: input.meetingId },
        data: {
          momContent: input.momContent,
          momSentAt: input.sentAt,
        },
      });
      await tx.account.update({
        where: { id: meeting.accountId },
        data: { lastMomDate: input.sentAt },
      });
      await tx.auditLog.create({
        data: {
          entityType: 'Meeting',
          entityId: meeting.id,
          action: 'MOM_SENT',
          performedBy: input.performedByUserId,
          payload: { momSentAt: input.sentAt.toISOString() },
        },
      });
      return meeting;
    });
  },
};
