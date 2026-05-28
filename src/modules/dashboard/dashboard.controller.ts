import type { Response } from 'express';
import type { CommercialChangeType, KittyType } from '@prisma/client';
import {
  dashboardService,
  computeNewBase,
  type FyQuarter,
} from './dashboard.service.js';
import { computeSamDetail, computeTeamPerformance } from './team-performance.service.js';
import { computeAlerts } from './alerts.service.js';
import { getBucketChanges } from './bucket-changes.service.js';
import type { AuthedRequest } from '../auth/auth.middleware.js';

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
const KITTY_TYPES: readonly KittyType[] = ['BASE', 'NEW'];
const BUCKETS: readonly CommercialChangeType[] = [
  'UPGRADE',
  'DOWNGRADE',
  'RATE_REVISION',
  'DISCONNECTION',
];

export const dashboardController = {
  async existingBase(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const raw = typeof req.query.quarter === 'string' ? req.query.quarter : undefined;
    const quarter: FyQuarter | undefined = (QUARTERS as readonly string[]).includes(raw ?? '')
      ? (raw as FyQuarter)
      : undefined;
    const data = await dashboardService.existingBase({ quarter, requester: req.user });
    res.json(data);
  },

  async newBase(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const data = await computeNewBase({ requester: req.user });
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

  async samDetail(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (req.user.role === 'SAM') {
      res.status(403).json({ error: 'SAMs cannot view other SAMs' });
      return;
    }
    const samId = req.params.samId;
    if (typeof samId !== 'string' || samId.length === 0) {
      res.status(400).json({ error: 'samId required' });
      return;
    }
    const rawQuarter = typeof req.query.quarter === 'string' ? req.query.quarter : '';
    const quarter: FyQuarter | undefined = (QUARTERS as readonly string[]).includes(rawQuarter)
      ? (rawQuarter as FyQuarter)
      : undefined;
    const data = await computeSamDetail({ samId, quarter, requester: req.user });
    if (!data) {
      res.status(404).json({ error: 'SAM not found or not in your team' });
      return;
    }
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

  async bucketChanges(req: AuthedRequest, res: Response) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const rawKitty = typeof req.query.kittyType === 'string' ? req.query.kittyType : '';
    const rawBucket = typeof req.query.bucket === 'string' ? req.query.bucket : '';
    const rawQuarter = typeof req.query.quarter === 'string' ? req.query.quarter : '';

    if (!(KITTY_TYPES as readonly string[]).includes(rawKitty)) {
      res.status(400).json({ error: 'kittyType must be BASE or NEW' });
      return;
    }
    if (!(BUCKETS as readonly string[]).includes(rawBucket)) {
      res.status(400).json({
        error: 'bucket must be UPGRADE, DOWNGRADE, RATE_REVISION or DISCONNECTION',
      });
      return;
    }
    const quarter: FyQuarter | undefined = (QUARTERS as readonly string[]).includes(rawQuarter)
      ? (rawQuarter as FyQuarter)
      : undefined;

    const data = await getBucketChanges({
      kittyType: rawKitty as KittyType,
      bucket: rawBucket as CommercialChangeType,
      quarter,
      requester: req.user,
    });
    res.json(data);
  },
};
