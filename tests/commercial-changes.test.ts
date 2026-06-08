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

/**
 * In-memory uploader stub. Tests can read `.uploads` to assert upload
 * happened with the expected args. Returns a deterministic Cloudinary-like
 * URL so assertions on the URL shape stay readable.
 */
class FakeApprovalUploader implements ApprovalFileUploader {
  uploads: ApprovalUploadInput[] = [];
  async uploadApprovalFile(input: ApprovalUploadInput) {
    this.uploads.push(input);
    const safe = input.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const publicId = `sam-software/po-and-mail-acceptance/${input.commercialChangeId}/test-${safe}`;
    return {
      publicId,
      secureUrl: `https://res.cloudinary.com/test-cloud/raw/upload/v1/${publicId}`,
      bytes: input.buffer.byteLength,
      format: null,
      originalFilename: input.originalName,
    };
  }
}

let fakeUploader: FakeApprovalUploader;

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
  fakeUploader = new FakeApprovalUploader();
  setApprovalFileUploaderForTests(fakeUploader);
});

async function adminCookie() {
  const admin = await seedUser({ email: 'admin@x.com', name: 'Admin', role: 'ADMIN' });
  return { cookie: `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}`, user: admin };
}

const PDF_BUFFER = Buffer.from('%PDF-1.4 mock approval');

