import { PrismaClient } from '@prisma/client';

declare global {
  var prismaClient: PrismaClient | undefined;
}

export const prisma = globalThis.prismaClient ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.prismaClient = prisma;
}

// Vercel Fluid Compute reaps idle instances; disconnect so Neon doesn't leak connections.
process.on('beforeExit', () => {
  void prisma.$disconnect();
});
