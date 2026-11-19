import type { FastifyInstance } from 'fastify';
import { checkOwner, createUser, getUser, listUsers, requireUser } from '../handlers/users';
import adminRoutes from './admin';

export default async function usersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);
  app.get('/', listUsers);
  app.get('/:id', { preHandler: [checkOwner] }, getUser);
  app.route({ method: ['POST'], url: '/', handler: createUser });
  app.register(adminRoutes, { prefix: '/admin' });
}
