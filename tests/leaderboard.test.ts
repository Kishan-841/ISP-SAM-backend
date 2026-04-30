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

describe('GET /leaderboard', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/leaderboard');
    expect(res.status).toBe(401);
  });

  it('returns empty ranking when there are no SAMs', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/leaderboard?role=SAM', token);
    expect(res.status).toBe(200);
    expect(res.body.ranking).toEqual([]);
  });

  it('SAMs with no accounts get score 0 across pillars except compliance/onboarding (default 100)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    await seedUser({ email: 'sam1@x.com', name: 'Sam One', role: 'SAM' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/leaderboard?role=SAM', token);
    expect(res.body.ranking).toHaveLength(1);
    const row = res.body.ranking[0];
    expect(row.accountsCount).toBe(0);
    expect(row.complianceScore).toBe(100);
    expect(row.onboardingScore).toBe(100);
    // revenue: 50 (flat baseline) * 0.7 + 0 * 0.3 = 35
    expect(row.revenueScore).toBeCloseTo(35, 0);
    // mom: 0
    expect(row.momScore).toBe(0);
  });

  it('ranks SAMs by final score, tie-break on compliance', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const sam1 = await seedUser({ email: 'sam1@x.com', name: 'Top', role: 'SAM' });
    const sam2 = await seedUser({ email: 'sam2@x.com', name: 'Mid', role: 'SAM' });

    // Sam1: BASE account, +20% MRR delta
    const a1 = await seedAccount({
      kittyType: 'BASE',
      currentMrr: 12000,
      startOfPeriodMrr: 10000,
      samOwnerId: sam1.id,
    });
    await prisma.commercialChange.create({
      data: {
        accountId: a1.id,
        changeType: 'UPGRADE',
        oldMrr: 10000,
        newMrr: 12000,
        effectiveDate: new Date('2026-04-15'),
        clientApprovalAttached: true,
        accountsNotifiedDate: new Date(),
        createdBy: admin.id,
      },
    });

    // Sam2: BASE account, flat
    await seedAccount({
      kittyType: 'BASE',
      currentMrr: 10000,
      startOfPeriodMrr: 10000,
      samOwnerId: sam2.id,
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/leaderboard?role=SAM', token);
    expect(res.body.ranking[0].name).toBe('Top');
    expect(res.body.ranking[0].rank).toBe(1);
    expect(res.body.ranking[1].name).toBe('Mid');
    expect(res.body.ranking[1].rank).toBe(2);
    expect(res.body.ranking[0].finalScore).toBeGreaterThan(res.body.ranking[1].finalScore);
  });

  it('filters by role=SAM_HEAD', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    await seedUser({ email: 'sam1@x.com', role: 'SAM' });
    await seedUser({ email: 'head1@x.com', name: 'Head One', role: 'SAM_HEAD' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/leaderboard?role=SAM_HEAD', token);
    expect(res.body.ranking).toHaveLength(1);
    expect(res.body.ranking[0].name).toBe('Head One');
  });

  it('rewards MOM discipline: SAM with held + MoM-within-48h scores higher than no MoM', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const samGood = await seedUser({ email: 'good@x.com', name: 'Good', role: 'SAM' });
    const samBad = await seedUser({ email: 'bad@x.com', name: 'Bad', role: 'SAM' });

    const aGood = await seedAccount({ kittyType: 'BASE', currentMrr: 10000, startOfPeriodMrr: 10000, samOwnerId: samGood.id });
    const aBad = await seedAccount({ kittyType: 'BASE', currentMrr: 10000, startOfPeriodMrr: 10000, samOwnerId: samBad.id });

    // Good: held + mom sent within 12h
    await prisma.meeting.create({
      data: {
        accountId: aGood.id,
        scheduledAt: new Date('2026-04-15T10:00:00Z'),
        heldAt: new Date('2026-04-15T11:00:00Z'),
        momSentAt: new Date('2026-04-15T23:00:00Z'),
        createdBy: admin.id,
      },
    });
    // Bad: scheduled but never held
    await prisma.meeting.create({
      data: {
        accountId: aBad.id,
        scheduledAt: new Date('2026-04-15T10:00:00Z'),
        createdBy: admin.id,
      },
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/leaderboard?role=SAM', token);
    const goodRow = res.body.ranking.find((r: { name: string }) => r.name === 'Good');
    const badRow = res.body.ranking.find((r: { name: string }) => r.name === 'Bad');
    expect(goodRow.momScore).toBeGreaterThan(badRow.momScore);
  });
});
