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
    expect(res.body.totalNewArcLakh).toBe(0);
    expect(res.body.recentAdditions).toEqual([]);
    expect(res.body.avgTimeToFirstMomDays).toBeNull();
  });

  it('totals include terminated, current excludes (mirrors existing-base)', async () => {
    const { token } = await adminCookie();
    // 2 NEW active, 1 NEW terminated, 1 BASE active.
    // Total covers all 3 NEW (including terminated); Current covers the 2 active only.
    await seedAccount({ kittyType: 'NEW', currentArc: 300000, contractStatus: 'ACTIVE', onboardingDate: new Date('2026-04-15') });
    await seedAccount({ kittyType: 'NEW', currentArc: 600000, contractStatus: 'ACTIVE', onboardingDate: new Date('2026-04-20') });
    await seedAccount({ kittyType: 'NEW', currentArc: 1200000, contractStatus: 'TERMINATED', onboardingDate: new Date('2026-04-10') });
    await seedAccount({ kittyType: 'BASE', currentArc: 960000, contractStatus: 'ACTIVE', onboardingDate: new Date('2025-04-01') });

    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.status).toBe(200);
    expect(res.body.totalCustomers).toBe(3);
    expect(res.body.currentCustomers).toBe(2);
    expect(res.body.terminatedCount).toBe(1);
    // totalNewArcLakh sums startOfPeriodArc for all 3 NEW (incl. terminated):
    //   (300000 + 600000 + 1200000) / 100000 = 21L
    expect(res.body.totalNewArcLakh).toBeCloseTo(21, 0);
    // currentArcLakh only covers the 2 active:
    //   (300000 + 600000) / 100000 = 9L
    expect(res.body.currentArcLakh).toBeCloseTo(9, 0);
  });

  it('flags customers with no meeting (§4.6 SAM failure indicator)', async () => {
    const { token, user } = await adminCookie();
    const a = await seedAccount({ kittyType: 'NEW', currentArc: 120000, onboardingDate: new Date('2026-04-15') });
    const b = await seedAccount({ kittyType: 'NEW', currentArc: 120000, onboardingDate: new Date('2026-04-20') });
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
      currentArc: 600000,
      onboardingDate: new Date('2026-04-01'),
    });
    // Rate revision 30 days post-onboarding → flagged
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'RATE_REVISION',
        oldArc: 600000,
        newArc: 540000,
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
        oldArc: 540000,
        newArc: 360000,
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
      currentArc: 960000,
      onboardingDate: new Date('2026-04-01'),
    });
    // Upgrade 60 days post-onboarding → counted
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldArc: 600000,
        newArc: 960000,
        effectiveDate: new Date('2026-05-31'),
        clientApprovalAttached: true,
        createdBy: user.id,
      },
    });

    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.body.earlyUpgrades.count).toBe(1);
    // (960000 - 600000) / 100000 = 3.6 lakh
    expect(res.body.earlyUpgrades.arcAddedLakh).toBeCloseTo(3.6, 1);
  });

  it('returns the most recent additions (top 10) sorted desc', async () => {
    const { token } = await adminCookie();
    for (let i = 0; i < 12; i++) {
      await seedAccount({
        kittyType: 'NEW',
        clientName: `Customer ${i}`,
        currentArc: 120000 + i * 12000,
        onboardingDate: new Date(`2026-04-${String(i + 1).padStart(2, '0')}`),
      });
    }

    const res = await authedGet(app, '/dashboard/new-base', token);
    expect(res.body.recentAdditions).toHaveLength(10);
    // The most recent one (i=11) should be first.
    expect(res.body.recentAdditions[0].clientName).toBe('Customer 11');
  });
});
