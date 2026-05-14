import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  setEmailClientForTests,
  type EmailClient,
  type EmailMessage,
  type SendResult,
} from '../src/services/email/email-client.js';

class FakeUploader implements ApprovalFileUploader {
  async uploadApprovalFile(input: ApprovalUploadInput) {
    return {
      publicId: `sam-software/po-and-mail-acceptance/${input.commercialChangeId}/${input.kind}/${input.originalName}`,
      secureUrl: `https://res.cloudinary.com/test-cloud/raw/upload/v1/${input.commercialChangeId}/${input.kind}/${input.originalName}`,
      bytes: input.buffer.byteLength,
      format: null,
      originalFilename: input.originalName,
    };
  }
}

class CapturingEmailClient implements EmailClient {
  public sent: EmailMessage[] = [];
  public nextResult: SendResult = { ok: true, messageId: 'fake-msg-1' };
  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    return this.nextResult;
  }
}

const PDF = Buffer.from('%PDF-1.4 mock approval');

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
  setApprovalFileUploaderForTests(new FakeUploader());
});

beforeEach(() => {
  // Tests rely on a clean env per case; .env-loaded values would otherwise
  // leak through and make these flaky depending on local config.
  delete process.env.ACCOUNTS_NOTIFICATIONS_ENABLED;
  delete process.env.ACCOUNTS_TEAM_EMAIL;
  delete process.env.ACCOUNTS_TEAM_CC_EMAILS;
  delete process.env.SALES_DIRECTOR_EMAIL;
  delete process.env.ADMIN_NOTIFY_EMAIL;
});

afterEach(() => {
  setEmailClientForTests(null);
  delete process.env.ACCOUNTS_NOTIFICATIONS_ENABLED;
  delete process.env.ACCOUNTS_TEAM_EMAIL;
  delete process.env.ACCOUNTS_TEAM_CC_EMAILS;
  delete process.env.SALES_DIRECTOR_EMAIL;
  delete process.env.ADMIN_NOTIFY_EMAIL;
});

async function adminCookie() {
  const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
  return { cookie: `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}`, admin };
}

async function commitUpgrade(cookie: string, accountId: string) {
  return request(app)
    .post('/commercial-changes')
    .set('Cookie', cookie)
    .field('accountId', accountId)
    .field('changeType', 'UPGRADE')
    .field('newArc', '720000')
    .field('newBandwidthMbps', '200')
    .field('effectiveDate', '2026-05-01')
    .attach('approvalFile', PDF, 'approval.pdf')
    .attach('poFile', PDF, 'po.pdf');
}

describe('Accounts-team notification bridge', () => {
  it('skipped (and audit-logged) when ACCOUNTS_NOTIFICATIONS_ENABLED is off', async () => {
    const email = new CapturingEmailClient();
    setEmailClientForTests(email);
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });

    const res = await commitUpgrade(cookie, acct.id);
    expect(res.status).toBe(201);

    // No email sent.
    expect(email.sent).toHaveLength(0);
    // Notified date NOT stamped.
    const change = await prisma.commercialChange.findUnique({
      where: { id: res.body.commercialChange.id },
    });
    expect(change?.accountsNotifiedDate).toBeNull();
    // Audit row records the SKIPPED outcome so the trail is honest.
    const audits = await prisma.auditLog.findMany({
      where: { entityId: change?.id, action: 'NOTIFY_ACCOUNTS_TEAM' },
    });
    expect(audits).toHaveLength(1);
    expect((audits[0]?.payload as { outcome: string }).outcome).toBe('SKIPPED');
  });

  it('misconfigured when enabled but ACCOUNTS_TEAM_EMAIL is missing', async () => {
    process.env.ACCOUNTS_NOTIFICATIONS_ENABLED = 'true';
    const email = new CapturingEmailClient();
    setEmailClientForTests(email);
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });

    const res = await commitUpgrade(cookie, acct.id);
    expect(res.status).toBe(201);
    expect(email.sent).toHaveLength(0);
    const audits = await prisma.auditLog.findMany({
      where: { entityId: res.body.commercialChange.id, action: 'NOTIFY_ACCOUNTS_TEAM' },
    });
    expect((audits[0]?.payload as { outcome: string }).outcome).toBe('MISCONFIGURED');
  });

  it('sends email and stamps accounts_notified_date when fully configured', async () => {
    process.env.ACCOUNTS_NOTIFICATIONS_ENABLED = 'true';
    process.env.ACCOUNTS_TEAM_EMAIL = 'accounts@gazon.test';
    process.env.ACCOUNTS_TEAM_CC_EMAILS = 'head@gazon.test, audit@gazon.test';
    const email = new CapturingEmailClient();
    setEmailClientForTests(email);
    const { cookie } = await adminCookie();
    const acct = await seedAccount({
      clientName: 'Acme',
      companyName: 'Acme Inc',
      customerCode: 'GAZ-0001',
      currentArc: 600000,
    });

    const res = await commitUpgrade(cookie, acct.id);
    expect(res.status).toBe(201);

    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0]!;
    expect(sent.to).toBe('accounts@gazon.test');
    expect(sent.cc).toEqual(['head@gazon.test', 'audit@gazon.test']);
    expect(sent.subject).toContain('Acme');
    expect(sent.html).toContain('GAZ-0001');
    expect(sent.html).toContain('Upgrade');
    // Plain-text body now uses an indented "ARC" block instead of "Old ARC:"
    // since the template was rewritten to include bandwidth + delta groupings.
    expect(sent.text).toMatch(/ARC\s*\n\s*Old:/);
    expect(sent.text).toContain('Bandwidth');
    expect(sent.text).toContain('SAM Reference:');

    const change = await prisma.commercialChange.findUnique({
      where: { id: res.body.commercialChange.id },
    });
    expect(change?.accountsNotifiedDate).not.toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { entityId: change?.id, action: 'NOTIFY_ACCOUNTS_TEAM' },
    });
    expect((audits[0]?.payload as { outcome: string }).outcome).toBe('SENT');
  });

  it('failed delivery → no notified-date stamp, audit recorded, commit still succeeds', async () => {
    process.env.ACCOUNTS_NOTIFICATIONS_ENABLED = 'true';
    process.env.ACCOUNTS_TEAM_EMAIL = 'accounts@gazon.test';
    const email = new CapturingEmailClient();
    email.nextResult = { ok: false, error: 'rate limited' };
    setEmailClientForTests(email);
    const { cookie } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme', currentArc: 600000 });

    const res = await commitUpgrade(cookie, acct.id);
    // Commit MUST still succeed — the row is saved, the email is best-effort.
    expect(res.status).toBe(201);

    expect(email.sent).toHaveLength(1);
    const change = await prisma.commercialChange.findUnique({
      where: { id: res.body.commercialChange.id },
    });
    expect(change?.accountsNotifiedDate).toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { entityId: change?.id, action: 'NOTIFY_ACCOUNTS_TEAM' },
    });
    expect((audits[0]?.payload as { outcome: string; detail: string }).outcome).toBe('FAILED');
    expect((audits[0]?.payload as { outcome: string; detail: string }).detail).toContain(
      'rate limited',
    );
  });
});
