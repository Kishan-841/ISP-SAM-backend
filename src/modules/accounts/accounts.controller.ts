import type { Response } from 'express';
import { z } from 'zod';
import type { KittyType } from '@prisma/client';
import { accountsService, type OwnerFilter } from './accounts.service.js';
import { prisma } from '../../prisma.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

const OWNER_FILTERS: ReadonlySet<string> = new Set(['mine', 'unassigned', 'team', 'all']);

const assignSchema = z.object({
  samUserId: z.string().uuid().nullable(),
});

export const accountsController = {
  async list(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const kittyType = req.query.kittyType as KittyType | undefined;
    const ownerRaw = typeof req.query.owner === 'string' ? req.query.owner : undefined;
    const owner: OwnerFilter | undefined =
      ownerRaw && OWNER_FILTERS.has(ownerRaw) ? (ownerRaw as OwnerFilter) : undefined;
    const accounts = await accountsService.list({
      kittyType,
      owner,
      requester: req.user,
    });
    res.json({ accounts });
  },

  async getById(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const account = await accountsService.getById(req.params.id as string, req.user);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json({ account });
  },

  async journey(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const data = await accountsService.journey(req.params.id as string, req.user);
    if (!data) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json(data);
  },

  /**
   * POST /accounts/:id/assign
   * Body: { samUserId: string | null }
   *
   * Authorisation:
   *  - ADMIN     → can assign to any SAM, or unassign (samUserId=null)
   *  - SAM_HEAD  → can assign only to their own direct reports (or unassign)
   *  - SAM       → 403 (route-level guard does this)
   */
  async assign(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const parse = assignSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.issues[0]?.message ?? 'Invalid body' });
      return;
    }
    const { samUserId } = parse.data;
    const accountId = req.params.id as string;

    // Validate target user (when assigning, not unassigning).
    if (samUserId) {
      const target = await prisma.user.findUnique({
        where: { id: samUserId },
        select: { id: true, role: true, samHeadId: true },
      });
      if (!target) {
        res.status(400).json({ error: 'samUserId does not reference an existing user' });
        return;
      }
      if (target.role !== 'SAM') {
        res.status(400).json({ error: 'Customers can only be assigned to users with role SAM' });
        return;
      }
      if (req.user.role === 'SAM_HEAD' && target.samHeadId !== req.user.id) {
        res.status(403).json({
          error: 'You can only assign customers to SAMs reporting to you',
        });
        return;
      }
    }

    try {
      const account = await accountsService.assign({
        accountId,
        samUserId,
        requester: req.user,
      });
      res.json({ account });
    } catch (err) {
      if (err instanceof Error && err.message === 'Account not found') {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
};
