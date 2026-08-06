import bcrypt from 'bcryptjs';
import type { UserRole } from '@prisma/client';
import { prisma } from '../../src/prisma.js';

export async function resetDb() {
  await prisma.auditLog.deleteMany();
  await prisma.feedback.deleteMany();
  await prisma.commercialChange.deleteMany();
  await prisma.meeting.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();
}

export async function seedAccount(overrides: Partial<Parameters<typeof prisma.account.create>[0]['data']> = {}) {
  return prisma.account.create({
    data: {
      clientName: 'Test Co',
      kittyType: 'BASE',
      currentArc: 120000,
      contractStatus: 'ACTIVE',
      onboardingDate: new Date('2025-01-01'),
      ...overrides,
    },
  });
}

export async function seedUser(opts: {
  email?: string;
  name?: string;
  role?: UserRole;
  password?: string;
} = {}) {
  return prisma.user.create({
    data: {
      email: opts.email ?? 'sam@gazonindia.com',
      name: opts.name ?? 'Test SAM',
      role: opts.role ?? 'SAM',
      passwordHash: await bcrypt.hash(opts.password ?? 'pw', 4), // low rounds for test speed
    },
  });
}
