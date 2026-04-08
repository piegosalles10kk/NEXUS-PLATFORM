import { Request, Response, NextFunction } from 'express';
import * as authService from './auth.service';
import { loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema } from './auth.schema';

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const data = loginSchema.parse(req.body);
    const result = await authService.login(data);
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
}

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const data = registerSchema.parse(req.body);
    const user = await authService.register(data);
    res.status(201).json({ status: 'success', data: { user } });
  } catch (error) {
    next(error);
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const data = forgotPasswordSchema.parse(req.body);
    await authService.forgotPassword(data);
    res.json({ status: 'success', message: 'If the email exists, a reset link has been sent' });
  } catch (error) {
    next(error);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const data = resetPasswordSchema.parse(req.body);
    await authService.resetPassword(data);
    res.json({ status: 'success', message: 'Password reset successfully' });
  } catch (error) {
    next(error);
  }
}

export async function getProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await authService.getProfile(req.user!.id);
    res.json({ status: 'success', data: { user } });
  } catch (error) {
    next(error);
  }
}
