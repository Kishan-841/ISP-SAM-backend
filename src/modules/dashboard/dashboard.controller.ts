import type { Request, Response } from 'express';
import {
  dashboardService,
  computeNewBase,
  type FyQuarter,
} from './dashboard.service.js';
import { computeTeamPerformance } from './team-performance.service.js';
import { computeAlerts } from './alerts.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

export const dashboardController = {
  async existingBase(req: Request, res: Response) {
    const raw = typeof req.query.quarter === 'string' ? req.query.quarter : undefined;
    const quarter: FyQuarter | undefined = (QUARTERS as readonly string[]).includes(raw ?? '')
      ? (raw as FyQuarter)
      : undefined;
    const data = await dashboardService.existingBase({ quarter });
    res.json(data);
  },

  async newBase(_req: Request, res: Response) {
    const data = await computeNewBase();
    res.json(data);
  },

  async teamPerformance(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const data = await computeTeamPerformance({ requester: req.user });
    res.json(data);
  },

  async alerts(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const data = await computeAlerts({ requester: req.user });
    res.json(data);
  },
};
