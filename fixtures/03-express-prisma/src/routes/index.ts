import { Router } from 'express';
import usersRouter from './users';
import postsRouter from './posts';

export const apiRouter = Router();
apiRouter.use('/users', usersRouter);
apiRouter.use('/posts', postsRouter);
