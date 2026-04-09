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

/**
 * Derives a unique /24 mesh subnet for an app using the first 4 hex chars
 * of its UUID.  Range: 10.51.0.0/24 → 10.150.255.0/24 (25 600 unique subnets).
 */
function appMeshSubnet(appId: string): { subnet: string; base: string } {
  const hex = appId.replace(/-/g, '');
  const b2  = parseInt(hex.slice(0, 2), 16) % 100; // 0-99  → 10.(51-150).x.0/24
  const b3  = parseInt(hex.slice(2, 4), 16);         // 0-255
  const base   = `10.${51 + b2}.${b3}`;
  const subnet = `${base}.0/24`;
  return { subnet, base };
}

/** Returns mesh IP addresses for cluster members using the given base (e.g. "10.51.42"). */
function allocateMeshIps(count: number, base: string): string[] {
  // Start at .2 — .1 is reserved for the virtual gateway
  return Array.from({ length: count }, (_, i) => `${base}.${i + 2}`);
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

  // Placeholder IPs — overridden with app-specific subnet in createCluster()
  const meshIps = allocateMeshIps(selected.length, '10.50.0');

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
    meshSubnet:    '10.50.0.0/24', // placeholder — replaced in createCluster()
    proximityTier: tier,
  };
}

// ── Persist cluster to DB ─────────────────────────────────────────────────────

export async function createCluster(appId: string, plan: ClusterPlan) {
  // Generate a unique /24 subnet for this cluster using the app UUID
  const { subnet: meshSubnet, base: meshBase } = appMeshSubnet(appId);
  const assignedIps = allocateMeshIps(plan.nodes.length, meshBase);

  // Re-assign mesh IPs using the app-specific subnet
  const nodes = plan.nodes.map((n, i) => ({ ...n, meshIp: assignedIps[i] }));

  return prisma.$transaction(async (tx) => {
    const cluster = await (tx.resourceCluster as any).create({
      data: {
        appId,
        totalVramMb:   plan.totalVramMb,
        totalRamMb:    plan.totalRamMb,
        totalCpuCores: plan.totalCpuCores,
        meshSubnet,
        status:        'FORMING',
        members: {
          create: nodes.map(n => ({
            nodeId: n.nodeId,
            meshIp: n.meshIp,
            role:   n.role,
          })),
        },
      },
      include: { members: true },
    });

    // Stamp meshIp onto each Node for quick lookup
    for (const n of nodes) {
      await (tx.node as any).update({
        where: { id: n.nodeId },
        data:  { meshIp: n.meshIp },
      });
    }

    return cluster;
  });
}

// ── Sprint 13.3: Hardware Fragmenter — distributeWorkload() ─────────────────

export interface NodeAllocation {
  nodeId:        string;
  meshIp:        string;
  role:          'LEADER' | 'WORKER';
  rank:          number;
  cpuMillicores: number; // vCPUs × 1000; enforced via --cpus flag
  memLimitMb:    number; // enforced via --memory flag
  vramLimitMb:   number; // > 0 → --gpus all + NCCL env injected
  masterMeshIp:  string;
  worldSize:     number;
  peers:         { meshIp: string; rank: number }[];
}

export interface WorkloadDistribution {
  allocations:        NodeAllocation[];
  masterMeshIp:       string;
  worldSize:          number;
  totalAllocatedCpu:  number; // vCPUs
  totalAllocatedRam:  number; // MB
  totalAllocatedVram: number; // MB
}

/**
 * Slices the requested CPU/RAM/VRAM across cluster nodes proportionally to
 * each node's raw hardware capacity.  Each node receives an exact budget
 * enforced by Docker cgroup flags (--cpus, --memory, --gpus).
 *
 * @param plan        - The cluster plan from planCluster()
 * @param requested   - What the tenant actually needs in total
 * @param appType     - "AI" triggers NCCL / Ray / DeepSpeed env injection
 */
export function distributeWorkload(
  plan: ClusterPlan,
  requested: { cpuCores: number; ramMb: number; vramMb: number },
  appType: string = '',
): WorkloadDistribution {
  const nodes = plan.nodes;
  if (nodes.length === 0) throw new Error('Cannot distribute across empty cluster.');

  const totalCpu  = nodes.reduce((s, n) => s + n.cpuCores, 0);
  const totalRam  = nodes.reduce((s, n) => s + n.ramMb, 0);
  const totalVram = nodes.reduce((s, n) => s + (n.gpuMemoryMb ?? 0) * n.gpuCount, 0);

  const masterMeshIp = nodes[0].meshIp; // LEADER = rank 0

  const allocations: NodeAllocation[] = nodes.map((n, i) => {
    const cpuShare  = totalCpu  > 0 ? (n.cpuCores / totalCpu)  * requested.cpuCores : 0;
    const ramShare  = totalRam  > 0 ? (n.ramMb    / totalRam)  * requested.ramMb    : 0;
    const nodeVram  = (n.gpuMemoryMb ?? 0) * n.gpuCount;
    const vramShare = totalVram > 0 ? (nodeVram   / totalVram) * requested.vramMb   : 0;

    return {
      nodeId:        n.nodeId,
      meshIp:        n.meshIp,
      role:          n.role,
      rank:          i,
      // minimum 100 millicores / 512 MB to avoid starving the container
      cpuMillicores: Math.max(100, Math.round(cpuShare * 1000)),
      memLimitMb:    Math.max(512, Math.round(ramShare)),
      vramLimitMb:   Math.round(vramShare),
      masterMeshIp,
      worldSize:     nodes.length,
      peers: nodes
        .filter((_, j) => j !== i)
        .map((p, j) => ({ meshIp: p.meshIp, rank: j < i ? j : j + 1 })),
    };
  });

  return {
    allocations,
    masterMeshIp,
    worldSize:           nodes.length,
    totalAllocatedCpu:   allocations.reduce((s, a) => s + a.cpuMillicores / 1000, 0),
    totalAllocatedRam:   allocations.reduce((s, a) => s + a.memLimitMb, 0),
    totalAllocatedVram:  allocations.reduce((s, a) => s + a.vramLimitMb, 0),
  };
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
