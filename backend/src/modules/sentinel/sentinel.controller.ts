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
import { getIo, getAgentSocket, getConnectedNodeIds } from '../../services/agent-ws.service';
import { getRedisClient } from '../../config/redis';
import { env } from '../../config/env';
import {
  triggerBenchmark,
  triggerGlobalStressTest,
  listNodeBenchmarks,
} from '../../services/benchmark.service';
import { recentBackendLogs } from '../../services/log-streamer.service';

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

// ── Sprint 17.4 — Benchmark Engine ───────────────────────────────────────────

/** GET /admin/nodes/benchmarks — list all nodes with benchmark data */
export async function listBenchmarks(_req: Request, res: Response, next: NextFunction) {
  try {
    const nodes = await listNodeBenchmarks();
    res.json({ status: 'success', data: { nodes } });
  } catch (err) { next(err); }
}

/** POST /admin/nodes/:id/benchmark — trigger benchmark on a single node */
export async function runBenchmark(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { id: nodeId } = req.params;
    const ok = await triggerBenchmark(nodeId);
    if (!ok) {
      res.status(503).json({ status: 'error', message: 'Node not connected.' });
      return;
    }
    await writeAudit({ actorId: req.user!.id, action: 'BENCHMARK', targetId: nodeId, ipAddress: req.ip });
    res.json({ status: 'success', message: 'Benchmark dispatched.' });
  } catch (err) { next(err); }
}

/** POST /admin/nodes/:id/infra-type — reclassify node infra type */
export async function setInfraType(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { infraType } = req.body as { infraType: 'SWARM' | 'CLOUD_MANAGED' | 'ON_PREMISE' };
    if (!['SWARM', 'CLOUD_MANAGED', 'ON_PREMISE'].includes(infraType)) {
      res.status(400).json({ status: 'error', message: 'Invalid infraType.' });
      return;
    }
    const node = await (prisma.node as any).update({
      where: { id: req.params.id },
      data:  { infraType },
      select: { id: true, name: true, infraType: true },
    });
    res.json({ status: 'success', data: { node } });
  } catch (err) { next(err); }
}

// ── Sprint 17.5 — Global Swarm Stress Test ────────────────────────────────────

/**
 * POST /admin/stress-test
 * Body: { durationSecs?, jitterMaxMs? }
 *
 * Dispatches `stress_test` to ALL connected nodes simultaneously.
 * Uses NTP-epoch coordination: all agents wait until `ntpEpochMs` then fire.
 * Jitter is applied per-agent to avoid synchronized DDoS on the master.
 */
export async function globalStressTest(req: Request, res: Response, next: NextFunction) {
  try {
    const durationSecs = parseInt(req.body.durationSecs ?? '30', 10);
    const jitterMaxMs  = parseInt(req.body.jitterMaxMs  ?? '5000', 10);

    // Schedule test to start 10 seconds from now (gives agents time to prepare)
    const ntpEpochMs = Date.now() + 10_000;

    const nodeIds = getConnectedNodeIds();
    const dispatched = await triggerGlobalStressTest(
      { durationSecs, jitterMaxMs, ntpEpochMs },
      nodeIds,
    );

    await writeAudit({
      actorId:   req.user!.id,
      action:    'STRESS_TEST',
      targetId:  'ALL_AGENTS',
      ipAddress: req.ip,
      payload:   { nodeCount: dispatched, durationSecs, ntpEpochMs },
    });

    // Broadcast to frontend so Sentinel dashboard can show countdown
    getIo()?.emit('sentinel:stress_test_started', {
      dispatched,
      ntpEpochMs,
      durationSecs,
      startedBy: req.user!.email,
    });

    res.json({ status: 'success', data: { dispatched, ntpEpochMs, durationSecs } });
  } catch (err) { next(err); }
}

// ── Sprint 17.3 — Backend error log stream ────────────────────────────────────

/** GET /admin/logs — returns last N backend error logs */
export async function getRecentLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = parseInt(req.query.limit as string ?? '100', 10);
    const logs  = recentBackendLogs(limit);
    res.json({ status: 'success', data: { logs } });
  } catch (err) { next(err); }
}

// ── Peer latency matrix ───────────────────────────────────────────────────────

/**
 * GET /admin/nodes/peer-matrix
 *
 * Returns the full NxN latency matrix built from data stored in Redis by each
 * node after it runs its benchmark (ProbePeerLatencies).
 *
 * Response shape:
 *   { nodes: [{ id, name }], matrix: { [fromNodeId]: { [peerIp]: latencyMs } } }
 */
export async function getPeerMatrix(req: Request, res: Response, next: NextFunction) {
  try {
    const redis = await getRedisClient();

    // Fetch all connected nodes
    const nodes: { id: string; name: string; wgIp: string | null }[] = await (prisma.node as any).findMany({
      where:  { status: { not: 'DELETED' } },
      select: { id: true, name: true, wireguardPubKey: true },
      orderBy: { name: 'asc' },
    });

    // Build IP→nodeId reverse map from ClusterMembership meshIp
    const memberships: { nodeId: string; meshIp: string }[] = await (prisma.clusterMembership as any).findMany({
      select: { nodeId: true, meshIp: true },
    });
    const ipToNodeId = new Map(memberships.map(m => [m.meshIp, m.nodeId]));

    // Read peer_latencies for each node from Redis
    const matrix: Record<string, Record<string, number>> = {};
    await Promise.all(nodes.map(async (n) => {
      const raw = await redis.get(`node:${n.id}:peer_latencies`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { ts: number; peers: Record<string, number> };
      // Re-key by nodeId when possible, fall back to IP
      const keyed: Record<string, number> = {};
      for (const [ip, ms] of Object.entries(parsed.peers)) {
        const targetId = ipToNodeId.get(ip) ?? ip;
        keyed[targetId] = ms;
      }
      matrix[n.id] = keyed;
    }));

    res.json({
      status: 'success',
      data: {
        nodes: nodes.map(n => ({ id: n.id, name: n.name })),
        matrix,
      },
    });
  } catch (err) { next(err); }
}
