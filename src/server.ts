import express, { type Request } from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/error-handler.js';
import { accountsRouter } from './modules/accounts/accounts.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { commercialChangesRouter } from './modules/commercial-changes/commercial-changes.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { feedbackRouter } from './modules/feedback/feedback.routes.js';
import {
  integrationsRouter,
  crmWebhookAliasRouter,
} from './modules/integrations/integrations.routes.js';
import { leadsRouter } from './modules/leads/leads.routes.js';
import { meetingsRouter } from './modules/meetings/meetings.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { probableChurnRouter } from './modules/probable-churn/probable-churn.routes.js';
import { sidebarRouter } from './modules/sidebar/sidebar.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

export const app = express();
// Behind nginx / Caddy / Cloudflare, `X-Forwarded-For` carries the real
// client IP. `trust proxy: 'loopback, linklocal, uniquelocal'` honours
// the header only when the socket peer is a local/private proxy, so
// audit logs capture the real client IP without trusting arbitrary
// upstream X-Forwarded-For headers.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
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
app.use('/feedback', feedbackRouter);
app.use('/users', usersRouter);
app.use('/accounts', accountsRouter);
app.use('/audit-logs', auditRouter);
app.use('/commercial-changes', commercialChangesRouter);
app.use('/leads', leadsRouter);
app.use('/meetings', meetingsRouter);
app.use('/notifications', notificationsRouter);
app.use('/probable-churn', probableChurnRouter);
app.use('/sidebar', sidebarRouter);
// Public endpoint — auth is enforced inside the router via HMAC, not JWT.
app.use('/integrations', integrationsRouter);
// Alias matching the contract's suggested path so the CRM team can configure
// SAM_WEBHOOK_URL with either /integrations/crm/quick-disconnect-decision
// (SAM-native) or /webhooks/crm/quick-disconnect.decided (contract suggestion).
// Both routes hit the same handler.
app.use('/webhooks', crmWebhookAliasRouter);
app.use(errorHandler);

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 5500);
  app.listen(port, () => console.log(`SAM backend listening on :${port}`));
}

export default app;
