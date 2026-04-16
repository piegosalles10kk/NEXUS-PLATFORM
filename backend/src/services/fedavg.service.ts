/**
 * fedavg.service.ts — Sprint 21.2 (Federated Averaging) + Sprint 21.3 (Anti-Poisoning)
 *
 * Implements the server-side of the Federated Learning loop:
 *
 *   1. Agents POST gradient updates → ingestGradient()
 *   2. Anti-poisoning filter rejects statistical outliers (K-Means, Sprint 21.3)
 *   3. FedAvg aggregation averages accepted gradients → aggregateGradients()
 *   4. Master broadcasts updated global model to all agents
 *
 * The model is a lightweight logistic regression for ChurnRisk prediction:
 *   - 8 features (CPU%, RAM%, netRX, netTX, diskR, diskW, uptime, hourOfDay)
 *   - 1 output  (churn probability 0–1)
 *
 * This lives entirely in memory + Redis (no TSDB dependency).
 * Model persistence: saved to Redis key "nexus:ml:model".
 */

import { getRedisClient } from '../config/redis';

const NUM_FEATURES    = 8;
const MODEL_REDIS_KEY = 'nexus:ml:model';
const GRAD_REDIS_KEY  = 'nexus:ml:gradients';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GlobalModel {
  version:  number;
  weights:  number[]; // len = NUM_FEATURES
  bias:     number;
  updatedAt: string;
}

export interface GradientUpdate {
  nodeId:       string;
  modelVersion: number;
  weightDeltas: number[];
  biasDelta:    number;
  sampleCount:  number;
  computeMs:    number;
  timestamp:    string;
}

interface AggregationResult {
  success:      boolean;
  message:      string;
  model?:       GlobalModel;
  accepted:     number;
  rejected:     number;
  totalGradients: number;
}

// ── In-memory model cache ─────────────────────────────────────────────────────

let _model: GlobalModel = {
  version:   0,
  weights:   Array(NUM_FEATURES).fill(0),
  bias:      0,
  updatedAt: new Date().toISOString(),
};

/** Returns the current in-memory global model. */
export function getModel(): GlobalModel {
  return { ..._model, weights: [..._model.weights] };
}

// ── Gradient ingestion ────────────────────────────────────────────────────────

/**
 * ingestGradient — stores a single gradient update in Redis.
 * Returns false if the gradient is immediately rejected (wrong version, malformed).
 */
export async function ingestGradient(update: GradientUpdate): Promise<boolean> {
  if (!update.nodeId || update.weightDeltas.length !== NUM_FEATURES) {
    return false;
  }

  // Ignore gradients from outdated model versions (stale agent)
  if (update.modelVersion < _model.version - 2) {
    console.warn(`[fedavg] stale gradient from ${update.nodeId} (v${update.modelVersion} < v${_model.version - 2})`);
    return false;
  }

  try {
    const redis = await getRedisClient();
    await redis.rPush(GRAD_REDIS_KEY, JSON.stringify(update));
    // TTL: gradients expire after 24 hours if never aggregated
    await redis.expire(GRAD_REDIS_KEY, 86_400);
    return true;
  } catch (err) {
    console.error('[fedavg] ingestGradient error:', err);
    return false;
  }
}

export async function resetGradients(): Promise<void> {
  const redis = await getRedisClient();
  await redis.del(GRAD_REDIS_KEY);
}

// ── FedAvg Aggregation ────────────────────────────────────────────────────────

/**
 * aggregateGradients — runs one round of Federated Averaging.
 *
 * Algorithm:
 *   1. Load all pending gradients from Redis
 *   2. Run anti-poisoning filter (K-Means outlier detection, Sprint 21.3)
 *   3. Weighted average of accepted gradients (weight = sampleCount)
 *   4. Apply averaged delta to global model
 *   5. Save updated model to Redis + clear pending gradients
 */
export async function aggregateGradients(): Promise<AggregationResult> {
  const redis   = await getRedisClient();
  const rawList = await redis.lRange(GRAD_REDIS_KEY, 0, -1);

  if (rawList.length === 0) {
    return { success: false, message: 'No gradients pending aggregation.', accepted: 0, rejected: 0, totalGradients: 0 };
  }

  const gradients: GradientUpdate[] = rawList
    .map(r => { try { return JSON.parse(r) as GradientUpdate; } catch { return null; } })
    .filter(Boolean) as GradientUpdate[];

  if (gradients.length < 2) {
    return { success: false, message: `Need ≥ 2 gradients; got ${gradients.length}.`, accepted: 0, rejected: 0, totalGradients: gradients.length };
  }

  // Sprint 21.3 — Anti-poisoning filter
  const { accepted, rejected } = antiPoisoningFilter(gradients);

  if (accepted.length === 0) {
    return { success: false, message: 'All gradients rejected by anti-poisoning filter.', accepted: 0, rejected: rejected.length, totalGradients: gradients.length };
  }

  // Federated averaging (weighted by sampleCount)
  const totalSamples = accepted.reduce((s, g) => s + g.sampleCount, 0);
  const avgWeights   = Array(NUM_FEATURES).fill(0) as number[];
  let   avgBias      = 0;

  for (const g of accepted) {
    const w = g.sampleCount / totalSamples;
    for (let i = 0; i < NUM_FEATURES; i++) {
      avgWeights[i] += w * (g.weightDeltas[i] ?? 0);
    }
    avgBias += w * g.biasDelta;
  }

  // Apply delta to current model (gradient descent step)
  const newWeights = _model.weights.map((w, i) => w - avgWeights[i]);
  const newBias    = _model.bias - avgBias;

  _model = {
    version:   _model.version + 1,
    weights:   newWeights,
    bias:      newBias,
    updatedAt: new Date().toISOString(),
  };

  // Persist to Redis
  await redis.set(MODEL_REDIS_KEY, JSON.stringify(_model));
  await redis.del(GRAD_REDIS_KEY);

  console.log(`[fedavg] round complete — v${_model.version} accepted=${accepted.length} rejected=${rejected.length}`);

  return {
    success:        true,
    message:        `FedAvg round ${_model.version} complete.`,
    model:          getModel(),
    accepted:       accepted.length,
    rejected:       rejected.length,
    totalGradients: gradients.length,
  };
}

