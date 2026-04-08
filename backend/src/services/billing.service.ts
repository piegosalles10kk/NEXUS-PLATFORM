/**
 * billing.service.ts
 *
 * Proof of Computing — tracks resource consumption per workload per node.
 *
 * Agents send periodic usage reports via the WS tunnel:
 *   { type: "usage_report", appId, cpuMs, ramMbS, netRxBytes, netTxBytes, windowStart, windowEnd }
 *
 * This service persists those reports and provides aggregation queries
 * for client invoicing and provider credit calculation.
 *
 * Pricing defaults (overridable via SystemSetting):
 *   cpu_price_per_ms      = 0.000_000_01  USD
 *   ram_price_per_mb_s    = 0.000_000_02  USD
 *   egress_price_per_byte = 0.000_000_001 USD
 *   platform_commission   = 0.20 (20%)
 */
import prisma from '../config/database';

// ── Price table ───────────────────────────────────────────────────────────────

const DEFAULT_PRICES = {
  cpuPerMs:          0.00000001,
  ramPerMbS:         0.00000002,
  egressPerByte:     0.000000001,
  platformCommission: 0.20,
};

async function getPrices() {
  try {
    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: ['cpu_price_per_ms', 'ram_price_per_mb_s', 'egress_price_per_byte', 'platform_commission'] } },
    });
    const map = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, parseFloat(s.value)]));
    return {
      cpuPerMs:          map['cpu_price_per_ms']       ?? DEFAULT_PRICES.cpuPerMs,
      ramPerMbS:         map['ram_price_per_mb_s']     ?? DEFAULT_PRICES.ramPerMbS,
      egressPerByte:     map['egress_price_per_byte']  ?? DEFAULT_PRICES.egressPerByte,
      platformCommission: map['platform_commission']   ?? DEFAULT_PRICES.platformCommission,
    };
  } catch {
    return DEFAULT_PRICES;
  }
}

// ── Ingest usage from agent ───────────────────────────────────────────────────

export interface AgentUsageReport {
  appId:       string;
  nodeId:      string;
  cpuMs:       number;
  ramMbS:      number;
  netRxBytes:  number;
  netTxBytes:  number;
  windowStart: string; // ISO-8601
  windowEnd:   string; // ISO-8601
}

export async function recordUsage(report: AgentUsageReport): Promise<void> {
  await prisma.usageRecord.create({
    data: {
      appId:       report.appId,
      nodeId:      report.nodeId,
      cpuMs:       BigInt(Math.round(report.cpuMs)),
      ramMbS:      BigInt(Math.round(report.ramMbS)),
      netRxBytes:  BigInt(Math.round(report.netRxBytes)),
      netTxBytes:  BigInt(Math.round(report.netTxBytes)),
      windowStart: new Date(report.windowStart),
      windowEnd:   new Date(report.windowEnd),
    },
  });
}

// ── Aggregation queries ───────────────────────────────────────────────────────

export interface UsageSummary {
  appId:        string;
  cpuMs:        bigint;
  ramMbS:       bigint;
  netRxBytes:   bigint;
  netTxBytes:   bigint;
  totalCostUsd: number;
}

export async function getAppUsage(
  appId: string,
  from: Date,
  to: Date,
): Promise<UsageSummary> {
  const records = await prisma.usageRecord.findMany({
    where: { appId, windowStart: { gte: from }, windowEnd: { lte: to } },
  });

  const cpuMs      = records.reduce((s: bigint, r: { cpuMs: bigint })     => s + r.cpuMs,      BigInt(0));
  const ramMbS     = records.reduce((s: bigint, r: { ramMbS: bigint })    => s + r.ramMbS,     BigInt(0));
  const netRxBytes = records.reduce((s: bigint, r: { netRxBytes: bigint })=> s + r.netRxBytes,  BigInt(0));
  const netTxBytes = records.reduce((s: bigint, r: { netTxBytes: bigint })=> s + r.netTxBytes,  BigInt(0));

  const prices = await getPrices();
  const totalCostUsd =
    Number(cpuMs)      * prices.cpuPerMs +
    Number(ramMbS)     * prices.ramPerMbS +
    Number(netTxBytes) * prices.egressPerByte; // egress = outbound

  return { appId, cpuMs, ramMbS, netRxBytes, netTxBytes, totalCostUsd };
}

export interface NodeEarnings {
  nodeId:      string;
  cpuMs:       bigint;
  ramMbS:      bigint;
  netTxBytes:  bigint;
  grossUsd:    number;
  netUsd:      number; // after platform commission
}

export async function getNodeEarnings(
  nodeId: string,
  from: Date,
  to: Date,
): Promise<NodeEarnings> {
  const records = await prisma.usageRecord.findMany({
    where: { nodeId, windowStart: { gte: from }, windowEnd: { lte: to } },
  });

  const cpuMs     = records.reduce((s: bigint, r: { cpuMs: bigint })     => s + r.cpuMs,      BigInt(0));
  const ramMbS    = records.reduce((s: bigint, r: { ramMbS: bigint })    => s + r.ramMbS,     BigInt(0));
  const netTxBytes= records.reduce((s: bigint, r: { netTxBytes: bigint })=> s + r.netTxBytes,  BigInt(0));

  const prices = await getPrices();
  const grossUsd =
    Number(cpuMs)      * prices.cpuPerMs +
    Number(ramMbS)     * prices.ramPerMbS +
    Number(netTxBytes) * prices.egressPerByte;

  const netUsd = grossUsd * (1 - prices.platformCommission);

  return { nodeId, cpuMs, ramMbS, netTxBytes, grossUsd, netUsd };
}
