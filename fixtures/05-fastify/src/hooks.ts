import type { FastifyRequest } from 'fastify';

export async function logRequest(req: FastifyRequest) {
  req.log.info(req.url);
}
