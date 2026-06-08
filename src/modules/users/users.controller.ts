import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { usersService } from './users.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

const createSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  name: z.string().min(1),
  role: z.enum(['ADMIN', 'SAM_HEAD', 'SAM']),
  password: z.string().min(6),
  samHeadId: z.string().uuid().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(['ADMIN', 'SAM_HEAD', 'SAM']).optional(),
  /** null clears the reports-to; undefined leaves it alone. */
  samHeadId: z.string().uuid().nullable().optional(),
  /** When present, admin is resetting the user's password. */
  password: z.string().min(6).optional(),
  /**
   * Per-SAM allowable churn budget (incentive ceiling). Constrained to the
   * 6.00–8.00 product range. Stored on every User row but only meaningful
   * when role = SAM; validation here doesn't enforce role since the value
   * is harmless on non-SAM rows and may be tuned ahead of role change.
   */
  allowableChurnPercent: z
    .number()
    .min(6, { message: 'allowableChurnPercent must be ≥ 6.00' })
    .max(8, { message: 'allowableChurnPercent must be ≤ 8.00' })
    .optional(),
});

function publicUser(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
  allowableChurnPercent?: unknown;
  samHead?: { id: string; name: string } | null;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    // Decimal serialises as string out of Prisma — coerce to number so the
    // shape matches the editable input on the frontend.
    allowableChurnPercent:
      u.allowableChurnPercent == null ? null : Number(u.allowableChurnPercent),
    samHead: u.samHead ?? null,
  };
}

export const usersController = {
  async list(_req: Request, res: Response) {
    const users = await usersService.list();
    res.json({ users: users.map(publicUser) });
  },

  async team(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const users = await usersService.team({ requester: req.user });
    res.json({ users });
  },

  async getById(req: Request, res: Response) {
    const user = await usersService.getById(req.params.id as string);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user: publicUser(user) });
  },

  async create(req: Request, res: Response) {
    const parse = createSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    const data = parse.data;

    if (data.samHeadId !== undefined) {
      if (data.role !== 'SAM') {
        res.status(400).json({ error: 'samHeadId can only be set when role is SAM' });
        return;
      }
      const head = await usersService.getById(data.samHeadId);
      if (!head || head.role !== 'SAM_HEAD') {
        res.status(400).json({ error: 'samHeadId must reference a SAM_HEAD user' });
        return;
      }
    }

    try {
      const user = await usersService.create({ ...data, samHeadId: data.samHeadId ?? null });
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        res.status(409).json({ error: 'Email already exists' });
        return;
      }
      throw err;
    }
  },

  async update(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const parse = updateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    const data = parse.data;
    const id = req.params.id as string;

    const target = await usersService.getById(id);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const nextRole = data.role ?? target.role;
    const nextSamHeadId =
      data.samHeadId === undefined ? target.samHeadId : data.samHeadId;

    // Invariants:
    //   SAM → must have a samHeadId pointing at a SAM_HEAD user.
    //   non-SAM → samHeadId must be null.
    if (nextRole === 'SAM') {
      if (!nextSamHeadId) {
        res.status(400).json({ error: 'SAM users must have a reports-to (samHeadId)' });
        return;
      }
      const head = await usersService.getById(nextSamHeadId);
      if (!head || head.role !== 'SAM_HEAD') {
        res.status(400).json({ error: 'samHeadId must reference a SAM_HEAD user' });
        return;
      }
    } else if (nextSamHeadId !== null) {
      res
        .status(400)
        .json({ error: 'samHeadId can only be set when role is SAM' });
      return;
    }

    // Guard: cannot demote the last ADMIN.
    if (target.role === 'ADMIN' && nextRole !== 'ADMIN') {
      const isLast = await usersService.isLastAdmin(id);
      if (isLast) {
        res.status(400).json({ error: 'Cannot demote the last ADMIN' });
        return;
      }
    }

    try {
      const user = await usersService.update({
        id,
        patch: {
          name: data.name,
          role: data.role,
          samHeadId: data.samHeadId,
          allowableChurnPercent: data.allowableChurnPercent,
        },
        newPassword: data.password,
        performedByUserId: req.user.id,
      });
      res.json({ user: publicUser(user) });
    } catch (err) {
      if (err instanceof Error && err.message === 'User not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  async remove(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const id = req.params.id as string;
    if (id === req.user.id) {
      res.status(400).json({ error: 'Cannot delete your own user' });
      return;
    }
    const target = await usersService.getById(id);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (target.role === 'ADMIN') {
      const isLast = await usersService.isLastAdmin(id);
      if (isLast) {
        res.status(400).json({ error: 'Cannot delete the last ADMIN' });
        return;
      }
    }
    try {
      const snapshot = await usersService.remove({
        id,
        performedByUserId: req.user.id,
      });
      res.json({ deleted: true, snapshot });
    } catch (err) {
      if (err instanceof Error && err.message === 'User not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
};
