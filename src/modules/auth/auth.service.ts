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

  /**
   * Self-service password change. Verifies the caller's current password
   * before writing the new hash. Throws a typed error the controller maps to
   * an HTTP status:
   *   USER_NOT_FOUND           — stale session (user deleted)
   *   INVALID_CURRENT_PASSWORD — current password didn't match
   *   SAME_PASSWORD            — new password equals the current one
   *
   * The JWT is stateless, so the existing session cookie stays valid after a
   * change — there's no session store to revoke.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ email: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('USER_NOT_FOUND');

    const currentOk = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentOk) throw new Error('INVALID_CURRENT_PASSWORD');

    // Reject a no-op change so "changed" always means something changed.
    const sameAsOld = await bcrypt.compare(newPassword, user.passwordHash);
    if (sameAsOld) throw new Error('SAME_PASSWORD');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { email: user.email };
  },
};
