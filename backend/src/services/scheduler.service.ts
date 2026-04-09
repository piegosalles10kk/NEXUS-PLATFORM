/**
 * scheduler.service.ts
 *
 * Selects the best N nodes from the network for a given workload.
 *
 * Scoring (lower = better):
 *   score = cpu_percent * 0.5 + mem_percent * 0.4 + latency_norm * 0.1
 *
 * If a node has no recent telemetry, it defaults to cpu=50, mem=50 (neutral).
 * Nodes that have been offline for more than 30s are excluded.
 */
import prisma from '../config/database';
import { getRedisClient } from '../config/redis';
import { getAgentSocket } from './agent-ws.service';
import { consolidateDailyUsage } from './wallet.service';

export interface NodeCandidate {
  id: string;
  name: string;
  ipAddress: string | null;
  country: string | null;
  city: string | null;
  cpuPercent: number;
  memPercent: number;
  score: number;
  connected: boolean;
  // GPU capability
  gpuCount: number;
  gpuModel: string | null;
  gpuMemoryMb: number | null;
}

export interface SchedulerOptions {
  count?: number;           // How many nodes to select (default 3)
  region?: string;          // ISO-3166-1 alpha-2 country filter (optional)
  requireConnected?: boolean; // Only include nodes with active WS (default true)
  requireGpu?: boolean;     // Only include nodes with at least one GPU
}

// ── Node scoring ──────────────────────────────────────────────────────────────

function computeScore(cpuPercent: number, memPercent: number): number {
  return cpuPercent * 0.5 + memPercent * 0.4;
}

async function getLatestTelemetry(
  nodeId: string,
): Promise<{ cpuPercent: number; memPercent: number } | null> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.lIndex(`node:${nodeId}:telemetry`, 0); // newest entry
    if (!raw) return null;

    const payload = JSON.parse(raw);

    // Telemetry payload may use different field names depending on agent version.
    const cpuPercent =
      payload.cpuPercent ??
      payload.cpu_percent ??
      payload.cpu ??
      null;

    const memPercent =
      payload.memPercent ??
      payload.mem_percent ??
      payload.memory_percent ??
      (payload.memUsed && payload.memTotal
        ? (payload.memUsed / payload.memTotal) * 100
        : null);

    if (cpuPercent === null || memPercent === null) return null;

    return {
      cpuPercent: Math.min(100, Math.max(0, Number(cpuPercent))),
      memPercent: Math.min(100, Math.max(0, Number(memPercent))),
    };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a ranked list of node candidates suitable for the workload.
 */
export async function selectNodes(options: SchedulerOptions = {}): Promise<NodeCandidate[]> {
  const { count = 3, region, requireConnected = true, requireGpu = false } = options;

  // NodeDbRow: the subset of Node columns we need (GPU fields may not yet be
  // present in the auto-generated PrismaClient if `prisma db push` has not been
  // run after the schema change — the cast to `any[]` keeps TS happy until then).
  interface NodeDbRow {
    id: string;
    name: string;
    ipAddress: string | null;
    country: string | null;
    city: string | null;
    gpuCount: number;
    gpuModel: string | null;
    gpuMemoryMb: number | null;
  }

  // 1. Fetch ONLINE nodes from DB (strictly filtered by country/region and GPU when requested)
  const nodes = (await (prisma.node as any).findMany({
    where: {
      status: 'ONLINE',
      ...(region     ? { country: region }          : {}),
      ...(requireGpu ? { gpuCount: { gt: 0 } }      : {}),
    },
    select: {
      id: true, name: true, ipAddress: true,
      country: true, city: true,
      gpuCount: true, gpuModel: true, gpuMemoryMb: true,
    },
  })) as NodeDbRow[];

  if (nodes.length === 0) return [];

  // 2. Score each node using latest telemetry
  const scored = await Promise.all(
    nodes.map(async (node) => {
      const connected = getAgentSocket(node.id) !== undefined;

      if (requireConnected && !connected) return null;

      // Double-check region at scoring stage (failsafe — DB filter already handles it)
      if (region && node.country !== region) return null;

      const telemetry = await getLatestTelemetry(node.id);
      const cpuPercent = telemetry?.cpuPercent ?? 50;
      const memPercent = telemetry?.memPercent ?? 50;

      return {
        id: node.id,
        name: node.name,
        ipAddress: node.ipAddress,
        country: node.country,
        city: node.city,
        cpuPercent,
        memPercent,
        score: computeScore(cpuPercent, memPercent),
        connected,
        gpuCount: node.gpuCount,
        gpuModel: node.gpuModel,
        gpuMemoryMb: node.gpuMemoryMb,
      } satisfies NodeCandidate;
    }),
  );

  // 3. Filter nulls, sort ascending by score, take top N
  return (scored.filter(Boolean) as NodeCandidate[])
    .sort((a, b) => a.score - b.score)
    .slice(0, count);
}

// ── Deploy orchestration ──────────────────────────────────────────────────────

