import type { UserRole, CommercialChangeType } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { fyQuarterRange, type FyQuarter } from './dashboard.service.js';

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
  /** Held meetings by mode. meetingsOnline + meetingsOffline === meetingsHeld. */
  meetingsOnline: number;
  meetingsOffline: number;
  momsSent: number;
  momSlaPercent: number;       // % MOMs sent within 48h of meeting heldAt
  approvalPercent: number;     // % commercial changes with approval attached
  activationPending: number;   // CRM orders waiting on this SAM (PENDING_SAM_ACTIVATION)
  customersWithoutMeeting: number;
  /** Reliability composite (revenue / MOM / compliance / onboarding) — 0–100. */
  reliabilityScore: number;
  // ── Incentive / allowable-churn block ─────────────────────────────────
  //   Net churn ARC = (disconnections + downgrades − upgrades). Positive
  //   means the book shrank; negative means the SAM grew it. The percent
  //   is denominated in start-of-period ARC so it's stable across the
  //   period. Headroom = allowable − actual; positive means under budget.
  /** ₹ net churn = disconnections + downgrades − upgrades (positive = loss). */
  netChurnArc: number;
  /** netChurnArc / startOfPeriodArc * 100 (rounded to 2 dp). */
  netChurnPercent: number;
  /** Per-SAM allowable churn ceiling (6.00–8.00, enforced at the API layer). */
  allowableChurnPercent: number;
  /** allowableChurnPercent − netChurnPercent. Positive = under budget = on-track for incentive. */
  churnHeadroomPercent: number;
  /** 'under_budget' when netChurnPercent ≤ allowableChurnPercent, else 'over_budget'. */
  churnStatus: 'under_budget' | 'over_budget';
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
    momsSent: number;
    meetingsHeld: number;
    meetingsOnline: number;
    meetingsOffline: number;
    activationPending: number;
    customersWithoutMeeting30d: number;
    /** Team-wide net churn ₹ — sum of per-SAM netChurnArc. */
    netChurnArc: number;
    /** netChurnArc / sum(startOfPeriodArc) * 100. */
    netChurnPercent: number;
    /** ARC-weighted allowable churn across the team (sums to a coherent budget). */
    allowableChurnPercent: number;
    /** allowableChurnPercent − netChurnPercent. */
    churnHeadroomPercent: number;
    samsOverBudget: number;
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
    select: { id: true, name: true, email: true, allowableChurnPercent: true },
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
        momsSent: 0,
        meetingsHeld: 0,
        meetingsOnline: 0,
        meetingsOffline: 0,
        activationPending: 0,
        customersWithoutMeeting30d: 0,
        netChurnArc: 0,
        netChurnPercent: 0,
        allowableChurnPercent: 0,
        churnHeadroomPercent: 0,
        samsOverBudget: 0,
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
        meetingType: true,
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
    // Held meetings split by mode. PHYSICAL === "offline". Partition of
    // heldMeetings, so online + offline === meetingsHeld.
    const meetingsOnline = heldMeetings.filter((m) => m.meetingType === 'ONLINE').length;
    const meetingsOffline = heldMeetings.filter((m) => m.meetingType === 'PHYSICAL').length;
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

    // Reliability composite — see computeReliabilityScore() below.
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

    // ── Allowable-churn / incentive math ───────────────────────────────
    //   Per the product rule, "churn" is the NET ARC delta — every rupee
    //   gained on an upgrade offsets a rupee lost to a downgrade or
    //   disconnection. Rate revisions are zero-delta by definition so they
    //   don't enter the calculation. The denominator is start-of-period
    //   ARC, which doesn't move during the period.
    //
    //   Sign convention: a POSITIVE netChurnPercent means the book shrank
    //   (loss), a NEGATIVE means it grew. The "ceiling" check is therefore
    //   `netChurnPercent <= allowableChurnPercent` — any growth or low
    //   loss is within budget.
    const netChurnArc =
      changeBuckets.DISCONNECTION.arcImpact +
      changeBuckets.DOWNGRADE.arcImpact -
      changeBuckets.UPGRADE.arcImpact;
    const netChurnPercent =
      startOfPeriodArc > 0 ? (netChurnArc / startOfPeriodArc) * 100 : 0;
    const allowableChurnPercent = Number(s.allowableChurnPercent);
    const churnHeadroomPercent = allowableChurnPercent - netChurnPercent;

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
      meetingsOnline,
      meetingsOffline,
      momsSent,
      momSlaPercent: round1(momSlaPercent),
      approvalPercent: round1(approvalPercent),
      activationPending,
      customersWithoutMeeting,
      reliabilityScore: round1(reliabilityScore),
      netChurnArc: round0(netChurnArc),
      netChurnPercent: round2(netChurnPercent),
      allowableChurnPercent: round2(allowableChurnPercent),
      churnHeadroomPercent: round2(churnHeadroomPercent),
      churnStatus: netChurnPercent <= allowableChurnPercent ? 'under_budget' : 'over_budget',
    };
  });

  // 5. Team aggregates.
  const teamCustomerCount = samRows.reduce((s, r) => s + r.customerCount, 0);
  const teamTotalArc = samRows.reduce((s, r) => s + r.totalArc, 0);
  const teamStartArc = samRows.reduce((s, r) => s + r.startOfPeriodArc, 0);
  const teamTotalChanges = samRows.reduce((s, r) => s + r.totalChanges, 0);
  const teamActivationPending = samRows.reduce((s, r) => s + r.activationPending, 0);
  const teamMeetingsHeld = samRows.reduce((s, r) => s + r.meetingsHeld, 0);
  const teamMeetingsOnline = samRows.reduce((s, r) => s + r.meetingsOnline, 0);
  const teamMeetingsOffline = samRows.reduce((s, r) => s + r.meetingsOffline, 0);
  const teamMomsSent = samRows.reduce((s, r) => s + r.momsSent, 0);

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

  // Team-wide churn aggregates.
  //  - netChurnArc and the percent denominator both sum across SAMs, so the
  //    team netChurnPercent is naturally ARC-weighted.
  //  - For the team allowable %, we weight each SAM's allowable by their
  //    own startOfPeriodArc. A SAM with a big book influences the team
  //    budget more than a SAM with a small one — same weighting rationale
  //    as how we compute the team-wide churn rate.
  const teamNetChurnArc = samRows.reduce((s, r) => s + r.netChurnArc, 0);
  const teamNetChurnPercent =
    teamStartArc > 0 ? (teamNetChurnArc / teamStartArc) * 100 : 0;
  const teamAllowableNumerator = samRows.reduce(
    (s, r) => s + r.allowableChurnPercent * r.startOfPeriodArc,
    0,
  );
  const teamAllowableChurnPercent =
    teamStartArc > 0 ? teamAllowableNumerator / teamStartArc : 0;
  const samsOverBudget = samRows.filter((r) => r.churnStatus === 'over_budget').length;

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
      momsSent: teamMomsSent,
      meetingsHeld: teamMeetingsHeld,
      meetingsOnline: teamMeetingsOnline,
      meetingsOffline: teamMeetingsOffline,
      activationPending: teamActivationPending,
      customersWithoutMeeting30d,
      netChurnArc: round0(teamNetChurnArc),
      netChurnPercent: round2(teamNetChurnPercent),
      allowableChurnPercent: round2(teamAllowableChurnPercent),
      churnHeadroomPercent: round2(teamAllowableChurnPercent - teamNetChurnPercent),
      samsOverBudget,
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
 * Composite weighted score: revenue 40 / mom 20 / compliance 25 / onboarding
 * 15. Onboarding is a flat 100 (not penalised) when the SAM has no NEW-kitty
 * customers — they have nothing to onboard, so we don't dock them.
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

