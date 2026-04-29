import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedUser } from './helpers/db.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
});

describe('POST /auth/login', () => {
  it('returns 401 on wrong password', async () => {
    await seedUser({ email: 'a@b.com', password: 'right' });
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid body', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('returns 200 + user + Set-Cookie on success', async () => {
    await seedUser({ email: 'a@b.com', name: 'Alice', role: 'ADMIN', password: 'pw' });
    const res = await request(app).post('/auth/login').send({ email: 'a@b.com', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('a@b.com');
    expect(res.body.user.role).toBe('ADMIN');
    expect(res.body.user.passwordHash).toBeUndefined();
    const setCookie = res.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
  });
});

describe('GET /auth/me', () => {
  it('returns 401 without cookie', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user with valid cookie', async () => {
    const user = await seedUser({ email: 'a@b.com', password: 'pw' });
    const login = await request(app).post('/auth/login').send({ email: 'a@b.com', password: 'pw' });
    const cookie = login.headers['set-cookie']?.[0] ?? '';
    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });
});

describe('POST /auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=;`);
  });
});
