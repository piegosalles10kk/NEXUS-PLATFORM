/**
 * benchmark.service.ts  (Sprint 17.4)
 *
 * Tier classification and DB persistence for node benchmark results.
 *
 * Tier thresholds (composite score):
 *   BRONZE   <  30  — basic commodity hardware
 *   SILVER   30–59  — mid-range, suitable for most workloads
 *   GOLD     60–89  — high-performance, suitable for AI inference
 *   PLATINUM ≥  90  — datacenter-grade, GPU-accelerated
 */

import prisma from '../config/database';
import { getAgentSocket } from './agent-ws.service';

export interface BenchmarkPayload {
  nodeId:             string;
  cpuGflops:          number;
  ramGbps:            number;
  storageIops:        number;
  gpuTflops:          number;
  meshLatencyMs:      number;
  meshBandwidthMbps:  number;
}

// ── Tier classifier ───────────────────────────────────────────────────────────

function computeComposite(p: Omit<BenchmarkPayload, 'nodeId'>): number {
  // Weighted composite out of 100+
  const cpuScore     = Math.min(p.cpuGflops * 2,       40);  // max 40 pts
  const ramScore     = Math.min(p.ramGbps * 5,          20);  // max 20 pts
  const storScore    = Math.min(p.storageIops / 2000,   15);  // max 15 pts
  const gpuScore     = Math.min(p.gpuTflops * 2,        20);  // max 20 pts
  const netScore     = Math.max(0, 5 - p.meshLatencyMs / 50); // 0-5 pts latency bonus

  return Math.round(cpuScore + ramScore + storScore + gpuScore + netScore);
}

function classifyTier(score: number): 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' {
  if (score >= 90) return 'PLATINUM';
  if (score >= 60) return 'GOLD';
  if (score >= 30) return 'SILVER';
  return 'BRONZE';
}

// ── Persist benchmark result ──────────────────────────────────────────────────

export async function saveBenchmarkResult(p: BenchmarkPayload): Promise<void> {
  const score = computeComposite(p);
  const tier  = classifyTier(score);

  await (prisma.nodeBenchmark as any).create({
    data: {
      nodeId:             p.nodeId,
      cpuGflops:          p.cpuGflops,
      ramGbps:            p.ramGbps,
      storageIops:        p.storageIops,
      gpuTflops:          p.gpuTflops,
      meshLatencyMs:      p.meshLatencyMs,
      meshBandwidthMbps:  p.meshBandwidthMbps,
      compositeScore:     score,
      tier,
    },
  });

  // Update denormalized fields on Node for fast dashboard queries
  await (prisma.node as any).update({
    where: { id: p.nodeId },
    data: {
      benchmarkScore:  score,
      benchmarkTier:   tier,
      lastBenchmarkAt: new Date(),
    },
  });
}

// ── Trigger benchmark on a connected agent ────────────────────────────────────

export async function triggerBenchmark(nodeId: string): Promise<boolean> {
  const ws = getAgentSocket(nodeId);
  if (!ws || ws.readyState !== 1 /* OPEN */) return false;

  ws.send(JSON.stringify({ type: 'run_benchmark', action: 'run_benchmark', nodeId }));
  return true;
}

// ── Trigger global stress test (NTP-synced fire) ──────────────────────────────

export interface StressTestOptions {
  durationSecs: number;
  jitterMaxMs:  number; // each agent adds random delay ≤ this before firing
  ntpEpochMs:   number; // absolute UTC ms — agents start at this exact moment
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

// ── Latest benchmark for a node ───────────────────────────────────────────────

export async function getLatestBenchmark(nodeId: string) {
  return (prisma.nodeBenchmark as any).findFirst({
    where:   { nodeId },
    orderBy: { createdAt: 'desc' },
  });
}

// ── List benchmarks for all nodes (ADM view) ──────────────────────────────────

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
