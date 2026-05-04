import { Router } from 'express';
import { dashboardController } from './dashboard.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);
dashboardRouter.get('/existing-base', dashboardController.existingBase);
dashboardRouter.get('/new-base', dashboardController.newBase);
