import { describe, it, expect, beforeAll } from 'vitest';
import { signSessionToken, verifySessionToken } from '../src/lib/jwt.js';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-min-32-characters-long-aaa';
});

describe('signSessionToken / verifySessionToken', () => {
  it('round-trips a payload', async () => {
    const token = await signSessionToken({ sub: 'user-1', role: 'ADMIN' });
    const claims = await verifySessionToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.role).toBe('ADMIN');
  });

  it('throws on a tampered token', async () => {
    const token = await signSessionToken({ sub: 'user-1', role: 'SAM' });
    const tampered = token.slice(0, -3) + 'XYZ';
    await expect(verifySessionToken(tampered)).rejects.toThrow();
  });

  it('throws when JWT_SECRET is missing', async () => {
    const original = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    await expect(signSessionToken({ sub: 'user-1', role: 'SAM' })).rejects.toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = original;
  });
});
