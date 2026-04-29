import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { signSessionToken, SESSION_COOKIE } from '../src/lib/jwt.js';
import { requireAuth, requireRole } from '../src/modules/auth/auth.middleware.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

function makeApp() {
  const app = express();
  app.use(cookieParser());
  app.get('/private', requireAuth, (req, res) => {
    res.json({ user: (req as any).user });
  });
  app.get('/admin-only', requireAuth, requireRole('ADMIN'), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireAuth', () => {
  it('returns 401 when cookie is missing', async () => {
    const res = await request(makeApp()).get('/private');
    expect(res.status).toBe(401);
  });

  it('returns 401 when cookie is malformed', async () => {
    const res = await request(makeApp()).get('/private').set('Cookie', `${SESSION_COOKIE}=garbage`);
    expect(res.status).toBe(401);
  });

  it('attaches req.user when cookie is valid', async () => {
    const token = await signSessionToken({ sub: 'user-42', role: 'SAM' });
    const res = await request(makeApp())
      .get('/private')
      .set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 'user-42', role: 'SAM' });
  });
});

describe('requireRole', () => {
  it('returns 403 when role is not allowed', async () => {
    const token = await signSessionToken({ sub: 'u', role: 'SAM' });
    const res = await request(makeApp()).get('/admin-only').set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(403);
  });

  it('passes through when role matches', async () => {
    const token = await signSessionToken({ sub: 'u', role: 'ADMIN' });
    const res = await request(makeApp()).get('/admin-only').set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(200);
  });
});
