import { Router } from 'express';
import { sidebarController } from './sidebar.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const sidebarRouter = Router();
sidebarRouter.use(requireAuth);
sidebarRouter.get('/counts', sidebarController.counts);
