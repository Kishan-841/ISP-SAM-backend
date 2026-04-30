import type { Request, Response } from 'express';
import { z } from 'zod';
import { leaderboardService } from './leaderboard.service.js';

const querySchema = z.object({
  role: z.enum(['SAM', 'SAM_HEAD']).default('SAM'),
});

export const leaderboardController = {
  async ranking(req: Request, res: Response) {
    const parse = querySchema.safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }
    const rows = await leaderboardService.ranking(parse.data.role);
    res.json({ ranking: rows });
  },
};
