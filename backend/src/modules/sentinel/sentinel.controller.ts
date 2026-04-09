/**
 * sentinel.controller.ts  (Sprint 16)
 *
 * Backoffice governance endpoints for ADM:
 *   GET  /admin/tenants           — list all tenants with credit summary
 *   POST /admin/tenants           — create a new tenant
 *   POST /admin/tenants/:id/ban   — suspend a tenant
 *   POST /admin/tenants/:id/unban — re-activate a tenant
 *   DELETE /admin/users/:id       — LGPD soft-delete (mask PII, keep ledger)
 *   POST /admin/ledger/mint       — inject credits into a wallet
 *   POST /admin/emergency-halt    — M.A.D. protocol (Ed25519-signed order)
 *   GET  /admin/audit             — read audit trail
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../../config/database';
import { writeAudit, readAuditLogs } from '../../services/audit.service';
import { getIo } from '../../services/agent-ws.service';
import { env } from '../../config/env';

// ── Tenant management ─────────────────────────────────────────────────────────

export async function listTenants(_req: Request, res: Response, next: NextFunction) {
  try {
    const tenants = await (prisma.tenant as any).findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { users: true, nodes: true, depinApps: true } },
        wallets: { select: { balanceUsd: true } },
      },
    });
    res.json({ status: 'success', data: { tenants } });
  } catch (err) { next(err); }
}

export async function createTenant(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, document } = req.body as { name: string; document?: string };
    if (!name) {
      res.status(400).json({ status: 'error', message: '"name" is required.' });
      return;
    }
    const tenant = await (prisma.tenant as any).create({ data: { name, document } });
    await writeAudit({
      actorId:   req.user!.id,
      action:    'CREATE_INVITE',
      targetId:  tenant.id,
      ipAddress: req.ip,
      payload:   { name },
    });
    res.status(201).json({ status: 'success', data: { tenant } });
  } catch (err) { next(err); }
}

export async function banTenant(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const tenant = await (prisma.tenant as any).update({
      where: { id: req.params.id },
      data:  { status: 'BANNED' },
    });
    await writeAudit({ actorId: req.user!.id, action: 'BAN', targetId: req.params.id, ipAddress: req.ip });
    res.json({ status: 'success', data: { tenant } });
  } catch (err) { next(err); }
}

export async function unbanTenant(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const tenant = await (prisma.tenant as any).update({
      where: { id: req.params.id },
      data:  { status: 'ACTIVE' },
    });
    await writeAudit({ actorId: req.user!.id, action: 'UNBAN', targetId: req.params.id, ipAddress: req.ip });
    res.json({ status: 'success', data: { tenant } });
  } catch (err) { next(err); }
}

// ── LGPD soft-delete ──────────────────────────────────────────────────────────

/**
 * DELETE /admin/users/:id
 *
 * Masks PII fields (name, email) so the user is unidentifiable.
 * Preserves all financial records (LedgerTransaction) for auditing.
 * isActive = false prevents future logins.
 */
export async function softDeleteUser(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      res.status(404).json({ status: 'error', message: 'User not found.' });
      return;
    }

    // Hash email so it's unique but unrecoverable
    const maskedEmail = crypto.createHash('sha256').update(user.email).digest('hex') + '@deleted.nexus';

    await prisma.user.update({
      where: { id },
      data: {
        name:         'DeletedUser',
        email:        maskedEmail,
        passwordHash: 'DELETED',
        resetToken:   null,
        resetExpires: null,
        isActive:     false,
      } as any,
    });

    await writeAudit({
      actorId:   req.user!.id,
      action:    'DELETE_USER',
      targetId:  id,
      ipAddress: req.ip,
      payload:   { originalEmail: user.email },
    });

    res.json({ status: 'success', message: 'User data erased (LGPD). Financial records preserved.' });
  } catch (err) { next(err); }
}

// ── Credit minting ────────────────────────────────────────────────────────────