// ============================================================================
// Per-SAM detail — Phase 1 dashboard for SAM_HEAD / ADMIN drill-down.
// ============================================================================

export type SamDetail = {
  sam: {
    id: string;
    name: string;
    email: string;
    samHeadId: string | null;
    samHeadName: string | null;
  };
  /** Quarter the dashboard is scoped to. Null = FYTD (all-time within this FY). */
  quarter: FyQuarter | null;
  score: {
    total: number;
    /**
     * Per-component breakdown. `raw` is the 0–100 score on that dimension;
     * `weighted` is `raw * weight / 100` so the four `weighted` numbers sum to
     * `total`. UI can render each as a stacked bar.
     */
    components: {
      revenue: { weight: number; raw: number; weighted: number };
      mom: { weight: number; raw: number; weighted: number };
      compliance: { weight: number; raw: number; weighted: number };
      onboarding: { weight: number; raw: number; weighted: number };
    };
  };
  kpis: {
    customers: { value: number; teamAvg: number; withoutMeeting: number };
    arcManaged: {
      value: number;
      teamAvg: number;
      arcDelta: number;
      arcDeltaPercent: number;
    };
    commercialChanges: { value: number; teamAvg: number; activationPending: number };
    meetings: {
      value: number;
      teamAvg: number;
      upcomingCount: number;
      online: number;
      offline: number;
    };
    momSla: { value: number; teamAvg: number; momsOverdue: number };
  };
  changes: Record<CommercialChangeType, { count: number; arcImpact: number }>;
  upcomingMeetings: Array<{
    id: string;
    scheduledAt: string;
    customer: { id: string; clientName: string; companyName: string | null };
  }>;
  recentMeetings: Array<{
    id: string;
    scheduledAt: string;
    heldAt: string | null;
    momSentAt: string | null;
    /** True if heldAt set but no MOM sent within 48h. Drives the warn tone. */
    momOverdue: boolean;
    customer: { id: string; clientName: string; companyName: string | null };
  }>;
  activityTimeline: Array<{
    type:
      | 'CHANGE_COMMITTED'
      | 'CHANGE_RETAINED'
      | 'CHANGE_PROCEEDED'
      | 'MEETING_HELD'
      | 'MOM_SENT'
      | 'CUSTOMER_ASSIGNED';
    timestamp: string;
    summary: string;
    customer: { id: string; clientName: string; companyName: string | null } | null;
  }>;
  riskPulse: {
    probableChurnCount: number;
    probableChurnArc: number;
    customersWithoutMeeting: number;
    staleMoms: number;
    day21Prompts: number;
  };
  /**
   * Allowable-churn / incentive block. `netChurnPercent` uses the same
   * net-of-upgrades definition as the SamRow on the team table — keep the
   * formula consistent so the team-table summary and this detail view
   * never disagree.
   */
  churn: {
    netChurnArc: number;
    netChurnPercent: number;
    allowableChurnPercent: number;
    churnHeadroomPercent: number;
    churnStatus: 'under_budget' | 'over_budget';
  };
};

