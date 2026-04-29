import type { Request, Response } from 'express';
import type { KittyType } from '@prisma/client';
import { accountsService } from './accounts.service.js';

export const accountsController = {
  async list(req: Request, res: Response) {
    const kittyType = req.query.kittyType as KittyType | undefined;
    const accounts = await accountsService.list({ kittyType });
    res.json({ accounts });
  },

  async getById(req: Request, res: Response) {
    const account = await accountsService.getById(req.params.id as string);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json({ account });
  },
};
