import { Request, Response, NextFunction } from 'express';
import * as scheduler from '../../services/scheduler.service';
import { classifyRuntime } from '../../services/classifier.service';
import { sendWorkloadToNodes } from '../../services/workload-dispatch.service';
import prisma from '../../config/database';

// ── GET /api/v1/scheduler/nodes ───────────────────────────────────────────────
/**
 * Returns the ranked list of available nodes based on current telemetry.
 */
export async function getAvailableNodes(req: Request, res: Response, next: NextFunction) {
  try {
    const count  = parseInt((req.query.count  as string) ?? '10', 10);
    const region = (req.query.region as string) || undefined;

    const nodes = await scheduler.selectNodes({ count, region, requireConnected: true });
    res.json({ status: 'success', data: { nodes } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/v1/scheduler/deploy ─────────────────────────────────────────────
/**
 * Deploys a DePIN app:
 *  1. Optionally classifies runtime via AI (if mode = "auto")
 *  2. Selects best nodes
 *  3. Creates DB records
 *  4. Dispatches workload to agents via WS tunnel
 */
export async function deployApp(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      name,
      slug,
      executionMode = 'AUTO',
      imageRef,
      envVars,
      port,
      region,
      replicaCount = 3,
      // For AI classification
      codeHint,
    } = req.body as {
      name: string;
      slug: string;
      executionMode?: 'WASM' | 'MICROVM' | 'AUTO';
      imageRef?: string;
      envVars?: Record<string, string>;
      port?: number;
      region?: string;
      replicaCount?: number;
      codeHint?: string;
    };

    if (!name || !slug) {
      res.status(400).json({ status: 'error', message: '"name" and "slug" are required.' });
      return;
    }

    // 1. AI classification when mode is AUTO and a code hint is provided
    let resolvedMode: 'WASM' | 'MICROVM' = executionMode === 'AUTO' ? 'MICROVM' : executionMode;
    let aiReasoning: string | undefined;

    if (executionMode === 'AUTO' && codeHint) {
      try {
        const classification = await classifyRuntime(codeHint);
        resolvedMode  = classification.mode;
        aiReasoning   = classification.reasoning;
      } catch (err) {
        console.warn('[scheduler] AI classification failed, defaulting to MICROVM:', err);
      }
    }

    // 2. Create deployment (selects nodes + DB records)
    const { app, assignments, nodes } = await scheduler.createDeployment({
      name,
      slug,
      executionMode: resolvedMode,
      imageRef,
      envVars,
      port,
      region,
      replicaCount,
    });

    // 3. Dispatch workload to selected agents (fire-and-forget, errors are logged)
    sendWorkloadToNodes(app, nodes).catch((err) =>
      console.error(`[scheduler] workload dispatch error for app ${app.id}:`, err),
    );

    res.status(201).json({
      status: 'success',
      data: {
        app,
        assignments,
        nodes: nodes.map((n: { id: string; name: string; score: number }, i: number) => ({ id: n.id, name: n.name, score: n.score, role: resolvedMode === 'MICROVM' && i === 0 ? 'LEADER' : resolvedMode === 'MICROVM' ? 'FOLLOWER' : 'WASM_WORKER' })),
        aiReasoning,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/scheduler/apps ────────────────────────────────────────────────
export async function listApps(_req: Request, res: Response, next: NextFunction) {
  try {
    const apps = await scheduler.listApps();
    res.json({ status: 'success', data: { apps } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/scheduler/apps/:id ───────────────────────────────────────────
export async function getApp(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const app = await scheduler.getApp(req.params.id);
    if (!app) {
      res.status(404).json({ status: 'error', message: 'App not found.' });
      return;
    }
    res.json({ status: 'success', data: { app } });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/v1/scheduler/apps/:id ────────────────────────────────────────
export async function removeApp(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const app = await scheduler.getApp(req.params.id);
    if (!app) {
      res.status(404).json({ status: 'error', message: 'App not found.' });
      return;
    }

    // Signal agents to stop the workload
    const { sendStopToNodes } = await import('../../services/workload-dispatch.service');
    await sendStopToNodes(app).catch(console.error);

    await scheduler.removeApp(req.params.id);
    res.json({ status: 'success', message: 'App removed.' });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/v1/scheduler/apps/:id/reassign ─────────────────────────────────
/**
 * Replaces a specific offline node in an app's assignment list with a new best node.
 * Used by the failover monitor.
 */
export async function reassignNode(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { offlineNodeId } = req.body as { offlineNodeId: string };
    if (!offlineNodeId) {
      res.status(400).json({ status: 'error', message: '"offlineNodeId" is required.' });
      return;
    }

    const app = await scheduler.getApp(req.params.id);
    if (!app) {
      res.status(404).json({ status: 'error', message: 'App not found.' });
      return;
    }

    // Mark offline assignment
    await prisma.nodeAssignment.updateMany({
      where: { appId: app.id, nodeId: offlineNodeId },
      data:  { status: 'OFFLINE' },
    });

    // Select replacement (exclude already assigned nodes)
    const assignedIds = app.assignments.map((a: { nodeId: string }) => a.nodeId);
    const candidates  = await scheduler.selectNodes({ count: 1, region: app.region ?? undefined });
    const replacement = candidates.find((c) => !assignedIds.includes(c.id));

    if (!replacement) {
      res.status(503).json({ status: 'error', message: 'No replacement node available.' });
      return;
    }

    const newAssignment = await prisma.nodeAssignment.create({
      data: {
        appId:  app.id,
        nodeId: replacement.id,
        role:   app.executionMode === 'MICROVM' ? 'FOLLOWER' : 'WASM_WORKER',
        status: 'RUNNING',
      },
    });

    // Dispatch workload to new node
    const { sendWorkloadToNodes } = await import('../../services/workload-dispatch.service');
    await sendWorkloadToNodes(app, [replacement]).catch(console.error);

    res.json({ status: 'success', data: { newAssignment, replacementNode: replacement } });
  } catch (err) {
    next(err);
  }
}
