import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor, authedGet } from './helpers/auth.js';
import { prisma } from '../src/prisma.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
});

async function seedChange(opts: {
  account: { id: string };
  changeType: 'UPGRADE' | 'DOWNGRADE' | 'RATE_REVISION' | 'DISCONNECTION';
  effectiveDate: Date;
  oldArc?: number;
  newArc?: number;
  oldBandwidthMbps?: number | null;
  newBandwidthMbps?: number | null;
  reason?: string | null;
  disconnectionReason?: string | null;
  approvalFileUrl?: string | null;
  poFileUrl?: string | null;
  createdBy: string;
}) {
  return prisma.commercialChange.create({
    data: {
      accountId: opts.account.id,
      changeType: opts.changeType,
      oldArc: opts.oldArc ?? 600000,
      newArc: opts.newArc ?? 720000,
      effectiveDate: opts.effectiveDate,
      oldBandwidthMbps: opts.oldBandwidthMbps ?? null,
      newBandwidthMbps: opts.newBandwidthMbps ?? null,
      reason: opts.reason ?? null,
      disconnectionReason: opts.disconnectionReason ?? null,
      approvalFileUrl: opts.approvalFileUrl ?? null,
      poFileUrl: opts.poFileUrl ?? null,
      clientApprovalAttached: !!opts.approvalFileUrl,
      createdBy: opts.createdBy,
    },
  });
}

