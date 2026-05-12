import { Router } from 'express';
import { usersController } from './users.controller.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';

export const usersRouter = Router();

usersRouter.get('/', requireAuth, requireRole('ADMIN', 'SAM_HEAD'), usersController.list);
usersRouter.get('/team', requireAuth, requireRole('ADMIN', 'SAM_HEAD'), usersController.team);
usersRouter.get('/:id', requireAuth, requireRole('ADMIN', 'SAM_HEAD'), usersController.getById);
usersRouter.post('/', requireAuth, requireRole('ADMIN'), usersController.create);
usersRouter.patch('/:id', requireAuth, requireRole('ADMIN'), usersController.update);
usersRouter.delete('/:id', requireAuth, requireRole('ADMIN'), usersController.remove);
