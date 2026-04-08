import { Router } from 'express';
import * as authController from './auth.controller';
import { authenticate } from '../../middlewares/auth';

const router = Router();

router.post('/login', authController.login);
router.post('/register', authController.register);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.get('/profile', authenticate, authController.getProfile);

export default router;
