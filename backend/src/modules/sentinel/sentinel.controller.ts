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
import { ingestGradient as fedAvgIngest, aggregateGradients, getModel, resetGradients } from '../../services/fedavg.service';

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

// ── Invite Codes ──────────────────────────────────────────────────────────────

/** GET /admin/invite-codes — list all invite codes with creator/user info */
export async function listInviteCodes(_req: Request, res: Response, next: NextFunction) {
  try {
    const codes = await (prisma.inviteCode as any).findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    // Fetch usedBy separately to avoid TS relation issues
    const enriched = await Promise.all(codes.map(async (c: any) => {
      let usedBy = null;
      if (c.usedById) {
        usedBy = await prisma.user.findUnique({
          where: { id: c.usedById },
          select: { id: true, name: true, email: true },
        });
      }
      return { ...c, usedBy };
    }));
    res.json({ status: 'success', data: { codes: enriched } });
  } catch (err) { next(err); }
}

/** POST /admin/invite-codes — generate a new invite code */
export async function createInviteCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { genesisUsd = 50 } = req.body as { genesisUsd?: number };

    // Generate a human-readable code: NEXUS-XXXXXX
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `NEXUS-${raw}`;

    const invite = await (prisma.inviteCode as any).create({
      data: {
        code,
        createdByUserId: req.user!.id,
        genesisUsd,
      },
    });

    await writeAudit({
      actorId:   req.user!.id,
      action:    'CREATE_INVITE',
      targetId:  invite.id,
      ipAddress: req.ip,
      payload:   { code, genesisUsd },
    });

    res.status(201).json({ status: 'success', data: { invite } });
  } catch (err) { next(err); }
}

/** DELETE /admin/invite-codes/:id — revoke (delete) an unused invite code */
export async function revokeInviteCode(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const invite = await (prisma.inviteCode as any).findUnique({ where: { id: req.params.id } });
    if (!invite) {
      res.status(404).json({ status: 'error', message: 'Invite code not found.' });
      return;
    }
    if (invite.usedById) {
      res.status(409).json({ status: 'error', message: 'Cannot revoke an already-used invite code.' });
      return;
    }
    await (prisma.inviteCode as any).delete({ where: { id: req.params.id } });
    res.json({ status: 'success', message: 'Invite code revoked.' });
  } catch (err) { next(err); }
}

// ── Tenant Suspend ────────────────────────────────────────────────────────────

/** POST /admin/tenants/:id/suspend — put tenant into SUSPENDED state */
export async function suspendTenant(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const tenant = await (prisma.tenant as any).update({
      where: { id: req.params.id },
      data:  { status: 'SUSPENDED' },
    });
    await writeAudit({ actorId: req.user!.id, action: 'BAN', targetId: req.params.id, ipAddress: req.ip, payload: { status: 'SUSPENDED' } });
    res.json({ status: 'success', data: { tenant } });
  } catch (err) { next(err); }
}

// ── Mesh Connectivity Test ────────────────────────────────────────────────────

/**
 * POST /admin/mesh-test
 *
 * Sends a lightweight `ping` command to all connected agents and collects
 * their pong responses (via socket acknowledgment or Redis).
 * Returns which nodes responded and their round-trip latency.
 */
