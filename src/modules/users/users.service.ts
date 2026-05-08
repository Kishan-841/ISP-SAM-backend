import type { UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { authService } from '../auth/auth.service.js';

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
};
