import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../../config/database';
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

// ── POST /api/v1/auth/invite (ADM only) ──────────────────────────────────────
/**
 * Generates one or more invite codes.
 * Body: { count?: number (1-50), genesisUsd?: number }
 */
export async function generateInvites(req: Request, res: Response, next: NextFunction) {
  try {
    const count      = Math.min(Math.max(parseInt(req.body.count ?? '1', 10), 1), 50);
    const genesisUsd = parseFloat(req.body.genesisUsd ?? '50');

    const codes = Array.from({ length: count }, () =>
      'NEXUS-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    );

    await (prisma.inviteCode as any).createMany({
      data: codes.map(code => ({
        code,
        createdByUserId: req.user!.id,
        genesisUsd,
      })),
    });

    res.status(201).json({ status: 'success', data: { codes, genesisUsd } });
  } catch (error) {
    next(error);
  }
}

// ── GET /api/v1/auth/invites (ADM only) ──────────────────────────────────────
export async function listInvites(req: Request, res: Response, next: NextFunction) {
  try {
    const invites = await (prisma.inviteCode as any).findMany({
      where: { createdByUserId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ status: 'success', data: { invites } });
  } catch (error) {
    next(error);
  }
}
