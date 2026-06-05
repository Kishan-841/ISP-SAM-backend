import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

/**
 * GET /commercial-changes/:id/file/:kind
 *
 * Auth-gated proxy. Verifies the caller can see the parent commercial-
 * change row (SAM scoping), then 302-redirects to the stored Cloudinary
 * URL. Audits the download.
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});
beforeEach(async () => {
  await resetDb();
});

async function seedChange(opts: {
  accountId: string;
  createdBy: string;
  approvalFileUrl?: string | null;
  poFileUrl?: string | null;
}) {
  return prisma.commercialChange.create({
    data: {
      accountId: opts.accountId,
      changeType: 'UPGRADE',
      oldArc: 100000,
      newArc: 150000,
      effectiveDate: new Date(),
      clientApprovalAttached: !!opts.approvalFileUrl,
      createdBy: opts.createdBy,
      approvalFileUrl: opts.approvalFileUrl ?? null,
      poFileUrl: opts.poFileUrl ?? null,
    },
  });
}

describe('GET /commercial-changes/:id/file/:kind', () => {
  it('admin: 302-redirects to the stored approvalFileUrl', async () => {
    const admin = await seedUser({ email: 'admin-file@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam-file@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'X', samOwnerId: sam.id });
    const change = await seedChange({
      accountId: acct.id,
      createdBy: sam.id,
      approvalFileUrl: 'https://res.cloudinary.com/test/raw/upload/v1/sam-software/po-and-mail-acceptance/abc/approval/file.pdf',
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await request(app)
      .get(`/commercial-changes/${change.id}/file/approval`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'https://res.cloudinary.com/test/raw/upload/v1/sam-software/po-and-mail-acceptance/abc/approval/file.pdf',
    );
  });

  it('admin: 302-redirects to the stored poFileUrl', async () => {
    const admin = await seedUser({ email: 'admin-po@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam-po@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'X', samOwnerId: sam.id });
    const change = await seedChange({
      accountId: acct.id,
      createdBy: sam.id,
      poFileUrl: 'https://res.cloudinary.com/test/raw/upload/v1/po.pdf',
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await request(app)
      .get(`/commercial-changes/${change.id}/file/po`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://res.cloudinary.com/test/raw/upload/v1/po.pdf');
  });

  it('SAM owner: 302-redirects (can access their own customers files)', async () => {
    const sam = await seedUser({ email: 'sam-own@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'Mine', samOwnerId: sam.id });
    const change = await seedChange({
      accountId: acct.id,
      createdBy: sam.id,
      approvalFileUrl: 'https://res.cloudinary.com/test/own.pdf',
    });

    const token = await tokenFor(sam.id, 'SAM');
    const res = await request(app)
      .get(`/commercial-changes/${change.id}/file/approval`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .redirects(0);
    expect(res.status).toBe(302);
  });

  it('SAM non-owner: gets 404, not 403 (existence not leaked)', async () => {
    const sam1 = await seedUser({ email: 'sam1@x.com', role: 'SAM' });
    const sam2 = await seedUser({ email: 'sam2@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'Other', samOwnerId: sam2.id });
    const change = await seedChange({
      accountId: acct.id,
      createdBy: sam2.id,
      approvalFileUrl: 'https://res.cloudinary.com/test/secret.pdf',
    });

    const token = await tokenFor(sam1.id, 'SAM');
    const res = await request(app)
      .get(`/commercial-changes/${change.id}/file/approval`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .redirects(0);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    // Verify the URL didn't leak in the response body either
    expect(JSON.stringify(res.body)).not.toContain('secret.pdf');
  });

  it('returns 404 when no file of that kind is attached', async () => {
    const admin = await seedUser({ email: 'admin-none@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam-none@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'X', samOwnerId: sam.id });
    const change = await seedChange({
      accountId: acct.id,
      createdBy: sam.id,
      approvalFileUrl: 'https://res.cloudinary.com/test/has-approval.pdf',
      // no poFileUrl
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await request(app)
      .get(`/commercial-changes/${change.id}/file/po`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .redirects(0);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no po file/i);
  });

  it('returns 400 on invalid kind', async () => {
    const admin = await seedUser({ email: 'admin-bk@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam-bk@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'X', samOwnerId: sam.id });
    const change = await seedChange({ accountId: acct.id, createdBy: sam.id });

    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await request(app)
      .get(`/commercial-changes/${change.id}/file/garbage`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .redirects(0);
    expect(res.status).toBe(400);
  });

  it('returns 404 on unknown commercial-change id', async () => {
    const admin = await seedUser({ email: 'admin-404@x.com', role: 'ADMIN' });
    const token = await tokenFor(admin.id, 'ADMIN');
    const res = await request(app)
      .get('/commercial-changes/00000000-0000-0000-0000-000000000000/file/approval')
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .redirects(0);
    expect(res.status).toBe(404);
  });

  it('returns 401 without a session cookie', async () => {
    const admin = await seedUser({ email: 'admin-401@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam-401@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'X', samOwnerId: sam.id });
    const change = await seedChange({
      accountId: acct.id,
      createdBy: sam.id,
      approvalFileUrl: 'https://res.cloudinary.com/test/x.pdf',
    });
    expect(admin).toBeTruthy();

    const res = await request(app)
      .get(`/commercial-changes/${change.id}/file/approval`)
      .redirects(0);
    expect(res.status).toBe(401);
  });

  it('writes a FILE_DOWNLOAD audit row with admin IP + UA', async () => {
    const admin = await seedUser({ email: 'admin-aud@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam-aud@x.com', role: 'SAM' });
    const acct = await seedAccount({ clientName: 'X', samOwnerId: sam.id });
    const change = await seedChange({
      accountId: acct.id,
      createdBy: sam.id,
      approvalFileUrl: 'https://res.cloudinary.com/test/audit.pdf',
    });

    const token = await tokenFor(admin.id, 'ADMIN');
    await request(app)
      .get(`/commercial-changes/${change.id}/file/approval`)
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .set('User-Agent', 'sam-test/1.0')
      .redirects(0);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'CommercialChange', entityId: change.id, action: 'FILE_DOWNLOAD' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.performedBy).toBe(admin.id);
    expect(audit!.userAgent).toBe('sam-test/1.0');
    const payload = audit!.payload as { kind: string; accountId: string };
    expect(payload.kind).toBe('approval');
    expect(payload.accountId).toBe(acct.id);
  });
});
