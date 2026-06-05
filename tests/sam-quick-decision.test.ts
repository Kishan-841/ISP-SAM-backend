import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

/**
 * Tests for the SAM-internal quick-disconnect approval queue:
 *   GET  /commercial-changes/quick-approvals
 *   POST /commercial-changes/:id/sam-quick-decision
 *
 * Both are ADMIN-only. APPROVE flips the account to DISCONNECTING +
 * stamps scheduledTerminationAt. REJECT flips back to ACTIVE — but only
 * if the account is still PENDING_QUICK_APPROVAL (drift guard).
 *
 * BASE kitty is in-scope for the queue; NEW kitty rows route to CRM
 * admin via the existing webhook flow and must be rejected here.
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
  process.env.QUICK_DISCONNECT_ENABLED = 'true';
});
beforeEach(async () => {
  await resetDb();
});

async function adminCookie() {
  const user = await seedUser({ email: 'admin-qd@x.com', role: 'ADMIN' });
  const token = await tokenFor(user.id, 'ADMIN');
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

/**
 * Insert a commercial_change row directly into the DB, simulating a SAM
 * having submitted a QUICK-mode disconnection that's now sitting in the
 * admin queue. Avoids going through the full commit() path so the test
 * setup stays tight.
 */
async function seedPendingQuickRequest(opts: {
  account: { id: string; currentArc: unknown };
  performedByUserId: string;
  days?: number;
  reason?: string;
}) {
  const change = await prisma.commercialChange.create({
    data: {
      accountId: opts.account.id,
      changeType: 'DISCONNECTION',
      oldArc: opts.account.currentArc as number,
      newArc: 0,
      effectiveDate: new Date(),
      clientApprovalAttached: false,
      createdBy: opts.performedByUserId,
      disconnectionMode: 'QUICK',
      quickRequestedDays: opts.days ?? 3,
      quickApprovalReason: opts.reason ?? 'Customer urgently wants out',
    },
  });
  // Match what enterPendingQuickApproval() does on the real path.
  await prisma.account.update({
    where: { id: opts.account.id },
    data: { contractStatus: 'PENDING_QUICK_APPROVAL' },
  });
  return change;
}