// ── Sprint 21.3 — Anti-Poisoning (K-Means outlier detection) ─────────────────

/**
 * antiPoisoningFilter uses K-Means (k=2) to split gradients into two clusters:
 * "normal" and "outlier". The smaller, more distant cluster is rejected.
 *
 * Detection logic:
 *   - Compute L2 norm of each gradient's weightDeltas vector
 *   - Run K-Means k=2 on the norms
 *   - Identify the "outlier" cluster as the one with fewer gradients OR
 *     the one whose centroid is statistically far from the majority centroid
 *     (using a 3-sigma rule on the inter-cluster distance)
 *   - Reject gradients in the outlier cluster
 */
function antiPoisoningFilter(gradients: GradientUpdate[]): {
  accepted: GradientUpdate[];
  rejected: GradientUpdate[];
} {
  if (gradients.length < 4) {
    // Not enough data for K-Means — accept all
    return { accepted: gradients, rejected: [] };
  }

  // Feature: L2 norm of weight deltas per gradient
  const norms = gradients.map(g =>
    Math.sqrt(g.weightDeltas.reduce((s, w) => s + w * w, 0))
  );

  // K-Means k=2, 1D (on norm values)
  const { labels, centroids } = kMeans1D(norms, 2);

  // Decide which cluster is "normal" (larger cluster = normal behavior)
  const counts = [0, 0];
  labels.forEach(l => counts[l]++);
  const normalCluster  = counts[0] >= counts[1] ? 0 : 1;
  const outlierCluster = 1 - normalCluster;

  // 3-sigma check: only reject if outlier centroid is far enough from normal
  const centroidDist = Math.abs(centroids[0] - centroids[1]);
  const normalNorms  = norms.filter((_, i) => labels[i] === normalCluster);
  const mean         = normalNorms.reduce((s, v) => s + v, 0) / normalNorms.length;
  const std          = Math.sqrt(normalNorms.reduce((s, v) => s + (v - mean) ** 2, 0) / normalNorms.length);

  // Only apply filter if outlier cluster centroid is > 3σ away
  const shouldFilter = centroidDist > 3 * std && std > 0;

  const accepted: GradientUpdate[] = [];
  const rejected: GradientUpdate[] = [];

  gradients.forEach((g, i) => {
    if (shouldFilter && labels[i] === outlierCluster) {
      console.warn(`[fedavg] anti-poison: rejecting gradient from ${g.nodeId} (norm=${norms[i].toFixed(4)})`);
      rejected.push(g);
    } else {
      accepted.push(g);
    }
  });

  return { accepted, rejected };
}

/**
 * kMeans1D — simple 1-dimensional K-Means with k=2, 50 iterations max.
 * Returns cluster labels and final centroids.
 */
function kMeans1D(data: number[], k: number): { labels: number[]; centroids: number[] } {
  // Init centroids: pick min and max
  let centroids = [Math.min(...data), Math.max(...data)];
  let labels    = new Array(data.length).fill(0);

  for (let iter = 0; iter < 50; iter++) {
    // Assignment step
    const newLabels = data.map(x => {
      const dists = centroids.map(c => Math.abs(x - c));
      return dists[0] <= dists[1] ? 0 : 1;
    });

    // Update step
    const newCentroids = Array.from({ length: k }, (_, ki) => {
      const cluster = data.filter((_, i) => newLabels[i] === ki);
      if (cluster.length === 0) return centroids[ki];
      return cluster.reduce((s, v) => s + v, 0) / cluster.length;
    });

    // Convergence check
    const moved = newCentroids.some((c, i) => Math.abs(c - centroids[i]) > 1e-6);
    labels    = newLabels;
    centroids = newCentroids;
    if (!moved) break;
  }

  return { labels, centroids };
}

// ── Bootstrap: load persisted model on startup ────────────────────────────────

(async () => {
  try {
    const redis  = await getRedisClient();
    const stored = await redis.get(MODEL_REDIS_KEY);
    if (stored) {
      _model = JSON.parse(stored) as GlobalModel;
      console.log(`[fedavg] loaded model v${_model.version} from Redis`);
    }
  } catch {
    // Redis not available yet — use default zero model
  }
})();
