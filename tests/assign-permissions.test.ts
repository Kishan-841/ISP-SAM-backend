/**
 * Ownership-change permissions.
 *
 * SAM_HEAD may only assign customers OUT of the unassigned triage queue.
 * Changing the owner of an already-assigned customer — reassign OR unassign
 * (which would be a backdoor reassign) — is ADMIN-only.
 */
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

async function setup() {
  const head = await seedUser({ email: 'head@x.com', name: 'Head', role: 'SAM_HEAD' });
  const samA = await seedUser({ email: 'a@x.com', name: 'A', role: 'SAM' });
  const samB = await seedUser({ email: 'b@x.com', name: 'B', role: 'SAM' });
  await prisma.user.updateMany({
    where: { id: { in: [samA.id, samB.id] } },
    data: { samHeadId: head.id },
  });
  const admin = await seedUser({ email: 'admin@x.com', name: 'Admin', role: 'ADMIN' });
  return {
    samA,
    samB,
    headCookie: `${SESSION_COOKIE}=${await tokenFor(head.id, 'SAM_HEAD')}`,
    adminCookie: `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}`,
  };
}

function assign(cookie: string, accountId: string, samUserId: string | null) {
  return request(app)
    .post(`/accounts/${accountId}/assign`)
    .set('Cookie', cookie)
    .send({ samUserId });
}

describe('POST /accounts/:id/assign — SAM_HEAD cannot reassign', () => {
  it('SAM_HEAD CAN assign an unassigned (triage) customer', async () => {
    const { samA, headCookie } = await setup();
    const acct = await seedAccount({ samOwnerId: null });

    const res = await assign(headCookie, acct.id, samA.id);
    expect(res.status).toBe(200);

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.samOwnerId).toBe(samA.id);
  });

  it('SAM_HEAD CANNOT reassign an already-owned customer (403)', async () => {
    const { samA, samB, headCookie } = await setup();
    const acct = await seedAccount({ samOwnerId: samA.id });

    const res = await assign(headCookie, acct.id, samB.id);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/REASSIGN_FORBIDDEN/);

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.samOwnerId).toBe(samA.id); // untouched
  });

  it('SAM_HEAD CANNOT unassign an owned customer either (no backdoor reassign)', async () => {
    const { samA, headCookie } = await setup();
    const acct = await seedAccount({ samOwnerId: samA.id });

    const res = await assign(headCookie, acct.id, null);
    expect(res.status).toBe(403);

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.samOwnerId).toBe(samA.id);
  });

  it('ADMIN can still reassign', async () => {
    const { samA, samB, adminCookie } = await setup();
    const acct = await seedAccount({ samOwnerId: samA.id });

    const res = await assign(adminCookie, acct.id, samB.id);
    expect(res.status).toBe(200);

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.samOwnerId).toBe(samB.id);
  });
});
