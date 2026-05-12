/**
 * Tests for the 21-day probable-churn retention workflow.
 *
 *   Day 0   commit DISCONNECTION → account PROBABLE_CHURN, prompt due +21d
 *   Day 21  SAM prompted → RETAIN or PROCEED
 *            RETAIN  → account back to ACTIVE
 *            PROCEED → account DISCONNECTING, scheduledTerminationAt = +10d,
 *                      CRM service order raised (if synced)
 *   Day 31  scheduledTerminationAt fires (lazy sweep on read) → TERMINATED
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';
import { prisma } from '../src/prisma.js';
import {
  setApprovalFileUploaderForTests,
  type ApprovalFileUploader,
  type ApprovalUploadInput,
} from '../src/services/storage/cloudinary-storage.js';

class FakeUploader implements ApprovalFileUploader {
  async uploadApprovalFile(input: ApprovalUploadInput) {
    const safe = input.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const publicId = `sam-software/po-and-mail-acceptance/${input.commercialChangeId}/test-${safe}`;
    return {
      publicId,
      secureUrl: `https://res.cloudinary.com/test/raw/upload/v1/${publicId}`,
      bytes: input.buffer.byteLength,
      format: null,
      originalFilename: input.originalName,
    };
  }
}

const PDF = Buffer.from('%PDF-1.4 test');

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
  setApprovalFileUploaderForTests(new FakeUploader());
  const mod = await import('../src/services/integrations/crm/index.js');
  mod.resetCrmClientCacheForTests();
});

async function adminCookie() {
  const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
  return { cookie: `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}`, user: admin };
}

async function raiseDisconnection(
  cookie: string,
  acctId: string,
  effectiveDate: string,
  opts: { externalCrmId?: string | null } = {},
) {
  void opts;
  return request(app)
    .post('/commercial-changes')
    .set('Cookie', cookie)
    .field('accountId', acctId)
    .field('changeType', 'DISCONNECTION')
    .field('newArc', '0')
    .field('effectiveDate', effectiveDate)
    .field('disconnectionCategoryId', '00000000-0000-0000-0000-000000000001')
    .field('disconnectionSubCategoryId', '00000000-0000-0000-0000-000000000002')
    .attach('approvalFile', PDF, 'disco.pdf')
    .attach('poFile', PDF, 'po.pdf');
}

describe('POST /commercial-changes/:id/retention-decision', () => {
  it('401 without cookie', async () => {
    const res = await request(app)
      .post('/commercial-changes/00000000-0000-0000-0000-000000000000/retention-decision')
      .send({ decision: 'RETAIN' });
    expect(res.status).toBe(401);
  });

  it('400 on invalid decision', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ currentArc: 600000, externalCrmId: null });
    const commit = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    expect(commit.status).toBe(201);
    const res = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'NOPE' });
    expect(res.status).toBe(400);
  });

  it('404 when commercial change does not exist', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .post('/commercial-changes/11111111-1111-1111-1111-111111111111/retention-decision')
      .set('Cookie', cookie)
      .send({ decision: 'RETAIN' });
    expect(res.status).toBe(404);
  });

  it('400 when the change is not a DISCONNECTION', async () => {
    const { cookie, user } = await adminCookie();
    const acct = await seedAccount({ currentArc: 600000 });
    // Create a non-disconnection change directly.
    const change = await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldArc: 600000,
        newArc: 720000,
        effectiveDate: new Date('2026-05-01'),
        clientApprovalAttached: true,
        createdBy: user.id,
      },
    });
    const res = await request(app)
      .post(`/commercial-changes/${change.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'RETAIN' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disconnection/i);
  });

  it('RETAIN returns the account to ACTIVE and stamps the decision', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ currentArc: 900000, externalCrmId: null });
    const commit = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    expect(commit.status).toBe(201);

    // Customer changes their mind — SAM retains them before day 21 (allowed).
    const res = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'RETAIN' });
    expect(res.status).toBe(200);
    expect(res.body.change.retentionDecision).toBe('RETAIN');
    expect(res.body.change.retentionDecidedAt).not.toBeNull();

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('ACTIVE');
    expect(Number(after?.currentArc)).toBe(900000);
  });

  it('PROCEED before retentionPromptDueAt is rejected — must wait for the 21-day window', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ currentArc: 900000, externalCrmId: null });
    const commit = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    expect(commit.status).toBe(201);

    // Prompt due 2026-05-22, today (in test seed) is well before that.
    const res = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/21[- ]day/i);

    // Account stays in probable churn.
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('PROBABLE_CHURN');
  });

  it('PROCEED on/after day 21 moves account to DISCONNECTING and sets scheduledTerminationAt', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ currentArc: 900000, externalCrmId: null });
    const commit = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    expect(commit.status).toBe(201);

    // Fast-forward: simulate that today is past retentionPromptDueAt.
    await prisma.commercialChange.update({
      where: { id: commit.body.commercialChange.id },
      data: { retentionPromptDueAt: new Date('2026-05-01') },
    });

    const res = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });
    expect(res.status).toBe(200);
    expect(res.body.change.retentionDecision).toBe('PROCEED');

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('DISCONNECTING');
    // Customer still paying until day 31.
    expect(Number(after?.currentArc)).toBe(900000);

    const change = await prisma.commercialChange.findUnique({
      where: { id: commit.body.commercialChange.id },
    });
    // scheduledTerminationAt = retentionDecidedAt + 10d. Today is the decision day.
    expect(change?.scheduledTerminationAt).not.toBeNull();
    const days = Math.round(
      ((change!.scheduledTerminationAt!.getTime() - change!.retentionDecidedAt!.getTime()) /
        86_400_000),
    );
    expect(days).toBe(10);
  });

  it('PROCEED on CRM-synced account raises a CRM service order', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      currentArc: 900000,
      externalCrmId: 'crm-procd',
    });
    const commit = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    expect(commit.status).toBe(201);
    // No CRM order yet — disconnection commit is SAM-side only.
    expect(stub.serviceOrders).toHaveLength(0);

    // Day 21 → PROCEED.
    await prisma.commercialChange.update({
      where: { id: commit.body.commercialChange.id },
      data: { retentionPromptDueAt: new Date('2026-05-01') },
    });
    const res = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });
    expect(res.status).toBe(200);

    // CRM order created now.
    expect(stub.serviceOrders).toHaveLength(1);
    expect(stub.serviceOrders[0]!.orderType).toBe('DISCONNECTION');

    const after = await prisma.commercialChange.findUnique({
      where: { id: commit.body.commercialChange.id },
    });
    expect(after?.crmServiceOrderId).not.toBeNull();
  });

  it('PROCEED when CRM rejects the order: account still DISCONNECTING, crmStatus=FAILED, error captured in audit log', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    stub.failNextCreate = { status: 400, message: 'Unknown disconnection category' };
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      currentArc: 900000,
      externalCrmId: 'crm-failpath',
    });
    const commit = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    await prisma.commercialChange.update({
      where: { id: commit.body.commercialChange.id },
      data: { retentionPromptDueAt: new Date('2026-05-01') },
    });

    const res = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });
    expect(res.status).toBe(200);

    // Account still transitions — SAM committed to disconnecting.
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('DISCONNECTING');

    // But crmStatus is FAILED so the UI can flag the broken hand-off.
    const change = await prisma.commercialChange.findUnique({
      where: { id: commit.body.commercialChange.id },
    });
    expect(change?.crmStatus).toBe('FAILED');
    expect(change?.crmServiceOrderId).toBeNull();

    // Audit log carries the underlying CRM error message for investigation.
    const audit = await prisma.auditLog.findFirst({
      where: {
        entityId: commit.body.commercialChange.id,
        action: 'RETENTION_PROCEEDED',
      },
    });
    expect(audit).not.toBeNull();
    const payload = audit!.payload as { crmError?: string };
    expect(payload.crmError).toMatch(/Unknown disconnection category/);
  });

  it('cannot re-decide after PROCEED (state is terminal)', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ currentArc: 900000, externalCrmId: null });
    const commit = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    await prisma.commercialChange.update({
      where: { id: commit.body.commercialChange.id },
      data: { retentionPromptDueAt: new Date('2026-05-01') },
    });
    const first = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'RETAIN' });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already been decided/i);
  });
});

describe('Lazy termination sweep (day 31)', () => {
  it('terminates DISCONNECTING accounts whose scheduledTerminationAt has passed when probable-churn is read', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ currentArc: 900000, externalCrmId: null });
    const commit = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    await prisma.commercialChange.update({
      where: { id: commit.body.commercialChange.id },
      data: { retentionPromptDueAt: new Date('2026-05-01') },
    });
    await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });

    // Backdate scheduledTerminationAt so the sweep should pick it up.
    await prisma.commercialChange.update({
      where: { id: commit.body.commercialChange.id },
      data: { scheduledTerminationAt: new Date('2026-04-01') },
    });

    // Hitting any endpoint that fires the lazy sweep — /probable-churn does.
    const sweep = await request(app).get('/probable-churn').set('Cookie', cookie);
    expect(sweep.status).toBe(200);

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('TERMINATED');
    expect(Number(after?.currentArc)).toBe(0);

    const change = await prisma.commercialChange.findUnique({
      where: { id: commit.body.commercialChange.id },
    });
    expect(change?.accountAppliedAt).not.toBeNull();
  });
});

describe('Auto-retain on non-disconnection commit', () => {
  it('Rate revision committed on a PROBABLE_CHURN account auto-retains the pending disconnection', async () => {
    // Surface mechanic for the "Retain → opens rate-revision form" flow.
    // SAM clicks Retain in the queue, fills in a rate-revision form, and
    // the disconnection on this account is resolved as RETAIN by the commit.
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      currentArc: 900000,
      bandwidthMbps: 100,
      externalCrmId: null,
    });
    const disco = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    expect(disco.status).toBe(201);

    // Customer is in PROBABLE_CHURN, disconnection has no decision yet.
    let after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('PROBABLE_CHURN');

    // Now SAM commits a rate revision (bandwidth uplift at same ARC).
    const rev = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'RATE_REVISION')
      .field('newArc', '900000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-05')
      .field('reason', 'Bandwidth uplift to retain the customer')
      .attach('approvalFile', PDF, 'approval.pdf')
      .attach('poFile', PDF, 'po.pdf');
    expect(rev.status).toBe(201);

    // Pending disconnection is now RETAIN, account back to ACTIVE.
    after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('ACTIVE');
    const pending = await prisma.commercialChange.findUnique({
      where: { id: disco.body.commercialChange.id },
    });
    expect(pending?.retentionDecision).toBe('RETAIN');
    expect(pending?.retentionDecidedAt).not.toBeNull();

    // Audit trail distinguishes auto vs manual.
    const audits = await prisma.auditLog.findMany({
      where: { entityId: disco.body.commercialChange.id },
    });
    expect(audits.some((a) => a.action === 'RETENTION_RETAINED_AUTO')).toBe(true);
  });

  it('Upgrade on PROBABLE_CHURN also auto-retains (any non-disconnection signals "staying")', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      currentArc: 600000,
      bandwidthMbps: 100,
      externalCrmId: null,
    });
    const disco = await raiseDisconnection(cookie, acct.id, '2026-05-01');
    expect(disco.status).toBe(201);

    const up = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-05')
      .attach('approvalFile', PDF, 'approval.pdf')
      .attach('poFile', PDF, 'po.pdf');
    expect(up.status).toBe(201);

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('ACTIVE');
    const pending = await prisma.commercialChange.findUnique({
      where: { id: disco.body.commercialChange.id },
    });
    expect(pending?.retentionDecision).toBe('RETAIN');
  });

  it('Commit on an account without a pending disconnection is a no-op (no auto-retain side-effect)', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      currentArc: 600000,
      bandwidthMbps: 100,
      externalCrmId: null,
    });
    const up = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-05')
      .attach('approvalFile', PDF, 'approval.pdf')
      .attach('poFile', PDF, 'po.pdf');
    expect(up.status).toBe(201);
    const audits = await prisma.auditLog.findMany({
      where: { action: 'RETENTION_RETAINED_AUTO' },
    });
    expect(audits).toHaveLength(0);
  });
});

describe('GET /probable-churn', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/probable-churn');
    expect(res.status).toBe(401);
  });

  it('lists accounts in PROBABLE_CHURN and DISCONNECTING with at-risk ARC + days remaining', async () => {
    const { cookie } = await adminCookie();
    const acctA = await seedAccount({
      clientName: 'PendingCo',
      currentArc: 500000,
      externalCrmId: null,
    });
    const acctB = await seedAccount({
      clientName: 'AlreadyDecided',
      currentArc: 800000,
      externalCrmId: null,
    });
    await raiseDisconnection(cookie, acctA.id, '2026-05-01');
    const commitB = await raiseDisconnection(cookie, acctB.id, '2026-04-01');

    // Move B past day 21 + PROCEED to mark it DISCONNECTING.
    await prisma.commercialChange.update({
      where: { id: commitB.body.commercialChange.id },
      data: { retentionPromptDueAt: new Date('2026-04-01') },
    });
    await request(app)
      .post(`/commercial-changes/${commitB.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });

    const res = await request(app).get('/probable-churn').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows).toHaveLength(2);
    const totalAtRisk = res.body.summary.atRiskArc;
    expect(totalAtRisk).toBe(500000 + 800000);

    const pendingRow = res.body.rows.find(
      (r: { customer: { id: string } }) => r.customer.id === acctA.id,
    );
    expect(pendingRow.account.contractStatus).toBe('PROBABLE_CHURN');
    expect(pendingRow.retentionDecision).toBeNull();
    expect(typeof pendingRow.daysUntilPrompt).toBe('number');

    const decidedRow = res.body.rows.find(
      (r: { customer: { id: string } }) => r.customer.id === acctB.id,
    );
    expect(decidedRow.account.contractStatus).toBe('DISCONNECTING');
    expect(decidedRow.retentionDecision).toBe('PROCEED');
    expect(typeof decidedRow.daysUntilTermination).toBe('number');
  });

  it('SAMs see only their own probable-churn accounts; ADMIN sees all', async () => {
    const samA = await seedUser({ email: 'sa@x.com', role: 'SAM', name: 'Sam A' });
    const samB = await seedUser({ email: 'sb@x.com', role: 'SAM', name: 'Sam B' });
    const admin = await seedUser({ email: 'ad@x.com', role: 'ADMIN' });

    const acctA = await seedAccount({
      clientName: 'A',
      currentArc: 500000,
      samOwnerId: samA.id,
      externalCrmId: null,
    });
    const acctB = await seedAccount({
      clientName: 'B',
      currentArc: 700000,
      samOwnerId: samB.id,
      externalCrmId: null,
    });

    const adminTok = `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}`;
    await raiseDisconnection(adminTok, acctA.id, '2026-05-01');
    await raiseDisconnection(adminTok, acctB.id, '2026-05-01');

    const samATok = `${SESSION_COOKIE}=${await tokenFor(samA.id, 'SAM')}`;
    const samARes = await request(app).get('/probable-churn').set('Cookie', samATok);
    expect(samARes.body.rows).toHaveLength(1);
    expect(samARes.body.rows[0].customer.id).toBe(acctA.id);

    const adminRes = await request(app).get('/probable-churn').set('Cookie', adminTok);
    expect(adminRes.body.rows).toHaveLength(2);
  });
});
