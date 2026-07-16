import type {
  KittyType,
  UserRole,
  Prisma,
  CommercialChangeType,
} from '@prisma/client';
import { prisma } from '../../prisma.js';
import { sendCustomerAssignedAlert } from '../../services/email/notifications.service.js';

const TYPE_LABEL: Record<CommercialChangeType, string> = {
  UPGRADE: 'Upgrade',
  DOWNGRADE: 'Downgrade',
  RATE_REVISION: 'Rate Revision',
  DISCONNECTION: 'Disconnection',
};

export type Requester = { id: string; role: UserRole };

/**
 * Fields an admin can edit via PATCH /accounts/:id. Anything not in this
 * union (id, kittyType, samOwnerId, metadata, createdAt) is either
 * immutable or has its own dedicated endpoint (`/assign`).
 *
 * Note: `startOfPeriodArc` is intentionally immutable from system flows
 * (Excel import, CRM activation) but ADMINs may correct it here — same
 * bypass pattern as `currentArc`. Every edit is audit-logged.
 *
 *   - `undefined` = field not touched
 *   - `null`      = clear the field (where nullable)
 */
export type AccountUpdatePatch = {
  clientName?: string;
  companyName?: string | null;
  mobileNumber?: string | null;
  email?: string | null;
  currentArc?: number;
  startOfPeriodArc?: number | null;
  contractStatus?:
    | 'ACTIVE'
    | 'EXPIRED'
    | 'TERMINATED'
    | 'PENDING'
    | 'PROBABLE_CHURN'
    | 'DISCONNECTING'
    | 'PENDING_QUICK_APPROVAL';
  currentPlan?: string | null;
  bandwidthMbps?: number | null;
  customerCode?: string | null;
  circuitId?: string | null;
  address?: string | null;
  gstNumber?: string | null;
  contactPersonName?: string | null;
  industryType?: string | null;
  circle?: string | null;
  accountManager?: string | null;
  userName?: string | null;
  ipDetails?: string | null;
  leadId?: string | null;
  externalCrmId?: string | null;
  onboardingDate?: string;
};

/**
 * Owner filter:
 *  - 'mine'        → assigned to the requester (only meaningful for SAM/SAM_HEAD)
 *  - 'unassigned'  → samOwnerId IS NULL (the SAM_HEAD triage queue)
 *  - 'team'        → owned by anyone reporting to the requester (SAM_HEAD only)
 *  - 'all' / undef → no owner filter applied (subject to role scoping below)
 */
export type OwnerFilter = 'mine' | 'unassigned' | 'team' | 'all';

const ACCOUNT_INCLUDE = {
  samOwner: { select: { id: true, name: true, email: true, role: true } },
} as const;

