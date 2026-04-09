/**
 * benchmark.service.ts  (Sprint 17.4 + 17.5)
 *
 * Tier classification with InfraType-aware scoring:
 *
 *   SWARM nodes (DePIN community hardware):
 *     Raw scores — these are commodity machines, every point counts.
 *     No adjustments — results are taken at face value.
 *
 *   CLOUD_MANAGED (Nexus-owned physical servers):
 *     +10 bonus — datacenter-grade power, reliable uptime SLA.
 *     Higher baseline expected; benchmark mainly tracks degradation.
 *
 *   ON_PREMISE (enterprise on-prem):
 *     +5 bonus — managed environments with dedicated I/O, but variable quality.
 *
 * Final thresholds (after infraType bonus applied):
 *   BRONZE   <  30  — basic commodity hardware
 *   SILVER   30–59  — mid-range, suitable for most workloads
 *   GOLD     60–89  — high-performance, suitable for AI inference
 *   PLATINUM ≥  90  — datacenter-grade, GPU-accelerated
 *
 * Auto-Limpeza Cron (Task 17.5):
 *   Runs every 24 h.  Triggers silent benchmarks on all connected nodes.
 *   If a node's new score drops > 20 pts from its previous best, the node
 *   is flagged DEGRADED (its tier drops one level) — surfaced in the Sentinel UI.
 */

import prisma from '../config/database';
import { getAgentSocket, getConnectedNodeIds } from './agent-ws.service';

export type InfraType = 'SWARM' | 'CLOUD_MANAGED' | 'ON_PREMISE';

export interface BenchmarkPayload {
  nodeId:             string;
  cpuGflops:          number;
  ramGbps:            number;
  storageIops:        number;
  gpuTflops:          number;
  meshLatencyMs:      number;
  meshBandwidthMbps:  number;
  infraType?:         InfraType; // fetched from DB if omitted
}

// ── Scoring constants per InfraType ──────────────────────────────────────────

const INFRA_BONUS: Record<InfraType, number> = {
  SWARM:         0,   // raw score — every point earned on commodity hardware
  ON_PREMISE:    5,   // managed environment with dedicated I/O
  CLOUD_MANAGED: 10,  // datacenter-grade; high baseline expected
};

// ── Tier classifier ───────────────────────────────────────────────────────────

function computeComposite(
  p: Omit<BenchmarkPayload, 'nodeId'>,
  infraType: InfraType,
): number {
  // Weighted composite out of 100+
  const cpuScore  = Math.min(p.cpuGflops * 2,        40);  // max 40 pts
  const ramScore  = Math.min(p.ramGbps * 5,           20);  // max 20 pts
  const storScore = Math.min(p.storageIops / 2000,    15);  // max 15 pts
  const gpuScore  = Math.min(p.gpuTflops * 2,         20);  // max 20 pts
  // Mesh: lower latency → more points; 0 ms ≡ 5 pts, ≥ 250 ms ≡ 0 pts
  const netScore  = Math.max(0, 5 - p.meshLatencyMs / 50);

  const raw   = cpuScore + ramScore + storScore + gpuScore + netScore;
  const bonus = INFRA_BONUS[infraType] ?? 0;
  return Math.round(raw + bonus);
}

function classifyTier(score: number): 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' {
  if (score >= 90) return 'PLATINUM';
  if (score >= 60) return 'GOLD';
  if (score >= 30) return 'SILVER';
  return 'BRONZE';
}

// ── Persist benchmark result ──────────────────────────────────────────────────