/**
 * Single-SAM performance dashboard payload. Used by /team-performance/:samId.
 *
 *  Authorisation:
 *    - SAM:       always 403 (denied at controller layer; this fn returns null
 *                 if a SAM somehow reaches it).
 *    - SAM_HEAD:  only their direct reports.
 *    - ADMIN:     any SAM.
 *
 *  Period:
 *    - `quarter` undefined → FYTD (all-time within current FY for changes /
 *      meetings; customer + ARC totals are point-in-time regardless).
 *    - `quarter` set → filter commercial_changes by effectiveDate and meetings
 *      by scheduledAt (+ heldAt where relevant) to that window.
 *
 *  Returns null when the SAM doesn't exist or the requester can't see them.
 */
export async function computeSamDetail({
  samId,
  quarter,
  requester,
}: {
  samId: string;
  quarter?: FyQuarter;
  requester: { id: string; role: UserRole };
}): Promise<SamDetail | null> {
  // 1. Lookup + authz
  const sam = await prisma.user.findUnique({
    where: { id: samId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      samHeadId: true,
      allowableChurnPercent: true,
      samHead: { select: { name: true } },
    },
  });
  if (!sam || sam.role !== 'SAM') return null;
  if (requester.role === 'SAM_HEAD' && sam.samHeadId !== requester.id) return null;
  if (requester.role === 'SAM') return null;

  // 2. Date window
  const range = quarter ? fyQuarterRange(quarter) : null;
  const now = new Date();

  // 3. Pull this SAM's data + peer-group data (for team-average comparison).
  //    "Peers" = other SAMs sharing the target's samHeadId — the apples-to-
  //    apples comparison even for ADMINs who can see across teams. Falls
  //    back to an empty peer set when the SAM has no head assigned.
  const peerSams = sam.samHeadId
    ? await prisma.user.findMany({
        where: { role: 'SAM', samHeadId: sam.samHeadId, NOT: { id: sam.id } },
        select: { id: true },
      })
    : [];
  const peerSamIds = peerSams.map((p) => p.id);
  const scopeIds = [sam.id, ...peerSamIds];

  const [accounts, changes, meetings] = await Promise.all([
    prisma.account.findMany({
      where: { samOwnerId: { in: scopeIds } },
      select: {
        id: true,
        samOwnerId: true,
        clientName: true,
        companyName: true,
        currentArc: true,
        startOfPeriodArc: true,
        contractStatus: true,
        kittyType: true,
      },
    }),
    prisma.commercialChange.findMany({
      where: {
        account: { samOwnerId: { in: scopeIds } },
        ...(range
          ? { effectiveDate: { gte: range.start, lte: range.end } }
          : {}),
      },
      select: {
        id: true,
        accountId: true,
        changeType: true,
        oldArc: true,
        newArc: true,
        clientApprovalAttached: true,
        crmStatus: true,
        retentionDecision: true,
        retentionPromptDueAt: true,
        retentionDecidedAt: true,
        accountAppliedAt: true,
        effectiveDate: true,
        createdAt: true,
        account: {
          select: { samOwnerId: true, clientName: true, companyName: true },
        },
      },
    }),
    prisma.meeting.findMany({
      where: {
        account: { samOwnerId: { in: scopeIds } },
        ...(range
          ? { scheduledAt: { gte: range.start, lte: range.end } }
          : {}),
      },
      select: {
        id: true,
        accountId: true,
        scheduledAt: true,
        heldAt: true,
        momSentAt: true,
        meetingType: true,
        account: {
          select: { samOwnerId: true, clientName: true, companyName: true },
        },
      },
    }),
  ]);

  // 4. Per-SAM aggregator that returns the same SamRow shape used above for
  //    the team list — we call it once with samId filter, once per team SAM
  //    for the averages.
  const aggregateFor = (forSamId: string) => {
    const samAccounts = accounts.filter((a) => a.samOwnerId === forSamId);
    const samChanges = changes.filter((c) => c.account.samOwnerId === forSamId);
    const samMeetings = meetings.filter((m) => m.account.samOwnerId === forSamId);
    return rollUpSam(samAccounts, samChanges, samMeetings);
  };

  const self = aggregateFor(sam.id);
  const peerRows = peerSamIds.map(aggregateFor);
  const avg = averageRows(peerRows);

  // 5. Meetings split: upcoming (scheduled in next 7d, not yet held), recent
  //    (held in past 7d). Both quarter-bounded if a quarter is selected.
  const samMeetingsAll = meetings.filter((m) => m.account.samOwnerId === sam.id);
  const nowMs = now.getTime();
  const upcoming = samMeetingsAll
    .filter((m) => !m.heldAt && m.scheduledAt.getTime() > nowMs - 60_000) // tolerate clock skew
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .slice(0, 20)
    .map((m) => ({
      id: m.id,
      scheduledAt: m.scheduledAt.toISOString(),
      customer: {
        id: m.accountId,
        clientName: m.account.clientName,
        companyName: m.account.companyName,
      },
    }));
  const recent = samMeetingsAll
    .filter(
      (m) => m.heldAt && nowMs - m.heldAt.getTime() <= 14 * 24 * 60 * 60 * 1000,
    )
    .sort((a, b) => (b.heldAt?.getTime() ?? 0) - (a.heldAt?.getTime() ?? 0))
    .slice(0, 20)
    .map((m) => ({
      id: m.id,
      scheduledAt: m.scheduledAt.toISOString(),
      heldAt: m.heldAt!.toISOString(),
      momSentAt: m.momSentAt?.toISOString() ?? null,
      momOverdue:
        m.heldAt !== null &&
        m.momSentAt === null &&
        nowMs - m.heldAt.getTime() > FORTY_EIGHT_HOURS_MS,
      customer: {
        id: m.accountId,
        clientName: m.account.clientName,
        companyName: m.account.companyName,
      },
    }));

  // 6. Risk pulse — point-in-time, this SAM only.
  const samAccountsAll = accounts.filter((a) => a.samOwnerId === sam.id);
  const probableChurnAccounts = samAccountsAll.filter(
    (a) =>
      a.contractStatus === 'PROBABLE_CHURN' || a.contractStatus === 'DISCONNECTING',
  );
  const probableChurnArc = probableChurnAccounts.reduce(
    (s, a) => s + Number(a.currentArc),
    0,
  );
  const activeAccounts = samAccountsAll.filter(
    (a) =>
      a.contractStatus === 'ACTIVE' ||
      a.contractStatus === 'PROBABLE_CHURN' ||
      a.contractStatus === 'DISCONNECTING',
  );
  const accountsWithAnyMeeting = new Set(
    samMeetingsAll.map((m) => m.accountId),
  );
  const customersWithoutMeeting = activeAccounts.filter(
    (a) => !accountsWithAnyMeeting.has(a.id),
  ).length;
  const staleMoms = samMeetingsAll.filter(
    (m) =>
      m.heldAt &&
      !m.momSentAt &&
      nowMs - m.heldAt.getTime() > FORTY_EIGHT_HOURS_MS,
  ).length;
  const day21Prompts = changes.filter(
    (c) =>
      c.account.samOwnerId === sam.id &&
      c.changeType === 'DISCONNECTION' &&
      c.retentionDecision === null &&
      c.retentionPromptDueAt !== null &&
      c.retentionPromptDueAt.getTime() <= nowMs,
  ).length;

  // 7. Activity timeline — chronological feed for the past 30 days within
  //    the chosen window. Combines commercial-change milestones + meetings.
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const timelineCutoff = nowMs - THIRTY_DAYS_MS;
  type Activity = SamDetail['activityTimeline'][number];
  const timeline: Activity[] = [];
  for (const c of changes) {
    if (c.account.samOwnerId !== sam.id) continue;
    const cust = {
      id: c.accountId,
      clientName: c.account.clientName,
      companyName: c.account.companyName,
    };
    const display = cust.companyName || cust.clientName;
    if (c.createdAt.getTime() >= timelineCutoff) {
      timeline.push({
        type: 'CHANGE_COMMITTED',
        timestamp: c.createdAt.toISOString(),
        summary: `${labelForChange(c.changeType)} on ${display}`,
        customer: cust,
      });
    }
    if (
      c.retentionDecidedAt &&
      c.retentionDecidedAt.getTime() >= timelineCutoff
    ) {
      timeline.push({
        type:
          c.retentionDecision === 'RETAIN' ? 'CHANGE_RETAINED' : 'CHANGE_PROCEEDED',
        timestamp: c.retentionDecidedAt.toISOString(),
        summary:
          c.retentionDecision === 'RETAIN'
            ? `Retained ${display} (disconnection cancelled)`
            : `Proceeded with disconnection on ${display}`,
        customer: cust,
      });
    }
  }
  for (const m of samMeetingsAll) {
    if (m.heldAt && m.heldAt.getTime() >= timelineCutoff) {
      timeline.push({
        type: 'MEETING_HELD',
        timestamp: m.heldAt.toISOString(),
        summary: `Meeting held with ${m.account.companyName || m.account.clientName}`,
        customer: {
          id: m.accountId,
          clientName: m.account.clientName,
          companyName: m.account.companyName,
        },
      });
    }
    if (m.momSentAt && m.momSentAt.getTime() >= timelineCutoff) {
      timeline.push({
        type: 'MOM_SENT',
        timestamp: m.momSentAt.toISOString(),
        summary: `MOM sent to ${m.account.companyName || m.account.clientName}`,
        customer: {
          id: m.accountId,
          clientName: m.account.clientName,
          companyName: m.account.companyName,
        },
      });
    }
  }
  timeline.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const activityTimeline = timeline.slice(0, 50);

  // 8. Score component breakdown — same formulae as computeReliabilityScore
  //    but the four sub-scores are surfaced individually for the UI bars.
  const scoreInput = {
    revenueDeltaPercent: self.arcDeltaPercent,
    upgrades: self.changes.UPGRADE.count,
    downgrades: self.changes.DOWNGRADE.count,
    terminations: self.changes.DISCONNECTION.count,
    momSlaPercent: self.momSlaPercent,
    meetingCoveragePercent:
      self.activeAccountsCount === 0
        ? 0
        : (self.accountsWithMeetingCount / self.activeAccountsCount) * 100,
    approvalPercent: self.approvalPercent,
    hasNewKittyAccounts: self.hasNewKitty,
  };
  const components = scoreComponents(scoreInput);

  return {
    sam: {
      id: sam.id,
      name: sam.name,
      email: sam.email,
      samHeadId: sam.samHeadId,
      samHeadName: sam.samHead?.name ?? null,
    },
    quarter: quarter ?? null,
    score: {
      total: round1(self.reliabilityScore),
      components,
    },
    kpis: {
      customers: {
        value: self.activeAccountsCount,
        teamAvg: round1(avg.activeAccountsCount),
        withoutMeeting: self.customersWithoutMeeting,
      },
      arcManaged: {
        value: round0(self.totalArc),
        teamAvg: round0(avg.totalArc),
        arcDelta: round0(self.arcDelta),
        arcDeltaPercent: round1(self.arcDeltaPercent),
      },
      commercialChanges: {
        value: self.totalChanges,
        teamAvg: round1(avg.totalChanges),
        activationPending: self.activationPending,
      },
      meetings: {
        value: self.meetingsHeld,
        teamAvg: round1(avg.meetingsHeld),
        upcomingCount: upcoming.length,
        online: self.meetingsOnline,
        offline: self.meetingsOffline,
      },
      momSla: {
        value: round1(self.momSlaPercent),
        teamAvg: round1(avg.momSlaPercent),
        momsOverdue: staleMoms,
      },
    },
    changes: self.changes,
    upcomingMeetings: upcoming,
    recentMeetings: recent,
    activityTimeline,
    riskPulse: {
      probableChurnCount: probableChurnAccounts.length,
      probableChurnArc: round0(probableChurnArc),
      customersWithoutMeeting,
      staleMoms,
      day21Prompts,
    },
    churn: (() => {
      const netChurnArc =
        self.changes.DISCONNECTION.arcImpact +
        self.changes.DOWNGRADE.arcImpact -
        self.changes.UPGRADE.arcImpact;
      const netChurnPercent =
        self.startOfPeriodArc > 0 ? (netChurnArc / self.startOfPeriodArc) * 100 : 0;
      const allowable = Number(sam.allowableChurnPercent);
      return {
        netChurnArc: round0(netChurnArc),
        netChurnPercent: round2(netChurnPercent),
        allowableChurnPercent: round2(allowable),
        churnHeadroomPercent: round2(allowable - netChurnPercent),
        churnStatus:
          netChurnPercent <= allowable
            ? ('under_budget' as const)
            : ('over_budget' as const),
      };
    })(),
  };
}

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

