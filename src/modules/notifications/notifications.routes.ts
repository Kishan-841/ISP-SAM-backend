import { Router } from 'express';
import { notificationsController } from './notifications.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.get('/', notificationsController.list);
notificationsRouter.get('/unread-count', notificationsController.unreadCount);
notificationsRouter.post('/mark-all-read', notificationsController.markAll);
notificationsRouter.post('/:id/read', notificationsController.markRead);
notificationsRouter.post('/:id/dismiss', notificationsController.dismiss);
