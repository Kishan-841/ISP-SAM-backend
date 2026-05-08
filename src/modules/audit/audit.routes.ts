import { Router } from 'express';
import { auditController } from './audit.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('ADMIN', 'SAM_HEAD'));
auditRouter.get('/', auditController.list);
