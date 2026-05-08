import type { UserRole, CommercialChangeType } from '@prisma/client';
import { prisma } from '../../prisma.js';

/**
 * Snapshot of a single SAM's performance for the SAM_HEAD dashboard.
 * Numbers are point-in-time — no time-series yet.
 */
export type SamRow = {
  userId: string;
  name: string;
  email: string;
  customerCount: number;
  totalArc: number;
  startOfPeriodArc: number;
  arcDelta: number;
  arcDeltaPercent: number;
  changes: Record<CommercialChangeType, { count: number; arcImpact: number }>;
  totalChanges: number;
  meetingsHeld: number;
  momsSent: number;
  momSlaPercent: number;       // % MOMs sent within 48h of meeting heldAt
  approvalPercent: number;     // % commercial changes with approval attached
  activationPending: number;   // CRM orders waiting on this SAM (PENDING_SAM_ACTIVATION)
  customersWithoutMeeting: number;
  /** Reliability composite from leaderboard formula (0–100). */
  reliabilityScore: number;
};

export type TeamPerformance = {
  team: {
    headId: string;
    samCount: number;
    customerCount: number;
    unassignedCount: number;
    totalArc: number;
    startOfPeriodArc: number;
    arcDelta: number;
    totalChanges: number;
    momsPending: number;
    activationPending: number;
    customersWithoutMeeting30d: number;
  };
  sams: SamRow[];
};

const EMPTY_CHANGES = (): Record<CommercialChangeType, { count: number; arcImpact: number }> => ({
  UPGRADE: { count: 0, arcImpact: 0 },
  DOWNGRADE: { count: 0, arcImpact: 0 },
  RATE_REVISION: { count: 0, arcImpact: 0 },
  DISCONNECTION: { count: 0, arcImpact: 0 },
});

/**
 * Aggregate everything the team-performance dashboard needs in a few queries.
 *
 * Authorisation:
 *  - SAM_HEAD: returns their direct reports only.
 *  - ADMIN:    returns every SAM in the system (acts like the org-wide head view).
 */
