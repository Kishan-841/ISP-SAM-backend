import type { Response } from 'express';
import type { KittyType } from '@prisma/client';
import { accountsService } from './accounts.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

export const accountsController = {
  async list(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const kittyType = req.query.kittyType as KittyType | undefined;
    const accounts = await accountsService.list({ kittyType, requester: req.user });
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
};