describe('GET /commercial-changes/quick-approvals', () => {
  it('returns only BASE-kitty pending QUICK rows; excludes NEW kitty', async () => {
    const { user: admin, cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-qd@x.com', role: 'SAM' });

    const baseAcct = await seedAccount({
      clientName: 'BASE co',
      kittyType: 'BASE',
      currentArc: 100000,
      contractStatus: 'ACTIVE',
    });
    const newAcct = await seedAccount({
      clientName: 'NEW co',
      kittyType: 'NEW',
      currentArc: 200000,
      contractStatus: 'ACTIVE',
      onboardingDate: new Date('2026-04-10'),
    });
    await seedPendingQuickRequest({ account: baseAcct, performedByUserId: sam.id });
    await seedPendingQuickRequest({ account: newAcct, performedByUserId: sam.id });

    const res = await request(app)
      .get('/commercial-changes/quick-approvals')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]!.account.kittyType).toBe('BASE');
    expect(res.body.items[0]!.account.clientName).toBe('BASE co');
    // Hush an unused-var lint
    expect(admin).toBeTruthy();
  });

  it('excludes already-decided rows from the queue', async () => {
    const { cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-qd2@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'X', kittyType: 'BASE', currentArc: 100000 });
    const change = await seedPendingQuickRequest({ account: acct, performedByUserId: sam.id });
    await prisma.commercialChange.update({
      where: { id: change.id },
      data: { quickApprovalDecision: 'APPROVED' },
    });

    const res = await request(app)
      .get('/commercial-changes/quick-approvals')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('returns 403 to non-ADMIN users', async () => {
    const samUser = await seedUser({ email: 'sam-qa@x.com', role: 'SAM' });
    const token = await tokenFor(samUser.id, 'SAM');
    const res = await request(app)
      .get('/commercial-changes/quick-approvals')
      .set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /commercial-changes/:id/sam-quick-decision', () => {
  it('APPROVE — flips account to DISCONNECTING + sets scheduledTerminationAt = today + days', async () => {
    const { cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-app@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'A', kittyType: 'BASE', currentArc: 100000 });
    const change = await seedPendingQuickRequest({
      account: acct,
      performedByUserId: sam.id,
      days: 5,
    });

    const res = await request(app)
      .post(`/commercial-changes/${change.id}/sam-quick-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'APPROVE', note: 'Confirmed; proceed' });

    expect(res.status).toBe(200);
    const updatedAcct = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(updatedAcct!.contractStatus).toBe('DISCONNECTING');

    const updatedCC = await prisma.commercialChange.findUnique({ where: { id: change.id } });
    expect(updatedCC!.quickApprovalDecision).toBe('APPROVED');
    expect(updatedCC!.retentionDecision).toBe('PROCEED');
    expect(updatedCC!.crmStatus).toBe('SAM_LOCAL_APPROVED');
    expect(updatedCC!.quickApprovalNote).toBe('Confirmed; proceed');
    expect(updatedCC!.scheduledTerminationAt).not.toBeNull();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const expected = new Date(today);
    expected.setUTCDate(expected.getUTCDate() + 5);
    expect(updatedCC!.scheduledTerminationAt!.toISOString().slice(0, 10)).toBe(
      expected.toISOString().slice(0, 10),
    );

    // Audit row
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: change.id, action: 'QUICK_DISCONNECT_APPROVED' },
    });
    expect(audit).toBeTruthy();
    const payload = audit!.payload as { source: string };
    expect(payload.source).toBe('SAM_LOCAL');
  });

  it('REJECT — flips a pending account back to ACTIVE', async () => {
    const { cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-rej@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'B', kittyType: 'BASE', currentArc: 100000 });
    const change = await seedPendingQuickRequest({ account: acct, performedByUserId: sam.id });

    const res = await request(app)
      .post(`/commercial-changes/${change.id}/sam-quick-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'REJECT', note: 'Customer changed mind' });

    expect(res.status).toBe(200);
    const updatedAcct = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(updatedAcct!.contractStatus).toBe('ACTIVE');

    const updatedCC = await prisma.commercialChange.findUnique({ where: { id: change.id } });
    expect(updatedCC!.quickApprovalDecision).toBe('REJECTED');
    expect(updatedCC!.retentionDecision).toBe('RETAIN');
    expect(updatedCC!.crmStatus).toBe('SAM_LOCAL_REJECTED');
  });

  it('REJECT — drift guard: returns 409 if account is no longer PENDING_QUICK_APPROVAL', async () => {
    const { cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-drift@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'C', kittyType: 'BASE', currentArc: 100000 });
    const change = await seedPendingQuickRequest({ account: acct, performedByUserId: sam.id });

    // Simulate concurrent drift: another flow has moved the account to
    // PROBABLE_CHURN before the admin's REJECT lands.
    await prisma.account.update({
      where: { id: acct.id },
      data: { contractStatus: 'PROBABLE_CHURN' },
    });

    const res = await request(app)
      .post(`/commercial-changes/${change.id}/sam-quick-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'REJECT' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ACCOUNT_DRIFTED/);
    expect(res.body.error).toMatch(/refresh the queue/i);

    // Whole transaction should have rolled back — change still pending.
    const stillPending = await prisma.commercialChange.findUnique({ where: { id: change.id } });
    expect(stillPending!.quickApprovalDecision).toBeNull();

    // Account state is whatever the other flow set; importantly NOT 'ACTIVE'.
    const acctAfter = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctAfter!.contractStatus).toBe('PROBABLE_CHURN');
  });

  it('returns 422 ALREADY_DECIDED on a row that has already been approved or rejected', async () => {
    const { cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-twice@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'D', kittyType: 'BASE', currentArc: 100000 });
    const change = await seedPendingQuickRequest({ account: acct, performedByUserId: sam.id });

    // First decision goes through
    const first = await request(app)
      .post(`/commercial-changes/${change.id}/sam-quick-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'APPROVE' });
    expect(first.status).toBe(200);

    // Second attempt should be rejected
    const second = await request(app)
      .post(`/commercial-changes/${change.id}/sam-quick-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'REJECT' });
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/ALREADY_DECIDED/);
  });

  it('returns 422 NEW_BASE_NOT_LOCAL when account.kittyType is NEW', async () => {
    const { cookie } = await adminCookie();
    const sam = await seedUser({ email: 'sam-new@x.com', role: 'SAM' });
    const acct = await seedAccount({
      clientName: 'NEW co',
      kittyType: 'NEW',
      currentArc: 100000,
      onboardingDate: new Date('2026-04-10'),
    });
    const change = await seedPendingQuickRequest({ account: acct, performedByUserId: sam.id });

    const res = await request(app)
      .post(`/commercial-changes/${change.id}/sam-quick-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'APPROVE' });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/NEW_BASE_NOT_LOCAL/);
  });

  it('returns 404 on a non-existent commercial change id', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .post('/commercial-changes/00000000-0000-0000-0000-000000000000/sam-quick-decision')
      .set('Cookie', cookie)
      .send({ decision: 'APPROVE' });
    expect(res.status).toBe(404);
  });

  it('returns 403 to non-ADMIN users', async () => {
    const sam = await seedUser({ email: 'sam-no-decide@x.com', role: 'SAM' });
    const samToken = await tokenFor(sam.id, 'SAM');
    const acct = await seedAccount({ clientName: 'E', kittyType: 'BASE', currentArc: 100000 });
    const change = await seedPendingQuickRequest({ account: acct, performedByUserId: sam.id });

    const res = await request(app)
      .post(`/commercial-changes/${change.id}/sam-quick-decision`)
      .set('Cookie', `${SESSION_COOKIE}=${samToken}`)
      .send({ decision: 'APPROVE' });

    expect(res.status).toBe(403);
  });
});
