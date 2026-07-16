/**
 * Internal approval chain for BASE (existing-base) commercial changes.
 *
 *   UPGRADE / DOWNGRADE / RATE_REVISION → ACCOUNTS (terminal)
 *   DISCONNECTION (normal)              → ACCOUNTS → SUPER_ADMIN_2 (terminal)
 *   DISCONNECTION (quick)               → SAM_HEAD → ACCOUNTS → SUPER_ADMIN_2 (terminal)
 *
 * Only the terminal approval applies the change; SUPER_ADMIN_2 is the final
 * gate on disconnections and records material recovery. Any stage may reject
 * with a mandatory reason. NEW base never enters the chain.
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

class FakeApprovalUploader implements ApprovalFileUploader {
  uploads: ApprovalUploadInput[] = [];
  async uploadApprovalFile(input: ApprovalUploadInput) {
    this.uploads.push(input);
    return {
      publicId: `test/${input.commercialChangeId}/${input.kind}`,
      secureUrl: `https://res.cloudinary.com/test/${input.commercialChangeId}/${input.kind}`,
      bytes: input.buffer.byteLength,
      format: null,
      originalFilename: input.originalName,
    };
  }
}

const PDF = Buffer.from('%PDF-1.4 mock');

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

let sam: Awaited<ReturnType<typeof seedUser>>;
let samHead: Awaited<ReturnType<typeof seedUser>>;
let accounts: Awaited<ReturnType<typeof seedUser>>;
let sa2: Awaited<ReturnType<typeof seedUser>>;
let cookies: Record<'SAM' | 'SAM_HEAD' | 'ACCOUNTS' | 'SUPER_ADMIN_2', string>;

beforeEach(async () => {
  await resetDb();
  setApprovalFileUploaderForTests(new FakeApprovalUploader());

  samHead = await seedUser({ email: 'head@x.com', name: 'Head', role: 'SAM_HEAD' });
  sam = await seedUser({ email: 'sam@x.com', name: 'Sam', role: 'SAM' });
  await prisma.user.update({ where: { id: sam.id }, data: { samHeadId: samHead.id } });
  accounts = await seedUser({ email: 'acct@x.com', name: 'Accounts', role: 'ACCOUNTS' });
  sa2 = await seedUser({ email: 'sa2@x.com', name: 'Super Admin 2', role: 'SUPER_ADMIN_2' });

  cookies = {
    SAM: `${SESSION_COOKIE}=${await tokenFor(sam.id, 'SAM')}`,
    SAM_HEAD: `${SESSION_COOKIE}=${await tokenFor(samHead.id, 'SAM_HEAD')}`,
    ACCOUNTS: `${SESSION_COOKIE}=${await tokenFor(accounts.id, 'ACCOUNTS')}`,
    SUPER_ADMIN_2: `${SESSION_COOKIE}=${await tokenFor(sa2.id, 'SUPER_ADMIN_2')}`,
  };
});

/** BASE account owned by `sam` (who reports to `samHead`). */
function seedBaseAccount(overrides = {}) {
  return seedAccount({
    clientName: 'BaseCo',
    kittyType: 'BASE',
    currentArc: 500000,
    bandwidthMbps: 100,
    samOwnerId: sam.id,
    externalCrmId: null,
    ...overrides,
  });
}

function commitUpgrade(cookie: string, acctId: string, newArc: number) {
  return request(app)
    .post('/commercial-changes')
    .set('Cookie', cookie)
    .field('accountId', acctId)
    .field('changeType', 'UPGRADE')
    .field('newArc', String(newArc))
    .field('newBandwidthMbps', '300')
    .field('effectiveDate', '2026-07-01')
    .attach('approvalFile', PDF, 'a.pdf');
}

function commitDisconnection(
  cookie: string,
  acctId: string,
  opts: { quick?: boolean; days?: number } = {},
) {
  const req = request(app)
    .post('/commercial-changes')
    .set('Cookie', cookie)
    .field('accountId', acctId)
    .field('changeType', 'DISCONNECTION')
    .field('newArc', '0')
    .field('effectiveDate', '2026-07-01')
    .field('disconnectionCategoryId', '00000000-0000-0000-0000-000000000001')
    .field('disconnectionSubCategoryId', '00000000-0000-0000-0000-000000000002');
  if (opts.quick) {
    req
      .field('disconnectionMode', 'QUICK')
      .field('quickRequestedDays', String(opts.days ?? 5))
      .field('quickApprovalReason', 'Customer relocating — needs fast cutover.');
  }
  return req.attach('approvalFile', PDF, 'd.pdf');
}

