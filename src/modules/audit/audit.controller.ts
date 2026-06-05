import type { Response } from 'express';
import { z } from 'zod';
import type { AuthedRequest } from '../auth/auth.middleware.js';
import { auditService } from './audit.service.js';

const archiveSchema = z.object({
  /** Cutoff date as ISO string; rows with timestamp < this go to archive. */
  cutoff: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid cutoff date'),
  /** Hard cap on rows moved per call to avoid one giant transaction. */
  batchSize: z.number().int().min(1).max(10_000).optional(),
});

const archiveByMonthsSchema = z.object({
  /** Convenience param: "archive rows older than N months from now". */
  months: z.number().int().min(1).max(60).optional().default(12),
  batchSize: z.number().int().min(1).max(10_000).optional(),
});

export const auditController = {
  async list(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const q = req.query;
    const data = await auditService.list({
      entityType: typeof q.entityType === 'string' ? q.entityType : undefined,
      entityId: typeof q.entityId === 'string' ? q.entityId : undefined,
      performedBy: typeof q.performedBy === 'string' ? q.performedBy : undefined,
      action: typeof q.action === 'string' ? q.action : undefined,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
    res.json(data);
  },

  /**
   * POST /audit-logs/archive (ADMIN)
   *
   * Body shapes (either is accepted):
   *   { months: 12, batchSize?: 5000 }  — archive everything older than
   *                                       N months from now (default 12)
   *   { cutoff: '2025-06-01T00:00:00Z', batchSize?: 5000 }  — explicit
   *
   * Returns { moved, remaining, cutoff }. `remaining > 0` means another
   * call is needed to drain the queue. Designed to be runnable from cron
   * or curl — there's no UI consumer right now.
   */
  async archive(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }

    // Try the explicit-cutoff shape first; fall back to months.
    const explicit = archiveSchema.safeParse(req.body);
    if (explicit.success) {
      const result = await auditService.archiveOlderThan({
        cutoff: new Date(explicit.data.cutoff),
        batchSize: explicit.data.batchSize,
      });
      res.json(result);
      return;
    }

    const byMonths = archiveByMonthsSchema.safeParse(req.body);
    if (!byMonths.success) {
      res.status(400).json({
        error:
          byMonths.error.issues[0]?.message ??
          'Provide either { months } or { cutoff: ISO }',
      });
      return;
    }
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - byMonths.data.months);
    const result = await auditService.archiveOlderThan({
      cutoff,
      batchSize: byMonths.data.batchSize,
    });
    res.json(result);
  },
};