describe('POST /commercial-changes', () => {
  it('401 without cookie', async () => {
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });
    const res = await request(app)
      .post('/commercial-changes')
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(401);
  });

  it('422 when neither file is attached (at least one required)', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('effectiveDate', '2026-05-01');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/at least one document/i);
  });

  it('400 on invalid body', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', 'not-a-uuid')
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(400);
  });

  it('404 when account does not exist', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', '00000000-0000-0000-0000-000000000000')
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(404);
  });

  it('accepts any file extension (no allowlist; size cap is the only limit)', async () => {
    // The old behavior allow-listed .eml/.msg/.pdf and 422'd anything else.
    // Product asked to drop the allowlist so SAMs can attach scans, screenshots,
    // Word docs, etc. — anything the customer actually sent them.
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.txt');
    // 201 (or any non-4xx) — the upload no longer fails on extension.
    expect([200, 201]).toContain(res.status);
  });

  it('accepts approval-only (PO not attached)', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf');
    expect(res.status).toBe(201);
    expect(res.body.commercialChange.approvalFileUrl).toMatch(/^https:\/\//);
    expect(res.body.commercialChange.poFileUrl).toBeNull();
    expect(fakeUploader.uploads).toHaveLength(1);
    expect(fakeUploader.uploads[0]?.kind).toBe('approval');
  });

  it('accepts po-only (approval not attached)', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('effectiveDate', '2026-05-01')
      .attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);
    expect(res.body.commercialChange.approvalFileUrl).toBeNull();
    expect(res.body.commercialChange.poFileUrl).toMatch(/^https:\/\//);
    expect(fakeUploader.uploads).toHaveLength(1);
    expect(fakeUploader.uploads[0]?.kind).toBe('po');
  });

  it('UPGRADE: persists change + audit log; account NOT updated until CRM COMPLETED', async () => {
    const { cookie, user } = await adminCookie();
    // externalCrmId set → CRM-synced flow: account state must wait for
    // CRM to reach COMPLETED before mirroring. Excel-imported accounts
    // (without externalCrmId) skip CRM entirely — covered separately below.
    const acct = await seedAccount({
      clientName: 'Acme',
      currentArc: 600000,
      bandwidthMbps: 100,
      externalCrmId: 'crm-acme-pending',
    });

    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .field('reason', 'Customer capacity expansion')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');

    expect(res.status).toBe(201);
    expect(res.body.commercialChange.changeType).toBe('UPGRADE');
    expect(res.body.commercialChange.oldArc).toBe(600000);
    expect(res.body.commercialChange.newArc).toBe(720000);
    expect(res.body.commercialChange.approvalFileUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    expect(res.body.commercialChange.approvalFilePublicId).toMatch(/^sam-software\/po-and-mail-acceptance\//);
    // Uploader was invoked twice — once for approval, once for PO — both
    // under the same commercialChangeId folder (different `kind` sub-folder).
    expect(fakeUploader.uploads).toHaveLength(2);
    const approvalCall = fakeUploader.uploads.find((u) => u.kind === 'approval');
    const poCall = fakeUploader.uploads.find((u) => u.kind === 'po');
    expect(approvalCall?.originalName).toBe('approval.pdf');
    expect(poCall?.originalName).toBe('po.pdf');
    expect(approvalCall?.commercialChangeId).toBe(poCall?.commercialChangeId);
    expect(res.body.emailDraft.subject).toContain('Acme');
    expect(res.body.emailDraft.body).toContain('Old ARC:');

    // Account state UNCHANGED until CRM COMPLETED — SAM stops mirroring
    // optimistically.
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(Number(after?.currentArc)).toBe(600000);
    expect(after?.bandwidthMbps).toBe(100);

    // Audit log written. Filter to the COMMIT action — the notification
    // bridge also writes a NOTIFY_ACCOUNTS_TEAM row (SKIPPED when the env
    // toggle is off, which is the test default).
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'CommercialChange', action: 'COMMIT' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.performedBy).toBe(user.id);
  });

  it('DISCONNECTION: enters PROBABLE_CHURN, NOT terminated, 21-day retention prompt scheduled', async () => {
    // Disconnection commit no longer terminates — the account enters the
    // 21-day probable-churn window. SAM is prompted on day 21 to either
    // RETAIN or PROCEED. CRM service-order is NOT raised until PROCEED.
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'GoneCo',
      currentArc: 900000,
      externalCrmId: 'crm-goneco-pending',
    });

    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newArc', '0')
      .field('effectiveDate', '2026-05-01')
      .field('reason', 'Customer churn')
      .field('disconnectionCategoryId', '00000000-0000-0000-0000-000000000001')
      .field('disconnectionSubCategoryId', '00000000-0000-0000-0000-000000000002')
      .attach('approvalFile', PDF_BUFFER, 'termination.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');

    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'probable-churn' });

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('PROBABLE_CHURN');
    // ARC unchanged — customer is still paying through the 21-day window.
    expect(Number(after?.currentArc)).toBe(900000);

    const change = await prisma.commercialChange.findUnique({
      where: { id: res.body.commercialChange.id },
    });
    // retentionPromptDueAt = effectiveDate (2026-05-01) + 21d = 2026-05-22.
    expect(change?.retentionPromptDueAt?.toISOString().slice(0, 10)).toBe('2026-05-22');
    expect(change?.retentionDecision).toBeNull();
    expect(change?.scheduledTerminationAt).toBeNull();
    // No CRM order created on disconnection commit.
    expect(change?.crmServiceOrderId).toBeNull();
  });

  it('DOWNGRADE: persists negative-delta change', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Acme',
      currentArc: 600000,
      externalCrmId: 'crm-acme-down',
    });

    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DOWNGRADE')
      .field('newArc', '480000')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');

    expect(res.status).toBe(201);
    expect(res.body.commercialChange.oldArc).toBe(600000);
    expect(res.body.commercialChange.newArc).toBe(480000);
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    // Pre-CRM-COMPLETED: account stays at the OLD value.
    expect(Number(after?.currentArc)).toBe(600000);
  });
});

