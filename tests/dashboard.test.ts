import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor, authedGet } from './helpers/auth.js';
import { prisma } from '../src/prisma.js';

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
    // 8 BASE accounts at ₹9.5L ARC each → ₹76L total ARC
    for (let i = 0; i < 8; i++) {
      await seedAccount({ kittyType: 'BASE', currentArc: 950000, contractStatus: 'ACTIVE' });
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
    await seedAccount({ kittyType: 'BASE', currentArc: 1200000 });
    await seedAccount({ kittyType: 'NEW', currentArc: 6000000, onboardingDate: new Date('2026-04-15') });
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.totalCustomers).toBe(1);
    expect(res.body.totalBaseArcLakh).toBe(12); // 1200000 / 100000 = 12L
  });

  it('drops terminated BASE accounts from current totals', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    await seedAccount({ kittyType: 'BASE', currentArc: 1200000, contractStatus: 'ACTIVE' });
    await seedAccount({ kittyType: 'BASE', currentArc: 1200000, contractStatus: 'TERMINATED' });
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.totalCustomers).toBe(2);          // both counted in start-of-period
    expect(res.body.currentCustomers).toBe(1);        // only the non-terminated one is current
    expect(res.body.totalBaseArcLakh).toBe(24);       // both counted (start)
    expect(res.body.currentArcLakh).toBe(12);         // only the active one
    expect(res.body.terminatedCount).toBe(1);
  });
});

describe('GET /dashboard/existing-base — waterfall aggregation', () => {
  it('aggregates UPGRADE: 1 count, ARC added', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({
      kittyType: 'BASE',
      currentArc: 720000,
      startOfPeriodArc: 600000,
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldArc: 600000,
        newArc: 720000,
        effectiveDate: new Date('2026-04-15'),
        clientApprovalAttached: true,
        createdBy: admin.id,
      },
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.upgrades.count).toBe(1);
    // 720000 - 600000 = 120000 = 1.2L
    expect(res.body.upgrades.arcAddedLakh).toBeCloseTo(1.2, 1);
  });

  it('aggregates DOWNGRADE as positive ARC reduced magnitude', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({
      kittyType: 'BASE',
      currentArc: 480000,
      startOfPeriodArc: 600000,
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'DOWNGRADE',
        oldArc: 600000,
        newArc: 480000,
        effectiveDate: new Date('2026-04-15'),
        clientApprovalAttached: true,
        createdBy: admin.id,
      },
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.downgrades.count).toBe(1);
    // 600000 - 480000 = 120000 = 1.2L
    expect(res.body.downgrades.arcReducedLakh).toBeCloseTo(1.2, 1);
  });

  it('aggregates DISCONNECTION as full ARC lost', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({
      kittyType: 'BASE',
      currentArc: 0,
      startOfPeriodArc: 1200000,
      contractStatus: 'TERMINATED',
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'DISCONNECTION',
        oldArc: 1200000,
        newArc: 0,
        effectiveDate: new Date('2026-04-15'),
        clientApprovalAttached: true,
        createdBy: admin.id,
      },
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.terminations.count).toBe(1);
    // 1200000 = 12L
    expect(res.body.terminations.arcLostLakh).toBeCloseTo(12, 0);
  });

  it('aggregates RATE_REVISION', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({
      kittyType: 'BASE',
      currentArc: 576000,
      startOfPeriodArc: 600000,
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'RATE_REVISION',
        oldArc: 600000,
        newArc: 576000,
        effectiveDate: new Date('2026-04-15'),
        clientApprovalAttached: true,
        createdBy: admin.id,
      },
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.rateRevisions.count).toBe(1);
    // 600000 - 576000 = 24000 = 0.24L → rounded to 1 decimal = 0.2L
    expect(res.body.rateRevisions.arcChangeLakh).toBeCloseTo(0.2, 1);
  });

  it('ignores commercial changes against NEW kitty accounts (Existing Base only)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const newAcct = await seedAccount({
      kittyType: 'NEW',
      currentArc: 720000,
      startOfPeriodArc: 600000,
      onboardingDate: new Date('2026-04-15'),
    });
    await prisma.commercialChange.create({
      data: {
        accountId: newAcct.id,
        changeType: 'UPGRADE',
        oldArc: 600000,
        newArc: 720000,
        effectiveDate: new Date('2026-04-20'),
        clientApprovalAttached: true,
        createdBy: admin.id,
      },
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.upgrades.count).toBe(0);
    expect(res.body.upgrades.arcAddedLakh).toBe(0);
  });

  it('totalBaseArcLakh now reads from startOfPeriodArc (not currentArc)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    // Account was onboarded at ARC 6L, then upgraded to 7.2L.
    await seedAccount({
      kittyType: 'BASE',
      currentArc: 720000,
      startOfPeriodArc: 600000,
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/existing-base', token);
    // Start-of-period ARC reflects the original 6L baseline, not the 7.2L current.
    expect(res.body.totalBaseArcLakh).toBeCloseTo(6, 1);
    // Current ARC reflects the 7.2L post-upgrade.
    expect(res.body.currentArcLakh).toBeCloseTo(7.2, 1);
  });
});

