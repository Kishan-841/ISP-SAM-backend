import { Router } from 'express';
import { authController } from './auth.controller.js';
import { optionalAuth, requireAuth } from './auth.middleware.js';

export const authRouter = Router();
authRouter.post('/login', authController.login);
// Soft auth so we can audit *who* logged out — but never block a logout
// (already-expired sessions should still clear the cookie cleanly).
authRouter.post('/logout', optionalAuth, authController.logout);
authRouter.get('/me', requireAuth, authController.me);
