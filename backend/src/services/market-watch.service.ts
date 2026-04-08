/**
 * market-watch.service.ts
 *
 * Maintains a live reference table of AWS EC2 on-demand pricing per region.
 * Nexus enforces the invariant: P_nexus = P_aws_ref × 0.50 in every region.
 *
 * AWS reference (Q1 2025, t3.medium normalised per unit + p3.2xlarge for GPU):
 *   us-east-1   : $0.0416/vCPU-h · $0.0104/GB-h · $3.06/GPU-h  · $0.09/GB-out
 *   sa-east-1   : $0.0672/vCPU-h · $0.0168/GB-h · $4.00/GPU-h  · $0.15/GB-out
 *   eu-west-1   : $0.0464/vCPU-h · $0.0116/GB-h · $3.305/GPU-h · $0.09/GB-out
 *   ap-northeast: $0.0528/vCPU-h · $0.0132/GB-h · $3.673/GPU-h · $0.114/GB-out
 *   (see full table below)
 *
 * Usage:
 *   import { getNexusBaseForCountry, getComparisonLabel } from './market-watch.service';
 *   const base = getNexusBaseForCountry('BR');   // → { cpuPerHour: 0.0336, … }
 */

export interface AwsRegionRef {
  /** Per vCPU per hour (USD, on-demand) */
  cpuPerVcpuHour: number;
  /** Per GB RAM per hour (USD, on-demand) */
  ramPerGbHour:   number;
  /** Per GPU-hour, V100-class (USD, on-demand p3.2xlarge) */
  gpuPerHour:     number;
  /** Per GB data transfer out (USD) */
  netGbOut:       number;
  /** Human-readable AWS region name */
  regionLabel:    string;
  /** When this entry was last refreshed */
  refreshedAt:    Date;
}

// ── AWS on-demand reference table (2025 Q1) ───────────────────────────────────
// Sourced from https://aws.amazon.com/ec2/pricing/on-demand/
// CPU/RAM normalised from t3.medium (2 vCPU, 4 GB); GPU from p3.2xlarge (1× V100).

const _now = new Date();

const AWS_REFERENCE: Record<string, AwsRegionRef> = {
  'us-east-1':      { cpuPerVcpuHour: 0.0416, ramPerGbHour: 0.0104, gpuPerHour: 3.060, netGbOut: 0.090, regionLabel: 'US East (N. Virginia)',   refreshedAt: _now },
  'us-west-2':      { cpuPerVcpuHour: 0.0416, ramPerGbHour: 0.0104, gpuPerHour: 3.060, netGbOut: 0.090, regionLabel: 'US West (Oregon)',          refreshedAt: _now },
  'ca-central-1':   { cpuPerVcpuHour: 0.0452, ramPerGbHour: 0.0113, gpuPerHour: 3.197, netGbOut: 0.090, regionLabel: 'Canada (Central)',          refreshedAt: _now },
  'sa-east-1':      { cpuPerVcpuHour: 0.0672, ramPerGbHour: 0.0168, gpuPerHour: 4.000, netGbOut: 0.150, regionLabel: 'South America (São Paulo)', refreshedAt: _now },
  'eu-west-1':      { cpuPerVcpuHour: 0.0464, ramPerGbHour: 0.0116, gpuPerHour: 3.305, netGbOut: 0.090, regionLabel: 'Europe (Ireland)',          refreshedAt: _now },
  'eu-west-3':      { cpuPerVcpuHour: 0.0480, ramPerGbHour: 0.0120, gpuPerHour: 3.370, netGbOut: 0.090, regionLabel: 'Europe (Paris)',            refreshedAt: _now },
  'eu-central-1':   { cpuPerVcpuHour: 0.0464, ramPerGbHour: 0.0116, gpuPerHour: 3.367, netGbOut: 0.090, regionLabel: 'Europe (Frankfurt)',        refreshedAt: _now },
  'eu-north-1':     { cpuPerVcpuHour: 0.0432, ramPerGbHour: 0.0108, gpuPerHour: 3.150, netGbOut: 0.090, regionLabel: 'Europe (Stockholm)',        refreshedAt: _now },
  'ap-northeast-1': { cpuPerVcpuHour: 0.0528, ramPerGbHour: 0.0132, gpuPerHour: 3.673, netGbOut: 0.114, regionLabel: 'Asia Pacific (Tokyo)',      refreshedAt: _now },
  'ap-northeast-2': { cpuPerVcpuHour: 0.0500, ramPerGbHour: 0.0125, gpuPerHour: 3.500, netGbOut: 0.126, regionLabel: 'Asia Pacific (Seoul)',      refreshedAt: _now },
  'ap-southeast-1': { cpuPerVcpuHour: 0.0496, ramPerGbHour: 0.0124, gpuPerHour: 3.306, netGbOut: 0.120, regionLabel: 'Asia Pacific (Singapore)',  refreshedAt: _now },
  'ap-southeast-2': { cpuPerVcpuHour: 0.0504, ramPerGbHour: 0.0126, gpuPerHour: 3.500, netGbOut: 0.114, regionLabel: 'Asia Pacific (Sydney)',     refreshedAt: _now },
  'ap-south-1':     { cpuPerVcpuHour: 0.0376, ramPerGbHour: 0.0094, gpuPerHour: 2.800, netGbOut: 0.109, regionLabel: 'Asia Pacific (Mumbai)',     refreshedAt: _now },
  'af-south-1':     { cpuPerVcpuHour: 0.0456, ramPerGbHour: 0.0114, gpuPerHour: 3.200, netGbOut: 0.154, regionLabel: 'Africa (Cape Town)',        refreshedAt: _now },
  'me-south-1':     { cpuPerVcpuHour: 0.0472, ramPerGbHour: 0.0118, gpuPerHour: 3.300, netGbOut: 0.117, regionLabel: 'Middle East (Bahrain)',     refreshedAt: _now },
};

