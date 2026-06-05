import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

/**
 * Tests for the admin edit-any-field flow:
 *   PATCH /accounts/:id   (ADMIN-only)
 *
 * Covers:
 *  - Happy path: multiple fields update, returned account reflects them
 *  - One audit_log row per changed field, with from/to diff in payload
 *  - Role gating (SAM gets 403)
 *  - Unique-constraint clash returns 409 (e.g. circuitId already used)
 *  - No-op patch returns empty changedFields (and writes no audit rows)
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});
beforeEach(async () => {
  await resetDb();
});

async function adminCookie(): Promise<{ user: { id: string }; cookie: string }> {
  const user = await seedUser({ email: 'admin-edit@x.com', role: 'ADMIN' });
  const token = await tokenFor(user.id, 'ADMIN');
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('PATCH /accounts/:id (admin edit)', () => {
  it('updates multiple editable fields and writes one audit row per changed field', async () => {
    const { user: admin, cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Old Name',
      companyName: null,
      currentArc: 100000,
      bandwidthMbps: 50,
      contractStatus: 'ACTIVE',
    });

    const res = await request(app)
      .patch(`/accounts/${acct.id}`)
      .set('Cookie', cookie)
      .send({
        clientName: 'New Name',
        companyName: 'New Co Pvt Ltd',
        currentArc: 150000,
        bandwidthMbps: 100,
        gstNumber: '27AAAAA0000A1Z5',
      });

    expect(res.status).toBe(200);
    expect(res.body.changedFields).toEqual(
      expect.arrayContaining([
        'clientName',
        'companyName',
        'currentArc',
        'bandwidthMbps',
        'gstNumber',
      ]),
    );
    expect(res.body.changedFields).toHaveLength(5);

    // Account row reflects all changes
    const updated = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(updated!.clientName).toBe('New Name');
    expect(updated!.companyName).toBe('New Co Pvt Ltd');
    expect(Number(updated!.currentArc)).toBe(150000);
    expect(updated!.bandwidthMbps).toBe(100);
    expect(updated!.gstNumber).toBe('27AAAAA0000A1Z5');

    // One audit row per changed field with from/to in payload
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'Account', entityId: acct.id, action: 'UPDATE_FIELD' },
    });
    expect(audits).toHaveLength(5);
    for (const a of audits) {
      expect(a.performedBy).toBe(admin.id);
      const p = a.payload as { field: string; from: unknown; to: unknown };
      expect(p.field).toBeTruthy();
      expect(p).toHaveProperty('from');
      expect(p).toHaveProperty('to');
    }
    const arcRow = audits.find((a) => (a.payload as { field: string }).field === 'currentArc');
    const arcPayload = arcRow!.payload as { from: number; to: number };
    expect(arcPayload.from).toBe(100000);
    expect(arcPayload.to).toBe(150000);
  });

  it('writes zero audit rows when no fields actually change', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Same', currentArc: 100000 });

    // Send the same values that already exist on the row.
    const res = await request(app)
      .patch(`/accounts/${acct.id}`)
      .set('Cookie', cookie)
      .send({ clientName: 'Same', currentArc: 100000 });

    expect(res.status).toBe(200);
    expect(res.body.changedFields).toEqual([]);

    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'Account', action: 'UPDATE_FIELD' },
    });
    expect(audits).toHaveLength(0);
  });

  it('clears nullable fields when null is sent', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'X',
      companyName: 'Y Pvt Ltd',
      gstNumber: '27AAAAA0000A1Z5',
    });

    const res = await request(app)
      .patch(`/accounts/${acct.id}`)
      .set('Cookie', cookie)
      .send({ companyName: null, gstNumber: null });

    expect(res.status).toBe(200);
    const updated = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(updated!.companyName).toBeNull();
    expect(updated!.gstNumber).toBeNull();
  });

  it('returns 409 when an edit collides with an existing unique constraint', async () => {
    const { cookie } = await adminCookie();
    await seedAccount({ clientName: 'Other', circuitId: 'CKT-USED-001' });
    const target = await seedAccount({ clientName: 'Mine', circuitId: 'CKT-MINE-001' });

    const res = await request(app)
      .patch(`/accounts/${target.id}`)
      .set('Cookie', cookie)
      .send({ circuitId: 'CKT-USED-001' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has that value/i);
    expect(res.body.error).toMatch(/circuit_?id/i);

    // Target unchanged
    const stillMine = await prisma.account.findUnique({ where: { id: target.id } });
    expect(stillMine!.circuitId).toBe('CKT-MINE-001');
  });

  it('returns 403 to non-ADMIN users (SAM)', async () => {
    const sam = await seedUser({ email: 'sam-no-edit@x.com', role: 'SAM' });
    const samToken = await tokenFor(sam.id, 'SAM');
    const acct = await seedAccount({ clientName: 'X' });

    const res = await request(app)
      .patch(`/accounts/${acct.id}`)
      .set('Cookie', `${SESSION_COOKIE}=${samToken}`)
      .send({ clientName: 'Hijacked' });

    expect(res.status).toBe(403);
    const stillX = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(stillX!.clientName).toBe('X');
  });

  it('returns 401 without a session cookie', async () => {
    const acct = await seedAccount({ clientName: 'X' });
    const res = await request(app).patch(`/accounts/${acct.id}`).send({ clientName: 'Y' });
    expect(res.status).toBe(401);
  });

  it('captures admin IP + user-agent on each audit row', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'A', currentArc: 100000 });

    await request(app)
      .patch(`/accounts/${acct.id}`)
      .set('Cookie', cookie)
      .set('User-Agent', 'sam-test-suite/1.0')
      .send({ clientName: 'B' });

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'Account', entityId: acct.id, action: 'UPDATE_FIELD' },
    });
    expect(audit).toBeTruthy();
    expect(typeof audit!.ipAddress).toBe('string');
    expect(audit!.userAgent).toBe('sam-test-suite/1.0');
  });
});
