import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { prisma } from '../../prisma.js';

const BCRYPT_ROUNDS = 12;

export const authService = {
  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
  },

  async validateCredentials(email: string, password: string): Promise<User | null> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    return ok ? user : null;
  },
};
