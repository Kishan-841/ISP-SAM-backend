import type { UserRole, Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';

/**
 * Per-user notification feed. This module reads from `audit_logs` and
 * formats the rows that are *relevant to the current user* into rich
 * notification items the UI renders. There's no separate Notification
 * table today — audit_logs is the source of truth and this is just a
 * presentation layer.
 *
 * Scope rules:
 *  - SAM:      Activity on their own accounts + commercial changes.
 *  - SAM_HEAD: Same for self, plus all reports' accounts and CUSTOMER_ACTIVATED.
 *  - ADMIN:    Everything (no scope filter).
 */

export type NotificationKind =
  | 'COMMERCIAL_CHANGE_COMMITTED'
  | 'CUSTOMER_ASSIGNED'
  | 'CUSTOMER_UNASSIGNED'
  | 'CUSTOMER_ACTIVATED'
  | 'ACCOUNTS_TEAM_NOTIFIED'
  | 'CRM_ACTIVATION_PENDING'
  | 'CRM_COMPLETED'
  | 'OTHER';

export type NotificationSeverity = 'critical' | 'warning' | 'info' | 'success';

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  description: string;
  actorName: string | null;
  /** Timestamp on the audit row. */
  timestamp: string;
  /** Where to drill — either the customer page or transactions. */
  href: string;
  /** Optional inline metadata for chips (customer name, ARC delta, etc.). */
  meta?: Record<string, string>;
  /** Per-user read state — null when unread. */
  readAt: string | null;
};

export type NotificationFeed = {
  notifications: NotificationItem[];
  total: number;
  unread: number;
  page: number;
  pageSize: number;
};

const RELEVANT_ACTIONS = [
  'COMMIT',
  'ASSIGN',
  'UNASSIGN',
  'NOTIFY_CUSTOMER_ASSIGNED',
  'NOTIFY_CUSTOMER_ACTIVATED',
  'NOTIFY_ACCOUNTS_TEAM',
  'NOTIFY_CRM_PENDING_SAM_ACTIVATION',
  'NOTIFY_CRM_COMPLETED',
];

