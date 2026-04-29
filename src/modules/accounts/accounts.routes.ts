import { Router } from 'express';
import { accountsController } from './accounts.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const accountsRouter = Router();
accountsRouter.use(requireAuth);
accountsRouter.get('/', accountsController.list);
accountsRouter.get('/:id', accountsController.getById);
