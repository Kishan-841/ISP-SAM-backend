import { Router } from 'express';
import { meetingsController } from './meetings.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const meetingsRouter = Router();
meetingsRouter.use(requireAuth);
meetingsRouter.post('/', meetingsController.log);
meetingsRouter.post('/send-mom-email', meetingsController.sendMomEmail);
meetingsRouter.get('/', meetingsController.list);
meetingsRouter.get('/:id', meetingsController.getById);
meetingsRouter.post('/:id/held', meetingsController.markHeld);
meetingsRouter.post('/:id/mom', meetingsController.submitMom);
meetingsRouter.post('/:id/send-mom-email', meetingsController.completeMeeting);
meetingsRouter.delete('/:id', requireRole('ADMIN'), meetingsController.remove);
