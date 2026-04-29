import { prisma } from '../../src/prisma.js';

export async function resetDb() {
  await prisma.auditLog.deleteMany();
  await prisma.commercialChange.deleteMany();
  await prisma.meeting.deleteMany();
  await prisma.account.deleteMany();
}

export async function seedAccount(overrides: Partial<Parameters<typeof prisma.account.create>[0]['data']> = {}) {
  return prisma.account.create({
    data: {
      clientName: 'Test Co',
      kittyType: 'BASE',
      currentMrr: 10000,
      contractStatus: 'ACTIVE',
      onboardingDate: new Date('2025-01-01'),
      ...overrides,
    },
  });
}