function decide(cookie: string, id: string, action: 'APPROVE' | 'REJECT', reason?: string) {
  return request(app)
    .post(`/commercial-changes/${id}/approval-decision`)
    .set('Cookie', cookie)
    .send({ action, reason });
}

describe('BASE non-disconnection approval (single ACCOUNTS stage)', () => {
  it('commit parks the change at PENDING_ACCOUNTS and does NOT touch the account', async () => {
    const acct = await seedBaseAccount();
    const res = await commitUpgrade(cookies.SAM, acct.id, 800000);

    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'pending-approval', stage: 'PENDING_ACCOUNTS' });

    const change = await prisma.commercialChange.findUnique({
      where: { id: res.body.commercialChange.id },
    });
    expect(change?.approvalStatus).toBe('PENDING_ACCOUNTS');
    expect(change?.accountAppliedAt).toBeNull();

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('PENDING_APPROVAL');
    expect(Number(after?.currentArc)).toBe(500000); // unchanged
  });

  it('ACCOUNTS approval applies the new ARC + bandwidth and returns account to ACTIVE', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitUpgrade(cookies.SAM, acct.id, 800000);
    const id = commit.body.commercialChange.id;

    const res = await decide(cookies.ACCOUNTS, id, 'APPROVE');
    expect(res.status).toBe(200);
    expect(res.body.change.approvalStatus).toBe('APPROVED');

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('ACTIVE');
    expect(Number(after?.currentArc)).toBe(800000);
    expect(after?.bandwidthMbps).toBe(300);

    const change = await prisma.commercialChange.findUnique({ where: { id } });
    expect(change?.accountAppliedAt).not.toBeNull();
  });

  it('SUPER_ADMIN_2 cannot approve an ACCOUNTS-stage change (403 WRONG_STAGE)', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitUpgrade(cookies.SAM, acct.id, 800000);
    const res = await decide(cookies.SUPER_ADMIN_2, commit.body.commercialChange.id, 'APPROVE');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/WRONG_STAGE/);
  });

  it('reject requires a reason (422) and, with one, restores the account unchanged', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitUpgrade(cookies.SAM, acct.id, 800000);
    const id = commit.body.commercialChange.id;

    const noReason = await decide(cookies.ACCOUNTS, id, 'REJECT');
    expect(noReason.status).toBe(422);
    expect(noReason.body.error).toMatch(/REJECTION_REASON_REQUIRED/);

    const rejected = await decide(cookies.ACCOUNTS, id, 'REJECT', 'PO does not match the quote.');
    expect(rejected.status).toBe(200);
    expect(rejected.body.change.approvalStatus).toBe('REJECTED');

    const change = await prisma.commercialChange.findUnique({ where: { id } });
    expect(change?.rejectionReason).toBe('PO does not match the quote.');
    expect(change?.rejectedBy).toBe(accounts.id);

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('ACTIVE');
    expect(Number(after?.currentArc)).toBe(500000); // never applied

    // The raising SAM is notified of the rejection.
    const feed = await request(app).get('/notifications').set('Cookie', cookies.SAM);
    expect(feed.status).toBe(200);
    const kinds = feed.body.notifications.map((n: { kind: string }) => n.kind);
    expect(kinds).toContain('COMMERCIAL_CHANGE_REJECTED');
  });

  it('a second change is blocked while one is awaiting approval (422)', async () => {
    const acct = await seedBaseAccount();
    await commitUpgrade(cookies.SAM, acct.id, 800000);
    const second = await commitUpgrade(cookies.SAM, acct.id, 900000);
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/ACCOUNT_PENDING_APPROVAL/);
  });
});

