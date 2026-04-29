import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { usersService } from './users.service.js';

const createSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  name: z.string().min(1),
  role: z.enum(['ADMIN', 'SAM_HEAD', 'SAM']),
  password: z.string().min(6),
});

function publicUser(u: { id: string; email: string; name: string; role: string; createdAt: Date }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt };
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
    try {
      const user = await usersService.create(parse.data);
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
