import type { Request, Response } from 'express';
import { dashboardService } from './dashboard.service.js';

export const dashboardController = {
  async existingBase(_req: Request, res: Response) {
    const data = await dashboardService.existingBase();
    res.json(data);
  },
};
