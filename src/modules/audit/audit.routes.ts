import { Router } from 'express';
import { auditController } from './audit.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('ADMIN', 'SAM_HEAD'));
auditRouter.get('/', auditController.list);

// ADMIN-only archive operation. Moves rows older than the cutoff into
// `audit_logs_archive`. Returns the count moved + how many remain for
// the next batch. Idempotent — re-running with the same cutoff is safe.
auditRouter.post('/archive', requireRole('ADMIN'), auditController.archive);
