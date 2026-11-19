import type { FastifyInstance } from 'fastify';
import { deleteUser } from '../handlers/users';

export default async function adminRoutes(app: FastifyInstance) {
  app.delete('/:id', deleteUser);
}
