import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor, authedGet } from './helpers/auth.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
});

describe('GET /accounts', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/accounts');
    expect(res.status).toBe(401);
  });

  it('returns empty list when no accounts (admin authed)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/accounts', token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: [] });
  });

  it('returns all accounts to ADMIN', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    await seedAccount({ clientName: 'Acme' });
    await seedAccount({ clientName: 'Globex', kittyType: 'NEW', onboardingDate: new Date('2026-04-15') });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/accounts', token);
    expect(res.body.accounts).toHaveLength(2);
  });

  it('returns all accounts to SAM_HEAD', async () => {
    const head = await seedUser({ email: 'head@x.com', role: 'SAM_HEAD' });
    await seedAccount({ clientName: 'A' });
    await seedAccount({ clientName: 'B' });
    const token = await tokenFor(head.id, 'SAM_HEAD');
    const res = await authedGet(app, '/accounts', token);
    expect(res.body.accounts).toHaveLength(2);
  });

  it('returns ONLY own accounts to SAM', async () => {
    const sam1 = await seedUser({ email: 'sam1@x.com', role: 'SAM' });
    const sam2 = await seedUser({ email: 'sam2@x.com', role: 'SAM' });
    await seedAccount({ clientName: 'mine', samOwnerId: sam1.id });
    await seedAccount({ clientName: 'theirs', samOwnerId: sam2.id });
    await seedAccount({ clientName: 'unowned' });
    const token = await tokenFor(sam1.id, 'SAM');
    const res = await authedGet(app, '/accounts', token);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].clientName).toBe('mine');
  });

  it('filters by kittyType (admin)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    await seedAccount({ clientName: 'Old', kittyType: 'BASE' });
    await seedAccount({ clientName: 'Fresh', kittyType: 'NEW', onboardingDate: new Date('2026-04-15') });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/accounts?kittyType=NEW', token);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].clientName).toBe('Fresh');
  });
});

describe('GET /accounts/:id', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/accounts/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });

  it('returns 404 when account does not exist (admin authed)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/accounts/00000000-0000-0000-0000-000000000000', token);
    expect(res.status).toBe(404);
  });

  it('returns the account when admin requests it', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const created = await seedAccount({ clientName: 'Found' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, `/accounts/${created.id}`, token);
    expect(res.status).toBe(200);
    expect(res.body.account.clientName).toBe('Found');
  });

  it('returns 404 when SAM requests an account they do not own', async () => {
    const sam = await seedUser({ email: 'sam@x.com', role: 'SAM' });
    const other = await seedUser({ email: 'other@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'theirs', samOwnerId: other.id });
    const token = await tokenFor(sam.id, 'SAM');
    const res = await authedGet(app, `/accounts/${acct.id}`, token);
    expect(res.status).toBe(404);
  });
});
