import express, { type Request } from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/error-handler.js';
import { accountsRouter } from './modules/accounts/accounts.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { commercialChangesRouter } from './modules/commercial-changes/commercial-changes.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { integrationsRouter } from './modules/integrations/integrations.routes.js';
import { leaderboardRouter } from './modules/leaderboard/leaderboard.routes.js';
import { meetingsRouter } from './modules/meetings/meetings.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

export const app = express();
// Capture the raw request body so HMAC verification can recompute the
// signature over the exact bytes the sender signed. Without this, JSON
// re-stringification would drift and the signatures would never match.
app.use(
  express.json({
    verify: (req: Request, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/dashboard', dashboardRouter);
app.use('/users', usersRouter);
app.use('/accounts', accountsRouter);
app.use('/audit-logs', auditRouter);
app.use('/commercial-changes', commercialChangesRouter);
app.use('/leaderboard', leaderboardRouter);
app.use('/meetings', meetingsRouter);
app.use('/notifications', notificationsRouter);
// Public endpoint — auth is enforced inside the router via HMAC, not JWT.
app.use('/integrations', integrationsRouter);
app.use(errorHandler);

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 5500);
  app.listen(port, () => console.log(`SAM backend listening on :${port}`));
}

export default app;
