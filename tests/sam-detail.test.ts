/**
 * GET /dashboard/team-performance/:samId — single-SAM dashboard payload.
 *
 * Authz model:
 *  - SAM:        403 (cannot view other SAMs)
 *  - SAM_HEAD:   only their direct reports; 404 for anyone else
 *  - ADMIN:      any SAM in the org
 *
 * The payload exposes: sam profile, reliability score with the four weighted
 * components surfaced individually, KPI row with team-average comparators,
 * commercial-change buckets, upcoming + recent meetings, a 30-day activity
 * timeline, and the risk pulse (probable-churn count + ARC, customers
 * without meetings, stale MOMs, day-21 prompts due).
 */
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

async function setupTeam() {
  const head = await seedUser({ email: 'head@x.com', name: 'Head', role: 'SAM_HEAD' });
  const samA = await prisma.user.create({
    data: {
      email: 'sam-a@x.com',
      name: 'Sam A',
      role: 'SAM',
      passwordHash: 'x',
      samHeadId: head.id,
    },
  });
  const samB = await prisma.user.create({
    data: {
      email: 'sam-b@x.com',
      name: 'Sam B',
      role: 'SAM',
      passwordHash: 'x',
      samHeadId: head.id,
    },
  });
  const lonerHead = await seedUser({
    email: 'head2@x.com',
    name: 'Other Head',
    role: 'SAM_HEAD',
  });
  const lonerSam = await prisma.user.create({
    data: {
      email: 'loner@x.com',
      name: 'Loner Sam',
      role: 'SAM',
      passwordHash: 'x',
      samHeadId: lonerHead.id,
    },
  });
  const admin = await seedUser({ email: 'admin@x.com', name: 'Admin', role: 'ADMIN' });
  return { head, samA, samB, lonerHead, lonerSam, admin };
}

describe('GET /dashboard/team-performance/:samId — auth + scoping', () => {
  it('401 without cookie', async () => {
    const res = await request(app).get('/dashboard/team-performance/abc');
    expect(res.status).toBe(401);
  });

  it('403 for a SAM trying to view any SAM detail', async () => {
    const { samA } = await setupTeam();
    const tok = await tokenFor(samA.id, 'SAM');
    const res = await authedGet(app, `/dashboard/team-performance/${samA.id}`, tok);
    expect(res.status).toBe(403);
  });

  it('SAM_HEAD: 200 for own report, 404 for someone else’s report', async () => {
    const { head, samA, lonerSam } = await setupTeam();
    const tok = await tokenFor(head.id, 'SAM_HEAD');
    const ok = await authedGet(app, `/dashboard/team-performance/${samA.id}`, tok);
    expect(ok.status).toBe(200);
    expect(ok.body.sam.id).toBe(samA.id);
    const denied = await authedGet(
      app,
      `/dashboard/team-performance/${lonerSam.id}`,
      tok,
    );
    expect(denied.status).toBe(404);
  });

  it('ADMIN: sees any SAM', async () => {
    const { admin, lonerSam } = await setupTeam();
    const tok = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, `/dashboard/team-performance/${lonerSam.id}`, tok);
    expect(res.status).toBe(200);
    expect(res.body.sam.id).toBe(lonerSam.id);
  });

  it('404 for non-SAM users (cannot drill into ADMIN/SAM_HEAD)', async () => {
    const { admin, head } = await setupTeam();
    const tok = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, `/dashboard/team-performance/${head.id}`, tok);
    expect(res.status).toBe(404);
  });
});

