import express from 'express';
import { errorHandler } from './middlewares/error-handler.js';
import { accountsRouter } from './modules/accounts/accounts.routes.js';

export const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/accounts', accountsRouter);
app.use(errorHandler);

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.log(`SAM backend listening on :${port}`));
}

export default app;
