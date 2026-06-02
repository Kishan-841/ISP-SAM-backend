import type { Request, Response } from 'express';
import { z } from 'zod';
import { authService } from './auth.service.js';
import { signSessionToken, SESSION_COOKIE } from '../../lib/jwt.js';
import { prisma } from '../../prisma.js';
import { writeAudit } from '../../lib/audit.js';

const loginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  password: z.string().min(1),
});

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function publicUser(user: { id: string; email: string; name: string; role: string }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// Stable nil-uuid used as `entityId` for pre-auth events (LOGIN_FAILED
// when the typed email doesn't match any account). `entityId` is
// required on AuditLog rows, so we need a placeholder.
const SYSTEM_ENTITY_ID = '00000000-0000-0000-0000-000000000000';

export const authController = {
  async login(req: Request, res: Response) {
    const parse = loginSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    const user = await authService.validateCredentials(parse.data.email, parse.data.password);
    if (!user) {
      await writeAudit({
        entityType: 'User',
        entityId: SYSTEM_ENTITY_ID,
        action: 'LOGIN_FAILED',
        performedBy: null,
        payload: { emailAttempted: parse.data.email, reason: 'Invalid email or password' },
        req,
      });
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    const token = await signSessionToken({ sub: user.id, role: user.role });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ONE_WEEK_MS,
      path: '/',
    });
    await writeAudit({
      entityType: 'User',
      entityId: user.id,
      action: 'LOGIN',
      performedBy: user.id,
      payload: { email: user.email, role: user.role },
      req,
    });
    res.json({ user: publicUser(user) });
  },

  async logout(req: Request, res: Response) {
    const reqUser = (req as Request & { user?: { id: string } }).user;
    res.cookie(SESSION_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    if (reqUser?.id) {
      await writeAudit({
        entityType: 'User',
        entityId: reqUser.id,
        action: 'LOGOUT',
        performedBy: reqUser.id,
        req,
      });
    }
    res.json({ ok: true });
  },

  async me(req: Request, res: Response) {
    const reqUser = (req as Request & { user?: { id: string } }).user;
    if (!reqUser) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: reqUser.id } });
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    res.json({ user: publicUser(user) });
  },
};
