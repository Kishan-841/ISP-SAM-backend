import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

/**
 * The `?sam=` filter on the Existing Base / New Base dashboards and their
 * bucket drill-downs. It narrows the view to one SAM's customers; it must
 * NEVER widen what the requester's role already allows — a SAM_HEAD asking
 * for a SAM outside their team gets zeros, not that team's numbers.
 */
describe('?sam= filter', () => {
  async function seedTwoSams() {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const samA = await seedUser({ email: 'sam-a@x.com', name: 'Sam A', role: 'SAM' });
    const samB = await seedUser({ email: 'sam-b@x.com', name: 'Sam B', role: 'SAM' });
    return { admin, samA, samB, token: await tokenFor(admin.id, 'ADMIN') };
  }

  it('narrows existing-base to the selected SAM', async () => {
    const { samA, samB, token } = await seedTwoSams();
    await seedAccount({ kittyType: 'BASE', currentArc: 1200000, samOwnerId: samA.id });
    await seedAccount({ kittyType: 'BASE', currentArc: 3600000, samOwnerId: samB.id });

    const all = await authedGet(app, '/dashboard/existing-base', token);
    expect(all.body.totalCustomers).toBe(2);
    expect(all.body.totalBaseArcLakh).toBe(48);

    const res = await authedGet(app, `/dashboard/existing-base?sam=${samA.id}`, token);
    expect(res.status).toBe(200);
    expect(res.body.totalCustomers).toBe(1);
    expect(res.body.totalBaseArcLakh).toBe(12);
    expect(res.body.currentArcLakh).toBe(12);
  });

  it('narrows new-base to the selected SAM', async () => {
    const { samA, samB, token } = await seedTwoSams();
    const onboardingDate = new Date('2026-04-15');
    await seedAccount({ kittyType: 'NEW', currentArc: 600000, samOwnerId: samA.id, onboardingDate });
    await seedAccount({ kittyType: 'NEW', currentArc: 900000, samOwnerId: samB.id, onboardingDate });

    const res = await authedGet(app, `/dashboard/new-base?sam=${samA.id}`, token);
    expect(res.status).toBe(200);
    expect(res.body.totalCustomers).toBe(1);
    expect(res.body.totalNewArcLakh).toBe(6);
  });

  it('narrows the bucket drill-down to the selected SAM', async () => {
    const { admin, samA, samB, token } = await seedTwoSams();
    const accountA = await seedAccount({ kittyType: 'BASE', samOwnerId: samA.id });
    const accountB = await seedAccount({ kittyType: 'BASE', samOwnerId: samB.id });
    for (const account of [accountA, accountB]) {
      await prisma.commercialChange.create({
        data: {
          accountId: account.id,
          changeType: 'UPGRADE',
          oldArc: 600000,
          newArc: 720000,
          effectiveDate: new Date('2026-05-01'),
          clientApprovalAttached: false,
          createdBy: admin.id,
        },
      });
    }

    const res = await authedGet(
      app,
      `/dashboard/changes?kittyType=BASE&bucket=UPGRADE&sam=${samA.id}`,
      token,
    );
    expect(res.status).toBe(200);
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].samOwner.id).toBe(samA.id);
  });

  it('ignores a malformed sam id rather than erroring', async () => {
    const { samA, token } = await seedTwoSams();
    await seedAccount({ kittyType: 'BASE', currentArc: 1200000, samOwnerId: samA.id });

    const res = await authedGet(app, '/dashboard/existing-base?sam=not-a-uuid', token);
    expect(res.status).toBe(200);
    expect(res.body.totalCustomers).toBe(1);
  });

  it('gives a SAM_HEAD zeros for a SAM outside their team, never that SAM’s data', async () => {
    const head = await seedUser({ email: 'head@x.com', role: 'SAM_HEAD' });
    const mine = await seedUser({ email: 'mine@x.com', role: 'SAM' });
    const theirs = await seedUser({ email: 'theirs@x.com', role: 'SAM' });
    await prisma.user.update({ where: { id: mine.id }, data: { samHeadId: head.id } });
    await seedAccount({ kittyType: 'BASE', currentArc: 1200000, samOwnerId: mine.id });
    await seedAccount({ kittyType: 'BASE', currentArc: 9900000, samOwnerId: theirs.id });

    const token = await tokenFor(head.id, 'SAM_HEAD');
    const res = await authedGet(app, `/dashboard/existing-base?sam=${theirs.id}`, token);
    expect(res.status).toBe(200);
    expect(res.body.totalCustomers).toBe(0);
    expect(res.body.totalBaseArcLakh).toBe(0);
  });
});