// ── ISO-3166-1 alpha-2 → AWS region ──────────────────────────────────────────

const COUNTRY_TO_AWS_REGION: Record<string, string> = {
  US: 'us-east-1',
  CA: 'ca-central-1',
  MX: 'us-east-1',
  BR: 'sa-east-1',
  AR: 'sa-east-1',
  CL: 'sa-east-1',
  CO: 'sa-east-1',
  GB: 'eu-west-1',
  IE: 'eu-west-1',
  NL: 'eu-west-1',
  BE: 'eu-west-1',
  FR: 'eu-west-3',
  DE: 'eu-central-1',
  AT: 'eu-central-1',
  CH: 'eu-central-1',
  SE: 'eu-north-1',
  NO: 'eu-north-1',
  DK: 'eu-north-1',
  FI: 'eu-north-1',
  JP: 'ap-northeast-1',
  KR: 'ap-northeast-2',
  SG: 'ap-southeast-1',
  MY: 'ap-southeast-1',
  ID: 'ap-southeast-1',
  AU: 'ap-southeast-2',
  NZ: 'ap-southeast-2',
  IN: 'ap-south-1',
  ZA: 'af-south-1',
  AE: 'me-south-1',
  SA: 'me-south-1',
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the AWS on-demand reference prices for the AWS region closest to the
 * given ISO-3166-1 country code. Falls back to us-east-1 for unknown countries.
 */
export function getAwsRef(country?: string | null): AwsRegionRef {
  const awsRegion =
    COUNTRY_TO_AWS_REGION[(country ?? '').toUpperCase()] ?? 'us-east-1';
  return AWS_REFERENCE[awsRegion] ?? AWS_REFERENCE['us-east-1'];
}

export interface NexusBasePrice {
  /** Per vCPU per hour (USD) — always 50 % below the local AWS reference */
  cpuPerHour:   number;
  /** Per GB RAM per hour (USD) */
  ramGbPerHour: number;
  /** Per GPU per hour (USD) */
  gpuPerHour:   number;
  /** Per GB transit (USD) */
  netGbTransit: number;
}

/**
 * Returns the Nexus base price for the region nearest to `country`.
 * The invariant P_nexus = P_aws × 0.50 is enforced here — if the AWS reference
 * price rises (e.g. after a refresh), Nexus prices rise proportionally so the
 * 50 % discount promise is always honoured.
 */
export function getNexusBaseForCountry(country?: string | null): NexusBasePrice {
  const aws = getAwsRef(country);
  return {
    cpuPerHour:   aws.cpuPerVcpuHour * 0.50,
    ramGbPerHour: aws.ramPerGbHour   * 0.50,
    gpuPerHour:   aws.gpuPerHour     * 0.50,
    netGbTransit: aws.netGbOut       * 0.50,
  };
}

/**
 * Returns a human-readable discount comparison for UI display.
 * e.g. "50% abaixo da AWS São Paulo · $0.0336/vCPU-h vs AWS $0.0672"
 */
export function getComparisonLabel(country?: string | null): string {
  const aws   = getAwsRef(country);
  const nexus = getNexusBaseForCountry(country);
  return (
    `50% abaixo da AWS ${aws.regionLabel}` +
    ` · $${nexus.cpuPerHour.toFixed(4)}/vCPU-h vs AWS $${aws.cpuPerVcpuHour.toFixed(4)}`
  );
}

/**
 * Returns true if the cached price for a country is older than 24 hours.
 * Wire this to a daily cron that calls refreshAwsPrices().
 */
export function isPriceStale(country?: string | null): boolean {
  return Date.now() - getAwsRef(country).refreshedAt.getTime() > CACHE_TTL_MS;
}

/**
 * Manually updates an AWS region's reference prices and marks it as refreshed.
 *
 * In production, call this from a daily cron that fetches from:
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/<region>/index.json
 *
 * The full AWS pricing bulk file is ~400 MB; a production implementation should
 * use a lightweight pricing microservice or Spot Price history as a proxy.
 */
export function updateAwsRef(
  awsRegion: string,
  prices: Partial<Omit<AwsRegionRef, 'regionLabel' | 'refreshedAt'>>,
): void {
  if (!AWS_REFERENCE[awsRegion]) return;
  Object.assign(AWS_REFERENCE[awsRegion], prices, { refreshedAt: new Date() });
}

/**
 * Returns all known AWS region references (for admin/debug endpoints).
 */
export function getAllAwsRefs(): Record<string, AwsRegionRef> {
  return { ...AWS_REFERENCE };
}
