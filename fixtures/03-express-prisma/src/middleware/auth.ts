import type { NextFunction, Request, Response } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) return res.status(401).end();
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.headers['x-role'] !== 'admin') return res.status(403).end();
  next();
}

export function validate(schema: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.body) throw new Error(`invalid ${schema}`);
    next();
  };
}
