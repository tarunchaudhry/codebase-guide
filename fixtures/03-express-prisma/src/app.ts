import express from 'express';
import { apiRouter } from './routes';
import { requestLogger } from './middleware/logger';
import { requireAdmin } from './middleware/auth';

const app = express();
app.use(express.json());
app.use(requestLogger);
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/admin', requireAdmin);
app.use('/api', apiRouter);

export default app;
