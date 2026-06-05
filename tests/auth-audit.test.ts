import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/prisma.js';
import { resetDb, seedUser } from './helpers/db.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';

/**
 * Tests for the audit trail on /auth/login + /auth/logout.
 *
 * These cover the LOGIN / LOGIN_FAILED / LOGOUT actions wired in
 * `auth.controller.ts`. The forensic value of those rows is high (incident
 * response uses them), so it's worth a small smoke suite making sure they
 * keep firing.
 *
 * Note: each test uses a unique email so the in-memory rate-limit on
 * /auth/login (5 attempts / 15min keyed on ip+email) doesn't bleed across
 * tests within the same run.
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});
beforeEach(async () => {
  await resetDb();
});

describe('Auth audit trail', () => {
  it('LOGIN — successful sign-in writes a LOGIN audit row attributed to the user', async () => {
    const user = await seedUser({ email: 'audit-login@x.com', password: 'pw' });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'audit-login@x.com', password: 'pw' });
    expect(res.status).toBe(200);

    const logs = await prisma.auditLog.findMany({
      where: { action: 'LOGIN' },
      orderBy: { timestamp: 'desc' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.entityType).toBe('User');
    expect(logs[0]!.entityId).toBe(user.id);
    expect(logs[0]!.performedBy).toBe(user.id);
    const payload = logs[0]!.payload as { email: string; role: string };
    expect(payload.email).toBe('audit-login@x.com');
    expect(payload.role).toBe('SAM');
  });

  it('LOGIN_FAILED — wrong password writes an unattributed audit row with the attempted email', async () => {
    await seedUser({ email: 'audit-fail@x.com', password: 'right' });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'audit-fail@x.com', password: 'wrong' });
    expect(res.status).toBe(401);

    const logs = await prisma.auditLog.findMany({
      where: { action: 'LOGIN_FAILED' },
      orderBy: { timestamp: 'desc' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.entityType).toBe('User');
    // Pre-auth event — no authenticated user, so performedBy is null.
    expect(logs[0]!.performedBy).toBeNull();
    const payload = logs[0]!.payload as {
      emailAttempted: string;
      reason: string;
    };
    expect(payload.emailAttempted).toBe('audit-fail@x.com');
    expect(payload.reason).toMatch(/Invalid email or password/i);
  });

  it('LOGIN_FAILED — also fires when the email is unknown (no such user)', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'unknown@x.com', password: 'anything' });
    expect(res.status).toBe(401);

    const logs = await prisma.auditLog.findMany({
      where: { action: 'LOGIN_FAILED' },
    });
    expect(logs).toHaveLength(1);
    const payload = logs[0]!.payload as { emailAttempted: string };
    expect(payload.emailAttempted).toBe('unknown@x.com');
  });

  it('LOGOUT — writes an audit row for the user, then clears the cookie', async () => {
    const user = await seedUser({ email: 'audit-logout@x.com', password: 'pw' });
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'audit-logout@x.com', password: 'pw' });
    const cookie = (login.get('Set-Cookie') as unknown as string[]).find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(cookie).toBeTruthy();

    const out = await request(app).post('/auth/logout').set('Cookie', cookie!);
    expect(out.status).toBe(200);

    const logs = await prisma.auditLog.findMany({
      where: { action: 'LOGOUT' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.entityId).toBe(user.id);
    expect(logs[0]!.performedBy).toBe(user.id);

    // Cookie should be cleared (Set-Cookie sets it to '' with Max-Age=0)
    const clearedHeader = (out.get('Set-Cookie') as unknown as string[]).find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(clearedHeader).toMatch(/Max-Age=0/);
  });

  it('LOGOUT — without a session cookie still succeeds but does NOT write an audit row', async () => {
    const res = await request(app).post('/auth/logout');
    expect(res.status).toBe(200);

    const logs = await prisma.auditLog.findMany({
      where: { action: 'LOGOUT' },
    });
    expect(logs).toHaveLength(0);
  });

  it('Captures IP + user-agent on every login event', async () => {
    await seedUser({ email: 'audit-ip@x.com', password: 'pw' });
    const res = await request(app)
      .post('/auth/login')
      .set('User-Agent', 'sam-test-suite/1.0')
      .send({ email: 'audit-ip@x.com', password: 'pw' });
    expect(res.status).toBe(200);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'LOGIN' },
    });
    expect(log).toBeTruthy();
    // Test peer IP can vary — assert it's a non-null string at minimum.
    expect(typeof log!.ipAddress).toBe('string');
    expect(log!.userAgent).toBe('sam-test-suite/1.0');
  });
});
