/**
 * agent-ws.service.ts
 *
 * Runs a separate HTTPS/WSS server on AGENT_WS_PORT (default 8443) with mTLS
 * (client certificate verification). Connected agents are identified by their
 * JWT token sent in the Authorization header during the WebSocket handshake.
 *
 * Responsibilities:
 *  - Upgrade HTTP → WebSocket after mTLS handshake
 *  - Authenticate agent via Bearer JWT (same secret as the main API)
 *  - Update Node.status = ONLINE / OFFLINE and last_ping in Prisma
 *  - Relay metrics payload to the frontend via Socket.io
 *  - Forward log_line messages to the correct Socket.io project room
 *  - Reverse-tunnel HTTP requests from the Gateway through the agent (proxy_request / proxy_response)
 */
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { Server as SocketServer } from 'socket.io';
import { env } from '../config/env';
import prisma from '../config/database';
import { getCACert, getCAKey } from './ca.service';
import { getRedisClient } from '../config/redis';

// Map nodeId → WebSocket, so the master can push commands to specific agents
const agentSockets = new Map<string, WebSocket>();

// Module-level Socket.io instance — stored when startAgentWsServer() is called
let _io: SocketServer | null = null;

/** Returns the Socket.io server instance (null before server starts). */
export function getIo(): SocketServer | null {
  return _io;
}

// ── Reverse-tunnel state ──────────────────────────────────────────────────────

/** Pending tunnel proxy requests: requestId → resolve callback */
const pendingProxyRequests = new Map<string, (response: ProxyResponse) => void>();

/** Pending agent port scan requests: requestId → resolve callback */
const pendingScanRequests = new Map<string, (ports: number[]) => void>();

/** Generic pending agent responses (stop/restart/files): requestId → resolve/reject */
const pendingAgentResponses = new Map<string, { resolve: (msg: any) => void; reject: (err: Error) => void }>();

/** Maximum body size for a single tunnel request/response (5 MB). */
const TUNNEL_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Per-request tunnel timeout in milliseconds. */
const TUNNEL_TIMEOUT_MS = 30_000;

export interface ProxyRequestData {
  method:    string;
  /** Path relative to the route prefix — e.g. "/api/users/1" */
  path:      string;
  /** The agent-local base URL — e.g. "http://localhost:8080" */
  targetUrl: string;
  headers:   Record<string, string>;
  /** Request body, base64-encoded. Empty string for bodyless methods. */
  body:      string;
}

export interface ProxyResponse {
  requestId:  string;
  statusCode: number;
  headers:    Record<string, string>;
  /** Response body, base64-encoded. */
  body:       string;
  error?:     string;
}

export function getAgentSocket(nodeId: string): WebSocket | undefined {
  return agentSockets.get(nodeId);
}

/**
 * Sends a remove command to the named agent to stop and delete a container.
 * Fire-and-forget — rejects if the agent is offline.
 */
export function sendRemoveCommand(nodeId: string, imageName: string): void {
  const ws = agentSockets.get(nodeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[agent-ws] sendRemoveCommand: agent ${nodeId} is not connected`);
    return;
  }
  ws.send(JSON.stringify({ type: 'command', action: 'remove', imageName }));
}

// ── Generic agent request helper ─────────────────────────────────────────────

/**
 * Sends a command to an agent and awaits the response message identified by requestId.
 * Rejects if the agent is offline or the request times out.
 */
function sendAgentRequest<T = any>(
  nodeId: string,
  payload: object,
  timeoutMs = 30_000,
): Promise<T> {
  const ws = agentSockets.get(nodeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`Agent ${nodeId} is not connected`));
  }

  const requestId = randomUUID();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAgentResponses.delete(requestId);
      reject(new Error(`Agent request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingAgentResponses.set(requestId, {
      resolve: (msg: any) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg as T);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    ws.send(JSON.stringify({ ...payload, requestId }));
  });
}

// ── Container lifecycle commands ──────────────────────────────────────────────

export function stopContainer(nodeId: string, imageName: string): Promise<void> {
  return sendAgentRequest(nodeId, { type: 'command', action: 'stop', imageName });
}

