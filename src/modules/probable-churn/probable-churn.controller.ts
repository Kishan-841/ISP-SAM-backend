import type { Response } from 'express';
import { listProbableChurn } from './probable-churn.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

export const probableChurnController = {
  async list(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const data = await listProbableChurn(req.user);
    res.json(data);
  },
};
