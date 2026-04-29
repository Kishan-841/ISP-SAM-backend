import { SignJWT, jwtVerify } from 'jose';
import type { UserRole } from '@prisma/client';

export type SessionClaims = {
  sub: string;
  role: UserRole;
};

const COOKIE_NAME = 'sam_session';
const TOKEN_TTL = '7d';

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(raw);
}

export async function signSessionToken(claims: SessionClaims): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, getSecret());
  return { sub: payload.sub as string, role: payload.role as UserRole };
}

export const SESSION_COOKIE = COOKIE_NAME;
