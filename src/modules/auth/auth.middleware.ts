import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '@prisma/client';
import { verifySessionToken, SESSION_COOKIE } from '../../lib/jwt.js';

export interface AuthedRequest extends Request {
  user?: { id: string; role: UserRole };
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  try {
    const claims = await verifySessionToken(token);
    req.user = { id: claims.sub, role: claims.role };
    next();
  } catch {
    res.status(401).json({ error: 'Unauthenticated' });
  }
}

/**
 * Soft variant of `requireAuth` — populates `req.user` when a valid
 * session cookie is present, but never blocks the request. Used by
 * `/auth/logout` so we can audit who logged out without rejecting
 * already-expired sessions.
 */
export async function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) {
    next();
    return;
  }
  try {
    const claims = await verifySessionToken(token);
    req.user = { id: claims.sub, role: claims.role };
  } catch {
    // Silently ignore — soft auth shouldn't block.
  }
  next();
}

export function requireRole(...allowed: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
