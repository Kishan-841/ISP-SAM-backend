import request from 'supertest';
import type { Express } from 'express';
import { signSessionToken, SESSION_COOKIE } from '../../src/lib/jwt.js';
import type { UserRole } from '@prisma/client';

export async function tokenFor(userId: string, role: UserRole): Promise<string> {
  return signSessionToken({ sub: userId, role });
}

export function authedGet(app: Express, path: string, token: string) {
  return request(app).get(path).set('Cookie', `${SESSION_COOKIE}=${token}`);
}

export function authedPost(app: Express, path: string, token: string) {
  return request(app).post(path).set('Cookie', `${SESSION_COOKIE}=${token}`);
}
