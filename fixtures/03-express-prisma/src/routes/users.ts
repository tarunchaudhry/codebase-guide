import { Router } from 'express';
import { createUser, getUser, listUsers } from '../controllers/users';
import { requireAuth, validate } from '../middleware/auth';

const router = Router();
router.get('/', listUsers);
router.get('/:id', getUser);
router.post('/', requireAuth, validate('user'), createUser);

export default router;