describe('GET /dashboard/team-performance/:samId — KPIs + team avg', () => {
  it('reports KPI value + team avg from peers, plus per-component score breakdown', async () => {
    const { head, samA, samB, admin } = await setupTeam();
    // Sam A: 2 customers, ₹12L ARC. Sam B: 4 customers, ₹24L ARC.
    for (let i = 0; i < 2; i++) {
      await seedAccount({
        kittyType: 'BASE',
        currentArc: 600000,
        startOfPeriodArc: 600000,
        samOwnerId: samA.id,
      });
    }
    for (let i = 0; i < 4; i++) {
      await seedAccount({
        kittyType: 'BASE',
        currentArc: 600000,
        startOfPeriodArc: 600000,
        samOwnerId: samB.id,
      });
    }

    void head;
    const tok = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, `/dashboard/team-performance/${samA.id}`, tok);
    expect(res.status).toBe(200);
    expect(res.body.kpis.customers.value).toBe(2);
    // Team avg (peers only, so just Sam B): 4 customers.
    expect(res.body.kpis.customers.teamAvg).toBeCloseTo(4, 0);
    expect(res.body.kpis.arcManaged.value).toBe(1200000);
    expect(res.body.kpis.arcManaged.teamAvg).toBeCloseTo(2400000, 0);

    // Score components sum to total (4 weighted figures).
    const c = res.body.score.components;
    const sum = c.revenue.weighted + c.mom.weighted + c.compliance.weighted + c.onboarding.weighted;
    expect(sum).toBeCloseTo(res.body.score.total, 1);
    // Weights are the documented 40 / 20 / 25 / 15.
    expect(c.revenue.weight).toBe(40);
    expect(c.mom.weight).toBe(20);
    expect(c.compliance.weight).toBe(25);
    expect(c.onboarding.weight).toBe(15);
  });

  it('teamAvg gracefully degrades when the SAM has no peers', async () => {
    const { lonerHead, lonerSam } = await setupTeam();
    await seedAccount({ samOwnerId: lonerSam.id, currentArc: 500000 });
    const tok = await tokenFor(lonerHead.id, 'SAM_HEAD');
    const res = await authedGet(
      app,
      `/dashboard/team-performance/${lonerSam.id}`,
      tok,
    );
    expect(res.status).toBe(200);
    // No peers → teamAvg defaults to 0 across the board.
    expect(res.body.kpis.customers.teamAvg).toBe(0);
    expect(res.body.kpis.arcManaged.teamAvg).toBe(0);
  });
});

