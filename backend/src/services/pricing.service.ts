/**
 * pricing.service.ts
 *
 * Nexus pricing engine — computes consumer costs and provider earnings.
 *
 * P_base(country) = P_aws_ref(country) × 0.50   (guaranteed 50 % discount)
 * P_final         = P_base × surgeMultiplier
 *
 * Base prices are resolved dynamically from market-watch.service so that if
 * AWS raises prices, Nexus prices rise proportionally — keeping the promise.
 *
 * The surge multiplier (1.0–3.0) is driven by the demand ratio computed in
 * scheduler.service and is the only lever that varies the final consumer price
 * after the deploy-time hedge is locked.
 */

import { getNexusBaseForCountry } from './market-watch.service';

// ── Re-export a US-baseline constant for UI components that don't know the
// node's country yet (e.g. BillingPage). Kept for backwards compatibility.
export const BASE = {
  cpuPerHour:   0.0208,   // us-east-1 reference × 0.50
  ramGbPerHour: 0.0052,
  gpuPerHour:   1.530,
  netGbTransit: 0.045,
} as const;

// ── WindowCost ────────────────────────────────────────────────────────────────

export interface WindowCost {
  cpuUsd:       number;
  ramUsd:       number;
  gpuUsd:       number;
  netUsd:       number;
  transitUsd:   number;
  totalUsd:     number;
  /** Effective surge multiplier applied */
  multiplier:   number;
}

export interface WindowUsage {
  /** Total CPU milliseconds consumed */
  cpuMs:                bigint;
  /** RAM megabyte-seconds consumed */
  ramMbS:               bigint;
  /** Bytes received by the workload */
  netRxBytes:           bigint;
  /** Bytes sent by the workload */
  netTxBytes:           bigint;
  /** GPU-milliseconds consumed (0 if no GPU) */
  gpuMs?:               bigint;
  /** Network transit bytes (separate from workload net I/O) */
  networkTransitBytes?: bigint;
  /** Provider node country (ISO-3166-1) */
  country?:             string | null;
  /** Surge / price multiplier from the demand engine */
  priceMultiplier?:     number;
}

/**
 * Computes the total cost for a billing window.
 * Base prices are fetched from market-watch (= P_aws × 0.50 per country).
 */
export function computeWindowCost(usage: WindowUsage): WindowCost {
  const base       = getNexusBaseForCountry(usage.country);
  const surge      = usage.priceMultiplier ?? 1.0;

  const cpuHours       = Number(usage.cpuMs)                          / 3_600_000;
  const ramGbHours     = Number(usage.ramMbS)                         / (1024 * 3600);
  const netGb          = Number(usage.netRxBytes + usage.netTxBytes)  / (1024 ** 3);
  const gpuHours       = Number(usage.gpuMs ?? 0n)                    / 3_600_000;
  const transitGb      = Number(usage.networkTransitBytes ?? 0n)      / (1024 ** 3);

  const cpuUsd     = cpuHours     * base.cpuPerHour    * surge;
  const ramUsd     = ramGbHours   * base.ramGbPerHour  * surge;
  const gpuUsd     = gpuHours     * base.gpuPerHour    * surge;
  const netUsd     = netGb        * base.netGbTransit  * surge;
  const transitUsd = transitGb    * base.netGbTransit  * surge;

  return {
    cpuUsd,
    ramUsd,
    gpuUsd,
    netUsd,
    transitUsd,
    totalUsd: cpuUsd + ramUsd + gpuUsd + netUsd + transitUsd,
    multiplier: surge,
  };
}

// ── Earnings preview (for ProviderPage UI) ────────────────────────────────────

export interface EarningsPreviewInput {
  maxCpuPercent:        number;   // 10–100
  maxRamMb:             number;   // up to node total RAM
  maxBandwidthMbps:     number;   // up to node uplink
  offerGpu:             boolean;
  maxGpuPercent:        number;
  offerNetworkTransit:  boolean;
  transitBandwidthMbps: number;
  country?:             string | null;
  surgeMultiplier?:     number;
}

/**
 * Returns estimated monthly provider earnings in USD at 60 % utilisation.
 * Uses country-specific base prices (= P_aws_local × 0.50) so providers in
 * high-cost regions (JP, AU) earn proportionally more.
 */
export function estimateMonthlyEarnings(input: EarningsPreviewInput): number {
  const HOURS_PER_MONTH = 24 * 30;
  const UTILISATION     = 0.60;
  const base  = getNexusBaseForCountry(input.country);
  const surge = input.surgeMultiplier ?? 1.0;

  const cpuVcpus   = input.maxCpuPercent / 100;
  const ramGb      = input.maxRamMb / 1024;
  // GB transferred per month at stated bandwidth × 60 % utilisation
  const netGbMonth = (input.transitBandwidthMbps / 8 / 1024) * 3600 * HOURS_PER_MONTH * UTILISATION;

  const cpuEarnings  = cpuVcpus * base.cpuPerHour    * surge * HOURS_PER_MONTH * UTILISATION;
  const ramEarnings  = ramGb    * base.ramGbPerHour  * surge * HOURS_PER_MONTH * UTILISATION;
  const gpuEarnings  = input.offerGpu
    ? (input.maxGpuPercent / 100) * base.gpuPerHour * surge * HOURS_PER_MONTH * UTILISATION
    : 0;
  const netEarnings  = input.offerNetworkTransit
    ? netGbMonth * base.netGbTransit * surge
    : 0;

  return cpuEarnings + ramEarnings + gpuEarnings + netEarnings;
}

// ── Per-GB transit earnings preview ──────────────────────────────────────────

/**
 * Returns the USD amount a provider earns per GB of transit traffic at the
 * current demand level. Used by the ProviderPage transit earnings counter.
 */
export function transitEarningsPerGb(opts: {
  country?:  string | null;
  surge?:    number;
}): number {
  const base = getNexusBaseForCountry(opts.country);
  return base.netGbTransit * (opts.surge ?? 1.0);
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
  const base = getNexusBaseForCountry(opts.country);
  const surge = opts.surge ?? 1.0;
  return (
    opts.cpuVcpus         * base.cpuPerHour    * surge +
    opts.ramGb            * base.ramGbPerHour  * surge +
    (opts.gpuUnits ?? 0)  * base.gpuPerHour    * surge
  );
}

// ── Regional multiplier helper (kept for UI components) ──────────────────────

export function getRegionalMultiplier(country?: string | null): number {
  // Expressed as the ratio between the country's Nexus price and the US baseline
  const local = getNexusBaseForCountry(country);
  const us    = getNexusBaseForCountry('US');
  return us.cpuPerHour > 0 ? local.cpuPerHour / us.cpuPerHour : 1.0;
}
