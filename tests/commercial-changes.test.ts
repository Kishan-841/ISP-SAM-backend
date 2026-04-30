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

  it('TERMINATION: marks account TERMINATED and zeroes MRR', async () => {
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'GoneCo', currentMrr: 75000 });

    const res = await request(app)
      .post('/commercial-changes')
      .set('Cookie', cookie)
      .field('accountId', acct.id)
      .field('changeType', 'TERMINATION')
      .field('newMrr', '0')
      .field('effectiveDate', '2026-05-01')
      .field('reason', 'Customer churn')
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
