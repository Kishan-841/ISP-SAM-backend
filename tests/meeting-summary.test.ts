/**
 * GET /dashboard/meeting-summary — leadership meeting analytics.
 * Held meetings by heldAt window, online/offline split, distinct customers met,
 * avg MOM turnaround, role scoping, and the 6-month trend.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});
beforeEach(async () => {
  await resetDb();
});

async function meeting(
  accountId: string,
  samId: string,
  opts: {
    held: Date | null;
    type: 'ONLINE' | 'PHYSICAL';
    momSentAt?: Date | null;
  },
) {
  await prisma.meeting.create({
    data: {
      accountId,
      createdBy: samId,
      scheduledAt: new Date(opts.held ?? '2026-07-01T10:00:00Z'),
      heldAt: opts.held,
      meetingType: opts.type,
      momSentAt: opts.momSentAt ?? null,
    },
  });
}

function cookieFor(id: string, role: 'ADMIN' | 'SAM_HEAD' | 'SUPER_ADMIN_2' | 'SAM') {
  return tokenFor(id, role).then((t) => `${SESSION_COOKIE}=${t}`);
}

describe('GET /dashboard/meeting-summary', () => {
  it('aggregates held meetings by mode, distinct customers, and turnaround', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const head = await seedUser({ email: 'head@x.com', name: 'Head', role: 'SAM_HEAD' });
    const sam = await prisma.user.create({
      data: { email: 'sam@x.com', name: 'Sam One', role: 'SAM', passwordHash: 'x', samHeadId: head.id },
    });
    const a1 = await prisma.account.create({
      data: { clientName: 'Acme', kittyType: 'BASE', currentArc: 1, contractStatus: 'ACTIVE', onboardingDate: new Date('2025-01-01'), samOwnerId: sam.id },
    });
    const a2 = await prisma.account.create({
      data: { clientName: 'Beta', kittyType: 'BASE', currentArc: 1, contractStatus: 'ACTIVE', onboardingDate: new Date('2025-01-01'), samOwnerId: sam.id },
    });

    const held = new Date('2026-07-10T10:00:00Z');
    // 2 held online on account a1 (one with a 24h-later MOM), 1 held physical on a2, 1 not held.
    await meeting(a1.id, sam.id, { held, type: 'ONLINE', momSentAt: new Date('2026-07-11T10:00:00Z') });
    await meeting(a1.id, sam.id, { held, type: 'ONLINE' });
    await meeting(a2.id, sam.id, { held, type: 'PHYSICAL' });
    await meeting(a1.id, sam.id, { held: null, type: 'ONLINE' }); // not held → ignored

    const res = await request(app)
      .get('/dashboard/meeting-summary')
      .set('Cookie', await cookieFor(admin.id, 'ADMIN'));
    expect(res.status).toBe(200);

    expect(res.body.team.held).toBe(3);
    expect(res.body.team.online).toBe(2);
    expect(res.body.team.offline).toBe(1);
    expect(res.body.team.customersMet).toBe(2); // a1 + a2 distinct
    expect(res.body.team.avgMomTurnaroundHours).toBe(24);

    const row = res.body.sams.find((s: { samId: string }) => s.samId === sam.id);
    expect(row.held).toBe(3);
    expect(row.online).toBe(2);
    expect(row.offline).toBe(1);
    expect(row.customersMet).toBe(2);
    expect(row.avgMomTurnaroundHours).toBe(24);

    // trend is always 6 buckets
    expect(res.body.trend).toHaveLength(6);
  });

  it('windows by heldAt when from/to given', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const sam = await prisma.user.create({
      data: { email: 'sam@x.com', name: 'Sam One', role: 'SAM', passwordHash: 'x' },
    });
    const acct = await prisma.account.create({
      data: { clientName: 'Acme', kittyType: 'BASE', currentArc: 1, contractStatus: 'ACTIVE', onboardingDate: new Date('2025-01-01'), samOwnerId: sam.id },
    });
    await meeting(acct.id, sam.id, { held: new Date('2026-06-15T10:00:00Z'), type: 'ONLINE' });
    await meeting(acct.id, sam.id, { held: new Date('2026-07-15T10:00:00Z'), type: 'ONLINE' });

    const res = await request(app)
      .get('/dashboard/meeting-summary?from=2026-07-01&to=2026-07-31')
      .set('Cookie', await cookieFor(admin.id, 'ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.team.held).toBe(1); // only the July meeting
  });

  it('scopes SAM_HEAD to their own reports', async () => {
    const headA = await seedUser({ email: 'ha@x.com', name: 'HeadA', role: 'SAM_HEAD' });
    const headB = await seedUser({ email: 'hb@x.com', name: 'HeadB', role: 'SAM_HEAD' });
    const samA = await prisma.user.create({ data: { email: 'sa@x.com', name: 'SamA', role: 'SAM', passwordHash: 'x', samHeadId: headA.id } });
    const samB = await prisma.user.create({ data: { email: 'sb@x.com', name: 'SamB', role: 'SAM', passwordHash: 'x', samHeadId: headB.id } });
    const acctA = await prisma.account.create({ data: { clientName: 'A', kittyType: 'BASE', currentArc: 1, contractStatus: 'ACTIVE', onboardingDate: new Date('2025-01-01'), samOwnerId: samA.id } });
    const acctB = await prisma.account.create({ data: { clientName: 'B', kittyType: 'BASE', currentArc: 1, contractStatus: 'ACTIVE', onboardingDate: new Date('2025-01-01'), samOwnerId: samB.id } });
    await meeting(acctA.id, samA.id, { held: new Date('2026-07-10T10:00:00Z'), type: 'ONLINE' });
    await meeting(acctB.id, samB.id, { held: new Date('2026-07-10T10:00:00Z'), type: 'ONLINE' });

    const res = await request(app)
      .get('/dashboard/meeting-summary')
      .set('Cookie', await cookieFor(headA.id, 'SAM_HEAD'));
    expect(res.status).toBe(200);
    // Only samA visible; samB's meeting excluded.
    expect(res.body.sams.map((s: { samId: string }) => s.samId)).toEqual([samA.id]);
    expect(res.body.team.held).toBe(1);
  });

  it('403s a plain SAM', async () => {
    const sam = await seedUser({ email: 'sam@x.com', role: 'SAM' });
    const res = await request(app)
      .get('/dashboard/meeting-summary')
      .set('Cookie', await cookieFor(sam.id, 'SAM'));
    expect(res.status).toBe(403);
  });
});