describe('BASE normal disconnection (ACCOUNTS → SUPER_ADMIN_2)', () => {
  it('walks both stages; SUPER_ADMIN_2 is terminal and starts the retention window', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitDisconnection(cookies.SAM, acct.id);
    const id = commit.body.commercialChange.id;
    expect(commit.body.crm).toEqual({ ok: 'pending-approval', stage: 'PENDING_ACCOUNTS' });

    // SUPER_ADMIN_2 is now LAST — it cannot jump the queue.
    const early = await decide(cookies.SUPER_ADMIN_2, id, 'APPROVE');
    expect(early.status).toBe(403);

    const s1 = await decide(cookies.ACCOUNTS, id, 'APPROVE');
    expect(s1.status).toBe(200);
    expect(s1.body.change.approvalStatus).toBe('PENDING_SUPER_ADMIN_2');
    // ACCOUNTS approving no longer applies anything — still held.
    let acctRow = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctRow?.contractStatus).toBe('PENDING_APPROVAL');

    const s2 = await request(app)
      .post(`/commercial-changes/${id}/approval-decision`)
      .set('Cookie', cookies.SUPER_ADMIN_2)
      .send({ action: 'APPROVE', materialRecovered: true, materialRecoveryNotes: 'Router + ONT collected.' });
    expect(s2.status).toBe(200);
    expect(s2.body.change.approvalStatus).toBe('APPROVED');

    acctRow = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctRow?.contractStatus).toBe('PROBABLE_CHURN');

    const change = await prisma.commercialChange.findUnique({ where: { id } });
    expect(change?.retentionPromptDueAt).not.toBeNull();
    expect(change?.accountAppliedAt).toBeNull(); // still in the notice window
    // Material recovery captured on the final gate.
    expect(change?.materialRecovered).toBe(true);
    expect(change?.materialRecoveryNotes).toBe('Router + ONT collected.');
    expect(change?.approvedBy).toBe(sa2.id); // SUPER_ADMIN_2 is the terminal approver
  });

  it('records material NOT recovered without blocking the approval', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitDisconnection(cookies.SAM, acct.id);
    const id = commit.body.commercialChange.id;
    await decide(cookies.ACCOUNTS, id, 'APPROVE');

    const res = await request(app)
      .post(`/commercial-changes/${id}/approval-decision`)
      .set('Cookie', cookies.SUPER_ADMIN_2)
      .send({ action: 'APPROVE', materialRecovered: false, materialRecoveryNotes: 'Customer relocated; chasing router.' });
    expect(res.status).toBe(200);
    expect(res.body.change.approvalStatus).toBe('APPROVED');

    const change = await prisma.commercialChange.findUnique({ where: { id } });
    expect(change?.materialRecovered).toBe(false);
    const acctRow = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctRow?.contractStatus).toBe('PROBABLE_CHURN'); // still proceeds
  });

  it('rejection at the first (ACCOUNTS) stage kills the chain and keeps the customer ACTIVE', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitDisconnection(cookies.SAM, acct.id);
    const res = await decide(cookies.ACCOUNTS, commit.body.commercialChange.id, 'REJECT', 'Retention attempt pending.');
    expect(res.status).toBe(200);
    expect(res.body.change.approvalStatus).toBe('REJECTED');
    const acctRow = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctRow?.contractStatus).toBe('ACTIVE');
  });

  it('SUPER_ADMIN_2 can still reject at the final stage', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitDisconnection(cookies.SAM, acct.id);
    const id = commit.body.commercialChange.id;
    await decide(cookies.ACCOUNTS, id, 'APPROVE');

    const res = await decide(cookies.SUPER_ADMIN_2, id, 'REJECT', 'Material not traceable — hold.');
    expect(res.status).toBe(200);
    expect(res.body.change.approvalStatus).toBe('REJECTED');
    const acctRow = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctRow?.contractStatus).toBe('ACTIVE');
  });
});

describe('BASE quick disconnection (SAM_HEAD → ACCOUNTS → SUPER_ADMIN_2)', () => {
  it('walks all three stages, then schedules termination in quickRequestedDays', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitDisconnection(cookies.SAM, acct.id, { quick: true, days: 5 });
    const id = commit.body.commercialChange.id;
    expect(commit.body.crm).toEqual({ ok: 'pending-approval', stage: 'PENDING_SAM_HEAD' });

    const s1 = await decide(cookies.SAM_HEAD, id, 'APPROVE');
    expect(s1.status).toBe(200);
    expect(s1.body.change.approvalStatus).toBe('PENDING_ACCOUNTS');

    const s2 = await decide(cookies.ACCOUNTS, id, 'APPROVE');
    expect(s2.status).toBe(200);
    expect(s2.body.change.approvalStatus).toBe('PENDING_SUPER_ADMIN_2');

    const s3 = await request(app)
      .post(`/commercial-changes/${id}/approval-decision`)
      .set('Cookie', cookies.SUPER_ADMIN_2)
      .send({ action: 'APPROVE', materialRecovered: true });
    expect(s3.status).toBe(200);
    expect(s3.body.change.approvalStatus).toBe('APPROVED');

    const acctRow = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctRow?.contractStatus).toBe('DISCONNECTING');

    const change = await prisma.commercialChange.findUnique({ where: { id } });
    expect(change?.retentionDecision).toBe('PROCEED');
    expect(change?.scheduledTerminationAt).not.toBeNull();
    expect(change?.materialRecovered).toBe(true);
  });
});

