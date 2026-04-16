/**
 * tsdb.service.ts — Sprint 20.1
 *
 * TimescaleDB integration for time-series node metrics.
 *
 * Schema (auto-created on first write):
 *
 *   CREATE TABLE IF NOT EXISTS node_metrics (
 *     time        TIMESTAMPTZ NOT NULL,
 *     node_id     TEXT        NOT NULL,
 *     cpu_pct     DOUBLE PRECISION,
 *     ram_pct     DOUBLE PRECISION,
 *     disk_pct    DOUBLE PRECISION,
 *     net_rx_mb   DOUBLE PRECISION,
 *     net_tx_mb   DOUBLE PRECISION,
 *     gpu_pct     DOUBLE PRECISION
 *   );
 *   SELECT create_hypertable('node_metrics', 'time', if_not_exists => TRUE);
 *
 * All writes are fire-and-forget (non-blocking to the main request path).
 * Queries return rows ordered by time DESC.
 */

import { Client } from 'pg';

const TSDB_URL = process.env.TSDB_URL ?? '';

let _client: Client | null = null;
let _ready = false;

// ── Connection ────────────────────────────────────────────────────────────────

async function getClient(): Promise<Client | null> {
  if (!TSDB_URL) return null; // TimescaleDB not configured — degrade gracefully
  if (_client && _ready) return _client;

  const client = new Client({ connectionString: TSDB_URL });
  try {
    await client.connect();
    await ensureSchema(client);
    _client = client;
    _ready  = true;
    console.log('[tsdb] connected and schema ready');
    return _client;
  } catch (err) {
    console.error('[tsdb] connection error:', err);
    return null;
  }
}

async function ensureSchema(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS node_metrics (
      time      TIMESTAMPTZ     NOT NULL,
      node_id   TEXT            NOT NULL,
      cpu_pct   DOUBLE PRECISION,
      ram_pct   DOUBLE PRECISION,
      disk_pct  DOUBLE PRECISION,
      net_rx_mb DOUBLE PRECISION,
      net_tx_mb DOUBLE PRECISION,
      gpu_pct   DOUBLE PRECISION
    );
  `);

  // Create the hypertable (TimescaleDB extension call — idempotent)
  await client.query(`
    SELECT create_hypertable('node_metrics', 'time', if_not_exists => TRUE);
  `);

  // Index for fast per-node lookups
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_node_metrics_node_id ON node_metrics (node_id, time DESC);
  `);
}

// ── Write ─────────────────────────────────────────────────────────────────────

export interface MetricPoint {
  nodeId:    string;
  cpuPct?:   number;
  ramPct?:   number;
  diskPct?:  number;
  netRxMb?:  number;
  netTxMb?:  number;
  gpuPct?:   number;
  time?:     Date;
}

/**
 * writeMetric — inserts one metric row into TimescaleDB.
 * Fire-and-forget; logs errors but never throws.
 */
export async function writeMetric(point: MetricPoint): Promise<void> {
  const client = await getClient();
  if (!client) return;

  const ts = point.time ?? new Date();
  try {
    await client.query(
      `INSERT INTO node_metrics
         (time, node_id, cpu_pct, ram_pct, disk_pct, net_rx_mb, net_tx_mb, gpu_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ts,
        point.nodeId,
        point.cpuPct  ?? null,
        point.ramPct  ?? null,
        point.diskPct ?? null,
        point.netRxMb ?? null,
        point.netTxMb ?? null,
        point.gpuPct  ?? null,
      ],
    );
  } catch (err) {
    console.error('[tsdb] writeMetric error:', err);
  }
}

// ── Query ─────────────────────────────────────────────────────────────────────

export interface MetricRow {
  time:      string;
  nodeId:    string;
  cpuPct:    number | null;
  ramPct:    number | null;
  diskPct:   number | null;
  netRxMb:   number | null;
  netTxMb:   number | null;
  gpuPct:    number | null;
}

/**
 * queryMetrics — returns the last N minutes of metrics for a given node.
 * Returns an empty array if TimescaleDB is unavailable.
 *
 * @param nodeId  Node UUID
 * @param minutes Look-back window in minutes (default 60)
 * @param limit   Max rows to return (default 500)
 */
export async function queryMetrics(
  nodeId:  string,
  minutes = 60,
  limit   = 500,
): Promise<MetricRow[]> {
  const client = await getClient();
  if (!client) return [];

  try {
    const res = await client.query<{
      time:      string;
      node_id:   string;
      cpu_pct:   number | null;
      ram_pct:   number | null;
      disk_pct:  number | null;
      net_rx_mb: number | null;
      net_tx_mb: number | null;
      gpu_pct:   number | null;
    }>(
      `SELECT time, node_id, cpu_pct, ram_pct, disk_pct, net_rx_mb, net_tx_mb, gpu_pct
         FROM node_metrics
        WHERE node_id = $1
          AND time > NOW() - INTERVAL '${Math.max(1, Math.floor(minutes))} minutes'
        ORDER BY time DESC
        LIMIT $2`,
      [nodeId, limit],
    );

    return res.rows.map((r) => ({
      time:     r.time,
      nodeId:   r.node_id,
      cpuPct:   r.cpu_pct,
      ramPct:   r.ram_pct,
      diskPct:  r.disk_pct,
      netRxMb:  r.net_rx_mb,
      netTxMb:  r.net_tx_mb,
      gpuPct:   r.gpu_pct,
    }));
  } catch (err) {
    console.error('[tsdb] queryMetrics error:', err);
    return [];
  }
}

/**
 * queryAggregated — returns time-bucketed averages for a node.
 * Useful for charts (bucket = 1 minute by default).
 *
 * @param nodeId       Node UUID
 * @param minutes      Look-back window in minutes
 * @param bucketSecs   Bucket size in seconds (default 60)
 */
export async function queryAggregated(
  nodeId:     string,
  minutes   = 60,
  bucketSecs = 60,
): Promise<MetricRow[]> {
  const client = await getClient();
  if (!client) return [];

  try {
    const res = await client.query<{
      bucket:    string;
      node_id:   string;
      cpu_pct:   number | null;
      ram_pct:   number | null;
      disk_pct:  number | null;
      net_rx_mb: number | null;
      net_tx_mb: number | null;
      gpu_pct:   number | null;
    }>(
      `SELECT
         time_bucket('${Math.max(1, Math.floor(bucketSecs))} seconds', time) AS bucket,
         node_id,
         AVG(cpu_pct)   AS cpu_pct,
         AVG(ram_pct)   AS ram_pct,
         AVG(disk_pct)  AS disk_pct,
         AVG(net_rx_mb) AS net_rx_mb,
         AVG(net_tx_mb) AS net_tx_mb,
         AVG(gpu_pct)   AS gpu_pct
       FROM node_metrics
       WHERE node_id = $1
         AND time > NOW() - INTERVAL '${Math.max(1, Math.floor(minutes))} minutes'
       GROUP BY bucket, node_id
       ORDER BY bucket DESC
       LIMIT 500`,
      [nodeId],
    );

    return res.rows.map((r) => ({
      time:    r.bucket,
      nodeId:  r.node_id,
      cpuPct:  r.cpu_pct,
      ramPct:  r.ram_pct,
      diskPct: r.disk_pct,
      netRxMb: r.net_rx_mb,
      netTxMb: r.net_tx_mb,
      gpuPct:  r.gpu_pct,
    }));
  } catch (err) {
    console.error('[tsdb] queryAggregated error:', err);
    return [];
  }
}