export async function getNotifications({
  requester,
  page = 1,
  pageSize = 50,
}: {
  requester: { id: string; role: UserRole };
  page?: number;
  pageSize?: number;
}): Promise<NotificationFeed> {
  const safePage = Math.max(1, page);
  const safePageSize = Math.min(100, Math.max(1, pageSize));

  // 1. Resolve the entity IDs in scope (accounts and commercial changes).
  const { accountIds, commercialChangeIds } = await scopedEntityIds(requester);

  // 2. Build the where clause — entity must be in scope OR (for heads/admins)
  //    NOTIFY_CUSTOMER_ACTIVATED rows which are global and meant for them.
  const orClauses: Record<string, unknown>[] = [];
  if (accountIds.length > 0) {
    orClauses.push({ entityType: 'Account', entityId: { in: accountIds } });
  }
  if (commercialChangeIds.length > 0) {
    orClauses.push({
      entityType: 'CommercialChange',
      entityId: { in: commercialChangeIds },
    });
  }
  if (requester.role === 'SAM_HEAD' || requester.role === 'ADMIN') {
    orClauses.push({ action: 'NOTIFY_CUSTOMER_ACTIVATED' });
  }

  // SAM with no scoped entities — short-circuit. Avoids hitting Postgres
  // with a sentinel value on the @db.Uuid `id` column (which would throw
  // P2023: invalid UUID).
  if (requester.role !== 'ADMIN' && orClauses.length === 0) {
    return {
      notifications: [],
      total: 0,
      unread: 0,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  // ADMIN sees everything regardless of scope.
  const where =
    requester.role === 'ADMIN'
      ? { action: { in: RELEVANT_ACTIONS } }
      : { AND: [{ action: { in: RELEVANT_ACTIONS } }, { OR: orClauses }] };

  // Pull dismissed audit-log ids for this user — we exclude them from the feed.
  const dismissed = await prisma.notificationState.findMany({
    where: { userId: requester.id, dismissedAt: { not: null } },
    select: { auditLogId: true },
  });
  const dismissedIds = dismissed.map((d) => d.auditLogId);
  const filteredWhere =
    dismissedIds.length > 0
      ? { AND: [where, { id: { notIn: dismissedIds } }] }
      : where;

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where: filteredWhere }),
    prisma.auditLog.findMany({
      where: filteredWhere,
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
    }),
  ]);

  // Read state for the rows we just fetched.
  const stateRows = rows.length
    ? await prisma.notificationState.findMany({
        where: {
          userId: requester.id,
          auditLogId: { in: rows.map((r) => r.id) },
        },
        select: { auditLogId: true, readAt: true },
      })
    : [];
  const readByAuditId = new Map(stateRows.map((s) => [s.auditLogId, s.readAt]));

  // 3. Hydrate user names + account/change refs for the title strings.
  //    performedBy is nullable (pre-auth events like LOGIN_FAILED), skip those.
  const performerIds = Array.from(
    new Set(rows.map((r) => r.performedBy).filter((p): p is string => !!p)),
  );
  const acctIds = Array.from(
    new Set(rows.filter((r) => r.entityType === 'Account').map((r) => r.entityId)),
  );
  const ccIds = Array.from(
    new Set(rows.filter((r) => r.entityType === 'CommercialChange').map((r) => r.entityId)),
  );

  const [performers, accountRows, ccRows] = await Promise.all([
    performerIds.length
      ? prisma.user.findMany({
          where: { id: { in: performerIds } },
          select: { id: true, name: true },
        })
      : [],
    acctIds.length
      ? prisma.account.findMany({
          where: { id: { in: acctIds } },
          select: { id: true, clientName: true, companyName: true, customerCode: true },
        })
      : [],
    ccIds.length
      ? prisma.commercialChange.findMany({
          where: { id: { in: ccIds } },
          select: {
            id: true,
            changeType: true,
            oldArc: true,
            newArc: true,
            account: {
              select: { id: true, clientName: true, companyName: true, customerCode: true },
            },
          },
        })
      : [],
  ]);

  const performerById = new Map(performers.map((u) => [u.id, u]));
  const accountById = new Map(accountRows.map((a) => [a.id, a]));
  const ccById = new Map(ccRows.map((c) => [c.id, c]));

  const notifications: NotificationItem[] = rows.map((r) => {
    const performer = r.performedBy ? performerById.get(r.performedBy) : undefined;
    const actorName = performer?.name ?? null;
    const fmt = formatRow({ row: r, accountById, ccById, actorName });
    const readAt = readByAuditId.get(r.id);
    return {
      id: r.id,
      kind: fmt.kind,
      severity: fmt.severity,
      title: fmt.title,
      description: fmt.description,
      actorName,
      timestamp: r.timestamp.toISOString(),
      href: fmt.href,
      meta: fmt.meta,
      readAt: readAt ? readAt.toISOString() : null,
    };
  });

  // Total unread within the SAME filter (not just within the page).
  const unread = await countUnread({ requester, where: filteredWhere });

  return { notifications, total, unread, page: safePage, pageSize: safePageSize };
}

async function countUnread({
  requester,
  where,
}: {
  requester: { id: string };
  where: Prisma.AuditLogWhereInput;
}): Promise<number> {
  // "unread" = audit row in scope AND no NotificationState row with readAt for this user.
  // Implemented as: count(audit rows in scope) - count(audit rows with readAt!=null state).
  const [total, readCount] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.notificationState.count({
      where: {
        userId: requester.id,
        readAt: { not: null },
        auditLog: where,
      },
    }),
  ]);
  return Math.max(0, total - readCount);
}

// ─── Mutations ────────────────────────────────────────────────────────

export async function markAsRead({
  userId,
  auditLogId,
}: {
  userId: string;
  auditLogId: string;
}) {
  await prisma.notificationState.upsert({
    where: { userId_auditLogId: { userId, auditLogId } },
    create: { userId, auditLogId, readAt: new Date() },
    update: { readAt: new Date() },
  });
}

export async function dismissNotification({
  userId,
  auditLogId,
}: {
  userId: string;
  auditLogId: string;
}) {
  await prisma.notificationState.upsert({
    where: { userId_auditLogId: { userId, auditLogId } },
    create: { userId, auditLogId, dismissedAt: new Date() },
    update: { dismissedAt: new Date() },
  });
}

