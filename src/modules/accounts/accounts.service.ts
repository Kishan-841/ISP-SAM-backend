import type { KittyType, UserRole, Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';

export type Requester = { id: string; role: UserRole };

// Note: `currentMrr` is Prisma `Decimal` and JSON-serialises as a string.
// The frontend type at sam-frontend/services/accounts.ts mirrors this.
export const accountsService = {
  list({ kittyType, requester }: { kittyType?: KittyType; requester: Requester }) {
    const where: Prisma.AccountWhereInput = {};
    if (kittyType) where.kittyType = kittyType;
    if (requester.role === 'SAM') where.samOwnerId = requester.id;
    return prisma.account.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  async getById(id: string, requester: Requester) {
    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) return null;
    if (requester.role === 'SAM' && account.samOwnerId !== requester.id) {
      return null; // Pretend it doesn't exist — don't leak existence to non-owners.
    }
    return account;
  },
};