const CHANGE_LABEL: Record<CommercialChangeType, string> = {
  UPGRADE: 'Upgrade committed',
  DOWNGRADE: 'Downgrade committed',
  RATE_REVISION: 'Rate revision committed',
  DISCONNECTION: 'Disconnection raised',
};
function labelForChange(t: CommercialChangeType): string {
  return CHANGE_LABEL[t];
}

type RolledRow = {
  activeAccountsCount: number;
  accountsWithMeetingCount: number;
  customersWithoutMeeting: number;
  hasNewKitty: boolean;
  totalArc: number;
  startOfPeriodArc: number;
  arcDelta: number;
  arcDeltaPercent: number;
  changes: Record<CommercialChangeType, { count: number; arcImpact: number }>;
  totalChanges: number;
  meetingsHeld: number;
  meetingsOnline: number;
  meetingsOffline: number;
  momsSent: number;
  momSlaPercent: number;
  approvalPercent: number;
  activationPending: number;
  reliabilityScore: number;
};

function rollUpSam(
  samAccounts: Array<{
    id: string;
    currentArc: unknown;
    startOfPeriodArc: unknown;
    contractStatus: string;
    kittyType: string;
  }>,
  samChanges: Array<{
    changeType: CommercialChangeType;
    oldArc: unknown;
    newArc: unknown;
    clientApprovalAttached: boolean;
    crmStatus: string | null;
  }>,
  samMeetings: Array<{
    accountId: string;
    heldAt: Date | null;
    momSentAt: Date | null;
    meetingType?: 'ONLINE' | 'PHYSICAL';
  }>,
): RolledRow {
  const activeAccounts = samAccounts.filter((a) => a.contractStatus !== 'TERMINATED');
  const totalArc = activeAccounts.reduce((s, a) => s + Number(a.currentArc), 0);
  const startOfPeriodArc = samAccounts.reduce(
    (s, a) => s + Number(a.startOfPeriodArc ?? a.currentArc),
    0,
  );
  const arcDelta = totalArc - startOfPeriodArc;
  const arcDeltaPercent = startOfPeriodArc > 0 ? (arcDelta / startOfPeriodArc) * 100 : 0;

  const changeBuckets: Record<CommercialChangeType, { count: number; arcImpact: number }> = {
    UPGRADE: { count: 0, arcImpact: 0 },
    DOWNGRADE: { count: 0, arcImpact: 0 },
    RATE_REVISION: { count: 0, arcImpact: 0 },
    DISCONNECTION: { count: 0, arcImpact: 0 },
  };
  for (const c of samChanges) {
    const oldA = Number(c.oldArc);
    const newA = Number(c.newArc);
    const b = changeBuckets[c.changeType];
    b.count += 1;
    switch (c.changeType) {
      case 'UPGRADE':
        b.arcImpact += newA - oldA;
        break;
      case 'DOWNGRADE':
      case 'RATE_REVISION':
        b.arcImpact += oldA - newA;
        break;
      case 'DISCONNECTION':
        b.arcImpact += oldA;
        break;
    }
  }

  const heldMeetings = samMeetings.filter((m) => m.heldAt !== null);
  const meetingsOnline = heldMeetings.filter((m) => m.meetingType === 'ONLINE').length;
  const meetingsOffline = heldMeetings.filter((m) => m.meetingType === 'PHYSICAL').length;
  const momsSent = samMeetings.filter((m) => m.momSentAt !== null).length;
  const momsWithin48h = heldMeetings.filter((m) => {
    if (!m.heldAt || !m.momSentAt) return false;
    const diff = m.momSentAt.getTime() - m.heldAt.getTime();
    return Math.abs(diff) <= FORTY_EIGHT_HOURS_MS;
  }).length;
  const momSlaPercent =
    heldMeetings.length === 0 ? 0 : (momsWithin48h / heldMeetings.length) * 100;
  const approvalsAttached = samChanges.filter((c) => c.clientApprovalAttached).length;
  const approvalPercent =
    samChanges.length === 0 ? 100 : (approvalsAttached / samChanges.length) * 100;
  const activationPending = samChanges.filter(
    (c) => c.crmStatus === 'PENDING_SAM_ACTIVATION',
  ).length;
  const accountsWithMeeting = new Set(samMeetings.map((m) => m.accountId));
  const customersWithoutMeeting = activeAccounts.filter(
    (a) => !accountsWithMeeting.has(a.id),
  ).length;

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
    activeAccountsCount: activeAccounts.length,
    accountsWithMeetingCount: accountsWithMeeting.size,
    customersWithoutMeeting,
    hasNewKitty: samAccounts.some((a) => a.kittyType === 'NEW'),
    totalArc,
    startOfPeriodArc,
    arcDelta,
    arcDeltaPercent,
    changes: changeBuckets,
    totalChanges: samChanges.length,
    meetingsHeld: heldMeetings.length,
    meetingsOnline,
    meetingsOffline,
    momsSent,
    momSlaPercent,
    approvalPercent,
    activationPending,
    reliabilityScore,
  };
}