export interface DeployAppOptions {
  name: string;
  slug: string;
  executionMode: 'WASM' | 'MICROVM' | 'AUTO';
  imageRef?: string;     // Docker image or WASM module base64
  envVars?: Record<string, string>;
  port?: number;
  region?: string;       // ISO-3166-1 alpha-2 — enforces geography at scheduling time
  replicaCount?: number;
  requireGpu?: boolean;  // If true, only schedule on GPU-capable nodes
  userId?: string;       // Tenant who deployed this app (consumer)
}

/**
 * Selects nodes and creates the DePINApp + NodeAssignment records.
 * The actual workload dispatch is done separately (sendWorkloadToNodes).
 */
export async function createDeployment(options: DeployAppOptions) {
  const {
    name,
    slug,
    executionMode,
    imageRef,
    envVars,
    port,
    region,
    replicaCount = 3,
    requireGpu = false,
    userId,
  } = options;

  const resolvedMode = executionMode === 'AUTO' ? 'MICROVM' : executionMode;

  // 1. Select best nodes (region and GPU constraints applied here)
  const candidates = await selectNodes({ count: replicaCount, region, requireGpu });

  if (candidates.length === 0) {
    const reason = requireGpu
      ? `No GPU-capable nodes available${region ? ` in region "${region}"` : ''}.`
      : `No available nodes${region ? ` in region "${region}"` : ''}. Check that agents are online.`;
    throw new Error(reason);
  }

  if (candidates.length < replicaCount) {
    console.warn(
      `[scheduler] Requested ${replicaCount} replicas but only ${candidates.length} nodes available${
        region ? ` in region "${region}"` : ''
      }.`,
    );
  }

  // 2. Upsert DePINApp record
  const app = await (prisma.dePINApp as any).upsert({
    where: { slug },
    update: { executionMode: resolvedMode, imageRef, envVars, port, region, replicaCount, status: 'PENDING' },
    create: { name, slug, executionMode: resolvedMode, imageRef, envVars, port, region, replicaCount, status: 'PENDING', userId },
  });

  // 3. Create NodeAssignment records (first = LEADER for MICROVM, rest = FOLLOWER)
  await prisma.nodeAssignment.deleteMany({ where: { appId: app.id } });

  const assignments = await prisma.$transaction(
    candidates.map((candidate, index) =>
      prisma.nodeAssignment.create({
        data: {
          appId: app.id,
          nodeId: candidate.id,
          role:
            resolvedMode === 'MICROVM'
              ? index === 0
                ? 'LEADER'
                : 'FOLLOWER'
              : 'WASM_WORKER',
          status: 'RUNNING',
        },
      }),
    ),
  );

  await prisma.dePINApp.update({
    where: { id: app.id },
    data: { status: 'RUNNING' },
  });

  return { app, assignments, nodes: candidates };
}

/**
 * Loads a DePINApp with its assignments and node details.
 * If userId is provided, enforces ownership (returns null if mismatch).
 */
export async function getApp(appId: string, userId?: string) {
  const app = await (prisma.dePINApp as any).findUnique({
    where: { id: appId },
    include: {
      assignments: {
        include: { node: true },
      },
    },
  });
  if (!app) return null;
  if (userId && app.userId && app.userId !== userId) return null; // tenant isolation
  return app;
}

/**
 * Lists DePIN apps. ADM (userId = undefined) sees all; tenant sees only theirs.
 */
export async function listApps(userId?: string) {
  return (prisma.dePINApp as any).findMany({
    where: userId ? { userId } : {},
    orderBy: { createdAt: 'desc' },
    include: {
      assignments: {
        include: { node: { select: { id: true, name: true, status: true, ipAddress: true, country: true } } },
      },
    },
  });
}

// ── Demand Ratio (Surge Pricing input) ───────────────────────────────────────

const DEMAND_KEY = 'depin:demand_ratio';

/**
 * Computes and caches the DemandRatio per region.
 * DemandRatio = activeRequests / onlineNodes (capped at 3.0)
 * Refreshed every 30 seconds by the monitoring loop.
 */
export async function refreshDemandRatio(): Promise<Record<string, number>> {
  try {
    const redis = await getRedisClient();

    // Count running assignments per country
    const assignments = await prisma.nodeAssignment.findMany({
      where: { status: 'RUNNING' },
      include: { node: { select: { country: true, id: true } } },
    });

    const onlineByRegion: Record<string, number> = {};
    const assignedByRegion: Record<string, number> = {};

    for (const a of assignments) {
      const region = a.node.country ?? 'global';
      assignedByRegion[region] = (assignedByRegion[region] ?? 0) + 1;
      if (getAgentSocket(a.node.id)) {
        onlineByRegion[region] = (onlineByRegion[region] ?? 0) + 1;
      }
    }

    const ratio: Record<string, number> = {};
    for (const region of Object.keys(assignedByRegion)) {
      const online = onlineByRegion[region] ?? 1;
      const assigned = assignedByRegion[region];
      ratio[region] = Math.min(assigned / online, 3.0);
    }
    ratio['global'] = ratio['global'] ?? 1.0;

    await redis.set(DEMAND_KEY, JSON.stringify(ratio), { EX: 60 });
    return ratio;
  } catch {
    return { global: 1.0 };
  }
}

