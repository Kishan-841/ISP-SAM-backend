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
