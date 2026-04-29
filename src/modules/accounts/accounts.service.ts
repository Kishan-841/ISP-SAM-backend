import type { KittyType } from '@prisma/client';
import { prisma } from '../../prisma.js';

// Note: `currentMrr` is Prisma `Decimal` and JSON-serialises as a string.
// The frontend type at sam-frontend/services/accounts.ts mirrors this.
export const accountsService = {
  list({ kittyType }: { kittyType?: KittyType } = {}) {
    return prisma.account.findMany({
      where: kittyType ? { kittyType } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  getById(id: string) {
    return prisma.account.findUnique({ where: { id } });
  },
};