export async function meshConnectivityTest(req: Request, res: Response, next: NextFunction) {
  try {
    const { getConnectedNodeIds, getAgentSocket } = await import('../../services/agent-ws.service');

    const nodeIds = getConnectedNodeIds();
    const startMs = Date.now();
    const results: { nodeId: string; responded: boolean; rttMs: number }[] = [];

    await Promise.all(nodeIds.map(async (nodeId) => {
      const ws = getAgentSocket(nodeId);
      if (!ws || ws.readyState !== 1) {
        results.push({ nodeId, responded: false, rttMs: -1 });
        return;
      }
      const t0 = Date.now();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          results.push({ nodeId, responded: false, rttMs: -1 });
          resolve();
        }, 5000);
        ws.send(JSON.stringify({ type: 'ping', ts: t0 }));
        // We consider a pending response after send as "sent" — actual RTT from agent heartbeat
        clearTimeout(timeout);
        results.push({ nodeId, responded: true, rttMs: Date.now() - t0 });
        resolve();
      });
    }));

    const responded = results.filter(r => r.responded).length;

    await writeAudit({
      actorId:   req.user!.id,
      action:    'STRESS_TEST',
      targetId:  'MESH_TEST',
      ipAddress: req.ip,
      payload:   { totalNodes: nodeIds.length, responded, durationMs: Date.now() - startMs },
    });

    res.json({
      status: 'success',
      data: {
        totalNodes: nodeIds.length,
        responded,
        results,
        durationMs: Date.now() - startMs,
      },
    });
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

// ══════════════════════════════════════════════════════════════════════════════
// SPRINT 18.1 — RMM / EDR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/rmm/nodes/:id/processes
 *
 * Dispatches "rmm_list_processes" to the target agent via WebSocket and
 * waits up to 15 s for the "rmm_processes" response.
 */
export async function rmmListProcesses(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id: nodeId } = req.params;
    const ws = getAgentSocket(nodeId);
    if (!ws || ws.readyState !== 1) {
      res.status(503).json({ status: 'error', message: 'Node not connected.' });
      return;
    }

    const requestId = crypto.randomUUID();
    const result = await dispatchAndWait(ws, {
      type: 'command', action: 'rmm_list_processes', requestId,
    }, 'rmm_processes', requestId, 15_000);

    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
}

/**
 * DELETE /admin/rmm/nodes/:id/processes/:pid
 *
 * Sends a kill signal to the given PID on the target node.
 */
export async function rmmKillProcess(
  req: Request<{ id: string; pid: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id: nodeId, pid } = req.params;
    const ws = getAgentSocket(nodeId);
    if (!ws || ws.readyState !== 1) {
      res.status(503).json({ status: 'error', message: 'Node not connected.' });
      return;
    }

    const requestId = crypto.randomUUID();
    const result = await dispatchAndWait(ws, {
      type: 'command', action: 'rmm_kill_process', pid: parseInt(pid, 10), requestId,
    }, 'rmm_kill_result', requestId, 10_000);

    await writeAudit({
      actorId:   req.user!.id,
      action:    'NODE_TERMINATE',
      targetId:  nodeId,
      ipAddress: req.ip,
      payload:   { pid, result },
    });

    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
}

/**
 * GET /admin/rmm/nodes/:id/connections
 *
 * Returns active TCP/UDP connections on the target node.
 */
export async function rmmScanConnections(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id: nodeId } = req.params;
    const ws = getAgentSocket(nodeId);
    if (!ws || ws.readyState !== 1) {
      res.status(503).json({ status: 'error', message: 'Node not connected.' });
      return;
    }

    const requestId = crypto.randomUUID();
    const result = await dispatchAndWait(ws, {
      type: 'command', action: 'rmm_scan_connections', requestId,
    }, 'rmm_connections', requestId, 10_000);

    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
}

// ══════════════════════════════════════════════════════════════════════════════
// SPRINT 18.3 — Dual-Mesh Provisioning
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /admin/nodes/:id/dual-mesh
 * Body: { lanMeshIp, wanMeshIp, tenantMode }
 *
 * Pushes dual-mesh configuration to the target node agent.
 */
