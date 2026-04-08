/**
 * pricing.service.ts
 *
 * Nexus base price table — 50 % below the AWS equivalent for every resource
 * category. Prices are in USD and expressed per natural unit per hour (or per GB).
 *
 * Comparison baseline (AWS on-demand, 2025):
 *   CPU  : ~$0.096 /vCPU-hr  (t3.medium equivalent)
 *   RAM  : ~$0.012 /GB-hr
 *   GPU  : ~$0.526 /GPU-hr   (p3.2xlarge / V100 equivalent)
 *   Net  : ~$0.090 /GB out
 *
 * Nexus base (50 % discount):
 *   CPU  : $0.048 /vCPU-hr
 *   RAM  : $0.006 /GB-hr
 *   GPU  : $0.263 /GPU-hr
 *   Net  : $0.045 /GB
 *
 * Regional multipliers keep Nexus cheaper than AWS IN EVERY REGION while still
 * compensating local providers for higher energy / tax costs.
 * Example: AWS São Paulo = 1.55× US → Nexus BR = 0.90× US baseline = still
 * ~42 % cheaper than the cheapest AWS option in BR.
 */

// ── Base prices (USD, per unit, per hour / per GB) ────────────────────────────

export const BASE = {
  /** per vCPU-hour */
  cpuPerHour:   0.048,
  /** per GB-RAM-hour */
  ramGbPerHour: 0.006,
  /** per GPU-hour (NVIDIA equivalent) */
  gpuPerHour:   0.263,
  /** per GB transferred (in+out) through a transit node */
  netGbTransit: 0.045,
} as const;

// ── Regional multipliers ──────────────────────────────────────────────────────
// Keyed by ISO-3166-1 alpha-2 country code (upper-case).
// Missing country → falls back to 1.00 (US baseline).

const REGIONAL: Record<string, number> = {
  US: 1.00,
  CA: 1.03,
  BR: 0.90,   // cheaper than AWS-SP (1.55×) while still competitive
  AR: 0.85,
  MX: 0.88,
  GB: 1.08,
  DE: 1.07,
  FR: 1.07,
  NL: 1.06,
  IE: 1.05,
  SE: 1.06,
  JP: 1.18,
  KR: 1.15,
  SG: 1.12,
  AU: 1.14,
  IN: 0.82,
  ZA: 0.88,
};

/**
 * Returns the regional multiplier for a given ISO-3166-1 country code.
 * Falls back to 1.0 for unknown regions.
 */
export function getRegionalMultiplier(country?: string | null): number {
  if (!country) return 1.0;
  return REGIONAL[country.toUpperCase()] ?? 1.0;
}

// ── Compute price for a billing window ───────────────────────────────────────

export interface WindowCost {
  cpuUsd:     number;
  ramUsd:     number;
  gpuUsd:     number;
  netUsd:     number;
  totalUsd:   number;
  /** The effective multiplier applied (regional × surge) */
  multiplier: number;
}

export interface WindowUsage {
  /** Total CPU milliseconds consumed */
  cpuMs:        bigint;
  /** RAM megabyte-seconds consumed */
  ramMbS:       bigint;
  /** Bytes received by the workload */
  netRxBytes:   bigint;
  /** Bytes sent by the workload */
  netTxBytes:   bigint;
  /** GPU-milliseconds consumed (0 if no GPU) */
  gpuMs?:       bigint;
  /** Provider node country (ISO-3166-1) */
  country?:     string | null;
  /** Surge / price multiplier from the AI classifier */
  priceMultiplier?: number;
}

export function computeWindowCost(usage: WindowUsage): WindowCost {
  const regional   = getRegionalMultiplier(usage.country);
  const surge      = usage.priceMultiplier ?? 1.0;
  const multiplier = regional * surge;

  // Convert raw units → billing units
  const cpuHours   = Number(usage.cpuMs)    / 3_600_000;
  const ramGbHours = Number(usage.ramMbS)   / (1024 * 3600);
  const netGb      = Number(usage.netRxBytes + usage.netTxBytes) / (1024 ** 3);
  const gpuHours   = Number(usage.gpuMs ?? 0n) / 3_600_000;

  const cpuUsd  = cpuHours   * BASE.cpuPerHour   * multiplier;
  const ramUsd  = ramGbHours * BASE.ramGbPerHour  * multiplier;
  const gpuUsd  = gpuHours   * BASE.gpuPerHour    * multiplier;
  const netUsd  = netGb      * BASE.netGbTransit  * multiplier;

  return {
    cpuUsd,
    ramUsd,
    gpuUsd,
    netUsd,
    totalUsd: cpuUsd + ramUsd + gpuUsd + netUsd,
    multiplier,
  };
}

// ── Earnings preview (for ProviderPage UI) ────────────────────────────────────

export interface EarningsPreviewInput {
  maxCpuPercent:       number;   // 10–100
  maxRamMb:            number;   // up to node total
  maxBandwidthMbps:    number;   // up to node uplink
  offerGpu:            boolean;
  maxGpuPercent:       number;
  offerNetworkTransit: boolean;
  transitBandwidthMbps:number;
  country?:            string | null;
  surgeMultiplier?:    number;
}

/**
 * Returns an estimated monthly earnings in USD assuming the node is busy
 * 60 % of the time (conservative DePIN utilisation assumption).
 */
export function estimateMonthlyEarnings(input: EarningsPreviewInput): number {
  const HOURS_PER_MONTH = 24 * 30;
  const UTILISATION     = 0.60; // 60 % busy
  const regional        = getRegionalMultiplier(input.country);
  const surge           = input.surgeMultiplier ?? 1.0;
  const mult            = regional * surge;

  // vCPU fraction offered (1 vCPU = 100 %)
  const cpuVcpus   = input.maxCpuPercent / 100;
  const ramGb      = input.maxRamMb / 1024;
  const netGbMonth = (input.transitBandwidthMbps / 8 / 1024) * 3600 * HOURS_PER_MONTH * UTILISATION;

  const cpuEarnings  = cpuVcpus * BASE.cpuPerHour   * mult * HOURS_PER_MONTH * UTILISATION;
  const ramEarnings  = ramGb    * BASE.ramGbPerHour  * mult * HOURS_PER_MONTH * UTILISATION;
  const gpuEarnings  = input.offerGpu
    ? (input.maxGpuPercent / 100) * BASE.gpuPerHour * mult * HOURS_PER_MONTH * UTILISATION
    : 0;
  const netEarnings  = input.offerNetworkTransit ? netGbMonth * BASE.netGbTransit * mult : 0;

  return cpuEarnings + ramEarnings + gpuEarnings + netEarnings;
}

// ── Consumer price estimate (for deploy UI) ───────────────────────────────────

/**
 * Returns the live hourly price a consumer pays for a given resource slice.
 * Used by SurgePricingBadge and the deploy flow.
 */
export function consumerHourlyPrice(opts: {
  cpuVcpus:    number;
  ramGb:       number;
  gpuUnits?:   number;
  country?:    string | null;
  surge?:      number;
}): number {
  const mult = getRegionalMultiplier(opts.country) * (opts.surge ?? 1.0);
  return (
    opts.cpuVcpus  * BASE.cpuPerHour   * mult +
    opts.ramGb     * BASE.ramGbPerHour * mult +
    (opts.gpuUnits ?? 0) * BASE.gpuPerHour * mult
  );
}
