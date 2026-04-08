/**
 * depin-ingress.service.ts
 *
 * DePIN Ingress Layer — routes inbound HTTP requests to healthy WASM/VM nodes.
 *
 * Flow:
 *   Client → POST /depin/<slug>/<path>
 *         → ingress looks up DePINApp by slug
 *         → finds RUNNING NodeAssignments with active WS connections
 *         → round-robin selects one
 *         → tunnels the request via sendProxyRequest (WS proxy_request)
 *         → waits for proxy_response
 *         → forwards status / headers / body back to client
 *
 * Health-aware: only nodes with an active WebSocket (confirmed ONLINE) receive
 * traffic. Nodes that are disconnected are transparently skipped.
 *
 * The target URL sent to the agent is "http://127.0.0.1:0" — the simulator
 * detects the special port and routes to its running echo server. Production
 * agents will resolve the app's local port from their process registry.
 */
import { Request, Response } from 'express';
import prisma from '../config/database';
import { getAgentSocket, sendProxyRequest } from './agent-ws.service';

// ── Round-robin state (per app slug) ─────────────────────────────────────────

const rrCounters = new Map<string, number>();

function nextIndex(slug: string, total: number): number {
  const idx = (rrCounters.get(slug) ?? 0) % total;
  rrCounters.set(slug, idx + 1);
  return idx;
}

// ── App + assignment lookup ───────────────────────────────────────────────────

export interface IngressNode {
  nodeId:   string;
  nodeName: string;
  role:     string;
}

/**
 * Returns healthy nodes for a DePIN app (RUNNING assignment + active WS socket).
 * Throws if the app is not found or has no healthy nodes.
 */
export async function getHealthyNodes(slug: string): Promise<IngressNode[]> {
  const app = await prisma.dePINApp.findUnique({
    where: { slug },
    include: {
      assignments: {
        where:   { status: 'RUNNING' },
        include: { node: { select: { id: true, name: true } } },
      },
    },
  });

  if (!app) throw Object.assign(new Error(`App "${slug}" not found`), { statusCode: 404 });
  if (app.status === 'OFFLINE') throw Object.assign(new Error(`App "${slug}" is offline`), { statusCode: 503 });

  const healthy = app.assignments.filter((a) => {
    const sock = getAgentSocket(a.nodeId);
    return sock !== undefined;
  });

  if (healthy.length === 0) {
    throw Object.assign(
      new Error(`No healthy nodes for app "${slug}" — all agents disconnected`),
      { statusCode: 503 },
    );
  }

  return healthy.map((a) => ({
    nodeId:   a.nodeId,
    nodeName: a.node.name,
    role:     a.role,
  }));
}

// ── Main ingress handler ──────────────────────────────────────────────────────

/**
 * Handles an HTTP request destined for a DePIN app.
 *
 * The request path has already been stripped of the `/depin/<slug>` prefix,
 * so `req.params[0]` contains the remainder (e.g. "/api/users/1").
 */
export async function handleDePINIngress(req: Request, res: Response): Promise<void> {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const remainingPath = (Array.isArray(req.params[0]) ? req.params[0][0] : req.params[0]) ?? '/';

  let healthy: IngressNode[];
  try {
    healthy = await getHealthyNodes(slug);
  } catch (err: any) {
    res.status(err.statusCode ?? 502).json({
      status: 'error',
      message: err.message,
      slug,
    });
    return;
  }

  // Select node using round-robin
  const idx  = nextIndex(slug, healthy.length);
  const node = healthy[idx];

  // Build forwarded headers (strip hop-by-hop)
  const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
  const forwardHeaders: Record<string, string> = {
    'x-forwarded-for':   (Array.isArray(req.ip) ? req.ip[0] : req.ip) ?? '',
    'x-forwarded-proto': req.protocol,
    'x-nexus-node':      node.nodeName,
    'x-nexus-slug':      slug,
  };
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === 'string') {
      forwardHeaders[k] = v;
    }
  }

  // Encode request body as base64
  const bodyB64 = req.body && Object.keys(req.body).length > 0
    ? Buffer.from(JSON.stringify(req.body)).toString('base64')
    : '';

  // The target URL tells the agent where its local worker is listening.
  // "http://127.0.0.1:0" is a sentinel value; the sim resolves it to its
  // echo server port. In production the agent uses its internal port registry.
  const targetUrl = 'http://127.0.0.1:0';

  const path = remainingPath.startsWith('/') ? remainingPath : `/${remainingPath}`;

  console.log(`[ingress] → ${req.method} /depin/${slug}${path}  node=${node.nodeName}  (${idx + 1}/${healthy.length})`);

  try {
    const proxyResp = await sendProxyRequest(node.nodeId, {
      method:    req.method,
      path,
      targetUrl,
      headers:   forwardHeaders,
      body:      bodyB64,
    });

    if (proxyResp.error) {
      res.status(502).json({ status: 'error', message: proxyResp.error, node: node.nodeName });
      return;
    }

    // Forward response headers (skip hop-by-hop)
    for (const [k, v] of Object.entries(proxyResp.headers ?? {})) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === 'string') {
        res.setHeader(k, v);
      }
    }
    res.setHeader('X-Served-By', node.nodeName);
    res.setHeader('X-Nexus-Nodes', healthy.length.toString());

    const bodyBuf = proxyResp.body ? Buffer.from(proxyResp.body, 'base64') : Buffer.alloc(0);
    res.status(proxyResp.statusCode).send(bodyBuf);
  } catch (err: any) {
    console.error(`[ingress] tunnel error for node ${node.nodeName}:`, err.message);
    res.status(504).json({
      status:  'error',
      message: 'Gateway timeout — agent did not respond in time',
      node:    node.nodeName,
    });
  }
}

// ── Cluster info endpoint ─────────────────────────────────────────────────────

export async function getDePINClusterInfo(req: Request, res: Response): Promise<void> {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;

  const app = await prisma.dePINApp.findUnique({
    where: { slug },
    include: {
      assignments: {
        include: { node: { select: { id: true, name: true, status: true, ipAddress: true } } },
      },
    },
  });

  if (!app) {
    res.status(404).json({ status: 'error', message: `App "${slug}" not found` });
    return;
  }

  const rawAssignments = (app as any).assignments as Array<{
    nodeId: string; role: string; status: string;
    node: { name: string; status: string };
  }>;
  const assignments = rawAssignments.map((a) => ({
    nodeId:     a.nodeId,
    nodeName:   a.node.name,
    role:       a.role,
    status:     a.status,
    connected:  getAgentSocket(a.nodeId) !== undefined,
    nodeStatus: a.node.status,
  }));

  const healthy = assignments.filter((a) => a.connected && a.status === 'RUNNING');

  res.json({
    status: 'success',
    data: {
      app: {
        id:            app.id,
        name:          app.name,
        slug:          app.slug,
        executionMode: app.executionMode,
        status:        app.status,
        replicaCount:  app.replicaCount,
      },
      cluster: {
        totalAssignments:   assignments.length,
        healthyNodes:       healthy.length,
        offlineNodes:       assignments.length - healthy.length,
        roundRobinCounter:  rrCounters.get(String(slug)) ?? 0,
      },
      assignments,
    },
  });
}