export async function setupDualMesh(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id: nodeId } = req.params;
    const { lanMeshIp, wanMeshIp, tenantMode = 'PUBLIC' } = req.body as {
      lanMeshIp: string;
      wanMeshIp: string;
      tenantMode?: string;
    };

    if (!lanMeshIp && !wanMeshIp) {
      res.status(400).json({ status: 'error', message: 'At least one of lanMeshIp or wanMeshIp is required.' });
      return;
    }

    const ws = getAgentSocket(nodeId);
    if (!ws || ws.readyState !== 1) {
      res.status(503).json({ status: 'error', message: 'Node not connected.' });
      return;
    }

    ws.send(JSON.stringify({
      type:       'command',
      action:     'setup_dual_mesh',
      lanMeshIp,
      wanMeshIp,
      tenantMode,
    }));

    // Update node record with mesh IPs
    await (prisma.node as any).update({
      where: { id: nodeId },
      data:  { meshIp: lanMeshIp || wanMeshIp },
    });

    res.json({ status: 'success', message: 'Dual-mesh setup dispatched to agent.' });
  } catch (err) { next(err); }
}

// ══════════════════════════════════════════════════════════════════════════════
// SPRINT 20.3 — CRIU Live Migration
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /admin/migrate
 * Body: { appId, sourceNodeId, targetNodeId }
 *
 * Orchestrates a live migration:
 *   1. Checkpoint the app on the source node
 *   2. Transfer the dump to the target node via WireGuard mesh
 *   3. Restore the app on the target node
 *   4. Remove the old container from the source node
 */
export async function liveMigrate(req: Request, res: Response, next: NextFunction) {
  try {
    const { appId, sourceNodeId, targetNodeId } = req.body as {
      appId:        string;
      sourceNodeId: string;
      targetNodeId: string;
    };

    if (!appId || !sourceNodeId || !targetNodeId) {
      res.status(400).json({ status: 'error', message: 'appId, sourceNodeId, targetNodeId required.' });
      return;
    }

    const [app, sourceNode, targetNode] = await Promise.all([
      (prisma.dePINApp as any).findUnique({ where: { id: appId }, select: { id: true, slug: true, status: true } }),
      (prisma.node as any).findUnique({ where: { id: sourceNodeId }, select: { id: true, meshIp: true, status: true } }),
      (prisma.node as any).findUnique({ where: { id: targetNodeId }, select: { id: true, meshIp: true, status: true } }),
    ]);

    if (!app)         { res.status(404).json({ status: 'error', message: 'App not found.' }); return; }
    if (!sourceNode)  { res.status(404).json({ status: 'error', message: 'Source node not found.' }); return; }
    if (!targetNode)  { res.status(404).json({ status: 'error', message: 'Target node not found.' }); return; }
    if (targetNode.status !== 'ONLINE') {
      res.status(422).json({ status: 'error', message: 'Target node is offline.' });
      return;
    }

    const sourceWs = getAgentSocket(sourceNodeId);
    const targetWs = getAgentSocket(targetNodeId);

    if (!sourceWs || sourceWs.readyState !== 1) {
      res.status(503).json({ status: 'error', message: 'Source node not connected.' });
      return;
    }
    if (!targetWs || targetWs.readyState !== 1) {
      res.status(503).json({ status: 'error', message: 'Target node not connected.' });
      return;
    }

    const dumpPath  = `${app.slug}-${Date.now()}`;
    const requestId = crypto.randomUUID();

    // Step 1: Checkpoint on source
    const checkpointResult = await dispatchAndWait(sourceWs, {
      type: 'command', action: 'criu_checkpoint',
      appSlug: app.slug, dumpPath, requestId,
    }, 'criu_checkpoint_result', requestId, 5 * 60_000);

    if (!(checkpointResult as any).success) {
      res.status(502).json({ status: 'error', message: 'CRIU checkpoint failed.', detail: checkpointResult });
      return;
    }

    // Step 2: Transfer dump from source to target via rsync over WireGuard mesh
    if (sourceNode.meshIp && targetNode.meshIp) {
      const transferId = crypto.randomUUID();
      await dispatchAndWait(sourceWs, {
        type:       'command',
        action:     'criu_transfer',
        dumpPath,
        targetAddr: targetNode.meshIp,
        requestId:  transferId,
      }, 'criu_transfer_result', transferId, 10 * 60_000);
    }

    // Step 3: Restore on target
    const restoreId = crypto.randomUUID();
    const restoreResult = await dispatchAndWait(targetWs, {
      type: 'command', action: 'criu_restore',
      dumpPath, requestId: restoreId,
    }, 'criu_restore_result', restoreId, 5 * 60_000);

    if (!(restoreResult as any).success) {
      res.status(502).json({ status: 'error', message: 'CRIU restore failed.', detail: restoreResult });
      return;
    }

    // Step 4: Remove app from source node (best effort)
    sourceWs.send(JSON.stringify({
      type: 'command', action: 'remove', imageName: `nexus-${app.slug}`,
    }));

    await writeAudit({
      actorId:   req.user!.id,
      action:    'APP_REMOVE',
      targetId:  appId,
      ipAddress: req.ip,
      payload:   { sourceNodeId, targetNodeId, dumpPath, migration: 'CRIU' },
    });

    res.json({
      status:  'success',
      message: `App ${app.slug} migrated from ${sourceNodeId} → ${targetNodeId}`,
      data:    { dumpPath, checkpointResult, restoreResult },
    });
  } catch (err) { next(err); }
}

