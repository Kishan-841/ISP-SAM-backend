import { Router } from 'express';
import { probableChurnController } from './probable-churn.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const probableChurnRouter = Router();
probableChurnRouter.use(requireAuth);
probableChurnRouter.get('/', probableChurnController.list);
