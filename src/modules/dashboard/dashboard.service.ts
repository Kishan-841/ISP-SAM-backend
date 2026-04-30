import { prisma } from '../../prisma.js';

export type ExistingBaseMetrics = {
  // Row 1 — backed by real data
  totalCustomers: number;
  totalBaseArcLakh: number;
  totalBaseMrrLakh: number;
  currentCustomers: number;
  currentArcLakh: number;
  terminatedCount: number;

  // Row 2 — placeholder (Chunk B will replace these)
  upgrades: { count: 0; arcAddedLakh: 0 };
  downgrades: { count: 0; arcReducedLakh: 0 };
  rateRevisions: { count: 0; arcChangeLakh: 0 };
  terminations: { count: 0; arcLostLakh: 0 };
};

const LAKH = 100_000;

export const dashboardService = {
  async existingBase(): Promise<ExistingBaseMetrics> {
    // All BASE accounts (snapshot at start of period)
    const baseAccounts = await prisma.account.findMany({
      where: { kittyType: 'BASE' },
      select: { currentMrr: true, contractStatus: true },
    });

    const totalCustomers = baseAccounts.length;
    const totalBaseMrr = baseAccounts.reduce(
      (sum, a) => sum + Number(a.currentMrr),
      0,
    );
    const terminated = baseAccounts.filter((a) => a.contractStatus === 'TERMINATED');
    const active = baseAccounts.filter((a) => a.contractStatus !== 'TERMINATED');
    const currentMrrSum = active.reduce(
      (sum, a) => sum + Number(a.currentMrr),
      0,
    );

    return {
      totalCustomers,
      totalBaseArcLakh: round1((totalBaseMrr * 12) / LAKH),
      totalBaseMrrLakh: round1(totalBaseMrr / LAKH),
      currentCustomers: active.length,
      currentArcLakh: round1((currentMrrSum * 12) / LAKH),
      terminatedCount: terminated.length,
      upgrades: { count: 0, arcAddedLakh: 0 },
      downgrades: { count: 0, arcReducedLakh: 0 },
      rateRevisions: { count: 0, arcChangeLakh: 0 },
      terminations: { count: 0, arcLostLakh: 0 },
    };
  },
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
