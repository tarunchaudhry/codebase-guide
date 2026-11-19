import type { Request, Response } from 'express';
import { prisma } from '../db';

export async function listUsers(_req: Request, res: Response) {
  res.json(await prisma.user.findMany());
}

export async function getUser(req: Request, res: Response) {
  res.json(await prisma.user.findUnique({ where: { id: Number(req.params.id) } }));
}

export async function createUser(req: Request, res: Response) {
  res.status(201).json(await prisma.user.create({ data: req.body }));
}
