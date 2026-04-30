import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/error-handler.js';
import { accountsRouter } from './modules/accounts/accounts.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { commercialChangesRouter } from './modules/commercial-changes/commercial-changes.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { meetingsRouter } from './modules/meetings/meetings.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/dashboard', dashboardRouter);
app.use('/users', usersRouter);
app.use('/accounts', accountsRouter);
app.use('/commercial-changes', commercialChangesRouter);
app.use('/meetings', meetingsRouter);
app.use(errorHandler);

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`SAM backend listening on :${port}`));
}

export default app;
