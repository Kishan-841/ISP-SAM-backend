import { Router } from 'express';
import { authController } from './auth.controller.js';
import { requireAuth } from './auth.middleware.js';

export const authRouter = Router();
authRouter.post('/login', authController.login);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', requireAuth, authController.me);
