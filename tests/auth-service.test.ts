import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { authService } from '../src/modules/auth/auth.service.js';
import { resetDb, seedUser } from './helpers/db.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

beforeEach(async () => {
  await resetDb();
});

describe('authService.validateCredentials', () => {
  it('returns the user on correct email + password', async () => {
    await seedUser({ email: 'a@b.com', password: 'right' });
    const user = await authService.validateCredentials('a@b.com', 'right');
    expect(user?.email).toBe('a@b.com');
  });

  it('returns null on wrong password', async () => {
    await seedUser({ email: 'a@b.com', password: 'right' });
    expect(await authService.validateCredentials('a@b.com', 'wrong')).toBeNull();
  });

  it('returns null when user does not exist', async () => {
    expect(await authService.validateCredentials('ghost@b.com', 'pw')).toBeNull();
  });
});

describe('authService.hashPassword', () => {
  it('produces a bcrypt hash that compareSync verifies', async () => {
    const hash = await authService.hashPassword('hello');
    const bcrypt = (await import('bcryptjs')).default;
    expect(bcrypt.compareSync('hello', hash)).toBe(true);
    expect(bcrypt.compareSync('wrong', hash)).toBe(false);
  });
});
