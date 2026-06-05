import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

/**
 * Tests for POST /commercial-changes/backfill-disconnection
 * (admin-only, used to record historical disconnections where the
 * customer is already gone but no commercial_change row exists yet).
 *
 * This path bypasses CRM entirely + stamps `accountAppliedAt` to the
 * provided historical date, so the dashboard waterfall counts the loss
 * in the correct period.
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});
beforeEach(async () => {
  await resetDb();
});

async function adminCookie() {
  const user = await seedUser({ email: 'admin-bf@x.com', role: 'ADMIN' });
  const token = await tokenFor(user.id, 'ADMIN');
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('POST /commercial-changes/backfill-disconnection', () => {
  it('happy path — creates a fully-applied DISCONNECTION + flips the account', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Bygone Inc',
      currentArc: 75000,
      bandwidthMbps: 50,
      contractStatus: 'ACTIVE',
    });

    const res = await request(app)
      .post('/commercial-changes/backfill-disconnection')
      .set('Cookie', cookie)
      .send({
        accountId: acct.id,
        effectiveDate: '2026-04-14',
        reason: 'Office shut down, customer left',
      });

    expect(res.status).toBe(201);
    expect(res.body.commercialChange.oldArc).toBe(75000);
    expect(res.body.commercialChange.effectiveDate).toBe('2026-04-14');
    expect(res.body.account.contractStatus).toBe('TERMINATED');

    // Account fully flipped
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after!.contractStatus).toBe('TERMINATED');
    expect(Number(after!.currentArc)).toBe(0);

    // commercial_change row has all the "as-if-completed" stamps
    const cc = await prisma.commercialChange.findFirst({
      where: { accountId: acct.id, changeType: 'DISCONNECTION' },
    });
    expect(cc).toBeTruthy();
    expect(Number(cc!.oldArc)).toBe(75000);
    expect(Number(cc!.newArc)).toBe(0);
    expect(cc!.disconnectionMode).toBe('NORMAL');
    expect(cc!.retentionDecision).toBe('PROCEED');
    expect(cc!.crmStatus).toBe('BACKFILL_LOCAL');
    expect(cc!.crmServiceOrderId).toBeNull();
    // accountAppliedAt is set to effectiveDate so the dashboard counts it now
    expect(cc!.accountAppliedAt).not.toBeNull();
    expect(cc!.accountAppliedAt!.toISOString().slice(0, 10)).toBe('2026-04-14');
    expect(cc!.scheduledTerminationAt!.toISOString().slice(0, 10)).toBe('2026-04-14');
  });

  it('rejects when account is already TERMINATED (prevents double-counting)', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Already Gone',
      currentArc: 50000,
      contractStatus: 'TERMINATED',
    });

    const res = await request(app)
      .post('/commercial-changes/backfill-disconnection')
      .set('Cookie', cookie)
      .send({
        accountId: acct.id,
        effectiveDate: '2026-04-01',
        reason: 'Trying to backfill twice',
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/ACCOUNT_ALREADY_TERMINATED/);

    // No new commercial_change row created
    const ccCount = await prisma.commercialChange.count({
      where: { accountId: acct.id },
    });
    expect(ccCount).toBe(0);
  });

  it('returns 404 when accountId does not exist', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .post('/commercial-changes/backfill-disconnection')
      .set('Cookie', cookie)
      .send({
        accountId: '00000000-0000-0000-0000-000000000000',
        effectiveDate: '2026-04-01',
        reason: 'No such account',
      });
    expect(res.status).toBe(404);
  });

  it('writes a BACKFILL_DISCONNECTION audit row with admin IP', async () => {
    const { user: admin, cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Audited Co',
      currentArc: 60000,
      contractStatus: 'ACTIVE',
    });

    await request(app)
      .post('/commercial-changes/backfill-disconnection')
      .set('Cookie', cookie)
      .set('User-Agent', 'sam-test/1.0')
      .send({
        accountId: acct.id,
        effectiveDate: '2026-05-15',
        reason: 'Service issue',
      });

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'CommercialChange', action: 'BACKFILL_DISCONNECTION' },
    });
    expect(audit).toBeTruthy();
    expect(audit!.performedBy).toBe(admin.id);
    expect(audit!.userAgent).toBe('sam-test/1.0');
    const payload = audit!.payload as {
      accountId: string;
      effectiveDate: string;
      oldArc: number;
      reason: string;
    };
    expect(payload.accountId).toBe(acct.id);
    expect(payload.oldArc).toBe(60000);
    expect(payload.effectiveDate).toBe('2026-05-15');
    expect(payload.reason).toBe('Service issue');
  });

  it('returns 403 to non-ADMIN users', async () => {
    const samUser = await seedUser({ email: 'sam-no-bf@x.com', role: 'SAM' });
    const samToken = await tokenFor(samUser.id, 'SAM');
    const acct = await seedAccount({ clientName: 'X', currentArc: 1, contractStatus: 'ACTIVE' });

    const res = await request(app)
      .post('/commercial-changes/backfill-disconnection')
      .set('Cookie', `${SESSION_COOKIE}=${samToken}`)
      .send({
        accountId: acct.id,
        effectiveDate: '2026-04-01',
        reason: 'attempt',
      });

    expect(res.status).toBe(403);
  });

  it('rejects when reason is missing or too short', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'X', currentArc: 1, contractStatus: 'ACTIVE' });

    const noReason = await request(app)
      .post('/commercial-changes/backfill-disconnection')
      .set('Cookie', cookie)
      .send({ accountId: acct.id, effectiveDate: '2026-04-01' });
    expect(noReason.status).toBe(400);

    const tinyReason = await request(app)
      .post('/commercial-changes/backfill-disconnection')
      .set('Cookie', cookie)
      .send({ accountId: acct.id, effectiveDate: '2026-04-01', reason: 'a' });
    expect(tinyReason.status).toBe(400);
  });
});