function averageRows(rows: RolledRow[]): RolledRow {
  if (rows.length === 0) {
    return rollUpSam([], [], []);
  }
  const n = rows.length;
  const sum = (sel: (r: RolledRow) => number) =>
    rows.reduce((acc, r) => acc + sel(r), 0);
  return {
    activeAccountsCount: sum((r) => r.activeAccountsCount) / n,
    accountsWithMeetingCount: sum((r) => r.accountsWithMeetingCount) / n,
    customersWithoutMeeting: sum((r) => r.customersWithoutMeeting) / n,
    hasNewKitty: rows.some((r) => r.hasNewKitty),
    totalArc: sum((r) => r.totalArc) / n,
    startOfPeriodArc: sum((r) => r.startOfPeriodArc) / n,
    arcDelta: sum((r) => r.arcDelta) / n,
    arcDeltaPercent: sum((r) => r.arcDeltaPercent) / n,
    changes: {
      UPGRADE: { count: 0, arcImpact: 0 },
      DOWNGRADE: { count: 0, arcImpact: 0 },
      RATE_REVISION: { count: 0, arcImpact: 0 },
      DISCONNECTION: { count: 0, arcImpact: 0 },
    },
    totalChanges: sum((r) => r.totalChanges) / n,
    meetingsHeld: sum((r) => r.meetingsHeld) / n,
    meetingsOnline: sum((r) => r.meetingsOnline) / n,
    meetingsOffline: sum((r) => r.meetingsOffline) / n,
    momsSent: sum((r) => r.momsSent) / n,
    momSlaPercent: sum((r) => r.momSlaPercent) / n,
    approvalPercent: sum((r) => r.approvalPercent) / n,
    activationPending: sum((r) => r.activationPending) / n,
    reliabilityScore: sum((r) => r.reliabilityScore) / n,
  };
}

