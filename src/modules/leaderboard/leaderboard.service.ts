import type { UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';

export type LeaderboardRow = {
  rank: number;
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  accountsCount: number;
  // Pillar scores (0-100)
  revenueScore: number;
  momScore: number;
  complianceScore: number;
  onboardingScore: number;
  finalScore: number;
  // Display metadata for the table cells
  revenueDeltaPercent: number;     // can be negative
  momSlaPercent: number;
  approvalPercent: number;
  cleanHandoverPercent: number;
};

export const leaderboardService = {
  async ranking(role: UserRole): Promise<LeaderboardRow[]> {
    const users = await prisma.user.findMany({
      where: { role },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    });

    if (users.length === 0) return [];

    const userIds = users.map((u) => u.id);

    // Pull all data the scoring needs in 3 queries (one per joined entity)
    const accounts = await prisma.account.findMany({
      where: { samOwnerId: { in: userIds } },
      select: {
        id: true,
        samOwnerId: true,
        kittyType: true,
        contractStatus: true,
        currentMrr: true,
        startOfPeriodMrr: true,
        onboardingDate: true,
      },
    });

    const accountIds = accounts.map((a) => a.id);
    const commercialChanges = accountIds.length === 0 ? [] :
      await prisma.commercialChange.findMany({
        where: { accountId: { in: accountIds } },
        select: {
          accountId: true,
          changeType: true,
          oldMrr: true,
          newMrr: true,
          effectiveDate: true,
          clientApprovalAttached: true,
          accountsNotifiedDate: true,
        },
      });

    const meetings = accountIds.length === 0 ? [] :
      await prisma.meeting.findMany({
        where: { accountId: { in: accountIds } },
        select: {
          accountId: true,
          scheduledAt: true,
          heldAt: true,
          momSentAt: true,
        },
      });

    // Compute scores for each user
    const rows: LeaderboardRow[] = users.map((u) => {
      const userAccounts = accounts.filter((a) => a.samOwnerId === u.id);
      const userAccountIds = new Set(userAccounts.map((a) => a.id));
      const userChanges = commercialChanges.filter((c) => userAccountIds.has(c.accountId));
      const userMeetings = meetings.filter((m) => userAccountIds.has(m.accountId));

      const baseAccounts = userAccounts.filter((a) => a.kittyType === 'BASE');
      const newAccounts = userAccounts.filter((a) => a.kittyType === 'NEW');

      // ----- Revenue (40%) -----
      const startMrr = baseAccounts.reduce(
        (s, a) => s + Number(a.startOfPeriodMrr ?? a.currentMrr),
        0,
      );
      const currentMrr = baseAccounts
        .filter((a) => a.contractStatus !== 'TERMINATED')
        .reduce((s, a) => s + Number(a.currentMrr), 0);
      const revenueDeltaPercent = startMrr > 0 ? ((currentMrr - startMrr) / startMrr) * 100 : 0;

      const upgradesCount = userChanges.filter((c) => c.changeType === 'UPGRADE').length;
      const downgradesCount = userChanges.filter((c) => c.changeType === 'DOWNGRADE').length;
      const terminationsCount = userChanges.filter((c) => c.changeType === 'DISCONNECTION').length;
      const expansionDenom = upgradesCount + downgradesCount + terminationsCount;
      const expansionRatio = expansionDenom > 0 ? upgradesCount / expansionDenom : 0;

      // Map: if you're flat (0% delta) start at 50; +/- 10% delta == +/- 50 score
      // Combine 70% delta-portion + 30% expansion-portion
      const deltaPortion = clamp(50 + revenueDeltaPercent * 5, 0, 100);
      const revenueScore = round1(deltaPortion * 0.7 + expansionRatio * 100 * 0.3);

      // ----- MOM Discipline (20%) -----
      const heldMeetings = userMeetings.filter((m) => m.heldAt !== null);
      const within48h = heldMeetings.filter((m) => {
        if (!m.heldAt || !m.momSentAt) return false;
        const ms = new Date(m.momSentAt).getTime() - new Date(m.heldAt).getTime();
        return Math.abs(ms) <= 48 * 60 * 60 * 1000;
      }).length;
      const momSlaPercent = heldMeetings.length > 0 ? (within48h / heldMeetings.length) * 100 : 0;

      const accountsWithMeeting = new Set(userMeetings.map((m) => m.accountId)).size;
      const meetingCoveragePercent = userAccounts.length > 0
        ? (accountsWithMeeting / userAccounts.length) * 100
        : 0;
      const momScore = round1(momSlaPercent * 0.6 + meetingCoveragePercent * 0.4);

      // ----- Compliance Hygiene (25%) -----
      const approvalsAttached = userChanges.filter((c) => c.clientApprovalAttached).length;
      const approvalPercent = userChanges.length > 0
        ? (approvalsAttached / userChanges.length) * 100
        : 100; // No changes = nothing to enforce; default to 100
      const notificationsSent = userChanges.filter((c) => c.accountsNotifiedDate !== null).length;
      const notificationPercent = userChanges.length > 0
        ? (notificationsSent / userChanges.length) * 100
        : 100;
      const complianceScore = round1(approvalPercent * 0.5 + notificationPercent * 0.5);

      // ----- Onboarding Quality (15%) -----
      // Only weighted for SAMs with NEW accounts. Otherwise score = 100 (no friction).
      let onboardingScore = 100;
      let cleanHandoverPercent = 100;
      if (newAccounts.length > 0) {
        const newAccountIds = new Set(newAccounts.map((a) => a.id));
        const cleanCount = newAccounts.filter((a) => {
          const onboard = new Date(a.onboardingDate).getTime();
          const within30d = userChanges.filter(
            (c) => newAccountIds.has(c.accountId)
              && (new Date(c.effectiveDate).getTime() - onboard) <= 30 * 24 * 60 * 60 * 1000,
          );
          return within30d.length === 0;
        }).length;
        cleanHandoverPercent = (cleanCount / newAccounts.length) * 100;

        // Time to first MoM: average days from onboardingDate to first momSentAt across NEW accounts.
        // Score: 100 if avg <= 7d, scales down linearly to 0 at avg = 30d.
        const ttfmDays: number[] = [];
        for (const acct of newAccounts) {
          const acctMoms = userMeetings
            .filter((m) => m.accountId === acct.id && m.momSentAt !== null)
            .map((m) => new Date(m.momSentAt as Date).getTime())
            .sort((a, b) => a - b);
          if (acctMoms.length === 0) continue;
          const days = (acctMoms[0]! - new Date(acct.onboardingDate).getTime()) / (24 * 60 * 60 * 1000);
          ttfmDays.push(days);
        }
        const avgTtfm = ttfmDays.length > 0
          ? ttfmDays.reduce((a, b) => a + b, 0) / ttfmDays.length
          : 30; // No MoMs at all = worst case
        const ttfmScore = clamp(100 - ((avgTtfm - 7) / (30 - 7)) * 100, 0, 100);
        onboardingScore = round1(cleanHandoverPercent * 0.5 + ttfmScore * 0.5);
      }

      const finalScore = round1(
        revenueScore * 0.4
        + momScore * 0.2
        + complianceScore * 0.25
        + onboardingScore * 0.15,
      );

      return {
        rank: 0,  // assigned after sort
        userId: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        accountsCount: userAccounts.length,
        revenueScore,
        momScore,
        complianceScore,
        onboardingScore,
        finalScore,
        revenueDeltaPercent: round1(revenueDeltaPercent),
        momSlaPercent: round1(momSlaPercent),
        approvalPercent: round1(approvalPercent),
        cleanHandoverPercent: round1(cleanHandoverPercent),
      };
    });

    // Sort by finalScore desc, tie-break by complianceScore desc
    rows.sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      return b.complianceScore - a.complianceScore;
    });
    rows.forEach((row, i) => { row.rank = i + 1; });

    return rows;
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