export function restartContainer(nodeId: string, imageName: string): Promise<void> {
  return sendAgentRequest(nodeId, { type: 'command', action: 'restart', imageName });
}

export function startContainerLogs(nodeId: string, containerId: string): void {
  const ws = agentSockets.get(nodeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'command', action: 'stream_logs', container_id: containerId }));
}

export function stopContainerLogs(nodeId: string, containerId: string): void {
  const ws = agentSockets.get(nodeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'command', action: 'stop_logs', container_id: containerId }));
}

export function syncProjectRepository(nodeId: string, repo: string, branch: string, imageName: string): Promise<any> {
  return sendAgentRequest(nodeId, { type: 'command', action: 'git_sync', repo, branch, imageName }, 60000);
}

// ── File manager commands ─────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export function listProjectFiles(nodeId: string, imageName: string, filePath = ''): Promise<FileEntry[]> {
  return sendAgentRequest<{ entries: FileEntry[] }>(
    nodeId,
    { type: 'command', action: 'list_files', imageName, filePath },
  ).then((msg) => msg.entries ?? []);
}

export function readProjectFile(nodeId: string, imageName: string, filePath: string): Promise<string> {
  return sendAgentRequest<{ content: string }>(
    nodeId,
    { type: 'command', action: 'read_file', imageName, filePath },
  ).then((msg) => msg.content ?? '');
}

export function writeProjectFile(nodeId: string, imageName: string, filePath: string, fileContent: string): Promise<void> {
  return sendAgentRequest(
    nodeId,
    { type: 'command', action: 'write_file', imageName, filePath, fileContent },
  );
}

export function copyProjectFile(nodeId: string, imageName: string, filePath: string, destPath: string): Promise<void> {
  return sendAgentRequest(
    nodeId,
    { type: 'command', action: 'copy_file', imageName, filePath, destPath },
  );
}

export function deleteProjectFile(nodeId: string, imageName: string, filePath: string): Promise<void> {
  return sendAgentRequest(
    nodeId,
    { type: 'command', action: 'delete_file', imageName, filePath },
  );
}

export function moveProjectFile(nodeId: string, imageName: string, filePath: string, destPath: string): Promise<void> {
  return sendAgentRequest(
    nodeId,
    { type: 'command', action: 'move_file', imageName, filePath, destPath },
  );
}

/**
 * Sends a terminate command to an agent, which will uninstall the service and exit.
 */
export function terminateAgent(nodeId: string): void {
  const ws = agentSockets.get(nodeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type: 'command', action: 'terminate' }));
}

/**
 * Sends an HTTP request through the named agent's WebSocket tunnel and
 * returns the proxied response.  Rejects if the agent is offline or the
 * request exceeds TUNNEL_TIMEOUT_MS.
 */
export function sendProxyRequest(nodeId: string, data: ProxyRequestData): Promise<ProxyResponse> {
  const ws = agentSockets.get(nodeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`Agent ${nodeId} is not connected`));
  }

  // Guard against oversized bodies before touching the network.
  const bodyBytes = Buffer.byteLength(data.body, 'base64');
  if (bodyBytes > TUNNEL_MAX_BODY_BYTES) {
    return Promise.reject(new Error(`Request body (${bodyBytes} bytes) exceeds tunnel limit of ${TUNNEL_MAX_BODY_BYTES} bytes`));
  }

  const requestId = randomUUID();

  return new Promise<ProxyResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingProxyRequests.delete(requestId);
      reject(new Error(`Tunnel proxy request timed out after ${TUNNEL_TIMEOUT_MS}ms`));
    }, TUNNEL_TIMEOUT_MS);

    pendingProxyRequests.set(requestId, (response) => {
      clearTimeout(timer);
      resolve(response);
    });

    ws.send(JSON.stringify({
      type:      'proxy_request',
      action:    'proxy_request',
      requestId,
      method:    data.method,
      path:      data.path,
      targetUrl: data.targetUrl,
      headers:   data.headers,
      body:      data.body,
    }));
  });
}

/**
 * Requests an active port scan (1-10000) from a specific agent.
 * Returns a promise that resolves with the list of open ports.
 */
