import type { Request, Response } from 'express';
import { z } from 'zod';
import { authService } from './auth.service.js';
import { signSessionToken, SESSION_COOKIE } from '../../lib/jwt.js';
import { prisma } from '../../prisma.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function publicUser(user: { id: string; email: string; name: string; role: string }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export const authController = {
  async login(req: Request, res: Response) {
    const parse = loginSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    const user = await authService.validateCredentials(parse.data.email, parse.data.password);
    if (!user) {
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
    res.json({ user: publicUser(user) });
  },

  async logout(_req: Request, res: Response) {
    res.cookie(SESSION_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
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
