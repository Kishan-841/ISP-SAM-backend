import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { authService } from '../auth/auth.service.js';

export type UserUpdatePatch = {
  name?: string;
  role?: UserRole;
  /** Pass `null` to clear samHeadId, omit to leave unchanged. */
  samHeadId?: string | null;
};

export const usersService = {
  list() {
    return prisma.user.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        samHead: { select: { id: true, name: true } },
      },
    });
  },

  /**
   * Returns the SAMs that the assign-customer dropdown should offer.
   *  - ADMIN     → every SAM in the system
   *  - SAM_HEAD  → only SAMs whose samHeadId equals the requester's id
   */
  team({ requester }: { requester: { id: string; role: UserRole } }) {
    const where =
      requester.role === 'SAM_HEAD'
        ? { role: 'SAM' as const, samHeadId: requester.id }
        : { role: 'SAM' as const };
    return prisma.user.findMany({
      where,
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
  },

  getById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: {
        samHead: { select: { id: true, name: true } },
      },
    });
  },

  async create(input: {
    email: string;
    name: string;
    role: UserRole;
    password: string;
    samHeadId?: string | null;
  }) {
    const passwordHash = await authService.hashPassword(input.password);
    return prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash,
        samHeadId: input.samHeadId ?? null,
      },
      include: {
        samHead: { select: { id: true, name: true } },
      },
    });
  },

  async update(opts: {
    id: string;
    patch: UserUpdatePatch;
    newPassword?: string;
    performedByUserId: string;
  }) {
    const before = await prisma.user.findUnique({ where: { id: opts.id } });
    if (!before) throw new Error('User not found');

    const data: Prisma.UserUpdateInput = {};
    if (opts.patch.name !== undefined) data.name = opts.patch.name;
    if (opts.patch.role !== undefined) data.role = opts.patch.role;
    if (opts.patch.samHeadId !== undefined) {
      data.samHead =
        opts.patch.samHeadId === null
          ? { disconnect: true }
          : { connect: { id: opts.patch.samHeadId } };
    }
    const willResetPassword = !!opts.newPassword;
    if (willResetPassword) {
      data.passwordHash = await authService.hashPassword(opts.newPassword!);
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: opts.id },
        data,
        include: { samHead: { select: { id: true, name: true } } },
      });

      const beforeSnap = {
        name: before.name,
        role: before.role,
        samHeadId: before.samHeadId,
      };
      const afterSnap = {
        name: updated.name,
        role: updated.role,
        samHeadId: updated.samHeadId,
      };
      const fieldChanged =
        beforeSnap.name !== afterSnap.name ||
        beforeSnap.role !== afterSnap.role ||
        beforeSnap.samHeadId !== afterSnap.samHeadId;

      if (fieldChanged) {
        await tx.auditLog.create({
          data: {
            entityType: 'User',
            entityId: updated.id,
            action: 'UPDATE',
            performedBy: opts.performedByUserId,
            payload: { before: beforeSnap, after: afterSnap },
          },
        });
      }
      if (willResetPassword) {
        await tx.auditLog.create({
          data: {
            entityType: 'User',
            entityId: updated.id,
            action: 'PASSWORD_RESET',
            performedBy: opts.performedByUserId,
            payload: { byAdmin: true },
          },
        });
      }
      return updated;
    });
  },

  async remove(opts: { id: string; performedByUserId: string }) {
    const before = await prisma.user.findUnique({ where: { id: opts.id } });
    if (!before) throw new Error('User not found');

    return prisma.$transaction(async (tx) => {
      const snapshot = {
        email: before.email,
        name: before.name,
        role: before.role,
        samHeadId: before.samHeadId,
        createdAt: before.createdAt.toISOString(),
      };
      // Write audit BEFORE deletion so any FK cascade doesn't interfere.
      // AuditLog.performedBy is just a uuid string with no relation, so this
      // row survives the user deletion intact.
      await tx.auditLog.create({
        data: {
          entityType: 'User',
          entityId: before.id,
          action: 'DELETE',
          performedBy: opts.performedByUserId,
          payload: { snapshot },
        },
      });
      await tx.user.delete({ where: { id: before.id } });
      return snapshot;
    });
  },

  /** True if exactly one ADMIN remains (used to guard delete/demote). */
  async isLastAdmin(userId: string): Promise<boolean> {
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target || target.role !== 'ADMIN') return false;
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    return adminCount <= 1;
  },
};