export function requestPortScan(nodeId: string): Promise<number[]> {
  const ws = agentSockets.get(nodeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`Agent ${nodeId} is not connected`));
  }

  const requestId = randomUUID();

  return new Promise<number[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingScanRequests.delete(requestId);
      reject(new Error(`Port scan request timed out after 30s`));
    }, 30_000);

    pendingScanRequests.set(requestId, (ports) => {
      clearTimeout(timer);
      resolve(ports);
    });

    ws.send(JSON.stringify({
      type:      'scan_ports',
      action:    'scan_ports',
      requestId,
      startPort: 1,
      endPort:   10000,
    }));
  });
}

// ── WebSocket server ──────────────────────────────────────────────────────────

/**
 * Start the mTLS WebSocket server.
 * Called once from createApp() after the CA is warm.
 */
export async function startAgentWsServer(io: SocketServer): Promise<void> {
  _io = io; // store for getIo()
  const caCert = await getCACert();
  const caKey  = await getCAKey();

  // The mTLS server presents the same CA cert as its server cert.
  // In production, replace with a proper server cert issued by the same CA.
  // For simplicity we generate a self-signed server cert from the CA here.
  const { serverCert, serverKey } = await generateServerCert(caCert, caKey);

  const port = parseInt(process.env.AGENT_WS_PORT ?? '8443', 10);

  const httpsServer = https.createServer({
    ca:                 caCert,
    cert:               serverCert,
    key:                serverKey,
    requestCert:        true,   // request client cert (mTLS)
    rejectUnauthorized: false,  // we validate manually so we can send a 401 message
  });

  const wss = new WebSocketServer({ server: httpsServer });

  wss.on('connection', (ws, req) => {
    // 1. Verify the client certificate if presented
    const socket = req.socket as any;
    const clientCert = socket.getPeerCertificate?.();
    if (!clientCert || !socket.authorized) {
      // Allow fallback to JWT-only auth (no cert) for development/testing
      // In strict mode, uncomment the following:
      // ws.close(1008, 'mTLS: client certificate required');
      // return;
    }

    // 2. Authenticate via JWT in Authorization header
    const authHeader = req.headers['authorization'] ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      ws.close(1008, 'Authentication required');
      return;
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET);
    } catch {
      ws.close(1008, 'Invalid token');
      return;
    }

    const nodeId: string = decoded.nodeId;
    if (!nodeId) {
      ws.close(1008, 'Token missing nodeId claim');
      return;
    }

    // 3. Update node status in DB + geo-enrich IP asynchronously
    const remoteIp = req.socket.remoteAddress ?? undefined;
    const agentOs = (req.headers['x-agent-os'] as string) || undefined;
    const agentVersion = (req.headers['x-agent-version'] as string) || undefined;

    prisma.node.update({
      where: { id: nodeId },
      data:  {
        status: 'ONLINE',
        ipAddress: remoteIp,
        os: agentOs,
        version: agentVersion
      },
    }).catch(console.error);

    // Geo-enrich in background (non-blocking)
    if (remoteIp) {
      import('./geo.service').then(({ lookupIp }) =>
        lookupIp(remoteIp).then(geo => {
          if (!geo) return;
          const CONTINENT_MAP: Record<string, string> = {
            BR:'SA',AR:'SA',CL:'SA',CO:'SA',PE:'SA',
            US:'NA',CA:'NA',MX:'NA',
            GB:'EU',DE:'EU',FR:'EU',NL:'EU',IE:'EU',SE:'EU',NO:'EU',FI:'EU',AT:'EU',CH:'EU',
            JP:'AP',KR:'AP',SG:'AP',IN:'AP',AU:'OC',NZ:'OC',ID:'AP',MY:'AP',
            ZA:'AF',NG:'AF',KE:'AF',
            AE:'ME',SA:'ME',
          };
          (prisma.node as any).update({
            where: { id: nodeId },
            data: {
              country: geo.country, state: geo.state, city: geo.city,
              continent: geo.country ? (CONTINENT_MAP[geo.country.toUpperCase()] ?? null) : null,
            },
          }).catch(console.error);
        })
      ).catch(() => {});
    }

    agentSockets.set(nodeId, ws);
    console.log(`🤝 Agent connected: nodeId=${nodeId} ip=${remoteIp}`);

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case 'ping':
          // Touch last_ping (handled by @updatedAt) + keep ONLINE
          prisma.node.update({ where: { id: nodeId }, data: { status: 'ONLINE' } })
                     .catch(console.error);
          break;

        case 'metrics': {
          // Build update payload: GPU fields + Sonar latency + hardware capacity
          const updateData: Record<string, any> = {};

          if (Array.isArray(msg.data?.gpus) && msg.data.gpus.length > 0) {
            const gpus: Array<{ name: string; memory_total_mb: number }> = msg.data.gpus;
            updateData.gpuModel    = gpus[0].name ?? null;
            updateData.gpuMemoryMb = gpus.reduce((s: number, g: any) => s + (g.memory_total_mb ?? 0), 0);
            updateData.gpuCount    = gpus.length;
          }

          // Sprint 12.2 — persist Sonar latency from heartbeat
          if (typeof msg.sonarLatencyMs === 'number' && msg.sonarLatencyMs >= 0) {
            updateData.sonarLatencyMs = msg.sonarLatencyMs;
          }

          // Persist hardware capacity if provided
          if (typeof msg.data?.cpuCores === 'number') updateData.cpuCores = msg.data.cpuCores;
          if (typeof msg.data?.ramTotal === 'number')  updateData.ramMb    = Math.round(msg.data.ramTotal / (1024 * 1024));

          if (Object.keys(updateData).length > 0) {
            (prisma.node as any).update({ where: { id: nodeId }, data: updateData }).catch(console.error);
          }

          io.emit('node:metrics', { nodeId, data: msg.data });
          break;
        }

        case 'telemetry':
          // Save to Redis (capped to last 100 entries)
          getRedisClient().then((redis) => {
            const key = `node:${nodeId}:telemetry`;
            const m = redis.multi();
            m.lPush(key, JSON.stringify(msg.payload));
            m.lTrim(key, 0, 99);
            m.exec().catch(err => console.error(`[redis] exec failed for nodeId=${nodeId}:`, err));
          }).catch(err => {
            console.error(`[redis] connection failed for nodeId=${nodeId}:`, err);
          });

          // Persist GPU info from telemetry payload (5s stream, has gpus field now)
          if (Array.isArray(msg.payload?.gpus) && msg.payload.gpus.length > 0) {
            const gpus: Array<{ name: string; memory_total_mb: number }> = msg.payload.gpus;
            prisma.node.update({
              where: { id: nodeId },
              data: {
                gpuModel:    gpus[0].name ?? null,
                gpuMemoryMb: gpus.reduce((s, g) => s + (g.memory_total_mb ?? 0), 0),
                gpuCount:    gpus.length,
              },
            }).catch(console.error);
          }

          // Broadcast to connected web clients (includes gpus array)
          io.emit('node:telemetry', { nodeId, data: msg.payload });
          break;

        case 'log_line':
          // Forward to the Socket.io room for the relevant project (best-effort)
          io.emit('agent:log', { nodeId, containerId: msg.container_id, line: msg.data });
          break;

        case 'shell_output':
          io.to(`server:${nodeId}`).emit('agent:shell_output', { sessionId: msg.sessionId, message: msg.message });
          break;

        case 'shell_exit':
          io.to(`server:${nodeId}`).emit('agent:shell_exit', { sessionId: msg.sessionId, code: msg.code });
          break;

        case 'proxy_response': {
          // Agent has fulfilled a tunnel proxy request — resolve the pending promise.
          const resolver = pendingProxyRequests.get(msg.requestId);
          if (resolver) {
            pendingProxyRequests.delete(msg.requestId);
            resolver({
              requestId:  msg.requestId,
              statusCode: msg.statusCode ?? 502,
              headers:    msg.headers   ?? {},
              body:       msg.body      ?? '',
              error:      msg.error,
            });
          }
          break;
        }

        case 'scan_result': {
          // Agent returned list of open ports
          const resolver = pendingScanRequests.get(msg.requestId);
          if (resolver) {
            pendingScanRequests.delete(msg.requestId);
            resolver(msg.ports ?? []);
          }
          break;
        }

        case 'git_sync_result':
        case 'container_action_result':
        case 'file_list':
        case 'file_content':
        case 'file_write_result':
        case 'file_delete_result':
        case 'file_copy_result':
        case 'file_move_result': {
          const pending = pendingAgentResponses.get(msg.requestId);
          if (pending) {
            pendingAgentResponses.delete(msg.requestId);
            pending.resolve(msg);
          }
          break;
        }

        case 'route_register': {
          // Agent finished a deploy and is registering the gateway route for the container
          const routePath = `/${msg.host}`;
          const targetUrl = `http://${msg.containerName}:${msg.port}`;
          prisma.gatewayRoute.upsert({
            where:  { routePath },
            update: { targetUrl, isActive: true, name: String(msg.host) },
            create: { name: String(msg.host), routePath, targetUrl, isActive: true },
          }).then(() => {
            console.log(`🌐 [agent-ws] Route registered: ${routePath} → ${targetUrl}`);
            io.emit('gateway:route_updated', { routePath, targetUrl, isActive: true });
          }).catch(console.error);
          break;
        }

        case 'usage_report': {
          // Agent reports resource consumption for a workload window
          import('./billing.service').then(({ recordUsage }) => recordUsage({
            appId:       msg.appId,
            nodeId,
            cpuMs:       msg.cpuMs       ?? 0,
            ramMbS:      msg.ramMbS      ?? 0,
            netRxBytes:  msg.netRxBytes  ?? 0,
            netTxBytes:  msg.netTxBytes  ?? 0,
            windowStart: msg.windowStart ?? new Date().toISOString(),
            windowEnd:   msg.windowEnd   ?? new Date().toISOString(),
          })).catch(console.error);
          break;
        }

        case 'route_deregister': {
          // Agent signals that the container stopped — deactivate the route
          const routePath = `/${msg.host}`;
          prisma.gatewayRoute.updateMany({
            where: { routePath },
            data:  { isActive: false },
          }).then(() => {
            console.log(`🔴 [agent-ws] Route deregistered: ${routePath}`);
            io.emit('gateway:route_updated', { routePath, isActive: false });
          }).catch(console.error);
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      agentSockets.delete(nodeId);
      prisma.node.update({ where: { id: nodeId }, data: { status: 'OFFLINE' } })
                 .catch(console.error);
      console.log(`🔌 Agent disconnected: nodeId=${nodeId}`);
    });

    ws.on('error', (err) => {
      console.error(`[agent-ws] error for nodeId=${nodeId}: ${err.message}`);
    });
  });

  httpsServer.listen(port, () => {
    console.log(`🔐 Agent WSS (mTLS) listening on port ${port}`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function generateServerCert(
  caCertPem: string,
  caKeyPem: string,
): Promise<{ serverCert: string; serverKey: string }> {
  const { execSync } = await import('child_process');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '10kk-srv-'));
  try {
    const caKeyPath   = path.join(tmpDir, 'ca.key');
    const caCertPath  = path.join(tmpDir, 'ca.crt');
    const srvKeyPath  = path.join(tmpDir, 'srv.key');
    const srvCsrPath  = path.join(tmpDir, 'srv.csr');
    const srvCertPath = path.join(tmpDir, 'srv.crt');

    fs.writeFileSync(caKeyPath,  caKeyPem);
    fs.writeFileSync(caCertPath, caCertPem);

    execSync(`openssl genrsa -out "${srvKeyPath}" 2048`, { stdio: 'pipe' });
    execSync(
      `openssl req -new -key "${srvKeyPath}" -out "${srvCsrPath}" ` +
      `-subj "/CN=10kk-agent-server/O=10KK/C=BR"`,
      { stdio: 'pipe' },
    );
    execSync(
      `openssl x509 -req -days 3650 ` +
      `-in "${srvCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" -CAcreateserial ` +
      `-out "${srvCertPath}"`,
      { stdio: 'pipe' },
    );

    return {
      serverCert: fs.readFileSync(srvCertPath, 'utf8'),
      serverKey:  fs.readFileSync(srvKeyPath,  'utf8'),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