export async function computeTeamPerformance({
  requester,
}: {
  requester: { id: string; role: UserRole };
}): Promise<TeamPerformance> {
  // 1. Pick the SAMs that fall under this requester.
  const sams = await prisma.user.findMany({
    where:
      requester.role === 'SAM_HEAD'
        ? { role: 'SAM', samHeadId: requester.id }
        : { role: 'SAM' },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });
  const samIds = sams.map((s) => s.id);

  if (samIds.length === 0) {
    return {
      team: {
        headId: requester.id,
        samCount: 0,
        customerCount: 0,
        unassignedCount: 0,
        totalArc: 0,
        startOfPeriodArc: 0,
        arcDelta: 0,
        totalChanges: 0,
        momsPending: 0,
        activationPending: 0,
        customersWithoutMeeting30d: 0,
      },
      sams: [],
    };
  }

  // 2. Pull everything in parallel.
  const [accounts, unassignedCount, changes, meetings] = await Promise.all([
    prisma.account.findMany({
      where: { samOwnerId: { in: samIds } },
      select: {
        id: true,
        samOwnerId: true,
        currentArc: true,
        startOfPeriodArc: true,
        contractStatus: true,
        kittyType: true,
        onboardingDate: true,
      },
    }),
    requester.role === 'SAM_HEAD'
      ? prisma.account.count({ where: { samOwnerId: null } })
      : Promise.resolve(0),
    prisma.commercialChange.findMany({
      where: { account: { samOwnerId: { in: samIds } } },
      select: {
        accountId: true,
        changeType: true,
        oldArc: true,
        newArc: true,
        clientApprovalAttached: true,
        crmStatus: true,
        account: { select: { samOwnerId: true } },
      },
    }),
    prisma.meeting.findMany({
      where: { account: { samOwnerId: { in: samIds } } },
      select: {
        accountId: true,
        heldAt: true,
        momSentAt: true,
        account: { select: { samOwnerId: true } },
      },
    }),
  ]);

  // 3. Group everything by samOwnerId so per-SAM rows are one pass each.
  const accountsBySam = new Map<string, typeof accounts>();
  for (const a of accounts) {
    if (!a.samOwnerId) continue;
    const arr = accountsBySam.get(a.samOwnerId) ?? [];
    arr.push(a);
    accountsBySam.set(a.samOwnerId, arr);
  }

  const changesBySam = new Map<string, typeof changes>();
  for (const c of changes) {
    const ownerId = c.account.samOwnerId;
    if (!ownerId) continue;
    const arr = changesBySam.get(ownerId) ?? [];
    arr.push(c);
    changesBySam.set(ownerId, arr);
  }

  const meetingsBySam = new Map<string, typeof meetings>();
  for (const m of meetings) {
    const ownerId = m.account.samOwnerId;
    if (!ownerId) continue;
    const arr = meetingsBySam.get(ownerId) ?? [];
    arr.push(m);
    meetingsBySam.set(ownerId, arr);
  }

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

  // 4. Per-SAM rows.
  const samRows: SamRow[] = sams.map((s) => {
    const samAccounts = accountsBySam.get(s.id) ?? [];
    const samChanges = changesBySam.get(s.id) ?? [];
    const samMeetings = meetingsBySam.get(s.id) ?? [];

    // Money totals (active only — terminated accounts shouldn't pad the metric).
    const activeAccounts = samAccounts.filter((a) => a.contractStatus !== 'TERMINATED');
    const totalArc = activeAccounts.reduce((s, a) => s + Number(a.currentArc), 0);
    const startOfPeriodArc = samAccounts.reduce(
      (s, a) => s + Number(a.startOfPeriodArc ?? a.currentArc),
      0,
    );
    const arcDelta = totalArc - startOfPeriodArc;
    const arcDeltaPercent =
      startOfPeriodArc > 0 ? (arcDelta / startOfPeriodArc) * 100 : 0;

    // Commercial changes broken down by type with an ARC delta interpretation per type.
    const changeBuckets = EMPTY_CHANGES();
    for (const c of samChanges) {
      const oldA = Number(c.oldArc);
      const newA = Number(c.newArc);
      const bucket = changeBuckets[c.changeType];
      bucket.count += 1;
      switch (c.changeType) {
        case 'UPGRADE':
          bucket.arcImpact += newA - oldA;
          break;
        case 'DOWNGRADE':
          bucket.arcImpact += oldA - newA; // positive magnitude (lost)
          break;
        case 'RATE_REVISION':
          bucket.arcImpact += oldA - newA;
          break;
        case 'DISCONNECTION':
          bucket.arcImpact += oldA;
          break;
      }
    }
    const totalChanges = samChanges.length;

    // MOM discipline.
    const heldMeetings = samMeetings.filter((m) => m.heldAt !== null);
    const momsSent = samMeetings.filter((m) => m.momSentAt !== null).length;
    const momsWithin48h = heldMeetings.filter((m) => {
      if (!m.heldAt || !m.momSentAt) return false;
      const diff = new Date(m.momSentAt).getTime() - new Date(m.heldAt).getTime();
      return Math.abs(diff) <= FORTY_EIGHT_HOURS_MS;
    }).length;
    const momSlaPercent =
      heldMeetings.length === 0 ? 0 : (momsWithin48h / heldMeetings.length) * 100;

    // Compliance.
    const approvalsAttached = samChanges.filter((c) => c.clientApprovalAttached).length;
    const approvalPercent = totalChanges === 0 ? 100 : (approvalsAttached / totalChanges) * 100;

    // CRM activation queue.
    const activationPending = samChanges.filter(
      (c) => c.crmStatus === 'PENDING_SAM_ACTIVATION',
    ).length;

    // Customers without ANY meeting at all (a hard SAM-failure signal).
    const accountsWithMeeting = new Set(samMeetings.map((m) => m.accountId));
    const customersWithoutMeeting = activeAccounts.filter(
      (a) => !accountsWithMeeting.has(a.id),
    ).length;

    // Reliability composite (mirrors leaderboard.service formula).
    const reliabilityScore = computeReliabilityScore({
      revenueDeltaPercent: arcDeltaPercent,
      upgrades: changeBuckets.UPGRADE.count,
      downgrades: changeBuckets.DOWNGRADE.count,
      terminations: changeBuckets.DISCONNECTION.count,
      momSlaPercent,
      meetingCoveragePercent:
        activeAccounts.length === 0
          ? 0
          : (accountsWithMeeting.size / activeAccounts.length) * 100,
      approvalPercent,
      hasNewKittyAccounts: samAccounts.some((a) => a.kittyType === 'NEW'),
    });

    return {
      userId: s.id,
      name: s.name,
      email: s.email,
      customerCount: activeAccounts.length,
      totalArc: round0(totalArc),
      startOfPeriodArc: round0(startOfPeriodArc),
      arcDelta: round0(arcDelta),
      arcDeltaPercent: round1(arcDeltaPercent),
      changes: bucketsToRoundedNumbers(changeBuckets),
      totalChanges,
      meetingsHeld: heldMeetings.length,
      momsSent,
      momSlaPercent: round1(momSlaPercent),
      approvalPercent: round1(approvalPercent),
      activationPending,
      customersWithoutMeeting,
      reliabilityScore: round1(reliabilityScore),
    };
  });

  // 5. Team aggregates.
  const teamCustomerCount = samRows.reduce((s, r) => s + r.customerCount, 0);
  const teamTotalArc = samRows.reduce((s, r) => s + r.totalArc, 0);
  const teamStartArc = samRows.reduce((s, r) => s + r.startOfPeriodArc, 0);
  const teamTotalChanges = samRows.reduce((s, r) => s + r.totalChanges, 0);
  const teamActivationPending = samRows.reduce((s, r) => s + r.activationPending, 0);

  // MOMs pending = held meetings without momSentAt
  const momsPending = meetings.filter(
    (m) => m.heldAt !== null && m.momSentAt === null,
  ).length;

  // Customers without a meeting in the last 30 days — fresh hot-spot list.
  const recentMeetingByAccount = new Map<string, number>();
  for (const m of meetings) {
    const t = m.heldAt ? new Date(m.heldAt).getTime() : 0;
    if (t > 0) {
      const prev = recentMeetingByAccount.get(m.accountId) ?? 0;
      if (t > prev) recentMeetingByAccount.set(m.accountId, t);
    }
  }
  const customersWithoutMeeting30d = accounts.filter((a) => {
    if (a.contractStatus === 'TERMINATED') return false;
    const last = recentMeetingByAccount.get(a.id);
    return !last || now - last > THIRTY_DAYS_MS;
  }).length;

  return {
    team: {
      headId: requester.id,
      samCount: sams.length,
      customerCount: teamCustomerCount,
      unassignedCount,
      totalArc: round0(teamTotalArc),
      startOfPeriodArc: round0(teamStartArc),
      arcDelta: round0(teamTotalArc - teamStartArc),
      totalChanges: teamTotalChanges,
      momsPending,
      activationPending: teamActivationPending,
      customersWithoutMeeting30d,
    },
    sams: samRows,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round0(n: number): number {
  return Math.round(n);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function bucketsToRoundedNumbers(
  buckets: Record<CommercialChangeType, { count: number; arcImpact: number }>,
): Record<CommercialChangeType, { count: number; arcImpact: number }> {
  return {
    UPGRADE: { count: buckets.UPGRADE.count, arcImpact: round0(buckets.UPGRADE.arcImpact) },
    DOWNGRADE: { count: buckets.DOWNGRADE.count, arcImpact: round0(buckets.DOWNGRADE.arcImpact) },
    RATE_REVISION: {
      count: buckets.RATE_REVISION.count,
      arcImpact: round0(buckets.RATE_REVISION.arcImpact),
    },
    DISCONNECTION: {
      count: buckets.DISCONNECTION.count,
      arcImpact: round0(buckets.DISCONNECTION.arcImpact),
    },
  };
}

/**
 * Mirrors leaderboard.service composite (revenue 40 / mom 20 / compliance 25 /
 * onboarding 15) but scoped to the inputs available at this layer. Onboarding
 * here is a flat 100 (not penalised) when the SAM has no NEW-kitty customers,
 * matching the leaderboard convention.
 */
function computeReliabilityScore(input: {
  revenueDeltaPercent: number;
  upgrades: number;
  downgrades: number;
  terminations: number;
  momSlaPercent: number;
  meetingCoveragePercent: number;
  approvalPercent: number;
  hasNewKittyAccounts: boolean;
}): number {
  const expansionDenom = input.upgrades + input.downgrades + input.terminations;
  const expansionRatio = expansionDenom > 0 ? input.upgrades / expansionDenom : 0;
  const deltaPortion = clamp(50 + input.revenueDeltaPercent * 5, 0, 100);
  const revenueScore = deltaPortion * 0.7 + expansionRatio * 100 * 0.3;

  const momScore = input.momSlaPercent * 0.6 + input.meetingCoveragePercent * 0.4;
  const complianceScore = input.approvalPercent; // single signal at this scope
  const onboardingScore = input.hasNewKittyAccounts ? 100 : 100; // placeholder neutral

  return (
    revenueScore * 0.4 +
    momScore * 0.2 +
    complianceScore * 0.25 +
    onboardingScore * 0.15
  );
}
