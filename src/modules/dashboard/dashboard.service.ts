import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { sweepDueTerminations } from '../commercial-changes/commercial-changes.service.js';

export type FyQuarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';

/** Inclusive [start, end] of an Indian-FY quarter for the FY containing `now`. */
export function fyQuarterRange(
  quarter: FyQuarter,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const fyYear = month < 3 ? year - 1 : year;
  switch (quarter) {
    case 'Q1':
      return {
        start: new Date(Date.UTC(fyYear, 3, 1)),
        end: new Date(Date.UTC(fyYear, 5, 30, 23, 59, 59, 999)),
      };
    case 'Q2':
      return {
        start: new Date(Date.UTC(fyYear, 6, 1)),
        end: new Date(Date.UTC(fyYear, 8, 30, 23, 59, 59, 999)),
      };
    case 'Q3':
      return {
        start: new Date(Date.UTC(fyYear, 9, 1)),
        end: new Date(Date.UTC(fyYear, 11, 31, 23, 59, 59, 999)),
      };
    case 'Q4':
      return {
        start: new Date(Date.UTC(fyYear + 1, 0, 1)),
        end: new Date(Date.UTC(fyYear + 1, 2, 31, 23, 59, 59, 999)),
      };
  }
}

export type NewBaseMetrics = {
  // Components — mirrors ExistingBaseMetrics shape so the dashboards are
  // structurally identical. "Total" includes terminated; "Current" excludes.
  totalCustomers: number;
  totalNewArcLakh: number;
  currentCustomers: number;
  currentArcLakh: number;
  terminatedCount: number;

  // Commercial-change breakdown across NEW-kitty accounts (not time-windowed).
  upgrades:      { count: number; arcAddedLakh: number };
  downgrades:    { count: number; arcReducedLakh: number };
  rateRevisions: { count: number; arcChangeLakh: number };
  terminations:  { count: number; arcLostLakh: number };

  // NEW-kitty customers in the 21-day retention window or 10-day disconnecting
  // window. Same semantics as ExistingBaseMetrics.probableChurn — their ARC
  // is excluded from `currentArcLakh` and reported separately as "at risk".
  probableChurn: { count: number; arcAtRiskLakh: number };

  // Velocity (by onboardingDate)
  addedThisMonth:   { count: number; arcLakh: number };
  addedThisQuarter: { count: number; arcLakh: number };
  addedThisFy:      { count: number; arcLakh: number };

  // Onboarding efficiency (CLAUDE.md §4.4)
  avgTimeToFirstMomDays: number | null;
  customersWithoutMeeting: number;

  // Early growth (§4.5)
  earlyUpgrades: { count: number; arcAddedLakh: number }; // upgrades ≤ 180d of onboarding

  // Clean handover risks (§4.6)
  immediateRateRevisions: number; // rate-rev ≤ 60d → sales mispricing
  earlyDowngrades: number;        // downgrade ≤ 60d → bad qualification

  // Recent additions table (last 10)
  recentAdditions: Array<{
    id: string;
    clientName: string;
    companyName: string | null;
    customerCode: string | null;
    onboardingDate: string;
    /** Annualised Recurring Contribution, lakh-denominated. */
    currentArcLakh: number;
    contractStatus: string;
  }>;
};

export type ExistingBaseMetrics = {
  // Row 1 — backed by real data
  totalCustomers: number;
  totalBaseArcLakh: number;
  currentCustomers: number;
  currentArcLakh: number;
  terminatedCount: number;

  // Row 2 — aggregated from commercial_changes
  upgrades: { count: number; arcAddedLakh: number };
  downgrades: { count: number; arcReducedLakh: number };
  rateRevisions: { count: number; arcChangeLakh: number };
  terminations: { count: number; arcLostLakh: number };

  // Customers in the 21-day probable-churn window or 10-day disconnecting
  // window. Their ARC is excluded from `currentArcLakh` / `currentCustomers`
  // and surfaced separately as "at risk" so SAM_HEAD can see how much
  // revenue is on the line — the retention queue lives at /probable-churn.
  probableChurn: { count: number; arcAtRiskLakh: number };
};

