import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedUser } from './helpers/db.js';
import { tokenFor, authedGet, authedPost } from './helpers/auth.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
});

describe('GET /users', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/users');
    expect(res.status).toBe(401);
  });

  it('403 when SAM tries to list', async () => {
    const sam = await seedUser({ role: 'SAM' });
    const token = await tokenFor(sam.id, 'SAM');
    const res = await authedGet(app, '/users', token);
    expect(res.status).toBe(403);
  });

  it('200 with all users when ADMIN lists', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    await seedUser({ email: 'sam1@x.com', role: 'SAM' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/users', token);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users[0].passwordHash).toBeUndefined();
  });
});

describe('POST /users', () => {
  it('403 when SAM_HEAD tries to create', async () => {
    const head = await seedUser({ email: 'head@x.com', role: 'SAM_HEAD' });
    const token = await tokenFor(head.id, 'SAM_HEAD');
    const res = await authedPost(app, '/users', token).send({
      email: 'sam1@x.com', name: 'SAM 1', role: 'SAM', password: 'pw',
    });
    expect(res.status).toBe(403);
  });

  it('201 when ADMIN creates a SAM (and lowercases email)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedPost(app, '/users', token).send({
      email: 'SAM1@X.com', name: 'SAM 1', role: 'SAM', password: 'pw1234',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('sam1@x.com');
    expect(res.body.user.role).toBe('SAM');
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('409 on duplicate email (case-insensitive)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    await seedUser({ email: 'sam1@x.com', role: 'SAM' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedPost(app, '/users', token).send({
      email: 'SAM1@x.COM', name: 'Dup', role: 'SAM', password: 'pw1234',
    });
    expect(res.status).toBe(409);
  });

  it('400 on invalid body', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedPost(app, '/users', token).send({ email: 'bad', name: 'X' });
    expect(res.status).toBe(400);
  });
});