describe('GET /dashboard/existing-base — quarter filter', () => {
  async function seedAcctWithChange(opts: {
    admin: { id: string };
    changeType: 'UPGRADE' | 'DOWNGRADE' | 'RATE_REVISION' | 'DISCONNECTION';
    effectiveDate: Date;
    oldArc?: number;
    newArc?: number;
  }) {
    const oldArc = opts.oldArc ?? 600000;
    const newArc = opts.newArc ?? 720000;
    const acct = await seedAccount({
      kittyType: 'BASE',
      currentArc: newArc,
      startOfPeriodArc: oldArc,
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: opts.changeType,
        oldArc,
        newArc,
        effectiveDate: opts.effectiveDate,
        clientApprovalAttached: true,
        createdBy: opts.admin.id,
      },
    });
    return acct;
  }

  it('Q1 filter only counts changes effective Apr–Jun', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    // Q1 upgrade
    await seedAcctWithChange({ admin, changeType: 'UPGRADE', effectiveDate: new Date('2026-05-15') });
    // Q3 upgrade — must not appear under Q1
    await seedAcctWithChange({ admin, changeType: 'UPGRADE', effectiveDate: new Date('2026-11-15'), oldArc: 840000, newArc: 1080000 });

    const q1 = await authedGet(app, '/dashboard/existing-base?quarter=Q1', token);
    expect(q1.body.upgrades.count).toBe(1);
    expect(q1.body.upgrades.arcAddedLakh).toBeCloseTo(1.2, 1);

    const q3 = await authedGet(app, '/dashboard/existing-base?quarter=Q3', token);
    expect(q3.body.upgrades.count).toBe(1);
    // 1080000 - 840000 = 240000 = 2.4L
    expect(q3.body.upgrades.arcAddedLakh).toBeCloseTo(2.4, 1);

    const q2 = await authedGet(app, '/dashboard/existing-base?quarter=Q2', token);
    expect(q2.body.upgrades.count).toBe(0);
  });

  it('All Time (no filter) sums every change across the FY', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    await seedAcctWithChange({ admin, changeType: 'UPGRADE', effectiveDate: new Date('2026-05-15') });
    await seedAcctWithChange({ admin, changeType: 'UPGRADE', effectiveDate: new Date('2026-11-15'), oldArc: 840000, newArc: 1080000 });

    const res = await authedGet(app, '/dashboard/existing-base', token);
    expect(res.body.upgrades.count).toBe(2);
    // 1.2L + 2.4L = 3.6L
    expect(res.body.upgrades.arcAddedLakh).toBeCloseTo(3.6, 1);
  });

  it('Quarter filter projects current ARC = start + window deltas', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    await seedAcctWithChange({ admin, changeType: 'UPGRADE', effectiveDate: new Date('2026-05-15') });
    // Q1 view: start = 6L; +1.2L upgrade → currentArc = 7.2L
    const q1 = await authedGet(app, '/dashboard/existing-base?quarter=Q1', token);
    expect(q1.body.totalBaseArcLakh).toBeCloseTo(6, 1);
    expect(q1.body.currentArcLakh).toBeCloseTo(7.2, 1);
    // Q2 view: same start, no Q2 deltas → currentArc collapses back to start
    const q2 = await authedGet(app, '/dashboard/existing-base?quarter=Q2', token);
    expect(q2.body.totalBaseArcLakh).toBeCloseTo(6, 1);
    expect(q2.body.currentArcLakh).toBeCloseTo(6, 1);
  });

  it('rejects invalid quarter param silently (treats as All Time)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    await seedAcctWithChange({ admin, changeType: 'UPGRADE', effectiveDate: new Date('2026-05-15') });

    const res = await authedGet(app, '/dashboard/existing-base?quarter=Q9', token);
    expect(res.status).toBe(200);
    expect(res.body.upgrades.count).toBe(1); // counted because filter ignored
  });
});