export async function markAllAsRead({
  requester,
}: {
  requester: { id: string; role: UserRole };
}): Promise<{ markedCount: number }> {
  // Re-derive the same scope used by the feed so we only mark "their" notifications.
  const { accountIds, commercialChangeIds } = await scopedEntityIds(requester);
  const orClauses: Record<string, unknown>[] = [];
  if (accountIds.length > 0) {
    orClauses.push({ entityType: 'Account', entityId: { in: accountIds } });
  }
  if (commercialChangeIds.length > 0) {
    orClauses.push({
      entityType: 'CommercialChange',
      entityId: { in: commercialChangeIds },
    });
  }
  if (requester.role === 'SAM_HEAD' || requester.role === 'ADMIN') {
    orClauses.push({ action: 'NOTIFY_CUSTOMER_ACTIVATED' });
  }
  // SAM with no scoped entities — nothing to mark. See note in
  // getNotifications for the UUID-sentinel rationale.
  if (requester.role !== 'ADMIN' && orClauses.length === 0) {
    return { markedCount: 0 };
  }

  const where: Prisma.AuditLogWhereInput =
    requester.role === 'ADMIN'
      ? { action: { in: RELEVANT_ACTIONS } }
      : { AND: [{ action: { in: RELEVANT_ACTIONS } }, { OR: orClauses }] };

  const targets = await prisma.auditLog.findMany({
    where,
    select: { id: true },
  });
  if (targets.length === 0) return { markedCount: 0 };

  const now = new Date();
  // Bulk upsert — Prisma has no createMany-with-onConflict, so do it as
  // create-many for missing + update-many for existing in two passes.
  const existing = await prisma.notificationState.findMany({
    where: {
      userId: requester.id,
      auditLogId: { in: targets.map((t) => t.id) },
    },
    select: { auditLogId: true },
  });
  const existingIds = new Set(existing.map((e) => e.auditLogId));
  const missing = targets.filter((t) => !existingIds.has(t.id));

  if (missing.length > 0) {
    await prisma.notificationState.createMany({
      data: missing.map((t) => ({
        userId: requester.id,
        auditLogId: t.id,
        readAt: now,
      })),
    });
  }
  if (existingIds.size > 0) {
    await prisma.notificationState.updateMany({
      where: {
        userId: requester.id,
        auditLogId: { in: Array.from(existingIds) },
        readAt: null,
      },
      data: { readAt: now },
    });
  }
  return { markedCount: targets.length };
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function scopedEntityIds(requester: { id: string; role: UserRole }): Promise<{
  accountIds: string[];
  commercialChangeIds: string[];
}> {
  if (requester.role === 'ADMIN') {
    return { accountIds: [], commercialChangeIds: [] };
  }

  let ownerIds: string[];
  if (requester.role === 'SAM') {
    ownerIds = [requester.id];
  } else {
    const reports = await prisma.user.findMany({
      where: { samHeadId: requester.id },
      select: { id: true },
    });
    ownerIds = [requester.id, ...reports.map((r) => r.id)];
  }

  const accounts = await prisma.account.findMany({
    where: { samOwnerId: { in: ownerIds } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  const ccs = accountIds.length
    ? await prisma.commercialChange.findMany({
        where: { accountId: { in: accountIds } },
        select: { id: true },
      })
    : [];

  return {
    accountIds,
    commercialChangeIds: ccs.map((c) => c.id),
  };
}

type AccountSlim = {
  id: string;
  clientName: string;
  companyName: string | null;
  customerCode: string | null;
};

type CcSlim = {
  id: string;
  changeType: string;
  oldArc: { toString(): string } | number;
  newArc: { toString(): string } | number;
  account: AccountSlim | null;
};

function formatRow(args: {
  row: { id: string; entityType: string; entityId: string; action: string; payload: unknown };
  accountById: Map<string, AccountSlim>;
  ccById: Map<string, CcSlim>;
  actorName: string | null;
}): {
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  description: string;
  href: string;
  meta?: Record<string, string>;
} {
  const { row, accountById, ccById, actorName } = args;
  const account =
    row.entityType === 'Account'
      ? accountById.get(row.entityId)
      : row.entityType === 'CommercialChange'
        ? ccById.get(row.entityId)?.account ?? null
        : null;
  const cc = row.entityType === 'CommercialChange' ? ccById.get(row.entityId) : null;
  const customerName =
    account?.companyName ?? account?.clientName ?? '(unknown customer)';

  const actor = actorName ?? 'Someone';
  const code = account?.customerCode ?? null;

  switch (row.action) {
    case 'COMMIT': {
      const arcOld = cc ? Number(cc.oldArc) : 0;
      const arcNew = cc ? Number(cc.newArc) : 0;
      const typeLabel = cc ? labelChangeType(cc.changeType) : 'Commercial change';
      return {
        kind: 'COMMERCIAL_CHANGE_COMMITTED',
        severity: arcNew >= arcOld ? 'success' : 'warning',
        title: `${typeLabel} on ${customerName}`,
        description: `${actor} committed ${typeLabel.toLowerCase()} · ₹${arcOld.toLocaleString('en-IN')} → ₹${arcNew.toLocaleString('en-IN')}`,
        href: `/transactions`,
        meta: code ? { code } : undefined,
      };
    }

    case 'ASSIGN':
      return {
        kind: 'CUSTOMER_ASSIGNED',
        severity: 'info',
        title: `Customer assigned: ${customerName}`,
        description: `${actor} assigned this customer to a SAM.`,
        href: `/customers`,
        meta: code ? { code } : undefined,
      };

    case 'UNASSIGN':
      return {
        kind: 'CUSTOMER_UNASSIGNED',
        severity: 'warning',
        title: `Customer unassigned: ${customerName}`,
        description: `${actor} removed the SAM owner — this customer is now in the triage queue.`,
        href: `/customers?owner=unassigned`,
        meta: code ? { code } : undefined,
      };

    case 'NOTIFY_CUSTOMER_ASSIGNED':
      return {
        kind: 'CUSTOMER_ASSIGNED',
        severity: 'info',
        title: `New customer to manage: ${customerName}`,
        description: `${actor} assigned this customer to you. Schedule a kickoff meeting.`,
        href: `/customers`,
        meta: code ? { code } : undefined,
      };

    case 'NOTIFY_CUSTOMER_ACTIVATED':
      return {
        kind: 'CUSTOMER_ACTIVATED',
        severity: 'warning',
        title: `New customer in triage: ${customerName}`,
        description: 'A new customer has been activated from CRM and is awaiting SAM assignment.',
        href: `/customers?owner=unassigned`,
        meta: code ? { code } : undefined,
      };

    case 'NOTIFY_ACCOUNTS_TEAM': {
      const outcome = pickPayloadString(row.payload, 'outcome') ?? 'PROCESSED';
      return {
        kind: 'ACCOUNTS_TEAM_NOTIFIED',
        severity: outcome === 'SENT' ? 'success' : outcome === 'FAILED' ? 'critical' : 'info',
        title: `Accounts team notified · ${customerName}`,
        description:
          outcome === 'SENT'
            ? `${actor}'s commercial change was forwarded to the accounts team.`
            : `Notification ${outcome.toLowerCase()} — see audit log for details.`,
        href: `/transactions`,
        meta: { outcome },
      };
    }

    case 'NOTIFY_CRM_PENDING_SAM_ACTIVATION':
      return {
        kind: 'CRM_ACTIVATION_PENDING',
        severity: 'critical',
        title: `Set activation date · ${customerName}`,
        description:
          'CRM has finished its review and needs the customer-confirmed billing-start date from you.',
        href: `/transactions`,
        meta: code ? { code } : undefined,
      };

    case 'NOTIFY_CRM_COMPLETED':
      return {
        kind: 'CRM_COMPLETED',
        severity: 'success',
        title: `CRM order completed · ${customerName}`,
        description:
          'CRM has finalised this commercial change. Account ARC and bandwidth now reflect the new state.',
        href: `/transactions`,
        meta: code ? { code } : undefined,
      };

    default:
      return {
        kind: 'OTHER',
        severity: 'info',
        title: row.action.replace(/_/g, ' ').toLowerCase(),
        description: `${actor} performed ${row.action} on ${customerName}.`,
        href: `/audit?entityId=${row.entityId}`,
      };
  }
}

function labelChangeType(t: string): string {
  switch (t) {
    case 'UPGRADE':
      return 'Upgrade';
    case 'DOWNGRADE':
      return 'Downgrade';
    case 'RATE_REVISION':
      return 'Rate revision';
    case 'DISCONNECTION':
      return 'Disconnection';
    default:
      return 'Commercial change';
  }
}

function pickPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}