// Note: `currentArc` is Prisma `Decimal` and JSON-serialises as a string.
// The frontend type at sam-frontend/services/accounts.ts mirrors this.
export const accountsService = {
  async list({
    kittyType,
    owner,
    requester,
    cursor,
    limit,
  }: {
    kittyType?: KittyType;
    owner?: OwnerFilter;
    requester: Requester;
    /** Account id to seek past (exclusive). Use the `nextCursor` from the
     *  previous response. Undefined = first page. */
    cursor?: string;
    /** Max rows per page. Default 1000 (covers current ~700 customer
     *  count with headroom) and hard cap 1000 to keep the JSON payload
     *  (~1 KB/row) bounded. When the customer base crosses ~900 we'll
     *  need to add a "Load more" cursor walker in the customers page. */
    limit?: number;
  }) {
    const take = Math.max(1, Math.min(1_000, limit ?? 1_000));
    const where: Prisma.AccountWhereInput = {};
    if (kittyType) where.kittyType = kittyType;

    // Role-based scoping (always applied first).
    //  SAM       → only own customers
    //  SAM_HEAD  → own customers + their team's + unassigned (triage queue)
    //  ADMIN     → all
    if (requester.role === 'SAM') {
      where.samOwnerId = requester.id;
    } else if (requester.role === 'SAM_HEAD') {
      const reportIds = await listReportIds(requester.id);
      // SAM_HEAD sees: their own assignments + every SAM under them + unassigned.
      where.OR = [
        { samOwnerId: requester.id },
        { samOwnerId: { in: reportIds } },
        { samOwnerId: null },
      ];
    }

    // Owner-filter narrows further within the scope above.
    if (owner === 'mine') {
      where.samOwnerId = requester.id;
      delete where.OR;
    } else if (owner === 'unassigned') {
      where.samOwnerId = null;
      delete where.OR;
    } else if (owner === 'team' && requester.role === 'SAM_HEAD') {
      const reportIds = await listReportIds(requester.id);
      where.samOwnerId = { in: reportIds };
      delete where.OR;
    }

    // Cursor pagination — fetch `take + 1` so we can tell if there's
    // another page without a separate count query. Drop the +1 row from
    // the returned items, expose its id as `nextCursor`.
    const rows = await prisma.account.findMany({
      where,
      include: ACCOUNT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? items[items.length - 1]!.id : null;

    // For terminated rows, attach `lastDisconnectionArc` — the ARC the
    // customer was paying right before they walked. Helps the customers
    // list show "was ₹2.7Cr" instead of a uniform ₹0 across every
    // terminated row. One query for the whole page (not per-row).
    const itemsWithLost = await attachLastDisconnectionArc(items);
    return { accounts: itemsWithLost, nextCursor };
  },

  async getById(id: string, requester: Requester) {
    const account = await prisma.account.findUnique({
      where: { id },
      include: ACCOUNT_INCLUDE,
    });
    if (!account) return null;
    if (requester.role === 'SAM' && account.samOwnerId !== requester.id) {
      return null; // Pretend it doesn't exist — don't leak existence to non-owners.
    }
    const [withLost] = await attachLastDisconnectionArc([account]);
    return withLost ?? account;
  },

  /**
   * Customer journey — account header + chronological timeline of every
   * meaningful event in the customer's lifecycle. Used by the per-customer
   * detail page to give SAM_HEAD/ADMIN a one-screen story:
   *   onboarded → assigned → commercial changes → meetings → today.
   */
  async journey(id: string, requester: Requester) {
    const account = await this.getById(id, requester);
    if (!account) return null;

    const [changes, audits, meetings] = await Promise.all([
      prisma.commercialChange.findMany({
        where: { accountId: id },
        orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          changeType: true,
          oldArc: true,
          newArc: true,
          oldBandwidthMbps: true,
          newBandwidthMbps: true,
          effectiveDate: true,
          createdAt: true,
          reason: true,
          crmStatus: true,
          crmOrderNumber: true,
          accountAppliedAt: true,
          createdBy: true,
        },
      }),
      prisma.auditLog.findMany({
        where: {
          entityType: 'Account',
          entityId: id,
          action: { in: ['ASSIGN', 'UNASSIGN'] },
        },
        orderBy: { timestamp: 'asc' },
        select: {
          id: true,
          action: true,
          timestamp: true,
          performedBy: true,
          payload: true,
        },
      }),
      prisma.meeting.findMany({
        where: { accountId: id, heldAt: { not: null } },
        orderBy: { heldAt: 'asc' },
        select: {
          id: true,
          heldAt: true,
          momSentAt: true,
          createdBy: true,
        },
      }),
    ]);

    // Hydrate user names referenced by changes / audits / meetings.
    const userIds = new Set<string>();
    for (const c of changes) userIds.add(c.createdBy);
    for (const a of audits) if (a.performedBy) userIds.add(a.performedBy);
    for (const m of meetings) userIds.add(m.createdBy);
    // Pull owner-id targets out of audit payloads.
    for (const a of audits) {
      const p = a.payload as { from?: string | null; to?: string | null } | null;
      if (p?.from) userIds.add(p.from);
      if (p?.to) userIds.add(p.to);
    }
    const users = userIds.size
      ? await prisma.user.findMany({
          where: { id: { in: Array.from(userIds) } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    const nameOf = (id: string | null | undefined): string | null =>
      id ? userById.get(id)?.name ?? null : null;

    type JourneyEvent = {
      id: string;
      kind:
        | 'ONBOARDED'
        | 'ASSIGNED'
        | 'UNASSIGNED'
        | 'COMMERCIAL_CHANGE'
        | 'MEETING';
      timestamp: string;
      title: string;
      // Commercial-change details
      changeType?: 'UPGRADE' | 'DOWNGRADE' | 'RATE_REVISION' | 'DISCONNECTION';
      oldArc?: number;
      newArc?: number;
      oldBandwidthMbps?: number | null;
      newBandwidthMbps?: number | null;
      reason?: string | null;
      crmStatus?: string | null;
      crmOrderNumber?: string | null;
      accountAppliedAt?: string | null;
      // Assignment details
      fromOwnerName?: string | null;
      toOwnerName?: string | null;
      // Meeting details
      momSent?: boolean;
      // Actor (who performed it)
      performerName?: string | null;
    };

    const events: JourneyEvent[] = [];

    // 1. Onboarding — always the first event.
    events.push({
      id: `onboarded-${account.id}`,
      kind: 'ONBOARDED',
      timestamp: account.onboardingDate.toISOString(),
      title: account.kittyType === 'BASE' ? 'In Existing Base on April 1' : 'Onboarded from CRM',
    });

    // 2. Assignments (ASSIGN / UNASSIGN audit rows).
    for (const a of audits) {
      const payload = (a.payload ?? {}) as { from?: string | null; to?: string | null };
      events.push({
        id: a.id,
        kind: a.action === 'ASSIGN' ? 'ASSIGNED' : 'UNASSIGNED',
        timestamp: a.timestamp.toISOString(),
        title:
          a.action === 'ASSIGN'
            ? `Assigned to ${nameOf(payload.to) ?? 'a SAM'}`
            : `Unassigned${nameOf(payload.from) ? ` from ${nameOf(payload.from)}` : ''}`,
        fromOwnerName: nameOf(payload.from),
        toOwnerName: nameOf(payload.to),
        performerName: nameOf(a.performedBy),
      });
    }

    // 3. Commercial changes.
    for (const c of changes) {
      events.push({
        id: c.id,
        kind: 'COMMERCIAL_CHANGE',
        timestamp: c.effectiveDate.toISOString(),
        title: TYPE_LABEL[c.changeType],
        changeType: c.changeType,
        oldArc: Number(c.oldArc),
        newArc: Number(c.newArc),
        oldBandwidthMbps: c.oldBandwidthMbps,
        newBandwidthMbps: c.newBandwidthMbps,
        reason: c.reason,
        crmStatus: c.crmStatus,
        crmOrderNumber: c.crmOrderNumber,
        accountAppliedAt: c.accountAppliedAt ? c.accountAppliedAt.toISOString() : null,
        performerName: nameOf(c.createdBy),
      });
    }

    // 4. Meetings.
    for (const m of meetings) {
      if (!m.heldAt) continue;
      events.push({
        id: m.id,
        kind: 'MEETING',
        timestamp: m.heldAt.toISOString(),
        title: m.momSentAt ? 'Meeting held · MOM sent' : 'Meeting held · MOM pending',
        momSent: !!m.momSentAt,
        performerName: nameOf(m.createdBy),
      });
    }

    // Order chronologically — oldest first reads as a story.
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return { account, events };
  },

  /**
   * Assign or unassign a customer. Returns the updated account.
   * Authorisation is enforced by the caller (controller); this layer just
   * runs the update + audit log inside one transaction.
   */
  /**
   * Admin edit-any-field flow. Caller has already authorised the request
   * (ADMIN only at the route level). Diffs against current row, applies
   * the changes inside a transaction, and writes ONE audit_log row per
   * changed field with before/after in the payload — so the activity log
   * shows exactly which fields the admin touched.
   *
   * Returns the updated account + the list of fields that actually changed
   * (so the controller can short-circuit no-op responses if it wants).
   */
  async update({
    accountId,
    patch,
    requester,
    ipAddress,
    userAgent,
  }: {
    accountId: string;
    patch: AccountUpdatePatch;
    requester: Requester;
    ipAddress: string | null;
    userAgent: string | null;
  }) {
    return prisma.$transaction(async (tx) => {
      const before = await tx.account.findUnique({
        where: { id: accountId },
        include: ACCOUNT_INCLUDE,
      });
      if (!before) throw new Error('Account not found');

      // Build a Prisma update payload from only the keys the caller
      // actually sent. `undefined` = "don't touch", `null` = clear.
      const data: Prisma.AccountUpdateInput = {};
      const diffs: Array<{ field: string; from: unknown; to: unknown }> = [];

      const stringFields: Array<keyof AccountUpdatePatch> = [
        'clientName',
        'companyName',
        'mobileNumber',
        'email',
        'currentPlan',
        'customerCode',
        'circuitId',
        'address',
        'gstNumber',
        'contactPersonName',
        'industryType',
        'circle',
        'accountManager',
        'userName',
        'ipDetails',
        'leadId',
        'externalCrmId',
      ];
      for (const k of stringFields) {
        if (patch[k] === undefined) continue;
        const next = patch[k] === null ? null : String(patch[k]).trim() || null;
        const prev = (before as unknown as Record<string, unknown>)[k] ?? null;
        if ((prev ?? null) !== (next ?? null)) {
          (data as Record<string, unknown>)[k] = next;
          diffs.push({ field: k, from: prev, to: next });
        }
      }
      if (patch.bandwidthMbps !== undefined) {
        const next =
          patch.bandwidthMbps === null
            ? null
            : Number.isFinite(patch.bandwidthMbps)
              ? Math.round(patch.bandwidthMbps)
              : null;
        const prev = before.bandwidthMbps ?? null;
        if (prev !== next) {
          data.bandwidthMbps = next;
          diffs.push({ field: 'bandwidthMbps', from: prev, to: next });
        }
      }
      if (patch.currentArc !== undefined) {
        const next = Number(patch.currentArc);
        const prev = Number(before.currentArc);
        if (Number.isFinite(next) && next !== prev) {
          data.currentArc = next as unknown as Prisma.Decimal;
          diffs.push({ field: 'currentArc', from: prev, to: next });
        }
      }
      if (patch.startOfPeriodArc !== undefined) {
        const next =
          patch.startOfPeriodArc === null ? null : Number(patch.startOfPeriodArc);
        const prev = before.startOfPeriodArc == null ? null : Number(before.startOfPeriodArc);
        const valid = next === null || Number.isFinite(next);
        if (valid && next !== prev) {
          data.startOfPeriodArc = next as unknown as Prisma.Decimal | null;
          diffs.push({ field: 'startOfPeriodArc', from: prev, to: next });
        }
      }
      if (patch.contractStatus !== undefined && patch.contractStatus !== before.contractStatus) {
        data.contractStatus = patch.contractStatus;
        diffs.push({
          field: 'contractStatus',
          from: before.contractStatus,
          to: patch.contractStatus,
        });
      }
      if (patch.onboardingDate !== undefined) {
        const next = patch.onboardingDate ? new Date(patch.onboardingDate) : null;
        if (next && !Number.isNaN(next.getTime())) {
          const prevIso = before.onboardingDate.toISOString().slice(0, 10);
          const nextIso = next.toISOString().slice(0, 10);
          if (prevIso !== nextIso) {
            data.onboardingDate = next;
            diffs.push({ field: 'onboardingDate', from: prevIso, to: nextIso });
          }
        }
      }

      if (diffs.length === 0) {
        return { account: before, diffs };
      }

      const updated = await tx.account.update({
        where: { id: accountId },
        data,
        include: ACCOUNT_INCLUDE,
      });

      await tx.auditLog.createMany({
        data: diffs.map((d) => ({
          entityType: 'Account',
          entityId: accountId,
          action: 'UPDATE_FIELD',
          performedBy: requester.id,
          ipAddress,
          userAgent,
          payload: { field: d.field, from: d.from, to: d.to } as Prisma.InputJsonValue,
        })),
      });

      return { account: updated, diffs };
    });
  },

  async assign({
    accountId,
    samUserId,
    requester,
  }: {
    accountId: string;
    samUserId: string | null;
    requester: Requester;
  }) {
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true, samOwnerId: true },
      });
      if (!before) throw new Error('Account not found');

      // SAM_HEAD may only assign customers OUT of the unassigned triage queue.
      // Touching an account that already has an owner is ADMIN-only. This
      // covers unassign too, not just reassign — otherwise a head could
      // unassign and then re-assign to a different SAM as a backdoor.
      if (requester.role === 'SAM_HEAD' && before.samOwnerId) {
        throw new Error(
          'REASSIGN_FORBIDDEN: Only an ADMIN can change the owner of an already-assigned customer.',
        );
      }

      const updated = await tx.account.update({
        where: { id: accountId },
        data: { samOwnerId: samUserId },
        include: ACCOUNT_INCLUDE,
      });

      await tx.auditLog.create({
        data: {
          entityType: 'Account',
          entityId: accountId,
          action: samUserId ? 'ASSIGN' : 'UNASSIGN',
          performedBy: requester.id,
          payload: {
            from: before.samOwnerId,
            to: samUserId,
          },
        },
      });

      return updated;
    });

    // Best-effort: notify the new owner that they have a customer to manage.
    // Skipped for unassigns and silent-on-failure (audit-logged).
    if (samUserId && updated.samOwner) {
      const performer = await prisma.user.findUnique({
        where: { id: requester.id },
        select: { id: true, name: true },
      });
      if (performer) {
        await sendCustomerAssignedAlert({
          accountId: updated.id,
          account: updated,
          newOwner: {
            id: updated.samOwner.id,
            name: updated.samOwner.name,
            email: updated.samOwner.email,
          },
          assignedBy: { id: performer.id, name: performer.name },
        });
      }
    }

    return updated;
  },
};

