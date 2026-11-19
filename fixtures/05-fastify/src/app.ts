import Fastify from 'fastify';
import { logRequest } from './hooks';
import { authPlugin } from './plugins/auth';
import usersRoutes from './routes/users';

const app = Fastify({ logger: true });
app.addHook('onRequest', logRequest);
app.register(authPlugin);
app.register(usersRoutes, { prefix: '/users' });
app.register(async (instance) => {
  instance.get('/health', async () => ({ ok: true }));
}, { prefix: '/sys' });
app.get('/', async () => 'hello');

export default app;
