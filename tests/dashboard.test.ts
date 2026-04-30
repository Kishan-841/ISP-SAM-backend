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

describe('GET /dashboard/existing-base', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/dashboard/existing-base');
    expect(res.status).toBe(401);
  });

  it('returns zeros when no accounts exist', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.status).toBe(200);
    expect(res.body.totalCustomers).toBe(0);
    expect(res.body.totalBaseArcLakh).toBe(0);
    expect(res.body.currentCustomers).toBe(0);
    expect(res.body.currentArcLakh).toBe(0);
  });

  it('aggregates BASE accounts correctly (8 customers, 76L ARC)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    // 8 BASE accounts, average ₹79,166/month → ₹6.33L total MRR → ₹76L ARC
    for (let i = 0; i < 8; i++) {
      await seedAccount({ kittyType: 'BASE', currentMrr: 79166.67, contractStatus: 'ACTIVE' });
    }
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.totalCustomers).toBe(8);
    expect(res.body.totalBaseArcLakh).toBeCloseTo(76, 0); // ~76L
    expect(res.body.currentCustomers).toBe(8);
    expect(res.body.currentArcLakh).toBeCloseTo(76, 0);
  });

  it('excludes NEW kitty accounts from BASE totals', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    await seedAccount({ kittyType: 'BASE', currentMrr: 100000 });
    await seedAccount({ kittyType: 'NEW', currentMrr: 500000, onboardingDate: new Date('2026-04-15') });
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.totalCustomers).toBe(1);
    expect(res.body.totalBaseArcLakh).toBe(12); // 100000 * 12 / 100000 = 12L
  });

  it('drops terminated BASE accounts from current totals', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    await seedAccount({ kittyType: 'BASE', currentMrr: 100000, contractStatus: 'ACTIVE' });
    await seedAccount({ kittyType: 'BASE', currentMrr: 100000, contractStatus: 'TERMINATED' });
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.totalCustomers).toBe(2);          // both counted in start-of-period
    expect(res.body.currentCustomers).toBe(1);        // only the non-terminated one is current
    expect(res.body.totalBaseArcLakh).toBe(24);       // both counted (start)
    expect(res.body.currentArcLakh).toBe(12);         // only the active one
    expect(res.body.terminatedCount).toBe(1);
  });
});