describe('GET /commercial-changes/approvals queue scoping', () => {
  it('each approver sees only their own stage', async () => {
    const acct = await seedBaseAccount();
    const acct2 = await seedBaseAccount({ clientName: 'BaseCo2', customerCode: 'BC2' });
    // Disconnection starts at ACCOUNTS; push it on to SUPER_ADMIN_2.
    const disc = await commitDisconnection(cookies.SAM, acct.id);
    await decide(cookies.ACCOUNTS, disc.body.commercialChange.id, 'APPROVE');
    // An upgrade sits at PENDING_ACCOUNTS.
    await commitUpgrade(cookies.SAM, acct2.id, 700000);

    const sa2Queue = await request(app).get('/commercial-changes/approvals').set('Cookie', cookies.SUPER_ADMIN_2);
    expect(sa2Queue.body.items).toHaveLength(1);
    expect(sa2Queue.body.items[0].approvalStatus).toBe('PENDING_SUPER_ADMIN_2');

    const acctQueue = await request(app).get('/commercial-changes/approvals').set('Cookie', cookies.ACCOUNTS);
    expect(acctQueue.body.items).toHaveLength(1);
    expect(acctQueue.body.items[0].approvalStatus).toBe('PENDING_ACCOUNTS');
  });

  it('SAM cannot access the approvals queue (403)', async () => {
    const res = await request(app).get('/commercial-changes/approvals').set('Cookie', cookies.SAM);
    expect(res.status).toBe(403);
  });
});

describe('NEW base never enters the approval chain', () => {
  it('a NEW-base upgrade (no CRM) applies immediately, approvalStatus NOT_REQUIRED', async () => {
    const acct = await seedAccount({
      clientName: 'NewCo',
      kittyType: 'NEW',
      currentArc: 400000,
      samOwnerId: sam.id,
      externalCrmId: null,
    });
    const res = await commitUpgrade(cookies.SAM, acct.id, 600000);
    expect(res.status).toBe(201);
    expect(res.body.crm).toEqual({ ok: 'local-only' });

    const change = await prisma.commercialChange.findUnique({
      where: { id: res.body.commercialChange.id },
    });
    expect(change?.approvalStatus).toBe('NOT_REQUIRED');

    const after = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(after?.contractStatus).toBe('ACTIVE');
    expect(Number(after?.currentArc)).toBe(600000);
  });
});

describe('GET /commercial-changes/approvals — history tabs', () => {
  it('approved tab shows the change with who approved + when, and drops it from pending', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitUpgrade(cookies.SAM, acct.id, 800000);
    const id = commit.body.commercialChange.id;
    await decide(cookies.ACCOUNTS, id, 'APPROVE');

    const res = await request(app)
      .get('/commercial-changes/approvals?status=approved')
      .set('Cookie', cookies.ACCOUNTS);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    const row = res.body.items.find((i: { id: string }) => i.id === id);
    expect(row).toBeTruthy();
    expect(row.approvalStatus).toBe('APPROVED');
    expect(row.decidedByName).toBe('Accounts');
    expect(row.approvedAt).toBeTruthy();

    const pending = await request(app)
      .get('/commercial-changes/approvals?status=pending')
      .set('Cookie', cookies.ACCOUNTS);
    expect(pending.body.items.find((i: { id: string }) => i.id === id)).toBeFalsy();
  });

  it('rejected tab shows the reason + who rejected + when', async () => {
    const acct = await seedBaseAccount();
    const commit = await commitUpgrade(cookies.SAM, acct.id, 800000);
    const id = commit.body.commercialChange.id;
    await decide(cookies.ACCOUNTS, id, 'REJECT', 'PO mismatch with the approved quote.');

    const res = await request(app)
      .get('/commercial-changes/approvals?status=rejected')
      .set('Cookie', cookies.SUPER_ADMIN_2); // any approver sees the org-wide history
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { id: string }) => i.id === id);
    expect(row.approvalStatus).toBe('REJECTED');
    expect(row.rejectionReason).toBe('PO mismatch with the approved quote.');
    expect(row.decidedByName).toBe('Accounts');
    expect(row.rejectedAt).toBeTruthy();
  });

  it('SAM_HEAD history is scoped to their team', async () => {
    const acct = await seedBaseAccount(); // owned by `sam`, who reports to `samHead`
    const commit = await commitUpgrade(cookies.SAM, acct.id, 700000);
    await decide(cookies.ACCOUNTS, commit.body.commercialChange.id, 'APPROVE');

    const res = await request(app)
      .get('/commercial-changes/approvals?status=approved')
      .set('Cookie', cookies.SAM_HEAD);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});
