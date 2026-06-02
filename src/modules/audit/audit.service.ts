import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';

export type AuditEntry = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  performedBy: string | null;
  performer: { id: string; name: string; email: string; role: string } | null;
  ipAddress: string | null;
  userAgent: string | null;
  payload: unknown;
  timestamp: Date;
};

export const auditService = {
  async list(opts: {
    entityType?: string;
    entityId?: string;
    performedBy?: string;
    action?: string;
    page?: number;
    pageSize?: number;
  } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
    const where: Prisma.AuditLogWhereInput = {};
    if (opts.entityType) where.entityType = opts.entityType;
    if (opts.entityId) where.entityId = opts.entityId;
    if (opts.performedBy) where.performedBy = opts.performedBy;
    if (opts.action) where.action = opts.action;

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // Hydrate performer info in one query — `performed_by` is just a uuid
    // and we want to display name/email in the UI. Skip nulls
    // (LOGIN_FAILED etc. have no user yet).
    const performerIds = Array.from(
      new Set(rows.map((r) => r.performedBy).filter((p): p is string => !!p)),
    );
    const performers = performerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: performerIds } },
          select: { id: true, name: true, email: true, role: true },
        })
      : [];
    const byId = new Map(performers.map((u) => [u.id, u]));

    const entries: AuditEntry[] = rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      action: r.action,
      performedBy: r.performedBy,
      performer: r.performedBy ? byId.get(r.performedBy) ?? null : null,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      payload: r.payload,
      timestamp: r.timestamp,
    }));

    return { entries, total, page, pageSize };
  },
};
