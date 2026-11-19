import type { FastifyReply, FastifyRequest } from 'fastify';

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.headers.authorization) return reply.code(401).send();
}

export async function checkOwner(_req: FastifyRequest) {}

export async function listUsers() {
  return [];
}

export async function getUser(req: FastifyRequest<{ Params: { id: string } }>) {
  return { id: req.params.id };
}

export async function createUser() {
  return { id: 'new' };
}

export async function deleteUser(_req: FastifyRequest, reply: FastifyReply) {
  return reply.code(204).send();
}
