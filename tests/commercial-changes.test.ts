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

async function adminCookie() {
  const admin = await seedUser({ email: 'admin@x.com', name: 'Admin', role: 'ADMIN' });
  return { cookie: `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}`, user: admin };
}

const PDF_BUFFER = Buffer.from('%PDF-1.4 mock approval');

describe('POST /commercial-changes', () => {
  it('401 without cookie', async () => {
    const acct = await seedAccount({ clientName: 'Acme', currentMrr: 50000 });
    const res = await request(app)
      .post('/commercial-changes')
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.pdf');
    expect(res.status).toBe(401);
  });

  it('422 when no file is attached (HARD GATE)', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentMrr: 50000 });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('effectiveDate', '2026-05-01');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/mandatory/i);
  });

  it('400 on invalid body', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', 'not-a-uuid')
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.pdf');
    expect(res.status).toBe(400);
  });

  it('404 when account does not exist', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', '00000000-0000-0000-0000-000000000000')
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.pdf');
    expect(res.status).toBe(404);
  });

  it('422 when file extension is not .eml/.msg/.pdf', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentMrr: 50000 });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.txt');
    expect(res.status).toBe(422);
  });

  it('UPGRADE: persists, updates account MRR, writes audit log, returns email draft', async () => {
    const { cookie, user } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentMrr: 50000, bandwidthMbps: 100 });

    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .field('reason', 'Customer capacity expansion')
      .attach('file', PDF_BUFFER, 'approval.pdf');

    expect(res.status).toBe(201);
    expect(res.body.commercialChange.changeType).toBe('UPGRADE');
    expect(res.body.commercialChange.oldMrr).toBe(50000);
    expect(res.body.commercialChange.newMrr).toBe(60000);
    expect(res.body.commercialChange.approvalFileUrl).toMatch(/^uploads\//);
    expect(res.body.emailDraft.subject).toContain('Acme');
    expect(res.body.emailDraft.body).toContain('Old MRR:');

    // Account state changed
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(Number(after?.currentMrr)).toBe(60000);
    expect(after?.bandwidthMbps).toBe(200);

    // Audit log written
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'CommercialChange' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.performedBy).toBe(user.id);
  });

  it('DISCONNECTION: marks account TERMINATED and zeroes MRR', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'GoneCo', currentMrr: 75000 });

    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newMrr', '0')
      .field('effectiveDate', '2026-05-01')
      .field('reason', 'Customer churn')
      .field('disconnectionCategoryId', '00000000-0000-0000-0000-000000000001')
      .field('disconnectionSubCategoryId', '00000000-0000-0000-0000-000000000002')
      .attach('file', PDF_BUFFER, 'termination.pdf');

    expect(res.status).toBe(201);
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('TERMINATED');
    expect(Number(after?.currentMrr)).toBe(0);
  });

  it('DOWNGRADE: persists negative-delta change', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentMrr: 50000 });

    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DOWNGRADE')
      .field('newMrr', '40000')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.pdf');

    expect(res.status).toBe(201);
    expect(res.body.commercialChange.oldMrr).toBe(50000);
    expect(res.body.commercialChange.newMrr).toBe(40000);
    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(Number(after?.currentMrr)).toBe(40000);
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
    const acct = await seedAccount({ clientName: 'Acme', currentMrr: 50000 });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldMrr: 50000,
        newMrr: 60000,
        effectiveDate: new Date('2026-04-15'),
        clientApprovalAttached: true,
        createdBy: user.id,
      },
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'DOWNGRADE',
        oldMrr: 60000,
        newMrr: 55000,
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
    const a1 = await seedAccount({ clientName: 'A', currentMrr: 10000, samOwnerId: sam1.id });
    const a2 = await seedAccount({ clientName: 'B', currentMrr: 20000, samOwnerId: sam2.id });
    await prisma.commercialChange.create({
      data: {
        accountId: a1.id, changeType: 'UPGRADE', oldMrr: 10000, newMrr: 12000,
        effectiveDate: new Date(), clientApprovalAttached: true, createdBy: sam1.id,
      },
    });
    await prisma.commercialChange.create({
      data: {
        accountId: a2.id, changeType: 'UPGRADE', oldMrr: 20000, newMrr: 25000,
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
      currentMrr: 50000,
      externalCrmId: 'crm-acme-1',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.pdf');
    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'disabled' });
    expect(res.body.commercialChange.crmServiceOrderId).toBeNull();
  });

  it('UPGRADE: forwards × 12 ARC + bandwidth to CRM and stores order ref', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Acme',
      currentMrr: 50000,
      bandwidthMbps: 100,
      externalCrmId: 'crm-acme-2',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.pdf');
    expect(res.status).toBe(201);

    // CRM was called with the right shape — × 12 ARC, customerId = externalCrmId
    expect(stub.createServiceOrderCalls).toHaveLength(1);
    const call = stub.createServiceOrderCalls[0]!;
    expect(call.customerId).toBe('crm-acme-2');
    expect(call.orderType).toBe('UPGRADE');
    expect(call.newArc).toBe(720000); // 60000 * 12
    expect(call.newBandwidth).toBe(200);
    // SAM internal ticket id is round-tripped via the notes field for
    // cross-system traceability.
    expect(call.notes).toMatch(/^SAM-[A-F0-9]{8}$/);

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
      currentMrr: 50000,
      bandwidthMbps: 100,
      externalCrmId: 'crm-acme-notes',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '60000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .field('notes', 'Customer expanding to add 50 devices')
      .attach('file', PDF_BUFFER, 'approval.pdf');
    expect(res.status).toBe(201);
    const call = stub.createServiceOrderCalls[0]!;
    expect(call.notes).toMatch(/^SAM-[A-F0-9]{8} \| Customer expanding/);
  });

  it('DISCONNECTION: forwards category/sub-category, no ARC math', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { CrmStub, setCrmClientForTests } = await import(
      '../src/services/integrations/crm/index.js'
    );
    const stub = new CrmStub();
    setCrmClientForTests(stub);

    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'GoneCo',
      currentMrr: 75000,
      externalCrmId: 'crm-gone-1',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newMrr', '0')
      .field('effectiveDate', '2026-05-01')
      .field('disconnectionCategoryId', 'cat-1')
      .field('disconnectionSubCategoryId', 'sub-1')
      .field('disconnectionReason', 'Office closing')
      .attach('file', PDF_BUFFER, 'disco.pdf');
    expect(res.status).toBe(201);
    const call = stub.createServiceOrderCalls[0]!;
    expect(call.orderType).toBe('DISCONNECTION');
    expect(call.disconnectionCategoryId).toBe('cat-1');
    expect(call.disconnectionSubCategoryId).toBe('sub-1');
    expect(call.disconnectionReason).toBe('Office closing');
    // No ARC math for DISCONNECTION
    expect(call.newArc).toBeUndefined();
    expect(call.newBandwidth).toBeUndefined();
    expect(res.body.crm.status).toBe('PENDING_APPROVAL');
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
      currentMrr: 10000,
      externalCrmId: 'crm-bad-1',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '20000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.pdf');
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
      currentMrr: 10000,
      externalCrmId: 'crm-x-1',
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'DISCONNECTION')
      .field('newMrr', '0')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'disco.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disconnectionCategoryId/);
  });

  it('crm.ok=false when account has no externalCrmId', async () => {
    process.env.CRM_SERVICE_ORDERS_ENABLED = 'true';
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'NoCrm',
      currentMrr: 10000,
      externalCrmId: null,
    });
    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'UPGRADE')
      .field('newMrr', '20000')
      .field('newBandwidthMbps', '200')
      .field('effectiveDate', '2026-05-01')
      .attach('file', PDF_BUFFER, 'approval.pdf');
    expect(res.status).toBe(201);
    expect(res.body.crm.ok).toBe(false);
    expect(res.body.crm.error).toMatch(/externalCrmId/);
  });
});
