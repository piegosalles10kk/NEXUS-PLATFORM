/**
 * sonar.service.ts  (Sprint 14)
 *
 * The Sonar Engine continuously monitors the quality of the ingress path for
 * each running DePIN app and automatically swaps the gateway when latency
 * exceeds a threshold.
 *
 * findBestGateway() — recursive proximity search:
 *   Tier 1: nodes in the same state  as the tenant          (target: <20 ms)
 *   Tier 2: nodes in the same country as the tenant         (target: <60 ms)
 *   Tier 3: nodes in the same continent as the tenant       (target: <120 ms)
 *   Tier 4: any online transit-enabled node                 (fallback)
 *
 * Hot-swap (T14.3):
 *   When a better gateway is found the service:
 *   1. Sends "deactivate_transit" to the old gateway agent
 *   2. Sends "activate_transit" to the new gateway agent
 *   3. Updates the GatewayRoute in the DB to point at the new IP
 *   4. Updates Node.transitStatus in the DB
 *   5. Emits a "sonar:gateway_swap" Socket.io event for the UI radar view
 *
 * The monitor runs every 30 s and is wired into the scheduler cron.
 */

import prisma from '../config/database';
import { getAgentSocket, getIo } from './agent-ws.service';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GatewayCandidate {
  nodeId:    string;
  name:      string;
  ipAddress: string;
  country:   string | null;
  state:     string | null;
  continent: string | null;
  latencyMs: number | null;
  tier:      'state' | 'country' | 'continent' | 'global';
}

