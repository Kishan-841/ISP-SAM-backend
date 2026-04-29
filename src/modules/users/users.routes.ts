import { Router } from 'express';
import { usersController } from './users.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const usersRouter = Router();

usersRouter.get('/', requireAuth, requireRole('ADMIN', 'SAM_HEAD'), usersController.list);
usersRouter.get('/:id', requireAuth, requireRole('ADMIN', 'SAM_HEAD'), usersController.getById);
usersRouter.post('/', requireAuth, requireRole('ADMIN'), usersController.create);
