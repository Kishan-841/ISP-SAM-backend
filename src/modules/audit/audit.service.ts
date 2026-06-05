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

  /**
   * Move audit_logs rows older than the cutoff into `audit_logs_archive`.
   * Runs inside a transaction: copy → delete. If either fails, both roll
   * back. Returns the count moved.
   *
   * The DELETE cascade through notification_states (FK with onDelete:
   * Cascade) drops the per-user read/dismissed overlay for archived
   * rows, which is intended — those notifications won't be displayed
   * once the audit row is moved to cold storage.
   *
   * Batch limit prevents one massive archive run from holding a long-
   * lived lock. If `total > batchSize`, the call moves `batchSize` rows
   * (oldest first) and reports how many remain so the caller can
   * iterate.
   */
  async archiveOlderThan(opts: {
    cutoff: Date;
    batchSize?: number;
  }): Promise<{ moved: number; remaining: number; cutoff: string }> {
    const batchSize = Math.max(1, Math.min(10_000, opts.batchSize ?? 5_000));
    const cutoff = opts.cutoff;

    // Snapshot the ids we'll move in this batch — pre-selecting keeps the
    // transaction's working set bounded and lets us report `remaining`
    // honestly without re-counting after the delete cascade.
    const batch = await prisma.auditLog.findMany({
      where: { timestamp: { lt: cutoff } },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      take: batchSize,
      select: { id: true },
    });
    const ids = batch.map((r) => r.id);
    if (ids.length === 0) {
      return { moved: 0, remaining: 0, cutoff: cutoff.toISOString() };
    }

    await prisma.$transaction(async (tx) => {
      // Copy to archive. Using raw SQL because Prisma's createMany doesn't
      // support `INSERT INTO ... SELECT FROM ...`, and we want a single
      // server-side copy rather than a roundtrip per row. Each id is cast
      // ::uuid explicitly — Postgres doesn't implicitly coerce text → uuid.
      const uuidValues = Prisma.join(
        ids.map((id) => Prisma.sql`${id}::uuid`),
      );
      await tx.$executeRaw`
        INSERT INTO audit_logs_archive
          (id, entity_type, entity_id, action, performed_by, ip_address, user_agent, payload, timestamp)
        SELECT
          id, entity_type, entity_id, action, performed_by, ip_address, user_agent, payload, timestamp
        FROM audit_logs
        WHERE id IN (${uuidValues})
      `;
      // Delete from the live table. CASCADE on notification_states.audit_log_id
      // cleans up the per-user overlay automatically.
      await tx.auditLog.deleteMany({ where: { id: { in: ids } } });
    });

    const remaining = await prisma.auditLog.count({
      where: { timestamp: { lt: cutoff } },
    });

    return { moved: ids.length, remaining, cutoff: cutoff.toISOString() };
  },
};
