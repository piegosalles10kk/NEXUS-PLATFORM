import { Request, Response, NextFunction } from 'express';
import * as collective from '../../services/collective-scheduler.service';
import { sendWorkloadToNodes } from '../../services/workload-dispatch.service';
import prisma from '../../config/database';
import { getAgentSocket } from '../../services/agent-ws.service';

// ── POST /api/v1/clusters/create ─────────────────────────────────────────────
/**
 * Plans and reserves a ResourceCluster for a new DePIN workload.
 *
 * Body:
 *   name, slug, executionMode, imageRef?, envVars?, port?,
 *   totalCpuCores, totalRamMb, totalVramMb?,
 *   tenantCountry?, tenantState?, tenantContinent?, region?, maxNodes?
 */
export async function createCluster(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      name, slug, executionMode = 'AUTO', imageRef, envVars, port,
      totalCpuCores = 4, totalRamMb = 8192, totalVramMb = 0,
      tenantCountry, tenantState, tenantContinent, region, maxNodes,
    } = req.body as {
      name: string; slug: string;
      executionMode?: 'WASM' | 'MICROVM' | 'AUTO';
      imageRef?: string; envVars?: Record<string, string>; port?: number;
      totalCpuCores?: number; totalRamMb?: number; totalVramMb?: number;
      tenantCountry?: string; tenantState?: string; tenantContinent?: string;
      region?: string; maxNodes?: number;
    };

    if (!name || !slug) {
      res.status(400).json({ status: 'error', message: '"name" and "slug" are required.' });
      return;
    }

    // 1. Plan which nodes to use
    const plan = await collective.planCluster({
      totalCpuCores, totalRamMb, totalVramMb,
      tenantCountry, tenantState, tenantContinent, region, maxNodes,
    });

    // 2. Create DePINApp + ResourceCluster records
    const resolvedMode = executionMode === 'AUTO' ? 'MICROVM' : executionMode;

    const app = await (prisma.dePINApp as any).create({
      data: {
        name, slug,
        executionMode: resolvedMode,
        imageRef, envVars, port,
        replicaCount: plan.nodes.length,
        status: 'PENDING',
      },
    });

    const cluster = await collective.createCluster(app.id, plan);

    // 3. Create NodeAssignments (for billing / telemetry compatibility)
    await prisma.nodeAssignment.createMany({
      data: plan.nodes.map(n => ({
        appId:  app.id,
        nodeId: n.nodeId,
        role:   n.role === 'LEADER' ? 'LEADER' : 'FOLLOWER',
        status: 'RUNNING',
      })),
    });

    // 4. Push WireGuard mesh config + workload to each agent
    const peerList = plan.nodes.map(n => ({ nodeId: n.nodeId, meshIp: n.meshIp, pubKey: '' }));

    for (const node of plan.nodes) {
      const ws = getAgentSocket(node.nodeId);
      if (!ws) continue;

      const peers = peerList.filter(p => p.nodeId !== node.nodeId);
      ws.send(JSON.stringify({
        type:   'action',
        action: 'setup_mesh',
        meshIp:  node.meshIp,
        subnet:  plan.meshSubnet,
        peers,
      }));
    }

    // 5. Dispatch workload
    sendWorkloadToNodes(app, plan.nodes.map(n => ({
      id: n.nodeId, name: n.name, score: n.score, ipAddress: n.ipAddress,
    }))).catch(err => console.error('[cluster] workload dispatch error:', err));

    res.status(201).json({
      status: 'success',
      data: {
        app,
        cluster: {
          id:            cluster.id,
          totalCpuCores: plan.totalCpuCores,
          totalRamMb:    plan.totalRamMb,
          totalVramMb:   plan.totalVramMb,
          meshSubnet:    plan.meshSubnet,
          proximityTier: plan.proximityTier,
          nodeCount:     plan.nodes.length,
          nodes: plan.nodes,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/clusters/:id/telemetry ───────────────────────────────────────
export async function clusterTelemetry(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const tel = await collective.getClusterTelemetry(req.params.id);
    if (!tel) {
      res.status(404).json({ status: 'error', message: 'Cluster not found.' });
      return;
    }
    res.json({ status: 'success', data: tel });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/clusters ─────────────────────────────────────────────────────
export async function listClusters(_req: Request, res: Response, next: NextFunction) {
  try {
    const clusters = await (prisma.resourceCluster as any).findMany({
      include: {
        app: { select: { id: true, name: true, slug: true, status: true } },
        members: { select: { nodeId: true, meshIp: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ status: 'success', data: { clusters } });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/v1/clusters/:id ──────────────────────────────────────────────
export async function dissolveCluster(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const cluster = await (prisma.resourceCluster as any).findUnique({
      where: { id: req.params.id },
      include: { members: true },
    });
    if (!cluster) {
      res.status(404).json({ status: 'error', message: 'Cluster not found.' });
      return;
    }

    // Tell agents to tear down the mesh
    for (const m of cluster.members) {
      const ws = getAgentSocket(m.nodeId);
      if (ws) ws.send(JSON.stringify({ type: 'action', action: 'teardown_mesh' }));
    }

    await (prisma.resourceCluster as any).delete({ where: { id: req.params.id } });
    res.json({ status: 'success', data: { dissolved: true } });
  } catch (err) {
    next(err);
  }
}
