import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedAccount, seedUser } from './helpers/db.js';
import { tokenFor, authedGet, authedPost } from './helpers/auth.js';
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

describe('POST /meetings', () => {
  it('401 without cookie', async () => {
    const res = await request(app).post('/meetings').send({});
    expect(res.status).toBe(401);
  });

  it('400 on invalid body', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app).post('/meetings').set('Cookie', cookie).send({});
    expect(res.status).toBe(400);
  });

  it('404 when account does not exist', async () => {
    const { cookie } = await adminCookie();
    const res = await request(app).post('/meetings').set('Cookie', cookie).send({
      accountId: '00000000-0000-0000-0000-000000000000',
      scheduledAt: '2026-05-03T11:00:00Z',
    });
    expect(res.status).toBe(404);
  });

  it('201 logs a meeting; audit log written', async () => {
    const { cookie, user } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme' });
    const res = await request(app).post('/meetings').set('Cookie', cookie).send({
      accountId: acct.id,
      scheduledAt: '2026-05-03T11:00:00Z',
      agenda: 'Q1 review',
    });
    expect(res.status).toBe(201);
    expect(res.body.meeting.scheduledAt).toMatch(/2026-05-03/);
    expect(res.body.meeting.agenda).toBe('Q1 review');
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'Meeting' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('LOG');
    expect(audits[0]?.performedBy).toBe(user.id);
  });
});

describe('GET /meetings', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/meetings');
    expect(res.status).toBe(401);
  });

  it('returns recent meetings sorted desc by scheduledAt', async () => {
    const { cookie, user } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme' });
    const dates = ['2026-04-28T15:21:00Z', '2026-04-28T16:31:00Z', '2026-04-30T07:20:00Z', '2026-05-03T11:00:00Z'];
    for (const d of dates) {
      await prisma.meeting.create({
        data: { accountId: acct.id, scheduledAt: new Date(d), createdBy: user.id },
      });
    }
    const ok = await request(app).get('/meetings').set('Cookie', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.meetings).toHaveLength(4);
    expect(new Date(ok.body.meetings[0].scheduledAt).getTime()).toBeGreaterThan(
      new Date(ok.body.meetings[3].scheduledAt).getTime(),
    );
    expect(ok.body.meetings[0].account.clientName).toBe('Acme');
  });

  it('SAM only sees meetings for their own accounts', async () => {
    const sam1 = await seedUser({ email: 'sam1@x.com', role: 'SAM' });
    const sam2 = await seedUser({ email: 'sam2@x.com', role: 'SAM' });
    const acctA = await seedAccount({ clientName: 'A', samOwnerId: sam1.id });
    const acctB = await seedAccount({ clientName: 'B', samOwnerId: sam2.id });
    await prisma.meeting.create({ data: { accountId: acctA.id, scheduledAt: new Date('2026-05-01'), createdBy: sam1.id } });
    await prisma.meeting.create({ data: { accountId: acctB.id, scheduledAt: new Date('2026-05-02'), createdBy: sam2.id } });
    const samCookie = `${SESSION_COOKIE}=${await tokenFor(sam1.id, 'SAM')}`;
    const res = await request(app).get('/meetings').set('Cookie', samCookie);
    expect(res.body.meetings).toHaveLength(1);
    expect(res.body.meetings[0].account.clientName).toBe('A');
  });
});

describe('POST /meetings/:id/held', () => {
  it('marks meeting as held and updates account.lastMeetingDate', async () => {
    const { user } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme' });
    const meeting = await prisma.meeting.create({
      data: { accountId: acct.id, scheduledAt: new Date('2026-05-03T11:00:00Z'), createdBy: user.id },
    });

    const res = await authedPost(app, `/meetings/${meeting.id}/held`, await tokenFor(user.id, 'ADMIN')).send({
      heldAt: '2026-05-03T11:30:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.meeting.heldAt).toMatch(/2026-05-03/);

    const acctAfter = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctAfter?.lastMeetingDate).toBeTruthy();

    const audits = await prisma.auditLog.findMany({ where: { entityType: 'Meeting', action: 'HELD' } });
    expect(audits).toHaveLength(1);
  });
});

describe('POST /meetings/:id/mom', () => {
  it('400 on empty MoM content', async () => {
    const { cookie, user } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme' });
    const meeting = await prisma.meeting.create({
      data: { accountId: acct.id, scheduledAt: new Date(), createdBy: user.id },
    });
    const res = await request(app).post(`/meetings/${meeting.id}/mom`).set('Cookie', cookie).send({ momContent: '' });
    expect(res.status).toBe(400);
  });

  it('records MoM, sets momSentAt, updates lastMomDate, writes audit row', async () => {
    const { cookie, user } = await adminCookie();
    const acct = await seedAccount({ clientName: 'Acme' });
    const meeting = await prisma.meeting.create({
      data: {
        accountId: acct.id,
        scheduledAt: new Date(),
        heldAt: new Date(),
        createdBy: user.id,
      },
    });
    const res = await request(app).post(`/meetings/${meeting.id}/mom`).set('Cookie', cookie).send({
      momContent: 'Discussed: Q1 review.\nAction items: 1) Send proposal by 2026-05-10.',
    });
    expect(res.status).toBe(200);
    expect(res.body.meeting.momContent).toContain('Q1 review');
    expect(res.body.meeting.momSentAt).toBeTruthy();

    const acctAfter = await prisma.account.findUnique({ where: { id: acct.id } });
    expect(acctAfter?.lastMomDate).toBeTruthy();

    const audits = await prisma.auditLog.findMany({ where: { entityType: 'Meeting', action: 'MOM_SENT' } });
    expect(audits).toHaveLength(1);
  });
});
