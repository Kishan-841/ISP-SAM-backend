import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { usersService } from './users.service.js';

const createSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  name: z.string().min(1),
  role: z.enum(['ADMIN', 'SAM_HEAD', 'SAM']),
  password: z.string().min(6),
  samHeadId: z.string().uuid().optional(),
});

function publicUser(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
  samHead?: { id: string; name: string } | null;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    samHead: u.samHead ?? null,
  };
}

export const usersController = {
  async list(_req: Request, res: Response) {
    const users = await usersService.list();
    res.json({ users: users.map(publicUser) });
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
};
