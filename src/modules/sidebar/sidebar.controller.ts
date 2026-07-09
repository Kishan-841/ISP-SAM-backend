import type { Response } from 'express';
import { sidebarService } from './sidebar.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

export const sidebarController = {
  async counts(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const counts = await sidebarService.getCounts({
      id: req.user.id,
      role: req.user.role,
    });
    res.json(counts);
  },
};
