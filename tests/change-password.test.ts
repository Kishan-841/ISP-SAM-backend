import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { resetDb, seedUser } from './helpers/db.js';
import { tokenFor } from './helpers/auth.js';
import { SESSION_COOKIE } from '../src/lib/jwt.js';
import { authService } from '../src/modules/auth/auth.service.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
});

async function seedWithPassword(password: string) {
  const user = await seedUser({ email: 'u@x.com', name: 'U', role: 'SAM', password });
  const cookie = `${SESSION_COOKIE}=${await tokenFor(user.id, 'SAM')}`;
  return { user, cookie };
}

describe('POST /auth/change-password (signed-in)', () => {
  it('changes the password when the current one is correct', async () => {
    const { user, cookie } = await seedWithPassword('oldpass123');

    const res = await request(app)
      .post('/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'oldpass123', newPassword: 'newpass123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // New password works, old one no longer does.
    expect(await authService.validateCredentials(user.email, 'newpass123')).not.toBeNull();
    expect(await authService.validateCredentials(user.email, 'oldpass123')).toBeNull();
  });

  it('rejects a wrong current password with 400', async () => {
    const { user, cookie } = await seedWithPassword('oldpass123');

    const res = await request(app)
      .post('/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'not-the-password', newPassword: 'newpass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current password is incorrect/i);

    // Password unchanged.
    expect(await authService.validateCredentials(user.email, 'oldpass123')).not.toBeNull();
  });

  it('rejects a too-short new password with 400', async () => {
    const { cookie } = await seedWithPassword('oldpass123');
    const res = await request(app)
      .post('/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'oldpass123', newPassword: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 6/i);
  });

  it('rejects reusing the current password with 400', async () => {
    const { cookie } = await seedWithPassword('oldpass123');
    const res = await request(app)
      .post('/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'oldpass123', newPassword: 'oldpass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different/i);
  });
});

describe('POST /auth/change-password (signed-out, login page)', () => {
  it('requires an email when there is no session', async () => {
    await seedWithPassword('oldpass123');
    const res = await request(app)
      .post('/auth/change-password')
      .send({ currentPassword: 'oldpass123', newPassword: 'newpass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email is required/i);
  });

  it('changes the password with email + current password, no session', async () => {
    const { user } = await seedWithPassword('oldpass123');
    const res = await request(app)
      .post('/auth/change-password')
      .send({ email: user.email, currentPassword: 'oldpass123', newPassword: 'newpass123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await authService.validateCredentials(user.email, 'newpass123')).not.toBeNull();
    expect(await authService.validateCredentials(user.email, 'oldpass123')).toBeNull();
  });

  it('returns a generic error for an unknown email (no enumeration)', async () => {
    await seedWithPassword('oldpass123');
    const res = await request(app)
      .post('/auth/change-password')
      .send({ email: 'nobody@x.com', currentPassword: 'oldpass123', newPassword: 'newpass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email or current password is incorrect/i);
  });

  it('returns the same generic error for a wrong current password', async () => {
    const { user } = await seedWithPassword('oldpass123');
    const res = await request(app)
      .post('/auth/change-password')
      .send({ email: user.email, currentPassword: 'wrong', newPassword: 'newpass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email or current password is incorrect/i);
    // Unchanged.
    expect(await authService.validateCredentials(user.email, 'oldpass123')).not.toBeNull();
  });
});
