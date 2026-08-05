import { Router } from 'express';
import { dashboardController } from './dashboard.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);
dashboardRouter.get('/existing-base', dashboardController.existingBase);
dashboardRouter.get('/new-base', dashboardController.newBase);
dashboardRouter.get('/changes', dashboardController.bucketChanges);
dashboardRouter.get(
  '/team-performance',
  requireRole('ADMIN', 'SAM_HEAD'),
  dashboardController.teamPerformance,
);
dashboardRouter.get(
  '/team-performance/:samId',
  requireRole('ADMIN', 'SAM_HEAD'),
  dashboardController.samDetail,
);
dashboardRouter.get(
  '/meeting-summary',
  requireRole('ADMIN', 'SAM_HEAD', 'SUPER_ADMIN_2'),
  dashboardController.meetingSummary,
);
dashboardRouter.get('/alerts', dashboardController.alerts);