/**
 * POST /admin/ledger/mint
 * Body: { userId, amountUsd, reason }
 */
export async function mintCredits(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, amountUsd, reason } = req.body as {
      userId:    string;
      amountUsd: number;
      reason:    string;
    };

    if (!userId || !amountUsd || !reason) {
      res.status(400).json({ status: 'error', message: '"userId", "amountUsd" and "reason" are required.' });
      return;
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      res.status(404).json({ status: 'error', message: 'Wallet not found for this user.' });
      return;
    }

    await prisma.$transaction([
      prisma.wallet.update({
        where: { id: wallet.id },
        data:  { balanceUsd: { increment: amountUsd } },
      }),
      prisma.ledgerTransaction.create({
        data: {
          walletId:    wallet.id,
          type:        'DEPOSIT',
          amountUsd,
          description: `[ADMIN MINT] ${reason}`,
          metadata:    { mintedBy: req.user!.id, reason } as any,
        },
      }),
    ]);

    await writeAudit({
      actorId:   req.user!.id,
      action:    'MINT',
      targetId:  userId,
      ipAddress: req.ip,
      payload:   { amountUsd, reason, walletId: wallet.id },
    });

    res.json({ status: 'success', data: { userId, amountUsd, newBalance: wallet.balanceUsd + amountUsd } });
  } catch (err) { next(err); }
}

// ── M.A.D. Emergency Halt ─────────────────────────────────────────────────────

/**
 * POST /admin/emergency-halt
 * Body: { signature }  — Ed25519 signature of "NEXUS_EMERGENCY_HALT" with the
 *                        admin's private key. The master verifies against the
 *                        stored public key (env.HALT_PUBLIC_KEY).
 *
 * On success: broadcasts EMERGENCY_HALT via Socket.io to all agents.
 * Each agent will kill workloads, tear down WireGuard, and exit.
 */
export async function emergencyHalt(req: Request, res: Response, next: NextFunction) {
  try {
    const { signature } = req.body as { signature: string };

    if (!signature) {
      res.status(400).json({ status: 'error', message: '"signature" is required.' });
      return;
    }

    // Verify Ed25519 signature — master stores only the public key
    const pubKeyPem = (env as any).HALT_PUBLIC_KEY as string | undefined;
    if (!pubKeyPem) {
      res.status(503).json({ status: 'error', message: 'Emergency halt not configured (HALT_PUBLIC_KEY missing).' });
      return;
    }

    const message = Buffer.from('NEXUS_EMERGENCY_HALT');
    let valid = false;
    try {
      valid = crypto.verify(
        null,                               // null = algo from key (Ed25519)
        message,
        { key: pubKeyPem, format: 'pem' },
        Buffer.from(signature, 'base64'),
      );
    } catch {
      valid = false;
    }

    if (!valid) {
      res.status(401).json({ status: 'error', message: 'Invalid halt signature.' });
      return;
    }

    // Broadcast to all connected agents
    const io = getIo();
    io?.emit('command', { action: 'emergency_halt' });

    await writeAudit({
      actorId:   req.user!.id,
      action:    'HALT',
      targetId:  'ALL_AGENTS',
      ipAddress: req.ip,
      payload:   { broadcastedAt: new Date().toISOString() },
    });

    console.warn(`[SENTINEL] EMERGENCY HALT issued by ${req.user!.email} from ${req.ip}`);

    res.json({ status: 'success', message: 'Emergency halt broadcast sent to all agents.' });
  } catch (err) { next(err); }
}

// ── Audit trail ───────────────────────────────────────────────────────────────

export async function getAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const limit  = parseInt(req.query.limit  as string ?? '50', 10);
    const offset = parseInt(req.query.offset as string ?? '0',  10);
    const action = req.query.action as any;

    const logs = await readAuditLogs({ action, limit, offset });
    res.json({ status: 'success', data: { logs } });
  } catch (err) { next(err); }
}
