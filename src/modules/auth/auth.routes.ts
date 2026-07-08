import { Router } from 'express';
import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { authController } from './auth.controller.js';
import { optionalAuth, requireAuth } from './auth.middleware.js';

/**
 * Brute-force guard on /auth/login. Keyed on `ip + email` so a shared
 * gateway IP (e.g. one office NAT) doesn't lock out every user when a
 * single bad actor tries garbage. 5 attempts per 15 minutes is enough
 * headroom for a typo-prone user but stops password-spraying cold.
 *
 * `ipKeyGenerator` normalises IPv6 addresses to a /56 block, preventing
 * trivial bypass via a single IPv6-cycling attacker.
 *
 * The LOGIN_FAILED audit log fires inside authController BEFORE this
 * gate trips, so legitimate "wrong password" attempts still leave a
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
    return `${ipKeyGenerator(req.ip ?? '')}:${email}`;
  },
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

/**
 * Guard on /auth/change-password. The route uses optionalAuth, so we key on
 * the authenticated user id when signed-in (in-app change) or on `ip + email`
 * when signed-out (login-page modal) — same shape as the login limiter. Either
 * way it stops the current-password check from being brute-forced.
 */
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const uid = (req as Request & { user?: { id: string } }).user?.id;
    if (uid) return `pwchange:${uid}`;
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return `pwchange:${ipKeyGenerator(req.ip ?? '')}:${email}`;
  },
  message: { error: 'Too many password-change attempts. Try again in 15 minutes.' },
});

export const authRouter = Router();
authRouter.post('/login', loginLimiter, authController.login);
// optionalAuth (not requireAuth): the in-app page uses the session; the
// login-page modal identifies the account by email + current password.
authRouter.post(
  '/change-password',
  optionalAuth,
  changePasswordLimiter,
  authController.changePassword,
);
// Soft auth so we can audit *who* logged out — but never block a logout
// (already-expired sessions should still clear the cookie cleanly).
authRouter.post('/logout', optionalAuth, authController.logout);
authRouter.get('/me', requireAuth, authController.me);
