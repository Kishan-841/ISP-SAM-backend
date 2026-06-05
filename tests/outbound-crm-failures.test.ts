import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

/**
 * GET /integrations/outbound-failures
 *
 * Surfaces commercial_changes where the outbound CRM service-order call
 * failed (crmStatus='FAILED'). Lets ops spot "SAM committed but CRM
 * didn't take" without grepping audit-log payloads.
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});
beforeEach(async () => {
  await resetDb();
});

async function adminCookie() {
  const user = await seedUser({ email: 'admin-cf@x.com', role: 'ADMIN' });
  const token = await tokenFor(user.id, 'ADMIN');
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

async function seedFailedCommercialChange(opts: {
  accountId: string;
  createdBy: string;
  crmStatus?: string;
}) {
  return prisma.commercialChange.create({
    data: {
      accountId: opts.accountId,
      changeType: 'DISCONNECTION',
      oldArc: 100000,
      newArc: 0,
      effectiveDate: new Date(),
      clientApprovalAttached: false,
      createdBy: opts.createdBy,
      crmStatus: opts.crmStatus ?? 'FAILED',
      crmStatusUpdatedAt: new Date(),
    },
  });
}

describe('GET /integrations/outbound-failures', () => {
  it('returns only commercial_changes with crmStatus=FAILED', async () => {
    const { user: admin, cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-cf@x.com', role: 'SAM' });
    const a = await seedAccount({ clientName: 'Failed Co', currentArc: 100000 });
    const b = await seedAccount({ clientName: 'OK Co', currentArc: 200000 });
    const c = await seedAccount({ clientName: 'Pending Co', currentArc: 300000 });

    await seedFailedCommercialChange({ accountId: a.id, createdBy: sam.id, crmStatus: 'FAILED' });
    await seedFailedCommercialChange({ accountId: b.id, createdBy: sam.id, crmStatus: 'COMPLETED' });
    await seedFailedCommercialChange({ accountId: c.id, createdBy: sam.id, crmStatus: 'PENDING_DOCS_REVIEW' });

    const res = await request(app)
      .get('/integrations/outbound-failures')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.failures).toHaveLength(1);
    expect(res.body.failures[0]!.account.clientName).toBe('Failed Co');
    expect(res.body.failures[0]!.crmStatus).toBe('FAILED');
    // Sanity check on payload shape
    expect(res.body.failures[0]!.changeType).toBe('DISCONNECTION');
    expect(res.body.failures[0]!.oldArc).toBe(100000);
    expect(admin).toBeTruthy();
  });

  it('returns empty list when there are no failures', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .get('/integrations/outbound-failures')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.failures).toEqual([]);
  });

  it('orders failures by crmStatusUpdatedAt desc (most recent first)', async () => {
    const { cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-cf2@x.com', role: 'SAM' });
    const older = await seedAccount({ clientName: 'Older', currentArc: 100000 });
    const newer = await seedAccount({ clientName: 'Newer', currentArc: 100000 });

    const olderCC = await seedFailedCommercialChange({ accountId: older.id, createdBy: sam.id });
    const newerCC = await seedFailedCommercialChange({ accountId: newer.id, createdBy: sam.id });

    // Force a deterministic ordering — bump the newer row's timestamp.
    await prisma.commercialChange.update({
      where: { id: olderCC.id },
      data: { crmStatusUpdatedAt: new Date('2026-01-01') },
    });
    await prisma.commercialChange.update({
      where: { id: newerCC.id },
      data: { crmStatusUpdatedAt: new Date('2026-06-01') },
    });

    const res = await request(app)
      .get('/integrations/outbound-failures')
      .set('Cookie', cookie);
    expect(res.body.failures).toHaveLength(2);
    expect(res.body.failures[0]!.account.clientName).toBe('Newer');
    expect(res.body.failures[1]!.account.clientName).toBe('Older');
  });

  it('returns 403 to non-ADMIN users', async () => {
    const sam = await seedUser({ email: 'sam-no-cf@x.com', role: 'SAM' });
    const token = await tokenFor(sam.id, 'SAM');
    const res = await request(app)
      .get('/integrations/outbound-failures')
      .set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 401 without a session cookie', async () => {
    const res = await request(app).get('/integrations/outbound-failures');
    expect(res.status).toBe(401);
  });
});
