import { Router } from 'express';
import { leaderboardController } from './leaderboard.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const leaderboardRouter = Router();
leaderboardRouter.use(requireAuth);
leaderboardRouter.get('/', leaderboardController.ranking);