describe('GET /dashboard/changes', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/dashboard/changes?kittyType=BASE&bucket=UPGRADE');
    expect(res.status).toBe(401);
  });

  it('400 when kittyType is missing or invalid', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const missing = await authedGet(app, '/dashboard/changes?bucket=UPGRADE', token);
    expect(missing.status).toBe(400);
    const bogus = await authedGet(app, '/dashboard/changes?kittyType=BOGUS&bucket=UPGRADE', token);
    expect(bogus.status).toBe(400);
  });

  it('400 when bucket is missing or invalid', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const missing = await authedGet(app, '/dashboard/changes?kittyType=BASE', token);
    expect(missing.status).toBe(400);
    const bogus = await authedGet(app, '/dashboard/changes?kittyType=BASE&bucket=NOPE', token);
    expect(bogus.status).toBe(400);
  });

  it('returns each row with customer + samOwner + arc + bandwidth + docs', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam1@x.com', role: 'SAM', name: 'Asha Patel' });
    const acct = await seedAccount({
      clientName: 'Acme Internet',
      companyName: 'Acme Corp',
      customerCode: 'GAZ-0042',
      kittyType: 'BASE',
      currentArc: 720000,
      startOfPeriodArc: 600000,
      samOwnerId: sam.id,
    });
    await seedChange({
      account: acct,
      changeType: 'UPGRADE',
      oldArc: 600000,
      newArc: 720000,
      oldBandwidthMbps: 80,
      newBandwidthMbps: 100,
      effectiveDate: new Date('2026-05-11'),
      approvalFileUrl: 'https://cloudinary.example/approval.pdf',
      poFileUrl: 'https://cloudinary.example/po.pdf',
      createdBy: admin.id,
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/changes?kittyType=BASE&bucket=UPGRADE', token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.changes)).toBe(true);
    expect(res.body.changes).toHaveLength(1);
    const row = res.body.changes[0];
    expect(row.customer).toMatchObject({
      id: acct.id,
      clientName: 'Acme Internet',
      companyName: 'Acme Corp',
      customerCode: 'GAZ-0042',
    });
    expect(row.samOwner).toMatchObject({ id: sam.id, name: 'Asha Patel' });
    expect(row.oldArc).toBe(600000);
    expect(row.newArc).toBe(720000);
    expect(row.deltaArc).toBe(120000);
    expect(row.oldBandwidthMbps).toBe(80);
    expect(row.newBandwidthMbps).toBe(100);
    expect(row.approvalFileUrl).toBe('https://cloudinary.example/approval.pdf');
    expect(row.poFileUrl).toBe('https://cloudinary.example/po.pdf');
    expect(typeof row.effectiveDate).toBe('string');
  });

  it('filters by kittyType — BASE excludes NEW accounts', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const baseAcct = await seedAccount({ kittyType: 'BASE', currentArc: 720000 });
    const newAcct = await seedAccount({
      kittyType: 'NEW',
      currentArc: 720000,
      onboardingDate: new Date('2026-04-15'),
    });
    await seedChange({
      account: baseAcct,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-05-01'),
      createdBy: admin.id,
    });
    await seedChange({
      account: newAcct,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-05-01'),
      createdBy: admin.id,
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const baseRes = await authedGet(app, '/dashboard/changes?kittyType=BASE&bucket=UPGRADE', token);
    expect(baseRes.body.changes).toHaveLength(1);
    expect(baseRes.body.changes[0].customer.id).toBe(baseAcct.id);

    const newRes = await authedGet(app, '/dashboard/changes?kittyType=NEW&bucket=UPGRADE', token);
    expect(newRes.body.changes).toHaveLength(1);
    expect(newRes.body.changes[0].customer.id).toBe(newAcct.id);
  });

  it('filters by bucket — only the requested changeType returns', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({ kittyType: 'BASE', currentArc: 720000 });
    await seedChange({
      account: acct,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-05-01'),
      createdBy: admin.id,
    });
    await seedChange({
      account: acct,
      changeType: 'DOWNGRADE',
      effectiveDate: new Date('2026-05-02'),
      createdBy: admin.id,
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const upRes = await authedGet(app, '/dashboard/changes?kittyType=BASE&bucket=UPGRADE', token);
    expect(upRes.body.changes).toHaveLength(1);
    expect(upRes.body.changes[0].oldArc).toBe(600000);

    const downRes = await authedGet(app, '/dashboard/changes?kittyType=BASE&bucket=DOWNGRADE', token);
    expect(downRes.body.changes).toHaveLength(1);
  });

  it('honors quarter window for BASE kitty', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({ kittyType: 'BASE', currentArc: 720000 });
    // Q1 (Apr-Jun) and Q3 (Oct-Dec) upgrades.
    await seedChange({
      account: acct,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-05-15'),
      createdBy: admin.id,
    });
    await seedChange({
      account: acct,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-11-15'),
      createdBy: admin.id,
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const q1 = await authedGet(
      app,
      '/dashboard/changes?kittyType=BASE&bucket=UPGRADE&quarter=Q1',
      token,
    );
    expect(q1.body.changes).toHaveLength(1);
    expect(q1.body.changes[0].effectiveDate).toContain('2026-05-15');

    const q3 = await authedGet(
      app,
      '/dashboard/changes?kittyType=BASE&bucket=UPGRADE&quarter=Q3',
      token,
    );
    expect(q3.body.changes).toHaveLength(1);
    expect(q3.body.changes[0].effectiveDate).toContain('2026-11-15');

    const all = await authedGet(app, '/dashboard/changes?kittyType=BASE&bucket=UPGRADE', token);
    expect(all.body.changes).toHaveLength(2);
  });

  it('quarter filter is ignored for NEW kitty (all-time semantics, mirrors dashboard)', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({
      kittyType: 'NEW',
      currentArc: 720000,
      onboardingDate: new Date('2026-04-15'),
    });
    await seedChange({
      account: acct,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-11-15'),
      createdBy: admin.id,
    });
    const token = await tokenFor(admin.id, 'ADMIN');
    // Even with quarter=Q1, the NEW-side change effective in Q3 should still appear
    // because computeNewBase doesn't time-window its bucket counts.
    const res = await authedGet(
      app,
      '/dashboard/changes?kittyType=NEW&bucket=UPGRADE&quarter=Q1',
      token,
    );
    expect(res.body.changes).toHaveLength(1);
  });

  it('SAM sees only changes on their own accounts; ADMIN sees all', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const samA = await seedUser({ email: 'sa@x.com', role: 'SAM', name: 'Sam A' });
    const samB = await seedUser({ email: 'sb@x.com', role: 'SAM', name: 'Sam B' });
    const acctA = await seedAccount({ kittyType: 'BASE', currentArc: 720000, samOwnerId: samA.id });
    const acctB = await seedAccount({ kittyType: 'BASE', currentArc: 720000, samOwnerId: samB.id });
    await seedChange({
      account: acctA,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-05-01'),
      createdBy: admin.id,
    });
    await seedChange({
      account: acctB,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-05-02'),
      createdBy: admin.id,
    });

    const adminTok = await tokenFor(admin.id, 'ADMIN');
    const adminRes = await authedGet(
      app,
      '/dashboard/changes?kittyType=BASE&bucket=UPGRADE',
      adminTok,
    );
    expect(adminRes.body.changes).toHaveLength(2);

    const samATok = await tokenFor(samA.id, 'SAM');
    const samARes = await authedGet(
      app,
      '/dashboard/changes?kittyType=BASE&bucket=UPGRADE',
      samATok,
    );
    expect(samARes.body.changes).toHaveLength(1);
    expect(samARes.body.changes[0].customer.id).toBe(acctA.id);
  });

  it('disconnection rows expose the disconnection reason', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({
      kittyType: 'BASE',
      currentArc: 0,
      contractStatus: 'TERMINATED',
    });
    await seedChange({
      account: acct,
      changeType: 'DISCONNECTION',
      oldArc: 1200000,
      newArc: 0,
      effectiveDate: new Date('2026-05-15'),
      disconnectionReason: 'Customer moved offices',
      createdBy: admin.id,
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(
      app,
      '/dashboard/changes?kittyType=BASE&bucket=DISCONNECTION',
      token,
    );
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].disconnectionReason).toBe('Customer moved offices');
    expect(res.body.changes[0].deltaArc).toBe(-1200000);
  });

  it('orders rows by effective date desc', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const acct = await seedAccount({ kittyType: 'BASE', currentArc: 720000 });
    await seedChange({
      account: acct,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-04-05'),
      createdBy: admin.id,
    });
    await seedChange({
      account: acct,
      changeType: 'UPGRADE',
      effectiveDate: new Date('2026-06-12'),
      createdBy: admin.id,
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, '/dashboard/changes?kittyType=BASE&bucket=UPGRADE', token);
    expect(res.body.changes).toHaveLength(2);
    expect(res.body.changes[0].effectiveDate).toContain('2026-06-12');
    expect(res.body.changes[1].effectiveDate).toContain('2026-04-05');
  });
});
