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
}

export interface SchedulerOptions {
  count?: number;        // How many nodes to select (default 3)
  region?: string;       // ISO-3166-1 alpha-2 country filter (optional)
  requireConnected?: boolean; // Only include nodes with active WS (default true)
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
  const { count = 3, region, requireConnected = true } = options;

  // 1. Fetch ONLINE nodes from DB (optionally filtered by country/region)
  const nodes = await prisma.node.findMany({
    where: {
      status: 'ONLINE',
      ...(region ? { country: region } : {}),
    },
  });

  if (nodes.length === 0) return [];

  // 2. Score each node using latest telemetry
  const scored = await Promise.all(
    nodes.map(async (node: { id: string; name: string; ipAddress: string | null; country: string | null; city: string | null }) => {
      const connected = getAgentSocket(node.id) !== undefined;

      if (requireConnected && !connected) return null;

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
  imageRef?: string;  // Docker image or WASM module base64
  envVars?: Record<string, string>;
  port?: number;
  region?: string;
  replicaCount?: number;
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
  } = options;

  const resolvedMode = executionMode === 'AUTO' ? 'MICROVM' : executionMode;

  // 1. Select best nodes
  const candidates = await selectNodes({ count: replicaCount, region });

  if (candidates.length === 0) {
    throw new Error('No available nodes to schedule the workload. Check that agents are online.');
  }

  if (candidates.length < replicaCount) {
    console.warn(
      `[scheduler] Requested ${replicaCount} replicas but only ${candidates.length} nodes available.`,
    );
  }

  // 2. Upsert DePINApp record
  const app = await prisma.dePINApp.upsert({
    where: { slug },
    update: { executionMode: resolvedMode, imageRef, envVars, port, region, replicaCount, status: 'PENDING' },
    create: { name, slug, executionMode: resolvedMode, imageRef, envVars, port, region, replicaCount, status: 'PENDING' },
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
 */
export async function getApp(appId: string) {
  return prisma.dePINApp.findUnique({
    where: { id: appId },
    include: {
      assignments: {
        include: { node: true },
      },
    },
  });
}

/**
 * Lists all DePIN apps with their assignments.
 */
export async function listApps() {
  return prisma.dePINApp.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      assignments: {
        include: { node: { select: { id: true, name: true, status: true, ipAddress: true, country: true } } },
      },
    },
  });
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
