/**
 * Public feedback survey + admin Feedbacks module.
 * Public GET /feedback/form + POST /feedback (no auth); scoring; role-gated
 * admin list/detail with SAM_HEAD scoping.
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

function cookie(id: string, role: string) {
  return tokenFor(id, role as never).then((t) => `${SESSION_COOKIE}=${t}`);
}

function baseAnswers(samId: string) {
  return {
    q1: 'Acme Corp',
    q2: 'Ravi Kumar',
    q4: 'ravi@acme.com',
    q5: '9876543210',
    yourSam: samId,
    q7: 5,
    q8: 4,
    q9: 3,
    q10: 9,
  };
}

describe('Feedback — public form', () => {
  it('serves the question catalog + SAM options with no auth', async () => {
    await seedUser({ email: 'sam@x.com', name: 'Sam One', role: 'SAM' });
    const res = await request(app).get('/feedback/form');
    expect(res.status).toBe(200);
    expect(res.body.questions.length).toBeGreaterThan(15);
    expect(res.body.sams).toHaveLength(1);
    expect(res.body.sams[0].name).toBe('Sam One');
  });

  it('accepts a submission and computes score + interest level', async () => {
    const sam = await seedUser({ email: 'sam@x.com', name: 'Sam One', role: 'SAM' });
    const res = await request(app).post('/feedback').send({ responses: baseAnswers(sam.id) });
    expect(res.status).toBe(201);
    // (5+4+3)/3 = 4.0 → High
    expect(res.body.overallScore).toBe(4);
    expect(res.body.interestLevel).toBe('High');

    const stored = await prisma.feedback.findUnique({ where: { id: res.body.id } });
    expect(stored?.companyName).toBe('Acme Corp');
    expect(stored?.customerName).toBe('Ravi Kumar');
    expect(stored?.samId).toBe(sam.id);
    expect(stored?.npsScore).toBe(9);
  });

  it('rejects missing required fields', async () => {
    const sam = await seedUser({ email: 'sam@x.com', role: 'SAM' });
    const answers = baseAnswers(sam.id);
    delete (answers as Record<string, unknown>).q7;
    const res = await request(app).post('/feedback').send({ responses: answers });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid SAM id', async () => {
    await seedUser({ email: 'sam@x.com', role: 'SAM' });
    const res = await request(app)
      .post('/feedback')
      .send({ responses: baseAnswers('00000000-0000-0000-0000-000000000000') });
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range rating', async () => {
    const sam = await seedUser({ email: 'sam@x.com', role: 'SAM' });
    const res = await request(app)
      .post('/feedback')
      .send({ responses: { ...baseAnswers(sam.id), q7: 9 } });
    expect(res.status).toBe(400);
  });
});

describe('Feedback — admin module', () => {
  it('lists feedback for ADMIN and rejects SAM', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam@x.com', name: 'Sam One', role: 'SAM' });
    await request(app).post('/feedback').send({ responses: baseAnswers(sam.id) });

    const ok = await request(app).get('/feedback').set('Cookie', await cookie(admin.id, 'ADMIN'));
    expect(ok.status).toBe(200);
    expect(ok.body.feedbacks).toHaveLength(1);

    const denied = await request(app).get('/feedback').set('Cookie', await cookie(sam.id, 'SAM'));
    expect(denied.status).toBe(403);
  });

  it('scopes SAM_HEAD to their own reports', async () => {
    const headA = await seedUser({ email: 'ha@x.com', role: 'SAM_HEAD' });
    const headB = await seedUser({ email: 'hb@x.com', role: 'SAM_HEAD' });
    const samA = await prisma.user.create({ data: { email: 'sa@x.com', name: 'SamA', role: 'SAM', passwordHash: 'x', samHeadId: headA.id } });
    const samB = await prisma.user.create({ data: { email: 'sb@x.com', name: 'SamB', role: 'SAM', passwordHash: 'x', samHeadId: headB.id } });
    await request(app).post('/feedback').send({ responses: baseAnswers(samA.id) });
    await request(app).post('/feedback').send({ responses: baseAnswers(samB.id) });

    const res = await request(app).get('/feedback').set('Cookie', await cookie(headA.id, 'SAM_HEAD'));
    expect(res.status).toBe(200);
    expect(res.body.feedbacks).toHaveLength(1);
    expect(res.body.feedbacks[0].sam.id).toBe(samA.id);
  });

  it('returns full detail with question catalog', async () => {
    const admin = await seedUser({ email: 'admin@x.com', role: 'ADMIN' });
    const sam = await seedUser({ email: 'sam@x.com', role: 'SAM' });
    const created = await request(app).post('/feedback').send({ responses: baseAnswers(sam.id) });

    const res = await request(app)
      .get(`/feedback/${created.body.id}`)
      .set('Cookie', await cookie(admin.id, 'ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.responses.q1).toBe('Acme Corp');
    expect(res.body.questions.length).toBeGreaterThan(15);
  });
});