/** Direct reports of a SAM_HEAD (SAMs whose samHeadId === headId). */
async function listReportIds(headId: string): Promise<string[]> {
  const reports = await prisma.user.findMany({
    where: { samHeadId: headId },
    select: { id: true },
  });
  return reports.map((r) => r.id);
}

/**
 * For each TERMINATED account in the list, attach `lastDisconnectionArc`
 * — the `oldArc` from the disconnection commercial change that actually
 * terminated them (`accountAppliedAt IS NOT NULL`). Non-terminated rows
 * pass through unchanged with `lastDisconnectionArc: null`.
 *
 * One query for the whole page (filtered by accountId IN (...)), then
 * an in-memory join. Picks the most recent applied disconnection if a
 * single account has multiple (e.g. retention reversed-then-re-committed).
 */
type AccountRow = Awaited<
  ReturnType<typeof prisma.account.findMany>
>[number];

async function attachLastDisconnectionArc<T extends AccountRow>(
  rows: T[],
): Promise<Array<T & { lastDisconnectionArc: number | null }>> {
  const terminatedIds = rows
    .filter((r) => r.contractStatus === 'TERMINATED')
    .map((r) => r.id);

  if (terminatedIds.length === 0) {
    return rows.map((r) => ({ ...r, lastDisconnectionArc: null }));
  }

  const discos = await prisma.commercialChange.findMany({
    where: {
      accountId: { in: terminatedIds },
      changeType: 'DISCONNECTION',
      accountAppliedAt: { not: null },
    },
    select: { accountId: true, oldArc: true, accountAppliedAt: true },
    orderBy: { accountAppliedAt: 'desc' },
  });
  // Pick the latest applied disconnection per account.
  const lostByAccount = new Map<string, number>();
  for (const d of discos) {
    if (!lostByAccount.has(d.accountId)) {
      lostByAccount.set(d.accountId, Number(d.oldArc));
    }
  }

  return rows.map((r) => ({
    ...r,
    lastDisconnectionArc:
      r.contractStatus === 'TERMINATED'
        ? lostByAccount.get(r.id) ?? null
        : null,
  }));
}
