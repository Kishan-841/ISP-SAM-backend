import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';
import { prisma } from '../src/prisma.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
});

async function counts(userId: string, role: 'ADMIN' | 'SAM_HEAD' | 'SAM' | 'ACCOUNTS' | 'SUPER_ADMIN_2') {
  const cookie = `${SESSION_COOKIE}=${await tokenFor(userId, role)}`;
  const res = await request(app).get('/sidebar/counts').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as {
    approvals: number;
    probableChurn: number;
    unassignedCustomers: number;
  };
}

describe('GET /sidebar/counts', () => {
  it('401 without a cookie', async () => {
    const res = await request(app).get('/sidebar/counts');
    expect(res.status).toBe(401);
  });

  it('approvals count is scoped to the viewer stage', async () => {
    const sam = await seedUser({ email: 'sam@x.com', role: 'SAM' });
    const accounts = await seedUser({ email: 'acct@x.com', name: 'Acct', role: 'ACCOUNTS' });
    const sa2 = await seedUser({ email: 'sa2@x.com', name: 'SA2', role: 'SUPER_ADMIN_2' });
    const acct = await seedAccount({ kittyType: 'BASE', samOwnerId: sam.id });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldArc: 100000,
        newArc: 200000,
        effectiveDate: new Date('2026-07-01'),
        clientApprovalAttached: false,
        createdBy: sam.id,
        approvalStatus: 'PENDING_ACCOUNTS',
      },
    });

    expect((await counts(accounts.id, 'ACCOUNTS')).approvals).toBe(1);
    // Different stage → not in SUPER_ADMIN_2's queue.
    expect((await counts(sa2.id, 'SUPER_ADMIN_2')).approvals).toBe(0);
    // SAM has no approval queue at all.
    expect((await counts(sam.id, 'SAM')).approvals).toBe(0);
  });

  it('probable-churn counts only due, undecided disconnections; SAM sees own', async () => {
    const samA = await seedUser({ email: 'a@x.com', role: 'SAM' });
    const samB = await seedUser({ email: 'b@x.com', name: 'B', role: 'SAM' });
    const admin = await seedUser({ email: 'admin@x.com', name: 'Admin', role: 'ADMIN' });
    const acct = await seedAccount({
      contractStatus: 'PROBABLE_CHURN',
      samOwnerId: samA.id,
      currentArc: 500000,
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'DISCONNECTION',
        oldArc: 500000,
        newArc: 0,
        effectiveDate: new Date('2020-01-01'),
        clientApprovalAttached: false,
        createdBy: samA.id,
        retentionPromptDueAt: new Date('2020-01-22'), // long past → due
        retentionDecision: null,
      },
    });

    expect((await counts(samA.id, 'SAM')).probableChurn).toBe(1);
    expect((await counts(samB.id, 'SAM')).probableChurn).toBe(0); // not their customer
    expect((await counts(admin.id, 'ADMIN')).probableChurn).toBe(1); // sees all
  });

  it('unassigned customers count shows only for SAM_HEAD / ADMIN', async () => {
    const head = await seedUser({ email: 'head@x.com', role: 'SAM_HEAD' });
    const sam = await seedUser({ email: 'sam@x.com', name: 'S', role: 'SAM' });
    await seedAccount({ samOwnerId: null, contractStatus: 'ACTIVE' });
    await seedAccount({ samOwnerId: null, contractStatus: 'PENDING' });

    expect((await counts(head.id, 'SAM_HEAD')).unassignedCustomers).toBe(2);
    expect((await counts(sam.id, 'SAM')).unassignedCustomers).toBe(0);
  });
});
