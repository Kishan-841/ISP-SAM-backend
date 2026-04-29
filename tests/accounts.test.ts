import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedAccount } from './helpers/db.js';

beforeEach(async () => {
  await resetDb();
});

describe('GET /accounts', () => {
  it('returns empty list when no accounts', async () => {
    const res = await request(app).get('/accounts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: [] });
  });

  it('returns all accounts', async () => {
    await seedAccount({ clientName: 'Acme' });
    await seedAccount({ clientName: 'Globex', kittyType: 'NEW', onboardingDate: new Date('2026-04-15') });
    const res = await request(app).get('/accounts');
    expect(res.body.accounts).toHaveLength(2);
    const names = res.body.accounts.map((a: { clientName: string }) => a.clientName).sort();
    expect(names).toEqual(['Acme', 'Globex']);
  });

  it('filters by kittyType', async () => {
    await seedAccount({ clientName: 'Old', kittyType: 'BASE' });
    await seedAccount({ clientName: 'Fresh', kittyType: 'NEW', onboardingDate: new Date('2026-04-15') });
    const res = await request(app).get('/accounts?kittyType=NEW');
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].clientName).toBe('Fresh');
  });
});

describe('GET /accounts/:id', () => {
  it('returns 404 when account does not exist', async () => {
    const res = await request(app).get('/accounts/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns the account when it exists', async () => {
    const created = await seedAccount({ clientName: 'Found' });
    const res = await request(app).get(`/accounts/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.account.clientName).toBe('Found');
  });
});