export async function saveBenchmarkResult(p: BenchmarkPayload): Promise<void> {
  // Fetch infraType from DB if not provided
  let infraType: InfraType = p.infraType ?? 'SWARM';
  if (!p.infraType) {
    const node = await (prisma.node as any).findUnique({
      where:  { id: p.nodeId },
      select: { infraType: true, benchmarkScore: true },
    });
    infraType = node?.infraType ?? 'SWARM';

    // Auto-Limpeza degradation check:
    // If new raw score drops > 20 pts from previous best → flag degraded
    const prevScore: number = node?.benchmarkScore ?? 0;
    const rawNew = computeComposite(p, 'SWARM'); // raw comparison, no bonus
    if (prevScore > 30 && rawNew < prevScore - 20) {
      console.warn(
        `[benchmark] Node ${p.nodeId} DEGRADED: score ${prevScore} → ${rawNew} ` +
        `(delta=${rawNew - prevScore}). Flagging for review.`,
      );
      // Emit via Socket.io so Sentinel sees it immediately
      const { getIo } = await import('./agent-ws.service');
      getIo()?.emit('sentinel:node_degraded', {
        nodeId:    p.nodeId,
        prevScore,
        newScore:  rawNew,
        delta:     rawNew - prevScore,
      });
    }
  }

  const score = computeComposite(p, infraType);
  const tier  = classifyTier(score);

  await (prisma.nodeBenchmark as any).create({
    data: {
      nodeId:            p.nodeId,
      cpuGflops:         p.cpuGflops,
      ramGbps:           p.ramGbps,
      storageIops:       p.storageIops,
      gpuTflops:         p.gpuTflops,
      meshLatencyMs:     p.meshLatencyMs,
      meshBandwidthMbps: p.meshBandwidthMbps,
      compositeScore:    score,
      tier,
    },
  });

  await (prisma.node as any).update({
    where: { id: p.nodeId },
    data:  { benchmarkScore: score, benchmarkTier: tier, lastBenchmarkAt: new Date() },
  });
}

// ── Trigger benchmark on a single connected agent ─────────────────────────────

export async function triggerBenchmark(nodeId: string): Promise<boolean> {
  const ws = getAgentSocket(nodeId);
  if (!ws || ws.readyState !== 1 /* OPEN */) return false;
  ws.send(JSON.stringify({ type: 'run_benchmark', action: 'run_benchmark', nodeId }));
  return true;
}

// ── Auto-Limpeza: silent daily benchmark sweep ────────────────────────────────

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the daily Auto-Limpeza cron.
 * Triggers silent benchmarks on every connected node.
 * Results flow back via `benchmark_result` agent message → saveBenchmarkResult()
 * which runs the degradation check automatically.
 *
 * Called once from app.ts startup.
 */
export function startAutoCleanupCron(): void {
  if (_cleanupTimer) return; // guard against double-start

  const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  const runSweep = async () => {
    const nodeIds = getConnectedNodeIds();
    if (nodeIds.length === 0) return;

    console.log(`[benchmark] Auto-Limpeza: dispatching silent benchmarks to ${nodeIds.length} nodes`);

    // Stagger dispatches by 500 ms each to avoid thundering-herd on master
    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i];
      setTimeout(() => {
        const ws = getAgentSocket(nodeId);
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({
            type:   'run_benchmark',
            action: 'run_benchmark',
            nodeId,
            silent: true, // hint to agent: don't show in local logs
          }));
        }
      }, i * 500);
    }
  };

  // Run first sweep after 60 s (let agents reconnect on startup)
  setTimeout(runSweep, 60_000);

  // Then repeat every 24 h
  _cleanupTimer = setInterval(runSweep, RUN_INTERVAL_MS);

  console.log('[benchmark] Auto-Limpeza cron started (interval: 24 h)');
}

// ── Trigger global stress test (NTP-synced) ───────────────────────────────────

export interface StressTestOptions {
  durationSecs: number;
  jitterMaxMs:  number;
  ntpEpochMs:   number;
}

export async function triggerGlobalStressTest(
  opts: StressTestOptions,
  connectedNodeIds: string[],
): Promise<number> {
  let dispatched = 0;
  for (const nodeId of connectedNodeIds) {
    const ws = getAgentSocket(nodeId);
    if (!ws || ws.readyState !== 1) continue;
    ws.send(JSON.stringify({
      type:         'stress_test',
      action:       'stress_test',
      ntpEpochMs:   opts.ntpEpochMs,
      durationSecs: opts.durationSecs,
      jitterMaxMs:  opts.jitterMaxMs,
    }));
    dispatched++;
  }
  return dispatched;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getLatestBenchmark(nodeId: string) {
  return (prisma.nodeBenchmark as any).findFirst({
    where:   { nodeId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listNodeBenchmarks() {
  return (prisma.node as any).findMany({
    select: {
      id: true, name: true, status: true, infraType: true,
      benchmarkTier: true, benchmarkScore: true, lastBenchmarkAt: true,
      country: true, cpuCores: true, ramMb: true, gpuCount: true, gpuModel: true,
    },
    orderBy: { benchmarkScore: 'desc' },
  });
}