const LAKH = 100_000;

export const dashboardService = {
  async existingBase(opts: { quarter?: FyQuarter } = {}): Promise<ExistingBaseMetrics> {
    // Sweep any disconnections whose 10-day notice has expired so the
    // dashboard reflects current truth before we read accounts/changes.
    await sweepDueTerminations();

    // 1. BASE accounts snapshot — always anchored to April 1.
    const baseAccounts = await prisma.account.findMany({
      where: { kittyType: 'BASE' },
      select: {
        id: true,
        currentArc: true,
        startOfPeriodArc: true,
        contractStatus: true,
      },
    });

    const totalCustomers = baseAccounts.length;
    // Start-of-period ARC uses the snapshot, falling back to currentArc for legacy
    // rows that pre-date the B1 import (where startOfPeriodArc is null).
    const startOfPeriodArcSum = baseAccounts.reduce(
      (sum, a) => sum + Number(a.startOfPeriodArc ?? a.currentArc),
      0,
    );

    // 2. Commercial changes against BASE accounts, optionally narrowed to a quarter window.
    const baseAccountIds = baseAccounts.map((a) => a.id);
    const changeWhere: Prisma.CommercialChangeWhereInput = {
      accountId: { in: baseAccountIds },
    };
    if (opts.quarter) {
      const { start, end } = fyQuarterRange(opts.quarter);
      changeWhere.effectiveDate = { gte: start, lte: end };
    }
    const changes =
      baseAccountIds.length === 0
        ? []
        : await prisma.commercialChange.findMany({
            where: changeWhere,
            select: {
              changeType: true,
              oldArc: true,
              newArc: true,
              accountAppliedAt: true,
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
      const oldA = Number(c.oldArc);
      const newA = Number(c.newArc);
      switch (c.changeType) {
        case 'UPGRADE':
          upgradesCount++;
          upgradesArcAdded += newA - oldA;
          break;
        case 'DOWNGRADE':
          downgradesCount++;
          downgradesArcReduced += oldA - newA;
          break;
        case 'RATE_REVISION':
          rateRevsCount++;
          rateRevsArcChange += oldA - newA; // positive magnitude
          break;
        case 'DISCONNECTION':
          // Only count disconnections that have *actually* terminated the
          // account. Rows still in the probable-churn / disconnecting
          // window have `accountAppliedAt = null` and are surfaced in the
          // separate probableChurn block.
          if (c.accountAppliedAt) {
            terminationsCount++;
            terminationsArcLost += oldA;
          }
          break;
      }
    }

    // 3. Probable churn — point-in-time, applies to both quarter and all-time
    //    views. Customers sitting in the 21-day retention window or the
    //    10-day notice window have their ARC excluded from `currentArcLakh`
    //    and reported separately as "at risk".
    const probableChurnAccounts = baseAccounts.filter(
      (a) => a.contractStatus === 'PROBABLE_CHURN' || a.contractStatus === 'DISCONNECTING',
    );
    const probableChurnArc = probableChurnAccounts.reduce(
      (sum, a) => sum + Number(a.currentArc),
      0,
    );

    // 4. Compute end-of-window state.
    //    - No quarter filter (All Time): use the live accounts table — it's
    //      the source of truth.
    //    - Quarter filter: replay window deltas on top of the start snapshot.
    //    In both cases, exclude probable-churn accounts from Current totals.
    const startArc = startOfPeriodArcSum;
    let currentArc: number;
    let currentCustomers: number;
    let terminatedCount: number;
    if (opts.quarter) {
      // Rate revisions intentionally NOT included: per the current business
      // rule (CLAUDE.md gotcha #5) a rate revision keeps ARC unchanged
      // (bandwidth uplift only), so `rateRevsArcChange` should always be 0.
      // Defensively excluding it keeps the running ARC honest even if legacy
      // data ever carried a non-zero delta on a RATE_REVISION row.
      const netDeltaArc =
        upgradesArcAdded - downgradesArcReduced - terminationsArcLost;
      currentArc = startArc + netDeltaArc - probableChurnArc;
      terminatedCount = terminationsCount;
      currentCustomers = totalCustomers - terminationsCount - probableChurnAccounts.length;
    } else {
      const liveActive = baseAccounts.filter(
        (a) =>
          a.contractStatus !== 'TERMINATED' &&
          a.contractStatus !== 'PROBABLE_CHURN' &&
          a.contractStatus !== 'DISCONNECTING',
      );
      const liveTerminated = baseAccounts.filter(
        (a) => a.contractStatus === 'TERMINATED',
      ).length;
      currentArc = liveActive.reduce((sum, a) => sum + Number(a.currentArc), 0);
      currentCustomers = liveActive.length;
      terminatedCount = liveTerminated;
    }

    return {
      totalCustomers,
      totalBaseArcLakh: roundLakh(startArc / LAKH),
      currentCustomers,
      currentArcLakh: roundLakh(currentArc / LAKH),
      terminatedCount,
      upgrades: {
        count: upgradesCount,
        arcAddedLakh: roundLakh(upgradesArcAdded / LAKH),
      },
      downgrades: {
        count: downgradesCount,
        arcReducedLakh: roundLakh(downgradesArcReduced / LAKH),
      },
      rateRevisions: {
        count: rateRevsCount,
        arcChangeLakh: roundLakh(rateRevsArcChange / LAKH),
      },
      terminations: {
        count: terminationsCount,
        arcLostLakh: roundLakh(terminationsArcLost / LAKH),
      },
      probableChurn: {
        count: probableChurnAccounts.length,
        arcAtRiskLakh: roundLakh(probableChurnArc / LAKH),
      },
    };
  },
};

/**
 * Rounds a lakh-denominated number to 2 decimal places (~₹1K granularity).
 *
 * Previously this rounded to 1 decimal, which silently truncated sub-lakh
 * deltas to zero — e.g. a ₹4,000 upgrade (96,000 → 100,000 ARC) rounded to
 * 0.0L and the bucket card on the dashboard rendered as "₹0" despite the
 * commercial change being counted. 2 decimals (₹0.01L = ₹1K) keeps small
 * but meaningful deltas visible while still display-friendly downstream
 * (`.toFixed(1)` callers re-round at render time).
 */
function roundLakh(n: number): number {
  return Math.round(n * 100) / 100;
}

// ============================================================================
// New Base — Growth & Velocity (CLAUDE.md §4.4-4.6)
// ============================================================================

const EARLY_HANDOVER_DAYS = 60;   // §4.6 — within this window indicates a sales/qualification problem
const EARLY_GROWTH_DAYS = 180;    // §4.5 — first 6 months counts as "early growth"

function startOfDayUTC(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function startOfMonthUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Indian financial year window starts on April 1.
 * For dates Jan-Mar, the FY started in the *previous* calendar year.
 */
function startOfFyUTC(now: Date): Date {
  const year = now.getUTCMonth() < 3 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  return new Date(Date.UTC(year, 3, 1)); // April 1
}

/**
 * FY-aligned quarters: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.
 */
function startOfFyQuarterUTC(now: Date): Date {
  const month = now.getUTCMonth(); // 0=Jan
  const year = now.getUTCFullYear();
  if (month >= 3 && month <= 5) return new Date(Date.UTC(year, 3, 1));      // Q1
  if (month >= 6 && month <= 8) return new Date(Date.UTC(year, 6, 1));      // Q2
  if (month >= 9 && month <= 11) return new Date(Date.UTC(year, 9, 1));     // Q3
  // Jan-Mar is Q4 of the previous calendar year's FY
  return new Date(Date.UTC(year - 1, 0, 1));
}

function daysBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 86_400_000;
}

export async function computeNewBase(
  now: Date = new Date(),
): Promise<NewBaseMetrics> {
  // Sweep any disconnections whose 10-day notice has expired so this view
  // reflects current truth — mirrors the existingBase entry point.
  await sweepDueTerminations();

  const newAccounts = await prisma.account.findMany({
    where: { kittyType: 'NEW' },
    select: {
      id: true,
      clientName: true,
      companyName: true,
      customerCode: true,
      currentArc: true,
      startOfPeriodArc: true,
      contractStatus: true,
      onboardingDate: true,
    },
    orderBy: { onboardingDate: 'desc' },
  });

  // "Active" for this dashboard means ACTIVE in the operational sense —
  // customers we're billing today. Customers in PROBABLE_CHURN or
  // DISCONNECTING are still being billed but their ARC is at risk; they
  // surface in the probableChurn block below, not in Current ARC.
  const active = newAccounts.filter((a) => a.contractStatus === 'ACTIVE');
  const probableChurnAccounts = newAccounts.filter(
    (a) => a.contractStatus === 'PROBABLE_CHURN' || a.contractStatus === 'DISCONNECTING',
  );

  // Components — mirrors existing-base. "Total" = all accounts ever onboarded
  // (includes terminated + probable churn). "Current" = active-and-paying.
  const totalCustomers = newAccounts.length;
  const currentCustomers = active.length;
  const terminatedCount = newAccounts.filter((a) => a.contractStatus === 'TERMINATED').length;
  const probableChurnArc = probableChurnAccounts.reduce(
    (s, a) => s + Number(a.currentArc),
    0,
  );
  // Total ARC anchors on each account's onboarding-time ARC (`startOfPeriodArc`)
  // so post-onboarding commercial changes don't pollute the headline.
  const totalNewArc = newAccounts.reduce(
    (s, a) => s + Number(a.startOfPeriodArc ?? a.currentArc),
    0,
  );
  const currentArc = active.reduce((s, a) => s + Number(a.currentArc), 0);

  // Velocity windows
  const monthStart   = startOfMonthUTC(now);
  const quarterStart = startOfFyQuarterUTC(now);
  const fyStart      = startOfFyUTC(now);

  const sumIn = (since: Date) => {
    const within = active.filter(
      (a) => startOfDayUTC(a.onboardingDate) >= since,
    );
    const arc = within.reduce((s, a) => s + Number(a.currentArc), 0);
    return { count: within.length, arcLakh: roundLakh(arc / LAKH) };
  };

  const addedThisMonth   = sumIn(monthStart);
  const addedThisQuarter = sumIn(quarterStart);
  const addedThisFy      = sumIn(fyStart);

  // Onboarding efficiency
  const newAccountIds = newAccounts.map((a) => a.id);
  const meetings =
    newAccountIds.length === 0
      ? []
      : await prisma.meeting.findMany({
          where: { accountId: { in: newAccountIds } },
          select: {
            accountId: true,
            heldAt: true,
            scheduledAt: true,
            momSentAt: true,
          },
        });

  // Group meetings by account, find first MOM-sent (or earliest meeting if none MOM'd).
  const firstMomByAccount = new Map<string, Date>();
  const accountsWithAnyMeeting = new Set<string>();
  for (const m of meetings) {
    accountsWithAnyMeeting.add(m.accountId);
    const candidate = m.momSentAt ?? m.heldAt ?? m.scheduledAt;
    const existing = firstMomByAccount.get(m.accountId);
    if (!existing || candidate < existing) {
      firstMomByAccount.set(m.accountId, candidate);
    }
  }

  const ttfmDays: number[] = [];
  for (const acct of newAccounts) {
    const firstMom = firstMomByAccount.get(acct.id);
    if (firstMom) {
      const days = daysBetween(firstMom, acct.onboardingDate);
      if (days >= 0) ttfmDays.push(days);
    }
  }
  const avgTimeToFirstMomDays =
    ttfmDays.length === 0
      ? null
      : Math.round((ttfmDays.reduce((s, d) => s + d, 0) / ttfmDays.length) * 10) / 10;

  const customersWithoutMeeting = active.filter(
    (a) => !accountsWithAnyMeeting.has(a.id),
  ).length;

  // Early growth + handover risks (commercial_changes joined to NEW accounts)
  const changes =
    newAccountIds.length === 0
      ? []
      : await prisma.commercialChange.findMany({
          where: { accountId: { in: newAccountIds } },
          select: {
            accountId: true,
            changeType: true,
            oldArc: true,
            newArc: true,
            effectiveDate: true,
            accountAppliedAt: true,
          },
        });
  const onboardingByAccount = new Map(newAccounts.map((a) => [a.id, a.onboardingDate]));

  let earlyUpgradesCount = 0;
  let earlyUpgradesArcAdded = 0;
  let immediateRateRevisions = 0;
  let earlyDowngrades = 0;

  // All-time commercial-change buckets across NEW kitty (mirrors existing-base
  // shape, no onboarding-window filter).
  let upgradesCount = 0;
  let upgradesArcAdded = 0;
  let downgradesCount = 0;
  let downgradesArcReduced = 0;
  let rateRevsCount = 0;
  let rateRevsArcChange = 0;
  let terminationsCount = 0;
  let terminationsArcLost = 0;

  for (const c of changes) {
    const oldA = Number(c.oldArc);
    const newA = Number(c.newArc);

    // All-time aggregates.
    switch (c.changeType) {
      case 'UPGRADE':
        upgradesCount++;
        upgradesArcAdded += newA - oldA;
        break;
      case 'DOWNGRADE':
        downgradesCount++;
        downgradesArcReduced += oldA - newA;
        break;
      case 'RATE_REVISION':
        rateRevsCount++;
        rateRevsArcChange += oldA - newA;
        break;
      case 'DISCONNECTION':
        // Only count fully-terminated disconnections — rows still in the
        // probable-churn / disconnecting window have accountAppliedAt = null
        // and are reported in the probableChurn block instead.
        if (c.accountAppliedAt) {
          terminationsCount++;
          terminationsArcLost += oldA;
        }
        break;
    }

    // Onboarding-window flags (still useful for the "early" / risk callouts).
    const onboarded = onboardingByAccount.get(c.accountId);
    if (!onboarded) continue;
    const days = daysBetween(c.effectiveDate, onboarded);
    if (days < 0) continue;
    if (c.changeType === 'UPGRADE' && days <= EARLY_GROWTH_DAYS) {
      earlyUpgradesCount++;
      earlyUpgradesArcAdded += newA - oldA;
    }
    if (c.changeType === 'RATE_REVISION' && days <= EARLY_HANDOVER_DAYS) {
      immediateRateRevisions++;
    }
    if (c.changeType === 'DOWNGRADE' && days <= EARLY_HANDOVER_DAYS) {
      earlyDowngrades++;
    }
  }

  // Recent additions: top 10 by onboardingDate desc
  const recentAdditions = newAccounts.slice(0, 10).map((a) => ({
    id: a.id,
    clientName: a.clientName,
    companyName: a.companyName,
    customerCode: a.customerCode,
    onboardingDate: a.onboardingDate.toISOString().slice(0, 10),
    currentArcLakh: roundLakh(Number(a.currentArc) / LAKH),
    contractStatus: a.contractStatus,
  }));

  return {
    totalCustomers,
    totalNewArcLakh: roundLakh(totalNewArc / LAKH),
    currentCustomers,
    currentArcLakh: roundLakh(currentArc / LAKH),
    terminatedCount,
    upgrades: {
      count: upgradesCount,
      arcAddedLakh: roundLakh(upgradesArcAdded / LAKH),
    },
    downgrades: {
      count: downgradesCount,
      arcReducedLakh: roundLakh(downgradesArcReduced / LAKH),
    },
    rateRevisions: {
      count: rateRevsCount,
      arcChangeLakh: roundLakh(rateRevsArcChange / LAKH),
    },
    terminations: {
      count: terminationsCount,
      arcLostLakh: roundLakh(terminationsArcLost / LAKH),
    },
    probableChurn: {
      count: probableChurnAccounts.length,
      arcAtRiskLakh: roundLakh(probableChurnArc / LAKH),
    },
    addedThisMonth,
    addedThisQuarter,
    addedThisFy,
    avgTimeToFirstMomDays,
    customersWithoutMeeting,
    earlyUpgrades: {
      count: earlyUpgradesCount,
      arcAddedLakh: roundLakh(earlyUpgradesArcAdded / LAKH),
    },
    immediateRateRevisions,
    earlyDowngrades,
    recentAdditions,
  };
}