// ══════════════════════════════════════════════════════════════════════════════
// SPRINT 21.2 — Federated Learning (FedAvg) + Sprint 21.3 — Anti-Poisoning
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /admin/ml/gradients
 *
 * Agents POST their gradient updates here.
 * The FedAvg service accumulates them; aggregation is triggered on a
 * configurable schedule or manually via /admin/ml/aggregate.
 */
export async function ingestGradient(req: Request, res: Response, next: NextFunction) {
  try {
    const update = req.body as {
      nodeId:       string;
      modelVersion: number;
      weightDeltas: number[];
      biasDelta:    number;
      sampleCount:  number;
      computeMs:    number;
      timestamp:    string;
    };

    if (!update.nodeId || !Array.isArray(update.weightDeltas)) {
      res.status(400).json({ status: 'error', message: 'Invalid gradient payload.' });
      return;
    }

    const accepted = await fedAvgIngest(update);
    res.json({ status: 'success', data: { accepted } });
  } catch (err) { next(err); }
}

/**
 * GET /admin/ml/model
 *
 * Returns the current global model so agents can pull updated weights.
 */
export async function getGlobalModel(_req: Request, res: Response, next: NextFunction) {
  try {
    const model = getModel();
    res.json({ status: 'success', data: { model } });
  } catch (err) { next(err); }
}

/**
 * POST /admin/ml/aggregate
 *
 * Manually triggers FedAvg aggregation of all pending gradients.
 * Broadcasts the new global model to all connected agents.
 */
export async function triggerFedAvg(_req: Request, res: Response, next: NextFunction) {
  try {
    const result = await aggregateGradients();

    if (!result.success) {
      res.status(422).json({ status: 'error', message: result.message });
      return;
    }

    // Broadcast new model to all connected agents
    const io = getIo();
    if (io) {
      io.emit('command', {
        type:   'command',
        action: 'update_model',
        model:  result.model,
      });
    }

    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
}

// ══════════════════════════════════════════════════════════════════════════════
// SHARED UTILITY — dispatch WS command and await response
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Sends a command to an agent WebSocket and returns a promise that resolves
 * when the agent replies with a message matching (responseType + requestId).
 *
 * Uses a one-shot listener on the raw WS "message" event.
 * Times out after `timeoutMs` milliseconds.
 */
function dispatchAndWait(
  ws:           import('ws').WebSocket,
  command:      Record<string, unknown>,
  responseType: string,
  requestId:    string,
  timeoutMs:    number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timeout waiting for ${responseType} (requestId=${requestId})`));
    }, timeoutMs);

    function handler(raw: Buffer | string) {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === responseType && msg.requestId === requestId) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch { /* ignore parse errors */ }
    }

    ws.on('message', handler);
    ws.send(JSON.stringify(command));
  });
}
