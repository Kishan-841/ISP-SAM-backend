import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { sendMomToCustomer } from '../../services/email/notifications.service.js';

export type ActionItem = {
  srNo: number;
  discussionDescription: string;
  actionOwner: string;
  planOfAction: string;
  closureDate: string | null;
  currentStatus: 'Open' | 'In Progress' | 'Closed';
};

export type LogInput = {
  accountId: string;
  scheduledAt: Date;
  agenda: string | null;
  meetingType: 'ONLINE' | 'PHYSICAL';
  location: string | null;
  clientParticipants: string | null;
  gazonParticipants: string | null;
  actionItems: ActionItem[] | null;
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
          meetingType: input.meetingType,
          location: input.location,
          clientParticipants: input.clientParticipants,
          gazonParticipants: input.gazonParticipants,
          actionItems: input.actionItems
            ? (input.actionItems as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
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
            meetingType: input.meetingType,
            actionItemsCount: input.actionItems?.length ?? 0,
          },
        },
      });
      return meeting;
    });
  },

  async list(opts: { recentLimit?: number; accountId?: string } = {}) {
    const meetings = await prisma.meeting.findMany({
      where: opts.accountId ? { accountId: opts.accountId } : undefined,
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      take: opts.recentLimit ?? 100,
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            companyName: true,
            customerCode: true,
            circuitId: true,
            kittyType: true,
            samOwnerId: true,
            samOwner: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    const userIds = Array.from(new Set(meetings.map((m) => m.createdBy)));
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    return meetings.map((m) => ({
      ...m,
      createdByUser: userMap.get(m.createdBy) ?? null,
    }));
  },

  async getById(id: string) {
    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            companyName: true,
            customerCode: true,
            circuitId: true,
            kittyType: true,
            samOwnerId: true,
            samOwner: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    if (!meeting) return null;
    const createdByUser = await prisma.user.findUnique({
      where: { id: meeting.createdBy },
      select: { id: true, name: true, email: true },
    });
    return { ...meeting, createdByUser };
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
    const meeting = await prisma.$transaction(async (tx) => {
      const m = await tx.meeting.update({
        where: { id: input.meetingId },
        data: {
          momContent: input.momContent,
          momSentAt: input.sentAt,
        },
      });
      await tx.account.update({
        where: { id: m.accountId },
        data: { lastMomDate: input.sentAt },
      });
      await tx.auditLog.create({
        data: {
          entityType: 'Meeting',
          entityId: m.id,
          action: 'MOM_SENT',
          performedBy: input.performedByUserId,
          payload: { momSentAt: input.sentAt.toISOString() },
        },
      });
      return m;
    });

    // Fire the customer email best-effort, OUTSIDE the transaction. Failure
    // doesn't roll back — the MOM is still recorded. Outcome is audited
    // separately via NOTIFY_MOM_TO_CUSTOMER.
    const account = await prisma.account.findUnique({
      where: { id: meeting.accountId },
      select: {
        id: true,
        clientName: true,
        companyName: true,
        customerCode: true,
        circuitId: true,
        email: true,
        samOwnerId: true,
      },
    });
    if (account) {
      await sendMomToCustomer({
        meetingId: meeting.id,
        account,
        meetingScheduledAt: meeting.scheduledAt,
        meetingHeldAt: meeting.heldAt,
        meetingType: meeting.meetingType,
        momContent: input.momContent,
        performedByUserId: input.performedByUserId,
      });
    }

    return meeting;
  },
};
