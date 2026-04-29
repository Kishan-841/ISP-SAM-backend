import type { KittyType } from '@prisma/client';
import { prisma } from '../../prisma.js';

export const accountsService = {
  list({ kittyType }: { kittyType?: KittyType } = {}) {
    return prisma.account.findMany({
      where: kittyType ? { kittyType } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  },

  getById(id: string) {
    return prisma.account.findUnique({ where: { id } });
  },
};
