import { Router } from 'express';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { authController } from './auth.controller.js';
import { optionalAuth, requireAuth } from './auth.middleware.js';

/**
 * Brute-force guard on /auth/login. Keyed on `ip + email` so a shared
 * gateway IP (e.g. one office NAT) doesn't lock out every user when a
 * single bad actor tries garbage. 5 attempts per 15 minutes is enough
 * headroom for a typo-prone user but stops password-spraying cold.
 *
 * Hits the LOGIN_FAILED audit log via authController BEFORE this gate
 * trips — so legitimate "wrong password" attempts still produce
 * forensic trail before the lock kicks in.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : '';
    return `${req.ip ?? 'anon'}:${email}`;
  },
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

export const authRouter = Router();
authRouter.post('/login', loginLimiter, authController.login);
// Soft auth so we can audit *who* logged out — but never block a logout
// (already-expired sessions should still clear the cookie cleanly).
authRouter.post('/logout', optionalAuth, authController.logout);
authRouter.get('/me', requireAuth, authController.me);
