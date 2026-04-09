/**
 * collective-scheduler.service.ts  (Sprint 11.2)
 *
 * The CollectiveScheduler pools resources from multiple physical nodes into a
 * single logical "supercomputer" called a ResourceCluster.
 *
 * Selection strategy (proximity-first):
 *   1. Same state  + same country   (lowest latency)
 *   2. Same country  (different state)
 *   3. Same continent
 *   4. Any online node (fallback)
 *
 * Each tier is tried in order until enough nodes are found.  If Sonar latency
 * data is available it is used as a tie-breaker inside each tier.
 */

import prisma from '../config/database';
import { getAgentSocket } from './agent-ws.service';
import { getRedisClient } from '../config/redis';
import { getNexusBaseForCountry } from './market-watch.service';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClusterRequirements {
  /** Total vCPUs needed across the cluster */
  totalCpuCores:  number;
  /** Total RAM needed (MB) */
  totalRamMb:     number;
  /** Total VRAM needed (MB) — 0 means GPU not required */
  totalVramMb?:   number;
  /** Preferred tenant geography for proximity scoring */
  tenantCountry?: string | null;
  tenantState?:   string | null;
  tenantContinent?: string | null;
  /** Hard region constraint — null = global */
  region?:        string | null;
  /** Max number of nodes to include (default 8) */
  maxNodes?:      number;
}

export interface ClusterNode {
  nodeId:       string;
  name:         string;
  ipAddress:    string | null;
  country:      string | null;
  state:        string | null;
  continent:    string | null;
  cpuCores:     number;
  ramMb:        number;
  gpuCount:     number;
  gpuMemoryMb:  number | null;
  meshIp:       string;         // assigned 10.50.0.x
  role:         'LEADER' | 'WORKER';
  sonarMs:      number | null;
  score:        number;
}

export interface ClusterPlan {
  nodes:          ClusterNode[];
  totalCpuCores:  number;
  totalRamMb:     number;
  totalVramMb:    number;
  meshSubnet:     string;
  proximityTier:  'state' | 'country' | 'continent' | 'global';
}

// ── Mesh IP allocator ─────────────────────────────────────────────────────────

/** Returns the next available 10.50.x.y address for a cluster member. */
function allocateMeshIps(count: number, subnet = '10.50.0'): string[] {
  // Start at .2 — .1 is reserved for the virtual gateway
  return Array.from({ length: count }, (_, i) => `${subnet}.${i + 2}`);
}

// ── Telemetry helpers ─────────────────────────────────────────────────────────

async function getNodeLoad(nodeId: string): Promise<{ cpu: number; mem: number }> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.lIndex(`node:${nodeId}:telemetry`, 0);
    if (!raw) return { cpu: 50, mem: 50 };
    const p = JSON.parse(raw);
    return {
      cpu: Number(p.cpuPercent ?? p.cpu_percent ?? p.cpu ?? 50),
      mem: Number(p.memPercent ?? p.mem_percent ?? p.ramUsage ?? 50),
    };
  } catch {
    return { cpu: 50, mem: 50 };
  }
}

// ── Node scoring ──────────────────────────────────────────────────────────────

/**
 * Lower score = better candidate.
 * Factors: load (60 %), sonar latency (30 %), GPU bonus (-10 % if has GPU and needed).
 */
function scoreNode(load: { cpu: number; mem: number }, sonarMs: number | null, needsGpu: boolean, hasGpu: boolean): number {
  const loadScore   = load.cpu * 0.5 + load.mem * 0.4;
  const latScore    = sonarMs !== null ? Math.min(sonarMs / 200, 1) * 0.3 * 100 : 15;
  const gpuBonus    = needsGpu && hasGpu ? -10 : 0;
  return loadScore + latScore + gpuBonus;
}

// ── Core selection algorithm ──────────────────────────────────────────────────

interface NodeRow {
  id: string; name: string; ipAddress: string | null;
  country: string | null; state: string | null; continent: string | null;
  cpuCores: number; ramMb: number;
  gpuCount: number; gpuMemoryMb: number | null;
  sonarLatencyMs: number | null;
}

async function candidateNodes(region?: string | null): Promise<NodeRow[]> {
  return (prisma.node as any).findMany({
    where: {
      status: 'ONLINE',
      ...(region ? { country: region } : {}),
    },
    select: {
      id: true, name: true, ipAddress: true,
      country: true, state: true, continent: true,
      cpuCores: true, ramMb: true,
      gpuCount: true, gpuMemoryMb: true,
      sonarLatencyMs: true,
    },
  }) as Promise<NodeRow[]>;
}

/**
 * Selects and ranks nodes for a ResourceCluster according to the proximity
 * tiers.  Returns a full ClusterPlan ready to be persisted.
 */
