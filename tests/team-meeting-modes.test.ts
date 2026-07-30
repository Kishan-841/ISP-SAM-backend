/**
 * Per-SAM online/offline held-meeting counts on Team Performance.
 * meetingsOnline + meetingsOffline === meetingsHeld (a partition of held).
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

async function meeting(accountId: string, samId: string, opts: {
  held: boolean;
  type: 'ONLINE' | 'PHYSICAL';
}) {
  await prisma.meeting.create({
    data: {
      accountId,
      createdBy: samId,
      scheduledAt: new Date('2026-06-01T10:00:00Z'),
      heldAt: opts.held ? new Date('2026-06-01T10:30:00Z') : null,
      meetingType: opts.type,
    },
  });
}

describe('GET /dashboard/team-performance — meetings online/offline', () => {
  it('counts held meetings by mode; ignores not-held', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const head = await seedUser({ email: 'head@x.com', name: 'Head', role: 'SAM_HEAD' });
    const sam = await prisma.user.create({
      data: { email: 'sam@x.com', name: 'Sam One', role: 'SAM', passwordHash: 'x', samHeadId: head.id },
    });
    const acct = await prisma.account.create({
      data: {
        clientName: 'Acme', kittyType: 'BASE', currentArc: 500000,
        contractStatus: 'ACTIVE', onboardingDate: new Date('2025-01-01'), samOwnerId: sam.id,
      },
    });

    await meeting(acct.id, sam.id, { held: true, type: 'ONLINE' });
    await meeting(acct.id, sam.id, { held: true, type: 'ONLINE' });
    await meeting(acct.id, sam.id, { held: true, type: 'PHYSICAL' });
    await meeting(acct.id, sam.id, { held: false, type: 'ONLINE' }); // not held → ignored

    const cookie = `${SESSION_COOKIE}=${await tokenFor(admin.id, 'ADMIN')}`;
    const res = await request(app).get('/dashboard/team-performance').set('Cookie', cookie);
    expect(res.status).toBe(200);

    const row = res.body.sams.find((s: { userId: string }) => s.userId === sam.id);
    expect(row.meetingsHeld).toBe(3);
    expect(row.meetingsOnline).toBe(2);
    expect(row.meetingsOffline).toBe(1);
    expect(row.meetingsOnline + row.meetingsOffline).toBe(row.meetingsHeld);

    // Team totals roll up the same way.
    expect(res.body.team.meetingsOnline).toBe(2);
    expect(res.body.team.meetingsOffline).toBe(1);
  });
});