function scoreComponents(input: {
  revenueDeltaPercent: number;
  upgrades: number;
  downgrades: number;
  terminations: number;
  momSlaPercent: number;
  meetingCoveragePercent: number;
  approvalPercent: number;
  hasNewKittyAccounts: boolean;
}) {
  const expansionDenom = input.upgrades + input.downgrades + input.terminations;
  const expansionRatio = expansionDenom > 0 ? input.upgrades / expansionDenom : 0;
  const deltaPortion = clamp(50 + input.revenueDeltaPercent * 5, 0, 100);
  const revenueRaw = deltaPortion * 0.7 + expansionRatio * 100 * 0.3;
  const momRaw = input.momSlaPercent * 0.6 + input.meetingCoveragePercent * 0.4;
  const complianceRaw = input.approvalPercent;
  const onboardingRaw = 100; // placeholder neutral — matches computeReliabilityScore
  return {
    revenue: { weight: 40, raw: round1(revenueRaw), weighted: round1(revenueRaw * 0.4) },
    mom: { weight: 20, raw: round1(momRaw), weighted: round1(momRaw * 0.2) },
    compliance: {
      weight: 25,
      raw: round1(complianceRaw),
      weighted: round1(complianceRaw * 0.25),
    },
    onboarding: {
      weight: 15,
      raw: round1(onboardingRaw),
      weighted: round1(onboardingRaw * 0.15),
    },
  };
}
