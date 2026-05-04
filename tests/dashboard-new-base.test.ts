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

async function adminCookie() {
  const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
  const token = await tokenFor(admin.id, 'ADMIN');
  return { token, user: admin };
}

const TODAY = new Date('2026-05-02T00:00:00Z'); // FY26-27, Q1, May

describe('GET /dashboard/new-base', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/dashboard/new-base');
    expect(res.status).toBe(401);
  });

  it('returns zeros when no accounts exist', async () => {
    const { token } = await adminCookie();
    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.status).toBe(200);
    expect(res.body.totalCustomers).toBe(0);
    expect(res.body.totalNewMrrLakh).toBe(0);
    expect(res.body.totalNewArcLakh).toBe(0);
    expect(res.body.recentAdditions).toEqual([]);
    expect(res.body.avgTimeToFirstMomDays).toBeNull();
  });

  it('counts only NEW-kitty accounts that are not terminated', async () => {
    const { token } = await adminCookie();
    // 2 NEW active, 1 NEW terminated, 1 BASE active — only the 2 should count.
    await seedAccount({ kittyType: 'NEW', currentMrr: 25000, contractStatus: 'ACTIVE', onboardingDate: new Date('2026-04-15') });
    await seedAccount({ kittyType: 'NEW', currentMrr: 50000, contractStatus: 'ACTIVE', onboardingDate: new Date('2026-04-20') });
    await seedAccount({ kittyType: 'NEW', currentMrr: 99000, contractStatus: 'TERMINATED', onboardingDate: new Date('2026-04-10') });
    await seedAccount({ kittyType: 'BASE', currentMrr: 80000, contractStatus: 'ACTIVE', onboardingDate: new Date('2025-04-01') });

    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.status).toBe(200);
    expect(res.body.totalCustomers).toBe(2);
    expect(res.body.totalNewMrrLakh).toBeCloseTo(0.8, 1); // 75,000 / 100,000
    expect(res.body.totalNewArcLakh).toBeCloseTo(9, 0);   // 75,000 * 12 / 100,000
  });

  it('flags customers with no meeting (§4.6 SAM failure indicator)', async () => {
    const { token, user } = await adminCookie();
    const a = await seedAccount({ kittyType: 'NEW', currentMrr: 10000, onboardingDate: new Date('2026-04-15') });
    const b = await seedAccount({ kittyType: 'NEW', currentMrr: 10000, onboardingDate: new Date('2026-04-20') });
    // Only `a` has a meeting; `b` does not.
    await prisma.meeting.create({
      data: {
        accountId: a.id,
        scheduledAt: new Date('2026-04-25'),
        heldAt: new Date('2026-04-25'),
        momSentAt: new Date('2026-04-26'),
        createdBy: user.id,
      },
    });

    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.status).toBe(200);
    expect(res.body.customersWithoutMeeting).toBe(1);
    // ttfm: a had MOM sent on 4/26, onboarded 4/15 → 11 days.
    expect(res.body.avgTimeToFirstMomDays).toBeCloseTo(11, 0);
  });

  it('flags immediate rate revisions and early downgrades within 60 days', async () => {
    const { token, user } = await adminCookie();
    const acct = await seedAccount({
      kittyType: 'NEW',
      currentMrr: 50000,
      onboardingDate: new Date('2026-04-01'),
    });
    // Rate revision 30 days post-onboarding → flagged
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'RATE_REVISION',
        oldMrr: 50000,
        newMrr: 45000,
        effectiveDate: new Date('2026-05-01'),
        clientApprovalAttached: true,
        createdBy: user.id,
      },
    });
    // Downgrade 90 days post-onboarding → NOT flagged (outside 60d window)
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'DOWNGRADE',
        oldMrr: 45000,
        newMrr: 30000,
        effectiveDate: new Date('2026-06-30'),
        clientApprovalAttached: true,
        createdBy: user.id,
      },
    });

    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.body.immediateRateRevisions).toBe(1);
    expect(res.body.earlyDowngrades).toBe(0);
  });

  it('counts early upgrades within 180 days as growth', async () => {
    const { token, user } = await adminCookie();
    const acct = await seedAccount({
      kittyType: 'NEW',
      currentMrr: 80000,
      onboardingDate: new Date('2026-04-01'),
    });
    // Upgrade 60 days post-onboarding → counted
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldMrr: 50000,
        newMrr: 80000,
        effectiveDate: new Date('2026-05-31'),
        clientApprovalAttached: true,
        createdBy: user.id,
      },
    });

    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.body.earlyUpgrades.count).toBe(1);
    // (80000 - 50000) * 12 / 100000 = 3.6 lakh
    expect(res.body.earlyUpgrades.arcAddedLakh).toBeCloseTo(3.6, 1);
  });

  it('returns the most recent additions (top 10) sorted desc', async () => {
    const { token } = await adminCookie();
    for (let i = 0; i < 12; i++) {
      await seedAccount({
        kittyType: 'NEW',
        clientName: `Customer ${i}`,
        currentMrr: 10000 + i * 1000,
        onboardingDate: new Date(`2026-04-${String(i + 1).padStart(2, '0')}`),
      });
    }

    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.body.recentAdditions).toHaveLength(10);
    // The most recent one (i=11) should be first.
    expect(res.body.recentAdditions[0].clientName).toBe('Customer 11');
  });
});