export async function getDemandRatio(region?: string): Promise<number> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.get(DEMAND_KEY);
    if (!raw) return 1.0;
    const ratio = JSON.parse(raw);
    return ratio[region ?? 'global'] ?? ratio['global'] ?? 1.0;
  } catch {
    return 1.0;
  }
}

// ── Network Transit Saturation Monitor ───────────────────────────────────────

const TRANSIT_SATURATION_THRESHOLD = 0.70; // 70 % of active-node bandwidth → trigger standby

/**
 * Checks bandwidth utilisation across active transit nodes.
 * If saturation ≥ 70 %, activates standby nodes from the transit pool.
 * Called every 30 s by the monitoring loop.
 */
export async function checkTransitSaturation(io?: any): Promise<void> {
  try {
    const redis = await getRedisClient();

    // Gather latest netTxSec for each ONLINE node offering transit
    const transitNodes = await (prisma.node as any).findMany({
      where: { status: 'ONLINE' },
      include: { policy: true },
      select: { id: true, name: true, ipAddress: true, transitStatus: true, policy: true },
    }) as Array<{ id: string; name: string; ipAddress: string | null; transitStatus: string; policy: any }>;

    let totalCapacityBps = 0;
    let totalUsedBps     = 0;

    for (const node of transitNodes) {
      if (!node.policy?.offerNetworkTransit) continue;
      const capacityBps = (node.policy.transitBandwidthMbps ?? 100) * 1_000_000 / 8;
      totalCapacityBps += capacityBps;

      // Read latest telemetry from Redis
      const raw = await redis.lIndex(`node:${node.id}:telemetry`, 0);
      if (raw) {
        const t = JSON.parse(raw);
        totalUsedBps += (t.netTxSec ?? 0) + (t.netRxSec ?? 0);
      }
    }

    if (totalCapacityBps === 0) return;

    const saturation = totalUsedBps / totalCapacityBps;

    // Find standby-capable nodes (policy.offerNetworkTransit but transitStatus = IDLE)
    const standbyPool = transitNodes.filter(
      n => n.policy?.offerNetworkTransit && n.transitStatus === 'IDLE',
    );

    if (saturation >= TRANSIT_SATURATION_THRESHOLD && standbyPool.length > 0) {
      // Promote first standby node to ACTIVE
      const node = standbyPool[0];
      await (prisma.node as any).update({
        where: { id: node.id },
        data: { transitStatus: 'STREAMING' },
      });

      // Push activate_transit to the agent
      const { getAgentSocket } = await import('./agent-ws.service');
      const ws = getAgentSocket(node.id);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          action: 'activate_transit',
          bandwidthMbps: node.policy?.transitBandwidthMbps ?? 100,
        }));
      }

      io?.emit('node:transit_activated', { nodeId: node.id, saturation });
      console.log(`[transit] Promoted node ${node.name} to STREAMING (saturation=${(saturation*100).toFixed(1)}%)`);

    } else if (saturation < TRANSIT_SATURATION_THRESHOLD * 0.50) {
      // De-activate streaming nodes when saturation drops below 35 %
      const streamingNodes = transitNodes.filter(n => n.transitStatus === 'STREAMING');
      for (const node of streamingNodes) {
        await (prisma.node as any).update({
          where: { id: node.id },
          data: { transitStatus: 'STANDBY' },
        });
        const { getAgentSocket } = await import('./agent-ws.service');
        const ws = getAgentSocket(node.id);
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ action: 'deactivate_transit' }));
        }
        io?.emit('node:transit_deactivated', { nodeId: node.id });
      }
    }

    // Update Redis with current saturation for UI display
    await redis.set('network:saturation', saturation.toFixed(4), { EX: 60 });
  } catch (err) {
    console.error('[transit] saturation check error:', err);
  }
}

// ── Daily billing cron ────────────────────────────────────────────────────────

/**
 * Must be wired to a cron job that fires at 00:00 UTC every day.
 * Call this from your app startup / cron scheduler.
 */
export async function runDailyBillingCron(): Promise<void> {
  console.log('[scheduler] Running daily billing consolidation...');
  await consolidateDailyUsage();
  console.log('[scheduler] Daily billing done.');
}

/**
 * Runs both the transit saturation check and the Sonar latency monitor.
 * Wire this to a 30 s interval at startup.
 */
export async function runNetworkMonitor(io?: any): Promise<void> {
  await checkTransitSaturation(io).catch(err => console.error('[monitor] transit check error:', err));
  const { runSonarMonitor } = await import('./sonar.service');
  await runSonarMonitor().catch(err => console.error('[monitor] sonar error:', err));
}

/**
 * Marks an app and all its assignments as OFFLINE.
 */
export async function removeApp(appId: string) {
  await prisma.nodeAssignment.updateMany({
    where: { appId },
    data: { status: 'OFFLINE' },
  });
  return prisma.dePINApp.update({
    where: { id: appId },
    data: { status: 'OFFLINE' },
  });
}