export async function planCluster(req: ClusterRequirements): Promise<ClusterPlan> {
  const maxNodes  = req.maxNodes ?? 8;
  const needsGpu  = (req.totalVramMb ?? 0) > 0;

  const all = await candidateNodes(req.region ?? undefined);

  // Only keep nodes that have an active WS connection
  const connected = all.filter(n => getAgentSocket(n.id) !== undefined);
  if (connected.length === 0) throw new Error('No connected nodes available for cluster.');

  // Score each node
  const scored = await Promise.all(
    connected.map(async n => {
      const load = await getNodeLoad(n.id);
      return { ...n, _score: scoreNode(load, n.sonarLatencyMs, needsGpu, n.gpuCount > 0) };
    })
  );
  scored.sort((a, b) => a._score - b._score);

  // Proximity tiers
  const tiers = [
    { label: 'state'     as const, filter: (n: typeof scored[0]) => n.state     === req.tenantState   && n.country === req.tenantCountry },
    { label: 'country'   as const, filter: (n: typeof scored[0]) => n.country   === req.tenantCountry },
    { label: 'continent' as const, filter: (n: typeof scored[0]) => n.continent === req.tenantContinent },
    { label: 'global'    as const, filter: (_: typeof scored[0]) => true },
  ];

  let selected: typeof scored = [];
  let tier: ClusterPlan['proximityTier'] = 'global';

  for (const t of tiers) {
    const candidates = scored.filter(t.filter);
    if (candidates.length > 0) {
      selected = candidates.slice(0, maxNodes);
      tier = t.label;
      break;
    }
  }

  if (selected.length === 0) throw new Error('No suitable nodes found in any proximity tier.');

  const meshIps = allocateMeshIps(selected.length);

  const nodes: ClusterNode[] = selected.map((n, i) => ({
    nodeId:      n.id,
    name:        n.name,
    ipAddress:   n.ipAddress,
    country:     n.country,
    state:       n.state,
    continent:   n.continent,
    cpuCores:    n.cpuCores,
    ramMb:       n.ramMb,
    gpuCount:    n.gpuCount,
    gpuMemoryMb: n.gpuMemoryMb,
    meshIp:      meshIps[i],
    role:        i === 0 ? 'LEADER' : 'WORKER',
    sonarMs:     n.sonarLatencyMs,
    score:       n._score,
  }));

  return {
    nodes,
    totalCpuCores: nodes.reduce((s, n) => s + n.cpuCores, 0),
    totalRamMb:    nodes.reduce((s, n) => s + n.ramMb,    0),
    totalVramMb:   nodes.reduce((s, n) => s + (n.gpuMemoryMb ?? 0) * n.gpuCount, 0),
    meshSubnet:    '10.50.0.0/24',
    proximityTier: tier,
  };
}

// ── Persist cluster to DB ─────────────────────────────────────────────────────

export async function createCluster(appId: string, plan: ClusterPlan) {
  return prisma.$transaction(async (tx) => {
    const cluster = await (tx.resourceCluster as any).create({
      data: {
        appId,
        totalVramMb:   plan.totalVramMb,
        totalRamMb:    plan.totalRamMb,
        totalCpuCores: plan.totalCpuCores,
        meshSubnet:    plan.meshSubnet,
        status:        'FORMING',
        members: {
          create: plan.nodes.map(n => ({
            nodeId: n.nodeId,
            meshIp: n.meshIp,
            role:   n.role,
          })),
        },
      },
      include: { members: true },
    });

    // Stamp meshIp onto each Node for quick lookup
    for (const n of plan.nodes) {
      await (tx.node as any).update({
        where: { id: n.nodeId },
        data:  { meshIp: n.meshIp },
      });
    }

    return cluster;
  });
}

// ── Cluster telemetry aggregation (Sprint 13.3) ───────────────────────────────

export interface ClusterTelemetry {
  clusterId:     string;
  status:        string;
  nodeCount:     number;
  onlineCount:   number;
  totalCpuCores: number;
  usedCpuPct:    number;
  totalRamMb:    number;
  usedRamPct:    number;
  totalVramMb:   number;
  usedVramMb:    number;
  avgLatencyMs:  number | null;
  nodes: {
    nodeId: string; name: string; meshIp: string; role: string;
    cpuPct: number; memPct: number; vramUsedMb: number; latencyMs: number | null;
  }[];
}

export async function getClusterTelemetry(clusterId: string): Promise<ClusterTelemetry | null> {
  const cluster = await (prisma.resourceCluster as any).findUnique({
    where: { id: clusterId },
    include: {
      members: {
        include: {
          node: { select: { id: true, name: true, status: true, cpuCores: true, ramMb: true, gpuMemoryMb: true, gpuCount: true, sonarLatencyMs: true } },
        },
      },
    },
  });
  if (!cluster) return null;

  const redis = await getRedisClient();
  const nodeStats = await Promise.all(
    cluster.members.map(async (m: any) => {
      const raw = await redis.lIndex(`node:${m.node.id}:telemetry`, 0).catch(() => null);
      const tel = raw ? JSON.parse(raw) : {};
      const cpuPct   = Number(tel.cpuPercent ?? tel.cpu ?? 0);
      const memPct   = Number(tel.memPercent ?? tel.ramUsage ?? 0);
      const vramUsed = (tel.gpus?.[0]?.memory_used_mb ?? 0);
      return {
        nodeId:     m.node.id,
        name:       m.node.name,
        meshIp:     m.meshIp,
        role:       m.role,
        cpuPct,
        memPct,
        vramUsedMb: vramUsed,
        latencyMs:  m.node.sonarLatencyMs ?? null,
        online:     m.node.status === 'ONLINE',
        totalVramMb: (m.node.gpuMemoryMb ?? 0) * (m.node.gpuCount ?? 0),
      };
    })
  );

  const online   = nodeStats.filter(n => n.online);
  const latencies = nodeStats.map(n => n.latencyMs).filter((v): v is number => v !== null);

  return {
    clusterId,
    status:        cluster.status,
    nodeCount:     nodeStats.length,
    onlineCount:   online.length,
    totalCpuCores: cluster.totalCpuCores,
    usedCpuPct:    online.length ? online.reduce((s, n) => s + n.cpuPct, 0) / online.length : 0,
    totalRamMb:    cluster.totalRamMb,
    usedRamPct:    online.length ? online.reduce((s, n) => s + n.memPct, 0) / online.length : 0,
    totalVramMb:   cluster.totalVramMb,
    usedVramMb:    nodeStats.reduce((s, n) => s + n.vramUsedMb, 0),
    avgLatencyMs:  latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    nodes: nodeStats.map(({ online: _o, totalVramMb: _v, ...rest }) => rest),
  };
}
