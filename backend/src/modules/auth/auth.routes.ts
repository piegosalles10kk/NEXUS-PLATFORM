import { Router } from 'express';
import * as authController from './auth.controller';
import { authenticate } from '../../middlewares/auth';
import { authorize } from '../../middlewares/rbac';

const router = Router();

router.post('/login', authController.login);
router.post('/register', authController.register);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.get( '/profile', authenticate, authController.getProfile);

// Invite code management (ADM only)
router.post('/invite',  authenticate, authorize('ADM'), authController.generateInvites);
router.get( '/invites', authenticate, authorize('ADM'), authController.listInvites);

export default router;
