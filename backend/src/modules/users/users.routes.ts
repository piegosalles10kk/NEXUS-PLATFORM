import { Router } from 'express';
import * as usersController from './users.controller';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';

const router = Router();

// All user management requires authentication
router.use(authenticate);

// Only ADM can manage users
router.get('/', authorize('ADM'), usersController.listUsers);
router.get('/:id', authorize('ADM'), usersController.getUserById);
router.post('/', authorize('ADM'), usersController.createUser);
router.put('/:id', authorize('ADM'), usersController.updateUser);
router.delete('/:id', authorize('ADM'), usersController.deleteUser);

export default router;