describe('POST /commercial-changes — lifecycle guards', () => {
  it('422 ACCOUNT_TERMINATED when raising any change on a terminated customer', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'GoneCo',
      currentArc: 0,
      contractStatus: 'TERMINATED',
      externalCrmId: null,
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf')
      .attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/^ACCOUNT_TERMINATED:/);
    expect(res.body.error).toMatch(/disconnected/i);
  });

  it('422 ACCOUNT_DISCONNECTING when raising any change on an account in the 10-day notice', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'NoticeCo',
      currentArc: 600000,
      contractStatus: 'DISCONNECTING',
      externalCrmId: null,
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'RATE_REVISION')
      .field('newArc', '600000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf')
      .attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/^ACCOUNT_DISCONNECTING:/);
    expect(res.body.error).toMatch(/notice/i);
  });

  it('422 DISCONNECTION_IN_FLIGHT when raising a second disconnection on a PROBABLE_CHURN account', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'PendingCo',
      currentArc: 600000,
      contractStatus: 'PROBABLE_CHURN',
      externalCrmId: null,
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newArc', '0')
      .field('effectiveDate', '2026-05-01')
      .field('disconnectionCategoryId', 'commercial-issue')
      .field('disconnectionSubCategoryId', 'shifted-to-broadband')
      .attach('approvalFile', PDF_BUFFER, 'disco.pdf')
      .attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/^DISCONNECTION_IN_FLIGHT:/);
    expect(res.body.error).toMatch(/retain/i);
  });

  it('Rate revision / upgrade / downgrade on PROBABLE_CHURN still works — that path auto-retains', async () => {
    // Counterpoint: PROBABLE_CHURN must NOT block retention plays.
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'StayingCo',
      currentArc: 600000,
      bandwidthMbps: 100,
      contractStatus: 'PROBABLE_CHURN',
      externalCrmId: null,
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'RATE_REVISION')
      .field('newArc', '600000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf')
      .attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);
  });
});

