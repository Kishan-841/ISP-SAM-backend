import type { UserRole } from '@prisma/client';
import { prisma } from '../../prisma.js';

/**
 * Role-scoped operational alerts for the home page.
 *
 *  - SAM:       only their own customers / changes / meetings.
 *  - SAM_HEAD:  team scope (own + reports + unassigned triage queue).
 *  - ADMIN:     org-wide.
 *
 * Each Alert is one card on the home page. `severity` controls visual tone
 * and ordering (critical → warning → info). `count` is the number of items
 * that make up this alert; `href` is where to drill in.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type Alert = {
  id: string;
  severity: AlertSeverity;
  title: string;
  description: string;
  count: number;
  href: string;
  /** Optional sample identifiers to render as chips ("rohit sharma · raman · 3 more"). */
  samples?: string[];
};

const STALE_MEETING_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function computeAlerts({
  requester,
}: {
  requester: { id: string; role: UserRole };
}): Promise<{ alerts: Alert[] }> {
  const accountIds = await scopedAccountIds(requester);

  // No accounts in scope → likely a fresh SAM with nothing assigned.
  if (accountIds.length === 0 && requester.role === 'SAM') {
    return {
      alerts: [
        {
          id: 'sam-no-accounts',
          severity: 'info',
          title: 'No customers assigned yet',
          description:
            'Your SAM_HEAD will assign customers to you. Until then, there is nothing to act on here.',
          count: 0,
          href: '/customers',
        },
      ],
    };
  }

  const [accounts, changes, meetings, unassignedCount] = await Promise.all([
    prisma.account.findMany({
      where: { id: { in: accountIds } },
      select: {
        id: true,
        clientName: true,
        companyName: true,
        contractStatus: true,
        externalCrmId: true,
        onboardingDate: true,
      },
    }),
    prisma.commercialChange.findMany({
      where: {
        accountId: { in: accountIds },
        crmStatus: 'PENDING_SAM_ACTIVATION',
      },
      select: { id: true, accountId: true },
    }),
    prisma.meeting.findMany({
      where: { accountId: { in: accountIds } },
      select: {
        accountId: true,
        heldAt: true,
        momSentAt: true,
      },
    }),
    requester.role === 'SAM_HEAD' || requester.role === 'ADMIN'
      ? prisma.account.count({ where: { samOwnerId: null } })
      : Promise.resolve(0),
  ]);

  // Most-recent-heldAt per account, used by the "stale meeting" alert.
  const lastMeetingByAccount = new Map<string, number>();
  // Meetings held but missing MOM — total across scope.
  let momsPending = 0;
  for (const m of meetings) {
    if (m.heldAt) {
      const t = new Date(m.heldAt).getTime();
      const prev = lastMeetingByAccount.get(m.accountId) ?? 0;
      if (t > prev) lastMeetingByAccount.set(m.accountId, t);
      if (!m.momSentAt) momsPending += 1;
    }
  }

  const now = Date.now();
  const staleAccounts = accounts.filter((a) => {
    if (a.contractStatus === 'TERMINATED') return false;
    const last = lastMeetingByAccount.get(a.id);
    return !last || now - last > STALE_MEETING_DAYS * MS_PER_DAY;
  });
  const accountsWithoutAnyMeeting = accounts.filter(
    (a) => a.contractStatus !== 'TERMINATED' && !lastMeetingByAccount.has(a.id),
  );
  const noCrmIdAccounts =
    requester.role === 'ADMIN'
      ? accounts.filter(
          (a) => a.contractStatus !== 'TERMINATED' && !a.externalCrmId,
        )
      : [];

  const alerts: Alert[] = [];

  // 1. Unassigned triage queue (SAM_HEAD/ADMIN only).
  if (unassignedCount > 0) {
    alerts.push({
      id: 'unassigned-customers',
      severity: 'warning',
      title: `${unassignedCount} unassigned ${unassignedCount === 1 ? 'customer' : 'customers'}`,
      description:
        'New customers from CRM are waiting for a SAM. Until you assign them, nobody can run commercial changes or meetings.',
      count: unassignedCount,
      href: '/customers?owner=unassigned',
    });
  }

  // 2. CRM activations stuck on SAMs.
  if (changes.length > 0) {
    alerts.push({
      id: 'pending-activations',
      severity: 'critical',
      title: `${changes.length} ${changes.length === 1 ? 'order is' : 'orders are'} waiting for activation date`,
      description:
        'CRM has finished docs + NOC. Confirm the billing-start date with the customer to advance the order to PENDING_ACCOUNTS.',
      count: changes.length,
      href: '/transactions',
    });
  }

  // 3. MOMs pending on held meetings.
  if (momsPending > 0) {
    alerts.push({
      id: 'moms-pending',
      severity: 'warning',
      title: `${momsPending} ${momsPending === 1 ? 'MOM' : 'MOMs'} pending`,
      description:
        'Meeting held but no MOM has gone out. CLAUDE.md compliance: every meeting needs an MOM sent within 48h.',
      count: momsPending,
      href: '/meetings',
    });
  }

  // 4. Customers stale (no meeting in 60+ days).
  if (staleAccounts.length > 0) {
    alerts.push({
      id: 'stale-customers',
      severity: 'warning',
      title: `${staleAccounts.length} ${staleAccounts.length === 1 ? 'customer has' : 'customers have'} no meeting in ${STALE_MEETING_DAYS}+ days`,
      description:
        'CLAUDE.md §4.3 — long-silent customers are a churn signal. Schedule a check-in.',
      count: staleAccounts.length,
      href: '/customers',
      samples: staleAccounts
        .slice(0, 3)
        .map((a) => a.companyName ?? a.clientName),
    });
  }

  // 5. Customers with NO meeting at all (a stronger signal — sub-set of stale).
  if (
    accountsWithoutAnyMeeting.length > 0 &&
    accountsWithoutAnyMeeting.length < staleAccounts.length
  ) {
    // Only surface separately if it's a strict subset (avoids duplication
    // when *every* stale account also has zero meetings).
    alerts.push({
      id: 'never-met-customers',
      severity: 'critical',
      title: `${accountsWithoutAnyMeeting.length} ${accountsWithoutAnyMeeting.length === 1 ? 'customer has' : 'customers have'} never been met`,
      description:
        'These customers have been onboarded but have not had a single meeting logged. Hard SAM-failure signal.',
      count: accountsWithoutAnyMeeting.length,
      href: '/customers',
      samples: accountsWithoutAnyMeeting
        .slice(0, 3)
        .map((a) => a.companyName ?? a.clientName),
    });
  }

  // 6. ADMIN-only: customers with no externalCrmId (manually imported, can't
  //    receive CRM updates). Surfaces a data-integrity gap.
  if (noCrmIdAccounts.length > 0) {
    alerts.push({
      id: 'no-crm-id',
      severity: 'info',
      title: `${noCrmIdAccounts.length} ${noCrmIdAccounts.length === 1 ? 'customer is' : 'customers are'} not linked to CRM`,
      description:
        'These were imported manually or via Excel and have no externalCrmId. Commercial changes for them will fail at the CRM bridge.',
      count: noCrmIdAccounts.length,
      href: '/customers',
      samples: noCrmIdAccounts
        .slice(0, 3)
        .map((a) => a.companyName ?? a.clientName),
    });
  }

  // Empty queue — celebrate.
  if (alerts.length === 0) {
    alerts.push({
      id: 'all-clear',
      severity: 'info',
      title: 'All clear',
      description: 'No risk signals in your scope right now. Nice work.',
      count: 0,
      href: '/customers',
    });
  }

  // Order: critical → warning → info, then by count desc.
  const sevRank: Record<AlertSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  alerts.sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity]) {
      return sevRank[a.severity] - sevRank[b.severity];
    }
    return b.count - a.count;
  });

  return { alerts };
}

/**
 * Resolve which account ids the requester is allowed to see, mirroring the
 * scoping rules in accountsService.list. SAM_HEAD includes their reports'
 * customers; ADMIN includes everyone.
 */
async function scopedAccountIds(requester: {
  id: string;
  role: UserRole;
}): Promise<string[]> {
  if (requester.role === 'ADMIN') {
    const rows = await prisma.account.findMany({ select: { id: true } });
    return rows.map((r) => r.id);
  }
  if (requester.role === 'SAM') {
    const rows = await prisma.account.findMany({
      where: { samOwnerId: requester.id },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
  // SAM_HEAD
  const reports = await prisma.user.findMany({
    where: { samHeadId: requester.id },
    select: { id: true },
  });
  const ownerIds = [requester.id, ...reports.map((r) => r.id)];
  const rows = await prisma.account.findMany({
    where: { samOwnerId: { in: ownerIds } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
