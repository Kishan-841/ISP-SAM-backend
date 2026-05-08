import type { Response } from 'express';
import type { AuthedRequest } from '../auth/auth.middleware.js';
import { auditService } from './audit.service.js';

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
};
