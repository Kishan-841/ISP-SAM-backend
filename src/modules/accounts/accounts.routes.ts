import { Router } from 'express';
import { accountsController } from './accounts.controller.js';

export const accountsRouter = Router();
accountsRouter.get('/', accountsController.list);
accountsRouter.get('/:id', accountsController.getById);