export interface SonarResult {
  appId:       string;
  previousGw:  string | null;
  newGw:       string | null;
  latencyMs:   number | null;
  tier:        GatewayCandidate['tier'] | null;
  swapped:     boolean;
  reason:      string;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const LATENCY_THRESHOLD_MS = 150; // trigger a swap if current GW > this
const IMPROVEMENT_MIN_MS   = 20;  // only swap if new GW is at least 20 ms better

// ── findBestGateway ───────────────────────────────────────────────────────────

/**
 * Finds the lowest-latency transit-enabled node for a given tenant geography.
 * Tries proximity tiers from most-local to global, returning the first
 * candidate whose Sonar latency is below the threshold.
 */
export async function findBestGateway(opts: {
  tenantCountry?:   string | null;
  tenantState?:     string | null;
  tenantContinent?: string | null;
  excludeNodeId?:   string;
}): Promise<GatewayCandidate | null> {

  interface NodeRow {
    id: string; name: string; ipAddress: string | null;
    country: string | null; state: string | null; continent: string | null;
    sonarLatencyMs: number | null; transitStatus: string;
  }

  const nodes: NodeRow[] = await (prisma.node as any).findMany({
    where: {
      status: 'ONLINE',
      ...(opts.excludeNodeId ? { id: { not: opts.excludeNodeId } } : {}),
    },
    select: {
      id: true, name: true, ipAddress: true,
      country: true, state: true, continent: true,
      sonarLatencyMs: true, transitStatus: true,
    },
  });

  // Only keep nodes that have an active WS and transit enabled or STANDBY
  const connected = nodes.filter(n =>
    getAgentSocket(n.id) !== undefined &&
    (n.transitStatus === 'STANDBY' || n.transitStatus === 'STREAMING' || n.transitStatus === 'IDLE')
  );

  if (connected.length === 0) return null;

  // Sort by latency ascending (null = unknown, treated as high)
  connected.sort((a, b) => {
    const la = a.sonarLatencyMs ?? 9999;
    const lb = b.sonarLatencyMs ?? 9999;
    return la - lb;
  });

  const tiers: Array<{ label: GatewayCandidate['tier']; filter: (n: NodeRow) => boolean }> = [
    { label: 'state',     filter: n => n.state     === opts.tenantState   && n.country === opts.tenantCountry },
    { label: 'country',   filter: n => n.country   === opts.tenantCountry },
    { label: 'continent', filter: n => n.continent === opts.tenantContinent },
    { label: 'global',    filter: _n => true },
  ];

  for (const tier of tiers) {
    const candidates = connected.filter(tier.filter);
    if (candidates.length > 0) {
      const best = candidates[0];
      return {
        nodeId:    best.id,
        name:      best.name,
        ipAddress: best.ipAddress ?? '',
        country:   best.country,
        state:     best.state,
        continent: best.continent,
        latencyMs: best.sonarLatencyMs,
        tier:      tier.label,
      };
    }
  }

  return null;
}

// ── Hot-swap logic ────────────────────────────────────────────────────────────

async function getCurrentGateway(appId: string): Promise<{ nodeId: string; latencyMs: number | null } | null> {
  // The "gateway" is the node whose transitStatus = STREAMING and is assigned to this app
  const assignment = await (prisma.nodeAssignment as any).findFirst({
    where: { appId, status: 'RUNNING' },
    include: { node: { select: { id: true, sonarLatencyMs: true, transitStatus: true } } },
    orderBy: { createdAt: 'asc' }, // LEADER first
  }) as any;

  if (!assignment) return null;
  return {
    nodeId:    assignment.node?.id ?? null,
    latencyMs: assignment.node?.sonarLatencyMs ?? null,
  };
}

async function swapGateway(
  appId:      string,
  oldNodeId:  string | null,
  newNode:    GatewayCandidate,
  upstream:   string,
): Promise<void> {
  const io = getIo();

  // 1. Deactivate old gateway
  if (oldNodeId) {
    const oldWs = getAgentSocket(oldNodeId);
    if (oldWs) oldWs.send(JSON.stringify({ type: 'action', action: 'deactivate_transit' }));
    await (prisma.node as any).update({
      where: { id: oldNodeId },
      data:  { transitStatus: 'STANDBY' },
    }).catch(console.error);
  }

  // 2. Activate new gateway
  const newWs = getAgentSocket(newNode.nodeId);
  if (newWs) {
    newWs.send(JSON.stringify({
      type:       'action',
      action:     'activate_transit',
      port:       100,          // 100 Mbps default
      targetUrl:  upstream,
    }));
  }

  await (prisma.node as any).update({
    where: { id: newNode.nodeId },
    data:  { transitStatus: 'STREAMING' },
  }).catch(console.error);

  // 3. Update GatewayRoute to point at new IP (if a route exists for this app)
  await (prisma.gatewayRoute as any).updateMany({
    where: { tunnelNodeId: oldNodeId },
    data:  { tunnelNodeId: newNode.nodeId, targetUrl: `http://${newNode.ipAddress}:8080` },
  }).catch(console.error);

  // 4. Emit Socket.io event for the Sonar Radar UI
  io?.emit('sonar:gateway_swap', {
    appId,
    from:      oldNodeId,
    to:        newNode.nodeId,
    toName:    newNode.name,
    toCountry: newNode.country,
    toState:   newNode.state,
    latencyMs: newNode.latencyMs,
    tier:      newNode.tier,
    ts:        Date.now(),
  });
}

// ── Monitor loop ──────────────────────────────────────────────────────────────

/**
 * Runs the Sonar monitor for all active DePIN apps.
 * Call this from the scheduler cron every 30 s.
 */
export async function runSonarMonitor(): Promise<SonarResult[]> {
  const apps = await (prisma.dePINApp as any).findMany({
    where: { status: 'RUNNING' },
    select: {
      id: true, region: true,
      assignments: {
        where:   { status: 'RUNNING' },
        select:  { nodeId: true },
        take:    1,
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  const results: SonarResult[] = [];

  for (const app of apps) {
    try {
      const current = await getCurrentGateway(app.id);
      if (!current) continue;

      // Skip if current latency is acceptable
      if (current.latencyMs !== null && current.latencyMs < LATENCY_THRESHOLD_MS) {
        results.push({ appId: app.id, previousGw: current.nodeId, newGw: null, latencyMs: current.latencyMs, tier: null, swapped: false, reason: 'latency ok' });
        continue;
      }

      // Fetch tenant geography from the leader node
      const leaderNode = await (prisma.node as any).findUnique({
        where: { id: current.nodeId },
        select: { country: true, state: true, continent: true },
      });

      const best = await findBestGateway({
        tenantCountry:   leaderNode?.country,
        tenantState:     leaderNode?.state,
        tenantContinent: leaderNode?.continent,
        excludeNodeId:   current.nodeId,
      });

      if (!best) {
        results.push({ appId: app.id, previousGw: current.nodeId, newGw: null, latencyMs: current.latencyMs, tier: null, swapped: false, reason: 'no candidate found' });
        continue;
      }

      // Only swap if there's meaningful improvement
      const improvement = (current.latencyMs ?? LATENCY_THRESHOLD_MS + 1) - (best.latencyMs ?? 0);
      if (improvement < IMPROVEMENT_MIN_MS) {
        results.push({ appId: app.id, previousGw: current.nodeId, newGw: best.nodeId, latencyMs: best.latencyMs, tier: best.tier, swapped: false, reason: `improvement ${improvement.toFixed(0)}ms < threshold` });
        continue;
      }

      await swapGateway(app.id, current.nodeId, best, `http://${best.ipAddress}:3000`);
      results.push({ appId: app.id, previousGw: current.nodeId, newGw: best.nodeId, latencyMs: best.latencyMs, tier: best.tier, swapped: true, reason: `latency improved ${improvement.toFixed(0)}ms via tier=${best.tier}` });

      console.log(`[sonar] gateway swap app=${app.id} ${current.nodeId}→${best.nodeId} tier=${best.tier} Δ${improvement.toFixed(0)}ms`);
    } catch (err) {
      console.error(`[sonar] monitor error app=${app.id}:`, err);
    }
  }

  return results;
}
