/**
 * Per-SAM allowable-churn / incentive math.
 *
 * Verifies:
 *   1. Net churn ARC = disconnections + downgrades − upgrades.
 *   2. Net churn % is denominated in start-of-period ARC.
 *   3. churnHeadroomPercent = allowableChurnPercent − netChurnPercent and
 *      churnStatus = under_budget when actual ≤ allowable.
 *   4. The team aggregate is ARC-weighted (a heavier book moves the team
 *      number more than a lighter one).
 *   5. The PATCH /users/:id validation enforces the 6.00 ≤ x ≤ 8.00 range.
 *   6. publicUser projection exposes the field as a number so the
 *      frontend edit form can pre-populate it.
 *
 * Net-churn definition was picked deliberately — see the long comment in
 * team-performance.service.ts on why we net upgrades against losses
 * rather than treating churn as a one-way ratchet.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});
beforeEach(async () => {
  await resetDb();
});

async function adminCookie() {
  const u = await seedUser({ email: 'admin-churn@x.com', role: 'ADMIN' });
  const token = await tokenFor(u.id, 'ADMIN');
  return { user: u, cookie: `${SESSION_COOKIE}=${token}` };
}

async function seedHeadAndSam(opts: { allowableChurn?: number } = {}) {
  const head = await seedUser({
    email: `head-${Math.floor(performance.now())}@x.com`,
    role: 'SAM_HEAD',
  });
  const sam = await prisma.user.create({
    data: {
      email: `sam-${Math.floor(performance.now())}@x.com`,
      name: 'Sam Net',
      role: 'SAM',
      passwordHash: 'x',
      samHeadId: head.id,
      allowableChurnPercent: opts.allowableChurn ?? 7.0,
    },
  });
  return { head, sam };
}

async function seedAccountWithChange(opts: {
  samId: string;
  startArc: number;
  currentArc: number;
  changeType: 'UPGRADE' | 'DOWNGRADE' | 'DISCONNECTION';
  oldArc: number;
  newArc: number;
  terminated?: boolean;
}) {
  const account = await prisma.account.create({
    data: {
      clientName: 'Churn Co',
      kittyType: 'BASE',
      currentArc: opts.currentArc,
      startOfPeriodArc: opts.startArc,
      contractStatus: opts.terminated ? 'TERMINATED' : 'ACTIVE',
      onboardingDate: new Date('2025-01-01'),
      samOwnerId: opts.samId,
    },
  });
  await prisma.commercialChange.create({
    data: {
      accountId: account.id,
      createdBy: opts.samId,
      changeType: opts.changeType,
      oldArc: opts.oldArc,
      newArc: opts.newArc,
      effectiveDate: new Date('2025-06-01'),
      clientApprovalAttached: true,
      // Disconnections need accountAppliedAt to count as "actually terminated"
      // in the existing waterfall math; we set it here so the test scenario
      // matches the production sweep.
      accountAppliedAt: opts.changeType === 'DISCONNECTION' ? new Date() : null,
    },
  });
  return account;
}

describe('Per-SAM allowable churn — net churn math', () => {
  it('net churn = disconnections + downgrades − upgrades, denominated in startArc', async () => {
    const { cookie } = await adminCookie();
    const { sam } = await seedHeadAndSam({ allowableChurn: 7.0 });

    // Crafted so upgrades exactly cancel losses → 0% net churn:
    //   +₹5L upgrade (account A: 50L → 55L; startArc 50L)
    //   −₹3L downgrade (account B: 20L → 17L; startArc 20L)
    //   −₹2L disconnection (account C: 2L → 0, terminated; startArc 2L)
    // startArc total = 50 + 20 + 2 = 72L
    // net churn ARC = 2 (disco) + 3 (down) − 5 (up) = 0L → 0% → full 7% headroom.
    await seedAccountWithChange({
      samId: sam.id,
      startArc: 50_00_000,
      currentArc: 55_00_000,
      changeType: 'UPGRADE',
      oldArc: 50_00_000,
      newArc: 55_00_000,
    });
    await seedAccountWithChange({
      samId: sam.id,
      startArc: 20_00_000,
      currentArc: 17_00_000,
      changeType: 'DOWNGRADE',
      oldArc: 20_00_000,
      newArc: 17_00_000,
    });
    await seedAccountWithChange({
      samId: sam.id,
      startArc: 2_00_000,
      currentArc: 2_00_000,
      changeType: 'DISCONNECTION',
      oldArc: 2_00_000,
      newArc: 0,
      terminated: true,
    });

    const res = await request(app).get('/dashboard/team-performance').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const row = res.body.sams.find((s: { userId: string }) => s.userId === sam.id)!;

    expect(row.netChurnArc).toBe(0);
    expect(row.netChurnPercent).toBe(0);
    expect(row.allowableChurnPercent).toBe(7);
    expect(row.churnHeadroomPercent).toBe(7);
    expect(row.churnStatus).toBe('under_budget');
  });

  it('over-budget when net loss exceeds allowable %', async () => {
    const { cookie } = await adminCookie();
    const { sam } = await seedHeadAndSam({ allowableChurn: 6.0 });

    // Start ₹100L, lose ₹10L net → 10% churn vs 6% allowable → over budget.
    await seedAccountWithChange({
      samId: sam.id,
      startArc: 100_00_000,
      currentArc: 100_00_000,
      changeType: 'DISCONNECTION',
      oldArc: 10_00_000,
      newArc: 0,
      terminated: false,
    });

    const res = await request(app).get('/dashboard/team-performance').set('Cookie', cookie);
    const row = res.body.sams.find((s: { userId: string }) => s.userId === sam.id)!;

    expect(row.netChurnArc).toBe(10_00_000);
    expect(row.netChurnPercent).toBe(10);
    expect(row.allowableChurnPercent).toBe(6);
    expect(row.churnHeadroomPercent).toBe(-4);
    expect(row.churnStatus).toBe('over_budget');
  });

  it('growth (upgrades > losses) shows negative net churn and headroom above allowable', async () => {
    const { cookie } = await adminCookie();
    const { sam } = await seedHeadAndSam({ allowableChurn: 8.0 });

    // Net +₹8L gain on ₹100L → −8% churn → 16% headroom under 8% budget.
    await seedAccountWithChange({
      samId: sam.id,
      startArc: 100_00_000,
      currentArc: 108_00_000,
      changeType: 'UPGRADE',
      oldArc: 100_00_000,
      newArc: 108_00_000,
    });

    const res = await request(app).get('/dashboard/team-performance').set('Cookie', cookie);
    const row = res.body.sams.find((s: { userId: string }) => s.userId === sam.id)!;

    expect(row.netChurnArc).toBe(-8_00_000);
    expect(row.netChurnPercent).toBe(-8);
    expect(row.churnHeadroomPercent).toBe(16);
    expect(row.churnStatus).toBe('under_budget');
  });

  it('team aggregate is ARC-weighted across SAMs', async () => {
    const { cookie } = await adminCookie();
    const head = await seedUser({ email: 'head-team@x.com', role: 'SAM_HEAD' });
    const samBig = await prisma.user.create({
      data: {
        email: 'big@x.com',
        name: 'Big Book',
        role: 'SAM',
        passwordHash: 'x',
        samHeadId: head.id,
        allowableChurnPercent: 6.0,
      },
    });
    const samSmall = await prisma.user.create({
      data: {
        email: 'small@x.com',
        name: 'Small Book',
        role: 'SAM',
        passwordHash: 'x',
        samHeadId: head.id,
        allowableChurnPercent: 8.0,
      },
    });

    // Big book: ₹900L, no churn.
    await seedAccountWithChange({
      samId: samBig.id,
      startArc: 900_00_000,
      currentArc: 900_00_000,
      changeType: 'UPGRADE',
      oldArc: 50_00_000,
      newArc: 50_00_000,
    });
    // Small book: ₹100L, lost ₹10L (10% net churn).
    await seedAccountWithChange({
      samId: samSmall.id,
      startArc: 100_00_000,
      currentArc: 100_00_000,
      changeType: 'DISCONNECTION',
      oldArc: 10_00_000,
      newArc: 0,
      terminated: false,
    });

    const res = await request(app).get('/dashboard/team-performance').set('Cookie', cookie);
    // Team net churn = (0 + 10L) / (900 + 100) L = 1.0% — small-book loss
    // is heavily diluted by big-book stability.
    expect(res.body.team.netChurnArc).toBe(10_00_000);
    expect(res.body.team.netChurnPercent).toBe(1);
    // Team allowable = (6*900 + 8*100) / 1000 = 6.2% — Big's lower threshold
    // weights more because Big controls more of the book.
    expect(res.body.team.allowableChurnPercent).toBe(6.2);
    expect(res.body.team.churnHeadroomPercent).toBe(5.2);
    expect(res.body.team.samsOverBudget).toBe(1); // small book is over budget
  });
});

describe('PATCH /users/:id — allowableChurnPercent range guard', () => {
  it('accepts 6.0 (lower bound) and 8.0 (upper bound)', async () => {
    const { cookie } = await adminCookie();
    const head = await seedUser({ email: 'h@x.com', role: 'SAM_HEAD' });
    const sam = await prisma.user.create({
      data: {
        email: 's@x.com',
        name: 'S',
        role: 'SAM',
        passwordHash: 'x',
        samHeadId: head.id,
      },
    });

    const r1 = await request(app)
      .patch(`/users/${sam.id}`)
      .set('Cookie', cookie)
      .send({ allowableChurnPercent: 6.0 });
    expect(r1.status).toBe(200);
    expect(r1.body.user.allowableChurnPercent).toBe(6);

    const r2 = await request(app)
      .patch(`/users/${sam.id}`)
      .set('Cookie', cookie)
      .send({ allowableChurnPercent: 8.0 });
    expect(r2.status).toBe(200);
    expect(r2.body.user.allowableChurnPercent).toBe(8);
  });

  it('rejects 5.99 and 8.01 with 400', async () => {
    const { cookie } = await adminCookie();
    const head = await seedUser({ email: 'h2@x.com', role: 'SAM_HEAD' });
    const sam = await prisma.user.create({
      data: {
        email: 's2@x.com',
        name: 'S2',
        role: 'SAM',
        passwordHash: 'x',
        samHeadId: head.id,
      },
    });

    const low = await request(app)
      .patch(`/users/${sam.id}`)
      .set('Cookie', cookie)
      .send({ allowableChurnPercent: 5.99 });
    expect(low.status).toBe(400);

    const high = await request(app)
      .patch(`/users/${sam.id}`)
      .set('Cookie', cookie)
      .send({ allowableChurnPercent: 8.01 });
    expect(high.status).toBe(400);

    // Value unchanged.
    const fresh = await prisma.user.findUnique({ where: { id: sam.id } });
    expect(Number(fresh!.allowableChurnPercent)).toBe(7);
  });

  it('audit-logs the change with before/after snapshot', async () => {
    const { cookie, user: admin } = await adminCookie();
    const head = await seedUser({ email: 'h3@x.com', role: 'SAM_HEAD' });
    const sam = await prisma.user.create({
      data: {
        email: 's3@x.com',
        name: 'S3',
        role: 'SAM',
        passwordHash: 'x',
        samHeadId: head.id,
        allowableChurnPercent: 7.0,
      },
    });

    await request(app)
      .patch(`/users/${sam.id}`)
      .set('Cookie', cookie)
      .send({ allowableChurnPercent: 6.5 });

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'User', entityId: sam.id, action: 'UPDATE' },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit).toBeTruthy();
    expect(audit!.performedBy).toBe(admin.id);
    const payload = audit!.payload as {
      before: { allowableChurnPercent: number };
      after: { allowableChurnPercent: number };
    };
    expect(payload.before.allowableChurnPercent).toBe(7);
    expect(payload.after.allowableChurnPercent).toBe(6.5);
  });
});
