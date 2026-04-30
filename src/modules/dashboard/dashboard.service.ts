import { prisma } from '../../prisma.js';

export type ExistingBaseMetrics = {
  // Row 1 — backed by real data
  totalCustomers: number;
  totalBaseArcLakh: number;
  totalBaseMrrLakh: number;
  currentCustomers: number;
  currentArcLakh: number;
  terminatedCount: number;

  // Row 2 — aggregated from commercial_changes
  upgrades: { count: number; arcAddedLakh: number };
  downgrades: { count: number; arcReducedLakh: number };
  rateRevisions: { count: number; arcChangeLakh: number };
  terminations: { count: number; arcLostLakh: number };
};

const LAKH = 100_000;

export const dashboardService = {
  async existingBase(): Promise<ExistingBaseMetrics> {
    // 1. BASE accounts snapshot
    const baseAccounts = await prisma.account.findMany({
      where: { kittyType: 'BASE' },
      select: {
        id: true,
        currentMrr: true,
        startOfPeriodMrr: true,
        contractStatus: true,
      },
    });

    const totalCustomers = baseAccounts.length;
    // Start-of-period MRR uses the snapshot, falling back to currentMrr for legacy
    // rows that pre-date the B1 import (where startOfPeriodMrr is null).
    const startOfPeriodMrrSum = baseAccounts.reduce(
      (sum, a) => sum + Number(a.startOfPeriodMrr ?? a.currentMrr),
      0,
    );
    const terminated = baseAccounts.filter((a) => a.contractStatus === 'TERMINATED');
    const active = baseAccounts.filter((a) => a.contractStatus !== 'TERMINATED');
    const currentMrrSum = active.reduce(
      (sum, a) => sum + Number(a.currentMrr),
      0,
    );

    // 2. Commercial changes against BASE accounts only
    const baseAccountIds = baseAccounts.map((a) => a.id);
    const changes =
      baseAccountIds.length === 0
        ? []
        : await prisma.commercialChange.findMany({
            where: { accountId: { in: baseAccountIds } },
            select: {
              changeType: true,
              oldMrr: true,
              newMrr: true,
            },
          });

    let upgradesCount = 0;
    let upgradesArcAdded = 0;
    let downgradesCount = 0;
    let downgradesArcReduced = 0;
    let rateRevsCount = 0;
    let rateRevsArcChange = 0;
    let terminationsCount = 0;
    let terminationsArcLost = 0;

    for (const c of changes) {
      const oldM = Number(c.oldMrr);
      const newM = Number(c.newMrr);
      switch (c.changeType) {
        case 'UPGRADE':
          upgradesCount++;
          upgradesArcAdded += (newM - oldM) * 12;
          break;
        case 'DOWNGRADE':
          downgradesCount++;
          downgradesArcReduced += (oldM - newM) * 12;
          break;
        case 'RATE_REVISION':
          rateRevsCount++;
          rateRevsArcChange += (oldM - newM) * 12; // positive magnitude
          break;
        case 'TERMINATION':
          terminationsCount++;
          terminationsArcLost += oldM * 12;
          break;
      }
    }

    return {
      totalCustomers,
      totalBaseArcLakh: round1((startOfPeriodMrrSum * 12) / LAKH),
      totalBaseMrrLakh: round1(startOfPeriodMrrSum / LAKH),
      currentCustomers: active.length,
      currentArcLakh: round1((currentMrrSum * 12) / LAKH),
      terminatedCount: terminated.length,
      upgrades: {
        count: upgradesCount,
        arcAddedLakh: round1(upgradesArcAdded / LAKH),
      },
      downgrades: {
        count: downgradesCount,
        arcReducedLakh: round1(downgradesArcReduced / LAKH),
      },
      rateRevisions: {
        count: rateRevsCount,
        arcChangeLakh: round1(rateRevsArcChange / LAKH),
      },
      terminations: {
        count: terminationsCount,
        arcLostLakh: round1(terminationsArcLost / LAKH),
      },
    };
  },
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
