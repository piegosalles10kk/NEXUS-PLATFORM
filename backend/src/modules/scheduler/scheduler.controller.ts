import { Request, Response, NextFunction } from 'express';
import * as scheduler from '../../services/scheduler.service';
import { classifyRuntime } from '../../services/classifier.service';
import { sendWorkloadToNodes } from '../../services/workload-dispatch.service';
import prisma from '../../config/database';
import { getRedisClient } from '../../config/redis';
import { parseComposeYaml, planNodeAssignments } from '../../services/compose-parser.service';
import { getAgentSocket } from '../../services/agent-ws.service';

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
      userId: req.user!.id,
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
export async function listApps(req: Request, res: Response, next: NextFunction) {
  try {
    // ADM sees all apps; TECNICO sees only their own
    const userId = req.user?.role === 'ADM' ? undefined : req.user!.id;
    const apps = await scheduler.listApps(userId);
    res.json({ status: 'success', data: { apps } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/scheduler/apps/:id ───────────────────────────────────────────
export async function getApp(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.role === 'ADM' ? undefined : req.user!.id;
    const app = await scheduler.getApp(req.params.id, userId);
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
    const userId = req.user?.role === 'ADM' ? undefined : req.user!.id;
    const app = await scheduler.getApp(req.params.id, userId);
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

// ── PATCH /api/v1/scheduler/apps/:id ─────────────────────────────────────────
/**
 * Hot-resize a running DePIN app without downtime.
 * Updates vCpu / ramMb / vramMb in DB then pushes UPDATE_RESOURCES to each
 * assigned agent — the agent writes to cgroup v2 files directly (<1 s).
 */
export async function resizeApp(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    const { vCpu, ramMb, vramMb } = req.body as {
      vCpu?:   number;
      ramMb?:  number;
      vramMb?: number;
    };

    const userId = req.user?.role === 'ADM' ? undefined : req.user!.id;
    const app = await scheduler.getApp(req.params.id, userId);
    if (!app) {
      res.status(404).json({ status: 'error', message: 'App not found.' });
      return;
    }

    // Persist new resource limits
    const updated = await (prisma.dePINApp as any).update({
      where: { id: app.id },
      data: {
        ...(vCpu   !== undefined ? { vCpu }   : {}),
        ...(ramMb  !== undefined ? { ramMb }  : {}),
        ...(vramMb !== undefined ? { vramMb } : {}),
      },
    });

    // Push live resize to all running agents for this app
    const { sendResizeToNodes } = await import('../../services/workload-dispatch.service');
    await sendResizeToNodes(updated, {
      vCpu:   vCpu   ?? updated.vCpu,
      ramMb:  ramMb  ?? updated.ramMb,
      vramMb: vramMb ?? updated.vramMb,
    }).catch(console.error);

    // Notify frontend via Socket.io
    const io = req.app.get('io');
    io?.emit('app:resize', { appId: app.id, vCpu: updated.vCpu, ramMb: updated.ramMb, vramMb: updated.vramMb });

    res.json({ status: 'success', data: { app: updated } });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/scheduler/apps/:id/telemetry/net ─────────────────────────────
/**
 * Constellation View — returns the app's cluster topology with star aliases.
 * Node IPs and hostnames are NEVER returned here; only the alias, status, and
 * anonymised telemetry. Safe for end-users (Tenant) to call.
 */

const STAR_NAMES = [
  'Orion','Sirius','Vega','Rigel','Deneb','Altair','Arcturus','Aldebaran',
  'Antares','Spica','Pollux','Castor','Capella','Procyon','Regulus','Betelgeuse',
  'Fomalhaut','Achernar','Mira','Canopus','Hadar','Acrux','Mimosa','Gacrux',
  'Elnath','Alhena','Adhara','Wezen','Mirfak','Algenib','Algol','Menkar',
  'Menkib','Nunki','Kaus','Sabik','Rasalhague','Yed','Cebalrai','Marfik',
  'Zubenelgenubi','Zubeneshamali','Sheratan','Hamal','Segin','Ruchbah',
  'Caph','Schedar','Navi','Achird','Dubhe','Merak','Phad','Megrez',
  'Alioth','Mizar','Alkaid','Thuban','Phi','Fulu','Acamar','Zaurak',
];

function starAlias(nodeId: string): string {
  const hex = nodeId.replace(/-/g, '').slice(0, 4);
  return STAR_NAMES[parseInt(hex, 16) % STAR_NAMES.length];
}

export async function getAppNetTelemetry(req: Request<{ id: string }>, res: Response, next: NextFunction) {
  try {
    // Tenants see their own apps; ADM sees all
    const userId = req.user?.role === 'ADM' ? undefined : req.user!.id;
    const app = await scheduler.getApp(req.params.id, userId);
    if (!app) {
      res.status(404).json({ status: 'error', message: 'App not found.' });
      return;
    }

    const nodeList: Array<{ id: string; alias: string; status: string }> = (app.assignments ?? []).map((a: any) => ({
      id:     a.nodeId as string,
      alias:  starAlias(a.nodeId),
      status: a.status as string,
    }));

    // Load real peer latencies from Redis for each node in this cluster
    const redis = await getRedisClient();
    const peerDataMap: Record<string, Record<string, number>> = {};
    await Promise.all(nodeList.map(async (n) => {
      const raw = await redis.get(`node:${n.id}:peer_latencies`).catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw) as { peers: Record<string, number> };
        peerDataMap[n.id] = parsed.peers;
      }
    }));

    // Build edges with real latency when available
    const nodeIds = nodeList.map(n => n.id);
    const edges: { from: string; to: string; latencyMs: number | null; type: 'net' | 'fail' | 'gpu' }[] = [];
    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const a = nodeList[i]; const b = nodeList[j];
        const bothUp = a.status === 'RUNNING' && b.status === 'RUNNING';

        // Try to find real latency: A→B or B→A
        let latencyMs: number | null = null;
        const peersA = peerDataMap[a.id] ?? {};
        const peersB = peerDataMap[b.id] ?? {};
        // peerDataMap keys are IPs; try to find any value keyed by the other nodeId
        // (after backend re-keying in peer-matrix endpoint logic)
        for (const [key, ms] of Object.entries(peersA)) {
          if (nodeIds.includes(key) && key === b.id) { latencyMs = ms; break; }
        }
        if (latencyMs === null) {
          for (const [key, ms] of Object.entries(peersB)) {
            if (nodeIds.includes(key) && key === a.id) { latencyMs = ms; break; }
          }
        }

        const type = !bothUp ? 'fail' : latencyMs !== null && latencyMs < 10 ? 'gpu' : 'net';
        edges.push({ from: a.id, to: b.id, latencyMs, type });
      }
    }

    res.json({ status: 'success', data: { appId: app.id, appName: app.name, nodes: nodeList, edges } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/v1/scheduler/deploy-compose ────────────────────────────────────
/**
 * Sprint 18.2 — Docker Compose deploy.
 *
 * Accepts a raw docker-compose.yml string in `req.body.composeYaml` plus an
 * optional `stackName`. Parses the file, assigns each service to the best
 * available node, creates DB records, and dispatches `deploy_compose_service`
 * commands to each agent.
 *
 * Body: { composeYaml: string, stackName?: string }
 */
export async function deployCompose(req: Request, res: Response, next: NextFunction) {
  try {
    const { composeYaml, stackName = 'nexus' } = req.body as {
      composeYaml: string;
      stackName?:  string;
    };

    if (!composeYaml || typeof composeYaml !== 'string') {
      res.status(400).json({ status: 'error', message: '"composeYaml" is required.' });
      return;
    }

    // 1. Parse compose file → DeployPlan
    const plan = parseComposeYaml(composeYaml, stackName);
    if (plan.services.length === 0) {
      res.status(422).json({ status: 'error', message: 'No services found in compose file.', warnings: plan.warnings });
      return;
    }

    // 2. Load available nodes for placement
    const rawNodes = await prisma.node.findMany({
      where:  { status: 'ONLINE' },
      select: { id: true, infraType: true, status: true, cpuCores: true, ramMb: true, gpuCount: true },
    });

    const nodeData = rawNodes.map((n) => ({
      id:        n.id,
      infraType: n.infraType ?? 'STANDARD',
      status:    n.status,
      cpuCores:  n.cpuCores ?? 2,
      ramMb:     n.ramMb    ?? 2048,
      gpuCount:  n.gpuCount ?? 0,
    }));

    if (nodeData.length === 0) {
      res.status(503).json({ status: 'error', message: 'No online nodes available for deployment.' });
      return;
    }

    // 3. Assign services to nodes
    const assignments = planNodeAssignments(plan, nodeData);

    // 4. Create a DePINApp record for the whole stack
    const app = await (prisma.dePINApp as any).create({
      data: {
        name:          stackName,
        slug:          `${stackName}-compose-${Date.now()}`,
        executionMode: 'MICROVM',
        status:        'DEPLOYING',
        userId:        req.user!.id,
      },
    });

    // 5. Create NodeAssignment records + dispatch to agents
    const dispatched: Array<{ service: string; nodeId: string; status: string }> = [];

    for (const { service, nodeId } of assignments) {
      // DB record
      await prisma.nodeAssignment.create({
        data: {
          appId:  app.id,
          nodeId,
          role:   service.role === 'api' || service.role === 'frontend' ? 'LEADER' : 'FOLLOWER',
          status: 'RUNNING',
        },
      });

      // Dispatch to agent
      const { WebSocket } = await import('ws');
      const ws = getAgentSocket(nodeId);
      if (ws && (ws as any).readyState === WebSocket.OPEN) {
        (ws as any).send(JSON.stringify({
          type:         'deploy_compose_service',
          appId:        app.id,
          stackName,
          serviceName:  service.name,
          role:         service.role,
          image:        service.image ?? null,
          build:        service.build ?? null,
          ports:        service.ports,
          envVars:      { ...service.envVars },
          depends:      service.depends,
          volumes:      service.volumes,
          networks:     service.networks,
          replicas:     service.replicas,
          cpuLimit:     service.cpuLimit  ?? null,
          memLimit:     service.memLimit  ?? null,
          gatewayRoute: service.gatewayRoute ?? null,
        }));
        dispatched.push({ service: service.name, nodeId, status: 'dispatched' });
      } else {
        dispatched.push({ service: service.name, nodeId, status: 'agent_offline' });
      }
    }

    // 6. Notify frontend
    const io = req.app.get('io');
    io?.emit('compose:deployed', { appId: app.id, stackName, services: dispatched.length });

    res.status(201).json({
      status: 'success',
      data: {
        app,
        plan:       { totalServices: plan.totalServices, networkName: plan.networkName, warnings: plan.warnings },
        dispatched,
      },
    });
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