describe('GET /dashboard/team-performance/:samId — meetings + activity + risk', () => {
  it('upcomingMeetings lists scheduled meetings ahead of now, sorted ascending; recentMeetings lists held meetings within 14 days', async () => {
    const { admin, samA } = await setupTeam();
    const acct = await seedAccount({ samOwnerId: samA.id, currentArc: 500000 });
    const now = new Date();
    const ms = (offsetMs: number) => new Date(now.getTime() + offsetMs);
    await prisma.meeting.create({
      data: {
        accountId: acct.id,
        scheduledAt: ms(3 * 24 * 60 * 60 * 1000), // 3 days ahead
        createdBy: admin.id,
      },
    });
    await prisma.meeting.create({
      data: {
        accountId: acct.id,
        scheduledAt: ms(7 * 24 * 60 * 60 * 1000), // 7 days ahead
        createdBy: admin.id,
      },
    });
    await prisma.meeting.create({
      data: {
        accountId: acct.id,
        scheduledAt: ms(-2 * 24 * 60 * 60 * 1000),
        heldAt: ms(-2 * 24 * 60 * 60 * 1000), // 2 days ago, held
        momSentAt: ms(-1 * 24 * 60 * 60 * 1000),
        createdBy: admin.id,
      },
    });

    const tok = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, `/dashboard/team-performance/${samA.id}`, tok);
    expect(res.status).toBe(200);
    expect(res.body.upcomingMeetings).toHaveLength(2);
    expect(res.body.recentMeetings).toHaveLength(1);
    // Ordered ascending by scheduledAt.
    expect(
      new Date(res.body.upcomingMeetings[0].scheduledAt).getTime(),
    ).toBeLessThan(new Date(res.body.upcomingMeetings[1].scheduledAt).getTime());
    expect(res.body.recentMeetings[0].momSentAt).not.toBeNull();
    expect(res.body.recentMeetings[0].momOverdue).toBe(false);
  });

  it('riskPulse counts probable-churn customers + at-risk ARC + stale MOMs + customers without meetings', async () => {
    const { admin, samA } = await setupTeam();
    // 1 ACTIVE + 1 PROBABLE_CHURN + 1 DISCONNECTING + 1 ACTIVE w/o meeting.
    await seedAccount({
      samOwnerId: samA.id,
      currentArc: 500000,
      contractStatus: 'ACTIVE',
    });
    const churn = await seedAccount({
      samOwnerId: samA.id,
      currentArc: 600000,
      contractStatus: 'PROBABLE_CHURN',
    });
    await seedAccount({
      samOwnerId: samA.id,
      currentArc: 400000,
      contractStatus: 'DISCONNECTING',
    });
    const noMtg = await seedAccount({
      samOwnerId: samA.id,
      currentArc: 700000,
      contractStatus: 'ACTIVE',
    });
    void noMtg;

    // Stale MOM: meeting held > 48h ago, no MOM.
    const seventyHoursAgo = new Date(Date.now() - 70 * 60 * 60 * 1000);
    await prisma.meeting.create({
      data: {
        accountId: churn.id,
        scheduledAt: seventyHoursAgo,
        heldAt: seventyHoursAgo,
        createdBy: admin.id,
      },
    });

    const tok = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, `/dashboard/team-performance/${samA.id}`, tok);
    expect(res.status).toBe(200);
    const pulse = res.body.riskPulse;
    expect(pulse.probableChurnCount).toBe(2); // PROBABLE_CHURN + DISCONNECTING
    expect(pulse.probableChurnArc).toBe(1000000); // 6L + 4L
    // 4 active-ish (ACTIVE + PC + DISC + ACTIVE); 3 don't have meetings.
    expect(pulse.customersWithoutMeeting).toBe(3);
    expect(pulse.staleMoms).toBe(1);
  });

  it('activityTimeline merges commercial-change commits + meetings + MOMs, newest first, last 30d', async () => {
    const { admin, samA } = await setupTeam();
    const acct = await seedAccount({ samOwnerId: samA.id, currentArc: 600000 });
    const now = Date.now();
    const days = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000);
    // 5d ago: meeting held + MOM sent. 2d ago: upgrade committed.
    await prisma.meeting.create({
      data: {
        accountId: acct.id,
        scheduledAt: days(5),
        heldAt: days(5),
        momSentAt: days(4),
        createdBy: admin.id,
      },
    });
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldArc: 600000,
        newArc: 720000,
        effectiveDate: days(2),
        clientApprovalAttached: true,
        createdBy: admin.id,
        createdAt: days(2),
      },
    });

    const tok = await tokenFor(admin.id, 'ADMIN');
    const res = await authedGet(app, `/dashboard/team-performance/${samA.id}`, tok);
    expect(res.status).toBe(200);
    const tl: Array<{ type: string; timestamp: string }> = res.body.activityTimeline;
    // 3 events: MEETING_HELD, MOM_SENT, CHANGE_COMMITTED.
    const types = tl.map((t) => t.type);
    expect(types).toContain('CHANGE_COMMITTED');
    expect(types).toContain('MEETING_HELD');
    expect(types).toContain('MOM_SENT');
    // Newest first.
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i - 1].timestamp >= tl[i].timestamp).toBe(true);
    }
  });
});

describe('GET /dashboard/team-performance/:samId — period filter', () => {
  it('quarter filter scopes commercial changes + meetings to the FY-quarter window', async () => {
    const { admin, samA } = await setupTeam();
    const acct = await seedAccount({
      samOwnerId: samA.id,
      currentArc: 720000,
      startOfPeriodArc: 600000,
    });
    // Q1 (Apr–Jun) upgrade
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldArc: 600000,
        newArc: 720000,
        effectiveDate: new Date('2026-05-15'),
        clientApprovalAttached: true,
        createdBy: admin.id,
      },
    });
    // Q3 (Oct–Dec) upgrade
    await prisma.commercialChange.create({
      data: {
        accountId: acct.id,
        changeType: 'UPGRADE',
        oldArc: 720000,
        newArc: 900000,
        effectiveDate: new Date('2026-11-10'),
        clientApprovalAttached: true,
        createdBy: admin.id,
      },
    });

    const tok = await tokenFor(admin.id, 'ADMIN');
    const q1 = await authedGet(
      app,
      `/dashboard/team-performance/${samA.id}?quarter=Q1`,
      tok,
    );
    expect(q1.body.quarter).toBe('Q1');
    expect(q1.body.kpis.commercialChanges.value).toBe(1);
    expect(q1.body.changes.UPGRADE.count).toBe(1);

    const all = await authedGet(app, `/dashboard/team-performance/${samA.id}`, tok);
    expect(all.body.quarter).toBeNull();
    expect(all.body.kpis.commercialChanges.value).toBe(2);
  });
});