describe('Account update on CRM COMPLETED', () => {
  beforeEach(async () => {
    const mod = await import('../src/services/integrations/crm/index.js');
    mod.resetCrmClientCacheForTests();
  });

  it('refreshCrmStatus applies the change to the account when CRM moves to COMPLETED', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Acme',
      currentArc: 600000,
      bandwidthMbps: 100,
      externalCrmId: 'crm-acme-completed',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);

    // Account untouched right after submission.
    let after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(Number(after?.currentArc)).toBe(600000);
    expect(after?.bandwidthMbps).toBe(100);

    // Simulate CRM advancing the order to COMPLETED, then SAM refreshing.
    const order = stub.serviceOrders[0]!;
    order.status = 'COMPLETED';
    const refreshRes = await request(app)
      .post(`/commercial-changes/${res.body.commercialChange.id}/refresh-status`)
      .set('Cookie', cookie);
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.change.crmStatus).toBe('COMPLETED');
    expect(refreshRes.body.change.accountAppliedAt).not.toBeNull();

    // Account is NOW updated.
    after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(Number(after?.currentArc)).toBe(720000);
    expect(after?.bandwidthMbps).toBe(200);

    // Idempotent — refreshing again doesn't double-apply.
    const refreshAgain = await request(app)
      .post(`/commercial-changes/${res.body.commercialChange.id}/refresh-status`)
      .set('Cookie', cookie);
    expect(refreshAgain.status).toBe(200);
    after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(Number(after?.currentArc)).toBe(720000);
  });

  it('DISCONNECTION + CRM COMPLETED does NOT terminate the account — scheduledTerminationAt is the source of truth', async () => {
    // The CRM service order for a disconnection is created only after the
    // day-21 PROCEED decision. Even when CRM races through to COMPLETED in
    // < 10 days, the account stays in DISCONNECTING until the contractual
    // 10-day notice window expires (scheduledTerminationAt). The lazy
    // sweep does the actual termination.
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'GoneCo',
      currentArc: 900000,
      externalCrmId: 'crm-gone-completed',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newArc', '0')
      .field('effectiveDate', '2026-05-01')
      .field('disconnectionCategoryId', 'cat-1')
      .field('disconnectionSubCategoryId', 'sub-1')
      .attach('approvalFile', PDF_BUFFER, 'disco.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);

    // Day 0: PROBABLE_CHURN. No CRM order yet.
    let after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('PROBABLE_CHURN');
    expect(stub.serviceOrders).toHaveLength(0);

    // Simulate day 21+ → SAM picks PROCEED. CRM order is now raised.
    await prisma.commercialChange.update({
      where: { id: res.body.commercialChange.id },
      data: { retentionPromptDueAt: new Date('2026-05-01') },
    });
    const decideRes = await request(app)
      .post(`/commercial-changes/${res.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });
    expect(decideRes.status).toBe(200);
    expect(stub.serviceOrders).toHaveLength(1);

    // CRM races to COMPLETED — but the account does NOT terminate yet.
    stub.serviceOrders[0]!.status = 'COMPLETED';
    await request(app)
      .post(`/commercial-changes/${res.body.commercialChange.id}/refresh-status`)
      .set('Cookie', cookie);

    after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('DISCONNECTING');
    expect(Number(after?.currentArc)).toBe(900000);
  });
});

describe('GET /commercial-changes', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/commercial-changes');
    expect(res.status).toBe(401);
  });

  it('returns empty list when no changes exist', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app).get('/commercial-changes').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([]);
  });

  it('lists all changes for ADMIN; filters by type', async () => {
    const { cookie, user } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldArc: 600000,
        newArc: 720000,
        effectiveDate: new Date('2026-04-15'),
        clientApprovalAttached: true,
        createdBy: user.id,
      },
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'DOWNGRADE',
        oldArc: 720000,
        newArc: 660000,
        effectiveDate: new Date('2026-04-20'),
        clientApprovalAttached: true,
        createdBy: user.id,
      },
    });
    const all = await request(app).get('/commercial-changes').set('Cookie', cookie);
    expect(all.body.changes).toHaveLength(2);
    const upgrades = await request(app).get('/commercial-changes?type=UPGRADE').set('Cookie', cookie);
    expect(upgrades.body.changes).toHaveLength(1);
    expect(upgrades.body.changes[0].changeType).toBe('UPGRADE');
    expect(upgrades.body.changes[0].account.clientName).toBe('Acme');
  });

  it('400 on invalid type', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app).get('/commercial-changes?type=BOGUS').set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('SAM only sees changes for their own accounts', async () => {
    const sam1 = await seedUser({ email: 'sam1@x.com', role: 'SAM' });
    const sam2 = await seedUser({ email: 'sam2@x.com', role: 'SAM' });
    const a1 = await seedAccount({ clientName: 'A', currentArc: 120000, samOwnerId: sam1.id });
    const a2 = await seedAccount({ clientName: 'B', currentArc: 240000, samOwnerId: sam2.id });
    await prisma.commercialChange.create({
      data: {
        accountId: a1.id, changeType: 'UPGRADE', oldArc: 120000, newArc: 144000,
        effectiveDate: new Date(), clientApprovalAttached: true, createdBy: sam1.id,
      },
    });
    await prisma.commercialChange.create({
      data: {
        accountId: a2.id, changeType: 'UPGRADE', oldArc: 240000, newArc: 300000,
        effectiveDate: new Date(), clientApprovalAttached: true, createdBy: sam2.id,
      },
    });
    const cookie = `${SESSION_COOKIE}=${await tokenFor(sam1.id, 'SAM')}`;
    const res = await request(app).get('/commercial-changes').set('Cookie', cookie);
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].account.clientName).toBe('A');
  });
});

describe('CRM service-order bridge', () => {
  beforeEach(async () => {
    // Reset module cache so getCrmClient() returns a fresh stub each test.
    const mod = await import('../src/services/integrations/crm/index.js');
    mod.resetCrmClientCacheForTests();
    delete process.env.CRM_API_BASE_URL;
    delete process.env.CRM_SERVICE_EMAIL;
    delete process.env.CRM_SERVICE_PASSWORD;
  });

  it('crm.ok=disabled when kill-switch is off', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'false';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Acme',
      currentArc: 600000,
      externalCrmId: 'crm-acme-1',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'disabled' });
    expect(res.body.commercialChange.crmServiceOrderId).toBeNull();
  });

  it('UPGRADE: forwards ARC + bandwidth to CRM and stores order ref', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Acme',
      currentArc: 600000,
      bandwidthMbps: 100,
      externalCrmId: 'crm-acme-2',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .field('mailReceivedDate', '2026-04-25')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);

    // CRM was called with the right shape — ARC pass-through, customerId = externalCrmId
    expect(stub.createServiceOrderCalls).toHaveLength(1);
    const call = stub.createServiceOrderCalls[0]!;
    expect(call.customerId).toBe('crm-acme-2');
    expect(call.orderType).toBe('UPGRADE');
    expect(call.newArc).toBe(720000);
    expect(call.newBandwidth).toBe(200);
    // Mail-received date is forwarded so CRM can render when the customer
    // actually consented. ISO date only, no time.
    expect(call.mailReceivedDate).toBe('2026-04-25');
    // SAM internal ticket id is round-tripped via the notes field for
    // cross-system traceability.
    expect(call.notes).toMatch(/^SAM-[A-F0-9]{8}$/);
    // Persisted on the SAM row too.
    expect(res.body.commercialChange.mailReceivedDate).toContain('2026-04-25');

    // SAM row stores the CRM linkage
    expect(res.body.crm.ok).toBe(true);
    expect(res.body.commercialChange.crmOrderNumber).toMatch(/^SO\/STUB\//);
    expect(res.body.commercialChange.crmStatus).toBe('PENDING_DOCS_REVIEW');
  });

  it('preserves user notes alongside the SAM ref in CRM notes', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Acme',
      currentArc: 600000,
      bandwidthMbps: 100,
      externalCrmId: 'crm-acme-notes',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .field('notes', 'Customer expanding to add 50 devices')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);
    const call = stub.createServiceOrderCalls[0]!;
    expect(call.notes).toMatch(/^SAM-[A-F0-9]{8} \| Customer expanding/);
  });

  it('forwards Cloudinary approval URL to CRM as approvalFileUrl', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Acme',
      currentArc: 600000,
      bandwidthMbps: 100,
      externalCrmId: 'crm-acme-cloudinary',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'customer_approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);

    const call = stub.createServiceOrderCalls[0]!;
    expect(call.approvalFileUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    expect(call.approvalFileUrl).toContain('customer_approval.pdf');

    // The same URL is persisted on the SAM-side row + audit log.
    const row = await prisma.commercialChange.findUnique({ where: { id: res.body.commercialChange.id } });
    expect(row?.approvalFileUrl).toBe(call.approvalFileUrl);
    expect(row?.approvalFilePublicId).toMatch(/^sam-software\/po-and-mail-acceptance\//);
  });

  it('DISCONNECTION: CRM order is raised on day-21 PROCEED, not on commit', async () => {
    // Day 0 commit no longer hits CRM — the disconnection sits in the
    // 21-day probable-churn window first. Only when SAM picks PROCEED does
    // the service-order POST go out with category/sub-category and no ARC.
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'GoneCo',
      currentArc: 900000,
      externalCrmId: 'crm-gone-1',
    });
    const commit = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newArc', '0')
      .field('effectiveDate', '2026-05-01')
      .field('disconnectionCategoryId', 'cat-1')
      .field('disconnectionSubCategoryId', 'sub-1')
      .field('disconnectionReason', 'Office closing')
      .attach('approvalFile', PDF_BUFFER, 'disco.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(commit.status).toBe(201);
    expect(commit.body.crm).toEqual({ ok: 'probable-churn' });
    // No CRM order yet.
    expect(stub.createServiceOrderCalls).toHaveLength(0);

    // Backdate the prompt and pick PROCEED — now CRM gets called.
    await prisma.commercialChange.update({
      where: { id: commit.body.commercialChange.id },
      data: { retentionPromptDueAt: new Date('2026-05-01') },
    });
    const decide = await request(app)
      .post(`/commercial-changes/${commit.body.commercialChange.id}/retention-decision`)
      .set('Cookie', cookie)
      .send({ decision: 'PROCEED' });
    expect(decide.status).toBe(200);

    const call = stub.createServiceOrderCalls[0]!;
    expect(call.orderType).toBe('DISCONNECTION');
    // SAM-local slug IDs are forwarded to CRM — both systems must agree on
    // the taxonomy (CRM seeds matching rows; see docs/INTEGRATION_CRM.md).
    expect(call.disconnectionCategoryId).toBe('cat-1');
    expect(call.disconnectionSubCategoryId).toBe('sub-1');
    expect(call.disconnectionReason).toBe('Office closing');
    // Notes carry the SAM ref + human-readable reason for the CRM operator
    // even when the slug IDs are valid.
    expect(call.notes).toContain('SAM-');
    expect(call.notes).toContain('Office closing');
    expect(call.newArc).toBeUndefined();
    expect(call.newBandwidth).toBeUndefined();
  });

  it('surfaces CRM 4xx as crm.ok=false but still saves SAM row', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    stub.failNextCreate = { status: 400, message: 'Customer not found' };
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Bad',
      currentArc: 120000,
      externalCrmId: 'crm-bad-1',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '240000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    // SAM still returns 201 — the row was saved + the file is on disk.
    expect(res.status).toBe(201);
    expect(res.body.crm.ok).toBe(false);
    expect(res.body.crm.status).toBe(400);
    expect(res.body.crm.error).toMatch(/Customer not found/);
    // No CRM linkage on the row
    expect(res.body.commercialChange.crmServiceOrderId).toBeNull();

    // But the SAM row was saved
    const rows = await prisma.commercialChange.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.crmServiceOrderId).toBeNull();
  });

  it('rejects DISCONNECTION without category ids', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'false';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'X',
      currentArc: 120000,
      externalCrmId: 'crm-x-1',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newArc', '0')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'disco.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disconnectionCategoryId/);
  });

  it('UPGRADE on Excel-imported account (no externalCrmId): applies account state immediately', async () => {
    // No CRM service-order can be raised — there's nothing to wait on.
    // The dashboard must reflect the change at once.
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'ExcelCo',
      currentArc: 600000,
      bandwidthMbps: 100,
      externalCrmId: null,
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '720000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'local-only' });

    // Account row updated immediately — dashboards read account.currentArc.
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(Number(after?.currentArc)).toBe(720000);
    expect(after?.bandwidthMbps).toBe(200);

    // Idempotency marker stamped on the change row.
    const change = await prisma.commercialChange.findUnique({
      where: { id: res.body.commercialChange.id },
    });
    expect(change?.accountAppliedAt).not.toBeNull();
  });

  it('DISCONNECTION on Excel-imported account: probable-churn applies the same way (no CRM, no immediate termination)', async () => {
    // Per design: 21-day retention window applies to all customers
    // regardless of CRM-sync status. Imported customers don't skip it.
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'ExcelGone',
      currentArc: 900000,
      externalCrmId: null,
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newArc', '0')
      .field('effectiveDate', '2026-05-01')
      .field('reason', 'Customer churn')
      .field('disconnectionCategoryId', '00000000-0000-0000-0000-000000000001')
      .field('disconnectionSubCategoryId', '00000000-0000-0000-0000-000000000002')
      .attach('approvalFile', PDF_BUFFER, 'disco.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'probable-churn' });

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('PROBABLE_CHURN');
    // Customer still pays — ARC unchanged until day 31.
    expect(Number(after?.currentArc)).toBe(900000);
  });

  it('local-only path runs even when the CRM kill-switch is off', async () => {
    // For accounts without externalCrmId, the kill-switch is irrelevant —
    // there's no CRM call to gate. Apply immediately either way.
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'false';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'ExcelCo2',
      currentArc: 600000,
      externalCrmId: null,
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DOWNGRADE')
      .field('newArc', '480000')
      .field('effectiveDate', '2026-05-01')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf').attach('poFile', PDF_BUFFER, 'po.pdf');
    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'local-only' });
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(Number(after?.currentArc)).toBe(480000);
  });
});

describe('Quick disconnect (DISCONNECTION + mode=QUICK)', () => {
  beforeEach(() => {
    // Feature flag is opt-in; reset to a known state per test so order doesn't matter.
    delete process.env.QUICK_DISCONNECT_ENABLED;
    // Stub CRM out so these tests don't try to call a real CRM client.
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'false';
  });

  async function postQuick(
    cookie: string,
    accountId: string,
    overrides: Partial<{ days: string; reason: string; mode: string }> = {},
  ) {
    return request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', accountId)
      .field('changeType', 'DISCONNECTION')
      .field('newArc', '0')
      .field('effectiveDate', '2026-05-01')
      .field('disconnectionCategoryId', 'cat-test')
      .field('disconnectionSubCategoryId', 'sub-test')
      .field('disconnectionMode', overrides.mode ?? 'QUICK')
      .field('quickRequestedDays', overrides.days ?? '7')
      .field('quickApprovalReason', overrides.reason ?? 'Customer already shut down operations.')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf');
  }

  it('rejects mode=QUICK with 422 when QUICK_DISCONNECT_ENABLED is not true', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'X', currentArc: 120000 });
    const res = await postQuick(cookie, acct.id);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/QUICK_DISCONNECT_DISABLED/);
  });

  it('accepts mode=QUICK and flips the account to PENDING_QUICK_APPROVAL', async () => {
    process.env.QUICK_DISCONNECT_ENABLED = 'true';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'X', currentArc: 120000 });
    const res = await postQuick(cookie, acct.id, { days: '5' });
    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'pending-quick-approval' });

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('PENDING_QUICK_APPROVAL');

    // Commercial change row has the quick metadata persisted.
    const cc = await prisma.commercialChange.findFirst({
      where: { accountId: acct.id },
    });
    expect(cc?.disconnectionMode).toBe('QUICK');
    expect(cc?.quickRequestedDays).toBe(5);
    expect(cc?.quickApprovalReason).toMatch(/Customer already shut down/);

    // No CRM service-order yet — that happens later via the approval webhook.
    expect(cc?.crmServiceOrderId).toBeNull();
  });

  it('rejects quickRequestedDays > 15 with 422', async () => {
    process.env.QUICK_DISCONNECT_ENABLED = 'true';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'X', currentArc: 120000 });
    const res = await postQuick(cookie, acct.id, { days: '20' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/QUICK_DISCONNECT_INVALID_DAYS/);
  });

  it('rejects too-short quickApprovalReason with 422', async () => {
    process.env.QUICK_DISCONNECT_ENABLED = 'true';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'X', currentArc: 120000 });
    const res = await postQuick(cookie, acct.id, { reason: 'too short' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/QUICK_DISCONNECT_REASON_REQUIRED/);
  });

  it('refuses a second commercial change while account is PENDING_QUICK_APPROVAL', async () => {
    process.env.QUICK_DISCONNECT_ENABLED = 'true';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'X', currentArc: 120000 });
    const first = await postQuick(cookie, acct.id);
    expect(first.status).toBe(201);

    // Now try to raise any other change — must be blocked.
    const second = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newArc', '200000')
      .field('effectiveDate', '2026-05-10')
      .attach('approvalFile', PDF_BUFFER, 'approval.pdf');
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/ACCOUNT_PENDING_QUICK_APPROVAL/);
  });
});
