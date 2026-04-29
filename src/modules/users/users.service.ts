import type { UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { authService } from '../auth/auth.service.js';

export const usersService = {
  list() {
    return prisma.user.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  getById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  async create(input: { email: string; name: string; role: UserRole; password: string }) {
    const passwordHash = await authService.hashPassword(input.password);
    return prisma.user.create({
      data: { email: input.email, name: input.name, role: input.role, passwordHash },
    });
  },
};
