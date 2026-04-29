import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/error-handler.js';
import { accountsRouter } from './modules/accounts/accounts.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/accounts', accountsRouter);
app.use(errorHandler);

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`SAM backend listening on :${port}`));
}

export default app;
