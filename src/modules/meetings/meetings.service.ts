import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { sendMomToCustomer } from '../../services/email/notifications.service.js';

function parseParticipantsJson(
  s: string | null,
): { name: string; position?: string }[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s) as Array<{ name?: unknown; position?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p): p is { name: string; position?: string } =>
        !!p && typeof p.name === 'string' && p.name.trim().length > 0,
      )
      .map((p) => ({
        name: p.name,
        position: typeof p.position === 'string' ? p.position : undefined,
      }));
  } catch {
    return [];
  }
}

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

export type SendMomEmailInput = {
  accountId: string;
  scheduledAt: Date;
  meetingType: 'ONLINE' | 'PHYSICAL';
  location: string | null;
  agenda: string | null;
  clientParticipants: string | null;
  gazonParticipants: string | null;
  actionItems: ActionItem[] | null;
  momContent: string;
  toOverride: string | null;
  ccOverride: string[] | null;
  subjectOverride: string | null;
  samDesignation: string | null;
  samPhone: string | null;
  testMode: boolean;
  performedByUserId: string;
};

export type DeleteMeetingInput = {
  meetingId: string;
  performedByUserId: string;
};

export type CompleteMeetingInput = {
  meetingId: string;
  agenda: string | null;
  clientParticipants: string | null;
  gazonParticipants: string | null;
  actionItems: ActionItem[] | null;
  momContent: string;
  toOverride: string | null;
  ccOverride: string[] | null;
  subjectOverride: string | null;
  samDesignation: string | null;
  samPhone: string | null;
  testMode: boolean;
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

  async sendMomEmail(input: SendMomEmailInput) {
    const account = await prisma.account.findUnique({
      where: { id: input.accountId },
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
    if (!account) throw new Error('Account not found');

    const now = new Date();
    const meeting = await prisma.$transaction(async (tx) => {
      const m = await tx.meeting.create({
        data: {
          accountId: input.accountId,
          scheduledAt: input.scheduledAt,
          heldAt: input.scheduledAt,
          momContent: input.momContent,
          momSentAt: now,
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
      await tx.account.update({
        where: { id: input.accountId },
        data: { lastMeetingDate: input.scheduledAt, lastMomDate: now },
      });
      await tx.auditLog.createMany({
        data: [
          {
            entityType: 'Meeting',
            entityId: m.id,
            action: 'LOG',
            performedBy: input.performedByUserId,
            payload: {
              accountId: input.accountId,
              scheduledAt: input.scheduledAt.toISOString(),
              meetingType: input.meetingType,
              actionItemsCount: input.actionItems?.length ?? 0,
              viaSendMomEmail: true,
            },
          },
          {
            entityType: 'Meeting',
            entityId: m.id,
            action: 'HELD',
            performedBy: input.performedByUserId,
            payload: { heldAt: input.scheduledAt.toISOString() },
          },
          {
            entityType: 'Meeting',
            entityId: m.id,
            action: 'MOM_SENT',
            performedBy: input.performedByUserId,
            payload: { momSentAt: now.toISOString() },
          },
        ],
      });
      return m;
    });

    if (input.testMode) {
      await prisma.auditLog.create({
        data: {
          entityType: 'Meeting',
          entityId: meeting.id,
          action: 'NOTIFY_MOM_TO_CUSTOMER',
          performedBy: input.performedByUserId,
          payload: { outcome: 'SKIPPED', detail: 'testMode=true (no email dispatched)' },
        },
      });
      return { meeting, emailStatus: 'SKIPPED' as const };
    }

    const emailResult = await sendMomToCustomer({
      meetingId: meeting.id,
      account,
      meetingScheduledAt: meeting.scheduledAt,
      meetingHeldAt: meeting.heldAt,
      meetingType: meeting.meetingType,
      location: meeting.location,
      clientParticipants: parseParticipantsJson(input.clientParticipants),
      gazonParticipants: parseParticipantsJson(input.gazonParticipants),
      actionItems: input.actionItems ?? [],
      momContent: input.momContent,
      performedByUserId: input.performedByUserId,
      toOverride: input.toOverride,
      ccOverride: input.ccOverride,
      subjectOverride: input.subjectOverride,
      samDesignation: input.samDesignation,
      samPhone: input.samPhone,
    });

    return { meeting, emailStatus: emailResult.status };
  },

  async completeMeeting(input: CompleteMeetingInput) {
    const existing = await prisma.meeting.findUnique({
      where: { id: input.meetingId },
      include: {
        account: {
          select: {
            id: true,
            clientName: true,
            companyName: true,
            customerCode: true,
            circuitId: true,
            email: true,
            samOwnerId: true,
          },
        },
      },
    });
    if (!existing) throw new Error('Meeting not found');

    const now = new Date();
    const heldAt = existing.heldAt ?? existing.scheduledAt;

    const meeting = await prisma.$transaction(async (tx) => {
      const m = await tx.meeting.update({
        where: { id: input.meetingId },
        data: {
          agenda: input.agenda,
          clientParticipants: input.clientParticipants,
          gazonParticipants: input.gazonParticipants,
          actionItems: input.actionItems
            ? (input.actionItems as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
          heldAt,
          momContent: input.momContent,
          momSentAt: now,
        },
      });
      await tx.account.update({
        where: { id: m.accountId },
        data: { lastMeetingDate: heldAt, lastMomDate: now },
      });
      const auditRows: Prisma.AuditLogCreateManyInput[] = [];
      if (!existing.heldAt) {
        auditRows.push({
          entityType: 'Meeting',
          entityId: m.id,
          action: 'HELD',
          performedBy: input.performedByUserId,
          payload: { heldAt: heldAt.toISOString() },
        });
      }
      auditRows.push({
        entityType: 'Meeting',
        entityId: m.id,
        action: 'MOM_SENT',
        performedBy: input.performedByUserId,
        payload: { momSentAt: now.toISOString() },
      });
      await tx.auditLog.createMany({ data: auditRows });
      return m;
    });

    if (input.testMode) {
      await prisma.auditLog.create({
        data: {
          entityType: 'Meeting',
          entityId: meeting.id,
          action: 'NOTIFY_MOM_TO_CUSTOMER',
          performedBy: input.performedByUserId,
          payload: { outcome: 'SKIPPED', detail: 'testMode=true (no email dispatched)' },
        },
      });
      return { meeting, emailStatus: 'SKIPPED' as const };
    }

    const emailResult = await sendMomToCustomer({
      meetingId: meeting.id,
      account: existing.account,
      meetingScheduledAt: meeting.scheduledAt,
      meetingHeldAt: meeting.heldAt,
      meetingType: meeting.meetingType,
      location: meeting.location,
      clientParticipants: parseParticipantsJson(input.clientParticipants),
      gazonParticipants: parseParticipantsJson(input.gazonParticipants),
      actionItems: input.actionItems ?? [],
      momContent: input.momContent,
      performedByUserId: input.performedByUserId,
      toOverride: input.toOverride,
      ccOverride: input.ccOverride,
      subjectOverride: input.subjectOverride,
      samDesignation: input.samDesignation,
      samPhone: input.samPhone,
    });

    return { meeting, emailStatus: emailResult.status };
  },

  async remove(input: DeleteMeetingInput) {
    const existing = await prisma.meeting.findUnique({
      where: { id: input.meetingId },
    });
    if (!existing) throw new Error('Meeting not found');

    return prisma.$transaction(async (tx) => {
      const snapshot = {
        accountId: existing.accountId,
        scheduledAt: existing.scheduledAt.toISOString(),
        heldAt: existing.heldAt?.toISOString() ?? null,
        momSentAt: existing.momSentAt?.toISOString() ?? null,
        momContent: existing.momContent,
        meetingType: existing.meetingType,
        location: existing.location,
        agenda: existing.agenda,
        clientParticipants: existing.clientParticipants,
        gazonParticipants: existing.gazonParticipants,
        actionItems: existing.actionItems,
        createdBy: existing.createdBy,
        createdAt: existing.createdAt.toISOString(),
      };
      // Write audit BEFORE deletion. AuditLog.entityId is just a uuid string
      // (no FK), so the row remains queryable after the meeting is gone.
      await tx.auditLog.create({
        data: {
          entityType: 'Meeting',
          entityId: existing.id,
          action: 'DELETE',
          performedBy: input.performedByUserId,
          payload: { snapshot },
        },
      });
      await tx.meeting.delete({ where: { id: existing.id } });

      // Recompute the account denorms from the remaining meetings, since the
      // deleted row may have been the most recent meeting / MoM.
      const recentMeeting = await tx.meeting.findFirst({
        where: { accountId: existing.accountId, heldAt: { not: null } },
        orderBy: { heldAt: 'desc' },
        select: { heldAt: true },
      });
      const recentMom = await tx.meeting.findFirst({
        where: { accountId: existing.accountId, momSentAt: { not: null } },
        orderBy: { momSentAt: 'desc' },
        select: { momSentAt: true },
      });
      await tx.account.update({
        where: { id: existing.accountId },
        data: {
          lastMeetingDate: recentMeeting?.heldAt ?? null,
          lastMomDate: recentMom?.momSentAt ?? null,
        },
      });
      return snapshot;
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
        location: meeting.location,
        clientParticipants: parseParticipantsJson(meeting.clientParticipants),
        gazonParticipants: parseParticipantsJson(meeting.gazonParticipants),
        actionItems: (meeting.actionItems as ActionItem[] | null) ?? [],
        momContent: input.momContent,
        performedByUserId: input.performedByUserId,
      });
    }

    return meeting;
  },
};
